import { KEYWORDS } from "./verilog";

/** Verilog 过程体（always/initial）语句级解析：赋值池模型，不分析语句顺序。 */

export interface ExprAnalysis { reads: string[]; blockedReads: string[]; hasCall: boolean }
export interface ProcAssign extends ExprAnalysis {
  operator: "=" | "<=" | ":=";
  target: string;
  targetText?: string;
  selectors?: string[];
  selectorReads?: string[];
  reason?: string;
  contexts?: string[];
  expression: string;
  /** 相对过程文本的偏移 */
  index: number;
  conditions: string[];
  /** 边沿敏感信号（非空 = 时钟过程） */
  clock: string[];
}
export interface ProcBoundary { index: number; endIndex: number; reason: string; bindings?: Record<string,string> }
export interface ProcLocalBinding { name:string; identity:string; start:number; end:number }
export interface ProcInfo {
  assignments: ProcAssign[];
  boundaries: ProcBoundary[];
  /** 敏感表与条件表达式中的信号 */
  controlSignals: string[];
  /** 赋值目标与 RHS 中的信号 */
  dataSignals: string[];
  /** 当前过程声明的局部对象，不含嵌套子程序的声明。 */
  locals?: string[];
  /** 块局部名字从声明至所属块结束的可见范围；相对过程文本偏移。 */
  localBindings?: ProcLocalBinding[];
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

/** 只识别循环头声明的局部名字，不求值或执行循环。 */
export function loopLocalDeclarations(header:string,vhdl=false):{name:string;index:number}[] {
  const ts=tokenize(header),word=(i:number)=>vhdl?ts[i]?.text.toLowerCase():ts[i]?.text;
  if(vhdl) return word(0)==="for"&&word(2)==="in"&&isVhdlIdent(ts[1]?.text??"")?[{name:word(1)!,index:ts[1].index}]:[];
  if(word(0)==="foreach") {
    const open=ts.findIndex(t=>t.text==="["),out:{name:string;index:number}[]=[];
    if(open<0)return out;
    for(let i=open+1;i<ts.length&&word(i)!=="]";i++) if(/^[A-Za-z_]\w*$/.test(word(i)??"")&&["[",","].includes(word(i-1)??""))out.push({name:word(i)!,index:ts[i].index});
    return out;
  }
  if(word(0)!=="for"||word(1)!=="(")return[];
  const builtin=/^(?:int|integer|bit|logic|reg|byte|shortint|longint|time|var)$/;
  const namedType=/^[A-Za-z_]\w*$/.test(word(2)??"")&&/^[A-Za-z_]\w*$/.test(word(3)??"")&&word(4)==="=";
  if(!builtin.test(word(2)??"")&&!namedType)return[];
  let i=3;while(/^(?:signed|unsigned|int|integer|bit|logic|reg|byte|shortint|longint|time)$/.test(word(i)??""))i++;
  while(word(i)==="[") {while(i<ts.length&&word(i)!=="]")i++;i++;}
  const out:{name:string;index:number}[]=[];
  while(i<ts.length&&word(i)!==";") {
    if(!/^[A-Za-z_]\w*$/.test(word(i)??""))break;
    out.push({name:word(i)!,index:ts[i].index});i++;
    let depth=0;
    while(i<ts.length) {const w=word(i);if(!depth&&(w===","||w===";"))break;if(["(","[","{"].includes(w??""))depth++;if([")","]","}"].includes(w??""))depth--;i++;}
    if(word(i)===",")i++;else break;
  }
  return out;
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
  const info: ProcInfo = { assignments: [], boundaries: [], controlSignals: [], dataSignals: [], locals: [], localBindings: [] };
  const tokens = tokenize(maskLiterals(text, false));
  const control = new Set<string>(), data = new Set<string>();
  const edges: string[] = [];
  const scopes: Map<string,string>[]=[new Map()];
  const scopeBindings:ProcLocalBinding[][]=[[]];
  const scopedName=(name:string):string=>{for(let k=scopes.length-1;k>=0;k--){const local=scopes[k].get(name);if(local)return local;}return name;};
  const facts=(expression:string):ExprAnalysis=>{const e=analyzeExpression(expression);return {...e,reads:e.reads.map(scopedName),blockedReads:e.blockedReads.map(scopedName)};};
  const bindings=():Record<string,string>=>Object.fromEntries(scopes.flatMap(scope=>[...scope]));
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
  info.boundaries.sort((a,b)=>a.index-b.index);
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
    info.boundaries.push({ index: startIndex, endIndex: t ? t.index + t.text.length : text.length, reason, bindings:bindings() });
  }
  function addConditionSignals(expression: string): void {
    const expr = facts(expression);
    for (const r of [...expr.reads, ...expr.blockedReads]) control.add(r);
  }

