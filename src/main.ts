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
import { createProjectSearch } from "./app/project-search";
import { scanStructure } from "./parser";
import type { ModuleInfo, IpInfo } from "./parser";
import { openFolderDialog, openFileDialog, pathExists, showInFolder, isDirectory, normalizePath, runSyntaxCheck, cancelSyntaxCheck, saveReportDialog, writeFile, type SyntaxCheckResult } from "./ipc";
import { ProblemPanel } from "./ui/problems";
import { syncProblemMarkers } from "./app/problem-markers";
import { syntaxReportHtml, syntaxReportCsv } from "./app/syntax-report";
import { registerAppShortcuts } from "./ui/shortcuts";
import { initMonaco, createEditor, monaco } from "./editor/monaco";
import { registerCompletionProviders } from "./editor/completion";
import { TabManager } from "./editor/tabs";
import { HierarchyTree } from "./ui/tree";
import { StatusBar } from "./ui/statusbar";
import { OutlineView } from "./ui/outline";
import { SearchPanel } from "./ui/search";
import { RecentMenu } from "./ui/recent";
import { appAlert, choiceDialog } from "./ui/dialog";
import { createNewFileControl, preferredNewFileType } from "./ui/new-file";
import { createEditorWorkspace } from "./app/editor-workspace";
import { openColumnEditor, registerColumnActions } from "./editor/column-editor";
import { registerEditorAction } from "./editor/actions";
import { attachWindowControls } from "./ui/window-controls";
import { initTheme } from "./ui/theme";
import { setIcon } from "./ui/icons";
import type { IconName } from "./ui/icons";
import { pathFromUri } from "./editor/file-path";
import { createSignalController } from "./app/signal-controller";
import { createModuleMetadataLoader } from "./app/module-metadata";
import { createProjectScanner } from "./app/project-scanner";
import { isGeneratedNetlist } from "./app/project-files";
import { verilogStub } from "./app/syntax-stubs";
import { loadSyntaxOptions, saveSyntaxOptions, configuredPath, validateSyntaxOptions } from "./app/syntax-options";
import { showSyntaxOptionsDialog } from "./ui/syntax-options";
import { createFactsScheduler } from "./app/facts-scheduler";
import { StatsPanel } from "./ui/stats";
import { emptySyntaxCheckOptions } from "./ipc";
import { createExternalWatcher, type CachedFile } from "./app/watcher";
import { attachSidebarWidth } from "./ui/sidebar-width";
import { BottomPanels } from "./ui/bottom-panels";
import { showCtxMenu } from "./ui/menu";
import { filePathKey, indexedFilePath } from "./file-path";
import type { FileVersion } from "./app/module-metadata";

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
  autoTop: undefined as string | undefined,
};

