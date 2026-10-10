import "./style.css";
import { ModuleIndex } from "./model";

// E2E 模式：先装 IPC mock 再初始化（invoke 在调用时才读取 __TAURI_INTERNALS__）
if (import.meta.env.DEV && new URLSearchParams(location.search).has("e2e")) {
  await import("./e2e-mock");
}
import { buildHierarchy, findInstancesOf } from "./model/hierarchy";
import type { Hierarchy, TreeNode, InstanceSite } from "./model/hierarchy";
import { extractOutline, breadcrumbAt, OUTLINE_KIND_LABELS } from "./model/outline";
import type { OutlineItem } from "./model/outline";
import { searchContents } from "./model/search";
import { scanStructure, parseFileDetail } from "./parser";
import type { ModuleInfo, IpInfo } from "./parser";
import { findSignalDeclLine } from "./model/signals";
import { openFolderDialog, openFileDialog, pathExists, showInFolder, isDirectory, normalizePath } from "./ipc";
import { registerAppShortcuts } from "./ui/shortcuts";
import { initMonaco, createEditor, monaco } from "./editor/monaco";
import { registerCompletionProviders } from "./editor/completion";
import { TabManager } from "./editor/tabs";
import { HierarchyTree } from "./ui/tree";
import { StatusBar } from "./ui/statusbar";
import { OutlineView } from "./ui/outline";
import { SearchPanel } from "./ui/search";
import { RecentMenu } from "./ui/recent";
import { appAlert } from "./ui/dialog";
import { createNewFileControl, preferredNewFileType } from "./ui/new-file";
import { createEditorWorkspace } from "./app/editor-workspace";
import { openColumnEditor, registerColumnActions } from "./editor/column-editor";
import { attachWindowControls } from "./ui/window-controls";
import { initTheme } from "./ui/theme";
import { setIcon } from "./ui/icons";
import type { IconName } from "./ui/icons";
import { renderPortMap, type PortMapData } from "./ui/portmap";
import { pathFromUri } from "./editor/file-path";
import { createSignalController } from "./app/signal-controller";
import { portMapMarkdown } from "./app/port-markdown";
import { createPortMapLoader, findInstanceAt, resolveInstanceAt } from "./app/portmap";
import { createProjectScanner } from "./app/project-scanner";
import { createExternalWatcher, type CachedFile } from "./app/watcher";

/** 全局工程状态 */
const state = {
  folder: "",
  index: new ModuleIndex(),
  structures: new Map<string, ModuleInfo[]>(),
  contents: new Map<string, CachedFile>(),
  ips: [] as IpInfo[],
  /** 约束文件（.xdc/.sdc）路径列表，树底部「约束」分组 */
  constraints: [] as string[],
  topName: undefined as string | undefined,
};

const sidebarEl = document.getElementById("sidebar")!;
const editorContainer = document.getElementById("editor-container")!;
const statusbarEl = document.getElementById("statusbar")!;

