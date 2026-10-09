import type { Expr } from "../../src/analysis/expression";
import type { ComputationGraph, ComputationNode } from "../../src/analysis/project";

export interface BranchOption { guard: string; value: string; context: string }
export interface Branch { key: string; options: BranchOption[]; selected?: number }
export interface ReadingStep { node: ComputationNode; code: string; branches: Branch[]; pending: boolean; dependencies: string[]; hold?: boolean; contextOnly?: boolean; contextDependencies?: string[] }

/** Keep the already-read prefix when choosing a branch; only replace its continuation.
 * Retained context is not a data dependency of a reset/hold/constant branch. */
export function keepReadingPrefix(previous: ReadingStep[], next: ReadingStep[], branchKey: string): ReadingStep[] {
  const at = previous.findIndex(s => s.branches.some(b => b.key === branchKey));
  if (at < 0) return next;
  const identity = (s: ReadingStep) => `${s.node.path}:${s.node.signal ?? s.node.label}:${s.node.kind}`;
  const fresh = new Map(next.map(s => [identity(s), s]));
  const prefix = previous.slice(0, at).map(old => fresh.get(identity(old)) ?? { ...old, contextOnly: true });
  const kept = new Set(prefix.map(identity));
  const suffix = next.filter(s => !kept.has(identity(s)));
  const result = [...prefix, ...suffix];
  const oldByKey = new Map(previous.map(s => [identity(s), s]));
  const visibleIds = new Set(result.map(s => s.node.id));
  return result.map(step => {
    const old = oldByKey.get(identity(step));
    const oldLinks = [...(old?.dependencies ?? []), ...(old?.contextDependencies ?? [])];
    return { ...step, contextDependencies: [...new Set(oldLinks.filter(id => visibleIds.has(id) && !step.dependencies.includes(id)))] };
  });
}

/** Display expressions in their HDL dialect; choices are exploration, never value evaluation. */
export function codeExpr(e: Expr, vhdl = false): string {
  const args = e.args.map(a => codeExpr(a, vhdl));
  if (e.kind === "select") return vhdl ? `(${args[1]} when ${args[0]} else ${args[2]})` : `(${args[0]} ? ${args[1]} : ${args[2]})`;
  if (e.kind === "op") return args.length === 1 ? `${e.value}${vhdl ? " " : ""}${["ref", "literal"].includes(e.args[0].kind) ? args[0] : `(${args[0]})`}` : `(${args.join(` ${e.value} `)})`;
  if (e.kind === "concat") return `{${args.join(", ")}}`;
  if (e.kind === "slice") return vhdl ? `${args[0]}(${args.slice(1).join(/\bto\b/i.test(e.text) ? " to " : " downto ")})` : `${args[0]}[${args.slice(1).join(":")}]`;
  if (e.kind === "cast") return `write<${e.value}>(${args[0]})`;
  return e.current ? e.value : e.text || e.value;
}

/** Changing an earlier selection drops later assumptions, including nested selections. */
export function selectBranch(choices: Map<string, number>, key: string, index: number): void {
  let drop = false;
  for (const existing of choices.keys()) {
    if (existing === key) drop = true;
    if (drop) choices.delete(existing);
  }
  choices.set(key, index);
}