const sidebarEl = document.getElementById("sidebar")!;
const editorContainer = document.getElementById("editor-container")!;
const statusbarEl = document.getElementById("statusbar")!;
attachSidebarWidth(sidebarEl, document.getElementById("splitter")!);

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
  openWrap.id = "open-project-control";
  const openBtn = action("打开", "folder", () => {
    recentMenu.close();
    const rect = openBtn.getBoundingClientRect();
    showCtxMenu(rect.left, rect.bottom, [
      { label: "打开文件… (Ctrl+O)", action: () => void openSourceFile() },
      { label: "打开文件夹… (Ctrl+Alt+O)", action: () => void openProject() },
      { label: "最近工程… (Ctrl+Alt+R)", action: () => window.setTimeout(() => recentMenu.toggle(), 0) },
    ], openBtn);
  });
  openBtn.className = "btn btn-primary open-menu-button";
  openBtn.title = "打开文件、文件夹或最近工程";
  openBtn.setAttribute("aria-haspopup", "menu");
  openBtn.addEventListener("click", event => event.stopPropagation());
  const openArrow = document.createElement("span"); setIcon(openArrow, "chevron-down"); openBtn.append(openArrow);
  openWrap.append(openBtn);
  const newBtn = createNewFileControl(extension => activeGroup().tabs.newFile(extension, state.folder));
  const saveBtn = action("保存", "save", () => void activeGroup().tabs.save());
  saveBtn.title = "保存 (Ctrl+S)";
  const editBtn = action("编辑", "chevron-down", () => {
    const rect = editBtn.getBoundingClientRect();
    showCtxMenu(rect.left, rect.bottom, [
      { label: "列编辑 (Alt+C)", action: () => void openColumnEditor(activeGroup().editor) },
      { label: "另存为 (Ctrl+Alt+S)", action: () => void activeGroup().tabs.saveAs() },
      { label: "全部保存 (Ctrl+Shift+S)", action: () => void workspace.saveAll() },
    ], editBtn);
  });
  editBtn.setAttribute("aria-haspopup", "menu");
  editBtn.addEventListener("click", event => event.stopPropagation());
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
  const splitBtn = action("视图", "split", () => {
    const rect = splitBtn.getBoundingClientRect();
    workspace.showViewMenu(rect.left, rect.bottom);
  });
  splitBtn.id = "split-action";
  splitBtn.addEventListener("click", event => event.stopPropagation());
  splitBtn.title = "双视图与布局；Ctrl+Alt+V 克隆，F8 切换焦点";
  splitBtn.setAttribute("aria-haspopup", "menu");
  const flowBtn = action("信号链", "ports", toggleSignalFlow);
  flowBtn.id = "flow-action";
  flowBtn.title = "信号链分析";
  flowBtn.setAttribute("aria-expanded", "false");
  const statsBtn = action("统计", "stats", () => setStatsVisible(document.getElementById("stats-root")!.hidden));
  statsBtn.id = "stats-action";
  statsBtn.title = "工程代码、结构与检查统计";
  statsBtn.setAttribute("aria-expanded", "false");
  const checkBtn = action("检查", "check", () => void runProjectSyntaxCheck());
  checkBtn.id = "syntax-check-action";
  checkBtn.title = "使用 Verilator／GHDL 检查当前工程";
  end.append(searchBtn, splitBtn, flowBtn, statsBtn, checkBtn);
  bar.append(openWrap, newBtn, saveBtn, editBtn, end);
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
const editor = initMonaco(editorContainer, (name) => state.index.resolve(name), fileContent);
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
    if (runningSyntaxRequest) syntaxChangedWhileRunning = true;
    problemPanel.markStale();
    renderTree();
    factsDone = factsTotal = 0;
    refreshFactsViews();
    void factsScheduler.start();
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

const projectSearch = createProjectSearch();
window.addEventListener("pagehide", projectSearch.cancel, { once: true });
const searchPanel = new SearchPanel(searchRootEl, {
  onClose: () => { setSearchVisible(false); activeGroup().editor.focus(); },
  onFocus: () => setSearchVisible(true, false),
  onSearch: (query, options) => projectSearch.search([...state.contents].map(([path, cached]) => [path, { content: fileContent(path) ?? cached.content }]), query, options),
  onCancel: projectSearch.cancel,
  onOpen: (file, line, column, length) => { bottomPanels.restoreEditor(); void navigateTo(file, line, column, length); },
  displayPath,
});

let projectReady = false;
let syntaxSerial = 0;
let runningSyntaxRequest = 0;
let lastSyntaxResult: SyntaxCheckResult | undefined;
let syntaxOptions = { ...emptySyntaxCheckOptions };
const problemPanel = new ProblemPanel(document.getElementById("problem-root")!, {
  onRun: () => void runProjectSyntaxCheck(),
  onConfigure: () => void configureSyntaxCheck(),
  onCancel: () => { if (runningSyntaxRequest) void cancelSyntaxCheck(runningSyntaxRequest); },
  onScopeChange: setAnalysisScope,
  onExport: format => void exportSyntaxReport(format),
  onOpen: diagnostic => { bottomPanels.restoreEditor(); void navigateTo(diagnostic.file, diagnostic.line, diagnostic.column); },
  onClose: () => { setProblemsVisible(false); activeGroup().editor.focus(); },
});

function refreshProblemMarkers(): void {
  const models = new Map<string, { path: string; model: import("./editor/monaco").monaco.editor.ITextModel }>();
  for (const group of groups) for (const tab of group.tabs.allTabs) {
    if (tab.path) models.set(tab.uriKey, { path: tab.path, model: tab.model });
  }
  syncProblemMarkers(models.values(), (lastSyntaxResult?.diagnostics ?? []).filter(item => inAnalysisScope(item.file)), problemPanel.isStale, problemPanel.builtinDiagnostics);
}

