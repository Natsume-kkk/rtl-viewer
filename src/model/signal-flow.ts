import { detectLang, parseFileDetail, scanStructure, type InstanceInfo, type ModuleInfo } from "../parser";
import { analyzeExpression, parseVerilogProcess, parseVhdlProcess } from "../parser/procedural";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";

interface Assignment {
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
interface Boundary { text: string; line: number; file: string; reason: string }
export interface SignalModule extends ModuleInfo {
  instances: (InstanceInfo & { file: string })[];
  assignments: Assignment[];
  boundaries: Boundary[];
  /** 只出现在敏感表/条件中、不作为数据链展开的信号 */
  controlOnly: Set<string>;
  controlSites: { signal: string; file: string; line: number }[];
  /** 同一过程内被多次赋值的目标 */
  multiSameProc: Set<string>;
  /** 被多个过程/连续赋值驱动的目标 */
  multiDriver: Set<string>;
  problem?: string;
}
export interface SignalContext { module: string; path: string; parent?: SignalContext; instance?: InstanceInfo }
export interface TraceNode {
  label: string; file?: string; line?: number; reason?: string; children: TraceNode[];
  /** 行尾弱化标注（条件、表达式、多驱动等） */
  note?: string;
  /** 仅悬停提示的信息（寄存器级等） */
  tip?: string;
}
export type TraceDirection = "upstream" | "downstream";
const identifier = /^[A-Za-z_]\w*$/;
const same = (a: string, b: string, file: string) => detectLang(file) === "vhdl" ? a.toLowerCase() === b.toLowerCase() : a === b;
const mentions = (text: string, name: string, file: string) => (text.match(/[A-Za-z_]\w*/g) ?? []).some(s => same(s, name, file));
const lineAt = (src: string, offset: number) => src.slice(0, offset).split("\n").length;

function processAccess(text: string, name: string, file: string, direction: TraceDirection): boolean {
  const assignments = /(^|[;\n)]|\bbegin\b|\bthen\b|\belse\b)\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]|\([^)]*\))?\s*(<=|:=|=(?!=))/gi;
  let writes = false;
  const reads = text.replace(assignments, (whole, prefix: string, target: string, operator: string) => {
    if (same(target, name, file)) writes = true;
    return prefix + " " + operator;
  });
  return direction === "upstream" ? writes : mentions(reads, name, file);
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

/** VHDL 并发条件赋值拆分：`a when c else b` —— when 段作条件标注，其余段作数据候选。 */
function splitVhdlWhen(expression: string): { valueText: string; conditions: string[] } | undefined {
  if (!/\bwhen\b/i.test(expression)) return undefined;
  const segs = expression.split(/\b(?:when|else)\b/i);
  return {
    valueText: segs.filter((_, idx) => idx % 2 === 0).join("; "),
    conditions: segs.filter((_, idx) => idx % 2 === 1).map(s => s.trim()).filter(Boolean),
  };
}

