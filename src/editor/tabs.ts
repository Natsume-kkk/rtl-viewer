import { monaco, langForFile } from "./monaco";
import { readFile, writeFile, saveFileDialog, confirmDialog } from "../ipc";

export interface Tab {
  /** 磁盘路径；未命名新文件为空字符串 */
  path: string;
  title: string;
  model: monaco.editor.ITextModel;
  encoding: string;
  dirty: boolean;
  element: HTMLLIElement;
}

export interface TabEvents {
  /** 活动标签变化（含编码、语言，用于状态栏刷新） */
  onActiveChange(): void;
  /** 文件从磁盘读取/写回后回调（用于刷新解析缓存与层级树） */
  onFileReloaded(path: string, content: string): void;
  onFileSaved(path: string, content: string): void;
}

export class TabManager {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private barEl: HTMLElement;
  private events: TabEvents;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private untitledCount = 0;
  /** 打开中的每个标签的视图状态（光标、滚动位置） */
  private viewStates = new Map<monaco.editor.ITextModel, monaco.editor.ICodeEditorViewState | null>();

  constructor(editor: monaco.editor.IStandaloneCodeEditor, barEl: HTMLElement, events: TabEvents) {
    this.editor = editor;
    this.barEl = barEl;
    this.events = events;
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void this.save();
    });
  }

  get activeTab(): Tab | null {
    return this.active;
  }

  findTab(path: string): Tab | undefined {
    return this.tabs.find((t) => t.path === path);
  }

  /** 打开磁盘文件（已打开则聚焦）。dirty 标签不覆盖磁盘内容。 */
  async openFile(path: string, line?: number): Promise<void> {
    const existing = this.findTab(path);
    if (existing) {
      this.activate(existing);
      if (line !== undefined) this.reveal(line);
      return;
    }
    const { content, encoding } = await readFile(path);
    this.createTab(path, basename(path), content, encoding, line);
    this.events.onFileReloaded(path, content);
  }

  /** 已缓存内容的文件直接打开，不再读盘（扫描阶段已读过的场景）。 */
  openContent(path: string, content: string, encoding: string, line?: number): void {
    const existing = this.findTab(path);
    if (existing) {
      this.activate(existing);
      if (line !== undefined) this.reveal(line);
      return;
    }
    this.createTab(path, basename(path), content, encoding, line);
  }

  newFile(): void {
    this.untitledCount += 1;
    this.createTab("", `untitled-${this.untitledCount}`, "", "utf8");
  }

  /** 以指定编码重新读取当前文件并替换内容。 */
  async reopenWithEncoding(encoding: string): Promise<void> {
    const tab = this.active;
    if (!tab) return;
    if (tab.dirty && !(await confirmDialog("当前修改未保存，重新打开将丢弃修改，继续？"))) {
      return;
    }
    if (!tab.path) return; // 未命名文件无盘可读
    try {
      const { content } = await readFile(tab.path, encoding);
      tab.model.setValue(content);
      tab.encoding = encoding;
      tab.dirty = false;
      this.renderTab(tab);
      this.events.onFileReloaded(tab.path, content);
      this.events.onActiveChange();
    } catch (e) {
      await confirmDialog(`重新打开失败：${String(e)}`);
    }
  }

  /** 修改当前标签的保存编码（不动磁盘）。 */
  setSaveEncoding(encoding: string): void {
    const tab = this.active;
    if (!tab) return;
    tab.encoding = encoding;
    this.events.onActiveChange();
  }

  async save(): Promise<boolean> {
    const tab = this.active;
    if (!tab) return false;
    if (!tab.path) return this.saveAs();
    return this.doWrite(tab, tab.path);
  }

  async saveAs(): Promise<boolean> {
    const tab = this.active;
    if (!tab) return false;
    const target = await saveFileDialog(tab.path || undefined);
    if (!target) return false;
    const ok = await this.doWrite(tab, target);
    if (ok && !tab.path) {
      tab.path = target;
      tab.title = basename(target);
      const lang = langForFile(target);
      if (lang !== "plaintext") monaco.editor.setModelLanguage(tab.model, lang);
      this.renderTab(tab);
      this.events.onActiveChange();
    }
    return ok;
  }

  async close(tab: Tab): Promise<void> {
    if (tab.dirty) {
      const ok = await confirmDialog(`「${tab.title}」有未保存的修改，关闭将丢弃，继续？`);
      if (!ok) return;
    }
    const idx = this.tabs.indexOf(tab);
    this.tabs.splice(idx, 1);
    tab.element.remove();
    this.viewStates.delete(tab.model);
    tab.model.dispose();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (next) this.activate(next);
      else {
        this.editor.setModel(null);
        this.events.onActiveChange();
      }
    }
  }

  private async doWrite(tab: Tab, path: string): Promise<boolean> {
    try {
      await writeFile(path, tab.model.getValue(), tab.encoding);
    } catch (e) {
      await confirmDialog(`保存失败：${String(e)}`);
      return false;
    }
    tab.dirty = false;
    this.renderTab(tab);
    this.events.onFileSaved(path, tab.model.getValue());
    return true;
  }

  private createTab(path: string, title: string, content: string, encoding: string, line?: number): void {
    const uri = path
      ? monaco.Uri.parse(`file:///${path}`)
      : monaco.Uri.parse(`inmemory:///${title}`);
    const model = monaco.editor.createModel(content, langForFile(path), uri);
    const tab: Tab = {
      path,
      title,
      model,
      encoding,
      dirty: false,
      element: document.createElement("li"),
    };
    model.onDidChangeContent(() => {
      if (!tab.dirty) {
        tab.dirty = true;
        this.renderTab(tab);
      }
    });
    this.tabs.push(tab);
    this.renderTab(tab);
    tab.element.addEventListener("click", () => this.activate(tab));
    this.barEl.appendChild(tab.element);
    this.activate(tab);
    if (line !== undefined) this.reveal(line);
  }

  private renderTab(tab: Tab): void {
    tab.element.textContent = "";
    tab.element.className = "tab";
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = (tab.dirty ? "*" : "") + tab.title;
    label.title = tab.path || "未保存";
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.close(tab);
    });
    tab.element.append(label, close);
    if (this.active === tab) tab.element.classList.add("active");
  }

  private activate(tab: Tab): void {
    if (this.active === tab) return;
    if (this.active) {
      this.viewStates.set(this.active.model, this.editor.saveViewState());
      this.active.element.classList.remove("active");
    }
    this.active = tab;
    tab.element.classList.add("active");
    this.editor.setModel(tab.model);
    const state = this.viewStates.get(tab.model);
    if (state) this.editor.restoreViewState(state);
    this.editor.focus();
    this.events.onActiveChange();
  }

  private reveal(line: number): void {
    this.editor.revealLineInCenter(line);
    this.editor.setPosition({ lineNumber: line, column: 1 });
    this.editor.focus();
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
