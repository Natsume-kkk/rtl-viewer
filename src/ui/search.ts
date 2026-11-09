import type { FileMatches, SearchOptions } from "../model/search";
import { countMatches, type MatchHit } from "../model/search";
import { setIcon } from "./icons";

export interface SearchPanelCallbacks {
  /** 查询变化（已去抖）；options 为 Aa/整词/正则开关状态 */
  onSearch(query: string, options: SearchOptions): FileMatches[] | Promise<FileMatches[]>;
  onCancel?(): void;
  /** 点击命中行：打开文件并跳转 */
  onOpen(file: string, line: number, column: number, length: number): void;
  /** 路径转显示用相对路径 */
  displayPath(file: string): string;
  onFocus?(): void;
  onClose?(): void;
}

/** 独立搜索面板，不负责工程树或编辑器的可见状态。 */
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
  private stale: HTMLButtonElement;
  private hasRun = false;
  private request = 0;
  private pending = false;
  private scope: HTMLElement;

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
    const label = document.createElement("span"); label.className = "search-heading"; label.textContent = "搜索";
    const close = document.createElement("button"); close.className = "icon-button"; close.setAttribute("aria-label", "收起搜索"); close.title = "收起搜索（保留结果）"; setIcon(close, "close"); close.onclick = () => this.callbacks.onClose?.();
    this.input.setAttribute("aria-label", "全工程搜索");
    bar.append(label, this.input, this.caseBtn, this.wordBtn, this.regexBtn, close);

    this.countEl = document.createElement("div");
    this.countEl.className = "search-count";
    this.countEl.setAttribute("role", "status");
    this.scope = document.createElement("p");
    this.scope.className = "search-scope";
    this.updateScope();
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "search-results";

    this.stale = document.createElement("button"); this.stale.className = "text-button result-stale";
    this.stale.textContent = "源码已变化，刷新搜索结果"; this.stale.hidden = true; this.stale.onclick = () => this.run();
    this.rootEl.append(bar, this.scope, this.stale, this.countEl, this.resultsEl);

    this.input.addEventListener("input", () => {
      this.cancel();
      this.debounceTimer = window.setTimeout(() => this.run(), 250);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        window.clearTimeout(this.debounceTimer);
        this.run();
      } else if (e.key === "Escape") {
        this.callbacks.onClose?.();
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
    btn.setAttribute("aria-label", title);
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      this.options[key] = !this.options[key];
      btn.classList.toggle("on", !!this.options[key]);
      btn.setAttribute("aria-pressed", String(!!this.options[key]));
      this.run();
    });
    return btn;
  }

  /** 聚焦输入框并全选（Ctrl+Shift+F）。 */
  focus(): void {
    this.callbacks.onFocus?.();
    this.input.focus();
    this.input.select();
  }

  /** 查找同名文本：填入查询、强制整词匹配，立即执行并聚焦面板。 */
  searchAll(query: string, caseSensitive = true): void {
    this.input.value = query;
    this.options = { wholeWord: true, useRegex: false, caseSensitive };
    this.wordBtn.classList.add("on");
    this.regexBtn.classList.remove("on");
    this.caseBtn.classList.toggle("on", caseSensitive);
    this.wordBtn.setAttribute("aria-pressed", "true");
    this.regexBtn.setAttribute("aria-pressed", "false");
    this.caseBtn.setAttribute("aria-pressed", String(caseSensitive));
    this.run();
    this.focus();
  }

  clear(): void {
    this.cancel();
    this.hasRun = false; this.stale.hidden = true;
    this.input.value = "";
    this.resultsEl.textContent = "";
    this.countEl.textContent = "";
  }

  cancel(): void {
    window.clearTimeout(this.debounceTimer);
    ++this.request;
    this.callbacks.onCancel?.();
    if (this.pending) this.countEl.textContent = "搜索已取消";
    this.pending = false;
  }

  async run(): Promise<void> {
    this.cancel();
    this.updateScope();
    const request = this.request;
    this.hasRun = true; this.stale.hidden = true;
    const query = this.input.value;
    this.resultsEl.textContent = "";
    if (!query) {
      this.countEl.textContent = "";
      return;
    }
    this.pending = true;
    this.countEl.textContent = "搜索中…";
    let results: FileMatches[];
    try { results = await this.callbacks.onSearch(query, { ...this.options }); }
    catch (error) {
      if (request === this.request) {
        this.pending = false;
        this.countEl.textContent = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (request !== this.request) return;
    this.pending = false;
    const total = countMatches(results);
    this.countEl.textContent =
      total === 0 ? "无结果：请检查名称、大小写和文件是否已纳入工程；不包含工程外及被排除文件。" : `${total} 个命中行，${results.length} 个文件${total >= 500 ? "（已截断）" : ""}`;
    for (const group of results) {
      this.resultsEl.appendChild(this.renderGroup(group));
    }
  }

  markStale(): void {
    if (this.hasRun && this.input.value) this.stale.hidden = false;
  }

  private updateScope(): void {
    const matching = this.options.useRegex ? "正则文本匹配" : this.options.wholeWord ? "整词文本匹配" : "文本匹配";
    this.scope.textContent = `${matching}，不代表语义引用 · 已纳入工程的文件 · 含未保存内容`;
  }

  private renderGroup(group: FileMatches): HTMLElement {
    const box = document.createElement("div");
    box.className = "search-group";
    const head = document.createElement("button");
    head.className = "search-file";
    head.textContent = `${this.callbacks.displayPath(group.file)} (${group.matches.length})`;
    head.title = group.file;
    head.addEventListener("click", () =>
      this.callbacks.onOpen(group.file, group.matches[0].line, group.matches[0].column, group.matches[0].length),
    );
    box.appendChild(head);
    let shown = 0;
    let loadMore: HTMLButtonElement | undefined;
    const appendBatch = () => {
      const end = Math.min(shown + 100, group.matches.length);
      for (const m of group.matches.slice(shown, end)) {
        const row = document.createElement("button");
        row.className = "search-match";
        const lineNo = document.createElement("span");
        lineNo.className = "search-line-no";
        lineNo.textContent = String(m.line);
        row.appendChild(lineNo);
        row.appendChild(this.highlight(m.text, m.highlights ?? []));
        row.addEventListener("click", () => this.callbacks.onOpen(group.file, m.line, m.column, m.length));
        box.insertBefore(row, loadMore ?? null);
      }
      shown = end;
      loadMore?.remove();
      const remaining = group.matches.length - shown;
      if (!remaining) return;
      loadMore = document.createElement("button");
      loadMore.className = "search-file search-load-more";
      loadMore.textContent = `继续加载此文件结果（剩余 ${remaining} 条）`;
      loadMore.addEventListener("click", appendBatch);
      box.appendChild(loadMore);
    };
    appendBatch();
    return box;
  }

  /** 命中高亮：按与搜索相同的语义标记全部命中（正则/整词/大小写一致）。 */
  private highlight(
    text: string,
    highlights: MatchHit[],
  ): HTMLElement {
    const span = document.createElement("span");
    span.className = "search-text";
    let pos = 0;
    for (const hit of highlights) {
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
