import { detectLang, type HdlLang } from "../parser";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import { SignalProject, type SignalContext, type SignalModule } from "../model/signal-flow";
import { formatExpr, parseExpression, refs, type Expr } from "./expression";
import { analyzeProcess, type ProcessResult } from "./process";

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
export interface Driver { expression: Expr; source: SourceSpan; process?: ProcessResult; operator?: string }
export interface ModuleAnalysis { mod: SignalModule; drivers: Map<string, Driver[]>; widths: Map<string, string>; vectors: Set<string>; lang: HdlLang }
export interface Load { path: string; signal: string; label: string; source?: SourceSpan }
const lineOffset = (text: string, line: number) => text.split("\n").slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0);

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
    for (const name of names) {
      if (!ctx) return;
      const inst = this.connections.module(ctx.module)?.instances.find(inst => inst.inst === name);
      if (!inst) return;
      ctx = this.connections.child(ctx, inst);
    }
    return ctx;
  }
  private analyze(ctx: SignalContext): ModuleAnalysis | undefined {
    const mod = this.connections.module(ctx.module);
    if (!mod) return;
    const key = `${mod.file}:${mod.name}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const lang = detectLang(mod.file)!, drivers = new Map<string, Driver[]>(), widths = new Map<string, string>(), vectors = new Set<string>();
    if (mod.problem) { const out={mod,drivers,widths,vectors,lang}; this.cache.set(key,out); return out; }
    const normal = (s: string) => lang === "vhdl" ? s.toLowerCase() : s;
    const add = (name: string, d: Driver) => { name = normal(name); const list = drivers.get(name) ?? []; list.push(d); drivers.set(name, list); };
    for (const port of mod.ports) { widths.set(normal(port.name), port.width || "标量"); if (port.width) vectors.add(normal(port.name)); }
    // 仅取该模块的声明；过程局部声明不混入模块对象。
    const moduleFiles = new Set([mod.file, ...mod.processes.map(p => p.file), ...mod.assignments.map(a => a.file), ...mod.instances.map(i => i.file)]);
    for (const file of moduleFiles) {
      const raw = this.files.get(file); if (raw === undefined) continue;
      if (detectLang(file) !== lang) continue;
      const clean = lang === "vhdl" ? stripVhdlComments(raw, false) : stripComments(raw, false);
      const scopes = [...clean.matchAll(lang === "vhdl" ? /\barchitecture\s+\w+\s+of\s+(\w+)\s+is/gi : /\bmodule\s+(\w+)/g)];
      for (let s = 0; s < scopes.length; s++) {
        if (normal(scopes[s][1]) !== normal(mod.name)) continue;
        const start = scopes[s].index!, end = scopes[s + 1]?.index ?? clean.length;
        if (!mod.regions.some(r=>r.file===file&&r.start===start)) continue;
        const body = clean.slice(start, end);
        const declarations = lang === "vhdl" ? /\bsignal\s+([\w\s,]+)\s*:\s*([^;]+);/gi : /\b(wire|reg|logic)\s+(signed\s+|unsigned\s+)?(\[[^\]]+\]\s*)?([^;]+);/g;
        for (const m of body.matchAll(declarations)) {
          const at = start + m.index!;
          if (mod.processes.some(p => p.file === file && at >= p.start && at < p.end)) continue;
          if (lang === "vhdl") {
            for (const name of m[1].split(",").map(s => s.trim().toLowerCase())) {
              widths.set(name, m[2].trim()); if (/\b(?:unsigned|signed|std_logic_vector|bit_vector)\s*\(/i.test(m[2])) vectors.add(name);
            }
          } else {
            for (const entry of m[4].split(/,(?![^{}]*\})/)) {
              const name = /^\s*(\w+)/.exec(entry)?.[1]; if (!name) continue;
              widths.set(name, `${m[2] ?? ""}${m[3] ?? "标量"}`.trim()); if (m[3]) vectors.add(name);
            }

          }
        }
      }
    }
    for (const a of mod.assignments.filter(a => a.proc === -1)) {
      const raw = this.files.get(a.file)!;
      const start = lineOffset(raw, a.line);
      const at = raw.indexOf(a.expression, start);
      const name = /^(\w+)/.exec(a.target)?.[1] ?? a.target;
      const expression = /^\w+$/.test(a.target) ? parseExpression(a.expression, lang, at >= 0 ? at : start, vectors)
        : { kind: "unknown" as const, value: "部分目标写入", args: [], text: `${a.target} <= ${a.expression}`, start, end: start + a.target.length };
      add(name, { expression, operator: lang === "vhdl" ? "<=" : "=", source: { file: a.file, start: at >= 0 ? at : start, end: at >= 0 ? at + a.expression.length : start + 1 } });
    }
    for (const [idx, p] of mod.processes.entries()) {
      const raw = this.files.get(p.file)!;
      const result = analyzeProcess(raw.slice(p.start, p.end), lang, p.start, vectors);
      for (const [name, expression] of result.updates) add(name, { expression, operator: result.operators.get(name), process: result, source: { file: p.file, ...(result.sites.get(name) ?? { start: p.start, end: p.end }) } });
      if (result.issues.length) {
        const names = new Set(mod.assignments.filter(a => a.proc === idx).map(a => a.target));
        // 部分写入也要留下目标边界，不能显示为没有驱动。
        const body = (lang === "vhdl" ? stripVhdlComments : stripComments)(raw.slice(p.start, p.end), false);
        const writes = lang === "vhdl"
          ? /(?:\bbegin\b|\bthen\b|\belse\b|;|=>)\s*(\w+)\s*(?:\([^;]*?\))?\s*(?:<=|:=)/gi
          : /(?:\bbegin\b|\belse\b|;|\))\s*(\w+)\s*(?:\[[^\]]*\])?\s*(?:<=|=(?!=))/g;
        for (const m of body.matchAll(writes)) names.add(normal(m[1]));
        for (const name of names) if (!result.locals.includes(name)) add(name, {
          expression: { kind: "unknown", value: result.issues.join("；"), text: result.issues.join("；"), args: [], start: p.start, end: p.end },
          source: { file: p.file, start: p.start, end: p.end }, process: result,
        });
      }
    }
    const out = { mod, drivers, widths, vectors, lang }; this.cache.set(key, out); return out;
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
        if (norm(c.expr.trim()) === norm(signal) && /^(in|input|inout)$/.test(port?.direction ?? "")) found.push({ path: child.path, signal: port!.name, label: `${inst.inst}.${port!.name}`, source: { file: inst.file, start: lineOffset(this.files.get(inst.file)!, c.line), end: lineOffset(this.files.get(inst.file)!, c.line + 1) } });
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
      const unknown = e.kind === "unknown" || e.kind === "call";
      const label = e.kind === "literal" ? (/^(?:\d*'[bB])?[zZ]$/.test(e.value) || /^'[zZ]'$/.test(e.value) ? `${e.value} · 释放驱动` : e.value)
        : unknown ? e.text : e.kind === "cast" ? `写入 ${e.value}` : e.kind === "select" ? "条件选择" : e.kind === "op" ? `${e.value} 运算` : e.kind === "slice" ? "位选／切片" : "拼接";
      const id = node({ kind: unknown ? "boundary" : e.kind === "literal" ? "constant" : "operation", label,
        detail: unknown ? (e.kind === "call" ? "函数或转换调用：保留原文，内部语义未展开" : e.value) : e.kind === "cast" ? `${formatExpr(e)}；按目标类型／位宽转换，未计算转换后的值` : formatExpr(e), path: ctx.path,
        source: { file: d.source.file, start: e.start, end: e.end }, expression: e, expressionTarget: target });
      if (!unknown) e.args.forEach((arg, index) => edge(expression(arg, ctx, target, d, remaining, stack, control || e.kind === "select" && index === 0), id, e.kind === "select" ? ["条件", "成立", "不成立"][index] : e.kind === "slice" && index > 0 ? "位界" : `输入 ${index + 1}`));
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
      const resolved = inout || ds.length + childDriverCount > 1;
      const id = node({ kind: resolved ? "resolved" : ds[0]?.process?.mode === "clocked" ? "register" : port?.direction === "input" || port?.direction === "in" ? "input" : "signal", label: name,
        detail: [a?.widths.get(name) ?? "类型／位宽待确定", resolved ? "多来源解析，不能按优先级选择" : ds[0]?.process?.clock ? `时钟：${ds[0].process.clock}${ds[0].process.sensitivity ? `；敏感表：${ds[0].process.sensitivity.join("，")}` : ds[0].process.events.length > 1 ? `；敏感事件：${ds[0].process.events.join("，")}` : ""}` : ""].filter(Boolean).join(" · "),
        path: ctx.path, signal: name, source: ds[0]?.source, expressions: ds.map(d => d.expression) });
      seen.set(key, id);
      if (!a || a.mod.problem) { nodes.find(n => n.id === id)!.detail = a?.mod.problem ?? "黑盒／缺失定义"; nodes.find(n => n.id === id)!.kind = "boundary"; return id; }
      if (remaining < 0 || nodes.length >= budget) { nodes.find(n => n.id === id)!.detail += " · 可继续聚焦展开"; return id; }
      const next = new Set(stack).add(key);
      for (const d of ds) edge(expression(d.expression, ctx, name, d, remaining, next), id, d.process?.mode === "clocked" ? "下一次更新值" : "赋值");
      if (inout && !ctx.parent) edge(node({ kind: "external", label: "外部器件／上拉", detail: "顶层双向端口外部来源，实际总线值取决于全部驱动及解析", path: ctx.path, signal: name }), id, "外部驱动");
      if (ctx.parent && /^(input|in|inout)$/.test(port?.direction ?? "")) {
        const parent = this.analyze(ctx.parent), index = a.mod.ports.indexOf(port!);
        const conn = ctx.instance?.connections?.find((c, i) => c.port ? c.port.toLowerCase() === port!.name.toLowerCase() : i === index);
        if (conn?.expr && parent) {
          const file = parent.mod.instances.find(inst => inst.inst === ctx.instance!.inst)?.file ?? parent.mod.file;
          const at = lineOffset(this.files.get(file)!, conn.line);
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