export function readingSteps(g: ComputationGraph, choices: ReadonlyMap<string, number> = new Map()): ReadingStep[] {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const selectedEdges = new Map<string, Map<Expr, number>>();
  const selectedEdge = (n: ComputationNode) => n.expression && selectedEdges.get(`${n.path}/${n.expressionTarget}`)?.get(n.expression);
  const stepById = new Map<string, ReadingStep>();
  for (const node of g.nodes.filter(n => n.expressions?.length)) {
    if (node.detail.includes("可继续聚焦展开")) {
      stepById.set(node.id, { node, code: node.label, branches: [], pending: false, dependencies: [] });
      continue;
    }
    const vhdl = /\.vhdl?$/i.test(node.source?.file ?? "");
    const edges = new Map<Expr, number>();
    selectedEdges.set(`${node.path}/${node.signal}`, edges);
    const branches: Branch[] = [];
    function resolve(e: Expr, trail: string): Expr {
      if (e.kind !== "select") {
        if (["unknown", "call"].includes(e.kind)) return e;
        return { ...e, args: e.args.map((a, i) => resolve(a, `${trail}.${i}`)) };
      }
      const key = `${node.path}/${node.signal}:${node.source?.file}:${trail}`;
      const chain: Expr[] = [], values: Expr[] = [];
      let cursor = e;
      while (cursor.kind === "select" && cursor.procedural === e.procedural) {
        chain.push(cursor); values.push(cursor.args[1]); cursor = cursor.args[2];
      }
      values.push(cursor);
      const guards = chain.map((s, i) => {
        const condition = codeExpr(s.args[0], vhdl).replace(/^\((.*)\)$/, "$1");
        if (!e.procedural) return vhdl ? `when ${condition}` : `${i ? ": " : ""}(${condition}) ?`;
        return vhdl ? `${i ? "elsif" : "if"} ${condition} then` : `${i ? "else if" : "if"} (${condition})`;
      });
      guards.push(e.procedural || vhdl ? "else" : ":");
      const options = values.map((value, i) => ({
        guard: guards[i], value: value.kind === "select" ? "…" : codeExpr(value, vhdl) + (value.current && value.value === node.signal ? (vhdl ? "  -- hold" : "  // hold") : ""),
        context: [...guards.slice(0, i).map(s => `${s} …`), guards[i]].join(e.procedural ? "\n" : " "),
      }));
      const proposed = choices.get(key), selected = proposed !== undefined && proposed >= 0 && proposed < options.length ? proposed : undefined;
      branches.push({ key, options, selected });
      if (selected === undefined) return e;
      chain.slice(0, Math.min(selected + 1, chain.length)).forEach((s, i) => edges.set(s, i === selected ? 1 : 2));
      return resolve(values[selected], `${trail}.branch${selected}`);
    }
    const values = node.expressions!.map((e, i) => resolve(e, String(i)));
    const assignment = node.kind === "register" || vhdl ? "<=" : "=";
    const code = values.map(e => `${node.label} ${assignment} ${codeExpr(e, vhdl)};`).join("\n");
    stepById.set(node.id, { node, code, branches, pending: branches.some(b => b.selected === undefined), dependencies: [], hold: values.length === 1 && values[0].current && values[0].value === node.signal });
  }
  const visited = new Set<string>(), ordered: ReadingStep[] = [];
  function visit(id: string) {
    if (visited.has(id)) return; visited.add(id);
    const node = byId.get(id)!;
    if (["current", "control"].includes(node.kind)) return;
    const selected = selectedEdge(node);
    const incoming = g.edges.filter(edge => edge.to === id && edge.role !== "条件" && edge.role !== "位界" &&
      (selected === undefined || edge.role === (selected === 1 ? "成立" : "不成立")));
    incoming.forEach(edge => visit(edge.from));
    const step = stepById.get(id);
    if (step) ordered.push(step);
    else if (["resolved", "boundary", "external"].includes(node.kind) || id === g.root || node.signal && incoming.length) {
      const sources = incoming.map(edge => byId.get(edge.from)!.label);
      ordered.push({ node, code: sources.length ? `${node.label} ← ${sources.join(", ")}` : node.label, branches: [], pending: false, dependencies: [] });
    }
  }
  visit(g.root);
  const visible = new Set(ordered.map(s => s.node.id));
  for (const step of ordered) {
    const seen = new Set<string>();
    function collect(id: string) {
      if (seen.has(id)) return; seen.add(id);
      if (visible.has(id) && id !== step.node.id) { step.dependencies.push(id); return; }
      const n = byId.get(id)!, selected = selectedEdge(n);
      for (const edge of g.edges.filter(edge => edge.to === id && edge.role !== "条件" && edge.role !== "位界" &&
        (selected === undefined || edge.role === (selected === 1 ? "成立" : "不成立")))) collect(edge.from);
    }
    collect(step.node.id);
  }
  const stop = ordered.findIndex(step => step.pending);
  return stop < 0 ? ordered : ordered.slice(0, stop + 1);
}
