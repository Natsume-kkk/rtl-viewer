import { detectLang, parseFileDetail, scanStructure, type InstanceInfo, type ModuleInfo } from "../parser";
import { analyzeExpression, parseVerilogProcess, parseVhdlProcess, scanVhdlRegion } from "../parser/procedural";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import { processTargetSource } from "../analysis/process";
import { sourceEntry } from "../analysis/source-cache";
import { cloneConstants, expandStaticGenerate, setConstant, specializeText, type ConstantValues, type SourceView } from "../parser/static-generate";
import { parseParameters } from "../parser/parameters";
import { mappingAccess } from "../parser/port-mapping";

interface Assignment {
  /** 连续赋值 RHS 在原文件中的精确偏移。 */
  expressionStart?: number;
  expressionSourceMap?: number[];
  selectors?: string[];
  targetText?:string;
  selectorReads?:string[];
  reason?:string;
  contexts?:string[];
  statement?: string;
  target: string; expression: string; direct: boolean; line: number; file: string;
  /** 过程内赋值的条件标注（if/case 外层在前） */
  conditions?: string[];
  /** 边沿敏感信号（非空 = 时钟过程，寄存器级） */
  clock?: string[];
  /** 过程序号（同一模块内），连续赋值为 -1 */
  proc?: number;
  /** RHS 中可追踪的标识符；VHDL 旧路径不填 */
  reads?: string[];
  /** RHS 中带位选被阻断的标识符 */
  blockedReads?: string[];
  hasCall?: boolean;
}
interface Boundary { text: string; line: number; file: string; reason: string; proc?: number; start?: number; end?: number; bindings?:Record<string,string> }
interface SourcePosition { file: string; line: number; column?: number }
export interface SignalModule extends ModuleInfo {
  parameterValues?: ConstantValues;
  sourceViews?: SourceView[];
  regions: { file: string; start: number; end: number }[];
  instances: (InstanceInfo & { file: string })[];
  assignments: Assignment[];
  boundaries: Boundary[];
  processes: { file: string; start: number; end: number; locals: Set<string>; text?: string; sourceMap?: number[]; generateScope?: string; localBindings?:{name:string;identity:string;start:number;end:number}[] }[];
  /** 只出现在敏感表/条件中、不作为数据链展开的信号 */
  controlOnly: Set<string>;
  controlSites: { signal: string; file: string; line: number; proc: number }[];
  /** 同一过程内被多次赋值的目标 */
  multiSameProc: Set<string>;
  /** 被多个过程/连续赋值驱动的目标 */
  multiDriver: Set<string>;
  problem?: string;
}
export interface SignalContext { module: string; path: string; parent?: SignalContext; instance?: InstanceInfo }
export interface SignalCandidate {name:string;scope:number;label:string}
export interface TraceNode {
  owner?: string;
  scope?: number;
  signal?: { path: string; name: string; identity?:string };
  port?: { path: string; name: string; direction?: string };
  mapping?: string;
  statement?: string;
  label: string; file?: string; line?: number; reason?: string; children: TraceNode[];
  sourceRows?: {text: string; line?: number}[];
  /** 行尾弱化标注（条件、表达式、多驱动等） */
  note?: string;
  /** 仅悬停提示的信息（寄存器级等） */
  tip?: string;
  target?: { context: SignalContext; signal: string };
}
export type TraceDirection = "upstream" | "downstream";
const identifier = /^[A-Za-z_]\w*$/;
const objectIdentity = (s:string)=>identifier.test(s)||/^@local:\d+:[A-Za-z_]\w*$/.test(s);
const displayObject = (s:string)=>s.replace(/^@local:\d+:/,"");
const targetObject = (s:string)=>/^(?:@local:\d+:[A-Za-z_]\w*|[A-Za-z_]\w*)/.exec(s)?.[0]??s;
const same = (a: string, b: string, file: string) => detectLang(file) === "vhdl" ? a.toLowerCase() === b.toLowerCase() : a === b;
const mentions = (text: string, name: string, file: string) => (text.match(/[A-Za-z_]\w*/g) ?? []).some(s => same(s, name, file));
const localScope = (mod: SignalModule, name: string, proc = -1) =>
  mod.processes[proc]?.locals.has(name.toLowerCase()) ? proc : -1;
const signalKey = (mod: SignalModule, name: string, proc = -1) => {
  const key = detectLang(mod.file) === "vhdl" ? name.toLowerCase() : name;
  const scope = localScope(mod, name, proc);
  return scope < 0 ? key : `${scope}:${key}`;
};

function processAccess(text: string, name: string, file: string, direction: TraceDirection): boolean {
  const assignments = /(^|[;\n)]|\bbegin\b|\bthen\b|\belse\b)\s*([A-Za-z_]\w*)(?:\s*\.\s*\w+)*\s*(?:\[[^\]]*\]|\([^)]*\))?\s*(<=|:=|=(?!=))/gi;
  let writes = false;
  const reads = text.replace(assignments, (whole, prefix: string, target: string, operator: string) => {
    if (same(target, name, file)) writes = true;
    return prefix + " " + operator;
  });
  return direction === "upstream" ? writes : mentions(reads, name, file);
}

function boundaryAccess(boundary:Boundary,name:string,direction:TraceDirection):boolean {
  const lexical=(value:string)=>value.replace(/^@local:(\d+):[A-Za-z_]\w*$/,"__process_local_$1");
  const text=boundary.bindings?boundary.text.replace(/\b[A-Za-z_]\w*\b/g,s=>lexical(boundary.bindings![detectLang(boundary.file)==="vhdl"?s.toLowerCase():s]??s)):boundary.text;
  return processAccess(text,lexical(name),boundary.file,direction);
}

/** 跳过配对的括号，返回右括号之后的位置。 */
function skipParens(body: string, i: number): number {
  let depth = 0;
  for (; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") { depth--; if (!depth) return i + 1; }
  }
  return i;
}