// 全局工具栏与侧栏容器只建一次，各组件渲染进对应容器。
function initSidebar(): { treeRoot: HTMLElement; searchRoot: HTMLElement; outlineRoot: HTMLElement } {
  const bar = document.getElementById("toolbar")!;
  setIcon(document.getElementById("project-icon")!, "folder");
  const action = (label: string, icon: IconName, run: () => void) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    const glyph = document.createElement("span");
    setIcon(glyph, icon);
    btn.append(glyph, document.createTextNode(label));
    btn.addEventListener("click", run);
    return btn;
  };
  const openWrap = document.createElement("span");
  openWrap.className = "open-wrap";
  const openBtn = action("打开文件夹", "folder", () => void openProject());
  openBtn.className = "btn btn-primary";
  const recentBtn = document.createElement("button");
  recentBtn.className = "btn btn-primary recent-btn";
  setIcon(recentBtn, "chevron-down");
  openBtn.title = "打开源码文件夹 (Ctrl+Alt+O)";
  recentBtn.title = "最近打开的工程 (Ctrl+Alt+R)";
  recentBtn.setAttribute("aria-label", "最近打开的工程");
  recentBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    recentMenu.toggle();
  });
  openWrap.append(openBtn, recentBtn);
  const newBtn = createNewFileControl(extension => activeGroup().tabs.newFile(extension, state.folder));
  const saveBtn = action("保存", "save", () => void activeGroup().tabs.save());
  saveBtn.title = "保存 (Ctrl+S)";
  const columnBtn = action("列编辑", "split", () => void openColumnEditor(activeGroup().editor));
  columnBtn.title = "列编辑 (Alt+C)；Alt+拖动或 Alt+Shift+方向键选择矩形区域";
  const end = document.createElement("div");
  end.className = "toolbar-end";
  const searchBtn = action("搜索", "search", () => setSearchVisible(searchRoot.hidden));
  searchBtn.id = "search-action";
  searchBtn.title = "全工程搜索 (Ctrl+Shift+F)";
  searchBtn.setAttribute("aria-expanded", "false");
  const shortcut = document.createElement("span");
  shortcut.className = "shortcut";
  shortcut.textContent = "Ctrl Shift F";
  searchBtn.append(shortcut);
  const splitBtn = action("分屏", "split", () => {
    if (workspace.splitVisible) collapseSplit();
    else if (groups[1].tabs.count) ensureSplit();
    else void openInOtherGroup();
  });
  splitBtn.id = "split-action";
  splitBtn.title = "分屏 (Ctrl+Alt+V)；F8 切换编辑视图";
  const mapBtn = action("", "ports", togglePortMap);
  mapBtn.id = "map-action";
  mapBtn.title = "端口映射 (Ctrl+Alt+K)";
  mapBtn.setAttribute("aria-label", "切换端口映射");
  mapBtn.setAttribute("aria-expanded", "false");
  const flowBtn = action("信号链", "ports", toggleSignalFlow);
  flowBtn.id = "flow-action";
  flowBtn.title = "信号链分析";
  flowBtn.setAttribute("aria-expanded", "false");
  end.append(searchBtn, splitBtn, mapBtn, flowBtn);
  bar.append(openWrap, newBtn, saveBtn, columnBtn, end);
  const progress = document.createElement("div");
  progress.id = "progress";
  progress.className = "progress";
  const searchRoot = document.getElementById("search-root")!;
  const treeRoot = document.createElement("div");
  treeRoot.id = "tree-root";
  const outlineRoot = document.createElement("div");
  outlineRoot.id = "outline-root";
  const foot = document.createElement("div");
  foot.id = "sidebar-foot";
  foot.textContent = "本地工程";
  sidebarEl.append(progress, treeRoot, outlineRoot, foot);
  return { treeRoot, searchRoot, outlineRoot };
}

const { treeRoot: treeRootEl, searchRoot: searchRootEl, outlineRoot: outlineRootEl } = initSidebar();

// Monaco 初始化（definition provider 通过函数引用最新索引）；editor2 为分屏第二组
initTheme();
const editor = initMonaco(editorContainer, (name) => state.index.resolve(name));
const editor2 = createEditor(document.getElementById("editor-container-2")!);

// E2E 钩子：仅 ?e2e 模式暴露编辑器实例与拖放入口，供自动化验收驱动
if (import.meta.env.DEV && new URLSearchParams(location.search).has("e2e")) {
  const rtl: Record<string, unknown> = {
    monaco,
    debugDrop: (paths: string[]) => void handleDroppedPaths(paths),
    splitOther: () => void openInOtherGroup(),
  };
  Object.defineProperty(rtl, "editor", { get: () => activeGroup().editor });
  Object.defineProperty(rtl, "tabs", { get: () => activeGroup().tabs });
  (window as unknown as Record<string, unknown>).__rtl = rtl;
}

const statusbar = new StatusBar(statusbarEl, {
  onReopen: (enc) => void activeGroup().tabs.reopenWithEncoding(enc),
  onSetSaveEncoding: (enc) => activeGroup().tabs.setSaveEncoding(enc),
});
statusbar.attachEditor(editor, () => workspace.activeIndex === 0);
statusbar.attachEditor(editor2, () => workspace.activeIndex === 1);

const tree = new HierarchyTree(treeRootEl, {
  onOpen: (node) => void openTreeNode(node),
  onOpenInst: (node) => {
    if (node.instFile && node.instLine !== undefined) {
      selectTreeInstance(node);
      void navigateTo(node.instFile, node.instLine);
    }
  },
  onRevealFile: (path) => void showInFolder(path),
  onSelectTop: (name) => {
    state.topName = name;
    signalController.invalidate();
    renderTree();
  },
  onOpenFile: (path) => void navigateTo(path),
  onFindInstances: (name) => {
    document.getElementById("ref-panel")?.remove();
    const sites = findInstancesOf(state.structures, name);
    if (sites.length === 0) {
      statusbar.hint(`${name} 未被例化`);
    } else if (sites.length === 1) {
      void navigateTo(sites[0].file, sites[0].line);
    } else {
      showInstancePanel(name, sites);
    }
  },
});

