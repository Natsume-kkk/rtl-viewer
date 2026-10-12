import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as monaco from "monaco-editor/editor/editor.api";
const state = vi.hoisted(() => ({ commands: [] as monaco.editor.IActionDescriptor[] }));
vi.mock("monaco-editor/editor/editor.api", () => ({ editor: {
  addEditorAction: (action: monaco.editor.IActionDescriptor) => { state.commands.push(action); return { dispose: () => { state.commands.splice(state.commands.indexOf(action), 1); } }; },
} }));
import { installEditorActions, registerEditorAction } from "../src/editor/actions";

function editor() {
  const actions = new Map<string, monaco.editor.IActionDescriptor>();
  let disposed: (() => void) | undefined;
  const instance = {
    addAction: (action: monaco.editor.IActionDescriptor) => { actions.set(action.id, action); return { dispose: () => { actions.delete(action.id); } }; },
    onDidDispose: (cb: () => void) => { disposed = cb; return { dispose: () => { disposed = undefined; } }; },
    dispose: () => disposed?.(), actions,
  };
  return instance;
}
beforeEach(() => { state.commands = []; });
describe("应用动作的命令面板入口", () => {
  it("覆盖已有和后来创建的视图，面板执行使用所属编辑器，菜单和键位仅注册一次", () => {
    const left = editor(), right = editor(), run = vi.fn();
    installEditorActions(left as unknown as monaco.editor.IStandaloneCodeEditor);
    const binding = registerEditorAction({ id: "rtl.trace", label: "追踪此信号", run,
      keybindings: [123], contextMenuGroupId: "navigation", precondition: "!editorReadonly", keybindingContext: "editorTextFocus" });
    installEditorActions(right as unknown as monaco.editor.IStandaloneCodeEditor);
    for (const view of [left, right]) {
      const action = view.actions.get("rtl.trace")!;
      expect(action.label).toBe("追踪此信号");
      expect(action.precondition).toBe("!editorReadonly");
      expect(action.keybindingContext).toBeUndefined();
      expect(action.keybindings).toBeUndefined();
      expect(action.contextMenuGroupId).toBeUndefined();
      action.run(view as unknown as monaco.editor.ICodeEditor);
    }
    expect(run.mock.calls.map(call => call[0])).toEqual([left, right]);
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0].keybindingContext).toBe("editorTextFocus");
    right.dispose();
    expect(right.actions.size).toBe(0);
    expect(left.actions.size).toBe(1);
    binding.dispose();
    expect(left.actions.size).toBe(0);
    expect(state.commands).toHaveLength(0);
    left.dispose();
  });
});