/** 无 begin 包裹的语句的结尾位置：普通语句取括号深度为 0 的分号，if 扩展 else 链，case 取 endcase，循环扩展到循环体。 */
function stmtEnd(body: string, from: number): number {
  let i = from;
  while (i < body.length && /\s/.test(body[i])) i++;
  const kw = /^[A-Za-z_]\w*/.exec(body.slice(i))?.[0] ?? "";
  if (kw === "begin") {
    const tokens = /\b(begin|end)\b/g;
    tokens.lastIndex = i;
    let depth = 0, token: RegExpExecArray | null;
    while ((token = tokens.exec(body))) {
      depth += token[1] === "begin" ? 1 : -1;
      if (depth === 0) return tokens.lastIndex;
    }
    return body.length;
  }
  if (/^(case|casex|casez)$/.test(kw)) {
    const tokens = /\b(case|casex|casez|endcase)\b/g;
    tokens.lastIndex = i;
    let depth = 0, token: RegExpExecArray | null;
    while ((token = tokens.exec(body))) {
      depth += token[1] === "endcase" ? -1 : 1;
      if (depth === 0) return tokens.lastIndex;
    }
    return body.length;
  }
  if (kw === "if") {
    let j = skipParens(body, i + kw.length);
    while (/\s/.test(body[j])) j++;
    const thenEnd = stmtEnd(body, j);
    const elseMatch = /^\s*else\b/.exec(body.slice(thenEnd));
    if (!elseMatch) return thenEnd;
    return stmtEnd(body, thenEnd + elseMatch[0].length);
  }
  if (/^(for|while|repeat)$/.test(kw)) {
    let j = i + kw.length;
    while (/\s/.test(body[j])) j++;
    if (body[j] === "(") j = skipParens(body, j);
    return stmtEnd(body, j);
  }
  if (kw === "forever") return stmtEnd(body, i + kw.length);
  let depth = 0;
  for (let k = i; k < body.length; k++) {
    const c = body[k];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) return k + 1;
  }
  return body.length;
}

/** VHDL 并发条件赋值拆分：`a when c else b` —— when 段作条件标注，其余段作数据候选。
    when 段含顶层逗号时是 with...select 选择赋值，标记 selected 由调用方产出边界，不硬拆。
    expression 为字符串已遮蔽的副本，display 为索引对齐的原文（条件展示用）。 */
function splitVhdlWhen(expression: string, display = expression): { valueText: string; conditions: string[]; selected?: boolean } | undefined {
  if (!/\bwhen\b/i.test(expression)) return undefined;
  const spans: [number, number][] = [];
  let pos = 0;
  for (const t of expression.matchAll(/\b(?:when|else)\b/gi)) { spans.push([pos, t.index!]); pos = t.index! + t[0].length; }
  spans.push([pos, expression.length]);
  for (let idx = 1; idx < spans.length; idx += 2) {
    let depth = 0;
    for (const c of expression.slice(...spans[idx])) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && !depth) return { valueText: "", conditions: [], selected: true };
    }
  }
  return {
    valueText: spans.filter((_, idx) => idx % 2 === 0).map(([s, e]) => expression.slice(s, e)).join("; "),
    conditions: spans.filter((_, idx) => idx % 2 === 1).map(([s, e]) => display.slice(s, e).trim()).filter(Boolean),
  };
}

function processRanges(body: string, vhdl: boolean): { index: number; text: string }[] {
  const result: { index: number; text: string }[] = [];
  const starts = vhdl ? /\b(process|function|procedure)\b/gi : /\b(always(?:_ff|_comb|_latch)?|initial|function|task)\b/g;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(body))) {
    if (vhdl && /\bend\s*$/i.test(body.slice(Math.max(0, match.index - 12), match.index))) continue;
    let end = body.length;
    if (vhdl) {
      end = scanVhdlRegion(body, match.index).end;
    } else if (/^(function|task)$/.test(match[1])) {
      const closing = new RegExp(`\\bend${match[1]}\\b`, "i").exec(body.slice(starts.lastIndex));
      if (closing) end = starts.lastIndex + closing.index + closing[0].length;
    } else {
      // Verilog always/initial：跳过 @(...) 敏感表后按语句结构取结尾（for 条件分号、case、if/else 链不截断）
      let stmt = starts.lastIndex;
      while (stmt < body.length && /\s/.test(body[stmt])) stmt++;
      if (body[stmt] === "@") {
        stmt++;
        while (stmt < body.length && /\s/.test(body[stmt])) stmt++;
        if (body[stmt] === "(") stmt = skipParens(body, stmt);
        else while (stmt < body.length && /[\w*]/.test(body[stmt])) stmt++;
      }
      end = stmtEnd(body, stmt);
    }
    result.push({ index: match.index, text: body.slice(match.index, end) });
    starts.lastIndex = end;
  }
  return result;
}

/** 仅在用户打开分析时创建；文件详细解析按访问模块缓存，不物化全工程实例树。 */
export class SignalProject {
  private structures: Map<string, ModuleInfo[]>;
  private detail = new Map<string, ModuleInfo[]>();
  private modules = new Map<string, SignalModule | undefined>();
  private specialized = new Map<string, SignalModule>();
  constructor(private files: Map<string, string>, structures?: Map<string, ModuleInfo[]>, private binding?: {name:string;file:string;start:number}) {
    this.structures = structures ?? new Map([...files].map(([file, source]) => [file, scanStructure(source, file)]));
  }

  /** 显式源码入口仅绑定当前模块实现；子模块仍按工程绑定规则处理。 */
  forSource(name: string, source: SourcePosition): SignalProject {
    const raw = this.files.get(source.file); if (raw === undefined) return this;
    const entry = sourceEntry(source.file, raw);
    const clean = entry.text(true);
    const scopes = entry.scopes(true, false);
    const offset = entry.lineOffset(source.line) + (source.column ?? 1) - 1;
    const matches = scopes.filter(s => same(s.name, name, source.file));
    const selected = matches.length === 1 ? matches[0] : matches.find(s => s.index <= offset && (scopes[scopes.indexOf(s) + 1]?.index ?? clean.length) > offset);
    return selected ? new SignalProject(this.files, this.structures, { name, file: source.file, start: selected.index }) : this;
  }

  owner(file: string, line: number, column?: number): string | undefined {
    const source = this.files.get(file);
    if (source === undefined) return undefined;
    const lines = source.split("\n").slice(0, line);
    if (column !== undefined) lines[lines.length - 1] = lines[lines.length - 1].slice(0, column - 1);
    const before = lines.join("\n");
    const clean = detectLang(file) === "vhdl" ? stripVhdlComments(before) : stripComments(before);
    const re = detectLang(file) === "vhdl" ? /\b(?:entity\s+(\w+)\s+is|architecture\s+\w+\s+of\s+(\w+)\s+is)/gi : /\bmodule\s+(\w+)/g;
    return [...clean.matchAll(re)].at(-1)?.slice(1).find(Boolean);
  }

