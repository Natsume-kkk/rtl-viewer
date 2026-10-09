import { KEYWORDS } from "./verilog";

/** Verilog 过程体（always/initial）语句级解析：赋值池模型，不分析语句顺序。 */

export interface ExprAnalysis { reads: string[]; blockedReads: string[]; hasCall: boolean }
export interface ProcAssign extends ExprAnalysis {
  operator: "=" | "<=" | ":=";
  target: string;
  expression: string;
  /** 相对过程文本的偏移 */
  index: number;
  conditions: string[];
  /** 边沿敏感信号（非空 = 时钟过程） */
  clock: string[];
}
export interface ProcBoundary { index: number; endIndex: number; reason: string }
export interface ProcInfo {
  assignments: ProcAssign[];
  boundaries: ProcBoundary[];
  /** 敏感表与条件表达式中的信号 */
  controlSignals: string[];
  /** 赋值目标与 RHS 中的信号 */
  dataSignals: string[];
  /** 当前过程声明的局部对象，不含嵌套子程序的声明。 */
  locals?: string[];
}

interface Token { text: string; index: number }

const VHDL_KEYWORDS = new Set([
  "process", "begin", "end", "if", "then", "elsif", "else", "case", "when", "is", "loop", "for", "while", "in", "to", "downto",
  "signal", "variable", "constant", "wait", "on", "until", "null", "return", "report", "assert", "severity", "others", "all",
  "and", "or", "nand", "nor", "xor", "xnor", "not", "mod", "rem", "abs", "sll", "srl", "sla", "sra", "rol", "ror",
  "of", "architecture", "entity", "port", "map", "generic", "use", "library", "package", "body", "type", "subtype", "array",
  "record", "function", "procedure", "block", "generate", "out", "inout", "buffer", "linkage", "after", "transport", "inertial",
  "reject", "guarded", "postponed", "unaffected", "select", "with", "shared", "next", "exit", "new", "units", "group", "label",
  "open", "range", "reverse_range", "ns", "ps", "us", "ms", "sec", "pure", "impure",
]);

const tokenRe = /\d+#[0-9a-fA-FxzXZ_]+#|\d*'[sS]?[bBoOdDhH][0-9a-fA-FxzXZ_?]*|'[01xzXZ]|\d[\d_]*(?:\.[\d_]+)?|<<=|>>=|:=|=>|\/=|<=|>=|==|!=|&&|\|\||<<|>>|\*\*|\$?\w+|\S/g;
const isIdent = (t: string) => /^[A-Za-z_]\w*$/.test(t) && !KEYWORDS.has(t);
const isVhdlIdent = (t: string) => /^[A-Za-z_]\w*$/.test(t) && !VHDL_KEYWORDS.has(t.toLowerCase());

function tokenize(text: string): Token[] {
  return [...text.matchAll(tokenRe)].map(m => ({ text: m[0], index: m.index! }));
}

/** 遮蔽字符串内容（保留长度与索引）供匹配用；展示文本仍取原文。VHDL 的字符字面量 'U' 与基符位串 x"FF" 整体是值不是标识符，一并遮蔽。 */
function maskLiterals(text: string, vhdl: boolean): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let start = i;
      if (vhdl) while (start > 0 && /[A-Za-z]/.test(text[start - 1])) start--;
      let j = i + 1;
      while (j < text.length && text[j] !== "\n") {
        if (!vhdl && text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') { if (vhdl && text[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      for (let k = start; k <= j && k < text.length; k++) out[k] = " ";
      i = j + 1;
    } else if (vhdl && c === "'" && text[i + 2] === "'") {
      out[i] = out[i + 1] = out[i + 2] = " ";
      i += 3;
    } else i++;
  }
  return out.join("");
}

