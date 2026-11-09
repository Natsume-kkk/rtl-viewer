import type { OutlineItem } from "../model/outline";
import { OUTLINE_KIND_LABELS } from "../model/outline";
import { setIcon } from "./icons";

export interface OutlineCallbacks {
  /** 点击大纲项：跳转当前文件指定行 */
  onJump(line: number): void;
  /** 点击「符号」按钮：弹出可模糊过滤的符号列表（同 Ctrl+Shift+O） */
  onOpenSymbols?(): void;
}

const LS_COLLAPSED = "rtl.outlineCollapsed";
const LS_HEIGHT = "rtl.outlineHeight";

/** 侧栏大纲视图：展示当前文件的模块/信号/进程/例化等符号，顶部过滤框键入即筛，点击跳行。 */
export class OutlineView {
  private rootEl: HTMLElement;
  private resizerEl: HTMLDivElement;
  private listEl: HTMLElement;
  private filterEl: HTMLInputElement;
  private toggleEl: HTMLButtonElement;
  private fileEl: HTMLElement;
  private callbacks: OutlineCallbacks;
  private items: OutlineItem[] = [];
  private fileName = "";

  constructor(rootEl: HTMLElement, callbacks: OutlineCallbacks) {
    this.rootEl = rootEl;
    this.callbacks = callbacks;
    this.rootEl.className = "outline";

    // 顶部拖拽调高
    this.resizerEl = document.createElement("div");
    this.resizerEl.className = "outline-resizer";
    this.resizerEl.title = "拖拽调整大纲高度；方向键微调，Home 恢复默认";
    this.resizerEl.tabIndex = 0;
    this.resizerEl.setAttribute("role", "separator");
    this.resizerEl.setAttribute("aria-label", "调整大纲高度");
    this.resizerEl.setAttribute("aria-orientation", "horizontal");
    this.resizerEl.setAttribute("aria-controls", rootEl.id);
    this.resizerEl.setAttribute("aria-valuemin", "100");
    this.initResizer();
    this.rootEl.appendChild(this.resizerEl);

    const head = document.createElement("div");
    head.className = "outline-head";

    this.toggleEl = document.createElement("button");
    this.toggleEl.className = "outline-toggle";
    this.toggleEl.title = "折叠/展开大纲";
    this.toggleEl.setAttribute("aria-label", "折叠/展开大纲");
    this.toggleEl.addEventListener("click", () => this.toggleCollapse());

    const label = document.createElement("span");
    label.textContent = "当前文件大纲";

    this.filterEl = document.createElement("input");
    this.filterEl.className = "outline-filter";
    this.filterEl.placeholder = "过滤…";
    this.filterEl.setAttribute("aria-label", "过滤当前文件大纲");
    this.filterEl.addEventListener("input", () => this.renderList());

    const symbolsBtn = document.createElement("button");
    symbolsBtn.className = "outline-symbols";
    setIcon(symbolsBtn, "outline");
    symbolsBtn.title = "符号搜索 (Ctrl+Shift+O)";
    symbolsBtn.setAttribute("aria-label", "符号搜索");
    symbolsBtn.addEventListener("click", () => this.callbacks.onOpenSymbols?.());

    head.append(this.toggleEl, label, this.filterEl, symbolsBtn);
    this.listEl = document.createElement("div");
    this.listEl.className = "outline-list";
    this.fileEl = document.createElement("div");
    this.fileEl.className = "outline-file";
    this.rootEl.append(head, this.fileEl, this.listEl);

    // 恢复折叠状态与高度
    if (localStorage.getItem(LS_COLLAPSED) === "1") this.setCollapsed(true);
    else this.setCollapsed(false);
    const savedHeight = Number(localStorage.getItem(LS_HEIGHT));
    if (savedHeight > 0) this.applyHeight(savedHeight);

    this.render([], "");
  }

  private setCollapsed(collapsed: boolean): void {
    this.rootEl.classList.toggle("collapsed", collapsed);
    setIcon(this.toggleEl, collapsed ? "chevron-right" : "chevron-down");
    this.toggleEl.setAttribute("aria-expanded", String(!collapsed));
    localStorage.setItem(LS_COLLAPSED, collapsed ? "1" : "0");
    this.activeLine = undefined;
    if (collapsed) this.listEl.textContent = "";
    else this.renderList();
  }

  private toggleCollapse(): void {
    this.setCollapsed(!this.rootEl.classList.contains("collapsed"));
  }

  private applyHeight(px: number): void {
    const max = window.innerHeight * 0.6;
    const height = Math.min(Math.max(px, 100), max);
    this.rootEl.style.height = `${height}px`;
    this.resizerEl.setAttribute("aria-valuemax", String(Math.round(max)));
    this.resizerEl.setAttribute("aria-valuenow", String(Math.round(height)));
  }

