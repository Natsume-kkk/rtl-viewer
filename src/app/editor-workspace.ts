import { monaco } from "../editor/monaco";
import { TabManager, type TabEvents } from "../editor/tabs";
import { NavHistory, type NavEntry } from "../model/history";
import { PathBreadcrumb } from "../ui/breadcrumb";
import { setIcon } from "../ui/icons";
import { openDirectory, showInFolder } from "../ipc";
import type { CachedFile } from "./watcher";
import { sameFilePath } from "../file-path";

export interface EditorGroup {
  editor: monaco.editor.IStandaloneCodeEditor;
  tabs: TabManager;
}

interface WorkspaceContext {
  cachedFile(path: string): CachedFile | undefined;
  onFileChanged: TabEvents["onFileSaved"];
  onActiveChange(group: EditorGroup): void;
  onContentChange(active: boolean): void;
  onCursorChange(line: number): void;
  onSplit(): void;
  hint(message: string): void;
}

/** 两组编辑器的布局与导航状态；工程缓存和其他视图通过事件接线。 */
export function createEditorWorkspace(editors: readonly [EditorGroup["editor"], EditorGroup["editor"]], ctx: WorkspaceContext) {
  const [editor, editor2] = editors;
  const tabbarEl = document.getElementById("tabbar")!;
  const disposables: monaco.IDisposable[] = [];
  function listen(target: EventTarget, type: string, callback: EventListener): void {
    target.addEventListener(type, callback);
    disposables.push({ dispose: () => target.removeEventListener(type, callback) });
  }
  const histories = [new NavHistory(), new NavHistory()];
  let activeGroupIdx = 0;

  function currentPos(): NavEntry | undefined {
    const g = activeGroup();
    const tab = g.tabs.activeTab;
    if (!tab?.path) return undefined;
    const selection = g.editor.getSelection(), position = g.editor.getPosition();
    return { path: tab.path, line: selection?.startLineNumber ?? position?.lineNumber ?? 1, column: selection?.startColumn ?? position?.column ?? 1,
      length: selection && selection.startLineNumber === selection.endLineNumber ? selection.endColumn - selection.startColumn : 0 };
  }

  /** 工程内跳转统一入口：记录当前位置到历史，再打开目标位置。 */
  async function navigateTo(file: string, line?: number, column = 1, length = 0): Promise<void> {
    const idx = activeGroupIdx;
    const cur = currentPos();
    if (cur) histories[idx].push(cur);
    await openFile(file, line, idx, column, length);
    updateNavButtons();
  }

  function navBack(): void {
    const cur = currentPos();
    if (!cur) return;
    const idx = activeGroupIdx, target = histories[idx].goBack(cur);
    if (target) void openFile(target.path, target.line, idx, target.column, target.length).then(updateNavButtons);
  }

  function navForward(): void {
    const cur = currentPos();
    if (!cur) return;
    const idx = activeGroupIdx, target = histories[idx].goForward(cur);
    if (target) void openFile(target.path, target.line, idx, target.column, target.length).then(updateNavButtons);
  }

  const navButtons = histories.map((_, idx) => {
    const back = document.createElement("button"), forward = document.createElement("button");
    for (const button of [back, forward]) button.className = "nav-btn";
    setIcon(back, "arrow-left"); setIcon(forward, "arrow-right");
    back.title = "后退 (Alt+←)"; forward.title = "前进 (Alt+→)";
    back.setAttribute("aria-label", idx ? "右侧后退" : "后退");
    forward.setAttribute("aria-label", idx ? "右侧前进" : "前进");
    back.onclick = () => { focusGroup(idx); navBack(); };
    forward.onclick = () => { focusGroup(idx); navForward(); };
    document.getElementById(`breadcrumb-${idx + 1}`)!.prepend(back, forward);
    return { back, forward };
  });

  function updateNavButtons(): void {
    navButtons.forEach(({ back, forward }, idx) => {
      back.disabled = !histories[idx].canBack;
      forward.disabled = !histories[idx].canForward;
      back.classList.toggle("disabled", back.disabled);
      forward.classList.toggle("disabled", forward.disabled);
    });
  }
  updateNavButtons();

  let splitVisible = false;
  let splitFlex = "";

  function makeTabEvents(idx: number): TabEvents {
    return {
      onActiveChange: () => {
        if (idx === 1 && groups[1].tabs.count === 0) collapseSplit();
        syncEditorChrome(idx);
        if (idx === activeGroupIdx) ctx.onActiveChange(activeGroup());
      },
      onFileReloaded: ctx.onFileChanged,
      onFileSaved: ctx.onFileChanged,
      tabMenuExtra: tab => tab.path ? [{
        label: splitVisible ? "在另一侧视图打开" : "向右拆分视图",
        action: () => void openFile(tab.path, undefined, idx === 0 ? 1 : 0),
      }] : [],
    };
  }

  const groups: EditorGroup[] = [
    { editor, tabs: new TabManager(editor, tabbarEl, makeTabEvents(0)) },
    {
      editor: editor2,
      tabs: new TabManager(editor2, document.getElementById("tabbar-2")!, makeTabEvents(1)),
    },
  ];
  wireEditor(editor, 0);
  wireEditor(editor2, 1);
  const breadcrumbs = [1, 2].map(index => new PathBreadcrumb(
    document.querySelector<HTMLElement>(`#breadcrumb-${index} .breadcrumb-path`)!,
    path => void openDirectory(path).catch(error => ctx.hint(`打开文件夹失败：${String(error)}`)),
    path => void showInFolder(path).catch(error => ctx.hint(`定位文件失败：${String(error)}`)),
  ));
  setIcon(document.getElementById("close-split")!, "close");
  listen(document.getElementById("close-split")!, "click", collapseSplit);

  function syncEditorChrome(idx: number): void {
    const g = groups[idx];
    const tab = g.tabs.activeTab;
    const foot = document.getElementById(`editor-foot-${idx + 1}`)!;
    breadcrumbs[idx].setPath(tab?.path ?? "", tab?.title ?? "未打开文件");
    foot.textContent = tab ? `${tab.title} · ${tab.model.getLanguageId()}` : "打开工程，开始阅读源码";
    foot.title = foot.textContent;
  }

  function activeGroup(): EditorGroup {
    return groups[activeGroupIdx];
  }

  function focusGroup(idx: number): void {
    if (!groups[idx] || idx === activeGroupIdx) return;
    activeGroupIdx = idx;
    syncChrome();
  }

  /** 同步状态栏/大纲等外围 UI 到当前活动组。 */
  function syncChrome(): void {
    updateNavButtons();
    ctx.onActiveChange(activeGroup());
  }

  function ensureSplit(): void {
    if (splitVisible) return;
    splitVisible = true;
    document.getElementById("split-action")!.setAttribute("aria-pressed", "true");
    ctx.onSplit();
    document.getElementById("group-2")!.hidden = false;
    document.getElementById("group-splitter")!.hidden = false;
    document.getElementById("group-1")!.style.flex = splitFlex;
  }

  function collapseSplit(): void {
    if (!splitVisible) return;
    stopDrag();
    splitVisible = false;
    document.getElementById("split-action")!.setAttribute("aria-pressed", "false");
    document.getElementById("group-2")!.hidden = true;
    document.getElementById("group-splitter")!.hidden = true;
    splitFlex = document.getElementById("group-1")!.style.flex;
    document.getElementById("group-1")!.style.flex = "";
    if (activeGroupIdx === 1) {
      activeGroupIdx = 0;
      syncChrome();
    }
    groups[0].editor.focus();
  }

  /** 当前文件在另一侧视图打开（Ctrl+Alt+V / 编辑器右键）。 */
  async function openInOtherGroup(): Promise<void> {
    const src = activeGroup();
    const tab = src.tabs.activeTab;
    if (!tab?.path) {
      ctx.hint("当前没有已保存的文件");
      return;
    }
    const line = src.editor.getPosition()?.lineNumber;
    await openFile(tab.path, line, activeGroupIdx === 0 ? 1 : 0);
  }

  /** 隐藏、失焦和销毁也结束拖动，避免 document 上残留监听。 */
  let stopDrag = () => {};
  listen(document.getElementById("group-splitter")!, "mousedown", event => {
    if (!splitVisible) return;
    const e = event as MouseEvent;
    e.preventDefault();
    stopDrag();
    const g1 = document.getElementById("group-1")!;
    const startX = e.clientX, startWidth = g1.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      const total = document.getElementById("main-area")!.getBoundingClientRect().width;
      const width = Math.min(Math.max(startWidth + ev.clientX - startX, 200), Math.max(200, total - 200));
      g1.style.flex = `0 0 ${width}px`;
    };
    stopDrag = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", stopDrag);
      window.removeEventListener("blur", stopDrag);
      stopDrag = () => {};
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", stopDrag);
    window.addEventListener("blur", stopDrag);
  });

  async function openFile(file: string, line?: number, targetIdx?: number, column = 1, length = 0): Promise<void> {
    const idx = targetIdx ?? activeGroupIdx;
    if (idx === 1) ensureSplit();
    const g = groups[idx];
    const cached = ctx.cachedFile(file);
    if (cached) {
      g.tabs.openContent(file, cached.content, cached.encoding, cached.mtime, line);
    } else {
      await g.tabs.openFile(file, line);
    }
    if (line !== undefined && g.tabs.activeTab && sameFilePath(g.tabs.activeTab.path, file)) {
      g.editor.setSelection(new monaco.Range(line, column, line, column + length));
      g.editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(line, column, line, column + length));
    }
  }

  function wireEditor(ed: monaco.editor.IStandaloneCodeEditor, idx: number): void {
    disposables.push(ed.onDidFocusEditorText(() => focusGroup(idx)));
    // 共享 model 时两组编辑器都会收到内容事件，只让活动组触发大纲刷新
    disposables.push(ed.onDidChangeModelContent(() => ctx.onContentChange(idx === activeGroupIdx)));
    disposables.push(ed.onDidChangeCursorPosition((e) => {
      if (idx !== activeGroupIdx) return;
      const line = e.position.lineNumber;
      ctx.onCursorChange(line);
    }));
  }

  function jumpToLine(line: number): void {
    const cur = currentPos();
    if (cur) histories[activeGroupIdx].push(cur);
    const ed = activeGroup().editor;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
    updateNavButtons();
  }

  function switchView(): void {
    if (!splitVisible) return;
    const idx = activeGroupIdx === 0 ? 1 : 0;
    focusGroup(idx);
    groups[idx].editor.focus();
  }

  return {
    groups: groups as readonly EditorGroup[],
    get activeIndex() { return activeGroupIdx; },
    get splitVisible() { return splitVisible; },
    activeGroup, focusGroup, openFile, navigateTo, navBack, navForward, jumpToLine,
    ensureSplit, collapseSplit, openInOtherGroup, switchView,
    resetHistory() { histories.forEach(history => history.clear()); updateNavButtons(); },
    saveAll: () => TabManager.saveGroups(groups.map(group => group.tabs)),
    closeAll: () => TabManager.closeGroups(groups.map(group => group.tabs)),
    dispose() {
      stopDrag();
      disposables.splice(0).forEach(item => item.dispose());
      breadcrumbs.forEach(item => item.dispose());
      navButtons.forEach(({ back, forward }) => { back.remove(); forward.remove(); });
    },
  };
}
