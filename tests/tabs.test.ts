// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/editor/monaco", () => {
  class FakeModel {
    disposed = false;
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
      for (const l of [...this.listeners]) l();
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
        createModel: (content: string, lang: string, uri: { toString(): string }) =>
          new FakeModel(content, lang, uri),
        setModelLanguage: () => {},
      },
      Uri: { parse: (s: string) => ({ toString: () => s }) },
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
  confirmDialog: vi.fn(),
  fileStates: vi.fn(),
  showInFolder: vi.fn(),
}));

function makeEditor() {
  let model: unknown = null;
  return {
    addCommand: vi.fn(),
    getModel: () => model,
    setModel: (m: unknown) => {
      model = m;
    },
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setPosition: vi.fn(),
    saveViewState: () => null,
    restoreViewState: vi.fn(),
    focus: vi.fn(),
    revealLineInCenter: vi.fn(),
  };
}

function makeEvents() {
  return { onActiveChange: vi.fn(), onFileReloaded: vi.fn(), onFileSaved: vi.fn() };
}

// modelStore 与 TabManager.managers 是模块级状态，每个用例重置模块注册表拿到干净实例
async function setup() {
  vi.clearAllMocks();
  vi.resetModules();
  const ipc = await import("../src/ipc");
  const { TabManager } = await import("../src/editor/tabs");
  const mocks = {
    readFile: vi.mocked(ipc.readFile),
    writeFile: vi.mocked(ipc.writeFile),
    saveFileDialog: vi.mocked(ipc.saveFileDialog),
    confirmDialog: vi.mocked(ipc.confirmDialog),
    fileStates: vi.mocked(ipc.fileStates),
  };
  mocks.confirmDialog.mockResolvedValue(true);
  const make = () =>
    new TabManager(
      makeEditor() as unknown as ConstructorParameters<typeof TabManager>[0],
      document.createElement("ul"),
      makeEvents(),
    );
  return { make, mocks };
}

describe("TabManager", () => {
  it("编辑标脏，保存后清脏并更新 mtime", async () => {
    const { make, mocks } = await setup();
    mocks.readFile.mockResolvedValue({ content: "module a;", encoding: "utf8", mtime: 100 });
    const tm = make();
    await tm.openFile("D:/p/a.v");
    const tab = tm.activeTab!;
    expect(tab.dirty).toBe(false);

    tab.model.setValue("module a; // edit");
    expect(tab.dirty).toBe(true);
    expect(tab.element.textContent).toContain("*");

    mocks.fileStates.mockResolvedValue([100]);
    mocks.writeFile.mockResolvedValue(200);
    await expect(tm.save()).resolves.toBe(true);
    expect(tab.dirty).toBe(false);
    expect(tab.mtime).toBe(200);
  });

  it("H1: 共享 model 一侧 reloadFromDisk 后两侧都不脏、内容一致、mtime 已同步", async () => {
    const { make } = await setup();
    const g0 = make();
    const g1 = make();
    g0.openContent("D:/p/a.v", "old", "utf8", 100);
    g1.openContent("D:/p/a.v", "old", "utf8", 100);
    const t0 = g0.activeTab!;
    const t1 = g1.activeTab!;
    expect(t0.model).toBe(t1.model);

    expect(g0.reloadFromDisk("D:/p/a.v", "new", "utf8", 300)).toBe(true);
    expect(t0.dirty).toBe(false);
    // 修复前：setValue 触发共享 model 监听器把对侧标脏，对侧之后再不重载
    expect(t1.dirty).toBe(false);
    expect(t1.model.getValue()).toBe("new");
    expect(t1.mtime).toBe(300);
    // 对侧随后仍能正常重载
    expect(g1.reloadFromDisk("D:/p/a.v", "new2", "utf8", 400)).toBe(true);
    expect(t0.dirty).toBe(false);
    expect(t0.mtime).toBe(400);
  });

  it("H3: saveAs 后 model 迁移到新 uri，旧 model 释放，另一组按路径打开共享新 model", async () => {
    const { make, mocks } = await setup();
    const tm = make();
    tm.newFile();
    const tab = tm.activeTab!;
    const oldModel = tab.model;
    expect(tab.uriKey).toBe("inmemory:///untitled-1");
    tab.model.setValue("module x;");
    expect(tab.dirty).toBe(true);

    mocks.saveFileDialog.mockResolvedValue("D:/p/new.v");
    mocks.writeFile.mockResolvedValue(500);
    await expect(tm.save()).resolves.toBe(true);

    expect(tab.path).toBe("D:/p/new.v");
    expect(tab.title).toBe("new.v");
    expect(tab.uriKey).toBe("file:///D:/p/new.v");
    expect(tab.model).not.toBe(oldModel);
    expect(tab.model.getValue()).toBe("module x;");
    expect(tab.dirty).toBe(false);
    expect((oldModel as unknown as { disposed: boolean }).disposed).toBe(true);

    // 新 uri 已按引用计数登记：另一组打开同路径共享同一个 model
    const tm2 = make();
    tm2.openContent("D:/p/new.v", "module x;", "utf8", 500);
    expect(tm2.activeTab!.model).toBe(tab.model);
    // 关闭本侧后另一侧仍持有引用，model 不被 dispose
    await tm.close(tab);
    expect((tab.model as unknown as { disposed: boolean }).disposed).toBe(false);
    // 另一侧编辑经新监听器正常标脏
    tm2.activeTab!.model.setValue("module x; // edit");
    expect(tm2.activeTab!.dirty).toBe(true);
  });

  it("M3: close 后共享 model 的变化不再触达已关闭标签", async () => {
    const { make } = await setup();
    const g0 = make();
    const g1 = make();
    g0.openContent("D:/p/a.v", "old", "utf8", 100);
    g1.openContent("D:/p/a.v", "old", "utf8", 100);
    const t0 = g0.activeTab!;
    const t1 = g1.activeTab!;

    await g1.close(t1);
    t0.model.setValue("changed");
    // 修复前：已关闭标签的监听器仍挂在共享 model 上，把孤儿标签标脏
    expect(t1.dirty).toBe(false);
    expect(t0.dirty).toBe(true);
  });

  it("M4: readFile 失败时 openFile 不抛出，经 confirmDialog 提示且不建标签", async () => {
    const { make, mocks } = await setup();
    mocks.readFile.mockRejectedValue(new Error("gone"));
    const tm = make();
    await expect(tm.openFile("D:/p/gone.v")).resolves.toBeUndefined();
    expect(mocks.confirmDialog).toHaveBeenCalledWith(expect.stringContaining("打开失败"));
    expect(tm.count).toBe(0);
  });

  it("M4: fileStates 失败时保存中止并提示，不写盘、保持脏标记", async () => {
    const { make, mocks } = await setup();
    mocks.readFile.mockResolvedValue({ content: "x", encoding: "utf8", mtime: 100 });
    const tm = make();
    await tm.openFile("D:/p/a.v");
    const tab = tm.activeTab!;
    tab.model.setValue("y");

    mocks.fileStates.mockRejectedValue(new Error("io"));
    await expect(tm.save()).resolves.toBe(false);
    expect(mocks.confirmDialog).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(tab.dirty).toBe(true);
  });
});
