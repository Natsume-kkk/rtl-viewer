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
import { NavHistory } from "./model/history";
import { scanStructure, parseFile, parseFileDetail, parseXci } from "./parser";
import type { ModuleInfo, IpInfo, PortInfo, PortConnection } from "./parser";
import { findSignalDeclLine } from "./model/signals";
import { scanFolder, readFile, openFolderDialog, fileStates, pathExists, showInFolder, isDirectory } from "./ipc";
import { initMonaco, createEditor, monaco } from "./editor/monaco";
import { TabManager } from "./editor/tabs";
import type { TabEvents } from "./editor/tabs";
import { HierarchyTree } from "./ui/tree";
import { StatusBar } from "./ui/statusbar";
import { OutlineView } from "./ui/outline";
import { SearchPanel } from "./ui/search";
import { RecentMenu } from "./ui/recent";

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

// 侧栏静态结构：工具条 / 进度 / 搜索 / 树容器 / 大纲（只建一次，各组件渲染进对应容器）
function initSidebar(): { treeRoot: HTMLElement; searchRoot: HTMLElement; outlineRoot: HTMLElement } {
  const bar = document.createElement("div");
  bar.className = "sidebar-toolbar";
  const openWrap = document.createElement("span");
  openWrap.className = "open-wrap";
  const openBtn = document.createElement("button");
  openBtn.textContent = "打开文件夹";
  openBtn.addEventListener("click", () => void openProject());
  const recentBtn = document.createElement("button");
  recentBtn.className = "recent-btn";
  recentBtn.textContent = "▾";
  recentBtn.title = "最近打开的工程 (Ctrl+R)";
  recentBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    recentMenu.toggle();
  });
  openWrap.append(openBtn, recentBtn);
  const newBtn = document.createElement("button");
  newBtn.textContent = "新建文件";
  newBtn.addEventListener("click", () => activeGroup().tabs.newFile());
  bar.append(openWrap, newBtn);
  const progress = document.createElement("div");
  progress.id = "progress";
  progress.className = "progress";
  const searchRoot = document.createElement("div");
  searchRoot.id = "search-root";
  const treeRoot = document.createElement("div");
  treeRoot.id = "tree-root";
  const outlineRoot = document.createElement("div");
  outlineRoot.id = "outline-root";
  sidebarEl.append(bar, progress, searchRoot, treeRoot, outlineRoot);
  return { treeRoot, searchRoot, outlineRoot };
}

const { treeRoot: treeRootEl, searchRoot: searchRootEl, outlineRoot: outlineRootEl } = initSidebar();

// Monaco 初始化（definition provider 通过函数引用最新索引）；editor2 为分屏第二组
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
statusbar.attachEditor(editor);
statusbar.attachEditor(editor2);

