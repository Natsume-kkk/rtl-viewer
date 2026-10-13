// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/editor/monaco", () => {
  class FakeModel {
    disposed = false;
    private version = 1;
    private listeners = new Set<() => void>();
    constructor(
      private value: string,
      private lang: string,
      readonly uri: { toString(): string },
    ) {}
    getValue(): string {
      return this.value;
    }
    setValue(v: string): void {
      this.value = v;
      this.version += 1;
      for (const l of [...this.listeners]) l();
    }
    getVersionId(): number {
      return this.version;
    }
    isDisposed(): boolean {
      return this.disposed;
    }
    getLanguageId(): string {
      return this.lang;
    }
    onDidChangeContent(cb: () => void): { dispose(): void } {
      this.listeners.add(cb);
      return {
        dispose: () => {
          this.listeners.delete(cb);
        },
      };
    }
    dispose(): void {
      this.disposed = true;
      this.listeners.clear();
    }
  }
  return {
    monaco: {
      editor: {
        ScrollType: { Immediate: 1 },
        getModel: () => null,
        createModel: (content: string, lang: string, uri: { toString(): string }) =>
          new FakeModel(content, lang, uri),
        setModelLanguage: () => {},
      },
      Uri: {
        parse: (s: string) => ({ path: decodeURIComponent(s.replace(/^file:\/\//, "")).replace(/^\/([A-Z]):/, (_, drive: string) => `/${drive.toLowerCase()}:`), toString: () => s }),
        file: (s: string) => ({ path: `/${s}`, toString: () => `file:///${s.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F")}` }),
      },
      Range: class { constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {} },
      KeyMod: { CtrlCmd: 1 },
      KeyCode: { KeyS: 2 },
    },
    langForFile: (file: string): string => {
      const ext = file.toLowerCase().split(".").pop() ?? "";
      if (["v", "sv", "vh", "svh"].includes(ext)) return "verilog";
      if (["vhd", "vhdl"].includes(ext)) return "vhdl";
      if (["xdc", "sdc"].includes(ext)) return "tcl";
      return "plaintext";
    },
  };
});

vi.mock("../src/ipc", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  saveFileDialog: vi.fn(),
  fileStates: vi.fn(),
  showInFolder: vi.fn(),
  openDirectory: vi.fn(),
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}));

vi.mock("../src/ui/dialog", () => ({
  choiceDialog: vi.fn(),
  appConfirm: vi.fn(),
  appAlert: vi.fn(),
}));


interface Position { lineNumber: number; column: number }
interface Selection { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
interface Model { onDidChangeContent(cb: () => void): { dispose(): void } }
function makeEditor() {
  let model: Model | null = null, contentListener: { dispose(): void } | undefined;
  let position: Position = { lineNumber: 1, column: 1 };
  let selection: Selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  const focus = new Set<() => void>(), content = new Set<() => void>();
  const modelChanged = new Set<() => void>();
  const cursor = new Set<(event: { position: Position }) => void>();
  const scroll = new Set<(event: { scrollTop: number; scrollLeft: number; scrollTopChanged: boolean; scrollLeftChanged: boolean }) => void>();
  let scrollTop = 0, scrollLeft = 0;
  function listen<T>(set: Set<T>, cb: T) { set.add(cb); return { dispose: () => set.delete(cb) }; }
  const ed = {
    getModel: () => model,
    setModel: (next: Model | null) => {
      contentListener?.dispose(); model = next;
      contentListener = next?.onDidChangeContent(() => content.forEach(cb => cb()));
      modelChanged.forEach(cb => cb());
    },
    getPosition: () => position,
    getSelection: () => selection,
    setPosition: (next: Position) => {
      position = next;
      selection = { startLineNumber: next.lineNumber, startColumn: next.column, endLineNumber: next.lineNumber, endColumn: next.column };
      cursor.forEach(cb => cb({ position }));
    },
    setSelection: (next: Selection) => { selection = next; position = { lineNumber: next.endLineNumber, column: next.endColumn }; },
    saveViewState: () => ({ position, selection }),
    restoreViewState: (state: { position: Position; selection: Selection }) => { position = state.position; selection = state.selection; },
    focus: () => focus.forEach(cb => cb()),
    onDidFocusEditorText: (cb: () => void) => listen(focus, cb),
    onDidChangeModel: (cb: () => void) => listen(modelChanged, cb),
    onDidChangeModelContent: (cb: () => void) => listen(content, cb),
    onDidChangeCursorPosition: (cb: (event: { position: Position }) => void) => listen(cursor, cb),
    onDidScrollChange: (cb: (event: { scrollTop: number; scrollLeft: number; scrollTopChanged: boolean; scrollLeftChanged: boolean }) => void) => listen(scroll, cb),
    getScrollTop: () => scrollTop, getScrollLeft: () => scrollLeft,
    setScrollPosition: (next: { scrollTop?: number; scrollLeft?: number }) => {
      const top = next.scrollTop ?? scrollTop, left = next.scrollLeft ?? scrollLeft;
      const event = { scrollTop: top, scrollLeft: left, scrollTopChanged: top !== scrollTop, scrollLeftChanged: left !== scrollLeft };
      scrollTop = top; scrollLeft = left; scroll.forEach(cb => cb(event));
    },
    revealLineInCenter: vi.fn(), revealRangeInCenterIfOutsideViewport: vi.fn(),
    listenerCount: () => focus.size + content.size + cursor.size + scroll.size + modelChanged.size,
  };
  return ed;
}

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); });

