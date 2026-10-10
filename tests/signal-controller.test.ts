// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { ModuleIndex } from "../src/model";
import { scanStructure } from "../src/parser";

const fake = vi.hoisted(() => ({ panels: [] as any[] }));
vi.mock("../src/editor/monaco", () => ({ monaco: { editor: { tokenize: () => [[{ offset: 0, type: "identifier" }]] } } }));
vi.mock("../src/ui/signal-flow", () => ({
  SignalFlowPanel: class {
    hint = vi.fn(); setBack = vi.fn(); setContexts = vi.fn(); clearStale = vi.fn(); markStale = vi.fn();
    message = vi.fn(); result = vi.fn(); logicResult = vi.fn(); capture = vi.fn(() => ({})); restore = vi.fn();
    constructor(_root: unknown, readonly actions: any) { fake.panels.push(this); }
  },
}));
import { createSignalController } from "../src/app/signal-controller";

beforeEach(() => { fake.panels.length = 0; });
function setup(scanned = true) {
  let source = "module top(input a, output q); wire mid; assign mid = a; assign q = mid; endmodule";
  let word = "mid", version = 1;
  const file = "D:/test/100%.v", contents = new Map([[file, source]]), structures = new Map([[file, scanStructure(source, file)]]);
  const index = new ModuleIndex(); index.addStructure([...structures.values()].flat());
  const model = { uri: { path: `/${file}`, authority: "" }, getWordAtPosition: () => ({ word }), getLanguageId: () => "verilog", getVersionId: () => version, getValue: () => source };
  const editor = { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: source.indexOf(`assign ${word}`) + 8 }) };
  const controller = createSignalController(document.createElement("div"), {
    editor: () => editor as any, files: () => (scanned ? contents : new Map<string, string>()).keys(), structures: () => structures, index: () => index,
    topName: () => "top", instancePath: () => undefined, fileContent: () => source, isOpen: () => true,
    close: vi.fn(), navigate: vi.fn(), hint: vi.fn(),
  });
  return { controller, panel: fake.panels[0], setWord: (s: string) => { word = s; }, edit: () => { version++; source = source.replace("mid = a", "mid = ~a"); } };
}

it("修改源码只标旧结果，刷新仍分析原目标，切换工程清理阅读历史", async () => {
  const { controller, panel, setWord, edit } = setup();
  await controller.analyze(); expect(panel.logicResult).toHaveBeenCalledWith("mid", expect.anything(), expect.anything(), expect.anything(), "");
  setWord("a"); edit(); controller.invalidate();
  expect(panel.markStale).toHaveBeenCalledTimes(1); expect(panel.logicResult).toHaveBeenCalledTimes(1);
  panel.actions.refresh(); await vi.waitFor(() => expect(panel.logicResult).toHaveBeenCalledTimes(2));
  expect(panel.logicResult.mock.lastCall[0]).toBe("mid");
  controller.reset(); panel.actions.refresh();
  expect(panel.logicResult).toHaveBeenCalledTimes(2); expect(panel.setContexts).toHaveBeenLastCalledWith([], 0);
});

it("异步端口追踪在换工程后不提交旧结果，控制器仍能再次使用", async () => {
  const { controller, panel, setWord } = setup(); setWord("q");
  const pending = controller.analyze(); controller.reset(); await pending;
  expect(panel.result).not.toHaveBeenCalled();
  await controller.analyze(); expect(panel.result).toHaveBeenCalledTimes(1);
});

it("单独打开的工程外文件刷新也使用原目标缓冲区", async () => {
  const { controller, panel, edit, setWord } = setup(false);
  await controller.analyze();
  edit(); setWord("a"); controller.invalidate();
  panel.actions.refresh(); await vi.waitFor(() => expect(panel.logicResult).toHaveBeenCalledTimes(2));
  expect(panel.logicResult.mock.lastCall[0]).toBe("mid");
});
