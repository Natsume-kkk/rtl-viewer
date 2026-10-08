import { monaco, langForFile } from "./monaco";
import { readFile, writeFile, saveFileDialog, fileStates, showInFolder } from "../ipc";
import { appAlert, appConfirm, choiceDialog } from "../ui/dialog";
import { setIcon } from "../ui/icons";
import { filePathMenuItems, showCtxMenu, type MenuItem } from "../ui/menu";

export interface Tab {
  /** 磁盘路径；未命名新文件为空字符串 */
  path: string;
  title: string;
  model: monaco.editor.ITextModel;
  /** model 的 uri 字符串，共享 model 存储的键 */
  uriKey: string;
  encoding: string;
  dirty: boolean;
  /** 载入/上次保存时的磁盘 mtime，用于外部变更检测；0 表示未知 */
  mtime: number;
  /** 磁盘已被外部修改（脏标签上的警示徽章） */
  externalChanged: boolean;
  element: HTMLLIElement;
  /** model 内容变化监听器，close/迁移 model 时必须 dispose，否则关闭后仍挂在共享 model 上 */
  contentListener?: monaco.IDisposable;
}

/**
 * 共享 model 存储（按 uri 引用计数）：分屏两侧打开同一文件时共用同一 model，
 * 编辑实时互通，避免双 model 内容分裂。
 */
const modelStore = new Map<string, { model: monaco.editor.ITextModel; refs: number }>();

// 模块级计数：分屏各编辑组各持一个 TabManager，实例字段会让两组都从 untitled-1 开始，
// uriKey 相同导致误共享 model，两组新建文件内容互相串扰
let untitledSeq = 0;

function acquireModel(uriKey: string, content: string, lang: string): monaco.editor.ITextModel {
  const hit = modelStore.get(uriKey);
  if (hit) {
    hit.refs += 1;
    return hit.model;
  }
  const model = monaco.editor.createModel(content, lang, monaco.Uri.parse(uriKey));
  modelStore.set(uriKey, { model, refs: 1 });
  return model;
}

function releaseModel(uriKey: string): void {
  const entry = modelStore.get(uriKey);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.model.dispose();
    modelStore.delete(uriKey);
  }
}

export interface TabEvents {
  /** 活动标签变化（含编码、语言，用于状态栏刷新） */
  onActiveChange(): void;
  /** 文件从磁盘读取/写回后回调（用于刷新解析缓存与层级树） */
  onFileReloaded(path: string, content: string, encoding: string, mtime: number): void;
  onFileSaved(path: string, content: string, encoding: string, mtime: number): void;
  /** 标签右键菜单的附加项（如「在另一侧视图打开」），插在关闭项之后 */
  tabMenuExtra?(tab: Tab): MenuItem[];
}

export class TabManager {
  /** 所有实例（分屏各编辑组一个），用于跨组同步同路径标签状态 */
  private static managers = new Set<TabManager>();

  private editor: monaco.editor.IStandaloneCodeEditor;
  private barEl: HTMLElement;
  private events: TabEvents;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  /** 打开中的每个标签的视图状态（光标、滚动位置） */
  private viewStates = new Map<monaco.editor.ITextModel, monaco.editor.ICodeEditorViewState | null>();