async function setup() {
  vi.resetModules(); vi.clearAllMocks();
  const disconnected = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnected; });
  document.body.innerHTML = '<div id="main-area"><div id="group-1"><ul id="tabbar"></ul><div id="breadcrumb-1"><span class="breadcrumb-path"></span></div><div id="editor-foot-1"></div></div><div id="group-splitter" hidden></div><div id="group-2" hidden><ul id="tabbar-2"></ul><div id="breadcrumb-2"><span class="breadcrumb-path"></span></div><div id="editor-foot-2"></div></div></div><button id="split-action"></button><button id="close-split"></button>';
  const { createEditorWorkspace } = await import("../src/app/editor-workspace");
  const { choiceDialog } = await import("../src/ui/dialog");
  const { readFile } = await import("../src/ipc");
  vi.mocked(choiceDialog).mockResolvedValue(1);
  const editors = [makeEditor(), makeEditor()] as const;
  const ctx = {
    cachedFile: vi.fn((path: string) => path.includes("slow") ? undefined : ({ content: "module top;\nwire a;\nwire b;\nendmodule", encoding: "utf8", mtime: 10 })),
    onFileChanged: vi.fn(), onActiveChange: vi.fn(), onContentChange: vi.fn(), onCursorChange: vi.fn(), hint: vi.fn(),
  };
  const workspace = createEditorWorkspace(editors as unknown as Parameters<typeof createEditorWorkspace>[0], ctx);
  cleanup.push(() => workspace.dispose());
  return { workspace, editors, ctx, disconnected, choice: vi.mocked(choiceDialog), read: vi.mocked(readFile) };
}

