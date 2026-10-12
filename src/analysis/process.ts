import type { HdlLang } from "../parser";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import { loopLocalDeclarations, scanVhdlRegion } from "../parser/procedural";
import { choose, parseExpression, reference, substitute, tokens, type Expr } from "./expression";

export interface ProcessAssignment {
  target: string;
  targetText: string;
  expression: Expr;
  selectors: Expr[];
  conditions: Expr[];
  start: number;
  end: number;
  operator: string;
  reason?: string;
  /** 未展开循环等外围源码结构，按外层到内层排列。 */
  contexts?: string[];
}
export interface ProcessBoundary {text:string;start:number;end:number;reason:string;contexts?:string[]}
type Statement = { kind: "assign"; target: string; targetText: string; selectors: Expr[]; op: string; expr: Expr; start: number; end: number }
  | { kind: "branch"; condition: Expr; yes: Statement[]; no: Statement[]; display?: Expr["branch"] }
  | { kind: "boundary"; body: Statement[]; start: number; end: number; reason: string; header?:string; writes?:string[]; all?: boolean };

/** 只摘录该目标的赋值与原有控制结构，不使用符号化后的更新表达式。 */
export function processTargetSource(source: string, lang: HdlLang, target: string): {text: string; offset?: number}[] | undefined {
  const statements = analyzeProcess(source, lang).statements;
  if (!statements) return;
  const vhdl = lang === "vhdl", norm = (s: string) => vhdl ? s.toLowerCase() : s;
  const owns = (s: Statement): boolean => s.kind === "assign" ? norm(s.target) === norm(target) : s.kind === "boundary" ? s.all === true || s.body.some(owns) : [...s.yes, ...s.no].some(owns);
  const rows: {text: string; offset?: number}[] = [];
  const emit = (text: string, depth: number, offset?: number) => rows.push({text: "  ".repeat(depth) + text, offset});
  const first = statements[0];
  if (!first) return;
  const start = first.kind === "branch" ? first.display!.group : first.start;
  const header = source.slice(0, start).trim();
  if (header) rows.push({text: header});
  function seq(ss: Statement[], depth: number) {
    const relevant = ss.filter(owns);
    if (!relevant.length) { emit(vhdl ? "null;" : ";", depth); return; }
    for (const s of relevant) {
      if (s.kind === "assign") { emit(source.slice(s.start, s.end).trim(), depth, s.start); continue; }
      if (s.kind === "boundary") { emit(source.slice(s.start, s.end).trim(), depth, s.start); continue; }
      if (s.display?.kind === "case") {
        emit(s.display.header!, depth);
        let arm = s;
        for (;;) {
          emit(arm.display!.guard + (vhdl ? "" : " begin"), depth + 1);
          seq(arm.yes, depth + 2);
          if (!vhdl) emit("end", depth + 1);
          const next = arm.no[0];
          if (arm.no.length === 1 && next?.kind === "branch" && next.display?.group === s.display.group) { arm = next; continue; }
          if (arm.no.length) {
            emit(arm.display!.alternate + (vhdl ? "" : " begin"), depth + 1);
            seq(arm.no, depth + 2);
            if (!vhdl) emit("end", depth + 1);
          }
          break;
        }
        emit(vhdl ? "end case;" : "endcase", depth);
      } else {
        let arm = s, firstArm = true;
        for (;;) {
          const guard = arm.display!.guard;
          emit((!vhdl && !firstArm ? "end else " : "") + guard + (vhdl ? "" : " begin"), depth);
          seq(arm.yes, depth + 1);
          const next = arm.no[0];
          if (arm.no.length === 1 && next?.kind === "branch" && next.display?.kind === "if" && (!vhdl || next.display.guard.startsWith("elsif"))) { arm = next; firstArm = false; continue; }
          if (arm.no.length) { emit(vhdl ? "else" : "end else begin", depth); seq(arm.no, depth + 1); }
          break;
        }
        emit(vhdl ? "end if;" : "end", depth);
      }
    }
  }
  seq(statements, 0);
  if (vhdl) emit("end process;", 0);
  else if (/\bbegin\s*$/.test(header)) emit("end", 0);
  return rows;
}
export interface ProcessResult {
  statements?: Statement[];
  assignments?: ProcessAssignment[];
  boundaries?: ProcessBoundary[];
  updates: Map<string, Expr>;
  operators: Map<string, string>;
  sites: Map<string, { start: number; end: number }>;
  locals: string[];
  events: string[];
  clock?: string;
  sensitivity?: string[];
  mode: "clocked" | "combinational" | "boundary";
  issues: string[];
}

