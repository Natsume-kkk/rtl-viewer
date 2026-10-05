import type { DefinitionRef, InstanceInfo, ModuleInfo, PortInfo } from "./types";

const KEYWORDS = new Set([
  "module", "endmodule", "macromodule", "begin", "end", "if", "else", "always",
  "always_ff", "always_comb", "always_latch", "initial", "final", "assign", "wire",
  "reg", "logic", "input", "output", "inout", "parameter", "localparam", "genvar",
  "generate", "endgenerate", "function", "endfunction", "task", "endtask", "case",
  "casex", "casez", "endcase", "for", "while", "repeat", "forever", "integer",
  "real", "realtime", "time", "signed", "unsigned", "typedef", "enum", "struct",
  "union", "packed", "package", "endpackage", "import", "export", "return",
  "posedge", "negedge", "interface", "endinterface", "modport", "clocking",
  "endclocking", "property", "endproperty", "sequence", "endsequence", "program",
  "endprogram", "class", "endclass", "new", "this", "super", "extends", "virtual",
  "static", "const", "var", "automatic", "rand", "randc", "covergroup",
  "endcovergroup", "default", "unique", "unique0", "priority", "do", "break",
  "continue", "and", "nand", "or", "nor", "xor", "xnor", "not", "buf", "bufif0",
  "bufif1", "notif0", "notif1", "pullup", "pulldown", "tran", "specify",
  "endspecify", "primitive", "endprimitive", "table", "endtable", "config",
  "endconfig", "supply0", "supply1", "tri", "tri0", "tri1", "wand", "wor",
  "trireg", "scalared", "vectored", "strong0", "strong1", "weak0", "weak1",
  "deassign", "disable", "force", "release", "fork", "join", "join_any",
  "join_none", "wait", "event", "int", "bit", "byte", "shortint", "longint",
  "shortreal", "string", "void", "type", "ref", "inout",
]);

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** 跳过连续的 `(* ... *)` 属性组（可出现在 module 名与端口表之间等位置）。 */
function skipAttrs(s: string, i: number): number {
  for (;;) {
    i = skipWs(s, i);
    if (s[i] === "(" && s[i + 1] === "*") {
      const end = s.indexOf("*)", i + 2);
      if (end < 0) return i;
      i = end + 2;
    } else {
      return i;
    }
  }
}

function skipBalanced(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 去掉注释与字符串内容，保留长度和换行，保证行号不变。 */
export function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") out[j++] = " ";
      i = j;
    } else if (c === "/" && src[i + 1] === "*") {
      let j = i;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) {
        if (src[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < src.length) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      }
      i = j;
    } else if (c === '"') {
      out[i] = " ";
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          out[j] = " ";
          j++;
          if (j < src.length && src[j] !== "\n") out[j] = " ";
        } else if (src[j] !== "\n") {
          out[j] = " ";
        }
        j++;
      }
      if (j < src.length) out[j] = " ";
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

function lineAt(lineStarts: number[], pos: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function computeLineStarts(s: string): number[] {
  const starts = [0];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 第一级扫描：只提取 module/interface 定义名与行号。 */
export function scanVerilogDefinitions(src: string): DefinitionRef[] {
  const stripped = stripComments(src);
  const lineStarts = computeLineStarts(stripped);
  const out: DefinitionRef[] = [];
  const re = /\b(?:(?:macro)?module|interface)\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    out.push({ name: m[1], line: lineAt(lineStarts, m.index) });
  }
  return out;
}

function parsePortList(portListSrc: string): PortInfo[] {
  const ports: PortInfo[] = [];
  const entries: string[] = [];
  let depth = 0, cur = "";
  for (const ch of portListSrc) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      entries.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) entries.push(cur);
  for (const entry of entries) {
    const dirMatch = /\b(input|output|inout)\b/.exec(entry);
    const widthMatch = /\[[^\]]*\]/.exec(entry);
    const idents = entry.match(/[A-Za-z_]\w*/g) ?? [];
    const name = idents[idents.length - 1];
    if (!name || KEYWORDS.has(name)) continue;
    ports.push({
      name,
      direction: dirMatch?.[1],
      width: widthMatch?.[0],
    });
  }
  return ports;
}