  module(name: string): SignalModule | undefined {
    const key = name.toLowerCase();
    if (this.modules.has(key)) return this.modules.get(key);
    const parts: ModuleInfo[] = [];
    const sources: { file: string; source: string }[] = [];
    for (const [file, structures] of this.structures) {
      if (!structures.some(m => same(m.name, name, file))) continue;
      const source = this.files.get(file);
      if (source === undefined) continue;
      if (!this.detail.has(file)) this.detail.set(file, parseFileDetail(source, file));
      parts.push(...this.detail.get(file)!.filter(m => same(m.name, name, file)));
      sources.push({ file, source });
    }
    if (!parts.length) { this.modules.set(key, undefined); return undefined; }
    const binding = this.binding && same(this.binding.name,name,this.binding.file) ? this.binding : undefined;
    const definition = (binding && parts.find(p=>p.file===binding.file&&p.ports.length)) || parts.find(p => p.ports.length) || parts[0];
    const result: SignalModule = {
      ...definition,
      instances: parts.flatMap(p => p.instances.map(inst => ({ ...inst, file: p.file }))),
      assignments: [], boundaries: [], processes: [], regions: [],
      controlOnly: new Set(), controlSites: [], multiSameProc: new Set(), multiDriver: new Set(),
    };
    const control = new Set<string>(), data = new Set<string>();
    let architectureCount = 0;
    let moduleCount = 0;
    let procSeq = 0;
    for (const { file, source } of sources) {
      if (binding && binding.file !== file) continue;
      const vhdl = detectLang(file) === "vhdl";
      const fileEntry = sourceEntry(file, source);
      const clean = fileEntry.text(true);
      const scopes = fileEntry.scopes(true, true);
      for (let idx = 0; idx < scopes.length; idx++) {
        const scope = scopes[idx];
        if (!same(scope.name, name, file)) continue;
        if (binding && scope.index !== binding.start) continue;
        if (vhdl) architectureCount++;
        else moduleCount++;
        const start = scope.index;
        let end = scopes[idx + 1]?.index ?? clean.length;
        if (!vhdl) { const close = clean.indexOf("endmodule", start); if (close >= 0) end = Math.min(end, close); }
        result.regions.push({file,start,end});
        const body = fileEntry.text(false).slice(start, end);
        if (/\bgenerate\b/i.test(clean.slice(start,end))) result.problem = "generate 需展开后确定实例与连线";
        const procedural = processRanges(clean.slice(start,end), vhdl).map(p=>({...p,text:body.slice(p.index,p.index+p.text.length)}));
        const norm = (s: string) => vhdl ? s.toLowerCase() : s;
        for (const p of procedural) {
          const line = fileEntry.lineAt(start + p.index);
          // Verilog 函数/任务与 VHDL 函数/过程保持边界，不做过程内解析
          const head = p.text.trimStart();
          if (vhdl && !/^process\b/i.test(head)) { result.boundaries.push({ text: p.text, file, line, reason: "函数/过程（不继续推导）" }); continue; }
          if (!vhdl && !/^(always\w*|initial)\b/.test(head)) { result.boundaries.push({ text: p.text, file, line, start: start + p.index, end: start + p.index + p.text.length, reason: "函数/任务（不继续推导）" }); continue; }
          const parsed = vhdl ? parseVhdlProcess(p.text) : parseVerilogProcess(p.text);
          result.processes.push({ file, start: start + p.index, end: start + p.index + p.text.length, locals: new Set(parsed.locals),localBindings:parsed.localBindings?.map(b=>({...b,start:start+p.index+b.start,end:start+p.index+b.end})) });
          for (const pa of parsed.assignments) {
            result.assignments.push({
              target: pa.target+(pa.targetText?.replace(/^[A-Za-z_]\w*/,"")??""),targetText:pa.targetText, expression: pa.expression, statement: `${pa.targetText ?? displayObject(pa.target)} ${pa.operator} ${pa.expression};`,
              direct: !pa.hasCall && !pa.blockedReads.length && identifier.test(pa.targetText ?? pa.target) && identifier.test(pa.expression),
              file, line: fileEntry.lineAt(start + p.index + pa.index),
              conditions: pa.conditions, clock: pa.clock, proc: procSeq,
              selectors:pa.selectors,
              selectorReads:pa.selectorReads,reason:pa.reason,contexts:pa.contexts,
              reads: pa.reads, blockedReads: pa.blockedReads, hasCall: pa.hasCall,
            });
          }
          for (const b of parsed.boundaries) result.boundaries.push({ text: p.text.slice(b.index, b.endIndex), file, line: fileEntry.lineAt(start + p.index + b.index), reason: b.reason, proc: procSeq,bindings:b.bindings });
          for (const s of parsed.controlSignals) {
            control.add(signalKey(result, norm(s), procSeq));
            result.controlSites.push({ signal: norm(s), file, line, proc: procSeq });
          }
          for (const s of parsed.dataSignals) data.add(signalKey(result, norm(s), procSeq));
          procSeq++;
        }
        const assignments = vhdl
          ? /\b([A-Za-z_]\w*(?:\s*\.\s*\w+)*(?:\s*\([^;]*?\))?)\s*<=\s*([^;]+);/gd
          : /\b(?:assign\s+|wire\s+(?:(?:signed|unsigned)\s+)?(?:\[[^\]]+\]\s*)?)([A-Za-z_]\w*(?:\s*\[[^\]]*\])?)\s*=\s*([^;]+);/gd;
        // 匹配在字符串已遮蔽且索引对齐的 clean 副本上进行，展示文本仍取 body
        const masked = clean.slice(start, end);
        for (const a of masked.matchAll(assignments)) {
          if (procedural.some(p => a.index! >= p.index && a.index! < p.index + p.text.length)) continue;
          const statement = body.slice(a.index!, a.index! + a[0].length);
          // 遮蔽副本里字符串是空白，a[2] 边界不可靠；表达式取目标捕获组之后、结尾分号之前的原文
          const after = a.indices![1][1];
          const op = /^\s*(?:<=|=(?!=))\s*/.exec(body.slice(after, a.index! + a[0].length))!;
          const target = a[1].trim(), expression = body.slice(after + op[0].length, a.index! + a[0].length - 1).trim();
          const expressionStart = start + after + op[0].length;
          const entry: Assignment = { target, expression, expressionStart, statement: statement.trim(), direct: identifier.test(target) && identifier.test(expression), file, line: fileEntry.lineAt(start + a.index!), proc: -1 };
          // VHDL 并发条件赋值：when 段作条件标注，其余段作数据候选；选择赋值（逗号分隔 when 段）不硬拆
          const vhdlCond = vhdl ? splitVhdlWhen(masked.slice(after + op[0].length, a.index! + a[0].length - 1), body.slice(after + op[0].length, a.index! + a[0].length - 1)) : undefined;
          if (vhdlCond?.selected) {
            result.boundaries.push({ text: statement.trim(), file, line: entry.line, reason: "选择赋值（不继续推导）", proc: -1 });
            continue;
          }
          const expr = analyzeExpression(vhdlCond?.valueText ?? masked.slice(after + op[0].length, a.index! + a[0].length - 1), vhdl);
          entry.reads = expr.reads; entry.blockedReads = expr.blockedReads; entry.hasCall = expr.hasCall;
          if (vhdlCond) { entry.conditions = vhdlCond.conditions; entry.direct = false; }
          data.add(norm(target.replace(/\s*\[.*\]$/, "").replace(/\s*\(.*\)$/, "")));
          for (const r of [...expr.reads, ...expr.blockedReads]) data.add(norm(r));
          result.assignments.push(entry);
        }
      }
    }
    for (const s of control) if (!data.has(s)) result.controlOnly.add(s);
    const byTarget = new Map<string, Assignment[]>();
    for (const a of result.assignments) {
      const key = signalKey(result, targetObject(a.target), a.proc);
      const list = byTarget.get(key) ?? [];
      list.push(a);
      byTarget.set(key, list);
    }
    for (const [key, list] of byTarget) {
      const procs = new Set(list.map(a => a.proc ?? -1));
      if (procs.size > 1) result.multiDriver.add(key);
      for (const p of procs) if (list.filter(a => (a.proc ?? -1) === p).length > 1) result.multiSameProc.add(key);
    }
    if (architectureCount > 1) result.problem = "存在多个 architecture，尚未确定绑定";
    if (moduleCount > 1) result.problem = "存在多个同名 module，尚未确定绑定";
    if (binding) result.instances = result.instances.filter(inst=>result.regions.some(r=>{if(r.file!==inst.file)return false;const e=sourceEntry(r.file,this.files.get(r.file)!);return inst.line>=e.lineAt(r.start)&&inst.line<=e.lineAt(r.end);}));
    this.modules.set(key, result);
    return result;
  }

  /** 实例参数与静态 generate 只在显式分析时展开；不同实例不共享可变结果。 */
  moduleForContext(ctx: SignalContext): SignalModule | undefined {
    const base=this.module(ctx.module);if(!base)return;
    const cacheKey=`${ctx.path}:${ctx.module}:${JSON.stringify(ctx.instance?.parameterOverrides ?? [])}`;
    const cached=this.specialized.get(cacheKey);if(cached)return cached;
    const vhdl=detectLang(base.file)==="vhdl",norm=(s:string)=>vhdl?s.toLowerCase():s;
    const values:ConstantValues=new Map();
    const parentValues=ctx.instance?.parameterEnvironment??(ctx.parent?this.moduleForContext(ctx.parent)?.parameterValues??new Map():new Map());
    const overrides=ctx.instance?.parameterOverrides??[];
    for(const [i,p] of (base.parameters??[]).entries()) {
      const override=overrides.find((o,j)=>o.name?norm(o.name)===norm(p.name):j===i);
      const expression=override?.expression??p.defaultValue;
      const parentVhdl=ctx.parent?detectLang(this.module(ctx.parent.module)?.file??base.file)==="vhdl":vhdl;
      setConstant(values,norm(p.name),expression,override?parentValues:values,override?parentVhdl:vhdl,p.typeDeclaration);
    }
    for(const r of base.regions) {
      const clean=sourceEntry(r.file,this.files.get(r.file)!).text(false).slice(r.start,r.end);
      // 模块级常量在 generate 前声明；块内常量不能污染其他分支。
      const prefix=clean.split(vhdl?/\b\w+\s*:\s*(?:if|for|case)\b[\s\S]*?\bgenerate\b/i:/\bgenerate\b|\b(?:if|for|case|casex|casez)\s*\(/)[0];
      const re=vhdl?/\bconstant\s+(\w+)\s*:[^;]*?:=\s*([^;]+);/gi:/\b(?:localparam|parameter)\s+([^;]+);/g;
      for(const m of prefix.matchAll(re)) {
        const absolute=r.start+m.index!;
        if(base.processes.some(p=>p.file===r.file&&absolute>=p.start&&absolute<p.end))continue;
        if(vhdl)for(const p of parseParameters(m[0],m[0],true,true))setConstant(values,norm(p.name),p.defaultValue,values,true,p.typeDeclaration);
        else for(const p of parseParameters(m[1],m[1],false,true))if(!values.has(p.name))setConstant(values,p.name,p.defaultValue,values,false,p.typeDeclaration);
      }
    }
    const widthRegion={start:0,end:0,scope:"",values,names:new Map<string,string>()};
    const out:SignalModule={...base,ports:base.ports.map(p=>({...p,width:p.width?specializeText(p.width,0,widthRegion,vhdl,true).text:undefined})),parameterValues:values,sourceViews:[],instances:[],assignments:[],boundaries:[],processes:[],controlOnly:new Set(),controlSites:[],multiSameProc:new Set(),multiDriver:new Set()};
    if(base.problem?.startsWith("generate"))delete out.problem;
    for(const region of base.regions) {
      const raw=this.files.get(region.file)!,language=detectLang(region.file)==="vhdl";
      const excluded=[...base.processes.filter(p=>p.file===region.file),...base.boundaries.filter(b=>b.file===region.file&&b.start!==undefined&&b.end!==undefined).map(b=>({start:b.start!,end:b.end!}))];
      const plan=expandStaticGenerate(raw,region.start,region.end,values,language,excluded);
      for(const boundary of plan.boundaries)out.boundaries.push({...boundary,text:raw.slice(boundary.start,boundary.end),file:region.file,line:sourceEntry(region.file,raw).lineAt(boundary.start)});
      for(const active of plan.regions) {
        const transformed=specializeText(raw.slice(active.start,active.end),active.start,active,language);
        out.sourceViews!.push({...active,...transformed,file:region.file});
        const contains=(start:number)=>start>=active.start&&start<active.end;
        const procMap=new Map<number,number>();
        for(const [old,p] of base.processes.entries())if(p.file===region.file&&contains(p.start)) {
          const next=out.processes.length;procMap.set(old,next);
          out.processes.push({...p,...specializeText(raw.slice(p.start,p.end),p.start,active,language),generateScope:active.scope,locals:new Set(p.locals)});
        }
        for(const a of base.assignments)if(a.file===region.file&&((a.proc??-1)<0?contains(a.expressionStart??sourceEntry(region.file,raw).lineOffset(a.line)):procMap.has(a.proc!))) {
          const expression=specializeText(a.expression,a.expressionStart??sourceEntry(region.file,raw).lineOffset(a.line),active,language);
          const target=a.target.startsWith("@local:")?a.target:specializeText(a.target,0,active,language).text;
          const transformReads=(items:string[]|undefined)=>items?.map(s=>s.startsWith("@local:")?s:specializeText(s,0,active,language).text).filter(objectIdentity);
          out.assignments.push({...a,target,expression:expression.text,expressionSourceMap:expression.sourceMap,statement:a.statement?specializeText(a.statement,0,active,language).text:undefined,
            targetText:a.targetText?specializeText(a.targetText,0,active,language).text:undefined,
            conditions:a.conditions?.map(c=>specializeText(c,0,active,language).text),clock:a.clock?.map(c=>specializeText(c,0,active,language).text),
            selectors:a.selectors?.map(c=>specializeText(c,0,active,language).text),
            selectorReads:transformReads(a.selectorReads),contexts:a.contexts?.map(c=>specializeText(c,0,active,language).text),
            reads:transformReads(a.reads),blockedReads:transformReads(a.blockedReads),direct:objectIdentity(target)&&identifier.test(expression.text),proc:(a.proc??-1)<0?-1:procMap.get(a.proc!)});
        }
        for(const b of base.boundaries)if(b.file===region.file&&contains(b.start??sourceEntry(region.file,raw).lineOffset(b.line)))out.boundaries.push({...b,text:specializeText(b.text,0,active,language).text,proc:b.proc===undefined?undefined:procMap.get(b.proc)});
        for(const site of base.controlSites)if(site.file===region.file&&procMap.has(site.proc))out.controlSites.push({...site,signal:specializeText(site.signal,0,active,language).text,proc:procMap.get(site.proc)!});
        for(const inst of base.instances)if(inst.file===region.file&&contains(inst.start??sourceEntry(region.file,raw).lineOffset(inst.line))) {
          if(out.instances.length>=2000) {
            if(!out.boundaries.some(b=>b.reason==="generate 实例展开达到分析预算"))out.boundaries.push({file:region.file,line:sourceEntry(region.file,raw).lineAt(region.start),start:region.start,end:region.end,text:raw.slice(region.start,region.end),reason:"generate 实例展开达到分析预算"});
            continue;
          }
          out.instances.push({...inst,
            inst:active.scope?`${active.scope}.${inst.inst}`:inst.inst,
            connections:inst.connections?.map(c=>({...c,expr:specializeText(c.expr,0,active,language).text})),
            parameterOverrides:inst.parameterOverrides?.map(p=>({...p,expression:specializeText(p.expression,0,{...active,names:new Map()},language).text})),
            parameterEnvironment:cloneConstants(active.values),
          });
        }
      }
    }
    const groups=new Map<string,Assignment[]>();
    for(const a of out.assignments) {const key=signalKey(out,targetObject(a.target),a.proc);const list=groups.get(key)??[];list.push(a);groups.set(key,list);}
    for(const [key,entries]of groups){const procs=new Set(entries.map(a=>a.proc??-1));if(procs.size>1)out.multiDriver.add(key);if(entries.length>procs.size)out.multiSameProc.add(key);}
    const data=new Set(out.assignments.flatMap(a=>[targetObject(a.target),...(a.reads??[]),...(a.blockedReads??[])].map(n=>signalKey(out,n,a.proc))));
    for(const site of out.controlSites){const key=signalKey(out,site.signal,site.proc);if(!data.has(key))out.controlOnly.add(key);}
    this.specialized.set(cacheKey,out);return out;
  }

  root(module: string): SignalContext | undefined { return this.module(module) ? { module, path: module } : undefined; }
  assignmentSource(mod: SignalModule, proc: number, target: string): {text: string; line?: number}[] {
    const region = mod.processes[proc], source = this.files.get(region.file)!;
    const text = source.slice(region.start, region.end);
    const rows = processTargetSource(text, detectLang(region.file)!, target);
    if (rows) return rows.map(row => ({text: row.text, line: row.offset === undefined ? undefined : sourceEntry(region.file, source).lineAt(region.start + row.offset)}));
    // 不支持的过程仅展示原文，不重建或猜测其控制结构。
    const first = sourceEntry(region.file, source).lineAt(region.start);
    const sites = new Set(mod.assignments.filter(a => a.proc === proc && same(targetObject(a.target), target, a.file)).map(a => a.line));
    return text.split("\n").map((text, i) => ({text, line: sites.has(first + i) ? first + i : undefined}));
  }
  terminalReason(mod: SignalModule, name: string, direction: TraceDirection, scope = -1): string {
    let declared = scope >= 0 || mod.ports.some(p => same(p.name, name, mod.file));
    let remaining = false;
    for (const region of mod.regions) {
      const vhdl = detectLang(region.file) === "vhdl";
      let text = sourceEntry(region.file, this.files.get(region.file)!).text(true).slice(region.start, region.end);
      // 局部同名对象不能算模块信号的使用；局部入口也不能跨出所属过程。
      if (scope >= 0) {
        const proc = mod.processes[scope];
        if (proc.file !== region.file) continue;
        text = text.slice(proc.start - region.start, proc.end - region.start);
      } else {
        for (const p of [...mod.processes].reverse()) if (p.file === region.file && p.start >= region.start && p.end <= region.end && p.locals.has(name.toLowerCase())) text = text.slice(0,p.start-region.start) + " ".repeat(p.end-p.start) + text.slice(p.end-region.start);
      }
      text = text.replace(vhdl ? /\barchitecture\s+\w+\s+of\s+\w+\s+is\b/gi : /\bmodule\b[^;]*;/g, "");
      if (vhdl) {
        text = text.replace(/\battribute\b[^;]*;/gi, "");
        text = text.replace(/\b(?:signal|variable|constant)\s+([\w\s,]+)\s*:\s*([^;]+);/gi, (_all, names: string, type: string) => {
          const own = mentions(names, name, region.file); if (own) declared = true;
          const init = type.split(":=")[1];
          return init ? (direction === "upstream" && own ? `${name} <= ${init};` : init) : "";
        });
      } else {
        text = text.replace(/\b(?:wire|reg|logic|bit|integer|int|parameter|localparam)\s+([^;]+);/g, (_all, body: string) => {
          return body.replace(/\[[^\]]*\]/g, "").split(",").map(decl => {
            const [left, ...right] = decl.split("=");
            const own = left.trim().split(/\s+/).at(-1) === name; if (own) declared = true;
            return right.length ? (direction === "upstream" && own ? `${name} = ${right.join("=")};` : right.join("=")) : "";
          }).join(" ");
        });
      }
      // 已知例化的端口用途已在跨层追踪中处理，不把输出端的连接名再算作读取。
      for (const inst of mod.instances.filter(i => i.file === region.file)) {
        const re = new RegExp(`\\b${inst.inst}\\s*${vhdl ? ":" : "\\("}[^;]*;`, vhdl ? "gi" : "g");
        text = text.replace(re, "");
      }
      if (processAccess(text, name, region.file, direction)) remaining = true;
    }
    if (!declared) return "无法继续分析：未识别信号声明";
    if (remaining) return "无法继续分析：存在尚不支持的引用语句";
    return direction === "downstream" ? "无后续引用" : "无赋值来源";
  }
  /** 光标入口保留过程作用域；链内追踪则从赋值所在过程传播。 */
  signalScope(module: string, name: string, source?: SourcePosition): number {
    return this.signalIdentity(module,name,source).scope;
  }
  signalIdentity(module:string,name:string,source?:SourcePosition):{name:string;scope:number;candidates?:SignalCandidate[]} {
    const candidates=this.signalCandidates({module,path:module},name,source);
    if(candidates.length===1)return{name:candidates[0].name,scope:candidates[0].scope};
    return{name,scope:-1,candidates};
  }
  signalCandidates(ctx:SignalContext,name:string,source?:SourcePosition):SignalCandidate[] {
    const mod=this.moduleForContext(ctx);if(!mod)return[{name,scope:-1,label:displayObject(name)}];
    const raw=source&&this.files.get(source.file),offset=source&&raw!==undefined?sourceEntry(source.file,raw).lineOffset(source.line)+(source.column??1)-1:undefined;
    const candidates:SignalCandidate[]=[];
    for(const [scope,p] of mod.processes.entries()) {
      if(source&&p.file!==source.file||offset!==undefined&&(offset<p.start||offset>=p.end))continue;
      const binding=p.localBindings?.filter(b=>same(b.name,name,p.file)&&offset!==undefined&&offset>=b.start&&offset<b.end).sort((a,b)=>b.start-a.start)[0];
      const identity=(offset!==undefined||name.startsWith("@local:"))&&p.locals.has(name.toLowerCase())?name:binding?.identity;
      if(identity)candidates.push({name:identity,scope,label:[p.generateScope,displayObject(name)].filter(Boolean).join(".")});
    }
    if(candidates.length)return candidates;
    for(const view of mod.sourceViews??[]) {
      if(source&&view.file!==source.file||offset!==undefined&&(offset<view.start||offset>=view.end))continue;
      const generated=view.names?.get(detectLang(view.file)==="vhdl"?name.toLowerCase():name);
      const internal=generated??[...view.names?.values()??[]].find(n=>n===name);
      if(internal)candidates.push({name:internal,scope:-1,label:`${view.scope}.${generated?name:[...view.names!.entries()].find(([,v])=>v===name)?.[0]??name}`});
    }
    const unique=[...new Map(candidates.map(c=>[`${c.scope}:${c.name}`,c])).values()];
    return unique.length?unique:[{name,scope:-1,label:name}];
  }
  child(parent: SignalContext, instance: InstanceInfo): SignalContext {
    return { module: instance.module, path: `${parent.path}/${instance.inst}`, parent, instance };
  }
  contexts(top: string, module: string): { items: SignalContext[]; truncated: boolean } {
    // 先通过轻量结构反向筛出候选模块，详细解析不触及与目标无关的子树。
    const reachable=new Set([module.toLowerCase()]);let changed=true;
    while(changed){changed=false;for(const parts of this.structures.values())for(const part of parts)if(!reachable.has(part.name.toLowerCase())&&part.instances.some(i=>reachable.has(i.module.toLowerCase()))){reachable.add(part.name.toLowerCase());changed=true;}}
    if(!reachable.has(top.toLowerCase()))return{items:[],truncated:false};
    const root = { module: top, path: top };
    const queue: { context: SignalContext; ancestors: string[] }[] = [{ context: root, ancestors: [] }];
    const items: SignalContext[] = [];
    let visits = 0;
    while (queue.length && visits++ < 2000 && items.length < 100) {
      const { context, ancestors } = queue.shift()!;
      if (context.module.toLowerCase() === module.toLowerCase()) { items.push(context); continue; }
      if (ancestors.includes(context.module.toLowerCase()) || ancestors.length >= 32) continue;
      // 显式选择分析上下文时按访问路径特化，互斥分支和迭代身份与追踪一致。
      for(const inst of this.moduleForContext(context)?.instances??[])if(reachable.has(inst.module.toLowerCase())) queue.push({context:this.child(context,inst),ancestors:[...ancestors,context.module.toLowerCase()]});
    }
    return { items, truncated: queue.length > 0 };
  }
}

