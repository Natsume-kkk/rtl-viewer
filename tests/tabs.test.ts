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
  fileStates: vi.fn(),
  showInFolder: vi.fn(),
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}));

vi.mock("../src/ui/dialog", () => ({
  choiceDialog: vi.fn(),
  appConfirm: vi.fn(),
  appAlert: vi.fn(),
}));

let editorSeq = 0;
function makeEditor() {
  let model: unknown = null;
  const id = `test-editor-${++editorSeq}`;
  return {
    addCommand: vi.fn(),
    getId: () => id,
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
  const dialog = await import("../src/ui/dialog");
  const { TabManager } = await import("../src/editor/tabs");
  const mocks = {
    readFile: vi.mocked(ipc.readFile),
    writeFile: vi.mocked(ipc.writeFile),
    saveFileDialog: vi.mocked(ipc.saveFileDialog),
    appConfirm: vi.mocked(dialog.appConfirm),
    appAlert: vi.mocked(dialog.appAlert),
    choiceDialog: vi.mocked(dialog.choiceDialog),
    fileStates: vi.mocked(ipc.fileStates),
  };
  mocks.appConfirm.mockResolvedValue(true);
  mocks.choiceDialog.mockResolvedValue(0);
  const make = () =>
    new TabManager(
      makeEditor() as unknown as ConstructorParameters<typeof TabManager>[0],
      document.createElement("ul"),
      makeEvents(),
    );
  return { make, mocks };
}

describe("TabManager", () => {
  it.each([
    [0, "v", "verilog"],
    [1, "vhd", "vhdl"],
    [2, "sv", "verilog"],
  ] as const)("新建类型 %s 在保存前启用 %s 语言，保存建议保留后缀", async (choice, ext, language) => {
    const { make, mocks } = await setup();
    mocks.choiceDialog.mockResolvedValue(choice);
    const tm = make();
    tm.newFile(ext);
    const tab = tm.activeTab!;
    expect(tab.title).toBe(`untitled-1.${ext}`);
    expect(tab.uriKey).toBe(`inmemory:///untitled-1.${ext}`);
    expect(tab.model.getLanguageId()).toBe(language);
    expect(tab.path).toBe("");
    expect(mocks.writeFile).not.toHaveBeenCalled();
    tab.model.setValue("source");
    mocks.saveFileDialog.mockResolvedValue(null);
    await expect(tm.save()).resolves.toBe(false);
    expect(mocks.saveFileDialog).toHaveBeenCalledWith(tab.title);
    expect(tab.model.getValue()).toBe("source");
    expect(tab.dirty).toBe(true);
    expect(tab.model.getLanguageId()).toBe(language);
    mocks.saveFileDialog.mockResolvedValue(`D:/p/new.${ext}`);
    mocks.writeFile.mockResolvedValue(500);
    await expect(tm.save()).resolves.toBe(true);
    expect(tab.model.getLanguageId()).toBe(language);
    expect(tab.model.getValue()).toBe("source");
    expect(tab.dirty).toBe(false);
  });

  it("新建优先沿用当前源码目录，连续新建和取消保存保留建议目录", async () => {
    const { make, mocks } = await setup();
    const tm = make();
    tm.openContent("D:/p/rtl/current.v", "module current; endmodule", "utf8", 0);
    tm.newFile("sv", "D:/p");
    tm.newFile("vhd", "D:/p");
    mocks.saveFileDialog.mockResolvedValue(null);
    await tm.save();
    expect(mocks.saveFileDialog).toHaveBeenCalledWith("D:/p/rtl/untitled-2.vhd");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("没有源码标签时首次保存建议工程根目录，激活标签滚入可视区", async () => {
    const { make, mocks } = await setup();
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const tm = make(); tm.newFile("v", "D:/project/");
    mocks.saveFileDialog.mockResolvedValue(null); await tm.save();
    expect(mocks.saveFileDialog).toHaveBeenCalledWith("D:/project/untitled-1.v");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("没有工程时连续新建不会把上个未命名文件当作目录", async () => {
    const { make, mocks } = await setup();
    const tm = make(); tm.newFile("v"); tm.newFile("vhd");
    mocks.saveFileDialog.mockResolvedValue(null); await tm.save();
    expect(mocks.saveFileDialog).toHaveBeenCalledWith("untitled-2.vhd");
  });

  it("批量关闭取消时保留所有组的全部标签，包括干净标签", async () => {
    const { make, mocks } = await setup();
    const { TabManager } = await import("../src/editor/tabs");
    const a = make(), b = make();
    a.openContent("D:/p/clean.v", "clean", "utf8", 0);
    b.openContent("D:/p/dirty.v", "old", "utf8", 0);
    b.activeTab!.model.setValue("edited");
    mocks.choiceDialog.mockResolvedValue(2);
    await expect(TabManager.closeGroups([a, b])).resolves.toBe(false);
    expect(a.count).toBe(1); expect(b.count).toBe(1);
    expect(b.activeTab!.model.getValue()).toBe("edited");
    expect(mocks.choiceDialog).toHaveBeenCalledWith(expect.any(String), ["保存并关闭", "不保存", "取消"], 2);
  });

  it("保存后关闭成功才移除标签，写失败和另存为取消均保留全部标签", async () => {
    const { make, mocks } = await setup();
    const tm = make(); tm.openContent("D:/p/a.v", "old", "utf8", 0);
    tm.activeTab!.model.setValue("edited");
    mocks.choiceDialog.mockResolvedValue(0); mocks.writeFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(tm.closeAll()).resolves.toBe(false); expect(tm.count).toBe(1);
    mocks.writeFile.mockResolvedValue(200);
    await expect(tm.closeAll()).resolves.toBe(true); expect(tm.count).toBe(0);
    await tm.newFile(); tm.activeTab!.model.setValue("new source"); mocks.saveFileDialog.mockResolvedValue(null);
    await expect(tm.closeAll()).resolves.toBe(false); expect(tm.count).toBe(1);
  });

  it("共享脏缓冲区关闭一侧不丢内容，全部退出只确认和保存一次", async () => {
    const { make, mocks } = await setup();
    const { TabManager } = await import("../src/editor/tabs");
    const a = make(), b = make();
    for (const tm of [a, b]) tm.openContent("D:/p/shared.v", "old", "utf8", 0);
    a.activeTab!.model.setValue("edited");
    await expect(a.closeAll()).resolves.toBe(true); expect(mocks.choiceDialog).not.toHaveBeenCalled();
    expect(b.activeTab!.model.getValue()).toBe("edited");
    a.openContent("D:/p/shared.v", "old", "utf8", 0);
    expect(a.activeTab!.dirty).toBe(true);
    await b.closeAll();
    expect(a.activeTab!.dirty).toBe(true);
    b.openContent("D:/p/shared.v", "old", "utf8", 0);
    mocks.choiceDialog.mockResolvedValue(0); mocks.writeFile.mockResolvedValue(300);
    await expect(TabManager.confirmExit([a, b])).resolves.toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1); expect(a.count).toBe(1); expect(b.count).toBe(1);
  });

  it("不保存关闭不写磁盘，关闭非活动脏标签保存正确的文件", async () => {
    const { make, mocks } = await setup(); const tm = make();
    tm.openContent("D:/p/a.v", "old", "utf8", 0); const first = tm.activeTab!; first.model.setValue("edited");
    tm.openContent("D:/p/b.v", "other", "utf8", 0);
    mocks.choiceDialog.mockResolvedValueOnce(0); mocks.writeFile.mockResolvedValue(100);
    await expect(tm.close(first)).resolves.toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith("D:/p/a.v", "edited", "utf8");
    tm.activeTab!.model.setValue("discard"); mocks.writeFile.mockClear(); mocks.choiceDialog.mockResolvedValue(1);
    await expect(tm.closeAll()).resolves.toBe(true); expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it("Ctrl+S 只保存聚焦编辑组，另一侧关闭后仍可保存左侧", async () => {
    const { mocks } = await setup();
    const { TabManager } = await import("../src/editor/tabs");
    const editors = [makeEditor(), makeEditor()];
    const managers = editors.map(ed => new TabManager(ed as unknown as ConstructorParameters<typeof TabManager>[0], document.createElement("ul"), makeEvents()));
    managers[0].openContent("D:/p/left.v", "left", "utf8", 0);
    managers[1].openContent("D:/p/right.v", "right", "utf8", 0);
    await managers[1].closeAll();
    managers[0].activeTab!.model.setValue("left edited");
    mocks.writeFile.mockResolvedValue(200);
    // Monaco 的动态快捷键共享注册表，后注册者优先；只有 context 匹配才生效。
    const commands = editors.flatMap(ed => ed.addCommand.mock.calls);
    const applicable = commands.filter(([, , context]) => !context || context.includes(editors[0].getId()));
    applicable.at(-1)![1]();
    await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledWith("D:/p/left.v", "left edited", "utf8"));
    expect(managers[0].activeTab!.dirty).toBe(false);
  });

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
    await tm.newFile();
    const tab = tm.activeTab!;
    const oldModel = tab.model;
    expect(tab.uriKey).toBe("inmemory:///untitled-1.v");
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

  it("另存为对话框返回反斜杠路径时归一为正斜杠，tab.path 与 uriKey 一致", async () => {
    const { make, mocks } = await setup();
    const tm = make();
    await tm.newFile();
    const tab = tm.activeTab!;
    tab.model.setValue("module x;");
    mocks.saveFileDialog.mockResolvedValue("D:\\p\\sub\\new.v");
    mocks.writeFile.mockResolvedValue(500);
    await expect(tm.save()).resolves.toBe(true);
    expect(tab.path).toBe("D:/p/sub/new.v");
    expect(tab.uriKey).toBe("file:///D:/p/sub/new.v");
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

  it("M4: readFile 失败时 openFile 不抛出，经 appAlert 提示且不建标签", async () => {
    const { make, mocks } = await setup();
    mocks.readFile.mockRejectedValue(new Error("gone"));
    const tm = make();
    await expect(tm.openFile("D:/p/gone.v")).resolves.toBeUndefined();
    expect(mocks.appAlert).toHaveBeenCalledWith(expect.stringContaining("打开失败"));
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
    expect(mocks.appAlert).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(tab.dirty).toBe(true);
  });

  it("H4: 保存遇外部修改选择「放弃修改重新加载」后，对侧标签同步清脏与徽章", async () => {
    const { make, mocks } = await setup();
    const g0 = make();
    const g1 = make();
    g0.openContent("D:/p/a.v", "old", "utf8", 100);
    g1.openContent("D:/p/a.v", "old", "utf8", 100);
    const t0 = g0.activeTab!;
    const t1 = g1.activeTab!;
    t0.model.setValue("mine");
    g0.markExternalChanged("D:/p/a.v", true);
    g1.markExternalChanged("D:/p/a.v", true);

    mocks.fileStates.mockResolvedValue([300]);
    mocks.choiceDialog.mockResolvedValue(1);
    mocks.readFile.mockResolvedValue({ content: "disk", encoding: "utf8", mtime: 300 });
    await expect(g0.save()).resolves.toBe(false);

    expect(t0.dirty).toBe(false);
    // 修复前：doWrite 重载分支漏了 syncPeers，对侧仍脏且保留外部修改徽章
    expect(t1.dirty).toBe(false);
    expect(t1.externalChanged).toBe(false);
    expect(t1.mtime).toBe(300);
  });

  it("H5: 两组各自新建 untitled 时 uriKey 不冲突、不共享 model", async () => {
    const { make } = await setup();
    const g0 = make();
    const g1 = make();
    await g0.newFile();
    await g1.newFile();
    // 修复前：untitled 计数是实例字段，两组都从 1 开始，uriKey 相同导致共享 model
    expect(g0.activeTab!.uriKey).not.toBe(g1.activeTab!.uriKey);
    expect(g0.activeTab!.model).not.toBe(g1.activeTab!.model);
  });

  it("保存遇外部修改选择「覆盖保存」：写盘成功并清脏", async () => {
    const { make, mocks } = await setup();
    mocks.readFile.mockResolvedValue({ content: "old", encoding: "utf8", mtime: 100 });
    const tm = make();
    await tm.openFile("D:/p/a.v");
    const tab = tm.activeTab!;
    tab.model.setValue("mine");

    mocks.fileStates.mockResolvedValue([300]);
    mocks.choiceDialog.mockResolvedValue(0);
    mocks.writeFile.mockResolvedValue(400);
    await expect(tm.save()).resolves.toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledWith("D:/p/a.v", "mine", "utf8");
    expect(tab.dirty).toBe(false);
    expect(tab.mtime).toBe(400);
  });

  it("保存遇外部修改选择「取消」/Esc：不写盘、保持脏标记", async () => {
    for (const choice of [2, -1]) {
      const { make, mocks } = await setup();
      mocks.readFile.mockResolvedValue({ content: "old", encoding: "utf8", mtime: 100 });
      const tm = make();
      await tm.openFile("D:/p/a.v");
      const tab = tm.activeTab!;
      tab.model.setValue("mine");

      mocks.fileStates.mockResolvedValue([300]);
      mocks.choiceDialog.mockResolvedValue(choice);
      await expect(tm.save()).resolves.toBe(false);
      expect(mocks.writeFile).not.toHaveBeenCalled();
      expect(tab.dirty).toBe(true);
    }
  });
});
