export interface RecentMenuCallbacks {
  /** 点击某个最近工程 */
  onPick(path: string): void;
  /** 点行尾 × 移除条目 */
  onRemove(path: string): void;
}

/** 「打开文件夹」旁的最近工程下拉菜单。 */
export class RecentMenu {
  private menu: HTMLDivElement | null = null;
  private items: string[] = [];
  private anchorEl: HTMLElement;
  private callbacks: RecentMenuCallbacks;

  constructor(anchorEl: HTMLElement, callbacks: RecentMenuCallbacks) {
    this.anchorEl = anchorEl;
    this.callbacks = callbacks;
    document.addEventListener("click", () => this.close());
  }

  setItems(paths: string[]): void {
    this.items = paths;
    if (this.menu) this.renderItems();
  }

  get isOpen(): boolean {
    return this.menu !== null;
  }

  toggle(): void {
    if (this.menu) {
      this.close();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "recent-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    this.menu = menu;
    this.renderItems();
    this.anchorEl.appendChild(menu);
  }

  close(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private renderItems(): void {
    if (!this.menu) return;
    this.menu.textContent = "";
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "menu-title";
      empty.textContent = "暂无最近工程";
      this.menu.appendChild(empty);
      return;
    }
    for (const path of this.items) {
      const row = document.createElement("div");
      row.className = "menu-item recent-item";
      const label = document.createElement("span");
      label.className = "recent-path";
      label.textContent = path;
      label.title = path;
      label.addEventListener("click", () => {
        this.close();
        this.callbacks.onPick(path);
      });
      const remove = document.createElement("span");
      remove.className = "recent-remove";
      remove.textContent = "×";
      remove.title = "从列表移除";
      remove.addEventListener("click", () => {
        this.callbacks.onRemove(path);
      });
      row.append(label, remove);
      this.menu.appendChild(row);
    }
  }
}
