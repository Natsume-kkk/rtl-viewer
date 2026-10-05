import type { OutlineItem } from "../model/outline";
import { OUTLINE_KIND_LABELS } from "../model/outline";

export interface OutlineCallbacks {
  /** 点击大纲项：跳转当前文件指定行 */
  onJump(line: number): void;
}

/** 侧栏大纲视图：展示当前文件的模块/信号/进程等符号，点击跳行。 */
export class OutlineView {
  private rootEl: HTMLElement;
  private listEl: HTMLElement;
  private callbacks: OutlineCallbacks;

  constructor(rootEl: HTMLElement, callbacks: OutlineCallbacks) {
    this.rootEl = rootEl;
    this.callbacks = callbacks;
    this.rootEl.className = "outline";

    const head = document.createElement("div");
    head.className = "outline-head";
    head.textContent = "大纲";
    this.listEl = document.createElement("div");
    this.listEl.className = "outline-list";
    this.rootEl.append(head, this.listEl);
    this.render([], "");
  }

  /** 刷新大纲；fileName 仅用于空态提示。 */
  render(items: OutlineItem[], fileName: string): void {
    this.listEl.textContent = "";
    if (!fileName) {
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "未打开文件";
      this.listEl.appendChild(empty);
      return;
    }
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "无可识别符号";
      this.listEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = `outline-row outline-kind-${item.kind}`;
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
      this.listEl.appendChild(row);
    }
  }
}