// ---------- 大纲 ----------

const outline = new OutlineView(outlineRootEl, {
  onJump: line => workspace.jumpToLine(line),
  onOpenSymbols: () => {
    const ed = activeGroup().editor;
    ed.focus();
    ed.trigger("rtl.outline", "editor.action.quickOutline", null);
  },
});

let outlineTimer: number | undefined;
/** 当前文件的大纲缓存：面包屑与光标跟随共用，避免光标移动时重复提取。 */
let currentOutline: OutlineItem[] = [];

function refreshOutline(): void {
  window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    const g = activeGroup();
    const tab = g.tabs.activeTab;
    if (!tab) {
      currentOutline = [];
      outline.render([], "");
      return;
    }
    currentOutline = extractOutline(tab.model.getValue(), tab.path || tab.title);
    outline.render(currentOutline, tab.title);
    const line = g.editor.getPosition()?.lineNumber;
    if (line) {
      statusbar.setBreadcrumb(breadcrumbAt(currentOutline, line));
      outline.highlightLine(line);
    }
  }, 200);
}

// 工作区仅向当前活动组派发光标跟随事件。

// ---------- 全局搜索 ----------

function displayPath(file: string): string {
  return state.folder && file.startsWith(state.folder + "/")
    ? file.slice(state.folder.length + 1)
    : file;
}

const searchPanel = new SearchPanel(searchRootEl, {
  onClose: () => { setSearchVisible(false); activeGroup().editor.focus(); },
  onFocus: () => setSearchVisible(true, false),
  onSearch: (query, options) => searchContents(new Map([...state.contents].map(([path, cached]) => [path, { ...cached, content: fileContent(path) ?? cached.content }])), query, options),
  onOpen: (file, line, column, length) => void navigateTo(file, line, column, length),
  displayPath,
});

function setSearchVisible(visible: boolean, focus = true): void {
  searchRootEl.hidden = !visible;
  document.getElementById("search-action")!.setAttribute("aria-expanded", String(visible));
  if (visible && focus) searchPanel.focus();
}

// ---------- 例化端口映射（悬停预览 + 明确选择后保留） ----------

const portMapLoader = createPortMapLoader({
  ips: () => state.ips,
  resolveModule: (name) => state.index.resolve(name),
  fileContent,
  fileToken,
});
const { detailForModel, modulePorts, moduleParameters, buildPortMapRows } = portMapLoader;

/** 打开中的标签页用当前缓冲区（含未保存修改），否则用扫描缓存。两组标签都查。 */
function fileContent(file: string): string | undefined {
  for (const g of groups) {
    const tab = g.tabs.findTab(file);
    if (tab) return tab.model.getValue();
  }
  return state.contents.get(file)?.content;
}

/** 与 fileContent 同源的缓存令牌：标签页用 model 版本号，否则用扫描缓存内容引用。 */
function fileToken(file: string): unknown {
  for (const g of groups) {
    const tab = g.tabs.findTab(file);
    if (tab) return tab.model.getVersionId();
  }
  return state.contents.get(file)?.content;
}

function gotoSignalDecl(file: string, name: string): void {
  const content = fileContent(file);
  const line = content ? findSignalDeclLine(content, file, name) : undefined;
  if (line) void navigateTo(file, line);
  else statusbar.hint(`未找到 ${name} 的声明`);
}

function gotoPortDecl(moduleName: string, port: string): void {
  const def = state.index.resolve(moduleName);
  if (!def || def.isIp) return;
  const content = fileContent(def.file);
  const line = (content && findSignalDeclLine(content, def.file, port)) || def.line;
  void navigateTo(def.file, line);
}


const IDENT_RE = /^[A-Za-z_]\w*$/;

monaco.editor.registerCommand("rtl.gotoSignal", (_accessor, file: string, name: string) =>
  gotoSignalDecl(file, name),
);
monaco.editor.registerCommand("rtl.gotoPort", (_accessor, mod: string, port: string) =>
  gotoPortDecl(mod, port),
);