/** 分析表达式：可追踪的标识符、带位选被阻断的标识符、是否含函数/系统调用。VHDL 模式下标识符后跟 `(...)` 视为位选/调用，括号内不产生边。 */
export function analyzeExpression(expression: string, vhdl = false): ExprAnalysis {
  const tokens = tokenize(maskLiterals(expression, vhdl));
  const reads: string[] = [], blockedReads: string[] = [];
  let hasCall = false;
  const ident = vhdl ? isVhdlIdent : isIdent;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text;
    if (t.startsWith("$")) { if (tokens[i + 1]?.text === "(") hasCall = true; continue; }
    if (!ident(t)) continue;
    const next = tokens[i + 1]?.text;
    if (vhdl && next === "(") {
      if (!blockedReads.includes(t)) blockedReads.push(t);
      let depth = 0, k = i + 1;
      for (; k < tokens.length; k++) {
        if (tokens[k].text === "(") depth++;
        else if (tokens[k].text === ")") { depth--; if (!depth) break; }
      }
      i = k;
      continue;
    }
    if (next === "[") { if (!blockedReads.includes(t)) blockedReads.push(t); }
    else if (next === "(") hasCall = true;
    else if (!reads.includes(t)) reads.push(t);
  }
  return { reads, blockedReads, hasCall };
}

