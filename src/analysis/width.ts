import { moduleScopeAt, type FileFacts } from "./facts";

export function signalWidths(facts: FileFacts, scope: string): Map<string, number> {
  const widths = new Map<string, number>();
  const add = (name: string, declaration: string | undefined) => {
    const width = declaredWidth(declaration);
    if (width !== undefined) widths.set(facts.language === "vhdl" ? name.toLowerCase() : name, width);
  };
  for (const declaration of facts.declarations) {
    if (moduleScopeAt(facts, declaration.line, declaration.scope) === scope) add(declaration.name, declaration.width);
  }
  for (const port of facts.ports) {
    if (moduleScopeAt(facts, port.line ?? 1, port.scope) === scope) add(port.name, port.width);
  }
  return widths;
}

export function declaredWidth(declaration: string | undefined): number | undefined {
  if (!declaration) return undefined;
  const text = declaration.trim();
  if (/^(?:bit|boolean|std_logic|std_ulogic)$/i.test(text)) return 1;
  const verilog = /^\[\s*(\d+)\s*:\s*(\d+)\s*\]$/.exec(text);
  const vhdl = /^(?:std_(?:u)?logic_vector|bit_vector)\s*\(\s*(\d+)\s+(downto|to)\s+(\d+)\s*\)$/i.exec(text);
  if (verilog) return Math.abs(Number(verilog[1]) - Number(verilog[2])) + 1;
  if (vhdl) return Math.abs(Number(vhdl[1]) - Number(vhdl[3])) + 1;
  return undefined;
}

export function expressionWidth(expression: string, widths: ReadonlyMap<string, number>, vhdl = false): number | undefined {
  const text = stripParentheses(expression.trim());
  if (/^[A-Za-z_]\w*$/.test(text)) return widths.get(vhdl ? text.toLowerCase() : text);
  if (/^'(?:0|1|x|z|u|w|l|h|-)'$/i.test(text)) return 1;
  const literal = /^(\d+)\s*'\s*[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_?]+$/.exec(text);
  if (literal) return Number(literal[1]);
  const bit = /^([A-Za-z_]\w*)\s*\[\s*\d+\s*\]$/.exec(text);
  if (bit && widths.has(bit[1])) return 1;
  const slice = /^([A-Za-z_]\w*)\s*\[\s*(\d+)\s*:\s*(\d+)\s*\]$/.exec(text);
  if (slice && widths.has(slice[1])) return Math.abs(Number(slice[2]) - Number(slice[3])) + 1;
  if (text.startsWith("{") && text.endsWith("}")) {
    let total = 0;
    for (const part of splitTopLevel(text.slice(1, -1), ",")) {
      const width = expressionWidth(part, widths, vhdl);
      if (width === undefined) return undefined;
      total += width;
    }
    return total;
  }
  return undefined;
}

export function sizedLiteralWidth(expression: string): number | undefined {
  const match = /^(\d+)\s*'\s*[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_?]+$/.exec(expression.trim());
  return match ? Number(match[1]) : undefined;
}

export function simpleBinary(expression: string, operators: readonly string[]): { left: string; operator: string; right: string } | undefined {
  const ordered = [...operators].sort((left, right) => right.length - left.length);
  let round = 0, square = 0, curly = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === "(") round++;
    else if (char === ")") round--;
    else if (char === "[") square++;
    else if (char === "]") square--;
    else if (char === "{") curly++;
    else if (char === "}") curly--;
    if (round || square || curly) continue;
    for (const operator of ordered) {
      if (!expression.startsWith(operator, index)) continue;
      const left = expression.slice(0, index).trim();
      const right = expression.slice(index + operator.length).trim();
      if (left && right) return { left, operator, right };
    }
  }
  return undefined;
}

function stripParentheses(text: string): string {
  if (!text.startsWith("(") || !text.endsWith(")")) return text;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") depth--;
    if (depth === 0 && index < text.length - 1) return text;
  }
  return text.slice(1, -1).trim();
}

function splitTopLevel(text: string, separator: string): string[] {
  const result: string[] = [];
  let start = 0, depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (["(", "[", "{"].includes(text[index])) depth++;
    else if ([")", "]", "}"].includes(text[index])) depth--;
    else if (!depth && text[index] === separator) {
      result.push(text.slice(start, index));
      start = index + 1;
    }
  }
  result.push(text.slice(start));
  return result;
}