  function parseSeq(start: number, end: number, conds: string[], depth: number): number {
    if (depth >= 200) { boundaryAt(tokens[start]?.index ?? text.length, end - 1, "语句嵌套超过分析上限"); return end; }
    let i = start;
    while (i < end && depth < 200) {
      const t = tokens[i];
      if (t.text === "end" || t.text === "endcase") return i + 1;
      if (t.text === "begin") { i = parseBlock(i, end, conds, depth); continue; }
      if (/^(logic|reg|integer|int|bit|automatic|static)$/.test(t.text)) {i=parseDeclaration(i,end,conds);continue;}
      if (t.text === "if") { i = parseIf(i, end, conds, depth); continue; }
      if (/^(case|casex|casez)$/.test(t.text)) { i = parseCase(i, end, conds, depth); continue; }
      if (/^(for|foreach|while|repeat|forever)$/.test(t.text)) { i = parseLoop(i, end, conds, depth); continue; }
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
    if (t.text === "begin") return parseBlock(i, end, conds, depth);
    if (t.text === "if") return parseIf(i, end, conds, depth);
    if (/^(case|casex|casez)$/.test(t.text)) return parseCase(i, end, conds, depth);
    if (/^(for|foreach|while|repeat|forever)$/.test(t.text)) return parseLoop(i, end, conds, depth);
    if (t.text === "{") {
      const semi = findSemi(i + 1, end);
      boundaryAt(t.index, semi, "拼接目标赋值（不继续推导）");
      return semi < end ? semi + 1 : end;
    }
    if (isIdent(t.text) || t.text.startsWith("$")) return parseStatement(i, end, conds);
    return i + 1;
  }

  function parseBlock(i:number,end:number,conds:string[],depth:number):number {
    i++;if(tokens[i]?.text===":")i+=2;
    scopes.push(new Map());
    scopeBindings.push([]);
    i=parseSeq(i,end,conds,depth+1);
    const scopeEnd=tokens[i-1]?.text==="end"?tokens[i-1].index:text.length;
    for(const binding of scopeBindings.pop()!)binding.end=scopeEnd;
    scopes.pop();
    if(tokens[i]?.text===":")i+=2;
    return i;
  }

  function parseDeclaration(i:number,end:number,conds:string[]):number {
    i++;
    while(/^(signed|unsigned|logic|reg|integer|int|bit)$/.test(tokens[i]?.text??""))i++;
    while(tokens[i]?.text==="[")i=matchPair(i,"[","]")+1;
    const semi=findSemi(i,end);
    while(i<semi) {
      const t=tokens[i];if(!isIdent(t.text))break;
      const identity=`@local:${t.index}:${t.text}`;
      scopes.at(-1)!.set(t.text,identity);info.locals!.push(identity);i++;
      const binding={name:t.text,identity,start:t.index,end:text.length};
      info.localBindings!.push(binding);scopeBindings.at(-1)!.push(binding);
      while(tokens[i]?.text==="[")i=matchPair(i,"[","]")+1;
      if(tokens[i]?.text==="=") {
        const exprStart=tokens[i].index+1;let k=i+1,nesting=0;
        while(k<semi) {const w=tokens[k].text;if(!nesting&&w===",")break;if(["(","[","{"].includes(w))nesting++;if([")","]","}"].includes(w))nesting--;k++;}
        const expression=text.slice(exprStart,tokens[k]?.index??text.length).trim(),expr=facts(expression);
        info.assignments.push({target:identity,targetText:t.text,selectors:[],operator:"=",expression,index:t.index,conditions:conds,clock:[...edges],...expr});
        data.add(identity);expr.reads.forEach(r=>data.add(r));i=k;
      }
      if(tokens[i]?.text===",")i++;else break;
    }
    return semi<end?semi+1:end;
  }

  function parseIf(i: number, end: number, conds: string[], depth: number): number {
    if (depth >= 200) { boundaryAt(tokens[i].index, end - 1, "语句嵌套超过分析上限"); return end; }
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
    if (depth >= 200) { boundaryAt(tokens[i].index, end - 1, "语句嵌套超过分析上限"); return end; }
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

  function parseLoop(i: number, end: number,conds:string[],depth:number): number {
    if(depth>=200) {boundaryAt(tokens[i].index,end-1,"语句嵌套超过分析上限");return end;}
    const start = tokens[i].index;
    let j = i + 1;
    if (tokens[j]?.text === "(") j = matchPair(j, "(", ")") + 1;
    const header=text.slice(start,tokens[j]?.index??text.length).trim();
    scopes.push(new Map());scopeBindings.push([]);
    for(const declaration of loopLocalDeclarations(header)) {
      const index=start+declaration.index,identity=`@local:${index}:${declaration.name}`;
      scopes.at(-1)!.set(declaration.name,identity);info.locals!.push(identity);
      const binding={name:declaration.name,identity,start:index,end:text.length};
      info.localBindings!.push(binding);scopeBindings.at(-1)!.push(binding);
    }
    const firstAssignment=info.assignments.length,bodyEnd=parseStmt(j,end,conds,depth+1);
    for(const assignment of info.assignments.slice(firstAssignment)) {assignment.reason="循环内赋值只展示源码关系";assignment.contexts=[header,...assignment.contexts??[]];}
    boundaryAt(start, bodyEnd - 1, "循环内逻辑（不继续推导）");
    for(const binding of scopeBindings.pop()!)binding.end=tokens[bodyEnd]?.index??text.length;
    scopes.pop();
    return bodyEnd;
  }

  function parseStatement(i: number, end: number, conds: string[]): number {
    const t = tokens[i];
    if (t.text.startsWith("$")) return skipToSemi(i, end);
    let j = i + 1;
    const selectors: string[] = [];
    while (tokens[j]?.text === "[") { const close=matchPair(j,"[","]"); selectors.push(text.slice(tokens[j].index+1,tokens[close].index).trim()); j=close+1; }
    while(tokens[j]?.text === "." && isIdent(tokens[j+1]?.text ?? "")) { selectors.push("."+tokens[j+1].text); j+=2; }
    const selected = selectors.length > 0;
    const op = tokens[j]?.text;
    if (op === "<=" || op === "=") {
      // 从运算符之后切原文：RHS 为纯字面量（遮蔽后无 token）时仍能保留展示文本
      const exprStart = tokens[j].index + tokens[j].text.length;
      const semi = findSemi(j + 1, end);
      const semiTok = tokens[semi];
      const expression = text.slice(exprStart, semiTok ? semiTok.index : text.length).trim();
      if (selected) {
        info.boundaries.push({ index: t.index, endIndex: semiTok ? semiTok.index + 1 : text.length, reason: "位选/切片赋值（范围转换）", bindings:bindings() });
      }
      const expr = facts(expression), target=scopedName(t.text);
      const selectorReads=selectors.filter(s=>!s.startsWith(".")).flatMap(s=>{const e=facts(s);return [...e.reads,...e.blockedReads];});
      info.assignments.push({ target, targetText:text.slice(t.index,tokens[j].index).trim(), selectors, selectorReads, reason:selected?"位选/切片赋值（范围转换）":undefined, operator: op, expression, index: t.index, conditions: conds, clock: [...edges], ...expr });
      data.add(target);
      for (const r of [...expr.reads, ...expr.blockedReads, ...selectorReads]) data.add(r);
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
  const info: ProcInfo = { assignments: [], boundaries: [], controlSignals: [], dataSignals: [], localBindings: [] };
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
  const scopes:Map<string,string>[]=[new Map()];
  const scopedName=(name:string):string=>{for(let k=scopes.length-1;k>=0;k--){const local=scopes[k].get(name.toLowerCase());if(local)return local;}return name;};
  const facts=(expression:string):ExprAnalysis=>{const e=analyzeExpression(expression,true);return {...e,reads:e.reads.map(scopedName),blockedReads:e.blockedReads.map(scopedName)};};
  const bindings=():Record<string,string>=>Object.fromEntries(scopes.flatMap(scope=>[...scope]));
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
  info.boundaries.sort((a,b)=>a.index-b.index);
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
    info.boundaries.push({ index: startIndex, endIndex: t ? t.index + t.text.length : text.length, reason,bindings:bindings() });
  }
  function addConditionSignals(expression: string): void {
    const expr = facts(expression);
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
      if (/^(for|while|loop)$/.test(t)) { i = parseLoop(i, end,conds,depth); continue; }
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

  function parseLoop(i: number, end: number,conds:string[],depth:number): number {
    if(depth>=200) {boundaryAt(tokens[i].index,end-1,"语句嵌套超过分析上限");return end;}
    const start = tokens[i].index;
    let j=i+1;
    if(tokens[i].text.toLowerCase()!=="loop") {while(j<end&&tokens[j].text.toLowerCase()!=="loop")j++;j++;}
    const header=text.slice(start,tokens[j]?.index??text.length).trim(),locals:ProcLocalBinding[]=[];
    scopes.push(new Map());
    for(const declaration of loopLocalDeclarations(header,true)) {
      const index=start+declaration.index,identity=`@local:${index}:${declaration.name}`;
      scopes.at(-1)!.set(declaration.name,identity);info.locals!.push(identity);
      const binding={name:declaration.name,identity,start:index,end:text.length};
      info.localBindings!.push(binding);locals.push(binding);
    }
    const firstAssignment=info.assignments.length;
    let k=parseSeq(j,end,conds,depth+1,new Set(["end"]));
    if(tokens[k]?.text.toLowerCase()==="end"&&tokens[k+1]?.text.toLowerCase()==="loop")k+=2;
    if (tokens[k]?.text === ";") k++;
    for(const assignment of info.assignments.slice(firstAssignment)) {assignment.reason="循环内赋值只展示源码关系";assignment.contexts=[header,...assignment.contexts??[]];}
    boundaryAt(start, k - 1, "循环内逻辑（不继续推导）");
    for(const binding of locals)binding.end=tokens[k]?.index??text.length;
    scopes.pop();
    return k;
  }

  function parseStatement(i: number, end: number, conds: string[]): number {
    const t = tokens[i];
    let j = i + 1;
    const selectors: string[] = [];
    while (tokens[j]?.text === "(") { const close=matchPair(j,"(",")"); selectors.push(text.slice(tokens[j].index+1,tokens[close].index).trim()); j=close+1; }
    while(tokens[j]?.text === "." && isVhdlIdent(tokens[j+1]?.text ?? "")) { selectors.push("."+tokens[j+1].text); j+=2; }
    const selected = selectors.length > 0;
    const op = tokens[j]?.text;
    if (op === "<=" || op === ":=") {
      // 从运算符之后切原文：RHS 为纯字面量（遮蔽后无 token）时仍能保留展示文本
      const exprStart = tokens[j].index + tokens[j].text.length;
      const semi = findSemi(j + 1, end);
      const semiTok = tokens[semi];
      const expression = text.slice(exprStart, semiTok ? semiTok.index : text.length).trim();
      if (selected) {
        info.boundaries.push({ index: t.index, endIndex: semiTok ? semiTok.index + 1 : text.length, reason: "位选/切片赋值（范围转换）",bindings:bindings() });
      }
      const expr = facts(expression),target=scopedName(t.text);
      const selectorReads=selectors.filter(s=>!s.startsWith(".")).flatMap(s=>{const e=facts(s);return [...e.reads,...e.blockedReads];});
      info.assignments.push({ target, targetText:text.slice(t.index,tokens[j].index).trim(), selectors, selectorReads, reason:selected?"位选/切片赋值（范围转换）":undefined, operator: op, expression, index: t.index, conditions: conds, clock: [...edges], ...expr });
      data.add(target.toLowerCase());
      for (const r of [...expr.reads, ...expr.blockedReads, ...selectorReads]) data.add(r.toLowerCase());
      return semi < end ? semi + 1 : end;
    }
    if (selected) boundaryAt(t.index, Math.max(i, findSemi(i + 1, end) - 1), "函数/过程调用（不继续推导）");
    return skipToSemi(i, end);
  }
}