const hoverProvider: monaco.languages.HoverProvider = {
  async provideHover(model, position) {
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    const hit = findInstanceAt(detailForModel(model), word.word, position.lineNumber);
    if (!hit) return null;
    const rows = await buildPortMapRows(hit.inst.module, hit.inst.connections ?? []);
    return {
      contents: [portMapMarkdown(hit.inst.inst, hit.inst.module, rows, pathFromUri(model.uri))],
      range: new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      ),
    };
  },
};
monaco.languages.registerHoverProvider("verilog", hoverProvider);
monaco.languages.registerHoverProvider("vhdl", hoverProvider);

// 补全：当前文件信号、语法关键字、模块名（选中时懒解析端口出例化骨架）
registerCompletionProviders({
  allDefs: () => state.index.allDefs(),
  modulePorts,
  moduleParameters,
});

// ---------- Ctrl+Shift+O 文件符号（与侧栏大纲共用 extractOutline） ----------

const SYMBOL_KINDS: Record<string, monaco.languages.SymbolKind> = {
  module: monaco.languages.SymbolKind.Module,
  architecture: monaco.languages.SymbolKind.Namespace,
  signal: monaco.languages.SymbolKind.Variable,
  process: monaco.languages.SymbolKind.Method,
  function: monaco.languages.SymbolKind.Function,
  instance: monaco.languages.SymbolKind.Struct,
};

const symbolProvider: monaco.languages.DocumentSymbolProvider = {
  provideDocumentSymbols(model) {
    const items = extractOutline(model.getValue(), model.uri.path);
    const total = model.getLineCount();
    return items.map((it, idx) => {
      // 范围延伸到下一个符号起点；同一条目同行（多信号声明）时收敛为单行
      const next = idx + 1 < items.length ? items[idx + 1].line : total + 1;
      const endLine = Math.max(it.line, next - 1);
      return {
        name: it.name,
        detail: OUTLINE_KIND_LABELS[it.kind],
        kind: SYMBOL_KINDS[it.kind] ?? monaco.languages.SymbolKind.Variable,
        range: new monaco.Range(it.line, 1, endLine, 1),
        selectionRange: new monaco.Range(it.line, 1, it.line, 1),
        tags: [],
      };
    });
  },
};
monaco.languages.registerDocumentSymbolProvider("verilog", symbolProvider);
monaco.languages.registerDocumentSymbolProvider("vhdl", symbolProvider);

let mappingRequest = 0;
let mappingStale = false;
let mappingData: PortMapData | undefined;
let mappingTarget: { file: string; line?: number; instance: string } | undefined;

function renderMapping(): void {
  if (!mappingData) return;
  const { module: moduleName, file, line } = mappingData;
  const panel = document.getElementById("mapping")!;
  const def = state.index.resolve(moduleName);
  renderPortMap(panel, mappingData, {
    close: () => { setMappingVisible(false); document.getElementById("map-action")!.focus(); },
    definition: () => { if (def) void navigateTo(def.file, def.line); },
    origin: () => void navigateTo(file, line),
    port: (name) => gotoPortDecl(moduleName, name),
    signal: (name) => gotoSignalDecl(file, name),
  });
  if (mappingStale) {
    const refresh = document.createElement("button"); refresh.className = "text-button result-stale";
    refresh.textContent = "源码已变化，刷新端口连接";
    refresh.onclick = () => void loadPortMap(file, line, mappingData?.instance);
    panel.insertBefore(refresh, panel.children[1]);
  }
}

/** 光标位于例化语句任意一行即可；树选择可显式指定父文件中的实例。 */
async function loadPortMap(file?: string, line?: number, instance?: string): Promise<void> {
  if (document.getElementById("mapping")!.hidden) return;
  const request = ++mappingRequest;
  const ed = activeGroup().editor;
  const model = ed.getModel();
  const modules = file ? parseFileDetail(fileContent(file) ?? "", file) : model ? detailForModel(model) : [];
  const at = line ?? ed.getPosition()?.lineNumber ?? 1;
  const hit = resolveInstanceAt(modules, at, instance);
  if (!hit) {
    if (mappingData) { statusbar.hint("当前位置没有可识别的例化，保留原端口连接。"); return; }
    const panel = document.getElementById("mapping")!;
    panel.replaceChildren();
    const head = document.createElement("div"); head.className = "panel-head"; head.textContent = "端口映射";
    const close = document.createElement("button"); close.className = "icon-button"; close.setAttribute("aria-label", "收起端口映射");
    setIcon(close, "close"); close.onclick = () => setMappingVisible(false); head.append(close);
    const note = document.createElement("p"); note.className = "mapping-note"; note.textContent = "点击层级树中的例化，或将光标放到例化语句内，查看端口连接。";
    panel.append(head, note);
    return;
  }
  const rows = await buildPortMapRows(hit.module, hit.connections ?? []);
  if (request !== mappingRequest || document.getElementById("mapping")!.hidden) return;
  const def = state.index.resolve(hit.module);
  mappingData = { instance: hit.inst, module: hit.module, rows, file: file ?? pathFromUri(model!.uri), line: hit.line, hasDefinition: !!def && !def.isIp };
  mappingStale = false;
  renderMapping();
}