function processRanges(body: string, vhdl: boolean): { index: number; text: string }[] {
  const result: { index: number; text: string }[] = [];
  const starts = vhdl ? /\b(process|function|procedure)\b/gi : /\b(always(?:_ff|_comb|_latch)?|initial|function|task)\b/g;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(body))) {
    if (vhdl && /\bend\s*$/i.test(body.slice(Math.max(0, match.index - 12), match.index))) continue;
    let end = body.length;
    if (vhdl || /^(function|task)$/.test(match[1])) {
      const closing = new RegExp(vhdl ? `\\bend\\s+${match[1]}\\b[^;]*;|\\bend(?:\\s+(?!if\\b|case\\b|loop\\b|record\\b|function\\b|procedure\\b)\\w+)?\\s*;` : `\\bend${match[1]}\\b`, "i").exec(body.slice(starts.lastIndex));
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
  constructor(private files: Map<string, string>, structures?: Map<string, ModuleInfo[]>) {
    this.structures = structures ?? new Map([...files].map(([file, source]) => [file, scanStructure(source, file)]));
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
    const definition = parts.find(p => p.ports.length) ?? parts[0];
    const result: SignalModule = {
      ...definition,
      instances: parts.flatMap(p => p.instances.map(inst => ({ ...inst, file: p.file }))),
      assignments: [], boundaries: [],
      controlOnly: new Set(), controlSites: [], multiSameProc: new Set(), multiDriver: new Set(),
    };
    const control = new Set<string>(), data = new Set<string>();
    let architectureCount = 0;
    let procSeq = 0;
    for (const { file, source } of sources) {
      const vhdl = detectLang(file) === "vhdl";
      const clean = (vhdl ? stripVhdlComments : stripComments)(source);
      const scopes = [...clean.matchAll(vhdl ? /\barchitecture\s+(\w+)\s+of\s+(\w+)\s+is\b/gi : /\bmodule\s+(\w+)\b/g)];
      for (let idx = 0; idx < scopes.length; idx++) {
        const scope = scopes[idx];
        if (!same(scope[vhdl ? 2 : 1], name, file)) continue;
        if (vhdl) architectureCount++;
        const start = scope.index!;
        let end = scopes[idx + 1]?.index ?? clean.length;
        if (!vhdl) { const close = clean.indexOf("endmodule", start); if (close >= 0) end = Math.min(end, close); }
        const body = clean.slice(start, end);
        if (/\bgenerate\b/i.test(body)) result.problem = "generate 需展开后确定实例与连线";
        const procedural = processRanges(body, vhdl);
        const norm = (s: string) => vhdl ? s.toLowerCase() : s;
        for (const p of procedural) {
          const line = lineAt(source, start + p.index);
          // Verilog 函数/任务与 VHDL 函数/过程保持边界，不做过程内解析
          const head = p.text.trimStart();
          if (vhdl && !/^process\b/i.test(head)) { result.boundaries.push({ text: p.text, file, line, reason: "函数/过程（不继续推导）" }); continue; }
          if (!vhdl && !/^(always\w*|initial)\b/.test(head)) { result.boundaries.push({ text: p.text, file, line, reason: "函数/任务（不继续推导）" }); continue; }
          const parsed = vhdl ? parseVhdlProcess(p.text) : parseVerilogProcess(p.text);
          for (const pa of parsed.assignments) {
            result.assignments.push({
              target: pa.target, expression: pa.expression,
              direct: !pa.hasCall && !pa.blockedReads.length && identifier.test(pa.target) && identifier.test(pa.expression),
              file, line: lineAt(source, start + p.index + pa.index),
              conditions: pa.conditions, clock: pa.clock, proc: procSeq,
              reads: pa.reads, blockedReads: pa.blockedReads, hasCall: pa.hasCall,
            });
          }
          for (const b of parsed.boundaries) result.boundaries.push({ text: p.text.slice(b.index, b.endIndex), file, line: lineAt(source, start + p.index + b.index), reason: b.reason });
          for (const s of parsed.controlSignals) {
            control.add(norm(s));
            result.controlSites.push({ signal: norm(s), file, line });
          }
          for (const s of parsed.dataSignals) data.add(norm(s));
          procSeq++;
        }
        const assignments = vhdl
          ? /\b([A-Za-z_]\w*(?:\s*\([^;]*?\))?)\s*<=\s*([^;]+);/g
          : /\bassign\s+([A-Za-z_]\w*(?:\s*\[[^\]]*\])?)\s*=\s*([^;]+);/g;
        for (const a of body.matchAll(assignments)) {
          if (procedural.some(p => a.index! >= p.index && a.index! < p.index + p.text.length)) continue;
          const target = a[1].trim(), expression = a[2].trim();
          const entry: Assignment = { target, expression, direct: identifier.test(target) && identifier.test(expression), file, line: lineAt(source, start + a.index!), proc: -1 };
          // VHDL 并发条件赋值：when 段作条件标注，其余段作数据候选
          const vhdlCond = vhdl ? splitVhdlWhen(expression) : undefined;
          const expr = analyzeExpression(vhdlCond?.valueText ?? expression, vhdl);
          entry.reads = expr.reads; entry.blockedReads = expr.blockedReads; entry.hasCall = expr.hasCall;
          if (vhdlCond) { entry.conditions = vhdlCond.conditions; entry.direct = false; }
          data.add(norm(target.replace(/\s*\[.*\]$/, "").replace(/\s*\(.*\)$/, "")));
          for (const r of [...expr.reads, ...expr.blockedReads]) data.add(norm(r));
          result.assignments.push(entry);
        }
      }
    }
    for (const s of control) if (!data.has(s)) result.controlOnly.add(s);
    const normKey = (s: string, file: string) => detectLang(file) === "vhdl" ? s.toLowerCase() : s;
    const byTarget = new Map<string, Assignment[]>();
    for (const a of result.assignments) {
      const key = normKey(a.target.replace(/\s*\[.*\]$/, "").replace(/\s*\(.*\)$/, ""), a.file);
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
    this.modules.set(key, result);
    return result;
  }

  root(module: string): SignalContext | undefined { return this.module(module) ? { module, path: module } : undefined; }
  child(parent: SignalContext, instance: InstanceInfo): SignalContext {
    return { module: instance.module, path: `${parent.path}/${instance.inst}`, parent, instance };
  }
  contexts(top: string, module: string): { items: SignalContext[]; truncated: boolean } {
    const root = { module: top, path: top };
    const queue: { context: SignalContext; ancestors: string[] }[] = [{ context: root, ancestors: [] }];
    const items: SignalContext[] = [];
    let visits = 0;
    while (queue.length && visits++ < 2000 && items.length < 100) {
      const { context, ancestors } = queue.shift()!;
      if (context.module.toLowerCase() === module.toLowerCase()) { items.push(context); continue; }
      if (ancestors.includes(context.module.toLowerCase()) || ancestors.length >= 32) continue;
      // 仅用结构边寻找上下文，不触发所有模块的端口解析。
      for (const parts of this.structures.values()) for (const part of parts) {
        if (same(part.name, context.module, part.file)) for (const inst of part.instances) {
          queue.push({ context: this.child(context, inst), ancestors: [...ancestors, context.module.toLowerCase()] });
        }
      }
    }
    return { items, truncated: queue.length > 0 };
  }
}

export async function traceSignal(project: SignalProject, context: SignalContext, signal: string, direction: TraceDirection,
  options: { maxNodes?: number; cancelled?(): boolean } = {}): Promise<TraceNode> {
  let count = 0;
  const limit = options.maxNodes ?? 500;
  async function visit(ctx: SignalContext, name: string, seen: Set<string>, depth: number): Promise<TraceNode> {
    if (options.cancelled?.()) throw new Error("cancelled");
    const node: TraceNode = { label: `${ctx.path}.${name}`, children: [] };
    if (++count > limit || depth > 40) { node.reason = "达到分析预算，结果未完全展开"; return node; }
    if (count % 24 === 0) await new Promise(r => setTimeout(r, 0));
    const mod = project.module(ctx.module);
    if (!mod) { node.reason = "黑盒或缺失定义"; return node; }
    node.file = mod.file; node.line = mod.line;
    if (mod.problem) { node.reason = mod.problem; return node; }
    const key = `${ctx.path}:${detectLang(mod.file) === "vhdl" ? name.toLowerCase() : name}`;
    if (seen.has(key)) { node.reason = "循环连接，停止重复展开"; return node; }
    const nextSeen = new Set(seen).add(key);
    const stop = (label: string, reason: string, file = mod.file, line = mod.line, note?: string, tip?: string) => {
      if (count >= limit) {
        if (!node.children.some(n => n.reason?.includes("分析预算"))) node.children.push({ label: "未展开分支", reason: "达到分析预算，结果未完全展开", children: [] });
        return;
      }
      count++;
      node.children.push({ label, reason, file, line, note, tip, children: [] });
    };
    const follow = async (next: SignalContext, nextName: string, note?: string, tip?: string, location?: { file: string; line: number }) => {
      if (count >= limit) { if (!node.children.some(n => n.reason?.includes("分析预算"))) stop("未展开分支", "达到分析预算，结果未完全展开"); return; }
      const child = await visit(next, nextName, nextSeen, depth + 1);
      if (location) { child.file = location.file; child.line = location.line; }
      if (note) child.note = [child.note, note].filter(Boolean).join("；");
      if (tip) child.tip = [child.tip, tip].filter(Boolean).join("；");
      node.children.push(child);
    };
    for (const a of mod.assignments) {
      const relevant = direction === "upstream" ? mentions(a.target, name, a.file) : mentions(a.expression, name, a.file);
      if (!relevant) continue;
      if (!a.reads) {
        // 防御：未做表达式分析的路径仅直接赋值穿透
        if (a.direct) await follow(ctx, direction === "upstream" ? a.expression : a.target, undefined, undefined, a);
        else stop(`${a.target} ← ${a.expression}`, "运算或范围转换（不继续推导）", a.file, a.line);
        continue;
      }
      if (!identifier.test(a.target.trim())) {
        stop(`${a.target} ← ${a.expression}`, "位选/切片赋值（范围转换）", a.file, a.line);
        continue;
      }
      const parts: string[] = [];
      if (a.conditions?.length) parts.push(`条件: ${a.conditions.join("，")}`);
      if (!a.direct) parts.push(`${a.target} = ${a.expression}`);
      const key = a.target.replace(/\s*\[.*\]$/, "").replace(/\s*\(.*\)$/, "");
      const mkey = detectLang(mod.file) === "vhdl" ? key.toLowerCase() : key;
      if (mod.multiSameProc.has(mkey)) parts.push("同一过程多次赋值，后者覆盖");
      else if (mod.multiDriver.has(mkey)) parts.push("多驱动");
      const note = parts.join("；") || undefined;
      const tip = a.clock?.length ? `寄存器级：${a.clock.join("，")}` : undefined;
      const blockReason = detectLang(a.file) === "vhdl" ? "位选/下标/函数调用（不继续推导）" : "位选/切片（范围转换，不继续推导）";
      if (direction === "upstream") {
        if (a.hasCall) { stop(`${a.target} ← ${a.expression}`, "含函数调用（不继续推导）", a.file, a.line, note, tip); continue; }
        let followed = false;
        for (const r of a.reads) { followed = true; await follow(ctx, r, note, tip, a); }
        if (a.blockedReads?.length) stop(`${a.target} ← ${a.expression}`, blockReason, a.file, a.line, note, tip);
        if (!followed && !a.blockedReads?.length) stop(`${a.target} ← ${a.expression}`, "常量赋值（终点）", a.file, a.line, note, tip);
      } else {
        if (a.hasCall) { stop(`${a.target} ← ${a.expression}`, "含函数调用（不继续推导）", a.file, a.line, note, tip); continue; }
        if (!a.reads.some(r => same(r, name, a.file))) {
          if ((a.blockedReads ?? []).some(b => same(b, name, a.file))) stop(`${a.target} ← ${a.expression}`, blockReason, a.file, a.line, note, tip);
          continue;
        }
        await follow(ctx, key, note, tip, a);
      }
    }
    for (const b of mod.boundaries) if (processAccess(b.text, name, b.file, direction)) {
      stop(`${name} · ${b.file.split(/[\\/]/).pop()}:${b.line}`, b.reason, b.file, b.line);
    }
    if (direction === "downstream") {
      for (const c of mod.controlOnly) if (same(c, name, mod.file)) {
        for (const site of mod.controlSites.filter(s => same(s.signal, name, s.file))) {
          stop(`${name} · ${site.file.split(/[\\/]/).pop()}:${site.line}`, "控制/时钟信号，不作为数据链展开", site.file, site.line);
        }
        break;
      }
    }
    const allows = (dir: string | undefined, upstream: boolean) => upstream ? ["output", "out", "buffer", "inout"].includes(dir ?? "") : ["input", "in", "inout"].includes(dir ?? "");
    for (const inst of mod.instances) {
      const instanceFile = inst.file;
      const child = project.module(inst.module);
      for (const [i, conn] of (inst.connections ?? []).entries()) {
        if (!mentions(conn.expr, name, mod.file)) continue;
        const port = conn.port ? child?.ports.find(p => same(p.name, conn.port!, child.file)) : child?.ports[i];
        if (!child) { stop(`${ctx.path}/${inst.inst}.${conn.port ?? i + 1}`, "黑盒或缺失定义", instanceFile, conn.line); continue; }
        if (!port?.direction) { stop(`${inst.inst}.${conn.port ?? i + 1}`, "端口方向未知", instanceFile, conn.line); continue; }
        if (!allows(port.direction, direction === "upstream")) continue;
        if (!identifier.test(conn.expr)) stop(`${inst.inst}.${port.name} ← ${conn.expr}`, "连接含运算或范围转换", instanceFile, conn.line);
        else await follow(project.child(ctx, inst), port.name, undefined, undefined, { file: instanceFile, line: conn.line });
      }
    }
    const port = mod.ports.find(p => same(p.name, name, mod.file));
    if (port && allows(port.direction, direction === "downstream")) {
      if (!ctx.parent) stop(name, direction === "upstream" ? "顶层输入" : "顶层输出");
      else {
        const parent = project.module(ctx.parent.module);
        const inst = parent?.instances.find(i => i.inst === ctx.instance?.inst && i.line === ctx.instance.line);
        const connection = inst?.connections?.find((c, i) => c.port ? same(c.port, port.name, mod.file) : mod.ports[i]?.name === port.name);
        if (!connection || !connection.expr || /^open$/i.test(connection.expr)) stop(name, "未连接端口");
        else if (!identifier.test(connection.expr)) stop(connection.expr, "常量、运算或范围转换", inst?.file, connection.line);
        else await follow(ctx.parent, connection.expr, undefined, undefined, { file: inst!.file, line: connection.line });
      }
    }
    if (!node.children.length) node.reason = "未发现可继续追踪的连线（不代表未使用）";
    return node;
  }
  return visit(context, signal, new Set(), 0);
}