/** 解析例化端口连接表：`.name(expr)` 命名连接或位置连接，按顶层逗号切分。 */
function parseConnections(
  src: string,
  baseOffset: number,
  lineStarts: number[],
): InstanceInfo["connections"] {
  const entries: { text: string; start: number }[] = [];
  let depth = 0, cur = "", curStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      entries.push({ text: cur, start: curStart });
      cur = "";
      curStart = i + 1;
    } else {
      cur += ch;
    }
  }
  entries.push({ text: cur, start: curStart });
  const out: NonNullable<InstanceInfo["connections"]> = [];
  for (const { text, start } of entries) {
    // 行号取条目内首个非空白字符（条目可能以换行开头）
    const lead = /^\s*/.exec(text)![0].length;
    const line = lineAt(lineStarts, baseOffset + start + lead);
    const named = /^\s*\.\s*([A-Za-z_]\w*)\s*\(\s*([\s\S]*?)\s*\)\s*$/.exec(text);
    if (named) {
      out.push({ port: named[1], expr: named[2], line });
    } else {
      const expr = text.trim();
      if (expr) out.push({ expr, line });
    }
  }
  return out;
}

function scanInstances(
  body: string,
  bodyStart: number,
  lineStarts: number[],
  selfName: string,
  withConn: boolean,
): InstanceInfo[] {
  const out: InstanceInfo[] = [];
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const typeName = m[0];
    if (KEYWORDS.has(typeName) || typeName === selfName) continue;
    let i = skipWs(body, re.lastIndex);
    if (body[i] === "#") {
      i = skipWs(body, i + 1);
      if (body[i] !== "(") continue;
      i = skipBalanced(body, i);
      if (i < 0) continue;
      i = skipWs(body, i);
    }
    // 同组例化：类型名后可逗号续多个例化名，例化名可带数组维度 [n:0]
    const groupLine = lineAt(lineStarts, bodyStart + m.index);
    let lastEnd = -1;
    let cursor = i;
    for (;;) {
      const instMatch = /^[A-Za-z_]\w*/.exec(body.slice(cursor));
      if (!instMatch) break;
      const instName = instMatch[0];
      if (KEYWORDS.has(instName)) break;
      let p = skipWs(body, cursor + instName.length);
      if (body[p] === "[") {
        const close = body.indexOf("]", p);
        if (close < 0) break;
        p = skipWs(body, close + 1);
      }
      if (body[p] !== "(") break;
      const j = skipBalanced(body, p);
      if (j < 0) break;
      const k = skipWs(body, j);
      if (body[k] !== ";" && body[k] !== ",") break;
      const info: InstanceInfo = { module: typeName, inst: instName, line: groupLine };
      if (withConn) {
        info.connections = parseConnections(body.slice(p + 1, j - 1), bodyStart + p + 1, lineStarts);
        info.endLine = lineAt(lineStarts, bodyStart + j - 1);
      }
      out.push(info);
      lastEnd = j;
      if (body[k] !== ",") break;
      cursor = skipWs(body, k + 1);
    }
    if (lastEnd > 0) re.lastIndex = lastEnd;
  }
  return out;
}

/** 完整解析：module/interface 定义、端口、例化。withPorts=false 时跳过端口提取（第一级结构扫描用）；withConn=true 时额外提取例化端口连接（悬停端口映射用）。 */
export function parseVerilog(src: string, file: string, withPorts = true, withConn = false): ModuleInfo[] {
  const stripped = stripComments(src);
  const lineStarts = computeLineStarts(stripped);
  const modules: ModuleInfo[] = [];
  const modRe = /\b(?:(?:macro)?module|interface)\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = modRe.exec(stripped))) {
    const name = m[1];
    const endRe = /\bend(?:module|interface)\b/g;
    endRe.lastIndex = modRe.lastIndex;
    const endMatch = endRe.exec(stripped);
    const bodyEnd = endMatch ? endMatch.index : stripped.length;

    let i = skipAttrs(stripped, modRe.lastIndex);
    if (stripped[i] === "#") {
      i = skipWs(stripped, i + 1);
      if (stripped[i] === "(") {
        const j = skipBalanced(stripped, i);
        i = j < 0 ? i : skipWs(stripped, j);
      }
      i = skipAttrs(stripped, i);
    }
    let ports: PortInfo[] = [];
    let headerEnd = i;
    if (stripped[i] === "(") {
      const j = skipBalanced(stripped, i);
      if (j > 0) {
        if (withPorts) ports = parsePortList(stripped.slice(i + 1, j - 1));
        headerEnd = j;
      }
    }
    const semi = stripped.indexOf(";", headerEnd);
    const bodyStart = semi > 0 && semi < bodyEnd ? semi + 1 : headerEnd;

    modules.push({
      name,
      file,
      line: lineAt(lineStarts, m.index),
      ports,
      instances: scanInstances(
        stripped.slice(bodyStart, bodyEnd),
        bodyStart,
        lineStarts,
        name,
        withConn,
      ),
    });
    modRe.lastIndex = endMatch ? endRe.lastIndex : stripped.length;
  }
  return modules;
}
