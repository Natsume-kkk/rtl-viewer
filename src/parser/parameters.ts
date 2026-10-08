import type { ParameterInfo } from "./types";

/** clean 与 source 等长；结构使用去注释文本，默认值保留字符串字面量。 */
export function parseParameters(clean: string, source: string, vhdl: boolean): ParameterInfo[] {
  const result: ParameterInfo[] = [];
  let depth = 0, start = 0;
  const parts: { text: string; raw: string }[] = [];
  for (let i = 0; i <= clean.length; i++) {
    if (/[([{]/.test(clean[i] ?? "")) depth++;
    if (/[)\]}]/.test(clean[i] ?? "")) depth--;
    if (i === clean.length || (clean[i] === (vhdl ? ";" : ",") && depth === 0)) {
      parts.push({ text: clean.slice(start, i), raw: source.slice(start, i) }); start = i + 1;
    }
  }
  for (const { text, raw } of parts) {
    if (vhdl) {
      const match = /^\s*(?:constant\s+)?([A-Za-z_]\w*(?:\s*,\s*\w+)*)\s*:/i.exec(text);
      if (!match) continue;
      const eq = text.indexOf(":=");
      for (const name of match[1].split(",").map(n => n.trim())) result.push({ name, ...(eq >= 0 ? { defaultValue: raw.slice(eq + 2).trim() } : {}) });
    } else {
      if (/\blocalparam\b/.test(text)) continue;
      const eq = text.indexOf("=");
      const head = (eq >= 0 ? text.slice(0, eq) : text).trim();
      const name = /([A-Za-z_]\w*)\s*$/.exec(head)?.[1];
      if (name) result.push({ name, ...(eq >= 0 ? { defaultValue: raw.slice(eq + 1).trim() } : {}) });
    }
  }
  return result;
}