function setMappingVisible(visible: boolean): void {
  if (!visible) mappingRequest++;
  document.getElementById("mapping")!.hidden = !visible;
  document.getElementById("map-action")!.setAttribute("aria-expanded", String(visible));
}

function togglePortMap(): void {
  const panel = document.getElementById("mapping")!;
  if (!panel.hidden) setMappingVisible(false);
  else { setMappingVisible(true); if (!mappingData) void loadPortMap(mappingTarget?.file, mappingTarget?.line, mappingTarget?.instance); }
}

function selectTreeInstance(node: TreeNode): void {
  treeContextPath = node.key;
  if (!node.instFile || node.instLine === undefined) return;
  mappingTarget = { file: node.instFile, line: node.instLine, instance: node.label };
  mappingData = undefined;
  mappingStale = false;
  void loadPortMap(node.instFile, node.instLine, node.label);
}

function markResultsStale(): void {
  signalController.invalidate();
  searchPanel.markStale();
  if (mappingData && !mappingStale) {
    mappingStale = true;
    const panel = document.getElementById("mapping")!, scroll = panel.scrollTop;
    renderMapping(); panel.scrollTop = scroll;
  }
}

// ---------- 按需信号链：显式追踪，浏览源码不改变目标 ----------
let treeContextPath: string | undefined;
const signalController = createSignalController(document.getElementById("signal-flow")!, {
  editor: () => activeGroup().editor,
  files: () => state.contents.keys(),
  structures: () => state.structures,
  index: () => state.index,
  topName: () => state.topName,
  instancePath: () => treeContextPath,
  fileContent,
  isOpen: file => groups.some(group => !!group.tabs.findTab(file)),
  close: () => { setSignalFlowVisible(false); document.getElementById("flow-action")!.focus(); },
  navigate: (file, line) => navigateTo(file, line),
  hint: message => statusbar.hint(message),
});

function setSignalFlowVisible(visible: boolean): void {
  document.getElementById("signal-flow")!.hidden = !visible;
  document.getElementById("flow-action")!.setAttribute("aria-expanded", String(visible));
}

function toggleSignalFlow(): void {
  const visible = document.getElementById("signal-flow")!.hidden;
  setSignalFlowVisible(visible);
}

/** 「查看例化处」结果面板：多处例化时列出父模块与位置，点击跳转。 */
function showInstancePanel(name: string, sites: InstanceSite[]): void {
  document.getElementById("ref-panel")?.remove();
  const panel = document.createElement("div");
  panel.id = "ref-panel";

  const head = document.createElement("div");
  head.className = "ip-panel-head";
  const title = document.createElement("span");
  title.textContent = `${name} 被例化于 ${sites.length} 处`;
  const close = document.createElement("span");
  close.className = "ip-panel-close";
  setIcon(close, "close");
  close.addEventListener("click", () => panel.remove());
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "ip-panel-body";
  for (const site of sites) {
    const row = document.createElement("div");
    row.className = "ref-row";
    const parent = document.createElement("span");
    parent.className = "ref-parent";
    parent.textContent = site.parent;
    const loc = document.createElement("span");
    loc.className = "ref-loc";
    loc.textContent = `${displayPath(site.file)}:${site.line}`;
    row.append(parent, loc);
    row.addEventListener("click", () => void navigateTo(site.file, site.line));
    body.appendChild(row);
  }
  panel.appendChild(body);
  document.getElementById("main-area")!.appendChild(panel);
}

/**
 * 编辑器动作全局注册（monaco.editor.addEditorAction，只注册一次）：
 * run 收到的 ed 是当前聚焦的编辑器实例，天然适配分屏；
 * 不能用 ed.addAction 在两组各注册同 id 动作，会让按键分发失效。
 */