async function configureSyntaxCheck(): Promise<void> {
  if (!state.folder) {
    statusbar.hint("请先打开工程");
    return;
  }
  if (runningSyntaxRequest) {
    statusbar.hint("请先取消当前检查，再修改配置");
    return;
  }
  const next = await showSyntaxOptionsDialog(syntaxOptions, {
    browseInclude: async () => configurationPath(await openFolderDialog()),
    browseLibrary: async () => configurationPath(await openFileDialog(state.folder)),
  });
  if (!next) return;
  syntaxOptions = next;
  saveSyntaxOptions(state.folder, next);
  problemPanel.markStale();
  refreshFactsViews();
}

function configurationPath(file: string | null): string | undefined {
  if (!file) return undefined;
  const normalized = normalizePath(file);
  const root = state.folder.toLowerCase().replace(/\/+$/, "");
  return normalized.toLowerCase().startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

let syntaxChangedWhileRunning = false;

async function runProjectSyntaxCheck(): Promise<boolean> {
  const folder = state.folder;
  if (!folder || !projectReady) {
    statusbar.hint(projectReady ? "请先打开工程" : "工程仍在载入，请稍后运行语法检查");
    return false;
  }
  const optionErrors = validateSyntaxOptions(syntaxOptions);
  if (optionErrors.length) {
    await appAlert(`语法检查配置无效：\n\n${optionErrors.join("\n")}`);
    return false;
  }
  const snapshots = new Map<string, { file: string; content: string; encoding: string }>();
  for (const group of groups) for (const tab of group.tabs.allTabs) {
    if (tab.dirty && tab.path && state.contents.has(indexedFilePath(state.contents, tab.path))) {
      snapshots.set(tab.path, { file: tab.path, content: tab.model.getValue(), encoding: tab.encoding });
    }
  }
  const files = [...new Set([
    ...analysisHdlFiles(),
    ...syntaxOptions.vhdlLibraries.map(mapping => configuredPath(folder, mapping.file)),
  ])];
  if (!files.length) {
    statusbar.hint("当前工程没有可检查的 Verilog／VHDL 文件");
    return false;
  }
  if (runningSyntaxRequest) void cancelSyntaxCheck(runningSyntaxRequest);
  const request = ++syntaxSerial;
  runningSyntaxRequest = request;
  syntaxChangedWhileRunning = false;
  problemPanel.start();
  setProblemsVisible(true);
  refreshFactsViews();
  try {
    const scopedIps = analysisScope === "project" ? state.ips : state.ips.filter(ip => activeTopModules.has(ip.name.toLowerCase()));
    const ipStubs = (await Promise.all(scopedIps.map(async ip => {
      const ports = await modulePorts(ip.name);
      const parameters = await moduleIpParameters(ip.name);
      return { name: ip.name, source: ports.length ? verilogStub(ip.name, ports, parameters) : "" };
    }))).filter(stub => stub.source);
    const vhdlModules = new Map<string, ModuleInfo>();
    for (const file of analysisHdlFiles()) for (const module of state.structures.get(file) ?? []) {
      if (module.vhdl?.entity && !vhdlModules.has(module.name.toLowerCase())) vhdlModules.set(module.name.toLowerCase(), module);
    }
    const vhdlStubs = await Promise.all([...vhdlModules.values()].map(async module => ({
      name: module.name,
      source: verilogStub(module.name, await modulePorts(module.name), moduleParameters(module.name)),
    })));
    const stubs = [...ipStubs, ...vhdlStubs];
    if (request !== syntaxSerial || folder !== state.folder) return false;
    const options = {
      ...syntaxOptions,
      includeDirs: syntaxOptions.includeDirs.map(path => configuredPath(folder, path)),
      vhdlLibraries: syntaxOptions.vhdlLibraries.map(mapping => ({ ...mapping, file: configuredPath(folder, mapping.file) })),
    };
    const result = await runSyntaxCheck(folder, files, options.top || state.topName || state.autoTop, request, progress => {
      if (request === syntaxSerial) problemPanel.update(progress);
    }, stubs, options, [...snapshots.values()]);
    if (request !== syntaxSerial || folder !== state.folder) return false;
    runningSyntaxRequest = 0;
    lastSyntaxResult = result;
    problemPanel.finish(result);
    if (syntaxChangedWhileRunning) problemPanel.markStale();
    refreshFactsViews();
    return !result.cancelled;
  } catch (error) {
    if (request !== syntaxSerial) return false;
    runningSyntaxRequest = 0;
    problemPanel.fail(error);
    refreshFactsViews();
    return false;
  }
}

function cancelProjectSyntaxCheck(): void {
  syntaxSerial++;
  if (runningSyntaxRequest) void cancelSyntaxCheck(runningSyntaxRequest);
  runningSyntaxRequest = 0;
}

async function exportSyntaxReport(format: "html" | "csv"): Promise<void> {
  if (!state.folder || !problemPanel.hasResults) return;
  try {
    if (lastSyntaxResult && problemPanel.isStale) {
      const choice = await choiceDialog("源码或检查配置已变化，外部诊断来自上次快照。", ["重新检查后导出", "导出上次结果", "取消"], 0);
      if (choice < 0 || choice === 2) return;
      if (choice === 0 && !(await runProjectSyntaxCheck())) return;
    }
    const generated = new Date();
    const path = await saveReportDialog(format, `${state.folder}/${reportFileName(state.folder, format, generated)}`);
    if (!path) return;
    const external: SyntaxCheckResult = lastSyntaxResult ?? { requestId: 0, checkedFiles: 0, cancelled: false, backends: [], diagnostics: [] };
    const reportResult = { ...external, diagnostics: [...problemPanel.builtinDiagnostics, ...external.diagnostics.filter(item => inAnalysisScope(item.file))] };
    const content = format === "html" ? syntaxReportHtml(state.folder, reportResult, generated, { options: syntaxOptions, facts: factsScheduler.values().filter(item => inAnalysisScope(item.file)), stale: problemPanel.isStale }) : syntaxReportCsv(reportResult);
    await writeFile(path, content, "utf8");
    statusbar.hint(`检查报告已导出：${path}`);
  } catch (error) {
    statusbar.hint(`导出检查报告失败：${String(error)}`);
  }
}

function reportFileName(folder: string, format: "html" | "csv", date: Date): string {
  const project = folder.split(/[\\/]/).filter(Boolean).pop() || "rtl-project";
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${project}-check-${timestamp}.${format}`;
}

let factsDone = 0, factsTotal = 0;
let analysisScope: "top" | "project" = "top";
let activeTopFiles = new Set<string>();
let activeTopModules = new Set<string>();
let activeTopology: import("./model/hierarchy").TreeNode[] = [];
const statsPanel = new StatsPanel(document.getElementById("stats-root")!, {
  displayPath,
  onOpenFile: (file, line) => { bottomPanels.restoreEditor(); void navigateTo(file, line); },
  onOpenProblems: filter => {
    problemPanel.setDisplayFilter(filter);
    setProblemsVisible(true);
  },
  onScopeChange: setAnalysisScope,
  onClose: () => { setStatsVisible(false); activeGroup().editor.focus(); },
});

let searchWasVisible = false;
const bottomPanels = new BottomPanels(document.getElementById("bottom-panels")!, {
  search: searchRootEl, flow: document.getElementById("signal-flow")!, problems: document.getElementById("problem-root")!, stats: document.getElementById("stats-root")!,
}, () => {
  const searchVisible = bottomPanels.isVisible("search");
  if (searchWasVisible && !searchVisible) searchPanel.cancel();
  searchWasVisible = searchVisible;
  document.getElementById("search-action")!.setAttribute("aria-expanded", String(searchVisible));
  document.getElementById("flow-action")!.setAttribute("aria-expanded", String(bottomPanels.isVisible("flow")));
  document.getElementById("stats-action")!.setAttribute("aria-expanded", String(bottomPanels.isVisible("stats")));
});

function setSearchVisible(visible: boolean, focus = true): void {
  if (visible) bottomPanels.show("search");
  else bottomPanels.hide("search");
  if (visible && focus) searchPanel.focus();
}

function setProblemsVisible(visible: boolean): void {
  if (visible) bottomPanels.show("problems");
  else bottomPanels.hide("problems");
}

function setStatsVisible(visible: boolean): void {
  if (visible) bottomPanels.show("stats");
  else bottomPanels.hide("stats");
}

// ---------- 按需模块元数据（补全与 IP stub） ----------

const moduleMetadataLoader = createModuleMetadataLoader({
  ips: () => state.ips,
  resolveModule: (name) => state.index.resolve(name),
  fileContent,
  fileToken,
});
const { modulePorts, moduleIpParameters, moduleParameters } = moduleMetadataLoader;

/** 打开中的标签页用当前缓冲区（含未保存修改），否则用扫描缓存。两组标签都查。 */
function fileContent(file: string): string | undefined {
  for (const g of groups) {
    const tab = g.tabs.findTab(file);
    if (tab) return tab.model.getValue();
  }
  return state.contents.get(indexedFilePath(state.contents, file))?.content;
}

/** 与 fileContent 同源的缓存令牌；重建的 model 即使版本相同也必须失效。 */
function fileToken(file: string): FileVersion {
  for (const g of groups) {
    const tab = g.tabs.findTab(file);
    if (tab) return { identity: tab.model, version: tab.model.getVersionId() };
  }
  const path = indexedFilePath(state.contents, file);
  return { identity: path, version: state.contents.get(path)?.content };
}

// 补全：当前文件信号、语法关键字、模块名（选中时懒解析端口出例化骨架）
registerCompletionProviders({
  allDefs: () => state.index.allDefs(),
  modulePorts,
  moduleParameters,
});

// ---------- Ctrl+Shift+O 文件符号（与侧栏大纲共用 extractOutline） ----------

const IDENT_RE = /^[A-Za-z_]\w*$/;

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

function selectTreeInstance(node: TreeNode): void {
  treeContextPath = node.key;
}

function markResultsStale(): void {
  signalController.invalidate();
  searchPanel.markStale();
  if (runningSyntaxRequest) syntaxChangedWhileRunning = true;
  problemPanel.markStale();
  refreshProblemMarkers();
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
  navigate: (file, line) => { bottomPanels.restoreEditor(); return navigateTo(file, line); },
  hint: message => statusbar.hint(message),
});
bottomPanels.attachFlowHeader(document.querySelector<HTMLElement>("#signal-flow .flow-head")!);

function setSignalFlowVisible(visible: boolean): void {
  if (visible) bottomPanels.show("flow");
  else bottomPanels.hide("flow");
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
 * 全局命令处理菜单与键位；每组另注册命令面板入口，沿用所属编辑器分发。
 */
function registerEditorActions(): void {
  registerColumnActions();
  registerEditorAction({ id: "rtl.signal-flow", label: "追踪此信号", contextMenuGroupId: "navigation", run: ed => { focusGroup(groups.findIndex(g => g.editor === ed)); setSignalFlowVisible(true); return signalController.analyze(); } });
  // 自动换行切换：Monaco standalone 自带 editor.action.toggleWordWrap（含 Alt+Z），
  // 存在时只补右键菜单入口，不再绑快捷键避免双触发。
  {
    const builtin = editor.getAction("editor.action.toggleWordWrap");
    registerEditorAction({
      id: "rtl.toggle-word-wrap",
      label: "切换自动换行",
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

  // 同名文本：选中或光标下的标识符 → 全局搜索（整词），Shift+F12 / 右键菜单。
  registerEditorAction({
    id: "rtl.find-references",
    label: "查找同名文本",
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

  registerEditorAction({
    id: "rtl.move-other", label: "移动到另一视图", contextMenuGroupId: "view", contextMenuOrder: 0,
    run: () => { const tab = activeGroup().tabs.activeTab; if (tab) return workspace.transferTab(workspace.activeIndex, tab, false); },
  });
  // 克隆共享 model，两个视图保留各自的阅读状态。
  registerEditorAction({
    id: "rtl.split-other",
    label: "克隆到另一视图",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyV],
    keybindingContext: "editorTextFocus",
    contextMenuGroupId: "view",
    contextMenuOrder: 1,
    run: () => void openInOtherGroup(),
  });
}

// ---------- 编辑组（两个视图，同文件共享 model） ----------

const workspace = createEditorWorkspace([editor, editor2], {
  cachedFile: file => state.contents.get(indexedFilePath(state.contents, file)),
  onFileChanged: (path, content, encoding, mtime) => {
    path = indexedFilePath(state.contents, path);
    // 独立打开、新建／另存为的文件由扫描接纳，不绕过 EDA 与 IP 边界。
    if (!state.contents.has(path)) return;
    if (state.contents.get(path)?.content !== content) markResultsStale();
    state.contents.set(path, { content, encoding, mtime });
    updateStructure(path, content);
    if (inAnalysisScope(path)) void factsScheduler.refresh(path, content);
  },
  onActiveChange: group => {
    bottomPanels.restoreEditor();
    const tab = group.tabs.activeTab;
    statusbar.update(tab?.model.getLanguageId() ?? null, tab?.encoding ?? null);
    const pos = tab && group.editor.getPosition();
    if (pos) statusbar.setPosition(`行 ${pos.lineNumber}，列 ${pos.column}`);
    refreshOutline();
    refreshProblemMarkers();
  },
  onContentChange: active => { markResultsStale(); if (active) { refreshOutline(); scheduleFactsRefresh(); } },
  onCursorChange: line => {
    statusbar.setBreadcrumb(breadcrumbAt(currentOutline, line));
    outline.highlightLine(line);
  },
  hint: message => statusbar.hint(message),
  projectFolder: () => state.folder,
  openFolder: () => void openProject(),
  openSourceFile: () => void openSourceFile(),
  openSearch: () => setSearchVisible(true),
  newFile: () => void activeGroup().tabs.newFile(preferredNewFileType(), state.folder),
});
const { groups, activeGroup, focusGroup, navigateTo, navBack, navForward,
  openInOtherGroup, openFile: openProjectFile } = workspace;
function refreshFactsViews(): void {
  const files = analysisHdlFiles();
  const facts = factsScheduler.values().filter(item => inAnalysisScope(item.file));
  const diagnostics = factsScheduler.diagnosticValues().filter(item => inAnalysisScope(item.file));
  problemPanel.setScope(analysisScope, state.topName || state.autoTop);
  problemPanel.setBuiltins(diagnostics, factsDone > 0);
  statsPanel.render({
    facts,
    files,
    diagnostics: [...diagnostics, ...(lastSyntaxResult?.diagnostics ?? []).filter(item => inAnalysisScope(item.file))],
    done: factsDone,
    total: factsTotal,
    external: lastSyntaxResult,
    running: runningSyntaxRequest !== 0,
    stale: problemPanel.isStale,
    scope: analysisScope,
    topName: state.topName || state.autoTop,
    topology: activeTopology,
  });
  refreshProblemMarkers();
}

function setAnalysisScope(scope: "top" | "project"): void {
  if (analysisScope === scope) return;
  analysisScope = scope;
  if (runningSyntaxRequest) syntaxChangedWhileRunning = true;
  problemPanel.markStale();
  factsDone = factsTotal = 0;
  refreshFactsViews();
  void factsScheduler.start();
}

function inAnalysisScope(file: string): boolean {
  return analysisScope === "project" || !activeTopFiles.size || activeTopFiles.has(filePathKey(file));
}

function analysisHdlFiles(): string[] {
  return projectHdlFiles().filter(inAnalysisScope);
}

function projectHdlFiles(): string[] {
  return [...state.contents.keys()].filter(file => /\.(?:v|sv|vh|svh|vhd|vhdl)$/i.test(file));
}

const factsScheduler = createFactsScheduler({
  files: () => analysisHdlFiles().map(file => ({ file, content: fileContent(file) ?? state.contents.get(file)!.content })),
  priorityFile: () => activeGroup().tabs.activeTab?.path,
  result: refreshFactsViews,
  progress: (done, total) => { factsDone = done; factsTotal = total; refreshFactsViews(); },
  complete: () => undefined,
});
let factsRefreshTimer: number | undefined;
function scheduleFactsRefresh(): void {
  const tab = activeGroup().tabs.activeTab;
  if (!tab?.path || !state.contents.has(indexedFilePath(state.contents, tab.path)) || !inAnalysisScope(tab.path)) return;
  window.clearTimeout(factsRefreshTimer);
  factsRefreshTimer = window.setTimeout(() => void factsScheduler.refresh(tab.path, tab.model.getValue()), 400);
}
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
  if (isGeneratedNetlist(path, content)) {
    state.structures.delete(path); state.contents.delete(path);
  } else state.structures.set(path, scanStructure(content, path));
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
  state.autoTop = h.autoTop;
  activeTopology = h.tops;
  activeTopModules = new Set<string>();
  const pending = h.tops.length ? [h.tops[0]] : [];
  while (pending.length) {
    const node = pending.pop()!;
    const key = node.moduleName.toLowerCase();
    if (activeTopModules.has(key)) continue;
    activeTopModules.add(key);
    pending.push(...node.children);
  }
  activeTopFiles = new Set<string>();
  for (const [file, modules] of state.structures) {
    if (modules.some(module => activeTopModules.has(module.name.toLowerCase()))) activeTopFiles.add(filePathKey(file));
  }
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
  cancelProjectSyntaxCheck();
  window.clearTimeout(factsRefreshTimer);
  factsScheduler.clear();
  projectReady = false;
  lastSyntaxResult = undefined;
  problemPanel.clear();
  setProblemsVisible(false);
  setStatsVisible(false);
  factsDone = factsTotal = 0;
  analysisScope = "top";
  activeTopFiles.clear();
  activeTopModules.clear();
  activeTopology = [];
  statsPanel.render({ facts: [], files: [], diagnostics: [], done: 0, total: 0, running: false, stale: false, scope: "top" });
  state.folder = folder;
  syntaxOptions = loadSyntaxOptions(folder);
  updateProjectChrome();
  workspace.refreshChrome();
  setSignalFlowVisible(false);
  signalController.reset();
  treeContextPath = undefined;
  tree.reset();
  addRecent(folder);
  state.topName = undefined;
  state.autoTop = undefined;
  state.structures.clear();
  state.contents.clear();
  state.ips = [];
  state.constraints = [];
  moduleMetadataLoader.reset();
  workspace.resetHistory();
  searchPanel.clear();

  await projectScanner.scan(folder);
}

function updateProjectChrome(): void {
  document.querySelectorAll<HTMLButtonElement>("#open-project-control button").forEach(button => {
    button.classList.toggle("btn-primary", !state.folder);
    button.classList.toggle("btn-ghost", !!state.folder);
  });
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
  complete: issues => {
    projectReady = true;
    rebuildIndex(); renderTree(); watcher.start();
    setProgress(issues.length ? `部分载入：${issues.length} 项失败` : "");
    void factsScheduler.start();
    if (issues.length) {
      const details = issues.slice(0, 20).map(issue => `${issue.file}\n${issue.reason}`).join("\n\n");
      void appAlert(`工程已部分载入，${issues.length} 个文件或目录未能读取。已载入的文件仍可使用。\n\n${details}${issues.length > 20 ? `\n\n另有 ${issues.length - 20} 项失败。` : ""}`);
    }
  },
  failed: async error => {
    projectReady = false;
    state.folder = "";
    updateProjectChrome(); workspace.refreshChrome(); setProgress(""); rebuildIndex(); renderTree();
    await appAlert(`打开工程失败：${String(error)}`);
  },
});
window.addEventListener("pagehide", () => { projectScanner.cancel(); watcher.stop(); cancelProjectSyntaxCheck(); factsScheduler.dispose(); }, { once: true });

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

// ---------- 全局快捷键与编辑联动 ----------

async function openSourceFile(): Promise<void> {
  const idx = workspace.activeIndex;
  try {
    const file = await openFileDialog(activeGroup().tabs.activeTab?.path || state.folder || undefined);
    if (file) { bottomPanels.restoreEditor(); await openProjectFile(file, undefined, idx); }
  } catch (error) {
    statusbar.hint(`打开文件失败：${String(error)}`);
  }
}

registerAppShortcuts({
  newFile: () => activeGroup().tabs.newFile(preferredNewFileType(), state.folder),
  openFile: openSourceFile,
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
