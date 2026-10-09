import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import type { HdlLang } from "../parser";

export interface ConnectionContext {
  module: string;
  value: boolean;
  used: string[];
  dot: boolean;
  parameters: boolean;
}

export function stripSourceComments(source: string, lang: HdlLang): string {
  return (lang === "vhdl" ? stripVhdlComments : stripComments)(source);
}

export function connectionContext(source: string, offset: number, lang: HdlLang): ConnectionContext | undefined {
  return connectionContextClean(stripSourceComments(source, lang), offset, lang);
}

/** 不完整的例化仍可补全；按未闭合括号定位连接表，避免把表达式括号当作端口表。 */
export function connectionContextClean(cleanSource: string, offset: number, lang: HdlLang): ConnectionContext | undefined {
  const clean = cleanSource.slice(0, offset);
  const stack: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "(") stack.push(i);
    else if (clean[i] === ")") stack.pop();
  }
  for (const open of stack) {
    // 已闭合的参数/generic/架构选择器折叠，不受内部逗号和括号干扰。
    let head = clean.slice(0, open);
    while (/\([^()]*\)/.test(head)) head = head.replace(/\([^()]*\)/g, " ");
    const match = lang === "vhdl"
      ? /\b\w+\s*:\s*(?:entity\s+(?:\w+\s*\.\s*)?|component\s+)?(\w+)\s*(?:generic\s+map\s*)?(port|generic)\s+map\s*$/i.exec(head)
      : /\b([A-Za-z_]\w*)\s*(?:(#)\s*|(?:#\s*)?\s+\w+\s*(?:\[[^\]]*\]\s*)?)$/.exec(head);
    if (!match || /^(?:module|if|for|while|function|task|always|process)$/i.test(match[1])) continue;
    const body = clean.slice(open + 1);
    let depth = 0, entryStart = 0;
    const entries: string[] = [];
    for (let i = 0; i < body.length; i++) {
      if (/[([{]/.test(body[i])) depth++;
      if (/[)\]}]/.test(body[i])) depth--;
      if (body[i] === "," && depth === 0) { entries.push(body.slice(entryStart, i)); entryStart = i + 1; }
    }
    const entry = body.slice(entryStart);
    const used = entries.flatMap(e => {
      const m = (lang === "vhdl" ? /^\s*(\w+)\s*=>/ : /^\s*\.\s*(\w+)/).exec(e);
      return m ? [m[1]] : [];
    });
    return { module: match[1], used, value: lang === "vhdl" ? entry.includes("=>") : entry.includes("("), dot: /^\s*\./.test(entry), parameters: match[2] === "#" || match[2]?.toLowerCase() === "generic" };
  }
  return undefined;
}

/** 只有独立例化位置才展开骨架；表达式和定义中的模块名只插入名字。 */
export function instantiationContext(linePrefix: string, lang: HdlLang): { start: number; label?: string; library?: string } | undefined {
  if (/^\s*$/.test(linePrefix)) return { start: linePrefix.length };
  if (lang !== "vhdl") return undefined;
  const m = /^(\s*)(\w+)\s*:\s*(?:entity\s+(?:(\w+)\s*\.\s*)?)?$/i.exec(linePrefix);
  return m ? { start: m[1].length, label: m[2], library: m[3] } : undefined;
}