function registerEditorActions(): void {
  registerColumnActions();
  monaco.editor.addEditorAction({ id: "rtl.signal-flow", label: "追踪此信号", contextMenuGroupId: "navigation", run: ed => { focusGroup(groups.findIndex(g => g.editor === ed)); setSignalFlowVisible(true); return signalController.analyze(); } });
  monaco.editor.addEditorAction({
    id: "rtl.view-portmap",
    label: "查看端口连接",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyK],
    precondition: "editorTextFocus",
    contextMenuGroupId: "navigation",
    run: () => {
      setMappingVisible(true);
      void loadPortMap();
    },
  });

  // 自动换行切换：Monaco standalone 自带 editor.action.toggleWordWrap（含 Alt+Z），
  // 存在时只补右键菜单入口，不再绑快捷键避免双触发。
  {
    const builtin = editor.getAction("editor.action.toggleWordWrap");
    monaco.editor.addEditorAction({
      id: "rtl.toggle-word-wrap",
      label: "切换自动换行 (Alt+Z)",
      contextMenuGroupId: "view",
      contextMenuOrder: 1,
      ...(builtin ? {} : { keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ] }),
      run: (ed) => {
        const act = ed.getAction("editor.action.toggleWordWrap");
        if (act) {
          void act.run();
          return;
        }
        const on = ed.getOption(monaco.editor.EditorOption.wordWrap) !== "off";
        ed.updateOptions({ wordWrap: on ? "off" : "on" });
      },
    });
  }

  // 查找引用：选中或光标下的标识符 → 全局搜索（整词），Shift+F12 / 右键菜单。
  monaco.editor.addEditorAction({
    id: "rtl.find-references",
    label: "查找引用 (Shift+F12)",
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1,
    run: (ed) => {
      const model = ed.getModel();
      if (!model) return;
      const sel = ed.getSelection();
      const selText = sel ? model.getValueInRange(sel) : "";
      const pos = ed.getPosition();
      const word = IDENT_RE.test(selText)
        ? selText
        : pos
          ? model.getWordAtPosition(pos)?.word
          : undefined;
      if (!word) {
        statusbar.hint("光标不在标识符上");
        return;
      }
      searchPanel.searchAll(word, model?.getLanguageId() !== "vhdl");
    },
  });

  // 分屏：当前文件在另一侧视图打开（共享 model，编辑互通）。
  monaco.editor.addEditorAction({
    id: "rtl.split-other",
    label: "在另一侧视图打开 (Ctrl+Alt+V)",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyV],
    precondition: "editorTextFocus",
    contextMenuGroupId: "view",
    contextMenuOrder: 0,
    run: () => void openInOtherGroup(),
  });
}

// ---------- 编辑组（分屏：最多左右两组，同文件共享 model） ----------

const workspace = createEditorWorkspace([editor, editor2], {
  cachedFile: file => state.contents.get(file),
  onFileChanged: (path, content, encoding, mtime) => {
    // 独立打开、新建／另存为的文件由扫描接纳，不绕过 EDA 与 IP 边界。
    if (!state.contents.has(path)) return;
    if (state.contents.get(path)?.content !== content) markResultsStale();
    state.contents.set(path, { content, encoding, mtime });
    updateStructure(path, content);
  },
  onActiveChange: group => {
    const tab = group.tabs.activeTab;
    statusbar.update(tab?.model.getLanguageId() ?? null, tab?.encoding ?? null);
    const pos = tab && group.editor.getPosition();
    if (pos) statusbar.setPosition(`行 ${pos.lineNumber}, 列 ${pos.column}`);
    refreshOutline();
  },
  onContentChange: active => { markResultsStale(); if (active) refreshOutline(); },
  onCursorChange: line => {
    statusbar.setBreadcrumb(breadcrumbAt(currentOutline, line));
    outline.highlightLine(line);
  },
  onSplit: () => { setMappingVisible(false); setSignalFlowVisible(false); },
  hint: message => statusbar.hint(message),
});
const { groups, activeGroup, focusGroup, navigateTo, navBack, navForward,
  ensureSplit, collapseSplit, openInOtherGroup, openFile: openProjectFile } = workspace;
registerEditorActions();
window.addEventListener("pagehide", () => workspace.dispose(), { once: true });