export function parseVerilogProcess(text: string): ProcInfo {
  const info: ProcInfo = { assignments: [], boundaries: [], controlSignals: [], dataSignals: [] };
  const tokens = tokenize(maskLiterals(text, false));
  const control = new Set<string>(), data = new Set<string>();
  const edges: string[] = [];
  let i = 0;
  if (!/^(always\w*|initial)$/.test(tokens[0]?.text ?? "")) return info;
  i = 1;
  if (tokens[i]?.text === "@") {
    i++;
    if (tokens[i]?.text === "(") {
      const close = matchPair(i, "(", ")");
      for (let k = i + 1; k < close; k++) {
        const t = tokens[k].text;
        if (t === "posedge" || t === "negedge") {
          const n = tokens[k + 1];
          if (n && isIdent(n.text)) { edges.push(n.text); control.add(n.text); k++; }
        } else if (isIdent(t)) control.add(t);
      }
      i = close + 1;
    } else {
      if (tokens[i] && isIdent(tokens[i].text)) control.add(tokens[i].text);
      i++;
    }
  }
  parseSeq(i, tokens.length, [], 0);
  info.controlSignals = [...control];
  info.dataSignals = [...data];
  return info;

  function matchPair(open: number, l: string, r: string): number {
    let depth = 0;
    for (let k = open; k < tokens.length; k++) {
      if (tokens[k].text === l) depth++;
      else if (tokens[k].text === r) { depth--; if (!depth) return k; }
    }
    return tokens.length - 1;
  }
  function findSemi(from: number, end: number): number {
    let depth = 0;
    for (let k = from; k < end; k++) {
      const t = tokens[k].text;
      if (t === "(" || t === "[" || t === "{") depth++;
      else if (t === ")" || t === "]" || t === "}") depth--;
      else if (t === ";" && depth === 0) return k;
    }
    return end;
  }
  function skipToSemi(from: number, end: number): number {
    const k = findSemi(from, end);
    return k < end ? k + 1 : end;
  }
  function boundaryAt(startIndex: number, endToken: number, reason: string): void {
    const t = tokens[endToken];
    info.boundaries.push({ index: startIndex, endIndex: t ? t.index + t.text.length : text.length, reason });
  }
  function addConditionSignals(expression: string): void {
    const expr = analyzeExpression(expression);
    for (const r of [...expr.reads, ...expr.blockedReads]) control.add(r);
  }

  function parseSeq(start: number, end: number, conds: string[], depth: number): number {
    let i = start;
    while (i < end && depth < 200) {
      const t = tokens[i];
      if (t.text === "end" || t.text === "endcase") return i + 1;
      if (t.text === "begin") { i = parseSeq(i + 1, end, conds, depth + 1); continue; }
      if (t.text === "if") { i = parseIf(i, end, conds, depth); continue; }
      if (/^(case|casex|casez)$/.test(t.text)) { i = parseCase(i, end, conds, depth); continue; }
      if (/^(for|while|repeat|forever)$/.test(t.text)) { i = skipLoop(i, end); continue; }
      if (t.text === "{") {
        const semi = findSemi(i + 1, end);
        boundaryAt(t.index, semi, "拼接目标赋值（不继续推导）");
        i = semi < end ? semi + 1 : end;
        continue;
      }
      if (isIdent(t.text) || t.text.startsWith("$")) { i = parseStatement(i, end, conds); continue; }
      i++;
    }
    return i;
  }

  function parseStmt(i: number, end: number, conds: string[], depth: number): number {
    const t = tokens[i];
    if (!t) return end;
    if (t.text === "begin") return parseSeq(i + 1, end, conds, depth + 1);
    if (t.text === "if") return parseIf(i, end, conds, depth);
    if (/^(case|casex|casez)$/.test(t.text)) return parseCase(i, end, conds, depth);
    if (/^(for|while|repeat|forever)$/.test(t.text)) return skipLoop(i, end);
    if (t.text === "{") {
      const semi = findSemi(i + 1, end);
      boundaryAt(t.index, semi, "拼接目标赋值（不继续推导）");
      return semi < end ? semi + 1 : end;
    }
    if (isIdent(t.text) || t.text.startsWith("$")) return parseStatement(i, end, conds);
    return i + 1;
  }

  function parseIf(i: number, end: number, conds: string[], depth: number): number {
    const open = i + 1;
    if (tokens[open]?.text !== "(") return i + 1;
    const close = matchPair(open, "(", ")");
    const exprText = text.slice(tokens[open].index + 1, tokens[close].index).trim();
    addConditionSignals(exprText);
    i = parseStmt(close + 1, end, [...conds, exprText], depth + 1);
    while (tokens[i]?.text === "else") {
      if (tokens[i + 1]?.text === "if") i = parseIf(i + 1, end, [...conds, `!(${exprText})`], depth + 1);
      else i = parseStmt(i + 1, end, [...conds, `!(${exprText})`], depth + 1);
    }
    return i;
  }

  function parseCase(i: number, end: number, conds: string[], depth: number): number {
    const open = i + 1;
    if (tokens[open]?.text !== "(") return i + 1;
    const close = matchPair(open, "(", ")");
    const exprText = text.slice(tokens[open].index + 1, tokens[close].index).trim();
    addConditionSignals(exprText);
    i = close + 1;
    while (i < end && tokens[i].text !== "endcase" && depth < 200) {
      const labelStart = tokens[i].index;
      let j = i;
      while (j < end && tokens[j].text !== ":" && tokens[j].text !== "endcase") j++;
      if (tokens[j]?.text !== ":") return i + 1;
      const labelText = text.slice(labelStart, tokens[j].index).trim();
      const cond = /^default\b/.test(labelText) ? `case(${exprText}) default` : `${exprText} == ${labelText}`;
      i = parseStmt(j + 1, end, [...conds, cond], depth + 1);
    }
    return tokens[i]?.text === "endcase" ? i + 1 : i;
  }

  function skipLoop(i: number, end: number): number {
    const start = tokens[i].index;
    let j = i + 1;
    if (tokens[j]?.text === "(") j = matchPair(j, "(", ")") + 1;
    let bodyEnd: number;
    if (tokens[j]?.text === "begin") {
      let depth = 0, k = j;
      for (; k < end; k++) {
        if (tokens[k].text === "begin") depth++;
        else if (tokens[k].text === "end") { depth--; if (!depth) break; }
      }
      bodyEnd = k + 1;
    } else bodyEnd = skipToSemi(j, end);
    boundaryAt(start, bodyEnd - 1, "循环内逻辑（不继续推导）");
    return bodyEnd;
  }

  function parseStatement(i: number, end: number, conds: string[]): number {
    const t = tokens[i];
    if (t.text.startsWith("$")) return skipToSemi(i, end);
    let j = i + 1;
    let selected = false;
    while (tokens[j]?.text === "[") { selected = true; j = matchPair(j, "[", "]") + 1; }
    const op = tokens[j]?.text;
    if (op === "<=" || op === "=") {
      // 从运算符之后切原文：RHS 为纯字面量（遮蔽后无 token）时仍能保留展示文本
      const exprStart = tokens[j].index + tokens[j].text.length;
      const semi = findSemi(j + 1, end);
      const semiTok = tokens[semi];
      const expression = text.slice(exprStart, semiTok ? semiTok.index : text.length).trim();
      if (selected) {
        info.boundaries.push({ index: t.index, endIndex: semiTok ? semiTok.index + 1 : text.length, reason: "位选/切片赋值（范围转换）" });
        data.add(t.text);
        for (const r of analyzeExpression(expression).reads) data.add(r);
      } else {
        const expr = analyzeExpression(expression);
        info.assignments.push({ target: t.text, operator: op, expression, index: t.index, conditions: conds, clock: [...edges], ...expr });
        data.add(t.text);
        for (const r of [...expr.reads, ...expr.blockedReads]) data.add(r);
      }
      return semi < end ? semi + 1 : end;
    }
    if (op === "(") boundaryAt(t.index, Math.max(i, findSemi(i + 1, end) - 1), "任务/函数调用（不继续推导）");
    return skipToSemi(i, end);
  }
}

