import type { FileMatches, SearchOptions } from "../model/search";
import { buildAllMatcher, countMatches } from "../model/search";

export interface SearchPanelCallbacks {
  /** 查询变化（已去抖）；options 为 Aa/整词/正则开关状态 */
  onSearch(query: string, options: SearchOptions): FileMatches[];
  /** 点击命中行：打开文件并跳转 */
  onOpen(file: string, line: number): void;
  /** 路径转显示用相对路径 */
  displayPath(file: string): string;
}

/** 侧栏全局搜索面板：输入框 + 大小写/整词/正则开关 + 按文件分组的结果列表。 */
export class SearchPanel {
  private rootEl: HTMLElement;
  private input: HTMLInputElement;
  private caseBtn: HTMLButtonElement;
  private wordBtn: HTMLButtonElement;
  private regexBtn: HTMLButtonElement;
  private countEl: HTMLElement;
  private resultsEl: HTMLElement;
  private callbacks: SearchPanelCallbacks;
  private options: SearchOptions = {};
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
    this.caseBtn = this.toggleButton("Aa", "区分大小写", "caseSensitive");
    this.wordBtn = this.toggleButton("词", "整词匹配", "wholeWord");
    this.regexBtn = this.toggleButton(".*", "正则表达式", "useRegex");
    bar.append(this.input, this.caseBtn, this.wordBtn, this.regexBtn);

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
  }

  private toggleButton(
    text: string,
    title: string,
    key: "caseSensitive" | "wholeWord" | "useRegex",
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "search-case";
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener("click", () => {
      this.options[key] = !this.options[key];
      btn.classList.toggle("on", !!this.options[key]);
      this.run();
    });
    return btn;
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
    if (this.options.useRegex) {
      try {
        new RegExp(query);
      } catch {
        this.countEl.textContent = "正则表达式无效";
        return;
      }
    }
    const results = this.callbacks.onSearch(query, { ...this.options });
    const total = countMatches(results);
    this.countEl.textContent =
      total === 0 ? "无结果" : `${total} 个结果，${results.length} 个文件${total >= 500 ? "（已截断）" : ""}`;
    const highlighter = buildAllMatcher(query, this.options);
    for (const group of results) {
      this.resultsEl.appendChild(this.renderGroup(group, highlighter));
    }
  }

  private renderGroup(group: FileMatches, highlighter: (line: string) => { index: number; length: number }[]): HTMLElement {
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
      row.appendChild(this.highlight(m.text, highlighter));
      row.addEventListener("click", () => this.callbacks.onOpen(group.file, m.line));
      box.appendChild(row);
    }
    return box;
  }

  /** 命中高亮：按与搜索相同的语义标记全部命中（正则/整词/大小写一致）。 */
  private highlight(
    text: string,
    highlighter: (line: string) => { index: number; length: number }[],
  ): HTMLElement {
    const span = document.createElement("span");
    span.className = "search-text";
    let pos = 0;
    for (const hit of highlighter(text)) {
      if (hit.index < pos) continue;
      span.appendChild(document.createTextNode(text.slice(pos, hit.index)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(hit.index, hit.index + hit.length);
      span.appendChild(mark);
      pos = hit.index + hit.length;
    }
    span.appendChild(document.createTextNode(text.slice(pos)));
    return span;
  }
}
