import type { LogicGraph, LogicNode } from "../analysis/local";
import { CardWidths, cardHeader, element as el, type CardEdge } from "./signal-canvas";
import { setIcon } from "./icons";
import { closeCtxMenu, showCtxMenu, type MenuItem } from "./menu";

export interface LogicReadingState { open: string[]; routes: string[]; sources: [string, boolean[]][] }
interface ModuleState { expanded: string[]; filters: [string, string][]; selected?: string; only?: string }
interface ModuleSnapshot extends ModuleState { reading: LogicReadingState; left: number; top: number }
export interface LogicModuleState extends ModuleState { beforeOnly?: ModuleSnapshot; pathReading?: LogicReadingState }
interface InstanceGroup { id: string; name: string; members: string[] }
interface ModuleHooks { redraw(): void; reading(): LogicReadingState; restore(reading: LogicReadingState): void; materialize(id: string): void }

/** Presentation of child-port boundaries; never changes the module-local dependency graph. */
export class SignalLogicModules {
  private nodes = new Map<string, LogicNode>();
  private groups = new Map<string, InstanceGroup>();
  private groupFor = new Map<string, string>();
  private expanded = new Set<string>();
  private filters = new Map<string, string>();
  private selected?: string;
  private only?: string;
  private beforeOnly?: ModuleSnapshot;
  private pathReading?: LogicReadingState;
  private available = new Set<string>();
  private shown = new Set<string>();
  private frame?: number;
  private active = true;
  private bar = el("div", "port-view-context");
  private onlyLabel = el("code", "port-only-label");
  private showAllButton = el("button", "btn-ghost port-context-action", "显示全部");
  private count = el("span", "port-view-count");
  private selection = el("span", "port-selection-actions");
  private selectedLabel = el("code", "");
  private switcher = el("span", "port-instance-switcher");
  private select = el("select", "");
  private previous = el("button", "btn-ghost port-context-action port-previous-instance");
  private next = el("button", "btn-ghost port-context-action");
  private position = el("span", "");
  private closeOnScroll = () => closeCtxMenu();