  private initResizer(): void {
    this.resizerEl.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      const current = Number.parseFloat(this.rootEl.style.height) || this.rootEl.clientHeight;
      const preferred = event.key === "Home" ? this.rootEl.parentElement!.clientHeight * 0.32 : current + (event.key === "ArrowUp" ? 24 : -24);
      this.applyHeight(preferred);
      localStorage.setItem(LS_HEIGHT, this.rootEl.style.height.replace("px", ""));
    });
    this.resizerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const onMove = (ev: MouseEvent) => {
        // 大纲在侧栏底部：从视口底端向上量，扣除状态栏
        const statusH = document.getElementById("statusbar")?.offsetHeight ?? 22;
        this.applyHeight(window.innerHeight - ev.clientY - statusH);
      };
      const onUp = (ev: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const statusH = document.getElementById("statusbar")?.offsetHeight ?? 22;
        localStorage.setItem(LS_HEIGHT, String(window.innerHeight - ev.clientY - statusH));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  /** 刷新大纲；fileName 仅用于空态提示。 */
  render(items: OutlineItem[], fileName: string): void {
    this.items = items;
    this.fileName = fileName;
    this.fileEl.textContent = fileName;
    this.fileEl.title = fileName;
    this.activeLine = undefined;
    this.renderList();
  }

  private activeLine: number | undefined;
  private visibleCount = 200;

  /** 光标跟随：高亮最后一个起点不晚于 line 的条目；条目无变化时不动 DOM。 */
  highlightLine(line: number): void {
    if (this.rootEl.classList.contains("collapsed")) return;
    let idx = -1;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].line > line) break;
      idx = i;
    }
    const itemLine = idx >= 0 ? this.items[idx].line : undefined;
    if (itemLine === this.activeLine) return;
    this.activeLine = itemLine;
    if (idx >= this.visibleCount) {
      this.visibleCount = idx + 1;
      this.renderList(false);
    }
    this.listEl
      .querySelectorAll(".outline-row.active")
      .forEach((el) => el.classList.remove("active"));
    if (itemLine === undefined) return;
    const row = this.listEl.querySelector<HTMLElement>(`.outline-row[data-line="${itemLine}"]`);
    row?.classList.add("active");
    row?.scrollIntoView?.({ block: "nearest" });
  }

  private renderList(resetLimit = true): void {
    if (resetLimit) this.visibleCount = 200;
    if (this.rootEl.classList.contains("collapsed")) {
      this.listEl.textContent = "";
      return;
    }
    this.listEl.querySelector(".outline-load-more")?.remove();
    this.listEl.querySelector(".outline-empty")?.remove();
    if (!this.fileName) {
      this.listEl.textContent = "";
      this.renderEmpty("未打开文件");
      return;
    }
    const filter = this.filterEl.value.trim().toLowerCase();
    const shown = filter
      ? this.items.filter((i) => i.name.toLowerCase().includes(filter))
      : this.items;
    if (shown.length === 0) {
      this.listEl.textContent = "";
      this.renderEmpty(this.items.length === 0 ? "无可识别符号" : "无匹配项");
      return;
    }
    const previousRows = [...this.listEl.children].filter((child): child is HTMLButtonElement => child.classList.contains("outline-row"));
    const available = new Map<string, HTMLButtonElement[]>();
    for (const row of previousRows) {
      const matches = available.get(row.dataset.outlineKey!) ?? [];
      matches.push(row);
      available.set(row.dataset.outlineKey!, matches);
    }
    const retained = new Set<HTMLButtonElement>();
    let reference = this.listEl.firstChild;
    for (const item of shown.slice(0, this.visibleCount)) {
      const key = `${item.kind}|${item.name}|${item.line}`;
      let row = available.get(key)?.shift();
      if (!row) {
        row = document.createElement("button");
        row.className = `outline-row outline-kind-${item.kind}`;
        row.dataset.outlineKey = key;
        row.dataset.line = String(item.line);
        row.title = `${item.name}，第 ${item.line} 行`;
        const kind = document.createElement("span");
        kind.className = "outline-kind";
        kind.textContent = OUTLINE_KIND_LABELS[item.kind];
        const name = document.createElement("span");
        name.className = "outline-name";
        name.textContent = item.name;
        const line = document.createElement("span");
        line.className = "outline-line";
        line.textContent = String(item.line);
        row.append(kind, name, line);
        row.addEventListener("click", () => this.callbacks.onJump(item.line));
      }
      retained.add(row);
      if (row === reference) reference = reference.nextSibling;
      else this.listEl.insertBefore(row, reference);
    }
    for (const row of previousRows) if (!retained.has(row)) row.remove();
    const remaining = shown.length - Math.min(this.visibleCount, shown.length);
    if (remaining > 0) {
      const loadMore = document.createElement("button");
      loadMore.className = "outline-load-more btn btn-ghost btn-inline";
      loadMore.textContent = `继续加载（剩余 ${remaining} 项）`;
      loadMore.addEventListener("click", () => {
        this.visibleCount += 200;
        this.renderList(false);
      });
      this.listEl.appendChild(loadMore);
    }
  }

  private renderEmpty(text: string): void {
    const empty = document.createElement("div");
    empty.className = "outline-empty";
    empty.textContent = text;
    this.listEl.appendChild(empty);
  }
}
