import type { ModuleInfo, ParameterInfo, PortInfo } from "../parser";
import { evaluateConstant } from "../parser/static-generate";

export function verilogEntityStubs(modules: Iterable<ModuleInfo>, occupied: ReadonlySet<string>) {
  const entities = new Map<string, ModuleInfo[]>();
  for (const module of modules) {
    if (!module.vhdl?.entity) continue;
    const key = module.name.toLowerCase();
    const definitions = entities.get(key) ?? [];
    definitions.push(module);
    entities.set(key, definitions);
  }
  return [...entities.values()].flatMap(([module, duplicate]) =>
    duplicate || occupied.has(module.name) ? [] : [{
      name: module.name,
      source: verilogStub(module.name, module.ports, module.parameters ?? [], true),
    }],
  );
}

export function verilogStub(name: string, ports: PortInfo[], parameters: ParameterInfo[], vhdl = false): string {
  const parameterNames = new Map(parameters.map(parameter => [parameter.name.toLowerCase(), parameter.name]));
  const parametersText = parameters.filter(parameter => validName(parameter.name)).map(parameter => {
    const value = verilogDefault(parameter.defaultValue, parameters, vhdl);
    return `parameter ${parameter.name}${value === undefined ? "" : ` = ${value}`}`;
  });
  const portsText = ports.filter(port => validName(port.name) && port.direction).map(port => {
    const kind = port.direction!.toLowerCase();
    const direction = kind === "in" || kind === "input" ? "input" : kind === "out" || kind === "output" || kind === "buffer" ? "output" : "inout";
    const width = verilogWidth(port.width);
    const mappedWidth = vhdl ? width.replace(/[A-Za-z_]\w*/g, name => parameterNames.get(name.toLowerCase()) ?? name) : width;
    return `${direction} wire ${mappedWidth}${port.name}`;
  });
  const parameterList = parametersText.length ? ` #(${parametersText.join(", ")})` : "";
  return `module ${name}${parameterList} (${portsText.join(", ")});\nendmodule\n`;
}

export function vhdlStub(name: string, ports: PortInfo[], parameters: ParameterInfo[]): string {
  const generics = parameters.filter(parameter => validVhdlName(parameter.name)).map(parameter => {
    const value = vhdlDefault(parameter.defaultValue, parameters);
    return `    ${parameter.name} : integer${value === undefined ? "" : ` := ${value}`}`;
  });
  const portList = ports.filter(port => validVhdlName(port.name) && port.direction).map(port => {
    const direction = port.direction!.toLowerCase();
    const vhdlDirection = direction === "in" || direction === "input" ? "in" : direction === "inout" ? "inout" : direction === "buffer" ? "buffer" : "out";
    return `    ${port.name} : ${vhdlDirection} ${vhdlType(port.width)}`;
  });
  const genericText = generics.length ? `\n  generic (\n${generics.join(";\n")}\n  );` : "";
  const portText = portList.length ? `\n  port (\n${portList.join(";\n")}\n  );` : "";
  return `library ieee;\nuse ieee.std_logic_1164.all;\nentity ${name} is${genericText}${portText}\nend entity ${name};\n`;
}

function vhdlType(type: string | undefined): string {
  if (!type) return "std_logic";
  const trimmed = type.trim();
  const range = /^\[\s*(.+?)\s*:\s*(.+?)\s*\]$/.exec(trimmed);
  if (range) {
    const ascending = Number.isFinite(Number(range[1])) && Number.isFinite(Number(range[2])) && Number(range[1]) < Number(range[2]);
    return `std_logic_vector(${range[1]} ${ascending ? "to" : "downto"} ${range[2]})`;
  }
  if (/^std_(?:u)?logic_vector\s*\(/i.test(trimmed)) return trimmed.replace(/^std_ulogic_vector/i, "std_logic_vector");
  if (/^(?:integer|natural|positive)$/i.test(trimmed)) return "integer";
  return "std_logic";
}

function validVhdlName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

function verilogWidth(type: string | undefined): string {
  if (!type) return "";
  const trimmed = type.trim();
  if (/^\[[^\]]+\]$/.test(trimmed)) return `${trimmed} `;
  const vector = /std_(?:u)?logic_vector\s*\(\s*(.+?)\s+(downto|to)\s+(.+?)\s*\)/i.exec(type);
  if (vector) return vector[2].toLowerCase() === "downto" ? `[${vector[1]}:${vector[3]}] ` : `[${vector[3]}:${vector[1]}] `;
  if (/^(?:integer|natural|positive)$/i.test(type.trim())) return "[31:0] ";
  return "";
}

function validName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
}

function verilogDefault(value: string | undefined, parameters: ParameterInfo[], vhdl: boolean): string | undefined {
  if (!value?.trim() || value.length > 8192) return undefined;
  if (/^"(?:[^"\\\r\n]|\\.)*"$/.test(value.trim())) return value.trim();
  const names = new Map(parameters.map(parameter => [vhdl ? parameter.name.toLowerCase() : parameter.name, parameter.name]));
  const text = vhdl ? value.trim().replace(/\btrue\b/gi, "1").replace(/\bfalse\b/gi, "0")
    .replace(/\brem\b/gi, "%") : value.trim();
  // 只转换共享的常量表达式子集；无法转换时保留无默认值的参数，由后端报告黑盒边界。
  const tokens = text.match(/\d*'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|'[01xXzZ]|\d[\d_]*|\$clog2|[A-Za-z_]\w*|\s+|[()+*/%<>=!~&|^?:-]/g);
  if (!tokens || tokens.join("") !== text) return undefined;
  const key = (token: string) => vhdl ? token.toLowerCase() : token;
  if (tokens.some(token => /^[A-Za-z_]\w*$/.test(token) && !names.has(key(token)))) return undefined;
  return tokens.map(token => names.get(key(token)) ?? token).join("");
}

function vhdlDefault(value: string | undefined, parameters: ParameterInfo[]): string | undefined {
  const text = verilogDefault(value, parameters, true);
  if (!text) return undefined;
  let unknown = false;
  const converted = text.replace(/\d*'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|'[01xXzZ]/g, literal => {
    const number = evaluateConstant(literal, new Map());
    if (number === undefined) unknown = true;
    return String(number);
  });
  if (unknown || !/^[\w\s()+*/%\-]+$/.test(converted)) return undefined;
  return converted.replaceAll("%", " rem ");
}