/** 逐语句保留源码关系；只对可靠的目标推导最终值，立即与延迟环境分开。 */
export function analyzeProcess(source: string, lang: HdlLang, offset = 0, vectors = new Set<string>()): ProcessResult {
  const clean = lang === "vhdl" ? stripVhdlComments(source, false) : stripComments(source, false);
  const ts = tokens(clean, offset), vhdl = lang === "vhdl";
  const result: ProcessResult = { assignments: [], boundaries: [], updates: new Map(), operators: new Map(), sites: new Map(), locals: [], events: [], mode: "combinational", issues: [] };
  let i = 0, nesting = 0;
  const scopes: Map<string,string>[] = [new Map()];
  const scopedName=(name:string):string=>{for(let k=scopes.length-1;k>=0;k--) {const local=scopes[k].get(name);if(local) return local;}return name;};
  const scopeExpr=(e:Expr):Expr=>({...e,value:e.kind==="ref"?scopedName(e.value):e.value,args:e.args.map(scopeExpr)});
  const word = (at = i) => vhdl ? ts[at]?.text.toLowerCase() ?? "" : ts[at]?.text ?? "";
  const need = (s: string) => { if (word() !== s) throw Error(`语句未完整解析，预期 ${s}`); i++; };
  function exprUntil(stops: string[]): Expr {
    const from = i; let depth = 0;
    while (i < ts.length) {
      const w = word();
      if (!depth && stops.includes(w)) break;
      if (["(", "[", "{"].includes(w)) depth++;
      if ([")", "]", "}"].includes(w)) depth--;
      if (depth < 0) break;
      i++;
    }
    if (from === i) throw Error("缺少表达式");
    return scopeExpr(parseExpression(clean.slice(ts[from].start - offset, ts[i - 1].end - offset), lang, ts[from].start, vectors));
  }
  function seq(stops: string[]): Statement[] {
    const out: Statement[] = [];
    while (i < ts.length && !stops.includes(word())) out.push(...stmt());
    return out;
  }
  function branch(elsif = false): Statement {
    const start = ts[i].start;
    need(elsif ? "elsif" : "if");
    let condition: Expr;
    if (vhdl) { condition = exprUntil(["then"]); need("then"); }
    else { need("("); condition = exprUntil([")"]); need(")"); }
    const yes = vhdl ? seq(["elsif", "else", "end"]) : stmt();
    let no: Statement[] = [];
    const alternateStart = ts[i]?.start ?? start;
    if (vhdl && word() === "elsif") no = [branch(true)];
    else if (word() === "else") { i++; no = vhdl ? seq(["end"]) : stmt(); }
    if (vhdl && !elsif) { need("end"); need("if"); need(";"); }
    return { kind: "branch", condition, yes, no, display: {kind:"if",group:start,guard:vhdl?`${elsif?"elsif":"if"} ${condition.text} then`:`if (${condition.text})`,alternate:"else",alternateStart} };
  }
  function caseStatement(): Statement[] {
    const group = ts[i].start;
    i++;
    if (!vhdl) need("(");
    const subject = exprUntil([vhdl ? "is" : ")"]); i++;
    const header = vhdl ? `case ${subject.text} is` : `case (${subject.text})`;
    const arms: { condition: Expr; body: Statement[]; guard: string }[] = [];
    let alternateStart = group;
    let fallback: Statement[] = [], foundDefault = false;
    while (i < ts.length && word() !== (vhdl ? "end" : "endcase")) {
      const armStart = ts[i].start;
      if (vhdl) need("when");
      const isDefault = word() === (vhdl ? "others" : "default");
      const values: Expr[] = [];
      if (isDefault) { if (foundDefault) throw Error("重复默认分支"); foundDefault = true; i++; }
      else {
        values.push(exprUntil([vhdl ? "|" : ",", vhdl ? "=>" : ":"]));
        while (word() === (vhdl ? "|" : ",")) { i++; values.push(exprUntil([vhdl ? "|" : ",", vhdl ? "=>" : ":"])); }
      }
      need(vhdl ? "=>" : ":");
      const body = vhdl ? seq(["when", "end"]) : stmt();
      if (isDefault) { fallback = body; alternateStart = armStart; }
      else {
        const comparisons = values.map(value => ({ kind: "op" as const, value: vhdl ? "=" : "===", args: [subject, value], start: value.start, end: value.end, text: "" }));
        const condition = comparisons.reduce<Expr>((a, b) => a ? { ...b, value: vhdl ? "or" : "||", args: [a, b] } : b, undefined as unknown as Expr);
        arms.push({ condition, body, guard:vhdl?`when ${values.map(v=>v.text).join(" | ")} =>`:`${values.map(v=>v.text).join(", ")}:` });
      }
    }
    if (vhdl) { need("end"); need("case"); need(";"); } else need("endcase");
    for (const arm of arms.reverse()) fallback = [{ kind: "branch", condition: arm.condition, yes: arm.body, no: fallback, display:{kind:"case",group,header,guard:arm.guard,alternate:vhdl?"when others =>":"default:",alternateStart} }];
    return fallback;
  }
  function stmt(): Statement[] {
    if (++nesting > 100) throw Error("过程嵌套超过分析上限");
    let out: Statement[];
    if (word() === "if") out = [branch()];
    else if (word() === "case") out = caseStatement();
    else if (!vhdl && word() === "begin") { i++; if(word() === ":") { i += 2; } scopes.push(new Map()); out = seq(["end"]); need("end"); scopes.pop(); if(word() === ":") i += 2; }
    else if (word() === ";" || vhdl && word() === "null") { if (word() === "null") i++; need(";"); out = []; }
    else {
      const t = ts[i], target = word(); i++;
      if (["for", "foreach", "while", "repeat", "forever", "loop"].includes(target)) {
        if(vhdl && target !== "loop") { while(i < ts.length && word() !== "loop") i++; need("loop"); }
        else if(word() === "(") { let depth=0; do { if(word()==="(") depth++; else if(word()===")") depth--; i++; } while(i<ts.length && depth); if(depth) throw Error("循环头未闭合"); }
        const header=source.slice(t.start-offset,(ts[i]?.start??source.length+offset)-offset).trim();
        scopes.push(new Map());
        for(const declaration of loopLocalDeclarations(header,vhdl)) {
          const identity=`@local:${t.start+declaration.index}:${declaration.name}`;
          scopes.at(-1)!.set(declaration.name,identity);result.locals.push(identity);
        }
        const writes=vhdl?[]:[...header.matchAll(/\b([A-Za-z_]\w*)\s*(?:=(?!=)|\+\+|--)/g)].map(m=>scopedName(m[1]));
        const unknownHeaderCall=[...header.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].some(m=>m[1].toLowerCase()!==target);
        const body = vhdl ? seq(["end"]) : stmt();
        if(vhdl) { need("end"); need("loop"); need(";"); }
        scopes.pop();
        out = [{kind:"boundary",body,start:t.start,end:ts[i-1].end,header,writes,all:unknownHeaderCall,reason:"循环内赋值只展示源码关系"}];
        result.issues.push("循环内赋值只展示源码关系"); nesting--; return out;
      }
      if (!vhdl && /^(logic|reg|integer|int|bit|automatic|static)$/.test(target)) {
        out=[];
        while(["signed","unsigned","logic","reg","integer","int","bit"].includes(word())) i++;
        while(word()==="[") {i++;exprUntil(["]"]);need("]");}
        while(i<ts.length && word()!==";") {
          const localToken=ts[i], name=word();
          if(!/^[a-zA-Z_]\w*$/.test(name)) throw Error("局部声明未完整解析");
          i++;const identity=`@local:${localToken.start}:${name}`;
          scopes.at(-1)!.set(name,identity);result.locals.push(identity);
          while(word()==="[") {i++;exprUntil(["]"]);need("]");}
          if(word()==="=") {i++;const expr=exprUntil([",",";"]);out.push({kind:"assign",target:identity,targetText:name,selectors:[],op:"=",expr,start:localToken.start,end:ts[i].start});}
          if(word()===",") i++;else break;
        }
        need(";"); nesting--; return out;
      }
      const selectors: Expr[] = [];
      while(word() === (vhdl ? "(" : "[")) {
        i++; const close = vhdl ? ")" : "]";
        selectors.push(exprUntil([close, ":", "to", "downto"]));
        if(word() !== close) { i++; if(word() === ":") i++; selectors.push(exprUntil([close])); }
        need(close);
      }
      // Record/struct fields are partial writes as well.
      while(word() === ".") { i++; const field = ts[i++]; selectors.push({...reference(field.text,field.start,field.end),kind:"literal"}); }
      const op = word();
      if (!/^[a-zA-Z_]\w*$/.test(target) || !(vhdl ? ["<=", ":="] : ["=", "<="]).includes(op)) {
        while(i < ts.length && ![";", "end", "endcase"].includes(word())) i++;
        if(word() === ";") i++;
        out = [{kind:"boundary",body:[],start:t.start,end:ts[Math.max(i-1,0)].end,reason:"调用或未知语句，副作用未确定",all:true}];
        result.issues.push("调用或未知语句，副作用未确定"); nesting--; return out;
      }
      const targetText = source.slice(t.start-offset, ts[i].start-offset).trim();
      i++; const expr = exprUntil([";"]); const end = ts[i]?.end; need(";");
      const identity=scopedName(target);
      result.sites.set(identity, { start: t.start, end });
      out = [{ kind: "assign", target:identity, targetText, selectors, op, expr, start: t.start, end }];
    }
    nesting--; return out;
  }
  try {
    let statements: Statement[];
    if (vhdl) {
      need("process");
      const region = scanVhdlRegion(clean);
      const begin = ts.findIndex(t => t.start - offset === region.begin);
      if (begin < 0) throw Error("缺少过程体");
      let declarations = clean.slice(0, ts[begin].start - offset);
      for(const range of [...region.nested].reverse()) declarations=declarations.slice(0,range.start)+declarations.slice(range.start,range.end).replace(/[^\n]/g," ")+declarations.slice(range.end);
      result.sensitivity = /^process\s*\(([^)]+)\)/i.exec(clean.trimStart())?.[1].split(",").map(s => s.trim().toLowerCase());
      for (const m of declarations.matchAll(/\b(?:variable|constant)\s+([\w\s,]+)\s*:/gi)) result.locals.push(...m[1].split(",").map(s => s.trim().toLowerCase()));
      const edges = [...clean.slice(region.begin).matchAll(/\b(rising_edge|falling_edge)\s*\(\s*(\w+)\s*\)/gi)];
      const clocks = [...new Set(edges.map(m => `${m[1].toLowerCase()}(${m[2].toLowerCase()})`))];
      if (clocks.length > 1) throw Error("多时钟过程，停止推导");
      if (clocks.length) { result.mode = "clocked"; result.clock = clocks[0]; result.events = [...clocks]; }
      i = begin + 1; statements = seq(["end"]); need("end"); need("process");
      if (word() !== ";") i++; need(";");
    } else {
      if (!/^always(?:_ff|_comb|_latch)?$/.test(word())) throw Error("仅支持 always 过程");
      i++;
      if (word() === "@") {
        i++;
        if (word() === "(") {
          i++; const header = exprUntil([")"]); need(")");
          result.events = [...header.text.matchAll(/\b(posedge|negedge)\s+(\w+)/g)].map(m => `${m[1]} ${m[2]}`);
        } else need("*");
      }
      if (result.events.length) { result.mode = "clocked"; result.clock = result.events[0]; }
      statements = stmt();
      if (result.events.length > 1) {
        const first = statements[0];
        const reset = first?.kind === "branch" ? first.condition.text : "";
        const resetEvent = result.events.find(event => {
          const name = event.split(" ")[1];
          return new RegExp(`\\b${name}\\b`).test(reset);
        });
        const clocks = result.events.filter(event => event !== resetEvent);
        if (clocks.length !== 1) throw Error("无法区分时钟与异步控制");
        result.clock = clocks[0];
      }
    }
    if (i !== ts.length) throw Error("过程末尾存在未解析语句");
    result.statements = statements;
    const targets = new Set<string>(), operators = new Map<string, Set<string>>(), names = new Set<string>();
    const addNames=(e:Expr) => { if(e.kind==="ref") names.add(e.value); e.args.forEach(addNames); };
    function collect(ss: Statement[], conditions: Expr[] = [], reason?:string, contexts:string[] = []) {
      for (const s of ss) if (s.kind === "assign") {
        targets.add(s.target); const set = operators.get(s.target) ?? new Set(); set.add(s.op); operators.set(s.target, set);
        addNames(s.expr); s.selectors.forEach(addNames);
        const limited=reason ?? (s.selectors.length ? "部分写入，只展示目标范围与源码关系" : undefined);
        result.assignments!.push({target:s.target,targetText:s.targetText,expression:s.expr,selectors:s.selectors,conditions,start:s.start,end:s.end,operator:s.op,reason:limited,contexts});
        if(s.selectors.length) result.issues.push("部分写入，只展示目标范围与源码关系");
      } else if(s.kind === "boundary") {
        result.boundaries!.push({text:source.slice(s.start-offset,s.end-offset),start:s.start,end:s.end,reason:s.reason,contexts});
        collect(s.body,conditions,s.reason,s.header?[...contexts,s.header]:contexts);
      }
      else { addNames(s.condition); collect(s.yes,[...conditions,s.condition],reason,contexts); collect(s.no,[...conditions,{...s.condition,kind:"op",value:vhdl?"not":"!",args:[s.condition]}],reason,contexts); }
    }
    collect(statements);
    result.assignments!.sort((a,b)=>a.start-b.start);
    result.boundaries!.sort((a,b)=>a.start-b.start);
    const mixed=new Set([...operators].filter(([,ops])=>ops.size>1).map(([name])=>name));
    if(mixed.size) result.issues.push("同目标混合立即与延迟赋值，停止该目标推导");
    for (const [name, ops] of operators) result.operators.set(name, [...ops][0]);
    const old = (name: string): Expr => ({ ...reference(name), current: true });
    const uncertain=(name:string):Expr=>({...reference(name),kind:"unknown",value:"更新值未确定",args:[]});
    const unknownCall=(e:Expr):boolean=>e.kind==="call" && !e.conversion && !/^(rising_edge|falling_edge)$/.test(e.value) || e.args.some(unknownCall);
    const unreliable=(e:Expr):boolean=>e.kind==="unknown" || unknownCall(e) || e.args.some(unreliable);
    const invalidate=(affected:Iterable<string>,immediate:Map<string,Expr>,deferred:Map<string,Expr>)=>{
      for(const name of affected) { immediate.set(name,uncertain(name)); if(operators.get(name)?.has("<=")) deferred.set(name,uncertain(name)); }
    };
    function execute(ss: Statement[], immediate: Map<string, Expr>, deferred: Map<string, Expr>): void {
      for (const s of ss) {
        if(s.kind === "boundary") {
          const affected=new Set<string>(s.writes);
          const writes=(body:Statement[])=>body.forEach(x=>{ if(x.kind==="assign") affected.add(x.target); else if(x.kind==="branch") {writes(x.yes);writes(x.no);} else {x.writes?.forEach(n=>affected.add(n));if(x.all) [...names,...targets].forEach(n=>affected.add(n));writes(x.body);} });
          if(s.all) [...names,...targets].forEach(n=>affected.add(n)); else writes(s.body);
          invalidate(affected,immediate,deferred);
          continue;
        }
        if (s.kind === "assign") {
          if(unknownCall(s.expr)) { invalidate([...names,...targets],immediate,deferred); result.issues.push("未知函数调用的副作用未确定"); }
          const rhs = substitute(s.expr, immediate);
          const e = s.selectors.length || mixed.has(s.target) || unreliable(rhs) ? uncertain(s.target) : { ...rhs, assignment: {start:s.start,end:s.end} };
          if(unreliable(e)) { const assignment=result.assignments!.find(a=>a.start===s.start); if(assignment && !assignment.reason) assignment.reason="更新值未确定，只展示源码关系"; }
          // 立即写入必须保留赋值转换，不能把窄目标当成原 RHS 直接代入后续表达式。
          if (s.op === "=" || s.op === ":=") immediate.set(s.target, { kind: "cast", value: s.target, text: "", args: [e], start: s.start, end: s.end, assignment:e.assignment });
          else deferred.set(s.target, e);
        } else {
          if(unknownCall(s.condition)) {invalidate([...names,...targets],immediate,deferred);result.issues.push("未知条件调用的副作用未确定");}
          const cond = substitute(s.condition, immediate);
          if (vhdl && cond.kind === "call" && /^(rising_edge|falling_edge)$/.test(cond.value)) {
            if (s.no.length) throw Error("时钟边沿的非边沿分支尚未支持");
            const beforeI=new Map(immediate),beforeD=new Map(deferred);
            execute(s.yes, immediate, deferred);
            for(const [values,before] of [[immediate,beforeI],[deferred,beforeD]])for(const [name,value]of values){
              if(value!==before.get(name))values.set(name,{...value,event:cond.text,eventStart:cond.start});
            }
            continue;
          }
          const yesI = new Map(immediate), noI = new Map(immediate), yesD = new Map(deferred), noD = new Map(deferred);
          execute(s.yes, yesI, yesD); execute(s.no, noI, noD);
          for (const name of new Set([...targets,...yesI.keys(),...noI.keys()])) {
            const before=immediate.get(name) ?? old(name);
            immediate.set(name, choose(cond, yesI.get(name) ?? before, noI.get(name) ?? before, s.display));
            if (yesD.has(name) || noD.has(name)) deferred.set(name, choose(cond, yesD.get(name) ?? old(name), noD.get(name) ?? old(name), s.display));
          }
        }
      }
    }
    const immediate = new Map([...targets,...result.locals].map(name => [name, result.locals.includes(name) ? uncertain(name) : old(name)])), deferred = new Map<string, Expr>();
    execute(statements, immediate, deferred);
    for (const name of targets) if (!result.locals.includes(name)) { const value=deferred.get(name) ?? immediate.get(name)!; if(!unreliable(value)) result.updates.set(name,value); }
    if(result.issues.length) result.mode="boundary";
  } catch (error) {
    result.issues.push((error as Error).message); result.updates.clear(); result.mode = "boundary";
  }
  return result;
}
