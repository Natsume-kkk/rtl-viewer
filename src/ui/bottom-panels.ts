import { setIcon } from "./icons";

type Panel = "search" | "flow" | "problems" | "stats";
const DEFAULT_HEIGHT = 380;

/** 只管理面板可见性和空间，不重建搜索或追踪视图。 */
export class BottomPanels {
  private active: Panel | undefined;
  private opened = new Set<Panel>();
  private together = false;
  private companion?: Panel;
  private preferredHeight = DEFAULT_HEIGHT;
  private expanded = false;
  private expand: HTMLButtonElement;
  private header: HTMLElement;
  private flowHeader?: HTMLElement;
  private observer: ResizeObserver;
  private resize: HTMLElement;
  private buttons = new Map<Panel, HTMLButtonElement>();
  private simultaneous: HTMLButtonElement;
  private hint: HTMLElement;
  private endDrag?: () => void;
  private onPageHide = () => this.dispose();

  constructor(private root: HTMLElement, private panels: Record<Panel, HTMLElement>, private changed: () => void) {
    this.resize = document.createElement("div");
    this.resize.className = "panel-resize";
    this.resize.tabIndex = 0;
    this.resize.setAttribute("role", "separator");
    this.resize.setAttribute("aria-label", "调整底部面板高度");
    this.resize.setAttribute("aria-orientation", "horizontal");
    this.resize.setAttribute("aria-controls", root.id);
    this.resize.onkeydown = event => {
      if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      this.preferredHeight = event.key === "Home" ? DEFAULT_HEIGHT : root.clientHeight + (event.key === "ArrowUp" ? 24 : -24);
      this.render();
    };
    this.resize.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.endDrag?.();
      this.resize.setPointerCapture(event.pointerId);
      const start = root.clientHeight, y = event.clientY;
      const move = (next: PointerEvent) => { this.preferredHeight = start + y - next.clientY; this.render(); };
      const end = () => {
        this.resize.removeEventListener("pointermove", move);
        this.resize.removeEventListener("pointerup", end);
        this.resize.removeEventListener("pointercancel", end);
        this.resize.removeEventListener("lostpointercapture", end);
        if (this.resize.hasPointerCapture(event.pointerId)) this.resize.releasePointerCapture(event.pointerId);
        this.endDrag = undefined;
      };
      this.endDrag = end;
      this.resize.addEventListener("pointermove", move);
      this.resize.addEventListener("pointerup", end);
      this.resize.addEventListener("pointercancel", end);
      this.resize.addEventListener("lostpointercapture", end);
    };
    const bar = document.createElement("div");
    bar.className = "bottom-panel-bar";
    for (const [id, label] of [["search", "搜索"], ["flow", "信号链"], ["problems", "问题"], ["stats", "统计"]] as const) {
      const button = document.createElement("button");
      button.textContent = label;
      button.setAttribute("aria-controls", panels[id].id);
      button.onclick = () => this.show(id);
      this.buttons.set(id, button);
      bar.append(button);
    }
    this.header = document.createElement("div");
    this.header.className = "bottom-panel-header";
    bar.append(this.header);
    this.hint = document.createElement("span");
    this.hint.className = "bottom-panel-hint";
    this.hint.setAttribute("role", "status");
    this.simultaneous = document.createElement("button");
    this.simultaneous.textContent = "同时查看";
    this.simultaneous.onclick = () => {
      this.together = !this.together;
      if (this.together) {
        this.companion = this.active === "search" ? "flow" : this.active === "flow" ? "search" : this.active === "problems" ? "stats" : "problems";
        if (this.companion) this.opened.add(this.companion);
      } else this.companion = undefined;
      this.render();
    };
    this.expand = document.createElement("button");
    this.expand.className = "icon-button";
    this.expand.onclick = () => {
      this.expanded = !this.expanded;
      this.render();
    };
    bar.append(this.hint, this.simultaneous, this.expand);
    root.prepend(this.resize, bar);
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(root.parentElement!);
    window.addEventListener("pagehide", this.onPageHide, { once: true });
  }

  show(panel: Panel): void {
    if (this.together && this.active && this.active !== panel) this.companion = this.active;
    this.active = panel;
    this.opened.add(panel);
    if (this.together && this.companion) this.opened.add(this.companion);
    this.render();
  }

  hide(panel: Panel): void {
    this.opened.delete(panel);
    if (this.active === panel || this.companion === panel) {
      this.together = false;
      this.companion = undefined;
    }
    if (this.active === panel) this.active = this.opened.values().next().value;
    this.render();
  }

  isVisible(panel: Panel): boolean { return !this.panels[panel].hidden; }

  /** 沿用信号面板原有控件和事件，只把标题与操作放进共用栏。 */
  attachFlowHeader(header: HTMLElement): void {
    this.flowHeader = header;
    this.header.append(header);
    this.render();
  }

  restoreEditor(): void {
    if (!this.expanded) return;
    this.expanded = false;
    this.render();
  }

  private render(): void {
    const available = this.root.parentElement!.clientHeight;
    // 常规窗口保留 320 px 编辑区（标签／路径栏之外约 10 行源码），小窗口保留至少一半空间。
    const maximum = Math.max(0, available - Math.min(320, available * 0.55));
    const canShare = this.root.parentElement!.clientWidth >= 860 && (this.expanded ? available : maximum) >= 300;
    const shared = this.together && !!this.active && !!this.companion && this.active !== this.companion && this.opened.has(this.active) && this.opened.has(this.companion) && canShare;
    const minimum = Math.min(shared ? 300 : 180, maximum);
    if (!this.active) this.expanded = false;
    const height = this.expanded ? available : Math.max(minimum, Math.min(this.preferredHeight, maximum));
    this.root.hidden = !this.active;
    this.root.style.height = `${height}px`;
    this.root.classList.toggle("panels-together", shared);
    this.root.parentElement!.classList.toggle("panels-expanded", this.expanded);
    this.resize.hidden = this.expanded;
    const expandLabel = this.expanded ? "恢复源码与面板" : "展开底部面板";
    this.expand.title = expandLabel;
    this.expand.setAttribute("aria-label", expandLabel);
    this.expand.setAttribute("aria-pressed", String(this.expanded));
    setIcon(this.expand, this.expanded ? "restore" : "maximize");
    this.resize.setAttribute("aria-valuemin", String(Math.round(minimum)));
    this.resize.setAttribute("aria-valuemax", String(Math.round(maximum)));
    this.resize.setAttribute("aria-valuenow", String(Math.round(height)));
    this.simultaneous.setAttribute("aria-pressed", String(shared));
    this.simultaneous.disabled = !this.active || (!canShare && !this.together);
    this.simultaneous.title = canShare && this.companion ? `左右并列查看${this.buttons.get(this.companion)?.textContent ?? "两个面板"}` : "空间不足，暂用切换；放大窗口后可同时查看";
    this.hint.textContent = this.together && this.companion && !canShare ? "空间不足，暂用切换" : "";
    this.hint.hidden = !this.hint.textContent;
    for (const [id, button] of this.buttons) {
      const visible = !!this.active && (id === this.active || shared && id === this.companion);
      const panel = this.panels[id];
      const hadFocus = !visible && (panel.contains(document.activeElement) || id === "flow" && this.header.contains(document.activeElement));
      panel.hidden = !visible;
      button.setAttribute("aria-pressed", String(visible));
      if (hadFocus && this.active) this.buttons.get(this.active)!.focus();
    }
    this.header.hidden = this.panels.flow.hidden;
    this.changed();
  }

  dispose(): void {
    this.endDrag?.();
    this.observer.disconnect();
    this.resize.onkeydown = this.resize.onpointerdown = null;
    this.buttons.forEach(button => { button.onclick = null; });
    this.simultaneous.onclick = null;
    this.expand.onclick = null;
    this.root.parentElement!.classList.remove("panels-expanded");
    if (this.flowHeader) this.panels.flow.prepend(this.flowHeader);
    window.removeEventListener("pagehide", this.onPageHide);
  }
}
