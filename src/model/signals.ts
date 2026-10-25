import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verilogDeclLine(stripped: string, name: string): number | undefined {
  const re = new RegExp(
    `^\\s*(?:input|output|inout|wire|reg|logic)\\b[^;()]*\\b${escapeRe(name)}\\b`,
  );
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return undefined;
}

function vhdlDeclLine(stripped: string, name: string): number | undefined {
  const escaped = escapeRe(name);
  const declRe = new RegExp(`^\\s*signal\\s+[\\w\\s,]*\\b${escaped}\\b\\s*:`, "i");
  const portRe = new RegExp(`^\\s*[\\w\\s,]*\\b${escaped}\\b\\s*:\\s*(?:in|out|inout|buffer|linkage)\\b`, "i");
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.includes("=>")) continue; // port map 连接不是声明
    if (declRe.test(text) || portRe.test(text)) return i + 1;
  }
  return undefined;
}

/** 在文件内查找信号/端口声明行（verilog 声明关键字行、vhdl signal 与端口行），找不到返回 undefined。 */
export function findSignalDeclLine(content: string, file: string, name: string): number | undefined {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  if (ext === "vhd" || ext === "vhdl") return vhdlDeclLine(stripVhdlComments(content), name);
  return verilogDeclLine(stripComments(content), name);
}

/** 刷新时只在原模块内重新定位，不能按整文件的首个同名声明换目标。 */
export function findModuleSignalPosition(content: string, file: string, moduleName: string, signal: string): { line: number; column: number } | undefined {
  const vhdl = /\.vhdl?$/i.test(file);
  const clean = vhdl ? stripVhdlComments(content) : stripComments(content);
  const scopes = [...clean.matchAll(vhdl
    ? /\b(?:entity\s+(\w+)\s+is\b|architecture\s+\w+\s+of\s+(\w+)\s+is\b)/gi
    : /\bmodule\s+(\w+)\b/g)];
  const norm = (name: string) => vhdl ? name.toLowerCase() : name;
  const matches = scopes.filter(scope => norm(scope[1] ?? scope[2]) === norm(moduleName));
  if ((!vhdl && matches.length !== 1) || (vhdl && matches.filter(scope => scope[2]).length > 1)) return;
  for (const scope of matches) {
    const start = scope.index! + scope[0].length;
    let end = scopes[scopes.indexOf(scope) + 1]?.index ?? clean.length;
    if (!vhdl) {
      const close = clean.indexOf("endmodule", start);
      if (close >= 0) end = Math.min(end, close);
    }
    const match = new RegExp(`\\b${escapeRe(signal)}\\b`, vhdl ? "i" : "").exec(clean.slice(start, end));
    if (!match) continue;
    const offset = start + match.index;
    return { line: clean.slice(0, offset).split("\n").length, column: offset - clean.lastIndexOf("\n", offset - 1) };
  }
  return undefined;
}
