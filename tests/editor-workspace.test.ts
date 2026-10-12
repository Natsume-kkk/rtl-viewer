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
  const cursor = new Set<(event: { position: Position }) => void>();
  function listen<T>(set: Set<T>, cb: T) { set.add(cb); return { dispose: () => set.delete(cb) }; }
  const ed = {
    getModel: () => model,
    setModel: (next: Model | null) => {
      contentListener?.dispose(); model = next;
      contentListener = next?.onDidChangeContent(() => content.forEach(cb => cb()));
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
    onDidChangeModelContent: (cb: () => void) => listen(content, cb),
    onDidChangeCursorPosition: (cb: (event: { position: Position }) => void) => listen(cursor, cb),
    revealLineInCenter: vi.fn(), revealRangeInCenterIfOutsideViewport: vi.fn(),
    listenerCount: () => focus.size + content.size + cursor.size,
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
    onFileChanged: vi.fn(), onActiveChange: vi.fn(), onContentChange: vi.fn(), onCursorChange: vi.fn(), onSplit: vi.fn(), hint: vi.fn(),
  };
  const workspace = createEditorWorkspace(editors as unknown as Parameters<typeof createEditorWorkspace>[0], ctx);
  cleanup.push(() => workspace.dispose());
  return { workspace, editors, ctx, disconnected, choice: vi.mocked(choiceDialog), read: vi.mocked(readFile) };
}

describe("编辑工作区", () => {
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
    const { workspace: w, editors, ctx } = await setup();
    await w.openFile("D:/p/a.v", 2);
    const original = w.activeGroup().tabs.activeTab!;
    await w.openInOtherGroup();
    expect(w.groups[1].tabs.activeTab!.model).toBe(original.model);
    original.model.setValue("changed");
    expect(w.groups[1].tabs.activeTab!.dirty).toBe(true);
    editors[1].setPosition({ lineNumber: 3, column: 4 });
    document.getElementById("group-1")!.style.flex = "0 0 450px";
    w.collapseSplit();
    expect(w.activeIndex).toBe(0);
    expect(w.groups[1].tabs.count).toBe(1);
    w.ensureSplit(); w.switchView();
    expect(w.activeIndex).toBe(1);
    expect(editors[1].getPosition()).toEqual({ lineNumber: 3, column: 4 });
    expect(document.getElementById("group-1")!.style.flex).toBe("0 0 450px");
    expect(w.groups[1].tabs.activeTab!.model.getValue()).toBe("changed");
    expect(ctx.onSplit).toHaveBeenCalledTimes(2);
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