describe("编辑工作区", () => {
  it("移动脏标签到另一侧并拖回合并，不读盘、不询问丢弃且保留模型和位置", async () => {
    const { workspace: w, editors, choice, read } = await setup();
    await w.openFile("D:/p/a.v");
    const tab = w.activeGroup().tabs.activeTab!;
    tab.model.setValue("unsaved");
    editors[0].setPosition({ lineNumber: 3, column: 4 });
    await w.openFile("D:/p/b.v");
    await w.transferTab(0, tab, false);
    expect(w.groups.map(g => g.tabs.count)).toEqual([1, 1]);
    expect(editors[1].getPosition()).toEqual({ lineNumber: 3, column: 4 });
    expect(w.activeIndex).toBe(1);
    await w.transferTab(1, w.groups[1].tabs.activeTab!, false);
    expect(w.splitVisible).toBe(false);
    expect(w.groups.map(g => g.tabs.count)).toEqual([2, 0]);
    expect(w.activeGroup().tabs.activeTab!.model).toBe(tab.model);
    expect(tab.model.getValue()).toBe("unsaved");
    expect(tab.model.isDisposed()).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(choice).not.toHaveBeenCalled();
  });

  it("移走左侧最后一个标签时保留右侧，重复克隆不增加标签或改变对侧阅读位置", async () => {
    const { workspace: w, editors } = await setup();
    await w.openFile("D:/p/a.v");
    await w.openInOtherGroup();
    editors[1].setPosition({ lineNumber: 4, column: 5 });
    w.switchView(); await w.openInOtherGroup();
    expect(w.groups.map(g => g.tabs.count)).toEqual([1, 1]);
    expect(editors[1].getPosition()).toEqual({ lineNumber: 4, column: 5 });
    await w.transferTab(0, w.groups[0].tabs.activeTab!, false);
    expect(w.splitVisible).toBe(false); expect(w.activeIndex).toBe(1);
    expect(document.getElementById("group-1")!.hidden).toBe(true);
    expect(document.getElementById("group-2")!.hidden).toBe(false);
    await w.openInOtherGroup();
    expect(w.splitVisible).toBe(true); expect(w.activeIndex).toBe(0);
  });

  it("上下排列、交换及键盘调整不改变标签归属，同步滚动保持两轴独立与相对偏移", async () => {
    const { workspace: w, editors } = await setup();
    await w.openFile("D:/p/a.v"); await w.openInOtherGroup();
    const choose = (label: string) => {
      w.showViewMenu(0, 0);
      [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")].find(b => b.textContent === label)!.click();
    };
    choose("上下排列"); choose("交换两侧位置");
    expect(document.getElementById("main-area")!.classList.contains("stacked")).toBe(true);
    expect(document.getElementById("group-1")!.style.order).toBe("2");
    const pane = document.getElementById("group-1")!, divider = document.getElementById("group-splitter")!;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ height: 300 } as DOMRect);
    vi.spyOn(document.getElementById("main-area")!, "getBoundingClientRect").mockReturnValue({ height: 600 } as DOMRect);
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(pane.style.flex).toBe("0 0 324px");
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(pane.style.flex).toBe("");
    editors[0].setScrollPosition({ scrollTop: 100, scrollLeft: 20 });
    editors[1].setScrollPosition({ scrollTop: 300, scrollLeft: 80 });
    choose("同步纵向滚动");
    editors[1].setScrollPosition({ scrollTop: 350, scrollLeft: 90 });
    expect(editors[0].getScrollTop()).toBe(150); expect(editors[0].getScrollLeft()).toBe(20);
    choose("同步横向滚动");
    editors[0].setScrollPosition({ scrollLeft: 50 });
    expect(editors[1].getScrollLeft()).toBe(120);
    expect(w.activeIndex).toBe(1);
    w.collapseSplit(); editors[0].setScrollPosition({ scrollTop: 500 });
    expect(editors[1].getScrollTop()).toBe(350);
  });

  it("拖出标签弹出移动／克隆菜单，跨侧拖回自动合并，Esc 取消无副作用", async () => {
    const { workspace: w } = await setup();
    await w.openFile("D:/p/a.v"); await w.openFile("D:/p/b.v");
    const tab = w.activeGroup().tabs.activeTab!;
    let hit: Element = document.getElementById("editor-foot-1")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    const pointer = (target: EventTarget, type: string, x: number) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 100, button: 0 }));
    pointer(tab.element, "pointerdown", 10); pointer(document, "pointermove", 80);
    expect(document.querySelector(".tab-drop-hint")?.textContent).toContain("移动或克隆");
    pointer(document, "pointerup", 80);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector<HTMLButtonElement>(".ctx-item")!.click();
    await vi.waitFor(() => expect(w.splitVisible).toBe(true));
    const moved = w.groups[1].tabs.activeTab!;
    hit = document.getElementById("tabbar")!;
    pointer(moved.element, "pointerdown", 10); pointer(document, "pointermove", 80);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    pointer(document, "pointerup", 80);
    expect(w.groups.map(g => g.tabs.count)).toEqual([1, 1]);
    pointer(moved.element, "pointerdown", 10); pointer(document, "pointermove", 80); pointer(document, "pointerup", 80);
    await vi.waitFor(() => expect(w.splitVisible).toBe(false));
    expect(w.groups.map(g => g.tabs.count)).toEqual([2, 0]);
    expect(document.querySelector(".tab-drop-hint")).toBeNull();
  });

  it("两侧历史独立，后退和前进恢复原文件及选择范围", async () => {
    const { workspace: w, editors } = await setup();
    await w.openFile("D:/p/a.v", 2, 0, 2, 3);
    await w.navigateTo("D:/p/b.v", 3);
    await w.openFile("D:/p/c.v", 1, 1);
    await w.navigateTo("D:/p/d.v", 2);
    w.navBack();
    await vi.waitFor(() => expect(w.activeGroup().tabs.activeTab?.path).toBe("D:/p/c.v"));
    document.querySelector<HTMLButtonElement>('#breadcrumb-1 [aria-label="后退"]')!.click();
    await vi.waitFor(() => expect(w.activeGroup().tabs.activeTab?.path).toBe("D:/p/a.v"));
    expect(editors[0].getSelection()).toEqual({ startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 5 });
    w.navForward();
    await vi.waitFor(() => expect(w.groups[0].tabs.activeTab?.path).toBe("D:/p/b.v"));
    expect(w.groups[1].tabs.activeTab?.path).toBe("D:/p/c.v");
    w.resetHistory();
    expect([...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].every(button => button.disabled)).toBe(true);
  });

  it("分屏共用缓冲区，隐藏和恢复保留修改、光标、标签与宽度", async () => {
    const { workspace: w, editors } = await setup();
    await w.openFile("D:/p/a.v", 2);
    const original = w.activeGroup().tabs.activeTab!;
    await w.openInOtherGroup();
    expect(w.groups[1].tabs.activeTab!.model).toBe(original.model);
    original.model.setValue("changed");
    expect(w.groups[1].tabs.activeTab!.dirty).toBe(true);
    editors[1].setPosition({ lineNumber: 3, column: 4 });
    document.getElementById("group-1")!.style.flex = "0 0 450px";
    w.collapseSplit();
    expect(w.activeIndex).toBe(1);
    expect(w.groups[1].tabs.count).toBe(1);
    w.ensureSplit();
    expect(w.activeIndex).toBe(1);
    expect(editors[1].getPosition()).toEqual({ lineNumber: 3, column: 4 });
    expect(document.getElementById("group-1")!.style.flex).toBe("0 0 450px");
    expect(w.groups[1].tabs.activeTab!.model.getValue()).toBe("changed");
    expect(document.getElementById("group-1")!.hidden).toBe(false);
  });

  it("跨组关闭取消或保存失败时保留全部标签、分屏和活动组", async () => {
    const { workspace: w, choice } = await setup();
    await w.openFile("D:/p/a.v");
    await w.openFile("D:/p/b.v", undefined, 1);
    w.groups[0].tabs.activeTab!.model.setValue("dirty");
    choice.mockResolvedValue(2);
    expect(await w.closeAll()).toBe(false);
    expect(w.groups.map(group => group.tabs.count)).toEqual([1, 1]);
    expect(w.splitVisible).toBe(true); expect(w.activeIndex).toBe(1);
    const { fileStates } = await import("../src/ipc");
    vi.mocked(fileStates).mockRejectedValue(new Error("stat failed"));
    choice.mockResolvedValue(0);
    expect(await w.closeAll()).toBe(false);
    expect(w.groups.map(group => group.tabs.count)).toEqual([1, 1]);
    expect(w.splitVisible).toBe(true); expect(w.activeIndex).toBe(1);
    choice.mockResolvedValue(1);
    expect(await w.closeAll()).toBe(true);
    expect(w.groups.map(group => group.tabs.count)).toEqual([0, 0]);
    expect(w.splitVisible).toBe(false); expect(w.activeIndex).toBe(0);
  });

  it("在飞读取在关闭后不复活标签，切焦点也不改变原请求目标组", async () => {
    const { workspace: w, read, editors } = await setup();
    await w.openFile("D:/p/a.v");
    let resolve!: (file: { content: string; encoding: string; mtime: number }) => void;
    read.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = w.openFile("D:/p/slow.v", 3, 1);
    editors[0].focus();
    expect(await w.closeAll()).toBe(true);
    resolve({ content: "old", encoding: "utf8", mtime: 10 }); await pending;
    expect(w.groups.map(group => group.tabs.count)).toEqual([0, 0]);
    const next = w.openFile("D:/p/slow2.v", 3, 1);
    editors[0].focus();
    resolve({ content: "new", encoding: "utf8", mtime: 10 }); await next;
    expect(w.groups[0].tabs.count).toBe(0);
    expect(w.groups[1].tabs.activeTab!.path).toBe("D:/p/slow2.v");
  });

  it("仅活动侧派发光标事件，销毁释放两侧订阅与面包屑观察器", async () => {
    const { workspace: w, editors, ctx, disconnected } = await setup();
    editors[1].setPosition({ lineNumber: 9, column: 1 });
    expect(ctx.onCursorChange).not.toHaveBeenCalled();
    editors[1].focus(); editors[1].setPosition({ lineNumber: 5, column: 1 });
    expect(ctx.onCursorChange).toHaveBeenCalledWith(5);
    w.dispose(); expect(editors.map(ed => ed.listenerCount())).toEqual([0, 0]);
    expect(disconnected).toHaveBeenCalledTimes(2);
    ctx.onActiveChange.mockClear(); editors[0].focus();
    expect(ctx.onActiveChange).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".nav-btn")).toHaveLength(0);
  });

  it.each(["mouseup", "blur", "collapse", "dispose"])("拖动通过 %s 结束后不再响应 mousemove", async ending => {
    const { workspace: w } = await setup(); w.ensureSplit();
    const group = document.getElementById("group-1")!;
    vi.spyOn(group, "getBoundingClientRect").mockReturnValue({ width: 400 } as DOMRect);
    vi.spyOn(document.getElementById("main-area")!, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    document.getElementById("group-splitter")!.dispatchEvent(new MouseEvent("mousedown", { clientX: 400 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
    expect(group.style.flex).toBe("0 0 500px");
    if (ending === "collapse") w.collapseSplit();
    else if (ending === "dispose") w.dispose();
    else (ending === "blur" ? window : document).dispatchEvent(new Event(ending));
    expect(document.body.classList.contains("resizing")).toBe(false);
    const width = group.style.flex;
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 }));
    expect(group.style.flex).toBe(width);
  });
});
