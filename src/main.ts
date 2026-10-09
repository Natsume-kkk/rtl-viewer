import "./style.css";
import { ModuleIndex } from "./model";

// E2E 模式：先装 IPC mock 再初始化（invoke 在调用时才读取 __TAURI_INTERNALS__）
if (new URLSearchParams(location.search).has("e2e")) {
  await import("./e2e-mock");
}
import { buildHierarchy, findInstancesOf } from "./model/hierarchy";
import type { Hierarchy, TreeNode, InstanceSite } from "./model/hierarchy";
import { extractOutline, breadcrumbAt, OUTLINE_KIND_LABELS } from "./model/outline";
import type { OutlineItem } from "./model/outline";
import { searchContents } from "./model/search";
import { NavHistory, type NavEntry } from "./model/history";
import { scanStructure, parseFile, parseFileDetail, parseXci } from "./parser";
import type { ModuleInfo, IpInfo, PortInfo, PortConnection } from "./parser";
import { findSignalDeclLine } from "./model/signals";
import { scanFolder, readFile, openFolderDialog, fileStates, pathExists, showInFolder, openDirectory, isDirectory, normalizePath } from "./ipc";
import { initMonaco, createEditor, monaco } from "./editor/monaco";
import { registerCompletionProviders } from "./editor/completion";
import { TabManager } from "./editor/tabs";
import type { TabEvents } from "./editor/tabs";
import { HierarchyTree } from "./ui/tree";
import { StatusBar } from "./ui/statusbar";
import { OutlineView } from "./ui/outline";
import { SearchPanel } from "./ui/search";
import { RecentMenu } from "./ui/recent";
import { appAlert } from "./ui/dialog";
import { createNewFileControl, preferredNewFileType } from "./ui/new-file";
import { PathBreadcrumb } from "./ui/breadcrumb";
import { openColumnEditor, registerColumnActions } from "./editor/column-editor";
import { attachWindowControls } from "./ui/window-controls";
import { initTheme } from "./ui/theme";
import { setIcon } from "./ui/icons";
import type { IconName } from "./ui/icons";
import { renderPortMap, type PortMapRow, type PortMapData } from "./ui/portmap";
import { SignalProject, traceSignal, type SignalContext } from "./model/signal-flow";
import { SignalFlowPanel, type FlowViewState } from "./ui/signal-flow";
import { ComputationProject } from "./analysis/project";
import { localLogic, signalMode } from "./analysis/local";

interface CachedFile {
  content: string;
  encoding: string;
  /** 读取时的磁盘 mtime，外部变更检测基准 */
  mtime: number;
}

/** 全局工程状态 */
const state = {
  folder: "",
  index: new ModuleIndex(),
  structures: new Map<string, ModuleInfo[]>(),
  contents: new Map<string, CachedFile>(),
  /** 文件 → 完整解析（含端口），按需缓存 */
  parsed: new Map<string, ModuleInfo[]>(),
  ips: [] as IpInfo[],
  /** 约束文件（.xdc/.sdc）路径列表，树底部「约束」分组 */
  constraints: [] as string[],
  topName: undefined as string | undefined,
};

const sidebarEl = document.getElementById("sidebar")!;
const tabbarEl = document.getElementById("tabbar")!;
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
  recentBtn.title = "最近打开的工程 (Ctrl+R)";
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
  columnBtn.title = "列编辑 (Alt+C)；Alt+Shift+方向键或拖动选择矩形区域";
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
    if (splitVisible) collapseSplit();
    else if (groups[1].tabs.count) ensureSplit();
    else void openInOtherGroup();
  });
  splitBtn.id = "split-action";
  splitBtn.title = "分屏 (Ctrl+\\)";
  const mapBtn = action("", "ports", togglePortMap);
  mapBtn.id = "map-action";
  mapBtn.title = "端口映射 (Ctrl+K)";
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
if (new URLSearchParams(location.search).has("e2e")) {
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
statusbar.attachEditor(editor, () => activeGroupIdx === 0);
statusbar.attachEditor(editor2, () => activeGroupIdx === 1);

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
    flowProject = undefined;
    cancelSignalAnalysis();
    flowReady = false;
    if (flowSelection) flowPanel.markStale();
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

// ---------- 导航历史 ----------

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
  await openProjectFile(file, line, idx, column, length);
  updateNavButtons();
}

function navBack(): void {
  const cur = currentPos();
  if (!cur) return;
  const idx = activeGroupIdx, target = histories[idx].goBack(cur);
  if (target) void openProjectFile(target.path, target.line, idx, target.column, target.length).then(updateNavButtons);
}