/** 输入已去注释；按嵌套声明匹配 process/function/procedure 的范围，保留源码偏移。 */
export function scanVhdlRegion(text: string, from = 0): { end: number; begin: number; nested: { start: number; end: number }[]; closed: boolean } {
  const words = /[A-Za-z_]\w*|[();]/g;
  words.lastIndex = from;
  const stack: { kind: string; start: number }[] = [];
  const nested: { start: number; end: number }[] = [];
  let begin = -1, match: RegExpExecArray | null;
  while ((match = words.exec(text))) {
    const word = match[0].toLowerCase();
    if (word === "function" || word === "procedure") {
      // 参数列表中的分号不是原型声明结尾；只有顶层 is 才引入子程序体。
      let depth = 0, header: RegExpExecArray | null;
      while ((header = words.exec(text))) {
        const token = header[0].toLowerCase();
        if (token === "(") depth++;
        else if (token === ")") depth--;
        else if (!depth && (token === "is" || token === ";")) break;
      }
      if (!header) break;
      if (header[0] === ";") {
        if (!stack.length) return { end: words.lastIndex, begin, nested, closed: true };
        if (stack.length === 1) nested.push({ start: match.index, end: words.lastIndex });
        continue;
      }
      stack.push({ kind: word, start: match.index });
    } else if (word === "process" || word === "record") {
      stack.push({ kind: word, start: match.index });
    } else if (word === "begin" && stack.length === 1 && begin < 0) {
      begin = match.index;
    } else if (word === "end") {
      const close = /^\s*(?:([A-Za-z_]\w*)(?:\s+[A-Za-z_]\w*)?)?\s*;/.exec(text.slice(words.lastIndex));
      if (!close) continue;
      words.lastIndex += close[0].length;
      const tag = close[1]?.toLowerCase();
      if (tag && ["if", "case", "loop"].includes(tag)) continue;
      if (tag && ["architecture", "entity", "generate", "block"].includes(tag)) break;
      if (tag && ["process", "function", "procedure", "record"].includes(tag) && stack.at(-1)?.kind !== tag) break;
      const frame = stack.pop();
      if (!frame) break;
      if (stack.length === 1) nested.push({ start: frame.start, end: words.lastIndex });
      if (!stack.length) return { end: words.lastIndex, begin, nested, closed: true };
    }
  }
  return { end: text.length, begin, nested, closed: false };
}

