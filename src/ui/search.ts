import type { FileMatches } from "../model/search";
import { countMatches } from "../model/search";

export interface SearchPanelCallbacks {
  /** 查询变化（已去抖）；caseSensitive 为 Aa 开关状态 */
  onSearch(query: string, caseSensitive: boolean): FileMatches[];
  /** 点击命中行：打开文件并跳转 */
  onOpen(file: string, line: number): void;
  /** 路径转显示用相对路径 */
  displayPath(file: string): string;
}

/** 侧栏全局搜索面板：输入框 + 大小写开关 + 按文件分组的结果列表。 */
export class SearchPanel {
  private rootEl: HTMLElement;
  private input: HTMLInputElement;
  private caseBtn: HTMLButtonElement;
  private countEl: HTMLElement;
  private resultsEl: HTMLElement;
  private callbacks: SearchPanelCallbacks;
  private caseSensitive = false;
  private debounceTimer: number | undefined;

  constructor(rootEl: HTMLElement, callbacks: SearchPanelCallbacks) {
    this.rootEl = rootEl;
    this.callbacks = callbacks;
    this.rootEl.className = "search-panel";

    const bar = document.createElement("div");
    bar.className = "search-bar";
    this.input = document.createElement("input");
    this.input.className = "search-input";
    this.input.placeholder = "全工程搜索 (Ctrl+Shift+F)";
    this.input.spellcheck = false;
    this.caseBtn = document.createElement("button");
    this.caseBtn.className = "search-case";
    this.caseBtn.textContent = "Aa";
    this.caseBtn.title = "区分大小写";
    bar.append(this.input, this.caseBtn);

    this.countEl = document.createElement("div");
    this.countEl.className = "search-count";
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "search-results";

    this.rootEl.append(bar, this.countEl, this.resultsEl);

    this.input.addEventListener("input", () => {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => this.run(), 250);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        window.clearTimeout(this.debounceTimer);
        this.run();
      } else if (e.key === "Escape") {
        this.clear();
      }
    });
    this.caseBtn.addEventListener("click", () => {
      this.caseSensitive = !this.caseSensitive;
      this.caseBtn.classList.toggle("on", this.caseSensitive);
      this.run();
    });
  }

  /** 聚焦输入框并全选（Ctrl+Shift+F）。 */
  focus(): void {
    this.input.focus();
    this.input.select();
  }

  clear(): void {
    this.input.value = "";
    this.resultsEl.textContent = "";
    this.countEl.textContent = "";
  }

  run(): void {
    const query = this.input.value;
    this.resultsEl.textContent = "";
    if (!query) {
      this.countEl.textContent = "";
      return;
    }
    const results = this.callbacks.onSearch(query, this.caseSensitive);
    const total = countMatches(results);
    this.countEl.textContent =
      total === 0 ? "无结果" : `${total} 个结果，${results.length} 个文件${total >= 500 ? "（已截断）" : ""}`;
    const q = this.caseSensitive ? query : query.toLowerCase();
    for (const group of results) {
      this.resultsEl.appendChild(this.renderGroup(group, q));
    }
  }

  private renderGroup(group: FileMatches, queryLower: string): HTMLElement {
    const box = document.createElement("div");
    box.className = "search-group";
    const head = document.createElement("div");
    head.className = "search-file";
    head.textContent = `${this.callbacks.displayPath(group.file)} (${group.matches.length})`;
    head.title = group.file;
    head.addEventListener("click", () =>
      this.callbacks.onOpen(group.file, group.matches[0].line),
    );
    box.appendChild(head);
    for (const m of group.matches) {
      const row = document.createElement("div");
      row.className = "search-match";
      const lineNo = document.createElement("span");
      lineNo.className = "search-line-no";
      lineNo.textContent = String(m.line);
      row.appendChild(lineNo);
      row.appendChild(this.highlight(m.text, queryLower));
      row.addEventListener("click", () => this.callbacks.onOpen(group.file, m.line));
      box.appendChild(row);
    }
    return box;
  }

  /** 命中子串高亮（大小写不敏感时按小写定位，保留原文）。 */
  private highlight(text: string, queryLower: string): HTMLElement {
    const span = document.createElement("span");
    span.className = "search-text";
    const hay = this.caseSensitive ? text : text.toLowerCase();
    let pos = 0;
    let idx = hay.indexOf(queryLower);
    while (idx >= 0 && queryLower.length > 0) {
      span.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(idx, idx + queryLower.length);
      span.appendChild(mark);
      pos = idx + queryLower.length;
      idx = hay.indexOf(queryLower, pos);
    }
    span.appendChild(document.createTextNode(text.slice(pos)));
    return span;
  }
}
