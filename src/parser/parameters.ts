import type { ParameterInfo } from "./types";

export function parseOverrides(text: string, vhdl: boolean): { name?: string; expression: string }[] {
  const out: { name?: string; expression: string }[] = [];
  let depth = 0, from = 0;
  for (let i=0;i<=text.length;i++) {
    if (/[([{]/.test(text[i] ?? "")) depth++;
    if (/[)\]}]/.test(text[i] ?? "")) depth--;
    if (i !== text.length && (text[i] !== "," || depth)) continue;
    const entry=text.slice(from,i).trim(); from=i+1;
    const named = vhdl ? /^([A-Za-z_]\w*)\s*=>\s*([\s\S]*)$/.exec(entry) : /^\.\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(entry);
    if (named) out.push({name:named[1],expression:named[2].trim()});
    else if (entry) out.push({expression:entry});
  }
  return out;
}

/** clean 与 source 等长；结构使用去注释文本，默认值保留字符串字面量。 */
export function parseParameters(clean: string, source: string, vhdl: boolean, includeLocal=false): ParameterInfo[] {
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
  let inheritedType:string|undefined;
  for (const { text, raw } of parts) {
    if (vhdl) {
      const match = /^\s*(?:constant\s+)?([A-Za-z_]\w*(?:\s*,\s*\w+)*)\s*:/i.exec(text);
      if (!match) continue;
      const eq = text.indexOf(":=");
      const typeDeclaration=text.slice(text.indexOf(":")+1,eq>=0?eq:undefined).trim();
      for (const name of match[1].split(",").map(n => n.trim())) result.push({ name,typeDeclaration, ...(eq >= 0 ? { defaultValue: raw.slice(eq + 2).trim() } : {}) });
    } else {
      if (!includeLocal&&/\blocalparam\b/.test(text)) continue;
      const eq = text.indexOf("=");
      const head = (eq >= 0 ? text.slice(0, eq) : text).trim();
      const name = /([A-Za-z_]\w*)\s*$/.exec(head)?.[1];
      if (name) {
        const declaration=head.slice(0,head.length-name.length).replace(/^\s*(?:parameter|localparam)\b/,"").trim();
        if(declaration||/\b(?:parameter|localparam)\b/.test(head))inheritedType=declaration||undefined;
        result.push({ name,...(inheritedType?{typeDeclaration:inheritedType}:{}), ...(eq >= 0 ? { defaultValue: raw.slice(eq + 1).trim() } : {}) });
      }
    }
  }
  return result;
}