export async function traceSignal(project: SignalProject, context: SignalContext, signal: string, direction: TraceDirection,
  options: { maxNodes?: number; cancelled?(): boolean; source?: SourcePosition; scope?:number; stopAtAssignments?: boolean; localOnly?: boolean; descendOnly?: boolean } = {}): Promise<TraceNode> {
  let count = 0;
  const limit = options.maxNodes ?? 500;
  async function visit(ctx: SignalContext, name: string, seen: Set<string>, depth: number, scope = -1): Promise<TraceNode> {
    if (options.cancelled?.()) throw new Error("cancelled");
    const node: TraceNode = { label: `${ctx.path}.${displayObject(name)}`, owner: ctx.path, scope, signal: {path: ctx.path, name:displayObject(name),identity:name}, children: [] };
    if (++count > limit || depth > 40) { node.reason = "达到分析预算，结果未完全展开"; return node; }
    if (count % 24 === 0) await new Promise(r => setTimeout(r, 0));
    const mod = project.moduleForContext(ctx);
    if (!mod) { node.reason = "黑盒或缺失定义"; return node; }
    node.file = mod.file; node.line = mod.line;
    // The selected root points to the source occurrence that started the trace.
    // Following nodes retain their actual assignment/port-map locations below.
    if (depth === 0 && options.source) { node.file = options.source.file; node.line = options.source.line; }
    const declaredPort = scope < 0 ? mod.ports.find(p => same(p.name, name, mod.file)) : undefined;
    if (declaredPort) node.port = { path: ctx.path, name: declaredPort.name, direction: declaredPort.direction };
    if (mod.problem) { node.reason = mod.problem; return node; }
    if (options.descendOnly && depth > 0) {
      for (let parent = ctx.parent; parent; parent = parent.parent) {
        if (same(parent.module, ctx.module, mod.file)) { node.reason = "循环例化，停止重复展开"; return node; }
      }
    }
    const identity = signalKey(mod, name, scope);
    const key = `${ctx.path}:${identity}`;
    if (scope >= 0) node.tip = `过程局部对象（第 ${scope + 1} 个过程）`;
    if (seen.has(key)) { node.reason = "循环连接，停止重复展开"; return node; }
    const nextSeen = new Set(seen).add(key);
    const stop = (label: string, reason: string, file = mod.file, line = mod.line, note?: string, tip?: string) => {
      if (count >= limit) {
        if (!node.children.some(n => n.reason?.includes("分析预算"))) node.children.push({ label: "未展开分支", reason: "达到分析预算，结果未完全展开", children: [] });
        return;
      }
      count++;
      const leaf: TraceNode = { label, reason, file, line, note, tip, owner: ctx.path, scope, children: [] };
      node.children.push(leaf);
      return leaf;
    };
    const follow = async (next: SignalContext, nextName: string, note?: string, tip?: string, location?: { file: string; line: number }, nextScope = -1) => {
      if (count >= limit) { if (!node.children.some(n => n.reason?.includes("分析预算"))) stop("未展开分支", "达到分析预算，结果未完全展开"); return; }
      const child = await visit(next, nextName, nextSeen, depth + 1, nextScope);
      if (location) { child.file = location.file; child.line = location.line; }
      if (note) child.note = [child.note, note].filter(Boolean).join("；");
      if (tip) child.tip = [child.tip, tip].filter(Boolean).join("；");
      node.children.push(child);
    };
    const assignmentGroups = new Set<string>(), dataProcesses = new Set<number>();
    for (const a of mod.assignments) {
      if (signalKey(mod, name, a.proc) !== identity) continue;
      const dataRead=[...(a.reads??[]),...(a.blockedReads??[])].some(r=>same(r,name,a.file));
      const addressRead=a.selectorReads?a.selectorReads.some(s=>same(s,name,a.file)):a.selectors?.some(s=>!s.startsWith(".")&&mentions(s,name,a.file));
      const relevant = direction === "upstream" ? same(targetObject(a.target),name,a.file) : dataRead || options.stopAtAssignments && (addressRead||a.conditions?.some(c => mentions(c, name, a.file)));
      if (!relevant) continue;
      if ((a.proc ?? -1) >= 0) dataProcesses.add(a.proc!);
      if (options.stopAtAssignments) {
        const target = targetObject(a.target);
        const group = `${a.proc}:${signalKey(mod,target,a.proc)}`;
        if ((a.proc ?? -1) >= 0 && assignmentGroups.has(group)) continue;
        assignmentGroups.add(group);
        const rows = (a.proc ?? -1) >= 0 ? project.assignmentSource(mod,a.proc!,target) : undefined;
        const conditionOnly = direction === "downstream" && !dataRead;
        const leaf = stop(`${displayObject(target)} ← ${rows ? "过程赋值" : a.expression}`, "赋值位置", a.file, rows?.find(row=>row.line)?.line ?? a.line, [conditionOnly?addressRead?"写地址引用":"条件引用":undefined,a.reason].filter(Boolean).join("；")||undefined, a.clock?.join("，"));
        if (leaf) { leaf.target = { context: ctx, signal: target }; leaf.statement = rows ? rows.map(row=>row.text).join("\n") : a.statement; leaf.sourceRows = rows; }
        continue;
      }
      if (!a.reads) {
        // 防御：未做表达式分析的路径仅直接赋值穿透
        if (a.direct) await follow(ctx, direction === "upstream" ? a.expression : a.target, undefined, undefined, a);
        else stop(`${a.target} ← ${a.expression}`, "运算或范围转换（不继续推导）", a.file, a.line);
        continue;
      }
      if (!objectIdentity(a.target.trim())) {
        stop(`${a.targetText??displayObject(a.target)} ← ${a.expression}`, "位选/切片赋值（范围转换）", a.file, a.line);
        continue;
      }
      const parts: string[] = [];
      if (a.conditions?.length) parts.push(`条件: ${a.conditions.join("，")}`);
      if (!a.direct) parts.push(`${a.targetText??displayObject(a.target)} = ${a.expression}`);
      const key = targetObject(a.target);
      const mkey = signalKey(mod, key, a.proc);
      if (mod.multiSameProc.has(mkey)) parts.push("同一过程多次赋值，后者覆盖");
      else if (mod.multiDriver.has(mkey)) parts.push("多驱动");
      const note = parts.join("；") || undefined;
      const tip = a.clock?.length ? `寄存器级：${a.clock.join("，")}` : undefined;
      if(a.reason?.includes("循环")){stop(`${a.targetText??displayObject(a.target)} ← ${a.expression}`,a.reason,a.file,a.line,note,tip);continue;}
      const blockReason = detectLang(a.file) === "vhdl" ? "位选/下标/函数调用（不继续推导）" : "位选/切片（范围转换，不继续推导）";
      if (direction === "upstream") {
        if (a.hasCall) { stop(`${a.targetText??displayObject(a.target)} ← ${a.expression}`, "含函数调用（不继续推导）", a.file, a.line, note, tip); continue; }
        let followed = false;
        for (const r of a.reads) { followed = true; await follow(ctx, r, note, tip, a, localScope(mod, r, a.proc)); }
        if (a.blockedReads?.length) stop(`${a.targetText??displayObject(a.target)} ← ${a.expression}`, blockReason, a.file, a.line, note, tip);
        if (!followed && !a.blockedReads?.length) stop(`${a.targetText??displayObject(a.target)} ← ${a.expression}`, "常量赋值（终点）", a.file, a.line, note, tip);
      } else {
        if (a.hasCall) { stop(`${a.targetText??displayObject(a.target)} ← ${a.expression}`, "含函数调用（不继续推导）", a.file, a.line, note, tip); continue; }
        if (!a.reads.some(r => same(r, name, a.file))) {
          if ((a.blockedReads ?? []).some(b => same(b, name, a.file))) stop(`${a.target} ← ${a.expression}`, blockReason, a.file, a.line, note, tip);
          else if (a.conditions?.some(c => mentions(c,name,a.file))) stop(`${a.target} ← ${a.expression}`, "控制条件引用", a.file, a.line, note, tip);
          continue;
        }
        await follow(ctx, key, note, tip, a, localScope(mod, key, a.proc));
      }
    }
    for (const b of mod.boundaries) if (signalKey(mod, name, b.proc) === identity && (b.reason.includes("generate") ? mentions(b.text,name,b.file) : boundaryAccess(b,name,direction))) {
      stop(`${displayObject(name)} · ${b.file.split(/[\\/]/).pop()}:${b.line}`, b.reason, b.file, b.line);
    }
    if (direction === "downstream") {
        for (const site of mod.controlSites.filter(s => same(s.signal, name, s.file) && signalKey(mod, s.signal, s.proc) === identity && !dataProcesses.has(s.proc))) {
          stop(`${name} · ${site.file.split(/[\\/]/).pop()}:${site.line}`, "控制/时钟信号，不作为数据链展开", site.file, site.line);
        }
    }
    // 局部对象不参与模块端口或子实例连接，避免穿到同名模块信号。
    if (scope >= 0) {
      if (!node.children.length) node.reason = project.terminalReason(mod,name,direction,scope);
      return node;
    }
    const allows = (dir: string | undefined, upstream: boolean) => upstream ? ["output", "out", "buffer", "inout"].includes(dir ?? "") : ["input", "in", "inout"].includes(dir ?? "");
    for (const inst of mod.instances) {
      const instanceFile = inst.file;
      const child = project.moduleForContext(project.child(ctx,inst));
      for (const [i, conn] of (inst.connections ?? []).entries()) {
        const access=mappingAccess(conn.expr,detectLang(instanceFile)==="vhdl");
        const uncertainWrite=direction==="upstream"&&!access.writable&&access.reads.some(n=>same(n,name,mod.file));
        if (!uncertainWrite&&!(direction==="upstream"?access.targets:access.reads).some(n=>same(n,name,mod.file))) continue;
        const port = conn.port ? child?.ports.find(p => same(p.name, conn.port!, child.file)) : child?.ports[i];
        const pin = {path: `${ctx.path}/${inst.inst}`, name: port?.name ?? conn.port ?? String(i + 1), direction: port?.direction};
        if (!child || !port?.direction) {
          const leaf = stop(`${pin.path}.${pin.name}`, !child ? "黑盒或缺失定义，无法展开内部实现" : "端口方向未知，停止追踪", instanceFile, conn.line);
          if (leaf) leaf.port = pin;
          continue;
        }
        if (!allows(port.direction, direction === "upstream")) continue;
        const mapping=detectLang(instanceFile) === "vhdl" ? `${conn.port ?? port.name} => ${conn.expr}` : conn.port ? `.${conn.port}(${conn.expr})` : conn.expr;
        if(uncertainWrite) {
          const leaf=stop(`${inst.inst}.${port.name}`,"端口映射写入目标无法确定",instanceFile,conn.line);
          if(leaf){leaf.port=pin;leaf.mapping=mapping;}
        }else if (options.localOnly) {
          const leaf = stop(`${inst.inst}.${port.name}`, "子模块端口", instanceFile, conn.line);
          if (leaf) {leaf.port=pin;leaf.mapping=mapping;}
        }
        else {
          await follow(project.child(ctx, inst), port.name,identifier.test(conn.expr)?undefined:"端口表达式关系，未计算逐位对应", undefined, { file: instanceFile, line: conn.line });
          const leaf=node.children.at(-1);if(leaf&&!identifier.test(conn.expr))leaf.mapping=mapping;
        }
      }
    }
    const port = mod.ports.find(p => same(p.name, name, mod.file));
    if (port && allows(port.direction, direction === "downstream")) {
      if (options.localOnly || options.descendOnly || !ctx.parent) stop(name, options.localOnly || options.descendOnly ? "模块端口" : direction === "upstream" ? "顶层输入" : "顶层输出");
      else {
        const parent = project.moduleForContext(ctx.parent);
        const inst = parent?.instances.find(i => i.inst === ctx.instance?.inst && i.line === ctx.instance.line);
        const connection = inst?.connections?.find((c, i) => c.port ? same(c.port, port.name, mod.file) : mod.ports[i]?.name === port.name);
        if (!parent || parent.problem || !inst) stop(name, parent?.problem ?? "无法继续分析：实例绑定不明");
        else if (!connection || !connection.expr || /^open$/i.test(connection.expr)) stop(name, "未连接端口");
        else {
          const access=mappingAccess(connection.expr,detectLang(inst.file)==="vhdl");
          const names=direction==="upstream"?access.reads:access.targets;
          if(!names.length) {
            const leaf=stop(connection.expr,access.writable||direction==="upstream"?"常量端口映射（终点）":"端口映射写入目标无法确定",inst.file,connection.line);
            if(leaf){leaf.owner=ctx.parent.path;leaf.mapping=connection.expr;}
          }
          for(const next of names) {
            await follow(ctx.parent,next,identifier.test(connection.expr)?undefined:`端口映射：${connection.expr}；未计算逐位对应`,undefined,{file:inst.file,line:connection.line});
            const leaf=node.children.at(-1);if(leaf&&!identifier.test(connection.expr))leaf.mapping=connection.expr;
          }
        }
      }
    }
    if (!node.children.length) node.reason = project.terminalReason(mod,name,direction);
    return node;
  }
  const candidates=project.signalCandidates(context,signal,options.source).filter(c=>options.scope===undefined||c.scope===options.scope);
  if(candidates.length!==1)return{label:`${context.path}.${displayObject(signal)}`,file:options.source?.file,line:options.source?.line,reason:"当前位置对应多个生成块对象，请选择生成实例后分析",children:[]};
  const entry=candidates[0];
  return visit(context, entry.name, new Set(), 0, entry.scope);
}