const tree = new HierarchyTree(treeRootEl, {
  onOpen: (node) => void openTreeNode(node),
  onOpenInst: (node) => {
    if (node.instFile && node.instLine !== undefined) {
      void navigateTo(node.instFile, node.instLine);
    }
  },
  onRevealFile: (path) => void showInFolder(path),
  onSelectTop: (name) => {
    state.topName = name;
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

const history = new NavHistory();

function currentPos(): { path: string; line: number } | undefined {
  const g = activeGroup();
  const tab = g.tabs.activeTab;
  if (!tab?.path) return undefined;
  return { path: tab.path, line: g.editor.getPosition()?.lineNumber ?? 1 };
}

/** 工程内跳转统一入口：记录当前位置到历史，再打开目标位置。 */
async function navigateTo(file: string, line?: number): Promise<void> {
  const cur = currentPos();
  if (cur) history.push(cur);
  await openProjectFile(file, line);
  updateNavButtons();
}

function navBack(): void {
  const cur = currentPos();
  if (!cur) return;
  const target = history.goBack(cur);
  if (target) void openProjectFile(target.path, target.line).then(updateNavButtons);
}

function navForward(): void {
  const cur = currentPos();
  if (!cur) return;
  const target = history.goForward(cur);
  if (target) void openProjectFile(target.path, target.line).then(updateNavButtons);
}

const navBackBtn = document.createElement("li");
navBackBtn.className = "nav-btn";
navBackBtn.textContent = "←";
navBackBtn.title = "后退 (Alt+←)";
navBackBtn.addEventListener("click", navBack);
const navFwdBtn = document.createElement("li");
navFwdBtn.className = "nav-btn";
navFwdBtn.textContent = "→";
navFwdBtn.title = "前进 (Alt+→)";
navFwdBtn.addEventListener("click", navForward);
tabbarEl.prepend(navBackBtn, navFwdBtn);

function updateNavButtons(): void {
  navBackBtn.classList.toggle("disabled", !history.canBack);
  navFwdBtn.classList.toggle("disabled", !history.canForward);
}
updateNavButtons();

// ---------- 大纲 ----------

const outline = new OutlineView(outlineRootEl, {
  onJump: (line) => {
    const cur = currentPos();
    if (cur) history.push(cur);
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
  onSearch: (query, options) => searchContents(state.contents, query, options),
  onOpen: (file, line) => void navigateTo(file, line),
  displayPath,
});

// ---------- 例化端口映射（悬停 + Ctrl+K 钉住） ----------

interface PortMapRow {
  direction: string;
  width: string;
  port?: string;
  expr: string;
}

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
    const cached = state.contents.get(def.file);
    if (cached) {
      ensureParsed(def.file, cached.content);
      const mod = state.parsed.get(def.file)?.find((m) => m.name.toLowerCase() === key);
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

/** 钉住的端口映射面板（Ctrl+K）。 */
function pinPortMapPanel(
  instName: string,
  moduleName: string,
  rows: PortMapRow[],
  file: string,
): void {
  document.getElementById("portmap-panel")?.remove();
  const panel = document.createElement("div");
  panel.id = "portmap-panel";

  const head = document.createElement("div");
  head.className = "ip-panel-head";
  const title = document.createElement("span");
  title.textContent = `${instName} : ${moduleName}`;
  const close = document.createElement("span");
  close.className = "ip-panel-close";
  close.textContent = "×";
  close.addEventListener("click", () => panel.remove());
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "ip-panel-body";
  const note = document.createElement("div");
  note.className = "ip-panel-note";
  note.textContent = "点端口跳定义，点信号跳声明";
  body.appendChild(note);
  const table = document.createElement("table");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const dirTd = document.createElement("td");
    dirTd.textContent = row.direction;
    const widthTd = document.createElement("td");
    widthTd.textContent = row.width;
    const portTd = document.createElement("td");
    portTd.textContent = row.port ?? "?";
    if (row.port) {
      portTd.className = "pm-link";
      portTd.addEventListener("click", () => gotoPortDecl(moduleName, row.port!));
    }
    const exprTd = document.createElement("td");
    if (row.expr) {
      exprTd.textContent = row.expr;
      if (IDENT_RE.test(row.expr)) {
        exprTd.className = "pm-link";
        exprTd.addEventListener("click", () => gotoSignalDecl(file, row.expr));
      }
    } else {
      exprTd.textContent = "（未连接）";
      exprTd.className = "pm-unconnected";
    }
    tr.append(dirTd, widthTd, portTd, exprTd);
    table.appendChild(tr);
  }
  body.appendChild(table);
  panel.appendChild(body);
  document.getElementById("main-area")!.appendChild(panel);
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
  close.textContent = "×";
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

/** 每个编辑器实例的接线：焦点切组、光标跟随（两组各一份，闭包内 ed 即本组编辑器）。 */
function wireEditor(ed: monaco.editor.IStandaloneCodeEditor, idx: number): void {
  ed.onDidFocusEditorText(() => focusGroup(idx));
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
  monaco.editor.addEditorAction({
    id: "rtl.pin-portmap",
    label: "例化端口映射",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
    run: (ed) => {
      const model = ed.getModel();
      const pos = ed.getPosition();
      const word = model && pos ? model.getWordAtPosition(pos) : null;
      const hit =
        model && pos && word
          ? findInstanceAt(detailForModel(model), word.word, pos.lineNumber)
          : undefined;
      if (!model || !hit) {
        statusbar.hint("光标不在例化名上");
        return;
      }
      const inst = hit.inst;
      void buildPortMapRows(inst.module, inst.connections ?? []).then((rows) =>
        pinPortMapPanel(inst.inst, inst.module, rows, pathFromUri(model.uri)),
      );
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
      searchPanel.searchAll(word);
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
let activeGroupIdx = 0;

function makeTabEvents(idx: number): TabEvents {
  return {
    onActiveChange: () => {
      if (idx === 1 && groups[1].tabs.count === 0) collapseSplit();
      if (idx === activeGroupIdx) syncChrome();
    },
    onFileReloaded: (path, content, encoding, mtime) => {
      state.contents.set(path, { content, encoding, mtime });
      updateStructure(path, content);
    },
    onFileSaved: (path, content, encoding, mtime) => {
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
registerEditorActions();

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
  document.getElementById("group-2")!.hidden = false;
  document.getElementById("group-splitter")!.hidden = false;
}

function collapseSplit(): void {
  if (!splitVisible) return;
  splitVisible = false;
  document.getElementById("group-2")!.hidden = true;
  document.getElementById("group-splitter")!.hidden = true;
  document.getElementById("group-1")!.style.flex = "";
  if (activeGroupIdx === 1) {
    activeGroupIdx = 0;
    syncChrome();
  }
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

function updateStructure(path: string, content: string): void {
  if (!state.folder) return;
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
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
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
  const dir = paths[0];
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

async function openFolder(folder: string): Promise<void> {
  state.folder = folder;
  addRecent(folder);
  state.topName = undefined;
  state.structures.clear();
  state.contents.clear();
  state.parsed.clear();
  state.ips = [];
  state.constraints = [];
  history.clear();
  updateNavButtons();
  searchPanel.clear();

  setProgress("扫描文件…");
  const { hdl, xci, con } = await scanFolder(folder);
  // IP 生成目录（.xci 所在目录树）内的文件不进索引，stub/约束仅按需查看
  const xciDirs = xci.map((f) => f.slice(0, f.lastIndexOf("/")));
  const isIpGenerated = (file: string) =>
    xciDirs.some((dir) => file.startsWith(dir + "/"));
  state.constraints = con.filter((f) => !isIpGenerated(f));

  // 分批读取 + 结构扫描，避免长时间阻塞 UI
  const hdlFiles = hdl.filter((f) => !isIpGenerated(f));
  let done = 0;
  for (const file of hdlFiles) {
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
    try {
      const { content } = await readFile(file);
      state.ips.push(parseXci(content, file));
    } catch (e) {
      console.error("xci parse failed:", file, e);
    }
  }

  // 约束文件读入缓存：全局搜索覆盖、点击即开、外部变更监视生效
  for (const file of state.constraints) {
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

// ---------- 外部变更监视 ----------

let watchTimer: number | undefined;
let watchPollCount = 0;

function startWatcher(): void {
  window.clearInterval(watchTimer);
  watchTimer = window.setInterval(() => void pollExternalChanges(), 4000);
}

/** 轮询已索引文件的 mtime：干净标签静默重载，脏标签打 ⚠，未打开的增量重扫；每 4 轮 diff 一次目录增删。 */
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

/** 文件在磁盘被删除：打开中的标签保留缓冲区并打 ⚠，未打开的从索引移除。 */
function handleExternalDelete(file: string): void {
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
    rebuildIndex();
    renderTree();
  }
}

// ---------- 树节点打开 ----------

/** 打开工程内文件并跳转行：优先用扫描缓存，未缓存则读盘。树节点与编辑器跳转共用。
 *  targetIdx 指定目标编辑组（分屏「在另一侧打开」），缺省为当前活动组。 */
async function openProjectFile(file: string, line?: number, targetIdx?: number): Promise<void> {
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
  // 单击进模块定义（直觉操作）；例化点由节点行的 ↩ 图标进入
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
  if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === "ArrowLeft") {
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

editor.onDidChangeModelContent(() => refreshOutline());
