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
