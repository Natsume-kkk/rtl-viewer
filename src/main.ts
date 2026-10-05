import "./style.css";
import { ModuleIndex } from "./model";

// E2E 模式：先装 IPC mock 再初始化（invoke 在调用时才读取 __TAURI_INTERNALS__）
if (new URLSearchParams(location.search).has("e2e")) {
  await import("./e2e-mock");
}
import { buildHierarchy } from "./model/hierarchy";
import type { Hierarchy, TreeNode } from "./model/hierarchy";
import { extractOutline } from "./model/outline";
import { searchContents } from "./model/search";
import { NavHistory } from "./model/history";
import { scanStructure, parseFile, parseXci } from "./parser";
import type { ModuleInfo, IpInfo, PortInfo } from "./parser";
import { scanFolder, readFile, openFolderDialog } from "./ipc";
import { initMonaco, monaco } from "./editor/monaco";
import { TabManager } from "./editor/tabs";
import { HierarchyTree } from "./ui/tree";
import { StatusBar } from "./ui/statusbar";
import { OutlineView } from "./ui/outline";
import { SearchPanel } from "./ui/search";

interface CachedFile {
  content: string;
  encoding: string;
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
  const openBtn = document.createElement("button");
  openBtn.textContent = "打开文件夹";
  openBtn.addEventListener("click", () => void openProject());
  const newBtn = document.createElement("button");
  newBtn.textContent = "新建文件";
  newBtn.addEventListener("click", () => tabs.newFile());
  bar.append(openBtn, newBtn);
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

const statusbar = new StatusBar(statusbarEl, {
  onReopen: (enc) => void tabs.reopenWithEncoding(enc),
  onSetSaveEncoding: (enc) => tabs.setSaveEncoding(enc),
});
statusbar.attachEditor(editor);

const tree = new HierarchyTree(treeRootEl, {
  onOpen: (node) => void openTreeNode(node),
  onIpInfo: (node) => void showIpPanel(node),
  onSelectTop: (name) => {
    state.topName = name;
    renderTree();
  },
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
  onSearch: (query, caseSensitive) =>
    searchContents(state.contents, query, { caseSensitive }),
  onOpen: (file, line) => void navigateTo(file, line),
  displayPath: (file) =>
    state.folder && file.startsWith(state.folder + "/")
      ? file.slice(state.folder.length + 1)
      : file,
});

const tabs = new TabManager(editor, tabbarEl, {
  onActiveChange: () => {
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
  onFileReloaded: (path, content) => {
    state.contents.set(path, { content, encoding: tabs.activeTab?.encoding ?? "utf8" });
    updateStructure(path, content);
  },
  onFileSaved: (path, content) => {
    const tab = tabs.findTab(path);
    state.contents.set(path, { content, encoding: tab?.encoding ?? "utf8" });
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
  tree.render(h);
}

// ---------- 进度提示 ----------

function setProgress(text: string): void {
  const el = document.getElementById("progress");
  if (el) el.textContent = text;
}

// ---------- 打开工程 ----------

async function openProject(): Promise<void> {
  const folder = await openFolderDialog();
  if (!folder) return;
  state.folder = folder;
  state.topName = undefined;
  state.structures.clear();
  state.contents.clear();
  state.parsed.clear();
  state.ips = [];
  history.clear();
  updateNavButtons();
  searchPanel.clear();

  setProgress("扫描文件…");
  const { hdl, xci } = await scanFolder(folder);

  // IP 生成目录（.xci 所在目录树）内的 HDL 不进索引，stub 仅按需提取端口
  const xciDirs = xci.map((f) => f.slice(0, f.lastIndexOf("/")));
  const isIpGenerated = (file: string) =>
    xciDirs.some((dir) => file.startsWith(dir + "/"));

  // 分批读取 + 结构扫描，避免长时间阻塞 UI
  const hdlFiles = hdl.filter((f) => !isIpGenerated(f));
  let done = 0;
  for (const file of hdlFiles) {
    try {
      const { content, encoding } = await readFile(file);
      state.contents.set(file, { content, encoding });
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

  rebuildIndex();
  setProgress("");
  renderTree();
}

// ---------- 树节点打开 ----------

/** 打开工程内文件并跳转行：优先用扫描缓存，未缓存则读盘。树节点与编辑器跳转共用。 */
async function openProjectFile(file: string, line?: number): Promise<void> {
  const cached = state.contents.get(file);
  if (cached) {
    tabs.openContent(file, cached.content, cached.encoding, line);
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
  // 优先跳例化点（父模块中的例化行），看连接关系；顶层/无例化点节点跳定义
  if (node.instFile && node.instLine !== undefined) {
    await navigateTo(node.instFile, node.instLine);
    return;
  }
  if (!node.file) return; // unresolved 节点无定义位置
  await navigateTo(node.file, node.line);
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

// ---------- IP 端口面板 ----------

async function showIpPanel(node: TreeNode): Promise<void> {
  const ip = state.ips.find((i) => i.name.toLowerCase() === node.moduleName.toLowerCase());
  let ports: PortInfo[] = [];
  let source = "";

  // 优先在同目录找 stub（.v / synth / sim 子目录）提取端口，.veo 为模板无端口兜底
  if (ip) {
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
        const mod =
          modules.find((m) => m.name.toLowerCase() === ip.name.toLowerCase()) ?? modules[0];
        if (mod && mod.ports.length > 0) {
          ports = mod.ports;
          source = candidate;
          break;
        }
      } catch {
        // 候选文件不存在或解析失败，尝试下一个
      }
    }
  }

  document.getElementById("ip-panel")?.remove();
  const panel = document.createElement("div");
  panel.id = "ip-panel";

  const head = document.createElement("div");
  head.className = "ip-panel-head";
  const title = document.createElement("span");
  title.textContent = `◆ ${node.moduleName}`;
  const close = document.createElement("span");
  close.className = "ip-panel-close";
  close.textContent = "×";
  close.addEventListener("click", () => panel.remove());
  head.append(title, close);
  panel.appendChild(head);

  const body = document.createElement("div");
  body.className = "ip-panel-body";
  if (ports.length > 0) {
    const from = document.createElement("div");
    from.className = "ip-panel-note";
    from.textContent = `端口来源：${source}`;
    body.appendChild(from);
    const table = document.createElement("table");
    for (const p of ports) {
      const tr = document.createElement("tr");
      for (const text of [p.direction ?? "", p.width ?? "", p.name]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    body.appendChild(table);
  } else {
    const note = document.createElement("div");
    note.className = "ip-panel-note";
    note.textContent = "黑盒 IP，未找到端口 stub（.veo/.v）。";
    body.appendChild(note);
    if (ip?.vlnv) {
      const vlnv = document.createElement("div");
      vlnv.className = "ip-panel-vlnv";
      vlnv.textContent = ip.vlnv;
      body.appendChild(vlnv);
    }
  }
  panel.appendChild(body);
  document.getElementById("main-area")!.appendChild(panel);
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
  }
});

editor.onDidChangeModelContent(() => refreshOutline());
