import "./style.css";
import { ModuleIndex } from "./model";

// E2E 模式：先装 IPC mock 再初始化（invoke 在调用时才读取 __TAURI_INTERNALS__）
if (new URLSearchParams(location.search).has("e2e")) {
  await import("./e2e-mock");
}
import { buildHierarchy } from "./model/hierarchy";
import type { Hierarchy, TreeNode } from "./model/hierarchy";
import { extractOutline, OUTLINE_KIND_LABELS } from "./model/outline";
import { searchContents } from "./model/search";
import { NavHistory } from "./model/history";
import { scanStructure, parseFile, parseFileDetail, parseXci } from "./parser";
import type { ModuleInfo, IpInfo, PortInfo, PortConnection } from "./parser";
import { findSignalDeclLine } from "./model/signals";
import { scanFolder, readFile, openFolderDialog, fileStates, pathExists, showInFolder } from "./ipc";
import { initMonaco, monaco } from "./editor/monaco";
import { TabManager } from "./editor/tabs";
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
  newBtn.addEventListener("click", () => tabs.newFile());
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

// Monaco 初始化（definition provider 通过函数引用最新索引）
const editor = initMonaco(editorContainer, (name) => state.index.resolve(name));

// E2E 钩子：仅 ?e2e 模式暴露编辑器实例，供自动化验收驱动
if (new URLSearchParams(location.search).has("e2e")) {
  (window as unknown as Record<string, unknown>).__rtl = { editor, monaco };
}

const statusbar = new StatusBar(statusbarEl, {
  onReopen: (enc) => void tabs.reopenWithEncoding(enc),
  onSetSaveEncoding: (enc) => tabs.setSaveEncoding(enc),
});
statusbar.attachEditor(editor);

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
});

// ---------- 导航历史 ----------

const history = new NavHistory();

function currentPos(): { path: string; line: number } | undefined {
  const tab = tabs.activeTab;
  if (!tab?.path) return undefined;
  return { path: tab.path, line: editor.getPosition()?.lineNumber ?? 1 };
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
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
    updateNavButtons();
  },
  onOpenSymbols: () => {
    editor.focus();
    editor.trigger("rtl.outline", "editor.action.quickOutline", null);
  },
});

let outlineTimer: number | undefined;
function refreshOutline(): void {
  window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    const tab = tabs.activeTab;
    if (!tab) {
      outline.render([], "");
      return;
    }
    outline.render(extractOutline(tab.model.getValue(), tab.path || tab.title), tab.title);
  }, 200);
}

// ---------- 全局搜索 ----------

const searchPanel = new SearchPanel(searchRootEl, {
  onSearch: (query, options) => searchContents(state.contents, query, options),
  onOpen: (file, line) => void navigateTo(file, line),
  displayPath: (file) =>
    state.folder && file.startsWith(state.folder + "/")
      ? file.slice(state.folder.length + 1)
      : file,
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

/** 打开中的标签页用当前缓冲区（含未保存修改），否则用扫描缓存。 */
function fileContent(file: string): string | undefined {
  const tab = tabs.findTab(file);
  return tab ? tab.model.getValue() : state.contents.get(file)?.content;
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

editor.addAction({
  id: "rtl.pin-portmap",
  label: "例化端口映射",
  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
  run: () => {
    const model = editor.getModel();
    const pos = editor.getPosition();
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
  editor.addAction({
    id: "rtl.toggle-word-wrap",
    label: "切换自动换行 (Alt+Z)",
    contextMenuGroupId: "view",
    contextMenuOrder: 1,
    ...(builtin ? {} : { keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ] }),
    run: () => {
      if (builtin) {
        void builtin.run();
        return;
      }
      const on = editor.getOption(monaco.editor.EditorOption.wordWrap) !== "off";
      editor.updateOptions({ wordWrap: on ? "off" : "on" });
    },
  });
}

const tabs = new TabManager(editor, tabbarEl, {  onActiveChange: () => {
    const tab = tabs.activeTab;
    if (!tab) {
      statusbar.update(null, null);
      refreshOutline();
      return;
    }
    const lang = tab.model.getLanguageId();
    statusbar.update(lang, tab.encoding);
    refreshOutline();
  },
  onFileReloaded: (path, content, encoding, mtime) => {
    state.contents.set(path, { content, encoding, mtime });
    updateStructure(path, content);
  },
  onFileSaved: (path, content, encoding, mtime) => {
    state.contents.set(path, { content, encoding, mtime });
    updateStructure(path, content);
  },
});

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
        const tab = tabs.findTab(file);
        if (tab && !tab.dirty) {
          // 静默重载：onFileReloaded 事件会同步缓存与结构
          tabs.reloadFromDisk(file, fresh.content, fresh.encoding, fresh.mtime);
          statusbar.hint(`${file.split("/").pop() ?? file} 已被外部修改，已重新加载`);
        } else {
          cached.content = fresh.content;
          cached.encoding = fresh.encoding;
          cached.mtime = fresh.mtime;
          if (tab) tabs.markExternalChanged(file, true);
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
  if (tabs.findTab(file)) {
    tabs.markExternalChanged(file, true);
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
    if (!conSet.has(file) && !tabs.findTab(file)) state.contents.delete(file);
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

/** 打开工程内文件并跳转行：优先用扫描缓存，未缓存则读盘。树节点与编辑器跳转共用。 */
async function openProjectFile(file: string, line?: number): Promise<void> {
  const cached = state.contents.get(file);
  if (cached) {
    tabs.openContent(file, cached.content, cached.encoding, cached.mtime, line);
    ensureParsed(file, cached.content);
  } else {
    await tabs.openFile(file, line);
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
