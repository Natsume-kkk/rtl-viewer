import { detectLang, type HdlLang } from "../parser";
import { SignalProject, type SignalContext, type SignalModule } from "../model/signal-flow";
import { formatExpr, parseExpression, refs, type Expr } from "./expression";
import { analyzeProcess, type ProcessResult } from "./process";
import { sourceEntry } from "./source-cache";
import { collectSourceObjects, sourceTypeShape, type SourceObject } from "./objects";

export interface SourceSpan { file: string; start: number; end: number }
export interface ComputationNode {
  id: string; kind: "signal" | "operation" | "register" | "current" | "resolved" | "external" | "boundary" | "constant" | "input" | "control";
  label: string; detail: string; path: string; signal?: string; source?: SourceSpan;
  expressions?: Expr[];
  expression?: Expr;
  expressionTarget?: string;
}
export interface ComputationEdge { from: string; to: string; role: string }
export interface ComputationGraph { root: string; nodes: ComputationNode[]; edges: ComputationEdge[] }
export interface Driver { expression: Expr; source: SourceSpan; process?: ProcessResult; operator?: string; relation?: boolean; targetText?: string; selectors?: Expr[]; conditions?: Expr[]; reason?: string; initialization?: boolean; contexts?: string[] }
export interface ModuleAnalysis { mod: SignalModule; drivers: Map<string, Driver[]>; widths: Map<string, string>; vectors: Set<string>; lang: HdlLang; objects: Map<string, SourceObject> }
export function driverCount(ds: Driver[]): number { return new Set(ds.filter(d => !d.initialization).map(d => d.process ?? d)).size; }
export interface Load { path: string; signal: string; label: string; source?: SourceSpan }
function mapExpression(e: Expr, base: number, map?: number[]): Expr {
  if (!map) return e;
  const at = (offset: number) => map[offset - base] ?? offset;
  return { ...e, start: at(e.start), end: at(e.end), args: e.args.map(a => mapExpression(a, base, map)),
    ...(e.assignment ? { assignment: { start: at(e.assignment.start), end: at(e.assignment.end) } } : {}),
    ...(e.eventStart === undefined ? {} : { eventStart: at(e.eventStart) }),
    ...(e.branch ? { branch: { ...e.branch, group: at(e.branch.group), alternateStart: at(e.branch.alternateStart) } } : {}) };
}

