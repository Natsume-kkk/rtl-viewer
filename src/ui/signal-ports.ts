import type { TraceNode } from "../analysis/signal-flow";
import { CardWidths, columnPositions, element as el, cardHeader, appendSource, signalCode, makeWires, drawWires, CANVAS_TOP, type CardWidthState, type CardEdge, type CardPosition } from "./signal-canvas";
import { setIcon } from "./icons";
import { showCtxMenu, closeCtxMenu, type MenuItem } from "./menu";

type Side = "up" | "down";
interface PortCard { id: string; trace: TraceNode; column: number; children: string[]; card: HTMLElement; external?: boolean; materialized?: boolean; group?: string; side?: Side }
interface OnlySnapshot { expanded: string[]; assignments: string[]; filters: [string, string][]; selected?: string; left: number; top: number }
export interface PortViewState { expanded: string[]; assignments?: string[]; widths?:CardWidthState; selected?: string; only?: string; beforeOnly?: OnlySnapshot; filters?: [string, string][] }

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
  private active = true;
  private body: HTMLElement;
  private selected?: string;
  private only?: string;
  private beforeOnly?: OnlySnapshot;
  private filters = new Map<string, string>();
  private visible = new Set<string>();
  private followFrame?: number;
  private resize?: ResizeObserver;
  private contextBar = el("div", "port-view-context");
  private onlyLabel = el("code", "port-only-label");
  private counts = el("span", "port-view-count");
  private selectionActions = el("span", "port-selection-actions");
  private selectedLabel = el("code", "");
  private switcher = el("span", "port-instance-switcher");
  private instanceSelect = el("select", "");
  private previous = el("button", "btn-ghost port-context-action");
  private next = el("button", "btn-ghost port-context-action");
  private position = el("span", "");
  private showAllButton = el("button", "btn-ghost port-context-action", "显示全部");
  private closeMenuOnScroll = () => closeCtxMenu();
  private materializeNode?: (node: PortCard) => void;
  private widths = new CardWidths(() => this.render());
  constructor(signal: string, upstream: TraceNode, downstream: TraceNode, body: HTMLElement, private onExpandability?: (canExpand: boolean) => void) {
    this.body = body;
    this.setupContextBar();
    body.before(this.contextBar);
    body.classList.add("logic-body"); body.append(this.canvas); this.canvas.append(this.svg);
    const add = (id: string, trace: TraceNode, column: number, label: string, external = false): PortCard => {
      const old = this.nodes.get(id); if (old) return old;
      const card = el("article", `logic-card port-card${id === "focus" ? " selected" : ""}`);
      card.dataset.node = id;
      card.dataset.signal = label;
      const node = { id, trace, column, children: [], card, external, materialized: false };
      this.nodes.set(id, node);
      this.canvas.append(card);
      this.widths.add(id, card);
      return node;
    };
    const base = upstream.label.slice(0, upstream.label.lastIndexOf("."));
    const materialize = (node: PortCard) => {
      if (node.materialized) return;
      node.materialized = true;
      const { id, trace, column, card } = node;
      if (node.group) {
        cardHeader(card, `${node.group} · ${node.children.length} 个实例`);
        card.classList.add("repeated-summary");
        card.append(el("code", "logic-detail port-pin", `${this.nodes.get(node.children[0])!.trace.port?.name ?? signal} · ${node.children.length} 条端口连接`));
        const parameters = new Map<string, number>();
        for (const child of node.children) {
          const text = this.nodes.get(child)!.trace.module?.parameters ?? "默认参数";
          parameters.set(text, (parameters.get(text) ?? 0) + 1);
        }
        const entries = [...parameters].map(([text, count]) => `${text} × ${count}`);
        const summary = el("code", "logic-detail port-parameter-summary", entries.slice(0, 2).join(" · ") + (entries.length > 2 ? ` · 另 ${entries.length - 2} 组参数` : ""));
        summary.title = "参数覆盖原文；未列出默认值\n" + entries.join("\n");
        card.append(summary);
        const form = el("form", "port-instance-filter"), input = el("input", "");
        input.type = "search"; input.placeholder = "实例名或参数，回车筛选";
        input.setAttribute("aria-label", "筛选重复实例");
        input.value = this.filters.get(id) ?? "";
        form.append(input); card.append(form, el("span", "logic-detail port-filter-count"));
        form.onsubmit = event => {
          event.preventDefault(); this.stopFollowing();
          this.filters.set(id, input.value.trim()); this.render(); this.follow(node);
          input.focus({ preventScroll: true });
        };
        this.addActions(node);
        return;
      }
      const label = card.dataset.signal!;
      const location = trace.file ? { file: trace.file, line: trace.line ?? 1 } : undefined;
      const assignment = !trace.mapping && (!!trace.statement || trace.reason === "赋值位置");
      const subject = trace.port ?? trace.signal;
      const instance = subject && id !== "focus" ? subject.path.startsWith(base + "/") ? subject.path.slice(base.length + 1) : subject.path : undefined;
      const title = assignment && id !== "focus" ? (column < 0 ? "驱动赋值" : "读取赋值") : instance ?? (trace.mapping ? "端口映射" : label);
      cardHeader(card, title, location, [trace.label, trace.tip, trace.note].filter(Boolean).join("\n"));
      if (instance) card.append(el("code", `logic-detail ${trace.port ? "port-pin" : "signal-pin"}`, trace.port ? `${trace.port.direction ?? "方向待确认"} ${trace.port.name}` : `内部信号 ${trace.signal!.name}`));
      if (assignment && (trace.owner || trace.target)) card.append(el("code", "logic-detail assignment-context", trace.owner ?? trace.target!.context.path));
      if (assignment) appendSource(card, { ...trace, statement: trace.statement ?? trace.label }, signal, () => this.render());
      if (trace.mapping) { const code = signalCode(trace.mapping, signal, /\.vhdl?$/i.test(trace.file ?? "")); code.classList.add("port-mapping"); card.append(code); }
      if (trace.note) card.append(el("code", "flow-note", trace.note));
      if (trace.reason && trace.reason !== "赋值位置") card.append(el("p", "flow-reason", trace.reason));
      if (this.isModule(node)) {
        card.classList.add("module-summary");
        const summary = this.sites(this.descendants(id));
        card.append(el("span", "port-module-summary", `${summary.count} 处已知位置${summary.limited ? " · 含分析边界" : ""}`));
        if (trace.module) card.querySelector(".operation-name")!.append(el("span", "port-module-type", " · " + trace.module.name));
        if (trace.module?.parameters) card.append(el("code", "logic-detail", trace.module.parameters));
      }
      if (id !== "focus") this.addActions(node);
      this.canvas.append(card);
    };
    const focus = add("focus", { ...upstream, reason: undefined, note: undefined }, 0, signal);
    materialize(focus);
    focus.card.append(el("code", "logic-detail", [upstream.port?.direction, base].filter(Boolean).join(" · ")));
    const identity = (n: TraceNode) => JSON.stringify([n.owner ?? n.target?.context.path, n.scope, n.signal?.identity, n.port?.path, n.label, n.file, n.line, n.reason, n.note, n.mapping]);
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
      node.side = side;
      const edge: CardEdge = side === "up" ? { from: id, to: parent.id } : { from: parent.id, to: id };
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
    this.groupInstances(add, focus);
    const seed = (ids: string[], seen = new Set<string>()) => {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const node = this.nodes.get(id)!;
        const small = ids.length <= (this.isModule(node) ? 2 : 1);
        const directSites = !this.isModule(node) && node.children.every(child => this.nodes.get(child)!.trace.reason === "赋值位置");
        if (!node.group && node.children.length && (small || directSites)) {
          this.expanded.add(id);
        }
        if (this.expanded.has(id) || !node.group && !this.isModule(node)) seed(node.children, seen);
      }
    };
    seed(this.roots.up); seed(this.roots.down);
    // Some callers already end the root at an interface instead of adding a leaf.
    for (const [side, trace] of [["up", upstream], ["down", downstream]] as const) {
      if (!trace.children.length && trace.reason) {
        if (/^顶层(?:输入|输出)$/.test(trace.reason)) walk(trace, focus, side, 1);
        else if (![...focus.card.querySelectorAll(".flow-reason")].some(n => n.textContent === trace.reason)) focus.card.append(el("p", "flow-reason", trace.reason));
      }
    }
    for (const [id, directions] of this.externalDirections) {
      const node = this.nodes.get(id)!;
      materialize(node);
      node.card.append(el("span", "port-boundary", directions.size === 2 ? "顶层端口 · 与外部双向连接" : directions.has("up") ? "顶层端口 · 外部输入" : "顶层端口 · 输出至外部"));
    }
    this.materializeNode = materialize;
    this.render();
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => this.render());
      this.resize.observe(body);
    }
    body.addEventListener("scroll", this.closeMenuOnScroll);
    const current = focus.card.offsetLeft;
    if (current > body.clientWidth - 260 && body.clientWidth > 0) body.scrollLeft = Math.max(0, current - body.clientWidth / 2 + 118);
  }
  dispose(): void {
    this.active = false; this.stopFollowing(); this.resize?.disconnect();
    this.body.removeEventListener("scroll", this.closeMenuOnScroll);
    closeCtxMenu(); this.contextBar.remove(); this.widths.dispose();
  }
  capture(): PortViewState {
    return {expanded: [...this.expanded], assignments: this.assignments(), widths: this.widths.capture(), selected: this.selected, only: this.only, beforeOnly: this.beforeOnly, filters: [...this.filters]};
  }
  restore(state: PortViewState): void {
    this.stopFollowing();
    this.expanded = new Set(state.expanded); this.widths.restore(state.widths);
    this.selected = this.nodes.has(state.selected ?? "") ? state.selected : undefined;
    this.only = this.nodes.has(state.only ?? "") ? state.only : undefined;
    this.beforeOnly = this.only ? state.beforeOnly : undefined;
    this.filters = new Map(state.filters);
    this.render(); this.restoreAssignments(state.assignments);
    this.render();
  }
  expandLayer(): void {
    const before = new Set(this.visible);
    const frontier = [...this.visible].map(id => this.nodes.get(id)!).filter(node => node.children.length && !this.expanded.has(node.id));
    for (const node of frontier) this.expanded.add(node.id);
    this.render();
    if (frontier.length) this.follow(frontier.find(node => node.id === this.selected) ?? frontier[0], before);
  }
  expandAll(): void {
    const before = new Set(this.visible);
    this.expanded = new Set([...this.nodes.values()].filter(node => node.children.length).map(node => node.id));
    this.render();
    for (const block of this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block")) block.open = true;
    const node = this.nodes.get(this.selected ?? "") ?? [...this.nodes.values()].find(n => n.id !== "focus" && this.visible.has(n.id) && n.children.length);
    if (node) this.follow(node, before);
  }
  collapseAll(): void {
    this.stopFollowing(); this.expanded.clear();
    if (this.only) for (const target of this.moduleIds(this.only)) for (const id of this.trail(target).slice(0, -1)) this.expanded.add(id);
    for (const block of this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block")) block.open = false;
    this.render();
  }
  returnToSignal(): void {
    this.stopFollowing();
    const card = this.nodes.get("focus")!.card;
    if (!this.body.clientWidth) return;
    this.body.scrollTo({left: Math.max(0, card.offsetLeft - (this.body.clientWidth - card.offsetWidth) / 2), top: Math.max(0, card.offsetTop - 16), behavior: this.scrollBehavior()});
  }
  private isModule(node: PortCard): boolean { return node.id !== "focus" && !!(node.trace.port || node.trace.signal) && !node.trace.statement && node.trace.reason !== "赋值位置"; }
  private assignments(): string[] { return [...this.nodes.values()].filter(n => n.card.querySelector<HTMLDetailsElement>(".assignment-block")?.open).map(n => n.id); }
  private restoreAssignments(ids?: string[]): void {
    if (!ids) return;
    for (const node of this.nodes.values()) {
      const block = node.card.querySelector<HTMLDetailsElement>(".assignment-block");
      if (block) block.open = ids.includes(node.id);
    }
  }
  private descendants(id: string): Set<string> {
    const seen = new Set<string>();
    const visit = (key: string) => { if (seen.has(key)) return; seen.add(key); for (const child of this.nodes.get(key)?.children ?? []) visit(child); };
    visit(id); return seen;
  }
  private trail(id: string): string[] {
    const seen = new Set<string>();
    const visit = (key: string): string[] | undefined => {
      if (key === id) return [key];
      if (seen.has(key)) return; seen.add(key);
      for (const child of this.nodes.get(key)?.children ?? []) { const result = visit(child); if (result) return [key, ...result]; }
    };
    for (const key of [...this.roots.up, ...this.roots.down]) { const result = visit(key); if (result) return result; }
    return [];
  }
  private sites(ids: Iterable<string>): { count: number; limited: boolean } {
    const sites = new Set<string>(); let limited = false;
    for (const id of ids) {
      const node = this.nodes.get(id)!;
      if (node.group || id === "focus") continue;
      const trace = node.trace;
      if (trace.reason === "赋值位置" || trace.statement || trace.reason?.startsWith("控制/时钟")) sites.add(JSON.stringify([trace.owner ?? trace.target?.context.path, trace.scope, trace.file, trace.line, trace.label]));
      else if (trace.reason && !/^(顶层|模块端口|无赋值来源|无后续引用)/.test(trace.reason)) limited = true;
    }
    return { count: sites.size, limited };
  }
  private matches(node: PortCard, group: string): boolean {
    const query = this.filters.get(group)?.toLowerCase();
    return !query || `${node.trace.port?.path ?? node.trace.label} ${node.trace.module?.parameters ?? "默认参数"}`.toLowerCase().includes(query);
  }
  private groupInstances(add: (id: string, trace: TraceNode, column: number, label: string) => PortCard, focus: PortCard): void {
    const parents = [...this.nodes.values()];
    for (const side of ["up", "down"] as const) for (const parent of parents) {
      if (parent.id !== "focus" && parent.side !== side) continue;
      const children = parent === focus ? this.roots[side] : parent.children;
      const groups = new Map<string, string[]>();
      for (const id of children) {
        const node = this.nodes.get(id)!, trace = node.trace;
        if (!trace.module || !trace.port || node.external) continue;
        const key = JSON.stringify([trace.module.name, trace.port.path.slice(0, trace.port.path.lastIndexOf("/")), trace.port.name, trace.port.direction]);
        const members = groups.get(key) ?? []; members.push(id); groups.set(key, members);
      }
      for (const [key, members] of groups) {
        if (members.length < 3 || new Set(members.map(id => this.nodes.get(id)!.trace.port!.path)).size !== members.length) continue;
        const first = this.nodes.get(members[0])!, id = `group:${side}:${parent.id}:${key}`;
        const group = add(id, {label: first.trace.module!.name, children: []}, parent.column + (side === "up" ? -1 : 1), first.trace.module!.name);
        group.group = first.trace.module!.name; group.side = side; group.children = members;
        const shifted = new Set<string>();
        const shift = (child: string, depth: number) => {
          if (shifted.has(child)) return; shifted.add(child);
          const node = this.nodes.get(child)!;
          const distance = Math.abs(parent.column) + depth - Number(!!node.external);
          node.column = (side === "up" ? -1 : 1) * Math.max(Math.abs(node.column), distance);
          for (const next of node.children) shift(next, depth + 1);
        };
        for (const member of members) shift(member, 2);
        const replacement = children.flatMap(child => child === members[0] ? [id] : members.includes(child) ? [] : [child]);
        children.splice(0, children.length, ...replacement);
        this.edges = this.edges.filter(edge => !members.some(member => side === "up" ? edge.from === member && edge.to === parent.id : edge.to === member && edge.from === parent.id));
        this.edges.push(side === "up" ? {from: id, to: parent.id} : {from: parent.id, to: id});
        for (const member of members) this.edges.push(side === "up" ? {from: member, to: id, control: true, role: "重复实例端口连接汇总"} : {from: id, to: member, control: true, role: "重复实例端口连接汇总"});
      }
    }
  }
  private setupContextBar(): void {
    this.counts.setAttribute("role", "status"); this.counts.setAttribute("aria-live", "polite");
    this.showAllButton.type = "button"; this.showAllButton.title = "恢复只看之前的展开状态和位置";
    this.showAllButton.onclick = () => this.showAll();
    const collapse = el("button", "btn-ghost port-context-action", "收起其他"); collapse.type = "button";
    collapse.onclick = () => this.collapseOthers(); this.selectionActions.append(this.selectedLabel, collapse);
    this.previous.type = this.next.type = "button";
    setIcon(this.previous, "chevron-right"); setIcon(this.next, "chevron-right");
    this.previous.classList.add("port-previous-instance");
    this.previous.title = "上一个同级实例"; this.next.title = "下一个同级实例";
    this.previous.setAttribute("aria-label", this.previous.title); this.next.setAttribute("aria-label", this.next.title);
    this.previous.onclick = () => this.stepInstance(-1); this.next.onclick = () => this.stepInstance(1);
    this.instanceSelect.setAttribute("aria-label", "切换同级实例");
    this.instanceSelect.onchange = () => this.switchInstance(this.instanceSelect.value);
    this.switcher.append(this.previous, this.instanceSelect, this.position, this.next);
    this.contextBar.append(this.onlyLabel, this.showAllButton, this.counts, this.switcher, this.selectionActions);
  }
  private label(node: PortCard): string { return node.group ?? node.trace.port?.path.split("/").at(-1) ?? node.trace.signal?.path.split("/").at(-1) ?? node.card.dataset.signal!; }
  private moduleIds(id: string): string[] {
    const node = this.nodes.get(id)!;
    const path = node.trace.port?.path ?? node.trace.signal?.path;
    return path ? [...this.nodes.values()].filter(other => other.side === node.side && (other.trace.port?.path ?? other.trace.signal?.path) === path).map(other => other.id) : [id];
  }
  private onlyScope(id: string): Set<string> { return new Set(this.moduleIds(id).flatMap(key => [...this.descendants(key)])); }
  private peers(): PortCard[] {
    const node = this.nodes.get(this.only ?? ""); if (!node || node.group) return [];
    const trail = this.trail(node.id), parent = this.nodes.get(trail.at(-2) ?? "");
    const paths = new Set<string>();
    return (parent?.children ?? this.roots[node.side ?? "down"]).map(id => this.nodes.get(id)!).filter(peer => {
      const path = peer.trace.port?.path ?? peer.trace.signal?.path;
      if (!this.isModule(peer) || !path || paths.has(path) || parent?.group && !this.matches(peer, parent.id)) return false;
      paths.add(path); return true;
    });
  }
  private switchInstance(id: string): void {
    if (!this.peers().some(node => node.id === id) || this.only && this.moduleIds(this.only).includes(id)) return;
    this.onlySelected(id);
  }
  private stepInstance(direction: number): void {
    const peers = this.peers(), node = peers[peers.findIndex(n => this.only && this.moduleIds(this.only).includes(n.id)) + direction];
    if (node) this.switchInstance(node.id);
  }
  private onlySelected(id: string): void {
    this.stopFollowing();
    if (this.only && this.moduleIds(this.only).includes(id)) { this.showAll(); return; }
    if (!this.only) this.beforeOnly = {expanded: [...this.expanded], assignments: this.assignments(), filters: [...this.filters], selected: this.selected, left: this.body.scrollLeft, top: this.body.scrollTop};
    this.only = this.selected = id;
    for (const target of this.moduleIds(id)) for (const key of this.trail(target)) this.expanded.add(key);
    this.render(); this.follow(this.nodes.get(id)!);
  }
  private showAll(): void {
    this.stopFollowing(); const before = this.beforeOnly;
    this.only = this.beforeOnly = undefined;
    if (before) { this.expanded = new Set(before.expanded); this.filters = new Map(before.filters); this.selected = before.selected; }
    this.render();
    if (before) {
      this.restoreAssignments(before.assignments); this.render();
      this.body.scrollLeft = before.left; this.body.scrollTop = before.top;
    }
  }
  private collapseOthers(): void {
    if (this.only || !this.selected) return;
    this.stopFollowing();
    const targets = this.moduleIds(this.selected);
    const keep = new Set([...targets.flatMap(id => this.trail(id)), ...this.onlyScope(this.selected)]);
    this.expanded = new Set([...this.expanded].filter(id => keep.has(id)));
    for (const target of targets) for (const id of this.trail(target)) this.expanded.add(id);
    this.render(); this.follow(this.nodes.get(this.selected)!);
  }
  private addActions(node: PortCard): void {
    if (node.trace.statement || node.trace.reason === "赋值位置") return;
    const head = node.card.querySelector<HTMLElement>(".logic-card-head")!;
    if (node.children.length) {
      const button = el("button", "port-fold-toggle path-continue"), icon = el("span", "");
      button.type = "button"; button.append(icon, head.querySelector(".operation-name")!); head.prepend(button);
      button.onclick = () => {
        this.stopFollowing(); const before = new Set(this.visible), top = node.card.offsetTop - this.body.scrollTop;
        this.selected = node.id;
        const expanding = !this.expanded.has(node.id);
        if (expanding) this.expanded.add(node.id); else this.expanded.delete(node.id);
        // The path to an isolated descendant must remain visible.
        if (this.only && !this.moduleIds(this.only).includes(node.id) && this.moduleIds(this.only).some(id => this.trail(id).includes(node.id))) this.expanded.add(node.id);
        this.render();
        if (expanding) this.follow(node, before); else this.body.scrollTop = node.card.offsetTop - top;
      };
      head.onclick = event => { if (!(event.target as HTMLElement).closest("button")) button.click(); };
      this.branches.set(node.id, button);
    } else head.onclick = null;
    if (!this.isModule(node) && !node.group) return;
    node.card.tabIndex = 0;
    node.card.setAttribute("aria-label", node.trace.port?.path ?? node.trace.signal?.path ?? node.group!);
    node.card.onclick = event => {
      if (!(event.target as HTMLElement).closest("button,input,select,summary,.card-resize")) { this.selected = node.id; this.updateContext(); }
    };
    const only = el("button", "btn-ghost only-module-toggle"); only.type = "button"; setIcon(only, "only-module");
    only.onclick = () => this.onlySelected(node.id);
    head.insertBefore(only, head.querySelector(".source-jump"));
    const more = el("button", "btn-ghost port-module-more"); more.type = "button"; setIcon(more, "more");
    more.setAttribute("aria-label", `模块操作 ${this.label(node)}`); more.title = "模块操作"; more.setAttribute("aria-haspopup", "menu");
    more.onclick = event => {
      event.stopPropagation(); this.selected = node.id; this.updateContext();
      const items: MenuItem[] = [];
      if (node.children.length) items.push({label: "展开此模块全部层级", action: () => {
        const before = new Set(this.visible); for (const id of this.descendants(node.id)) this.expanded.add(id);
        this.render(); this.follow(node, before);
      }});
      items.push(this.only ? {label: "显示全部模块", action: () => this.showAll()} : {label: "收起其他模块", action: () => this.collapseOthers()});
      const box = more.getBoundingClientRect(); showCtxMenu(box.left, box.bottom, items, more);
    };
    head.append(more);
  }
  private updateContext(): void {
    const only = this.nodes.get(this.only ?? ""), selected = this.nodes.get(this.selected ?? "");
    this.onlyLabel.hidden = this.showAllButton.hidden = !only;
    this.onlyLabel.textContent = only ? "只看 " + this.label(only) : "";
    this.onlyLabel.title = only?.trace.port?.path ?? only?.trace.signal?.path ?? "";
    this.selectionActions.hidden = !selected || !!only || !this.visible.has(selected.id);
    this.selectedLabel.textContent = selected ? this.label(selected) : "";
    this.selectedLabel.title = selected?.trace.label ?? "";
    const total = this.sites(this.nodes.keys());
    let scope = only ? this.onlyScope(only.id) : undefined;
    if (only?.group) scope = new Set([only.id, ...only.children.filter(id => this.matches(this.nodes.get(id)!, only.id)).flatMap(id => [...this.descendants(id)])]);
    const current = scope ? this.sites(scope) : total;
    this.counts.textContent = (only ? `当前范围 ${current.count} 处位置／全部 ${total.count} 处` : `已找到 ${total.count} 处位置`) + (current.limited ? " · 含分析边界" : "");
    const peers = this.peers(), index = peers.findIndex(node => this.only && this.moduleIds(this.only).includes(node.id)), key = peers.map(node => node.id).join("\n");
    this.switcher.hidden = peers.length < 2;
    if (this.instanceSelect.dataset.peers !== key) {
      this.instanceSelect.replaceChildren(...peers.map(node => { const option = el("option", "", this.label(node)); option.value = node.id; return option; }));
      this.instanceSelect.dataset.peers = key;
    }
    this.instanceSelect.value = peers[index]?.id ?? ""; this.instanceSelect.title = only?.trace.label ?? "";
    this.position.textContent = `${index + 1} / ${peers.length}`;
    this.previous.disabled = index <= 0; this.next.disabled = index >= peers.length - 1;
    for (const node of this.nodes.values()) {
      node.card.classList.toggle("port-module-selected", node.id === this.selected);
      const button = node.card.querySelector<HTMLButtonElement>(".only-module-toggle");
      if (button) {
        const active = !!this.only && this.moduleIds(this.only).includes(node.id);
        button.setAttribute("aria-pressed", String(active));
        button.title = active ? "取消只看此模块，恢复之前视图" : "只看此模块";
        button.setAttribute("aria-label", button.title + " " + this.label(node));
      }
    }
  }
  private scrollBehavior(): ScrollBehavior { return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"; }
  private stopFollowing(): void {
    if (this.followFrame !== undefined) cancelAnimationFrame(this.followFrame);
    this.followFrame = undefined;
    if (this.body.clientWidth) this.body.scrollTo({left: this.body.scrollLeft, top: this.body.scrollTop, behavior: "auto"});
  }
  private follow(node: PortCard, before?: Set<string>): void {
    if (!this.body.clientWidth) return;
    if (this.followFrame !== undefined) cancelAnimationFrame(this.followFrame);
    this.followFrame = requestAnimationFrame(() => {
      this.followFrame = undefined;
      if (!this.active || node.card.hidden) return;
      const revealed = [...this.descendants(node.id)].filter(id => id !== node.id && this.visible.has(id) && (!before || !before.has(id))).map(id => this.nodes.get(id)!.card);
      const first = revealed[0] ?? node.card;
      const bounds = (cards: HTMLElement[]) => ({left: Math.min(...cards.map(card => card.offsetLeft)), right: Math.max(...cards.map(card => card.offsetLeft + card.offsetWidth)), top: Math.min(...cards.map(card => card.offsetTop)), bottom: Math.max(...cards.map(card => card.offsetTop + card.offsetHeight))});
      const all = bounds([node.card, ...revealed]);
      const fits = all.right - all.left <= this.body.clientWidth - 32 && all.bottom - all.top <= this.body.clientHeight - 32;
      const target = fits ? all : bounds([node.card, first]), firstBounds = bounds([first]);
      const axis = (start: number, end: number, firstStart: number, firstEnd: number, current: number, size: number) => {
        if (end - start > size - 32) return Math.max(0, firstEnd - firstStart > size - 32 ? firstStart - 16 : firstEnd - size + 16);
        if (start < current + 16) return Math.max(0, start - 16);
        if (end > current + size - 16) return Math.max(0, end - size + 16);
        return current;
      };
      this.body.scrollTo({left: axis(target.left, target.right, firstBounds.left, firstBounds.right, this.body.scrollLeft, this.body.clientWidth), top: axis(target.top, target.bottom, firstBounds.top, firstBounds.bottom, this.body.scrollTop, this.body.clientHeight), behavior: this.scrollBehavior()});
    });
  }
  private render(): void {
    if (!this.active) return;
    const visible = new Set(["focus"]), traversed = new Set<string>(), active = new Set<CardEdge>();
    const scope = this.only ? this.onlyScope(this.only) : undefined;
    const trail = this.only ? new Set(this.moduleIds(this.only).flatMap(id => this.trail(id))) : undefined;
    const onlySide = this.nodes.get(this.only ?? "")?.side;
    const allowed = (id: string) => !scope || scope.has(id) || trail!.has(id) || this.nodes.get(id)!.side !== onlySide;
    const visit = (id: string, parent: string) => {
      if (!allowed(id)) return;
      this.edges.filter(e=>e.from===parent&&e.to===id||e.from===id&&e.to===parent).forEach(e=>active.add(e));
      visible.add(id); const node = this.nodes.get(id)!;
      this.materializeNode?.(node);
      if (traversed.has(id)) return;
      traversed.add(id);
      if (this.expanded.has(id)) node.children.filter(child => !node.group || this.matches(this.nodes.get(child)!, id) || trail?.has(child)).forEach(child => visit(child, id));
    };
    for (const side of ["up", "down"] as const) this.roots[side].forEach(id => visit(id,"focus"));
    for (const [id, button] of this.branches) {
      const open = this.expanded.has(id), node = this.nodes.get(id)!;
      setIcon(button.firstElementChild as HTMLElement, open ? "chevron-down" : "chevron-right");
      button.setAttribute("aria-expanded", String(open));
      button.setAttribute("aria-label", `${open ? "收起" : "展开"} ${node.trace.label}`);
      button.title = button.getAttribute("aria-label")!;
      node.card.classList.toggle("route-pending", !open);
      node.card.classList.toggle("port-fold-open", open);
    }
    for (const node of this.nodes.values()) {
      node.card.hidden = !visible.has(node.id);
      if (node.group && node.materialized) {
        const form = node.card.querySelector<HTMLElement>(".port-instance-filter")!;
        form.hidden = !this.expanded.has(node.id) || !!this.only && node.id !== this.only;
        const input = form.querySelector("input")!;
        if (document.activeElement !== input) input.value = this.filters.get(node.id) ?? "";
        const count = node.card.querySelector<HTMLElement>(".port-filter-count")!;
        count.hidden = !this.expanded.has(node.id);
        count.textContent = `显示 ${node.children.filter(id => visible.has(id)).length} / ${node.children.length} 个实例`;
      }
    }
    this.widths.fit();
    const widths = new Map<number, number>();
    for (const node of this.nodes.values()) if (visible.has(node.id)) widths.set(node.column, Math.max(widths.get(node.column) ?? 0, this.widths.get(node.id)));
    const offsets = columnPositions(widths);
    const rows = new Map<number, number>(), positions = new Map<string, CardPosition>();
    const deferred = new Set<string>();
    const place = (id: string, top: number): number => {
      const node = this.nodes.get(id)!;
      const existing = positions.get(id);
      if (existing) return existing.y + existing.h;
      if (!visible.has(id)) return top;
      if (node.external) { deferred.add(id); return top; }
      const y = Math.max(top, rows.get(node.column) ?? CANVAS_TOP);
      const x = offsets.get(node.column)!;
      const h = node.card.offsetHeight || Number(node.card.dataset.height) || 96;
      node.card.dataset.height = String(h);
      node.card.style.left = `${x}px`; node.card.style.top = `${y}px`; rows.set(node.column, y + h + 40);
      positions.set(node.id, {x, y, h, w:this.widths.get(node.id), column:node.column});
      let bottom = y + h, next = y;
      if (this.expanded.has(id)) for (const child of node.children) if ([...active].some(edge => edge.from === id && edge.to === child || edge.to === id && edge.from === child)) {
        bottom = Math.max(bottom, place(child, next)); next = bottom + 24;
      }
      return bottom;
    };
    place("focus", CANVAS_TOP);
    for (const side of ["up", "down"] as const) {
      let top = CANVAS_TOP;
      for (const id of this.roots[side]) if (visible.has(id)) top = place(id, top) + 24;
    }
    for (const id of deferred) {
      const node = this.nodes.get(id)!, x = offsets.get(node.column)!, y = rows.get(node.column) ?? CANVAS_TOP;
      const h = node.card.offsetHeight || Number(node.card.dataset.height) || 96;
      node.card.style.left = `${x}px`; node.card.style.top = `${y}px`; rows.set(node.column, y + h + 40);
      positions.set(id, {x, y, h, w:this.widths.get(id), column:node.column});
    }
    drawWires(this.canvas, this.svg, positions, [...active]);
    this.visible = visible;
    this.updateContext();
    this.onExpandability?.([...visible].some(id => id !== "focus" && this.nodes.get(id)!.children.length > 0 && !this.expanded.has(id)));
  }
}
