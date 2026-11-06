import type { ParameterInfo, PortInfo } from "../parser";

export function verilogStub(name: string, ports: PortInfo[], parameters: ParameterInfo[]): string {
  const parametersText = parameters.map(parameter => parameter.name).filter(validName).map(parameter => `parameter ${parameter} = 1`);
  const portsText = ports.filter(port => validName(port.name) && port.direction).map(port => {
    const kind = port.direction!.toLowerCase();
    const direction = kind === "in" || kind === "input" ? "input" : kind === "out" || kind === "output" || kind === "buffer" ? "output" : "inout";
    return `${direction} wire ${verilogWidth(port.width)}${port.name}`;
  });
  const parameterList = parametersText.length ? ` #(${parametersText.join(", ")})` : "";
  return `module ${name}${parameterList} (${portsText.join(", ")});\nendmodule\n`;
}

export function vhdlStub(name: string, ports: PortInfo[], parameters: ParameterInfo[]): string {
  const generics = parameters.map(parameter => ({ name: parameter.name, value: parameter.defaultValue?.trim() }))
    .filter(parameter => validVhdlName(parameter.name))
    .map(parameter => `    ${parameter.name} : integer := ${parameter.value && /^[+-]?\d[\d_]*$/.test(parameter.value) ? parameter.value.replaceAll("_", "") : "1"}`);
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