// Tauri 宿主负责标题栏拖动与双击最大化；纯浏览器预览不显示不可用的窗口按钮。
if (!new URLSearchParams(location.search).has("e2e") && (await import("@tauri-apps/api/core")).isTauri()) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const disposeControls = await attachWindowControls(document.getElementById("window-controls")!, getCurrentWindow(), async () => {
      if (document.querySelector(".choice-overlay")) return false;
      return TabManager.confirmExit(groups.map(group => group.tabs));
    }, message => statusbar.hint(message));
    window.addEventListener("pagehide", disposeControls, { once: true });
  } catch (error) { statusbar.hint(`窗口控制初始化失败：${String(error)}`); }
}

function updateStructure(path: string, content: string): void {
  if (!state.folder) return;
  // 只索引当前工程内的文件：换工程后残留旧标签的保存/重载不得写入新索引（Windows 路径大小写不敏感）
  if (!path.toLowerCase().startsWith(state.folder.toLowerCase() + "/") || !state.structures.has(path)) return;
  state.structures.set(path, scanStructure(content, path));
  rebuildIndex();
  renderTree();
}

function rebuildIndex(): void {
  const index = new ModuleIndex();
  for (const modules of state.structures.values()) {
    index.addStructure(modules);
  }
  for (const ip of state.ips) {
    index.addIp(ip.name, ip.file);
  }
  state.index = index;
}

function renderTree(): void {
  const h: Hierarchy = buildHierarchy(state.index, state.structures, state.topName);
  tree.render(h, state.constraints);
}

// ---------- 进度提示 ----------

function setProgress(text: string): void {
  const el = document.getElementById("progress");
  if (el) el.textContent = text;
}

// ---------- 最近打开的工程 ----------

const RECENT_KEY = "rtl-viewer.recentProjects";

function loadRecents(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    // 存量条目可能来自归一之前的版本，读出时统一
    return Array.isArray(list) ? [...new Set(list.filter((p) => typeof p === "string").map(normalizePath))] : [];
  } catch {
    return [];
  }
}

function saveRecents(list: string[]): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
}

const recentMenu = new RecentMenu(document.getElementById("sidebar")!, {
  onPick: (path) => void openRecent(path),
  onRemove: (path) => {
    saveRecents(loadRecents().filter((p) => p !== path));
    recentMenu.setItems(loadRecents());
  },
});
recentMenu.setItems(loadRecents());

function addRecent(path: string): void {
  const list = loadRecents().filter((p) => p !== path);
  list.unshift(path);
  saveRecents(list);
  recentMenu.setItems(list);
}

/** 打开最近工程条目：先确认目录还在，不在了提示并移除。 */
async function openRecent(path: string): Promise<void> {
  if (await pathExists(path)) {
    await openFolder(path);
  } else {
    statusbar.hint("文件夹已不存在");
    saveRecents(loadRecents().filter((p) => p !== path));
    recentMenu.setItems(loadRecents());
  }
}

// ---------- 打开工程 ----------

/** 拖入窗口的路径：是文件夹则打开为工程，否则提示。 */
async function handleDroppedPaths(paths: string[]): Promise<void> {
  const dir = paths[0] ? normalizePath(paths[0]) : "";
  if (!dir) return;
  if (await isDirectory(dir)) {
    await openFolder(dir);
  } else {
    statusbar.hint("请拖入源码文件夹");
  }
}

// OS 级拖放（Tauri 窗口事件）；纯浏览器 e2e 环境注册失败时静默跳过
try {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") void handleDroppedPaths(event.payload.paths);
  });
} catch {
  // 非 Tauri 环境无窗口事件
}

async function openProject(): Promise<void> {
  const folder = await openFolderDialog();
  if (folder) await openFolder(folder);
}

let preparingProject = false;

async function openFolder(folder: string): Promise<void> {
  if (preparingProject) return;
  preparingProject = true;
  try { if (!(await workspace.closeAll())) return; }
  finally { preparingProject = false; }
  watcher.stop();
  state.folder = folder;
  updateProjectChrome();
  setMappingVisible(false);
  document.getElementById("mapping")!.replaceChildren();
  mappingData = undefined;
  mappingStale = false;
  mappingTarget = undefined;
  setSignalFlowVisible(false);
  signalController.reset();
  treeContextPath = undefined;
  tree.reset();
  addRecent(folder);
  state.topName = undefined;
  state.structures.clear();
  state.contents.clear();
  state.ips = [];
  state.constraints = [];
  portMapLoader.reset();
  workspace.resetHistory();
  searchPanel.clear();

  await projectScanner.scan(folder);
}

