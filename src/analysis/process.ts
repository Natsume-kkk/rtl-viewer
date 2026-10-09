import type { HdlLang } from "../parser";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import { choose, parseExpression, reference, substitute, tokens, type Expr } from "./expression";

type Statement = { kind: "assign"; target: string; op: string; expr: Expr; start: number; end: number }
  | { kind: "branch"; condition: Expr; yes: Statement[]; no: Statement[]; display?: Expr["branch"] };

/** 只摘录该目标的赋值与原有控制结构，不使用符号化后的更新表达式。 */
export function processTargetSource(source: string, lang: HdlLang, target: string): {text: string; offset?: number}[] | undefined {
  const statements = analyzeProcess(source, lang).statements;
  if (!statements) return;
  const vhdl = lang === "vhdl", norm = (s: string) => vhdl ? s.toLowerCase() : s;
  const owns = (s: Statement): boolean => s.kind === "assign" ? norm(s.target) === norm(target) : [...s.yes, ...s.no].some(owns);
  const rows: {text: string; offset?: number}[] = [];
  const emit = (text: string, depth: number, offset?: number) => rows.push({text: "  ".repeat(depth) + text, offset});
  const first = statements[0];
  if (!first) return;
  const start = first.kind === "assign" ? first.start : first.display!.group;
  const header = source.slice(0, start).trim();
  if (header) rows.push({text: header});
  function seq(ss: Statement[], depth: number) {
    const relevant = ss.filter(owns);
    if (!relevant.length) { emit(vhdl ? "null;" : ";", depth); return; }
    for (const s of relevant) {
      if (s.kind === "assign") { emit(source.slice(s.start, s.end).trim(), depth, s.start); continue; }
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

/** 顺序执行受支持的过程语句，立即赋值环境与延迟提交环境分开。遇未知语句拒绝整个过程推导。 */
export function analyzeProcess(source: string, lang: HdlLang, offset = 0, vectors = new Set<string>()): ProcessResult {
  const clean = lang === "vhdl" ? stripVhdlComments(source, false) : stripComments(source, false);
  const ts = tokens(clean, offset), vhdl = lang === "vhdl";
  const result: ProcessResult = { updates: new Map(), operators: new Map(), sites: new Map(), locals: [], events: [], mode: "combinational", issues: [] };
  let i = 0, nesting = 0;
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
    return parseExpression(clean.slice(ts[from].start - offset, ts[i - 1].end - offset), lang, ts[from].start, vectors);
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
    else if (!vhdl && word() === "begin") { i++; out = seq(["end"]); need("end"); }
    else if (word() === ";" || vhdl && word() === "null") { if (word() === "null") i++; need(";"); out = []; }
    else {
      const t = ts[i], target = word(); i++;
      if (!/^[a-zA-Z_]\w*$/.test(target) || ["for", "while", "repeat", "forever", "wait", "function", "procedure", "task", "casex", "casez"].includes(target)) throw Error("循环、调用或未知语句，停止过程推导");
      const op = word();
      if (!(vhdl ? ["<=", ":="] : ["=", "<="]).includes(op)) throw Error("部分写入、调用或未知赋值，停止过程推导");
      i++; const expr = exprUntil([";"]); const end = ts[i]?.end; need(";");
      result.sites.set(target, { start: t.start, end });
      out = [{ kind: "assign", target, op, expr, start: t.start, end }];
    }
    nesting--; return out;
  }
  try {
    let statements: Statement[];
    if (vhdl) {
      need("process");
      const begin = ts.findIndex(t => t.text.toLowerCase() === "begin");
      if (begin < 0) throw Error("缺少过程体");
      const declarations = clean.slice(0, ts[begin].start - offset);
      result.sensitivity = /^process\s*\(([^)]+)\)/i.exec(clean.trimStart())?.[1].split(",").map(s => s.trim().toLowerCase());
      if (/\b(function|procedure|constant|type)\b/i.test(declarations)) throw Error("局部子程序或类型声明，停止过程推导");
      for (const m of declarations.matchAll(/\bvariable\s+([\w\s,]+)\s*:/gi)) result.locals.push(...m[1].split(",").map(s => s.trim().toLowerCase()));
      if (/:=/.test(declarations)) throw Error("局部变量初始化尚未推导");
      const edges = [...clean.matchAll(/\b(rising_edge|falling_edge)\s*\(\s*(\w+)\s*\)/gi)];
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
    const targets = new Set<string>(), operators = new Map<string, Set<string>>();
    function collect(ss: Statement[]) {
      for (const s of ss) if (s.kind === "assign") {
        targets.add(s.target); const set = operators.get(s.target) ?? new Set(); set.add(s.op); operators.set(s.target, set);
      } else { collect(s.yes); collect(s.no); }
    }
    collect(statements);
    if ([...operators.values()].some(s => s.size > 1)) throw Error("同目标混合立即与延迟赋值，停止推导");
    for (const [name, ops] of operators) result.operators.set(name, [...ops][0]);
    const old = (name: string): Expr => ({ ...reference(name), current: true });
    function execute(ss: Statement[], immediate: Map<string, Expr>, deferred: Map<string, Expr>): void {
      for (const s of ss) {
        if (s.kind === "assign") {
          const e = { ...substitute(s.expr, immediate), assignment: {start:s.start,end:s.end} };
          // 立即写入必须保留赋值转换，不能把窄目标当成原 RHS 直接代入后续表达式。
          if (s.op === "=" || s.op === ":=") immediate.set(s.target, { kind: "cast", value: s.target, text: "", args: [e], start: s.start, end: s.end, assignment:e.assignment });
          else deferred.set(s.target, e);
        } else {
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
          for (const name of targets) {
            immediate.set(name, choose(cond, yesI.get(name) ?? old(name), noI.get(name) ?? old(name), s.display));
            if (yesD.has(name) || noD.has(name)) deferred.set(name, choose(cond, yesD.get(name) ?? old(name), noD.get(name) ?? old(name), s.display));
          }
        }
      }
    }
    const immediate = new Map([...targets].map(name => [name, old(name)])), deferred = new Map<string, Expr>();
    execute(statements, immediate, deferred);
    for (const name of targets) if (!result.locals.includes(name)) result.updates.set(name, deferred.get(name) ?? immediate.get(name)!);
  } catch (error) {
    result.issues.push((error as Error).message); result.updates.clear(); result.mode = "boundary";
  }
  return result;
}
