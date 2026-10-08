import { setIcon } from "./icons";
import { activateMenu } from "./menu-keyboard";

export interface RecentMenuCallbacks {
  /** 点击某个最近工程 */
  onPick(path: string): void;
  /** 点行尾移除按钮删除条目 */
  onRemove(path: string): void;
}

/** 「打开文件夹」旁的最近工程下拉菜单。 */
export class RecentMenu {
  private menu: HTMLDivElement | null = null;
  private releaseKeyboard?: () => void;
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
    const anchor = document.querySelector(".open-wrap")?.getBoundingClientRect();
    if (anchor) { menu.style.top = `${anchor.bottom + 4}px`; menu.style.left = `${anchor.left}px`; }
    this.releaseKeyboard = activateMenu(menu, () => this.close(), document.querySelector<HTMLElement>(".recent-btn") ?? undefined);
  }

  close(): void {
    this.releaseKeyboard?.(); this.releaseKeyboard = undefined;
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
      const label = document.createElement("button"); label.type = "button"; label.setAttribute("role", "menuitem"); label.tabIndex = -1;
      label.className = "recent-path";
      label.textContent = path;
      label.title = path;
      label.addEventListener("click", () => {
        this.close();
        this.callbacks.onPick(path);
      });
      const remove = document.createElement("button"); remove.type = "button"; remove.setAttribute("role", "menuitem"); remove.tabIndex = -1;
      remove.className = "recent-remove";
      setIcon(remove, "close");
      remove.title = "从列表移除";
      remove.setAttribute("aria-label", `从最近工程移除 ${path}`);
      remove.addEventListener("click", () => {
        const index = this.items.indexOf(path);
        this.callbacks.onRemove(path);
        (this.menu?.querySelectorAll<HTMLElement>(".recent-path")[Math.max(0, Math.min(index, this.items.length - 1))])?.focus();
        if (!this.items.length) this.close();
      });
      row.append(label, remove);
      this.menu.appendChild(row);
    }
  }
}