/** 按访问模块惰性分析；仅在用户打开信号链时构建。 */
export class ComputationProject {
  private connections: SignalProject;
  private cache = new Map<string, ModuleAnalysis>();
  constructor(readonly files: Map<string, string>, connections?: SignalProject) {
    this.connections = connections ?? new SignalProject(files);
  }
  get tops(): string[] { return [...new Set([...this.files].flatMap(([file, text]) => [...text.matchAll(detectLang(file) === "vhdl" ? /\bentity\s+(\w+)\s+is/gi : /\bmodule\s+(\w+)/g)].map(m => m[1])))]; }
  moduleData(ctx: SignalContext): ModuleAnalysis | undefined { return this.analyze(ctx); }
  context(path: string): SignalContext | undefined {
    const [root, ...names] = path.split("/");
    let ctx = this.connections.root(root);
    while (names.length) {
      if (!ctx) return;
      const rest = names.join("/");
      const inst = this.connections.moduleForContext(ctx)?.instances.find(inst => rest === inst.inst || rest.startsWith(inst.inst + "/"));
      if (!inst) return;
      ctx = this.connections.child(ctx, inst);
      names.splice(0, inst.inst.split("/").length);
    }
    return ctx;
  }
  private analyze(ctx: SignalContext): ModuleAnalysis | undefined {
    const mod = this.connections.moduleForContext(ctx);
    if (!mod) return;
    const key = `${ctx.path}:${mod.file}:${mod.name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const lang = detectLang(mod.file)!, drivers = new Map<string, Driver[]>(), widths = new Map<string, string>(), vectors = new Set<string>();
    const objects = collectSourceObjects(this.files, mod);
    if (mod.problem) { const out={mod,drivers,widths,vectors,lang,objects}; this.cache.set(key,out); return out; }
    const normal = (s: string) => lang === "vhdl" ? s.toLowerCase() : s;
    const add = (name: string, d: Driver) => { name = normal(name); const list = drivers.get(name) ?? []; list.push(d); drivers.set(name, list); };
    for (const port of mod.ports) { widths.set(normal(port.name), port.width || "标量"); }
    let accessVisits = 0;
    const addAccess = (path: string, shape: Pick<SourceObject, "array" | "record">, depth = 0) => {
      if (depth >= 16 || accessVisits++ >= 1024) return;
      if (shape.array) {
        vectors.add(path);
        addAccess(`${path}[]`, sourceTypeShape(shape.array.elementType, objects, lang === "vhdl"), depth + 1);
      }
      for (const field of shape.record?.fields ?? []) addAccess(`${path}.${normal(field.name)}`, sourceTypeShape(field.type, objects, lang === "vhdl"), depth + 1);
    };
    for (const [name, object] of objects) {
      if (object.kind === "type") continue;
      widths.set(name, object.type);
      addAccess(name, object);
      if (lang === "verilog" && /\[/.test(object.type)) vectors.add(name);
    }
    for (const [name, object] of objects) if (object.initializer && object.kind !== "type" && object.kind !== "port" && !/^wire\b/.test(object.type)) {
      const at = this.files.get(object.source.file)?.indexOf(object.initializer, object.source.start) ?? object.source.start;
      const expression = parseExpression(object.initializer, lang, at < 0 ? object.source.start : at, vectors);
      add(name, { expression, initialization: true, relation: true, targetText: name, reason: "声明初始化：不是持续赋值或仿真后的当前值", source: object.source });
    }
    for (const a of mod.assignments.filter(a => a.proc === -1)) {
      const raw = this.files.get(a.file)!;
      const start = sourceEntry(a.file, raw).lineOffset(a.line);
      const at = a.expressionStart ?? start;
      const name = /^(\w+)/.exec(a.target)?.[1] ?? a.target;
      const expression = mapExpression(parseExpression(a.expression, lang, at >= 0 ? at : start, vectors), at >= 0 ? at : start, a.expressionSourceMap);
      const partial = !/^\w+$/.test(a.target), target = partial ? parseExpression(a.target, lang, start, vectors) : undefined;
      add(name, { expression, operator: lang === "vhdl" ? "<=" : "=", source: { file: a.file, start: at >= 0 ? at : start, end: at >= 0 ? at + a.expression.length : start + 1 }, ...(partial ? { relation: true, targetText: a.target, selectors: target?.args.slice(1) ?? [], reason: "部分目标写入，保留源码关系；完整更新值未求解" } : {}) });
    }
    // The lightweight binding index can omit record-field LHS syntax. Only known fields qualify.
    for (const view of mod.sourceViews ?? []) {
      const text = sourceEntry(view.file, view.text).text(false);
      const re = lang === "vhdl" ? /\b(\w+)\.(\w+)\s*<=\s*([^;]+);/gi : /\bassign\s+(\w+)\.(\w+)\s*=\s*([^;]+);/g;
      for (const m of text.matchAll(re)) {
        const name = normal(m[1]), field = normal(m[2]), object = objects.get(name);
        if (!object?.record?.fields.some(f => normal(f.name) === field)) continue;
        const start = view.sourceMap[m.index!] ?? view.start + m.index!, end = view.sourceMap[m.index! + m[0].length] ?? start + m[0].length;
        if (mod.processes.some(p => p.file === view.file && start >= p.start && start < p.end)) continue;
        if (drivers.get(name)?.some(d => d.targetText === `${m[1]}.${m[2]}` && d.source.start >= start && d.source.start < end)) continue;
        const rhs = m.index! + m[0].lastIndexOf(m[3]);
        const expression = mapExpression(parseExpression(m[3], lang, view.start + rhs, vectors), view.start + rhs, view.sourceMap.slice(rhs, rhs + m[3].length + 1));
        add(name, { expression, relation: true, targetText: `${m[1]}.${m[2]}`, operator: lang === "vhdl" ? "<=" : "=", reason: "record 字段写入，保留源码关系；完整对象更新值未求解", source: { file: view.file, start, end } });
      }
    }
    for (const [idx, p] of mod.processes.entries()) {
      const raw = this.files.get(p.file)!;
      const result = analyzeProcess(p.text ?? raw.slice(p.start, p.end), lang, p.start, vectors);
      if (p.sourceMap) {
        for (const [name, expression] of result.updates) result.updates.set(name, mapExpression(expression, p.start, p.sourceMap));
        for (const [name, site] of result.sites) result.sites.set(name, { start: p.sourceMap[site.start - p.start] ?? site.start, end: p.sourceMap[site.end - p.start] ?? site.end });
        for (const a of result.assignments ?? []) {
          a.expression = mapExpression(a.expression, p.start, p.sourceMap);
          a.selectors = a.selectors.map(e => mapExpression(e, p.start, p.sourceMap));
          a.conditions = a.conditions.map(e => mapExpression(e, p.start, p.sourceMap));
          a.start = p.sourceMap[a.start - p.start] ?? a.start; a.end = p.sourceMap[a.end - p.start] ?? a.end;
        }
        for (const boundary of result.boundaries ?? []) {
          boundary.start = p.sourceMap[boundary.start - p.start] ?? boundary.start;
          boundary.end = p.sourceMap[boundary.end - p.start] ?? boundary.end;
        }
      }
      for (const [name, expression] of result.updates) add(name, { expression, operator: result.operators.get(name), process: result, source: { file: p.file, ...(result.sites.get(name) ?? { start: p.start, end: p.end }) } });
      for (const a of result.assignments ?? []) if (!result.locals.includes(a.target) && !result.updates.has(a.target)) add(a.target, { expression: a.expression, process: result, operator: a.operator, relation: true, targetText: a.targetText, selectors: a.selectors, conditions: a.conditions, reason: a.reason, contexts: a.contexts, source: { file: p.file, start: a.start, end: a.end } });
      if (result.issues.length && !result.assignments?.length) {
        const names = new Set(mod.assignments.filter(a => a.proc === idx).map(a => a.target));
        // 部分写入也要留下目标边界，不能显示为没有驱动。
        const body = sourceEntry(p.file, raw).text(false).slice(p.start, p.end);
        const writes = lang === "vhdl"
          ? /(?:\bbegin\b|\bthen\b|\belse\b|;|=>)\s*(\w+)\s*(?:\([^;]*?\))?\s*(?:<=|:=)/gi
          : /(?:\bbegin\b|\belse\b|;|\))\s*(\w+)\s*(?:\[[^\]]*\])?\s*(?:<=|=(?!=))/g;
        for (const m of body.matchAll(writes)) names.add(normal(m[1]));
        for (const name of names) if (!result.locals.includes(name) && !result.updates.has(name)) add(name, {
          expression: { kind: "unknown", value: result.issues.join("；"), text: result.issues.join("；"), args: [], start: p.start, end: p.end },
          source: { file: p.file, start: p.start, end: p.end }, process: result,
        });
      }
    }
    const out = { mod, drivers, widths, vectors, lang, objects }; this.cache.set(key, out); return out;
  }
  signals(path: string): string[] {
    const ctx = this.context(path), a = ctx && this.analyze(ctx);
    return a ? [...new Set([...a.widths.keys(), ...a.drivers.keys(), ...a.mod.ports.map(p => a.lang === "vhdl" ? p.name.toLowerCase() : p.name)])] : [];
  }
  loads(path: string, signal: string): Load[] {
    const ctx = this.context(path), a = ctx && this.analyze(ctx); if (!ctx || !a) return [];
    const norm = (s: string) => a.lang === "vhdl" ? s.toLowerCase() : s;
    const found: Load[] = [];
    for (const [name, ds] of a.drivers) {
      const match = ds.find(d => refs(d.expression).includes(norm(signal)) || d.process?.issues.length &&
        new RegExp(`\\b${signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, a.lang === "vhdl" ? "i" : "").test(this.files.get(d.source.file)!.slice(d.source.start, d.source.end)));
      if (match && name !== norm(signal)) found.push({ path, signal: name, label: `${name} ${match.process?.issues.length ? "所在过程（分析边界）" : "的运算／更新"}`, source: match.source });
    }
    for (const inst of a.mod.instances) {
      const child = this.connections.child(ctx, inst), childMod = this.connections.module(inst.module);
      for (const [i, c] of (inst.connections ?? []).entries()) {
        const port = c.port ? childMod?.ports.find(p => p.name.toLowerCase() === c.port!.toLowerCase()) : childMod?.ports[i];
        if (norm(c.expr.trim()) === norm(signal) && /^(in|input|inout)$/.test(port?.direction ?? "")) {
          const entry = sourceEntry(inst.file, this.files.get(inst.file)!);
          found.push({ path: child.path, signal: port!.name, label: `${inst.inst}.${port!.name}`, source: { file: inst.file, start: entry.lineOffset(c.line), end: entry.lineOffset(c.line + 1) } });
        }
      }
    }
    return found;
  }
  trace(path: string, signal: string, depth = 2): ComputationGraph {
    const nodes: ComputationNode[] = [], edges: ComputationEdge[] = [];
    const node = (data: Omit<ComputationNode, "id">) => { const id = `n${nodes.length}`; nodes.push({ id, ...data }); return id; };
    const edge = (from: string, to: string, role = "数据") => { edges.push({ from, to, role }); };
    const seen = new Map<string, string>();
    const budget = 180;
    const expression = (e: Expr, ctx: SignalContext, target: string, d: Driver, remaining: number, stack: Set<string>, control = false): string => {
      if (nodes.length >= budget) return node({ kind: "boundary", label: "展开上限", detail: "请聚焦其中一个信号继续查看", path: ctx.path });
      if (e.kind === "ref") {
        if (control) return node({ kind: "control", label: e.value, detail: "控制条件：可聚焦查看其来源", path: ctx.path, signal: e.value, source: { file: d.source.file, start: e.start, end: e.end } });
        if (e.current) return node({ kind: "current", label: `${e.value}（当前值）`, detail: d.process?.mode === "clocked" ? (e.value === target ? "保持：本次触发不更新" : "读取本次时钟触发前的值") : "未覆盖路径保留原值，存在存储依赖", path: ctx.path, signal: e.value, source: d.source });
        return visit(ctx, e.value, remaining - 1, stack);
      }
      const unknown = e.kind === "unknown" || e.kind === "call" && !e.conversion;
      const label = e.kind === "literal" ? (/^(?:\d*'[bB])?[zZ]$/.test(e.value) || /^'[zZ]'$/.test(e.value) ? `${e.value} · 释放驱动` : e.value)
        : unknown ? e.text : e.conversion ? e.conversion.name : e.kind === "cast" ? `写入 ${e.value}` : e.kind === "select" ? "条件选择" : e.kind === "op" ? `${e.value} 运算` : e.kind === "slice" ? e.access?.kind === "field" ? "字段访问" : "位选／切片／数组访问" : "拼接";
      const id = node({ kind: unknown ? "boundary" : e.kind === "literal" ? "constant" : "operation", label,
        detail: unknown ? (e.kind === "call" ? "未知调用：参数是源码关系，内部语义未展开" : e.value) : e.conversion?.description ?? (e.kind === "cast" ? `${formatExpr(e)}；按目标类型／位宽转换，未计算转换后的值` : formatExpr(e)), path: ctx.path,
        source: { file: d.source.file, start: e.start, end: e.end }, expression: e, expressionTarget: target });
      e.args.forEach((arg, index) => edge(expression(arg, ctx, target, d, remaining, stack, control || e.kind === "select" && index === 0), id, e.kind === "select" ? ["条件", "成立", "不成立"][index] : e.roles?.[index] ?? (e.kind === "call" && !e.conversion ? "调用参数（内部语义未知）" : `输入 ${index + 1}`)));
      return id;
    };
    const visit = (ctx: SignalContext, name: string, remaining: number, stack: Set<string>): string => {
      const a = this.analyze(ctx); if (a?.lang === "vhdl") name = name.toLowerCase();
      const key = `${ctx.path}.${name}`;
      if (stack.has(key)) return node({ kind: "boundary", label: `${name} · 反馈`, detail: "组合依赖回到已访问信号，停止展开", path: ctx.path, signal: name });
      if (seen.has(key)) return seen.get(key)!;
      const ds = a?.drivers.get(name) ?? [], port = a?.mod.ports.find(p => a.lang === "vhdl" ? p.name.toLowerCase() === name : p.name === name);
      const inout = port?.direction === "inout";
      let childDriverCount = 0;
      for (const inst of a?.mod.instances ?? []) {
        const child = this.connections.module(inst.module);
        for (const [i, c] of (inst.connections ?? []).entries()) {
          const cp = c.port ? child?.ports.find(p => p.name.toLowerCase() === c.port!.toLowerCase()) : child?.ports[i];
          if ((a?.lang === "vhdl" ? c.expr.toLowerCase() : c.expr).trim() === name && /^(output|out|buffer|inout)$/.test(cp?.direction ?? "")) childDriverCount++;
        }
      }
      const resolved = inout || driverCount(ds) + childDriverCount > 1, object = a?.objects.get(name), primary = ds.find(d => !d.initialization) ?? ds[0];
      const id = node({ kind: resolved ? "resolved" : primary?.process?.clock ? "register" : object?.kind === "constant" || object?.kind === "parameter" ? "constant" : port?.direction === "input" || port?.direction === "in" ? "input" : "signal", label: name,
        detail: [a?.widths.get(name) ?? "类型／位宽待确定", object?.initializer ? `声明初值：${object.initializer}；未模拟初始化或后续更新` : "", resolved ? "多来源解析，不能按优先级选择" : ds[0]?.process?.clock ? `时钟：${ds[0].process.clock}${ds[0].process.sensitivity ? `；敏感表：${ds[0].process.sensitivity.join("，")}` : ds[0].process.events.length > 1 ? `；敏感事件：${ds[0].process.events.join("，")}` : ""}` : ""].filter(Boolean).join(" · "),
        path: ctx.path, signal: name, source: ds[0]?.source ?? object?.source, expressions: ds.map(d => d.expression) });
      seen.set(key, id);
      if (!a || a.mod.problem) { nodes.find(n => n.id === id)!.detail = a?.mod.problem ?? "黑盒／缺失定义"; nodes.find(n => n.id === id)!.kind = "boundary"; return id; }
      if (remaining < 0 || nodes.length >= budget) { nodes.find(n => n.id === id)!.detail += " · 可继续聚焦展开"; return id; }
      const next = new Set(stack).add(key);
      for (const d of ds) {
        edge(expression(d.expression, ctx, name, d, remaining, next), id, d.relation ? "源码读写关系" : d.process?.mode === "clocked" ? "下一次更新值" : "赋值");
        for (const e of d.selectors ?? []) edge(expression(e, ctx, name, d, remaining, next), id, "地址");
        for (const e of d.conditions ?? []) edge(expression(e, ctx, name, d, remaining, next, true), id, "条件");
      }
      if (inout && !ctx.parent) edge(node({ kind: "external", label: "外部器件／上拉", detail: "顶层双向端口外部来源，实际总线值取决于全部驱动及解析", path: ctx.path, signal: name }), id, "外部驱动");
      if (ctx.parent && /^(input|in|inout)$/.test(port?.direction ?? "")) {
        const parent = this.analyze(ctx.parent), index = a.mod.ports.indexOf(port!);
        const conn = ctx.instance?.connections?.find((c, i) => c.port ? c.port.toLowerCase() === port!.name.toLowerCase() : i === index);
        if (conn?.expr && parent) {
          const file = parent.mod.instances.find(inst => inst.inst === ctx.instance!.inst)?.file ?? parent.mod.file;
          const at = sourceEntry(file, this.files.get(file)!).lineOffset(conn.line);
          const e = parseExpression(conn.expr, parent.lang, at, parent.vectors);
          edge(expression(e, ctx.parent, name, { expression: e, source: { file, start: at, end: at + conn.expr.length } }, remaining, next), id, "端口绑定");
        }
      }
      for (const inst of a.mod.instances) {
        const childMod = this.connections.module(inst.module);
        for (const [i, c] of (inst.connections ?? []).entries()) {
          if ((a.lang === "vhdl" ? c.expr.toLowerCase() : c.expr).trim() !== name) continue;
          const cp = c.port ? childMod?.ports.find(p => p.name.toLowerCase() === c.port!.toLowerCase()) : childMod?.ports[i];
          if (/^(output|out|buffer|inout)$/.test(cp?.direction ?? "")) edge(visit(this.connections.child(ctx, inst), cp!.name, remaining - 1, next), id, "子模块驱动");
          else if (!cp) edge(node({ kind: "boundary", label: `${inst.inst}.${c.port ?? i}`, detail: "黑盒端口，方向待确定", path: ctx.path }), id, "方向待确定");
        }
      }
      return id;
    };
    const ctx = this.context(path);
    const root = ctx ? visit(ctx, signal, Math.min(12, Math.max(0, depth)), new Set()) : node({ kind: "boundary", label: path, detail: "实例路径不存在", path });
    return { root, nodes, edges };
  }
}
