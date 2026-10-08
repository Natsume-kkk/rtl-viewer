import { detectLang, parseFileDetail, scanStructure, type InstanceInfo, type ModuleInfo } from "../parser";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";

interface Assignment { target: string; expression: string; direct: boolean; line: number; file: string }
interface Boundary { text: string; line: number; file: string; reason: string }
export interface SignalModule extends ModuleInfo {
  instances: (InstanceInfo & { file: string })[];
  assignments: Assignment[];
  boundaries: Boundary[];
  problem?: string;
}
export interface SignalContext { module: string; path: string; parent?: SignalContext; instance?: InstanceInfo }
export interface TraceNode { label: string; file?: string; line?: number; reason?: string; children: TraceNode[] }
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

function processRanges(body: string, vhdl: boolean): { index: number; text: string }[] {
  const result: { index: number; text: string }[] = [];
  const starts = vhdl ? /\b(process|function|procedure)\b/gi : /\b(always(?:_ff|_comb|_latch)?|initial|function|task)\b/g;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(body))) {
    if (/\bend\s*$/i.test(body.slice(Math.max(0, match.index - 12), match.index))) continue;
    let end = body.length;
    if (vhdl || /^(function|task)$/.test(match[1])) {
      const closing = new RegExp(vhdl ? `\\bend\\s+${match[1]}\\b[^;]*;` : `\\bend${match[1]}\\b`, "i").exec(body.slice(starts.lastIndex));
      if (closing) end = starts.lastIndex + closing.index + closing[0].length;
    } else {
      const semi = body.indexOf(";", starts.lastIndex);
      const begin = /\bbegin\b/.exec(body.slice(starts.lastIndex));
      if (begin && (semi < 0 || starts.lastIndex + begin.index < semi)) {
        const tokens = /\b(begin|end)\b/g; tokens.lastIndex = starts.lastIndex + begin.index;
        let depth = 0, token: RegExpExecArray | null;
        while ((token = tokens.exec(body))) {
          depth += token[1] === "begin" ? 1 : -1;
          if (depth === 0) { end = tokens.lastIndex; break; }
        }
      } else if (semi >= 0) end = semi + 1;
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
    const result: SignalModule = { ...definition, instances: parts.flatMap(p => p.instances.map(inst => ({ ...inst, file: p.file }))), assignments: [], boundaries: [] };
    let architectureCount = 0;
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
        for (const p of procedural) result.boundaries.push({ text: p.text, file, line: lineAt(source, start + p.index), reason: "过程逻辑（不继续推导）" });
        const assignments = vhdl
          ? /\b([A-Za-z_]\w*(?:\s*\([^;]*?\))?)\s*<=\s*([^;]+);/g
          : /\bassign\s+([A-Za-z_]\w*(?:\s*\[[^\]]*\])?)\s*=\s*([^;]+);/g;
        for (const a of body.matchAll(assignments)) {
          if (procedural.some(p => a.index! >= p.index && a.index! < p.index + p.text.length)) continue;
          result.assignments.push({ target: a[1].trim(), expression: a[2].trim(), direct: identifier.test(a[1].trim()) && identifier.test(a[2].trim()), file, line: lineAt(source, start + a.index!) });
        }
      }
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
    const stop = (label: string, reason: string, file = mod.file, line = mod.line) => {
      if (count >= limit) {
        if (!node.children.some(n => n.reason?.includes("分析预算"))) node.children.push({ label: "未展开分支", reason: "达到分析预算，结果未完全展开", children: [] });
        return;
      }
      count++;
      node.children.push({ label, reason, file, line, children: [] });
    };
    const follow = async (next: SignalContext, nextName: string) => {
      if (count >= limit) { if (!node.children.some(n => n.reason?.includes("分析预算"))) stop("未展开分支", "达到分析预算，结果未完全展开"); return; }
      node.children.push(await visit(next, nextName, nextSeen, depth + 1));
    };
    for (const a of mod.assignments) {
      const relevant = direction === "upstream" ? mentions(a.target, name, a.file) : mentions(a.expression, name, a.file);
      if (!relevant) continue;
      if (a.direct) await follow(ctx, direction === "upstream" ? a.expression : a.target);
      else stop(`${a.target} ← ${a.expression}`, "运算或范围转换（不继续推导）", a.file, a.line);
    }
    for (const b of mod.boundaries) if (processAccess(b.text, name, b.file, direction)) {
      stop(`${name} · ${b.file.split(/[\\/]/).pop()}:${b.line}`, b.reason, b.file, b.line);
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
        else await follow(project.child(ctx, inst), port.name);
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
        else await follow(ctx.parent, connection.expr);
      }
    }
    if (!node.children.length) node.reason = "未发现可继续追踪的连线（不代表未使用）";
    return node;
  }
  return visit(context, signal, new Set(), 0);
}
