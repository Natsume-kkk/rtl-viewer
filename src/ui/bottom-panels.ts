type Panel = "search" | "flow";

/** 只管理面板可见性和空间，不重建搜索或追踪视图。 */
export class BottomPanels {
  private active: Panel | undefined;
  private opened = new Set<Panel>();
  private together = false;
  private preferredHeight = 300;
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
      this.preferredHeight = event.key === "Home" ? 300 : root.clientHeight + (event.key === "ArrowUp" ? 24 : -24);
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
    for (const [id, label] of [["search", "搜索"], ["flow", "信号链"]] as const) {
      const button = document.createElement("button");
      button.textContent = label;
      button.setAttribute("aria-controls", panels[id].id);
      button.onclick = () => this.show(id);
      this.buttons.set(id, button);
      bar.append(button);
    }
    this.hint = document.createElement("span");
    this.hint.className = "bottom-panel-hint";
    this.hint.setAttribute("role", "status");
    this.simultaneous = document.createElement("button");
    this.simultaneous.textContent = "同时查看";
    this.simultaneous.onclick = () => {
      this.together = !this.together;
      if (this.together) { this.opened.add("search"); this.opened.add("flow"); }
      this.render();
    };
    bar.append(this.hint, this.simultaneous);
    root.prepend(this.resize, bar);
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(root.parentElement!);
    window.addEventListener("pagehide", this.onPageHide, { once: true });
  }

  show(panel: Panel): void {
    this.active = panel;
    this.opened.add(panel);
    this.render();
  }

  hide(panel: Panel): void {
    this.opened.delete(panel);
    if (this.active === panel) this.active = this.opened.values().next().value;
    this.render();
  }

  isVisible(panel: Panel): boolean { return !this.panels[panel].hidden; }

  private render(): void {
    const available = this.root.parentElement!.clientHeight;
    // 常规窗口保留 320 px 编辑区（标签／路径栏之外约 10 行源码），小窗口保留至少一半空间。
    const maximum = Math.max(0, available - Math.min(320, available * 0.55));
    const canShare = maximum >= 364; // 共用工具栏 44 px + 每个面板至少 160 px。
    const shared = this.together && this.opened.size === 2 && canShare;
    const minimum = Math.min(shared ? 364 : 180, maximum);
    const height = Math.max(minimum, Math.min(this.preferredHeight, maximum));
    this.root.hidden = !this.active;
    this.root.style.height = `${height}px`;
    this.root.classList.toggle("panels-together", shared);
    this.resize.setAttribute("aria-valuemin", String(Math.round(minimum)));
    this.resize.setAttribute("aria-valuemax", String(Math.round(maximum)));
    this.resize.setAttribute("aria-valuenow", String(Math.round(height)));
    this.simultaneous.setAttribute("aria-pressed", String(this.together));
    this.hint.textContent = this.together && this.opened.size === 2 && !canShare ? "高度不足，暂用切换" : "";
    for (const [id, button] of this.buttons) {
      const visible = !!this.active && (id === this.active || shared);
      const panel = this.panels[id];
      const hadFocus = !visible && panel.contains(document.activeElement);
      panel.hidden = !visible;
      button.setAttribute("aria-pressed", String(visible));
      if (hadFocus && this.active) this.buttons.get(this.active)!.focus();
    }
    this.changed();
  }

  dispose(): void {
    this.endDrag?.();
    this.observer.disconnect();
    this.resize.onkeydown = this.resize.onpointerdown = null;
    this.buttons.forEach(button => { button.onclick = null; });
    this.simultaneous.onclick = null;
    window.removeEventListener("pagehide", this.onPageHide);
  }
}