function updateProjectChrome(): void {
  const name = state.folder.split(/[\\/]/).filter(Boolean).pop() || "未打开工程";
  for (const id of ["project-name", "project-title"]) {
    const el = document.getElementById(id)!;
    el.textContent = name;
    el.title = state.folder;
  }
  document.getElementById("sidebar-foot")!.textContent = state.folder ? "本地工程 · " + name : "本地工程";
  document.getElementById("sidebar-foot")!.title = state.folder;
}

// ---------- 外部变更监视 ----------

const watcher = createExternalWatcher({
  folder: () => state.folder,
  contents: state.contents,
  structures: state.structures,
  ips: () => state.ips,
  setIps: (ips) => { state.ips = ips; },
  constraints: () => state.constraints,
  setConstraints: (constraints) => { state.constraints = constraints; },
  tabs: groups.map((g) => g.tabs),
  hint: (message) => statusbar.hint(message),
  markResultsStale,
  updateStructure,
  rebuildIndex,
  renderTree,
});

const projectScanner = createProjectScanner({
  contents: state.contents,
  structures: state.structures,
  setIps: ips => { state.ips = ips; },
  setConstraints: files => { state.constraints = files; },
  progress: setProgress,
  complete: () => { rebuildIndex(); setProgress(""); renderTree(); watcher.start(); },
  failed: async error => {
    state.folder = "";
    updateProjectChrome(); setProgress(""); rebuildIndex(); renderTree();
    await appAlert(`打开工程失败：${String(error)}`);
  },
});
window.addEventListener("pagehide", () => { projectScanner.cancel(); watcher.stop(); }, { once: true });

// ---------- 树节点打开 ----------

// 跳转到定义：目标文件未打开时 standalone Monaco 默认静默失败，注册 opener 接管打开
monaco.editor.registerEditorOpener({
  openCodeEditor: (_source, resource, selectionOrPosition) => {
    const path = pathFromUri(resource);
    if (!state.folder || !path.toLowerCase().startsWith(state.folder.toLowerCase() + "/")) {
      return false;
    }
    const line =
      selectionOrPosition && "startLineNumber" in selectionOrPosition
        ? selectionOrPosition.startLineNumber
        : selectionOrPosition?.lineNumber;
    void navigateTo(path, line);
    return true;
  },
});

async function openTreeNode(node: TreeNode): Promise<void> {
  selectTreeInstance(node);
  // 单击进模块定义（直觉操作）；例化点由节点行的跳例化图标进入
  if (node.file) {
    await navigateTo(node.file, node.line);
    return;
  }
  // unresolved 节点无定义位置，退到例化点
  if (node.instFile && node.instLine !== undefined) {
    await navigateTo(node.instFile, node.instLine);
  }
}

// ---------- 分栏拖拽 ----------

function initSplitter(): void {
  const splitter = document.getElementById("splitter")!;
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarEl.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      const width = Math.min(Math.max(startWidth + ev.clientX - startX, 160), 600);
      sidebarEl.style.width = `${width}px`;
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

initSplitter();

// ---------- 全局快捷键与编辑联动 ----------

registerAppShortcuts({
  newFile: () => activeGroup().tabs.newFile(preferredNewFileType(), state.folder),
  openFile: async () => {
    const idx = workspace.activeIndex;
    const file = await openFileDialog(activeGroup().tabs.activeTab?.path || state.folder || undefined);
    if (file) await openProjectFile(file, undefined, idx);
  },
  openProject,
  save: () => activeGroup().tabs.save(),
  saveAs: () => activeGroup().tabs.saveAs(),
  saveAll: workspace.saveAll,
  close: async () => {
    const tab = activeGroup().tabs.activeTab;
    if (tab) await activeGroup().tabs.close(tab);
  },
  closeAll: () => workspace.closeAll(),
  reload: () => activeGroup().tabs.reload(),
  cycleTab: delta => activeGroup().tabs.cycleTab(delta),
  switchView: workspace.switchView,
  recent: () => recentMenu.toggle(),
  search: () => searchPanel.focus(),
  back: navBack,
  forward: navForward,
  error: error => statusbar.hint(`快捷操作失败：${String(error)}`),
});
