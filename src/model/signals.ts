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
