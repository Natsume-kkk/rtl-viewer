import { monaco } from "../editor/monaco";
import { TabManager, type Tab, type TabEvents } from "../editor/tabs";
import { createEditorLayout } from "../ui/editor-layout";
import { attachTabDrag } from "../ui/tab-drag";
import { showCtxMenu, type MenuItem } from "../ui/menu";
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

  const layout = createEditorLayout();
  let transferring = false;
  let syncVertical = false, syncHorizontal = false, syncing = false;
  let changingViews = 0, disposed = false;
  let scrollOffset = { top: 0, left: 0 };

  function anchorScroll(): void {
    scrollOffset = { top: editor2.getScrollTop() - editor.getScrollTop(), left: editor2.getScrollLeft() - editor.getScrollLeft() };
  }

  function reconcileEmpty(): void {
    if (transferring || groups.every(g => g.tabs.count > 0)) return;
    if (!layout.splitVisible && groups.some(g => g.tabs.count > 0)) return;
    const remaining = groups[0].tabs.count ? 0 : groups[1].tabs.count ? 1 : 0;
    layout.show(remaining);
    focusGroup(remaining);
    updateSplitButton();
  }

  function makeTabEvents(idx: number): TabEvents {
    return {
      onActiveChange: () => {
        reconcileEmpty();
        if (syncVertical || syncHorizontal) anchorScroll();
        syncEditorChrome(idx);
        if (idx === activeGroupIdx) syncChrome();
      },
      onFileReloaded: ctx.onFileChanged,
      onFileSaved: ctx.onFileChanged,
      tabMenuExtra: tab => transferMenu(idx, tab),
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
  disposables.push({ dispose: attachTabDrag(groups.map(g => g.tabs), () => layout.splitVisible, hit => {
    if (hit.split) showCtxMenu(hit.x, hit.y, transferMenu(hit.source, hit.tab));
    else if (hit.source === hit.target) groups[hit.source].tabs.reorder(hit.tab, hit.before);
    else void transferTab(hit.source, hit.tab, false, hit.before);
  }) });
  listen(document.getElementById("group-splitter")!, "contextmenu", event => {
    event.preventDefault(); const e = event as MouseEvent;
    showViewMenu(e.clientX, e.clientY);
  });
  listen(document.getElementById("group-splitter")!, "keydown", event => {
    const e = event as KeyboardEvent;
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    e.preventDefault(); const rect = (e.target as HTMLElement).getBoundingClientRect();
    showViewMenu(rect.left, rect.top);
  });

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
    groups.forEach((_, idx) => document.getElementById(`group-${idx + 1}`)!.classList.toggle("focused", idx === activeGroupIdx));
    updateNavButtons();
    ctx.onActiveChange(activeGroup());
  }

  function updateSplitButton(): void {
    document.getElementById("split-action")!.setAttribute("aria-expanded", String(layout.splitVisible));
  }

  function ensureSplit(): void {
    if (layout.splitVisible) return;
    layout.show(null);
    if (syncVertical || syncHorizontal) anchorScroll();
    updateSplitButton();
  }

  function collapseSplit(): void {
    if (!layout.splitVisible) return;
    layout.show(activeGroupIdx);
    updateSplitButton();
    activeGroup().editor.focus();
  }

  function transferMenu(idx: number, tab: Tab): MenuItem[] {
    return [
      { label: "移动到另一视图", action: () => void transferTab(idx, tab, false) },
      { label: "克隆到另一视图", action: () => void transferTab(idx, tab, true) },
    ];
  }

  async function transferTab(idx: number, tab: Tab, clone: boolean, before?: Tab): Promise<void> {
    if (transferring) return;
    transferring = true;
    try {
      if (!(await groups[idx].tabs.transfer(tab, groups[1 - idx].tabs, clone, before))) return;
      ensureSplit();
      focusGroup(1 - idx);
      groups[1 - idx].editor.focus();
    } finally {
      transferring = false;
      reconcileEmpty();
      if (syncVertical || syncHorizontal) anchorScroll();
    }
  }

  /** 克隆当前缓冲区，包含尚未命名的文件。 */
  async function openInOtherGroup(): Promise<void> {
    const tab = activeGroup().tabs.activeTab;
    if (!tab) { ctx.hint("当前没有打开的文件"); return; }
    await transferTab(activeGroupIdx, tab, true);
  }

  function showViewMenu(x: number, y: number): void {
    const tab = activeGroup().tabs.activeTab;
    const items = tab ? transferMenu(activeGroupIdx, tab) : [];
    if (layout.splitVisible) items.push({ label: "收起另一视图（保留文件）", action: collapseSplit });
    else if (groups[1 - activeGroupIdx].tabs.count) items.push({ label: "恢复双视图", action: ensureSplit });
    items.push(
      { label: "左右排列", checked: !layout.stacked, action: () => layout.orient(false) },
      { label: "上下排列", checked: layout.stacked, action: () => layout.orient(true) },
      { label: "交换两侧位置", action: () => layout.swap() },
      { label: "同步纵向滚动", checked: syncVertical, action: () => { syncVertical = !syncVertical; anchorScroll(); } },
      { label: "同步横向滚动", checked: syncHorizontal, action: () => { syncHorizontal = !syncHorizontal; anchorScroll(); } },
    );
    showCtxMenu(x, y, items, document.getElementById("split-action")!);
  }

  async function openFile(file: string, line?: number, targetIdx?: number, column = 1, length = 0): Promise<void> {
    const idx = targetIdx ?? activeGroupIdx;
    if (document.getElementById(`group-${idx + 1}`)!.hidden) ensureSplit();
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
    disposables.push(ed.onDidChangeModel(() => {
      changingViews++;
      queueMicrotask(() => {
        changingViews--;
        if (!disposed && (syncVertical || syncHorizontal)) anchorScroll();
      });
    }));
    disposables.push(ed.onDidScrollChange(event => {
      if (syncing || transferring || changingViews || !layout.splitVisible) return;
      const target = editors[1 - idx], sign = idx === 0 ? 1 : -1;
      const position: monaco.editor.INewScrollPosition = {};
      if (syncVertical && event.scrollTopChanged) position.scrollTop = event.scrollTop + sign * scrollOffset.top;
      if (syncHorizontal && event.scrollLeftChanged) position.scrollLeft = event.scrollLeft + sign * scrollOffset.left;
      if (position.scrollTop === undefined && position.scrollLeft === undefined) return;
      syncing = true;
      try { target.setScrollPosition(position, monaco.editor.ScrollType.Immediate); }
      finally { syncing = false; }
    }));
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
    if (!layout.splitVisible) return;
    const idx = activeGroupIdx === 0 ? 1 : 0;
    focusGroup(idx);
    groups[idx].editor.focus();
  }

  return {
    groups: groups as readonly EditorGroup[],
    get activeIndex() { return activeGroupIdx; },
    get splitVisible() { return layout.splitVisible; },
    activeGroup, focusGroup, openFile, navigateTo, navBack, navForward, jumpToLine,
    ensureSplit, collapseSplit, openInOtherGroup, switchView, transferTab, showViewMenu,
    resetHistory() { histories.forEach(history => history.clear()); updateNavButtons(); },
    saveAll: () => TabManager.saveGroups(groups.map(group => group.tabs)),
    closeAll: () => TabManager.closeGroups(groups.map(group => group.tabs)),
    dispose() {
      disposed = true;
      layout.dispose();
      disposables.splice(0).forEach(item => item.dispose());
      breadcrumbs.forEach(item => item.dispose());
      navButtons.forEach(({ back, forward }) => { back.remove(); forward.remove(); });
    },
  };
}