  constructor(editor: monaco.editor.IStandaloneCodeEditor, barEl: HTMLElement, events: TabEvents) {
    this.editor = editor;
    this.barEl = barEl;
    this.events = events;
    TabManager.managers.add(this);
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void this.save();
    }, `editorId == '${this.editor.getId()}' && editorTextFocus`);
  }

  get activeTab(): Tab | null {
    return this.active;
  }

  get count(): number {
    return this.tabs.length;
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
    let file;
    try {
      file = await readFile(path);
    } catch (e) {
      await appAlert(`打开失败：${String(e)}`);
      return;
    }
    const { content, encoding, mtime } = file;
    this.createTab(path, basename(path), content, encoding, mtime, line);
    this.events.onFileReloaded(path, content, encoding, mtime);
  }

  /** 已缓存内容的文件直接打开，不再读盘（扫描阶段已读过的场景）。 */
  openContent(path: string, content: string, encoding: string, mtime: number, line?: number): void {
    const existing = this.findTab(path);
    if (existing) {
      this.activate(existing);
      if (line !== undefined) this.reveal(line);
      return;
    }
    this.createTab(path, basename(path), content, encoding, mtime, line);
  }

  newFile(): void {
    untitledSeq += 1;
    this.createTab("", `untitled-${untitledSeq}`, "", "utf8", 0);
  }

  /** 以指定编码重新读取当前文件并替换内容。 */
  async reopenWithEncoding(encoding: string): Promise<void> {
    const tab = this.active;
    if (!tab) return;
    if (tab.dirty && !(await appConfirm("当前修改未保存，重新打开将丢弃修改，继续？"))) {
      return;
    }
    if (!tab.path) return; // 未命名文件无盘可读
    try {
      const { content, mtime } = await readFile(tab.path, encoding);
      tab.model.setValue(content);
      tab.encoding = encoding;
      tab.mtime = mtime;
      tab.dirty = false;
      tab.externalChanged = false;
      this.renderTab(tab);
      this.events.onFileReloaded(tab.path, content, encoding, mtime);
      this.events.onActiveChange();
      this.syncPeers(tab);
    } catch (e) {
      await appAlert(`重新打开失败：${String(e)}`);
    }
  }

  /** 磁盘内容静默重载（外部变更、标签无未保存修改时）。返回是否执行。 */
  reloadFromDisk(path: string, content: string, encoding: string, mtime: number): boolean {
    const tab = this.findTab(path);
    if (!tab || tab.dirty) return false;
    const viewing = this.editor.getModel() === tab.model;
    const pos = viewing ? this.editor.getPosition() : null;
    tab.model.setValue(content);
    tab.encoding = encoding;
    tab.mtime = mtime;
    tab.dirty = false;
    tab.externalChanged = false;
    this.renderTab(tab);
    if (viewing && pos) this.editor.setPosition(pos);
    this.events.onFileReloaded(path, content, encoding, mtime);
    // setValue 触发的是共享 model 的监听器，对侧同路径标签会被误标脏，同步修正
    this.syncPeers(tab);
    return true;
  }

  /** 设置/清除「磁盘已变更」徽章。 */
  markExternalChanged(path: string, changed: boolean): void {
    const tab = this.findTab(path);
    if (!tab || tab.externalChanged === changed) return;
    tab.externalChanged = changed;
    this.renderTab(tab);
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
    return this.saveTab(tab);
  }

  private saveTab(tab: Tab): Promise<boolean> {
    return tab.path ? this.doWrite(tab, tab.path) : this.saveTabAs(tab);
  }

  async saveAs(): Promise<boolean> {
    const tab = this.active;
    if (!tab) return false;
    return this.saveTabAs(tab);
  }

  private async saveTabAs(tab: Tab): Promise<boolean> {
    const target = await saveFileDialog(tab.path || undefined);
    if (!target) return false;
    const ok = await this.doWrite(tab, target);
    if (ok && !tab.path) {
      // Monaco 不允许改 model.uri：用新 uri 重建 model 并迁移内容。
      // 否则 uriKey 停留在 inmemory:///，另一组按新路径打开会建第二个 model，两组内容分裂。
      const oldKey = tab.uriKey;
      const oldModel = tab.model;
      const newModel = acquireModel(`file:///${target}`, oldModel.getValue(), langForFile(target));
      tab.path = target;
      tab.title = basename(target);
      tab.model = newModel;
      tab.uriKey = `file:///${target}`;
      this.watchContent(tab, newModel);
      this.viewStates.set(newModel, this.viewStates.get(oldModel) ?? null);
      this.viewStates.delete(oldModel);
      if (this.active === tab) this.editor.setModel(newModel);
      // 放在 editor 切走之后：refs 归零会 dispose 旧 model（撤销栈随之丢弃，可接受）
      releaseModel(oldKey);
      this.renderTab(tab);
      this.events.onActiveChange();
    }
    return ok;
  }

  /** 全部确认和保存成功后才关闭任何标签；共享缓冲区仍有其他视图时不提示丢弃。 */
  private static async confirmClose(selections: { manager: TabManager; tabs: Tab[] }[]): Promise<boolean> {
    const closing = new Set(selections.flatMap(s => s.tabs));
    const remainingModels = new Set([...TabManager.managers].flatMap(m => m.tabs.filter(t => !closing.has(t)).map(t => t.model)));
    const dirty = new Map<monaco.editor.ITextModel, { manager: TabManager; tab: Tab }>();
    for (const { manager, tabs } of selections) for (const tab of tabs) {
      if (tab.dirty && !remainingModels.has(tab.model)) dirty.set(tab.model, { manager, tab });
    }
    if (!dirty.size) return true;
    const choice = await choiceDialog(`${dirty.size} 个文件有未保存的修改：\n${[...dirty.values()].map(({ tab }) => tab.path || tab.title).join("\n")}`, ["保存并关闭", "不保存", "取消"], 2);
    if (choice === 1) return true;
    if (choice !== 0) return false;
    for (const { manager, tab } of dirty.values()) if (!(await manager.saveTab(tab))) return false;
    return true;
  }

  static confirmExit(managers: TabManager[]): Promise<boolean> {
    return TabManager.confirmClose(managers.map(manager => ({ manager, tabs: [...manager.tabs] })));
  }

  static async closeGroups(managers: TabManager[]): Promise<boolean> {
    const selections = managers.map(manager => ({ manager, tabs: [...manager.tabs] }));
    if (!(await TabManager.confirmClose(selections))) return false;
    for (const { manager, tabs } of selections) for (const tab of tabs) manager.removeTab(tab);
    return true;
  }

  private async closeTabs(tabs: Tab[]): Promise<boolean> {
    if (!(await TabManager.confirmClose([{ manager: this, tabs }]))) return false;
    for (const tab of tabs) this.removeTab(tab);
    return true;
  }

  close(tab: Tab): Promise<boolean> {
    return this.closeTabs(this.tabs.includes(tab) ? [tab] : []);
  }

  private removeTab(tab: Tab): void {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return; // 标签已被关闭（双击关闭按钮等重复触发），splice(-1) 会误删末尾标签
    this.tabs.splice(idx, 1);
    tab.element.remove();
    tab.contentListener?.dispose();
    this.viewStates.delete(tab.model);
    releaseModel(tab.uriKey);
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

  closeAll(): Promise<boolean> {
    return this.closeTabs([...this.tabs]);
  }

  /** 关闭除 tab 外的所有标签（脏标签逐个确认）。 */
  closeOthers(tab: Tab): Promise<boolean> {
    return this.closeTabs(this.tabs.filter(t => t !== tab));
  }

  /** 关闭 tab 右侧的所有标签（脏标签逐个确认）。 */
  closeRight(tab: Tab): Promise<boolean> {
    const idx = this.tabs.indexOf(tab);
    return this.closeTabs(idx < 0 ? [] : this.tabs.slice(idx + 1));
  }

  private showTabMenu(tab: Tab, x: number, y: number): void {
    const items: MenuItem[] = [
      { label: "关闭", action: () => void this.close(tab) },
      { label: "关闭其他", action: () => void this.closeOthers(tab) },
      { label: "关闭右侧", action: () => void this.closeRight(tab) },
    ];
    items.push(...(this.events.tabMenuExtra?.(tab) ?? []));
    if (tab.path) {
      items.push(...filePathMenuItems(tab.path, (p) => void showInFolder(p)));
    }
    showCtxMenu(x, y, items);
  }

  /** 保存/重打开后同步其他组同路径标签的状态（共享 model，脏标记需一致）。 */
  private syncPeers(tab: Tab): void {
    if (!tab.path) return;
    for (const m of TabManager.managers) {
      if (m === this) continue;
      const peer = m.findTab(tab.path);
      if (!peer) continue;
      peer.dirty = tab.dirty;
      peer.encoding = tab.encoding;
      peer.mtime = tab.mtime;
      peer.externalChanged = tab.externalChanged;
      m.renderTab(peer);
    }
  }

  private async doWrite(tab: Tab, path: string): Promise<boolean> {
    // 保存前检测：磁盘 mtime 与载入时不一致说明外部已修改，禁止静默覆盖
    if (path === tab.path && tab.mtime) {
      let current: number | null | undefined;
      try {
        [current] = await fileStates([tab.path]);
      } catch (e) {
        // 无法确认磁盘状态时中止保存，避免静默覆盖外部修改
        await appAlert(`保存失败：无法读取磁盘状态（${String(e)}）`);
        return false;
      }
      if (current && current !== tab.mtime) {
        const choice = await choiceDialog(
          `「${tab.title}」在磁盘上已被外部修改。`,
          ["覆盖保存", "放弃修改重新加载", "取消"],
        );
        if (choice === 1) {
          try {
            const { content, encoding, mtime } = await readFile(tab.path);
            tab.model.setValue(content);
            tab.encoding = encoding;
            tab.mtime = mtime;
            tab.dirty = false;
            tab.externalChanged = false;
            this.renderTab(tab);
            this.events.onFileReloaded(tab.path, content, encoding, mtime);
            this.events.onActiveChange();
            this.syncPeers(tab);
          } catch (e) {
            await appAlert(`重新加载失败：${String(e)}`);
          }
          return false;
        }
        if (choice !== 0) return false;
      }
    }
    let mtime: number;
    try {
      mtime = await writeFile(path, tab.model.getValue(), tab.encoding);
    } catch (e) {
      await appAlert(`保存失败：${String(e)}`);
      return false;
    }
    tab.dirty = false;
    tab.externalChanged = false;
    tab.mtime = mtime;
    this.renderTab(tab);
    this.events.onFileSaved(path, tab.model.getValue(), tab.encoding, mtime);
    this.syncPeers(tab);
    return true;
  }

  /** 在 model 上挂脏标记监听（先清旧监听，共享 model 关闭/迁移时不得残留）。 */
  private watchContent(tab: Tab, model: monaco.editor.ITextModel): void {
    tab.contentListener?.dispose();
    tab.contentListener = model.onDidChangeContent(() => {
      if (!tab.dirty) {
        tab.dirty = true;
        this.renderTab(tab);
      }
    });
  }

  private createTab(path: string, title: string, content: string, encoding: string, mtime: number, line?: number): void {
    const uriKey = path ? `file:///${path}` : `inmemory:///${title}`;
    const peer = [...TabManager.managers].flatMap(manager => manager.tabs).find(tab => tab.uriKey === uriKey);
    // 同路径跨组共享 model（分屏双视图编辑同步）；未命名文件 uri 唯一不共享
    const model = acquireModel(uriKey, content, langForFile(path));
    const tab: Tab = {
      path,
      title,
      model,
      uriKey,
      encoding: peer?.encoding ?? encoding,
      dirty: peer?.dirty ?? false,
      mtime: peer?.mtime ?? mtime,
      externalChanged: peer?.externalChanged ?? false,
      element: document.createElement("li"),
    };
    this.watchContent(tab, model);
    this.tabs.push(tab);
    this.renderTab(tab);
    tab.element.addEventListener("click", () => this.activate(tab));
    tab.element.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showTabMenu(tab, e.clientX, e.clientY);
    });
    this.barEl.appendChild(tab.element);
    this.activate(tab);
    if (line !== undefined) this.reveal(line);
  }

  private renderTab(tab: Tab): void {
    tab.element.textContent = "";
    tab.element.className = "tab";
    const fileIcon = document.createElement("span");
    fileIcon.className = "tab-file-icon";
    setIcon(fileIcon, "module");
    const label = document.createElement("span");
    label.className = "tab-label";
    if (tab.dirty) {
      const dirty = document.createElement("span");
      dirty.className = "dirty";
      dirty.textContent = "*";
      label.appendChild(dirty);
    }
    if (tab.externalChanged) {
      const ext = document.createElement("span");
      ext.className = "external";
      setIcon(ext, "warning");
      label.append(ext, document.createTextNode(" "));
    }
    label.appendChild(document.createTextNode(tab.title));
    label.title = tab.externalChanged ? "磁盘文件已被外部修改" : tab.path || "未保存";
    const close = document.createElement("button");
    close.className = "tab-close";
    setIcon(close, "close");
    close.title = "关闭";
    close.setAttribute("aria-label", `关闭 ${tab.title}`);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.close(tab);
    });
    tab.element.append(fileIcon, label, close);
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
