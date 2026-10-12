import type { TraceNode } from "../model/signal-flow";
import { CARD_STEP, CANVAS_PAD, element as el, cardHeader, appendSource, signalCode, makeWires, drawWires, type CardEdge, type CardPosition } from "./signal-canvas";

type Side = "up" | "down";
interface PortCard { id: string; trace: TraceNode; column: number; children: string[]; card: HTMLElement; external?: boolean }
export interface PortViewState { expanded: string[]; assignments?: string[] }

/** Display the existing bounded trace as cards; this view never infers RTL connectivity. */
export class SignalPortsView {
  private canvas = el("div", "logic-canvas port-canvas");
  private svg = makeWires();
  private nodes = new Map<string, PortCard>();
  private edges: CardEdge[] = [];
  private expanded = new Set<string>();
  private branches = new Map<string, HTMLButtonElement>();
  private roots: Record<Side, string[]> = {up: [], down: []};
  private externalDirections = new Map<string, Set<Side>>();
  constructor(signal: string, upstream: TraceNode, downstream: TraceNode, body: HTMLElement) {
    body.classList.add("logic-body"); body.append(this.canvas); this.canvas.append(this.svg);
    const add = (id: string, trace: TraceNode, column: number, label: string, external = false): PortCard => {
      const old = this.nodes.get(id); if (old) return old;
      const card = el("article", `logic-card port-card${id === "focus" ? " selected" : ""}`); card.dataset.node = id; card.dataset.signal = label;
      const location = trace.file ? {file: trace.file, line: trace.line ?? 1} : undefined;
      const assignment = !trace.mapping && (!!trace.statement || trace.reason === "赋值位置");
      const subject = trace.port ?? trace.signal;
      const instance = subject && id !== "focus" ? subject.path.startsWith(base + "/") ? subject.path.slice(base.length + 1) : subject.path : undefined;
      const title = assignment && id !== "focus" ? (column < 0 ? "驱动赋值" : "读取赋值") : instance ?? (trace.mapping ? "端口映射" : label);
      cardHeader(card, title, location, [trace.label, trace.tip, trace.note].filter(Boolean).join("\n"));
      if (instance) card.append(el("code", `logic-detail ${trace.port ? "port-pin" : "signal-pin"}`, trace.port ? `${trace.port.direction ?? "方向待确认"} ${trace.port.name}` : `内部信号 ${trace.signal!.name}`));
      if (assignment && (trace.owner || trace.target)) card.append(el("code", "logic-detail assignment-context", trace.owner ?? trace.target!.context.path));
      if (assignment) appendSource(card, {...trace, statement: trace.statement ?? trace.label}, signal, () => this.render());
      if (trace.mapping) { const code = signalCode(trace.mapping, signal, /\.vhdl?$/i.test(trace.file ?? "")); code.classList.add("port-mapping"); card.append(code); }
      if (trace.note) card.append(el("code", "flow-note", trace.note));
      if (trace.reason && trace.reason !== "赋值位置") card.append(el("p", "flow-reason", trace.reason));
      const node = {id, trace, column, children: [], card, external}; this.nodes.set(id, node); this.canvas.append(card); return node;
    };
    const base = upstream.label.slice(0, upstream.label.lastIndexOf("."));
    const focus = add("focus", {...upstream,reason:undefined,note:undefined}, 0, signal);
    focus.card.append(el("code", "logic-detail", [upstream.port?.direction, base].filter(Boolean).join(" · ")));
    const identity = (n: TraceNode) => JSON.stringify([n.owner ?? n.target?.context.path, n.scope, n.port?.path, n.label, n.file, n.line, n.reason, n.note, n.mapping]);
    const walk = (trace: TraceNode, parent: PortCard, side: Side, depth: number): string => {
      const external = /^顶层(?:输入|输出)$/.test(trace.reason ?? "");
      if (external) {
        const directions = this.externalDirections.get(parent.id) ?? new Set<Side>();
        directions.add(side); this.externalDirections.set(parent.id, directions);
        return parent.id;
      }
      const unknown = /黑盒|端口方向未知/.test(trace.reason ?? "");
      const id = `${unknown ? "unknown" : side}:${identity(trace)}`;
      const existed = this.nodes.has(id);
      const name = trace.target?.signal ?? (trace.label.includes(" ← ") ? trace.label.split(" ← ")[0] : trace.label.startsWith(base + ".") || trace.label.startsWith(base + "/") ? trace.label.slice(base.length + 1) : trace.label);
      const node = add(id, trace, unknown ? parent.column : side === "up" ? -depth : depth, name, unknown);
      const edge: CardEdge = side === "up" ? {from: id, to: parent.id} : {from: parent.id, to: id};
      edge.vertical = unknown; edge.unknown = unknown;
      if (unknown) {
        const existing = this.edges.find(e => (e.from === id && e.to === parent.id) || (e.to === id && e.from === parent.id));
        if (!existing) this.edges.push(edge);
      } else if (!this.edges.some(e => e.from === edge.from && e.to === edge.to)) this.edges.push(edge);
      if (!existed && depth < 42) {
        node.children = trace.children.map(child => walk(child, node, side, depth + 1)).filter(child => child !== id);
      }
      return id;
    };
    this.roots.up = upstream.children.map(n => walk(n, focus, "up", 1)).filter(id => id !== "focus");
    this.roots.down = downstream.children.map(n => walk(n, focus, "down", 1)).filter(id => id !== "focus");
    // Some callers already end the root at an interface instead of adding a leaf.
    for (const [side, trace] of [["up", upstream], ["down", downstream]] as const) {
      if (!trace.children.length && trace.reason) {
        if (/^顶层(?:输入|输出)$/.test(trace.reason)) walk(trace, focus, side, 1);
        else if (![...focus.card.querySelectorAll(".flow-reason")].some(n => n.textContent === trace.reason)) focus.card.append(el("p", "flow-reason", trace.reason));
      }
    }
    for (const [id, directions] of this.externalDirections) this.nodes.get(id)!.card.append(el("span", "port-boundary", directions.size === 2 ? "顶层端口 · 与外部双向连接" : directions.has("up") ? "顶层端口 · 外部输入" : "顶层端口 · 输出至外部"));
    for (const node of this.nodes.values()) if (node.children.length) {
      const button = el("button", "text-button path-continue", "继续追踪"); button.type = "button";
      button.setAttribute("aria-label", `继续追踪 ${node.trace.label}`);
      button.onclick = () => { if(this.expanded.has(node.id))this.expanded.delete(node.id);else this.expanded.add(node.id); this.render(); };
      node.card.querySelector<HTMLElement>(".logic-card-head")!.onclick = null;
      node.card.onclick = event => { if (!(event.target as HTMLElement).closest("button, details") && !button.hidden) button.click(); };
      node.card.append(button); this.branches.set(node.id, button);
    }
    this.render();
    const current = focus.card.offsetLeft;
    if (current > body.clientWidth - 260 && body.clientWidth > 0) body.scrollLeft = Math.max(0, current - body.clientWidth / 2 + 118);
  }
  dispose(): void { /* All listeners belong to detached card elements. */ }
  capture(): PortViewState { return {expanded: [...this.expanded], assignments: [...this.nodes.values()].filter(n=>n.card.querySelector<HTMLDetailsElement>(".assignment-block")?.open).map(n=>n.id)}; }
  restore(state: PortViewState): void { this.expanded = new Set(state.expanded); if(state.assignments)for(const node of this.nodes.values()){const block=node.card.querySelector<HTMLDetailsElement>(".assignment-block");if(block)block.open=state.assignments.includes(node.id);} this.render(); }
  expandAll(): void { this.expanded = new Set(this.branches.keys()); for(const block of this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block"))block.open=true; this.render(); }
  collapseAll(): void { this.expanded.clear(); for(const block of this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block"))block.open=false; this.render(); }
  private render(): void {
    const visible = new Set(["focus"]), traversed = new Set<string>(), choices = new Set<string>(), active = new Set<CardEdge>();
    const assignmentEnd = (id: string) => {
      const node = this.nodes.get(id)!;
      return node.trace.reason === "赋值位置" && !node.children.length;
    };
    const visit = (id: string, choice: boolean, parent: string) => {
      this.edges.filter(e=>e.from===parent&&e.to===id||e.from===id&&e.to===parent).forEach(e=>active.add(e));
      visible.add(id); const node = this.nodes.get(id)!;
      const pending = choice && node.children.some(child => !assignmentEnd(child));
      if(pending)choices.add(id);
      if (traversed.has(id)) return;
      // A visible port includes its immediate assignment sites; only further routes need a click.
      if (pending && !this.expanded.has(id)) {
        node.children.filter(assignmentEnd).forEach(child => visit(child, false, id));
        return;
      }
      traversed.add(id);
      node.children.forEach(child => visit(child, node.children.length > 1, id));
    };
    for (const side of ["up", "down"] as const) this.roots[side].forEach(id => visit(id, this.roots[side].length > 1,"focus"));
    for (const [id, button] of this.branches) {
      button.hidden = !choices.has(id);
      const open=this.expanded.has(id);button.textContent=open?"收起此路":"继续追踪";
      button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",`${open?"收起":"继续追踪"} ${this.nodes.get(id)!.trace.label}`);
      this.nodes.get(id)!.card.classList.toggle("route-pending", choices.has(id)&&!open);
    }
    const min = Math.min(0, ...[...this.nodes.values()].map(n => n.column));
    const rows = new Map<number, number>(), positions = new Map<string, CardPosition>();
    // Reserve slots so choosing another route retains the preceding layout.
    for (const node of [...this.nodes.values()].sort((a, b) => Number(!!a.external) - Number(!!b.external))) {
      node.card.hidden = !visible.has(node.id);
      const x = CANVAS_PAD + (node.column - min) * CARD_STEP, y = rows.get(node.column) ?? 38;
      const h = node.card.offsetHeight || Number(node.card.dataset.height) || 96;
      if (!node.card.hidden) node.card.dataset.height = String(h);
      node.card.style.left = `${x}px`; node.card.style.top = `${y}px`; rows.set(node.column, y + h + 40);
      if (!node.card.hidden) positions.set(node.id, {x, y, h});
    }
    drawWires(this.canvas, this.svg, positions, [...active]);
  }
}