/** VHDL process 语句级解析：与 Verilog 侧同为赋值池模型；`(...)` 位选/调用、循环、聚合目标为断点。 */
export function parseVhdlProcess(text: string): ProcInfo {
  const info: ProcInfo = { assignments: [], boundaries: [], controlSignals: [], dataSignals: [] };
  const masked = maskLiterals(text, true);
  const region = scanVhdlRegion(masked);
  if (!region.closed || region.begin < 0) {
    info.boundaries.push({ index: 0, endIndex: text.length, reason: "过程边界未确定（不继续推导）" });
    return info;
  }
  // 局部子程序按调用处显示边界，不将其声明内的赋值或时钟混入外层过程。
  let declarations = masked.slice(0, region.begin);
  for (const range of [...region.nested].reverse()) {
    declarations = declarations.slice(0, range.start) + declarations.slice(range.start, range.end).replace(/[^\n]/g, " ") + declarations.slice(range.end);
  }
  info.locals = [...declarations.matchAll(/\b(?:variable|constant)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:/gi)]
    .flatMap(m => m[1].split(",").map(name => name.trim().toLowerCase()));
  const tokens = tokenize(masked);
  const control = new Set<string>(), data = new Set<string>();
  const edges: string[] = [];
  let i = 0;
  if (tokens[0]?.text.toLowerCase() !== "process") return info;
  i = 1;
  if (tokens[i]?.text === "(") {
    const close = matchPair(i, "(", ")");
    for (let k = i + 1; k < close; k++) if (isVhdlIdent(tokens[k].text)) control.add(tokens[k].text.toLowerCase());
    i = close + 1;
  }
  if (tokens[i]?.text.toLowerCase() === "is") i++;
  const body = masked.slice(region.begin);
  for (const m of body.matchAll(/(?:rising_edge|falling_edge)\s*\(\s*([A-Za-z_]\w*)\s*\)/gi)) {
    if (!edges.some(e => e.toLowerCase() === m[1].toLowerCase())) edges.push(m[1]);
    control.add(m[1].toLowerCase());
  }
  for (const m of body.matchAll(/([A-Za-z_]\w*)\s*'\s*event\b/gi)) {
    if (!edges.some(e => e.toLowerCase() === m[1].toLowerCase())) edges.push(m[1]);
    control.add(m[1].toLowerCase());
  }
  while (i < tokens.length && tokens[i].index < region.begin) i++;
  if (i < tokens.length) parseSeq(i + 1, tokens.length, [], 0, new Set(["end"]));
  info.controlSignals = [...control];
  info.dataSignals = [...data];
  return info;

  function matchPair(open: number, l: string, r: string): number {
    let depth = 0;
    for (let k = open; k < tokens.length; k++) {
      if (tokens[k].text === l) depth++;
      else if (tokens[k].text === r) { depth--; if (!depth) return k; }
    }
    return tokens.length - 1;
  }
  function findSemi(from: number, end: number): number {
    let depth = 0;
    for (let k = from; k < end; k++) {
      const t = tokens[k].text;
      if (t === "(" || t === "[") depth++;
      else if (t === ")" || t === "]") depth--;
      else if (t === ";" && depth === 0) return k;
    }
    return end;
  }
  function skipToSemi(from: number, end: number): number {
    const k = findSemi(from, end);
    return k < end ? k + 1 : end;
  }
  function boundaryAt(startIndex: number, endToken: number, reason: string): void {
    const t = tokens[endToken];
    info.boundaries.push({ index: startIndex, endIndex: t ? t.index + t.text.length : text.length, reason });
  }
  function addConditionSignals(expression: string): void {
    const expr = analyzeExpression(expression, true);
    for (const r of [...expr.reads, ...expr.blockedReads]) control.add(r.toLowerCase());
  }
  /** 条件文本：从 start 到目标关键字（括号深度 0 处）。 */
  function condUntil(from: number, end: number, keyword: string): { text: string; next: number } {
    const startIndex = tokens[from]?.index ?? text.length;
    let k = from, depth = 0;
    while (k < end && !(tokens[k].text.toLowerCase() === keyword && depth === 0)) {
      if (tokens[k].text === "(") depth++;
      else if (tokens[k].text === ")") depth--;
      k++;
    }
    return { text: text.slice(startIndex, tokens[k]?.index ?? text.length).trim(), next: k };
  }

  function parseSeq(start: number, end: number, conds: string[], depth: number, stops: Set<string>): number {
    let i = start;
    while (i < end && depth < 200) {
      const t = tokens[i].text.toLowerCase();
      if (stops.has(t)) return i;
      if (t === "if") { i = parseIf(i, end, conds, depth); continue; }
      if (t === "case") { i = parseCase(i, end, conds, depth); continue; }
      if (/^(for|while|loop)$/.test(t)) { i = skipLoop(i, end); continue; }
      if (t === "wait" || t === "report" || t === "assert") { i = skipToSemi(i, end); continue; }
      if (tokens[i].text === "(") {
        const semi = findSemi(i + 1, end);
        boundaryAt(tokens[i].index, semi, "聚合目标赋值（不继续推导）");
        i = semi < end ? semi + 1 : end;
        continue;
      }
      if (isVhdlIdent(tokens[i].text)) {
        if (tokens[i + 1]?.text === ":") { i += 2; continue; } // 语句标签
        i = parseStatement(i, end, conds);
        continue;
      }
      i++;
    }
    return i;
  }

  function parseIf(i: number, end: number, conds: string[], depth: number): number {
    const first = condUntil(i + 1, end, "then");
    addConditionSignals(first.text);
    i = parseSeq(first.next + 1, end, [...conds, first.text], depth + 1, new Set(["elsif", "else", "end"]));
    const excluded = [`!(${first.text})`];
    while (tokens[i]?.text.toLowerCase() === "elsif") {
      const branch = condUntil(i + 1, end, "then");
      addConditionSignals(branch.text);
      i = parseSeq(branch.next + 1, end, [...conds, ...excluded, branch.text], depth + 1, new Set(["elsif", "else", "end"]));
      excluded.push(`!(${branch.text})`);
    }
    if (tokens[i]?.text.toLowerCase() === "else") {
      i = parseSeq(i + 1, end, [...conds, ...excluded], depth + 1, new Set(["end"]));
    }
    if (tokens[i]?.text.toLowerCase() === "end" && tokens[i + 1]?.text.toLowerCase() === "if") i += 2;
    if (tokens[i]?.text === ";") i++;
    return i;
  }

  function parseCase(i: number, end: number, conds: string[], depth: number): number {
    const head = condUntil(i + 1, end, "is");
    addConditionSignals(head.text);
    i = head.next + 1;
    while (i < end && depth < 200) {
      const t = tokens[i].text.toLowerCase();
      if (t === "end") break;
      if (t !== "when") { i++; continue; }
      const labelStart = tokens[i + 1]?.index ?? text.length;
      let k = i + 1;
      while (k < end && tokens[k].text !== "=>") k++;
      if (tokens[k]?.text !== "=>") return k;
      const labelText = text.slice(labelStart, tokens[k].index).trim();
      const cond = /^others\b/i.test(labelText) ? `case(${head.text}) others` : `${head.text} == ${labelText}`;
      i = parseSeq(k + 1, end, [...conds, cond], depth + 1, new Set(["when", "end"]));
    }
    if (tokens[i]?.text.toLowerCase() === "end") {
      i++;
      if (tokens[i]?.text.toLowerCase() === "case") i++;
      if (tokens[i]?.text === ";") i++;
    }
    return i;
  }

  function skipLoop(i: number, end: number): number {
    const start = tokens[i].index;
    let depth = 0, k = i;
    for (; k < end; k++) {
      const t = tokens[k].text.toLowerCase();
      if (t === "loop") depth++;
      else if (t === "end" && tokens[k + 1]?.text.toLowerCase() === "loop") {
        depth--;
        if (!depth) { k += 2; break; }
      }
    }
    if (tokens[k]?.text === ";") k++;
    boundaryAt(start, k - 1, "循环内逻辑（不继续推导）");
    return k;
  }

  function parseStatement(i: number, end: number, conds: string[]): number {
    const t = tokens[i];
    let j = i + 1;
    let selected = false;
    while (tokens[j]?.text === "(") { selected = true; j = matchPair(j, "(", ")") + 1; }
    const op = tokens[j]?.text;
    if (op === "<=" || op === ":=") {
      // 从运算符之后切原文：RHS 为纯字面量（遮蔽后无 token）时仍能保留展示文本
      const exprStart = tokens[j].index + tokens[j].text.length;
      const semi = findSemi(j + 1, end);
      const semiTok = tokens[semi];
      const expression = text.slice(exprStart, semiTok ? semiTok.index : text.length).trim();
      if (selected) {
        info.boundaries.push({ index: t.index, endIndex: semiTok ? semiTok.index + 1 : text.length, reason: "位选/切片赋值（范围转换）" });
        data.add(t.text.toLowerCase());
        for (const r of analyzeExpression(expression, true).reads) data.add(r.toLowerCase());
      } else {
        const expr = analyzeExpression(expression, true);
        info.assignments.push({ target: t.text, operator: op, expression, index: t.index, conditions: conds, clock: [...edges], ...expr });
        data.add(t.text.toLowerCase());
        for (const r of [...expr.reads, ...expr.blockedReads]) data.add(r.toLowerCase());
      }
      return semi < end ? semi + 1 : end;
    }
    if (selected) boundaryAt(t.index, Math.max(i, findSemi(i + 1, end) - 1), "函数/过程调用（不继续推导）");
    return skipToSemi(i, end);
  }
}