  constructor(private graph: LogicGraph, private body: HTMLElement, private canvas: HTMLElement,
    private cards: Map<string, HTMLElement>, private widths: CardWidths, private hooks: ModuleHooks) {
    for (const node of graph.nodes) if (node.port) this.nodes.set(node.id, node);
    this.makeGroups();
    const small = new Set([...this.nodes.values()].map(node => node.port!.path)).size <= 2;
    for (const node of this.nodes.values()) {
      const card = cards.get(node.id)!; card.classList.add("module-summary");
      if (node.portContext) card.querySelector(".operation-name")!.append(el("span", "port-module-type", " · " + node.portContext.module));
      if (small && !this.groupFor.has(node.id)) this.expanded.add(node.id);
      this.actions(node.id, card, !!node.portSites?.some(site => site.trace.children.length));
    }
    this.setupBar(); body.before(this.bar); body.addEventListener("scroll", this.closeOnScroll);
  }
  get hasModules(): boolean { return this.nodes.size > 0; }
  capture(): LogicModuleState { return {...this.state(), beforeOnly: this.beforeOnly, pathReading: this.pathReading}; }
  restore(state: LogicModuleState): void {
    this.stop(); this.setState(state); this.beforeOnly = state.beforeOnly; this.pathReading = state.pathReading;
  }
  private state(): ModuleState { return {expanded: [...this.expanded], filters: [...this.filters], selected: this.selected, only: this.only}; }
  private setState(state: ModuleState): void {
    this.expanded = new Set(state.expanded); this.filters = new Map(state.filters);
    this.selected = state.selected; this.only = state.only;
  }
  dispose(): void {
    this.active = false; this.stop(); this.body.removeEventListener("scroll", this.closeOnScroll);
    this.bar.remove(); closeCtxMenu();
  }
  expandAll(): void {
    for (const id of [...this.groups.keys(), ...this.nodes.keys()]) this.expanded.add(id);
  }
  collapseAll(): void {
    this.stop(); this.expanded.clear();
    if (this.only) this.openGroups(this.targetIds(this.only));
  }
  expandLayer(): string | undefined {
    const frontier = [...this.shown].filter(id => !this.expanded.has(id) && (this.groups.has(id) || this.hasSites(id)));
    for (const id of frontier) this.expanded.add(id);
    return frontier[0];
  }
  requiredReading(): LogicReadingState | undefined {
    const reading = this.pathReading ?? this.beforeOnly?.reading;
    if (!this.only || !reading) return;
    const ancestors = new Set<string>();
    const visit = (id: string) => { if (ancestors.has(id)) return; ancestors.add(id); for (const edge of this.graph.edges) if (edge.to === id) visit(edge.from); };
    visit(this.graph.root); for (const id of this.targetIds(this.only)) visit(id);
    return {open: reading.open.filter(branch => [...ancestors].some(id => branch.startsWith(id + "/d"))), routes: reading.routes.filter(id => ancestors.has(id)), sources: []};
  }
  get canExpand(): boolean {
    return [...this.shown].some(id => !this.expanded.has(id) && (this.groups.has(id) || this.hasSites(id)));
  }
  private hasSites(id: string): boolean { return !!this.nodes.get(id)?.portSites?.some(site => site.trace.children.length); }
  private title(id: string): string { return this.groups.get(id)?.name ?? this.nodes.get(id)?.port?.path.split("/").at(-1) ?? id; }
  private key(id: string): string { return this.nodes.get(id)?.port?.path ?? id; }
  private targetIds(key: string): string[] {
    const group = this.groups.get(key);
    return group ? group.members.filter(id => this.matches(id, key)) : [...this.nodes].filter(([, node]) => node.port!.path === key).map(([id]) => id);
  }
  private matches(id: string, groupId = this.groupFor.get(id)): boolean {
    const query = groupId ? this.filters.get(groupId)?.toLowerCase() : undefined;
    const node = this.nodes.get(id)!;
    return !query || `${node.port!.path} ${this.parameters(node)}`.toLowerCase().includes(query);
  }
  private parameters(node: LogicNode): string {
    return node.portContext?.instance?.parameterOverrides?.map((parameter, i) => `${parameter.name ?? i + 1}=${parameter.expression}`).join(", ") || "默认参数";
  }
  private openGroups(ids: string[]): void { for (const id of ids) { const group = this.groupFor.get(id); if (group) this.expanded.add(group); } }
  private isolate(id: string): void {
    this.stop(); const key = this.key(id);
    if (key === this.only) { this.showAll(); return; }
    if (!this.only) this.beforeOnly = {...this.state(), reading: this.hooks.reading(), left: this.body.scrollLeft, top: this.body.scrollTop};
    this.pathReading = this.hooks.reading();
    this.only = key; this.selected = id;
    const targets = this.targetIds(key); this.openGroups(targets);
    this.expanded.add(id); for (const target of targets) this.expanded.add(target);
    this.hooks.redraw(); this.follow(id);
  }
  private showAll(): void {
    this.stop(); const before = this.beforeOnly;
    this.only = this.beforeOnly = this.pathReading = undefined;
    if (before) { this.setState(before); this.hooks.restore(before.reading); }
    this.hooks.redraw();
    if (before) { this.body.scrollLeft = before.left; this.body.scrollTop = before.top; }
  }
  private collapseOthers(): void {
    if (this.only || !this.selected) return;
    this.stop(); const keep = this.targetIds(this.key(this.selected));
    this.expanded = new Set(keep); this.openGroups(keep);
    if (this.groups.has(this.selected)) this.expanded.add(this.selected);
    this.hooks.redraw(); this.follow(this.selected);
  }
  private peers(): string[] {
    const node = this.nodes.get(this.only ? this.targetIds(this.only)[0] : "");
    if (!node || !this.only || this.groups.has(this.only)) return [];
    const parent = node.port!.path.slice(0, node.port!.path.lastIndexOf("/")), paths = new Set<string>();
    return [...this.available].filter(id => {
      const other = this.nodes.get(id)!, path = other.port!.path;
      if (paths.has(path) || path.slice(0, path.lastIndexOf("/")) !== parent || !this.matches(id)) return false;
      paths.add(path); return true;
    });
  }
  private step(direction: number): void {
    const peers = this.peers(), target = peers[peers.findIndex(id => this.key(id) === this.only) + direction];
    if (target) this.isolate(target);
  }
  private setupBar(): void {
    this.count.setAttribute("role", "status"); this.count.setAttribute("aria-live", "polite");
    this.showAllButton.type = "button"; this.showAllButton.title = "恢复只看之前的展开状态和位置"; this.showAllButton.onclick = () => this.showAll();
    const collapse = el("button", "btn-ghost port-context-action", "收起其他"); collapse.type = "button"; collapse.onclick = () => this.collapseOthers();
    this.selection.append(this.selectedLabel, collapse);
    this.previous.type = this.next.type = "button"; setIcon(this.previous, "chevron-right"); setIcon(this.next, "chevron-right");
    for (const [button, title] of [[this.previous, "上一个同级实例"], [this.next, "下一个同级实例"]] as const) { button.title = title; button.setAttribute("aria-label", title); }
    this.previous.onclick = () => this.step(-1); this.next.onclick = () => this.step(1);
    this.select.setAttribute("aria-label", "切换同级实例");
    this.select.onchange = () => { if (this.key(this.select.value) !== this.only) this.isolate(this.select.value); };
    this.switcher.append(this.previous, this.select, this.position, this.next);
    this.bar.append(this.onlyLabel, this.showAllButton, this.count, this.switcher, this.selection);
  }
  private actions(id: string, card: HTMLElement, foldable: boolean): void {
    const head = card.querySelector<HTMLElement>(".logic-card-head")!; head.onclick = null;
    card.tabIndex = 0; card.setAttribute("aria-label", this.key(id));
    if (foldable) {
      const fold = el("button", "port-fold-toggle"), icon = el("span", ""); fold.type = "button";
      fold.append(icon, head.querySelector(".operation-name")!); head.prepend(fold);
      fold.onclick = () => {
        this.stop(); const before = new Set(this.shown), top = card.offsetTop - this.body.scrollTop;
        this.selected = id; const expanding = !this.expanded.has(id);
        if (expanding) this.expanded.add(id); else this.expanded.delete(id);
        this.hooks.redraw(); if (expanding) this.follow(id, before); else this.body.scrollTop = card.offsetTop - top;
      };
      head.onclick = event => { if (!(event.target as HTMLElement).closest("button")) fold.click(); };
    }
    card.onclick = event => { if (!(event.target as HTMLElement).closest("button,input,select,summary,.card-resize")) { this.selected = id; this.updateBar(); } };
    const only = el("button", "btn-ghost only-module-toggle"); only.type = "button"; setIcon(only, "only-module"); only.onclick = () => this.isolate(id);
    head.insertBefore(only, head.querySelector(".source-jump"));
    const more = el("button", "btn-ghost port-module-more"); more.type = "button"; setIcon(more, "more");
    more.title = "模块操作"; more.setAttribute("aria-label", `模块操作 ${this.title(id)}`); more.setAttribute("aria-haspopup", "menu");
    more.onclick = event => {
      event.stopPropagation(); this.selected = id; this.updateBar();
      const actions: MenuItem[] = [];
      if (foldable) actions.push({label: "展开此模块全部内容", action: () => {
        this.expanded.add(id); for (const target of this.targetIds(this.key(id))) this.expanded.add(target);
        this.hooks.redraw(); this.follow(id);
      }});
      actions.push(this.only ? {label: "显示全部模块", action: () => this.showAll()} : {label: "收起其他模块", action: () => this.collapseOthers()});
      const box = more.getBoundingClientRect(); showCtxMenu(box.left, box.bottom, actions, more);
    };
    head.append(more);
  }
  private makeGroups(): void {
    const candidates = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      if (!node.portContext) continue;
      const incoming = this.graph.edges.filter(edge => edge.to === node.id), outgoing = this.graph.edges.filter(edge => edge.from === node.id);
      if (incoming.length && outgoing.length) continue;
      const connections = [...incoming, ...outgoing].map(edge => [edge.from === node.id ? "out" : "in", edge.from === node.id ? edge.to : edge.from, edge.role, edge.control, edge.current, edge.unknown]);
      const key = JSON.stringify([node.portContext.module, node.port!.path.slice(0, node.port!.path.lastIndexOf("/")), node.port!.name, node.port!.direction, connections]);
      const members = candidates.get(key) ?? []; members.push(node.id); candidates.set(key, members);
    }
    for (const [key, members] of candidates) {
      if (members.length < 3 || new Set(members.map(id => this.key(id))).size !== members.length) continue;
      const id = "module-group:" + key, first = this.nodes.get(members[0])!, name = first.portContext!.module;
      this.groups.set(id, {id, name, members}); for (const member of members) this.groupFor.set(member, id);
      const card = el("article", "logic-card repeated-summary"); card.dataset.node = id; card.dataset.signal = name;
      cardHeader(card, `${name} · ${members.length} 个实例`); card.append(el("code", "logic-detail port-pin", `${first.port!.name} · ${members.length} 条端口连接`));
      const parameters = new Map<string, number>();
      for (const member of members) { const text = this.parameters(this.nodes.get(member)!); parameters.set(text, (parameters.get(text) ?? 0) + 1); }
      const entries = [...parameters].map(([text, count]) => `${text} × ${count}`);
      const summary = el("code", "logic-detail port-parameter-summary", entries.slice(0, 2).join(" · ") + (entries.length > 2 ? ` · 另 ${entries.length - 2} 组参数` : "")); summary.title = "参数覆盖原文\n" + entries.join("\n");
      const form = el("form", "port-instance-filter"), input = el("input", ""); input.type = "search"; input.placeholder = "实例名或参数，回车筛选"; input.setAttribute("aria-label", "筛选重复实例"); form.append(input);
      form.onsubmit = event => { event.preventDefault(); this.stop(); this.filters.set(id, input.value.trim()); this.hooks.redraw(); this.follow(id); input.focus({preventScroll: true}); };
      card.append(summary, form, el("span", "logic-detail port-filter-count"));
      this.cards.set(id, card); this.canvas.append(card); this.widths.add(id, card, name); this.actions(id, card, true);
    }
  }
  project(visible: Set<string>, edges: CardEdge[]): {visible: Set<string>; edges: CardEdge[]} {
    this.available = new Set([...visible].filter(id => this.nodes.has(id)));
    const targets = new Set(this.only ? this.targetIds(this.only).filter(id => visible.has(id)) : []);
    let keep: Set<string> | undefined;
    if (this.only) {
      keep = new Set<string>();
      const ancestors = (id: string) => { if (keep!.has(id)) return; keep!.add(id); for (const edge of edges) if (edge.to === id) ancestors(edge.from); };
      ancestors(this.graph.root); for (const target of targets) ancestors(target);
    }
    const forward = new Set<string>();
    const descend = (id: string) => { if (forward.has(id)) return; forward.add(id); for (const edge of edges) if (edge.from === id) descend(edge.to); };
    if (this.only) descend(this.graph.root);
    const downstream = [...targets].some(id => forward.has(id));
    const shown = new Set([...visible].filter(id => (!keep || keep.has(id)) && (!this.nodes.has(id) ||
      (targets.has(id) || (!this.only || forward.has(id) !== downstream) && this.matches(id)))));
    const activeGroups = new Set<string>();
    for (const group of this.groups.values()) {
      const members = group.members.filter(id => this.available.has(id));
      if (!members.length || this.only && this.only !== group.id && !members.some(id => shown.has(id))) continue;
      activeGroups.add(group.id); shown.add(group.id);
      if (!this.expanded.has(group.id)) for (const member of members) shown.delete(member);
      const card = this.cards.get(group.id)!, input = card.querySelector<HTMLInputElement>("input")!;
      input.form!.hidden = !this.expanded.has(group.id) || !!this.only && this.only !== group.id;
      if (document.activeElement !== input) input.value = this.filters.get(group.id) ?? "";
      const count = card.querySelector<HTMLElement>(".port-filter-count")!;
      count.hidden = !this.expanded.has(group.id);
      count.textContent = `显示 ${members.filter(id => shown.has(id)).length} / ${group.members.length} 个实例`;
    }
    const projected: CardEdge[] = [], seen = new Set<string>();
    const add = (edge: CardEdge) => { const key = JSON.stringify([edge.from, edge.to, edge.control, edge.current, edge.unknown, edge.role]); if (!seen.has(key)) { seen.add(key); projected.push(edge); } };
    for (const edge of edges) {
      const fromGroup = this.groupFor.get(edge.from), toGroup = this.groupFor.get(edge.to);
      const from = fromGroup && activeGroups.has(fromGroup) ? fromGroup : edge.from, to = toGroup && activeGroups.has(toGroup) ? toGroup : edge.to;
      if (!shown.has(from) || !shown.has(to)) continue;
      add({...edge, from, to});
      if (fromGroup && shown.has(edge.from)) add({from: edge.from, to: fromGroup, unknown: edge.unknown, role: "重复实例端口连接汇总"});
      if (toGroup && shown.has(edge.to)) add({from: toGroup, to: edge.to, unknown: edge.unknown, role: "重复实例端口连接汇总"});
    }
    this.shown = shown;
    for (const [id, card] of this.cards) {
      const fold = card.querySelector<HTMLButtonElement>(":scope > .logic-card-head > .port-fold-toggle");
      if (fold) {
        const open = this.expanded.has(id); setIcon(fold.firstElementChild as HTMLElement, open ? "chevron-down" : "chevron-right");
        fold.setAttribute("aria-expanded", String(open)); fold.title = `${open ? "收起" : "展开"} ${this.title(id)}`; fold.setAttribute("aria-label", fold.title); card.classList.toggle("route-pending", !open);
      }
      if (this.nodes.has(id) && shown.has(id) && this.expanded.has(id)) this.hooks.materialize(id);
      const content = card.querySelector<HTMLElement>(":scope > .logic-module-content"); if (content) content.hidden = this.hasSites(id) && !this.expanded.has(id);
    }
    this.updateBar(); return {visible: shown, edges: projected};
  }
  private updateBar(): void {
    this.bar.hidden = !this.nodes.size;
    this.onlyLabel.hidden = this.showAllButton.hidden = !this.only;
    this.onlyLabel.textContent = this.only ? "只看 " + (this.groups.get(this.only)?.name ?? this.only.split("/").at(-1)) : ""; this.onlyLabel.title = this.only ?? "";
    const total = new Set([...this.available].map(id => this.key(id))).size;
    const current = new Set(this.only ? this.targetIds(this.only).filter(id => this.available.has(id)).map(id => this.key(id)) : []).size;
    this.count.textContent = this.only ? `当前范围 ${current} 个实例／全部 ${total} 个` : `${total} 个子模块实例`;
    this.selection.hidden = !this.selected || !!this.only || !this.shown.has(this.selected); this.selectedLabel.textContent = this.selected ? this.title(this.selected) : "";
    const peers = this.peers(), key = peers.join("\n"), index = peers.findIndex(id => this.key(id) === this.only);
    this.switcher.hidden = peers.length < 2;
    if (this.select.dataset.peers !== key) { this.select.replaceChildren(...peers.map(id => { const option = el("option", "", this.title(id)); option.value = id; return option; })); this.select.dataset.peers = key; }
    this.select.value = peers[index] ?? ""; this.select.title = this.only ?? ""; this.position.textContent = `${index + 1} / ${peers.length}`;
    this.previous.disabled = index <= 0; this.next.disabled = index >= peers.length - 1;
    for (const id of [...this.nodes.keys(), ...this.groups.keys()]) {
      const card = this.cards.get(id)!, button = card.querySelector<HTMLButtonElement>(":scope > .logic-card-head > .only-module-toggle")!;
      const active = this.key(id) === this.only; button.setAttribute("aria-pressed", String(active));
      button.title = active ? "取消只看此模块，恢复之前视图" : "只看此模块"; button.setAttribute("aria-label", button.title + " " + this.title(id));
      card.classList.toggle("port-module-selected", id === this.selected);
    }
  }
  stop(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame); this.frame = undefined;
    if (this.body.clientWidth) this.body.scrollTo({left: this.body.scrollLeft, top: this.body.scrollTop, behavior: "auto"});
  }
  follow(id: string, before?: Set<string>): void {
    if (!this.body.clientWidth) return;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined; const card = this.cards.get(id);
      if (!this.active || !card || card.hidden) return;
      const children = (this.groups.get(id)?.members ?? []).filter(id => this.shown.has(id) && (!before || !before.has(id))).map(id => this.cards.get(id)!);
      const bounds = (cards: HTMLElement[]) => ({left: Math.min(...cards.map(c => c.offsetLeft)), right: Math.max(...cards.map(c => c.offsetLeft + c.offsetWidth)), top: Math.min(...cards.map(c => c.offsetTop)), bottom: Math.max(...cards.map(c => c.offsetTop + c.offsetHeight))});
      const all = bounds([card, ...children]), first = bounds([children[0] ?? card]);
      const target = all.right - all.left <= this.body.clientWidth - 32 && all.bottom - all.top <= this.body.clientHeight - 32 ? all : bounds([card, children[0] ?? card]);
      const axis = (start: number, end: number, firstStart: number, firstEnd: number, current: number, size: number) => end - start > size - 32 ? Math.max(0, firstEnd - firstStart > size - 32 ? firstStart - 16 : firstEnd - size + 16) : start < current + 16 ? Math.max(0, start - 16) : end > current + size - 16 ? Math.max(0, end - size + 16) : current;
      this.body.scrollTo({left: axis(target.left, target.right, first.left, first.right, this.body.scrollLeft, this.body.clientWidth), top: axis(target.top, target.bottom, first.top, first.bottom, this.body.scrollTop, this.body.clientHeight), behavior: typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"});
    });
  }
}