function navForward(): void {
  const cur = currentPos();
  if (!cur) return;
  const idx = activeGroupIdx, target = histories[idx].goForward(cur);
  if (target) void openProjectFile(target.path, target.line, idx, target.column, target.length).then(updateNavButtons);
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

// ---------- 大纲 ----------

const outline = new OutlineView(outlineRootEl, {
  onJump: (line) => {
    const cur = currentPos();
    if (cur) histories[activeGroupIdx].push(cur);
    const ed = activeGroup().editor;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
    updateNavButtons();
  },
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

// 光标跟随在 wireEditor 中按组注册：状态栏显示「模块 › 进程」，大纲高亮当前条目

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

/** 当前编辑内容的第三级解析缓存（按 model 版本失效），悬停高频触发不能每次重解析。 */
const detailCache = new Map<string, { version: number; modules: ModuleInfo[] }>();

function detailForModel(model: monaco.editor.ITextModel): ModuleInfo[] {
  const key = model.uri.toString();
  const version = model.getVersionId();
  const hit = detailCache.get(key);
  if (hit?.version === version) return hit.modules;
  const modules = parseFileDetail(model.getValue(), model.uri.path);
  detailCache.set(key, { version, modules });
  return modules;
}

function findInstanceAt(
  modules: ModuleInfo[],
  word: string,
  line: number,
): { owner: ModuleInfo; inst: ModuleInfo["instances"][number] } | undefined {
  for (const owner of modules) {
    for (const inst of owner.instances) {
      if (inst.inst !== word || !inst.connections) continue;
      if (line >= inst.line && line <= (inst.endLine ?? inst.line)) return { owner, inst };
    }
  }
  return undefined;
}

const ipPortsCache = new Map<string, { ports: PortInfo[]; source: string }>();

/** 从 IP stub（同名 .v / synth / sim 子目录）提取端口，.veo 兜底；结果缓存。 */
async function loadIpPorts(name: string): Promise<{ ports: PortInfo[]; source: string }> {
  const key = name.toLowerCase();
  const hit = ipPortsCache.get(key);
  if (hit) return hit;
  const empty = { ports: [] as PortInfo[], source: "" };
  const ip = state.ips.find((i) => i.name.toLowerCase() === key);
  if (!ip) return empty;
  const base = ip.file.replace(/\.xci$/i, "");
  const dir = ip.file.slice(0, ip.file.lastIndexOf("/"));
  const candidates = [
    `${base}.v`,
    `${dir}/synth/${ip.name}.v`,
    `${dir}/sim/${ip.name}.v`,
    `${base}.veo`,
  ];
  for (const candidate of candidates) {
    try {
      const { content } = await readFile(candidate);
      const modules = parseFile(content, candidate);
      const mod = modules.find((m) => m.name.toLowerCase() === key) ?? modules[0];
      if (mod && mod.ports.length > 0) {
        const result = { ports: mod.ports, source: candidate };
        ipPortsCache.set(key, result);
        return result;
      }
    } catch {
      // 候选文件不存在或解析失败，尝试下一个
    }
  }
  ipPortsCache.set(key, empty);
  return empty;
}

/** 子模块端口元数据：工程内模块取解析结果，IP 取 stub。 */
async function modulePorts(moduleName: string): Promise<PortInfo[]> {
  const def = state.index.resolve(moduleName);
  const key = moduleName.toLowerCase();
  if (def && !def.isIp) {
    const content = fileContent(def.file);
    if (content !== undefined) {
      const mod = parseFile(content, def.file).find((m) => m.name.toLowerCase() === key);
      if (mod) return mod.ports;
    }
  }
  return (await loadIpPorts(moduleName)).ports;
}

/** 连接表对齐端口元数据：命名按名（大小写不敏感），位置按序；未连接的端口补空行。 */
async function buildPortMapRows(
  moduleName: string,
  connections: PortConnection[],
): Promise<PortMapRow[]> {
  const ports = await modulePorts(moduleName);
  const byName = new Map(ports.map((p) => [p.name.toLowerCase(), p]));
  const rows: PortMapRow[] = [];
  const used = new Set<string>();
  let posIdx = 0;
  for (const conn of connections) {
    let meta: PortInfo | undefined;
    if (conn.port) {
      meta = byName.get(conn.port.toLowerCase());
    } else {
      while (posIdx < ports.length && used.has(ports[posIdx].name.toLowerCase())) posIdx++;
      meta = ports[posIdx];
      posIdx++;
    }
    if (meta) used.add(meta.name.toLowerCase());
    rows.push({
      direction: meta?.direction ?? "",
      width: meta?.width ?? "",
      port: conn.port ?? meta?.name,
      expr: conn.expr,
    });
  }
  for (const p of ports) {
    if (!used.has(p.name.toLowerCase())) {
      rows.push({ direction: p.direction ?? "", width: p.width ?? "", port: p.name, expr: "" });
    }
  }
  return rows;
}

/** 打开中的标签页用当前缓冲区（含未保存修改），否则用扫描缓存。两组标签都查。 */
function fileContent(file: string): string | undefined {
  for (const g of groups) {
    const tab = g.tabs.findTab(file);
    if (tab) return tab.model.getValue();
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

function pathFromUri(uri: monaco.Uri): string {
  return decodeURIComponent(uri.path).replace(/^\/(?=[A-Za-z]:)/, "");
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

monaco.editor.registerCommand("rtl.gotoSignal", (_accessor, file: string, name: string) =>
  gotoSignalDecl(file, name),
);
monaco.editor.registerCommand("rtl.gotoPort", (_accessor, mod: string, port: string) =>
  gotoPortDecl(mod, port),
);

function commandLink(label: string, command: string, args: unknown[]): string {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

function portMapMarkdown(
  instName: string,
  moduleName: string,
  rows: PortMapRow[],
  file: string,
): monaco.IMarkdownString {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [`**${instName}** : ${moduleName}`, "", "| 方向 | 端口 | 连接 |", "|---|---|---|"];
  for (const row of rows) {
    const port = row.port ?? "?";
    const portCell = commandLink(port, "rtl.gotoPort", [moduleName, port]);
    let exprCell = row.expr ? esc(row.expr) : "*（未连接）*";
    if (row.expr && IDENT_RE.test(row.expr)) {
      exprCell = commandLink(row.expr, "rtl.gotoSignal", [file, row.expr]);
    }
    lines.push(`| ${row.direction} | ${portCell} | ${exprCell} |`);
  }
  return { value: lines.join("\n"), isTrusted: true };
}

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
  moduleParameters: name => {
    const def = state.index.resolve(name), content = def && fileContent(def.file);
    return def && content ? parseFile(content, def.file).find(m => m.name.toLowerCase() === name.toLowerCase())?.parameters ?? [] : [];
  },
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
  const candidates = modules.flatMap(m => m.instances).filter(i => !instance || i.inst === instance);
  const hit = candidates.find(i => at >= i.line && at <= (i.endLine ?? i.line)) ?? (instance && candidates.length === 1 ? candidates[0] : undefined);
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
  flowHistory=[];
  flowPanel.setBack(false);
  flowProject = undefined;
  cancelSignalAnalysis();
  flowReady = false;
  searchPanel.markStale();
  if (flowSelection) flowPanel.markStale();
  if (mappingData && !mappingStale) {
    mappingStale = true;
    const panel = document.getElementById("mapping")!, scroll = panel.scrollTop;
    renderMapping(); panel.scrollTop = scroll;
  }
}

// ---------- 按需信号链：显式追踪，浏览源码不改变目标 ----------
let flowRequest = 0;
let flowReady = false;
let flowProject: { project: SignalProject; computation: ComputationProject; sources: Map<string,string>; top: string | undefined; files: Set<string> } | undefined;
const flowTokens = new WeakMap<monaco.editor.ITextModel, { version: number; lines: monaco.Token[][] }>();
interface FlowSelection { project: SignalProject; computation: ComputationProject; sources: Map<string,string>; signal: string; contexts: SignalContext[]; note: string; file: string; line: number; column: number; scope: number; forceLogic?: boolean }
let flowSelection: FlowSelection | undefined;
let flowHistory: {selection:FlowSelection;index:number;view:FlowViewState}[] = [];
let treeContextPath: string | undefined;
let flowContextPath: string | undefined;
const flowPanel = new SignalFlowPanel(document.getElementById("signal-flow")!, {
  close: () => { setSignalFlowVisible(false); document.getElementById("flow-action")!.focus(); },
  refresh: () => { if (flowSelection) void analyzeCurrentSignal(flowSelection); },
  context: index => { flowHistory=[]; flowPanel.setBack(false); void runSignalTrace(index); },
  enter: (context, signal, source) => void enterSignalLogic(context,signal,source),
  back: () => { const old=flowHistory.pop();if(old){const expected=flowRequest+1;void runSignalTrace(old.index,old.selection).then(()=>{if(flowRequest===expected&&flowSelection===old.selection)flowPanel.restore(old.view);});} },
  navigate: (file, line) => {
    void navigateTo(file, line).catch(error => statusbar.hint(`定位失败：${String(error)}`));
  },
});

function cancelSignalAnalysis(): void {
  ++flowRequest;
}

function setSignalFlowVisible(visible: boolean): void {
  document.getElementById("signal-flow")!.hidden = !visible;
  document.getElementById("flow-action")!.setAttribute("aria-expanded", String(visible));
}

function toggleSignalFlow(): void {
  const visible = document.getElementById("signal-flow")!.hidden;
  setSignalFlowVisible(visible);
}

async function analyzeCurrentSignal(previous?: { file: string; line: number; column: number; signal: string; scope: number; forceLogic?: boolean }): Promise<void> {
  cancelSignalAnalysis();
  const ed = activeGroup().editor, model = ed.getModel(), position = ed.getPosition();
  let word = previous?.signal ?? (model && position ? model.getWordAtPosition(position)?.word : undefined);
  if (!previous && model && position && word) {
    const language = model.getLanguageId();
    if (language !== "verilog" && language !== "vhdl") word = undefined;
    else {
      let tokens = flowTokens.get(model);
      if (tokens?.version !== model.getVersionId()) {
        tokens = { version: model.getVersionId(), lines: monaco.editor.tokenize(model.getValue(), language) };
        flowTokens.set(model, tokens);
      }
      const token = tokens.lines[position.lineNumber - 1]?.filter(t => t.offset <= position.column - 1).at(-1);
      if (!token || /comment|string|keyword|number|type/.test(token.type)) word = undefined;
    }
  }
  if ((!previous && (!model || !position)) || !word || !IDENT_RE.test(word)) {
    flowPanel.hint(flowSelection ? "光标未落在信号上，保留当前链路。" : "在源码信号上右键，选择“追踪此信号”。");
    return;
  }
  const file = previous?.file ?? pathFromUri(model!.uri);
  const line = previous
    ? (previous.scope >= 0 ? previous.line : findSignalDeclLine(fileContent(file) ?? "", file, word) ?? previous.line)
    : position!.lineNumber;
  const column = previous?.column ?? position!.column;
  if (!flowProject || !flowProject.files.has(file)) {
    const files = new Map([...state.contents.keys()].map(path => [path, fileContent(path) ?? ""]));
    const structures = new Map(state.structures);
    for (const group of groups) for (const [path, source] of files) {
      if (group.tabs.findTab(path)) structures.set(path, scanStructure(source, path));
    }
    if (!previous && model) {
      files.set(file, model.getValue());
      structures.set(file, scanStructure(model.getValue(), file));
    }
    const project = new SignalProject(files, structures);
    flowProject = { project, computation: new ComputationProject(files,project), sources:files, top: buildHierarchy(state.index, structures, state.topName).tops[0]?.moduleName, files: new Set(files.keys()) };
  }
  const { project } = flowProject;
  const owner = project.owner(file, line, column);
  if (!owner) { flowPanel.hint("当前位置不在可识别的 HDL 模块内。"); return; }
  const mod = project.module(owner);
  if (!mod) { flowPanel.hint("在源码信号上右键，选择“追踪此信号”。"); return; }
  const scope = project.signalScope(owner, word, { file, line, column });
  if (previous && previous.scope >= 0 && scope !== previous.scope) {
    flowPanel.hint("局部对象所在过程已变化，请重新右键追踪。"); return;
  }
  if (!previous && (word === owner || mod?.instances.some(inst => inst.inst === word || inst.module === word))) {
    flowPanel.hint("在源码信号上右键，选择“追踪此信号”。"); return;
  }
  const preferredPath = previous ? flowContextPath : treeContextPath;
  const sameSignal = model?.getLanguageId() === "vhdl" ? word.toLowerCase() === flowSelection?.signal.toLowerCase() : word === flowSelection?.signal;
  if (!previous && flowReady && flowSelection?.project === project && sameSignal && flowSelection.file === file && flowSelection.scope === scope && flowSelection.contexts.some(c => c.module === owner) && (!preferredPath || preferredPath === flowContextPath)) {
    flowPanel.hint(""); return;
  }
  const top = flowProject.top ?? owner;
  const found = project.contexts(top, owner);
  const contexts = found.items.length ? found.items : [project.root(owner)!].filter(Boolean);
  if (!contexts.length) { flowPanel.hint("未找到当前模块定义，保留原链路。"); return; }
  const note = found.truncated ? "实例路径列表已截断。" : found.items.length ? "" : "未定位到当前顶层内的实例，仅分析本模块范围。";
  const selection:FlowSelection = { project, computation:flowProject.computation, sources:flowProject.sources, signal: word, contexts, note, file, line, column, scope, forceLogic:previous?.forceLogic };
  const selected = Math.max(0, contexts.findIndex(c => c.path === preferredPath));
  if(!previous)flowHistory=[];
  await runSignalTrace(selected, selection);
}

async function runSignalTrace(index: number, selection = flowSelection): Promise<void> {
  if (!selection?.contexts[index]) return;
  const request = ++flowRequest;
  flowReady = false;
  flowPanel.hint(`正在分析 ${selection.signal}…`);
  const options = { cancelled: () => request !== flowRequest, source: selection };
  try {
    const context=selection.contexts[index];
    const mode=selection.forceLogic?"logic":signalMode(selection.project,context,selection.signal,selection.scope);
    const localProject=mode==="logic"?selection.project.forSource(context.module,selection):selection.project;
    const localComputation=localProject===selection.project?selection.computation:new ComputationProject(selection.sources,localProject);
    const graph=mode==="logic" && selection.scope<0 ? localLogic(localComputation,localProject,context,selection.signal) : undefined;
    if(graph){const root=graph.nodes.find(n=>n.id===graph.root);if(root){const start=(selection.sources.get(selection.file)??"").split("\n").slice(0,selection.line-1).reduce((n,s)=>n+s.length+1,0);root.source={file:selection.file,start,end:start+1};}}
    const up=graph?undefined:await traceSignal(selection.project,context,selection.signal,"upstream",{...options,stopAtAssignments:mode==="port",localOnly:mode==="logic"});
    if(request!==flowRequest)return;
    const down=graph?undefined:await traceSignal(selection.project,context,selection.signal,"downstream",{...options,stopAtAssignments:mode==="port",localOnly:mode==="logic"});
    if(request===flowRequest){
      flowSelection=selection;flowContextPath=context.path;flowPanel.setContexts(selection.contexts,index);
      if(selection.project===flowProject?.project)flowPanel.clearStale();else flowPanel.markStale();
      if(graph)flowPanel.logicResult(selection.signal,context,graph,selection.sources,selection.note);
      else flowPanel.result(selection.signal,up!,down!,selection.note,mode==="port"?"端口连接":"模块内逻辑 · 过程作用域");
      flowPanel.setBack(flowHistory.length>0);
      flowPanel.hint("");flowReady=true;
    }
  } catch (error) {
    if (request === flowRequest) flowPanel.hint(`分析未完成：${String(error)}`);
  }
}

async function enterSignalLogic(context:SignalContext,signal:string,source?:{file:string;line:number}):Promise<void>{
  if(!flowSelection||!flowReady){flowPanel.hint("源码已变化，请先刷新当前信号链。");return;}
  const mod=flowSelection.project.module(context.module);if(!mod)return;
  flowHistory.push({selection:flowSelection,index:Math.max(0,flowSelection.contexts.findIndex(c=>c.path===flowContextPath)),view:flowPanel.capture()});
  if(flowHistory.length>30)flowHistory.shift();
  const file=source?.file??mod.file,line=source?.line??findSignalDeclLine(flowSelection.sources.get(file)??"",file,signal)??mod.line;
  const scope=flowSelection.project.signalScope(context.module,signal,{file,line});
  const selection:FlowSelection={...flowSelection,signal,contexts:[context],file,line,column:1,scope,forceLogic:true,note:""};
  await runSignalTrace(0,selection);
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

/** 每个编辑器实例的接线：焦点切组、内容/光标跟随（两组各一份，闭包内 ed 即本组编辑器）。 */
function wireEditor(ed: monaco.editor.IStandaloneCodeEditor, idx: number): void {
  ed.onDidFocusEditorText(() => focusGroup(idx));
  // 共享 model 时两组编辑器都会收到内容事件，只让活动组触发大纲刷新
  ed.onDidChangeModelContent(() => {
    markResultsStale();
    if (idx !== activeGroupIdx) return;
    refreshOutline();
  });
  ed.onDidChangeCursorPosition((e) => {
    if (idx !== activeGroupIdx) return;
    const line = e.position.lineNumber;
    statusbar.setBreadcrumb(breadcrumbAt(currentOutline, line));
    outline.highlightLine(line);
  });
}

/**
 * 编辑器动作全局注册（monaco.editor.addEditorAction，只注册一次）：
 * run 收到的 ed 是当前聚焦的编辑器实例，天然适配分屏；
 * 不能用 ed.addAction 在两组各注册同 id 动作，会让按键分发失效。
 */
function registerEditorActions(): void {
  registerColumnActions();
  monaco.editor.addEditorAction({ id: "rtl.signal-flow", label: "追踪此信号", contextMenuGroupId: "navigation", run: ed => { focusGroup(groups.findIndex(g => g.editor === ed)); setSignalFlowVisible(true); return analyzeCurrentSignal(); } });
  monaco.editor.addEditorAction({
    id: "rtl.view-portmap",
    label: "查看端口连接",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
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
    label: "在另一侧视图打开 (Ctrl+\\)",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backslash],
    contextMenuGroupId: "view",
    contextMenuOrder: 0,
    run: () => void openInOtherGroup(),
  });
}

// ---------- 编辑组（分屏：最多左右两组，同文件共享 model） ----------

interface EditorGroup {
  editor: monaco.editor.IStandaloneCodeEditor;
  tabs: TabManager;
}

let splitVisible = false;
let splitFlex = "";

function makeTabEvents(idx: number): TabEvents {
  return {
    onActiveChange: () => {
      if (idx === 1 && groups[1].tabs.count === 0) collapseSplit();
      syncEditorChrome(idx);
      if (idx === activeGroupIdx) syncChrome();
    },
    onFileReloaded: (path, content, encoding, mtime) => {
      if (state.contents.get(path)?.content !== content) markResultsStale();
      state.contents.set(path, { content, encoding, mtime });
      updateStructure(path, content);
    },
    onFileSaved: (path, content, encoding, mtime) => {
      if (state.contents.get(path)?.content !== content) markResultsStale();
      state.contents.set(path, { content, encoding, mtime });
      updateStructure(path, content);
    },
    tabMenuExtra: (tab) => {
      if (!tab.path) return [];
      const other = idx === 0 ? 1 : 0;
      return [
        {
          label: splitVisible ? "在另一侧视图打开" : "向右拆分视图",
          action: () => void openProjectFile(tab.path, undefined, other),
        },
      ];
    },
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
  path => void openDirectory(path).catch(error => statusbar.hint(`打开文件夹失败：${String(error)}`)),
  path => void showInFolder(path).catch(error => statusbar.hint(`定位文件失败：${String(error)}`)),
));
registerEditorActions();
setIcon(document.getElementById("close-split")!, "close");
document.getElementById("close-split")!.addEventListener("click", collapseSplit);

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
  if (idx === activeGroupIdx) return;
  activeGroupIdx = idx;
  syncChrome();
}

/** 同步状态栏/大纲等外围 UI 到当前活动组。 */
function syncChrome(): void {
  updateNavButtons();
  const g = activeGroup();
  const tab = g.tabs.activeTab;
  if (!tab) {
    statusbar.update(null, null);
    refreshOutline();
    return;
  }
  statusbar.update(tab.model.getLanguageId(), tab.encoding);
  const pos = g.editor.getPosition();
  if (pos) statusbar.setPosition(`行 ${pos.lineNumber}, 列 ${pos.column}`);
  refreshOutline();
}

function ensureSplit(): void {
  if (splitVisible) return;
  splitVisible = true;
  document.getElementById("split-action")!.setAttribute("aria-pressed", "true");
  setMappingVisible(false);
  setSignalFlowVisible(false);
  document.getElementById("group-2")!.hidden = false;
  document.getElementById("group-splitter")!.hidden = false;
  document.getElementById("group-1")!.style.flex = splitFlex;
}

function collapseSplit(): void {
  if (!splitVisible) return;
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

/** 当前文件在另一侧视图打开（Ctrl+\ / 编辑器右键）。 */
async function openInOtherGroup(): Promise<void> {
  const src = activeGroup();
  const tab = src.tabs.activeTab;
  if (!tab?.path) {
    statusbar.hint("当前没有已保存的文件");
    return;
  }
  const line = src.editor.getPosition()?.lineNumber;
  await openProjectFile(tab.path, line, activeGroupIdx === 0 ? 1 : 0);
}

/** 两组间的宽度分隔条拖拽。 */
function initGroupSplitter(): void {
  const splitter = document.getElementById("group-splitter")!;
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const g1 = document.getElementById("group-1")!;
    const mainArea = document.getElementById("main-area")!;
    const startX = e.clientX;
    const startWidth = g1.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      const total = mainArea.getBoundingClientRect().width;
      const width = Math.min(Math.max(startWidth + ev.clientX - startX, 200), total - 200);
      g1.style.flex = `0 0 ${width}px`;
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
initGroupSplitter();

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
  if (!path.toLowerCase().startsWith(state.folder.toLowerCase() + "/")) return;
  state.structures.set(path, scanStructure(content, path));
  state.parsed.delete(path);
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
    return Array.isArray(list) ? list.filter((p) => typeof p === "string").map(normalizePath) : [];
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

/** 扫描代际：每次 openFolder 递增，进行中的旧扫描据此中止，防止跨工程污染 state。 */
let scanGeneration = 0;
let preparingProject = false;

async function openFolder(folder: string): Promise<void> {
  if (preparingProject) return;
  preparingProject = true;
  try { if (!(await TabManager.closeGroups(groups.map(g => g.tabs)))) return; }
  finally { preparingProject = false; }
  const gen = ++scanGeneration;
  state.folder = folder;
  updateProjectChrome();
  setMappingVisible(false);
  document.getElementById("mapping")!.replaceChildren();
  mappingData = undefined;
  mappingStale = false;
  mappingTarget = undefined;
  setSignalFlowVisible(false);
  ++flowRequest;
  flowSelection = undefined;
  flowHistory = [];
  flowPanel.setBack(false);
  flowProject = undefined;
  flowReady = false;
  flowContextPath = undefined;
  flowPanel.clearStale();
  treeContextPath = undefined;
  flowPanel.setContexts([], 0);
  flowPanel.message("");
  flowPanel.hint("在源码信号上右键，选择“追踪此信号”。");
  addRecent(folder);
  state.topName = undefined;
  state.structures.clear();
  state.contents.clear();
  state.parsed.clear();
  state.ips = [];
  state.constraints = [];
  // 端口缓存按工程失效：换工程后同名 IP（clk_wiz_0 等）不得沿用旧定义
  ipPortsCache.clear();
  detailCache.clear();
  histories.forEach(history => history.clear());
  updateNavButtons();
  searchPanel.clear();

  setProgress("扫描文件…");
  let hdl: string[];
  let xci: string[];
  let con: string[];
  try {
    ({ hdl, xci, con } = await scanFolder(folder));
  } catch (e) {
    // 扫描失败（目录被删/无权限等）：回到空工程状态并提示，不得留下「扫描文件…」卡死的半初始化界面
    if (gen !== scanGeneration) return;
    state.folder = "";
    updateProjectChrome();
    setProgress("");
    rebuildIndex();
    renderTree();
    await appAlert(`打开工程失败：${String(e)}`);
    return;
  }
  if (gen !== scanGeneration) return;
  // IP 生成目录（.xci 所在目录树）内的文件不进索引，stub/约束仅按需查看
  const xciDirs = xci.map((f) => f.slice(0, f.lastIndexOf("/")));
  const isIpGenerated = (file: string) =>
    xciDirs.some((dir) => file.startsWith(dir + "/"));
  state.constraints = con.filter((f) => !isIpGenerated(f));

  // 分批读取 + 结构扫描，避免长时间阻塞 UI
  const hdlFiles = hdl.filter((f) => !isIpGenerated(f));
  let done = 0;
  for (const file of hdlFiles) {
    if (gen !== scanGeneration) return;
    try {
      const { content, encoding, mtime } = await readFile(file);
      state.contents.set(file, { content, encoding, mtime });
      state.structures.set(file, scanStructure(content, file));
    } catch (e) {
      console.error("read failed:", file, e);
    }
    done += 1;
    if (done % 8 === 0 || done === hdlFiles.length) {
      setProgress(`解析结构 ${done}/${hdlFiles.length}`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  for (const file of xci) {
    if (gen !== scanGeneration) return;
    try {
      const { content } = await readFile(file);
      state.ips.push(parseXci(content, file));
    } catch (e) {
      console.error("xci parse failed:", file, e);
    }
  }

  // 约束文件读入缓存：全局搜索覆盖、点击即开、外部变更监视生效
  for (const file of state.constraints) {
    if (gen !== scanGeneration) return;
    try {
      const { content, encoding, mtime } = await readFile(file);
      state.contents.set(file, { content, encoding, mtime });
    } catch (e) {
      console.error("read failed:", file, e);
    }
  }

  rebuildIndex();
  setProgress("");
  renderTree();
  startWatcher();
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

let watchTimer: number | undefined;
let watchPollCount = 0;

function startWatcher(): void {
  window.clearInterval(watchTimer);
  watchTimer = window.setInterval(() => void pollExternalChanges(), 4000);
}

/** 轮询已索引文件的 mtime：干净标签静默重载，脏标签打警示徽章，未打开的增量重扫；每 4 轮 diff 一次目录增删。 */
async function pollExternalChanges(): Promise<void> {
  if (!state.folder || document.hidden) return;
  const files = [...state.contents.keys()];
  if (files.length > 0) {
    let states: (number | null)[];
    try {
      states = await fileStates(files);
    } catch {
      return;
    }
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const cached = state.contents.get(file);
      if (!cached) continue;
      const mtime = states[i];
      if (mtime === cached.mtime) continue;
      if (mtime === null) {
        handleExternalDelete(file);
        continue;
      }
      try {
        const fresh = await readFile(file);
        if (fresh.content !== cached.content) markResultsStale();
        const openGroups = groups.filter((g) => g.tabs.findTab(file));
        const anyDirty = openGroups.some((g) => g.tabs.findTab(file)!.dirty);
        if (openGroups.length > 0 && !anyDirty) {
          // 静默重载：onFileReloaded 事件会同步缓存与结构；共享 model 的组逐个刷新标签状态
          for (const g of openGroups) {
            g.tabs.reloadFromDisk(file, fresh.content, fresh.encoding, fresh.mtime);
          }
          statusbar.hint(`${file.split("/").pop() ?? file} 已被外部修改，已重新加载`);
        } else {
          cached.content = fresh.content;
          cached.encoding = fresh.encoding;
          cached.mtime = fresh.mtime;
          for (const g of openGroups) g.tabs.markExternalChanged(file, true);
          updateStructure(file, fresh.content);
        }
      } catch (e) {
        console.error("reload failed:", file, e);
      }
    }
  }
  watchPollCount += 1;
  if (watchPollCount % 4 === 1) await rescanFolderDiff();
}

/** 文件在磁盘被删除：打开中的标签保留缓冲区并打警示徽章，未打开的从索引移除。 */
function handleExternalDelete(file: string): void {
  markResultsStale();
  const openGroups = groups.filter((g) => g.tabs.findTab(file));
  if (openGroups.length > 0) {
    for (const g of openGroups) g.tabs.markExternalChanged(file, true);
    return;
  }
  state.contents.delete(file);
  state.structures.delete(file);
  state.parsed.delete(file);
  rebuildIndex();
  renderTree();
}

/** 目录级 diff：新增 HDL/xci 纳入索引，删除的 xci 移除。 */
async function rescanFolderDiff(): Promise<void> {
  let scan;
  try {
    scan = await scanFolder(state.folder);
  } catch {
    return;
  }
  const xciDirs = scan.xci.map((f) => f.slice(0, f.lastIndexOf("/")));
  const isIpGenerated = (file: string) => xciDirs.some((dir) => file.startsWith(dir + "/"));
  let changed = false;
  for (const file of scan.hdl) {
    if (isIpGenerated(file) || state.structures.has(file)) continue;
    try {
      const { content, encoding, mtime } = await readFile(file);
      state.contents.set(file, { content, encoding, mtime });
      state.structures.set(file, scanStructure(content, file));
      changed = true;
    } catch (e) {
      console.error("read failed:", file, e);
    }
  }
  const knownXci = new Set(state.ips.map((i) => i.file));
  for (const file of scan.xci) {
    if (knownXci.has(file)) continue;
    try {
      const { content } = await readFile(file);
      state.ips.push(parseXci(content, file));
      changed = true;
    } catch (e) {
      console.error("xci parse failed:", file, e);
    }
  }
  const xciSet = new Set(scan.xci);
  const before = state.ips.length;
  state.ips = state.ips.filter((i) => xciSet.has(i.file));
  if (state.ips.length !== before) changed = true;
  // 约束文件增删：新增的读入缓存，删除的从缓存移除（IP 生成目录的约束不纳入）
  const userCon = scan.con.filter((f) => !isIpGenerated(f));
  for (const file of userCon) {
    if (state.contents.has(file)) continue;
    try {
      const { content, encoding, mtime } = await readFile(file);
      state.contents.set(file, { content, encoding, mtime });
    } catch (e) {
      console.error("read failed:", file, e);
    }
  }
  const conSet = new Set(userCon);
  for (const file of state.constraints) {
    if (!conSet.has(file) && !groups.some((g) => g.tabs.findTab(file))) state.contents.delete(file);
  }
  if (
    userCon.length !== state.constraints.length ||
    userCon.some((f, i) => state.constraints[i] !== f)
  ) {
    state.constraints = userCon;
    changed = true;
  }
  if (changed) {
    markResultsStale();
    rebuildIndex();
    renderTree();
  }
}

// ---------- 树节点打开 ----------

/** 打开工程内文件并跳转行：优先用扫描缓存，未缓存则读盘。树节点与编辑器跳转共用。
 *  targetIdx 指定目标编辑组（分屏「在另一侧打开」），缺省为当前活动组。 */
async function openProjectFile(file: string, line?: number, targetIdx?: number, column = 1, length = 0): Promise<void> {
  const idx = targetIdx ?? activeGroupIdx;
  if (idx === 1) ensureSplit();
  const g = groups[idx];
  const cached = state.contents.get(file);
  if (cached) {
    g.tabs.openContent(file, cached.content, cached.encoding, cached.mtime, line);
    ensureParsed(file, cached.content);
  } else {
    await g.tabs.openFile(file, line);
    const after = state.contents.get(file);
    if (after) ensureParsed(file, after.content);
  }
  if (line !== undefined && g.tabs.activeTab?.path === file) {
    g.editor.setSelection(new monaco.Range(line, column, line, column + length));
    g.editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(line, column, line, column + length));
  }
}

// 跳转到定义：目标文件未打开时 standalone Monaco 默认静默失败，注册 opener 接管打开
monaco.editor.registerEditorOpener({
  openCodeEditor: (_source, resource, selectionOrPosition) => {
    const path = decodeURIComponent(resource.path).replace(/^\/(?=[A-Za-z]:)/, "");
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

function ensureParsed(path: string, content: string): void {
  if (!state.parsed.has(path)) {
    try {
      state.parsed.set(path, parseFile(content, path));
    } catch (e) {
      console.error("parse failed:", path, e);
    }
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

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault(); activeGroup().tabs.newFile(preferredNewFileType(), state.folder);
  } else if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === "ArrowLeft") {
    e.preventDefault();
    navBack();
  } else if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === "ArrowRight") {
    e.preventDefault();
    navForward();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchPanel.focus();
  } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
    e.preventDefault();
    recentMenu.toggle();
  }
});
