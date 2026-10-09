// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor/editor/editor.api";

vi.mock("monaco-editor/editor/editor.api", () => ({
  Range: class {
    constructor(readonly startLineNumber: number, readonly startColumn: number,
      readonly endLineNumber: number, readonly endColumn: number) {}
  },
  Selection: class {
    constructor(readonly startLineNumber: number, readonly startColumn: number,
      readonly endLineNumber: number, readonly endColumn: number) {}
  },
  editor: { MouseTargetType: { CONTENT_TEXT: 6, CONTENT_EMPTY: 7, GUTTER_LINE_NUMBERS: 2 }, EditorOption: { readOnly: 1 } },
}));

import { clipboardLines, installAltColumnDrag, selectedLines } from "../src/editor/notepad-keymap";

const range = (startLineNumber: number, startColumn: number, endLineNumber = startLineNumber, endColumn = startColumn) =>
  ({ startLineNumber, startColumn, endLineNumber, endColumn });

describe("Notepad++ 整行剪贴板", () => {
  function setup(lines: string[], original: ReturnType<typeof range>[], eol = "\r\n") {
    let selections = original, version = 1;
    const model = { getEOL: () => eol, getLineContent: (line: number) => lines[line - 1],
      getLineCount: () => lines.length, getLineMaxColumn: (line: number) => lines[line - 1].length + 1,
      getVersionId: () => version, isDisposed: () => false };
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const executeEdits = vi.fn((_source: string, _edits: Monaco.editor.IIdentifiedSingleEditOperation[], _endCursorState?: unknown) => true), pushUndoStop = vi.fn();
    const editor = { getModel: () => model, getSelections: () => selections, getOption: () => false,
      executeEdits, pushUndoStop } as unknown as Monaco.editor.ICodeEditor;
    return { editor, writeText, executeEdits, pushUndoStop, selections: () => selections,
      select: (value: typeof original) => { selections = value; }, change: () => { version++; } };
  }
  it("包含部分行，排除终点第 1 列的下一行，多选区去重排序", () => {
    expect(selectedLines([range(3, 2, 5, 1), range(1, 4, 3, 8), range(5, 1)])).toEqual([1, 2, 3, 4, 5]);
    expect(selectedLines([range(2, 4, 4, 1)])).toEqual([2, 3]);
    expect(selectedLines([range(4, 1)])).toEqual([4]);
  });

  it("复制连续行仅保留原 EOL，不生成额外空行，不改变原选区", async () => {
    const original = [range(1, 2, 3, 1)];
    const state = setup(["abc", "def", "ghi"], original);
    await clipboardLines(state.editor, false);
    expect(state.writeText).toHaveBeenCalledExactlyOnceWith("abc\r\ndef\r\n");
    expect(state.selections()).toBe(original);
    expect(state.executeEdits).not.toHaveBeenCalled();
  });

  it("复制矩形选区所在整行及无换行末行，保留 LF 文件的 EOL", async () => {
    const original = [range(1, 2, 1, 4), range(2, 2, 2, 4)];
    const state = setup(["abc", "def"], original, "\n");
    await clipboardLines(state.editor, false);
    expect(state.writeText).toHaveBeenCalledExactlyOnceWith("abc\ndef\n");
    expect(state.selections()).toBe(original);
  });

  it("连续行剪切文本没有额外空行，合并为一个删除范围", async () => {
    const state = setup(["abc", "def", "ghi", "last"], [range(2, 2, 4, 1), range(3, 2)]);
    await clipboardLines(state.editor, true);
    expect(state.writeText).toHaveBeenCalledExactlyOnceWith("def\r\nghi\r\n");
    expect(state.executeEdits).toHaveBeenCalledWith("rtl.cut-lines", [{ range: range(2, 1, 4, 1), text: "", forceMoveMarkers: true }], expect.any(Function));
    expect(state.pushUndoStop).toHaveBeenCalledTimes(2);
  });

  it("剪切末行连同前面的 EOL，剪切整个单行文件只删内容", async () => {
    const last = setup(["abc", "def"], [range(2, 2)]);
    await clipboardLines(last.editor, true);
    expect(last.writeText).toHaveBeenCalledExactlyOnceWith("def\r\n");
    expect(last.executeEdits.mock.calls[0][1]).toEqual([{ range: range(1, 4, 2, 4), text: "", forceMoveMarkers: true }]);
    const single = setup(["abc"], [range(1, 2)]);
    await clipboardLines(single.editor, true);
    expect(single.executeEdits.mock.calls[0][1]).toEqual([{ range: range(1, 1, 1, 4), text: "", forceMoveMarkers: true }]);
    const emptyLast = setup(["abc", ""], [range(2, 1)]);
    await clipboardLines(emptyLast.editor, true);
    expect(emptyLast.writeText).toHaveBeenCalledExactlyOnceWith("\r\n");
    expect(emptyLast.executeEdits.mock.calls[0][1]).toEqual([{ range: range(1, 4, 2, 1), text: "", forceMoveMarkers: true }]);
  });

  it("剪贴板失败不删除；异步等待期间源码或选区变化不删除", async () => {
    const failure = setup(["abc"], [range(1, 2)]);
    failure.writeText.mockRejectedValue(new Error("denied"));
    await expect(clipboardLines(failure.editor, true)).rejects.toThrow("denied");
    expect(failure.executeEdits).not.toHaveBeenCalled();
    for (const change of ["model", "selection"]) {
      const state = setup(["abc", "def"], [range(1, 2)]);
      let resolve = () => {};
      state.writeText.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
      const operation = clipboardLines(state.editor, true);
      if (change === "model") state.change(); else state.select([range(2, 2)]);
      resolve(); await operation;
      expect(state.executeEdits).not.toHaveBeenCalled();
    }
  });
});

describe("Alt 矩形拖动配置生命周期", () => {
  function setup(initial: "alt" | "ctrlCmd" = "alt") {
    const container = document.createElement("div");
    document.body.append(container);
    let modifier = initial, targetType = 6;
    let onDispose = () => {};
    const updateOptions = vi.fn((value: { multiCursorModifier: "alt" | "ctrlCmd" }) => { modifier = value.multiCursorModifier; });
    const editor = {
      getContainerDomNode: () => container,
      getTargetAtClientPoint: () => ({ type: targetType }),
      getRawOptions: () => ({ multiCursorModifier: modifier }), updateOptions,
      onDidDispose: (callback: () => void) => { onDispose = callback; return { dispose: vi.fn() }; },
    } as unknown as Monaco.editor.ICodeEditor;
    const adapter = installAltColumnDrag(editor);
    return { container, modifier: () => modifier, updateOptions, target: (value: number) => { targetType = value; },
      disposeEditor: () => onDispose(), adapter };
  }
  function down(container: HTMLElement, extra: MouseEventInit = {}) {
    container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, altKey: true, ...extra }));
  }

  it("仅 Alt 内容左键切换，鼠标释放恢复；普通 Ctrl+Click 保留原配置", () => {
    const state = setup();
    down(state.container, { altKey: false, ctrlKey: true });
    expect(state.updateOptions).not.toHaveBeenCalled();
    down(state.container);
    expect(state.modifier()).toBe("ctrlCmd");
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(state.modifier()).toBe("alt");
    state.adapter.dispose(); state.container.remove();
  });

  it("排除行号、右键及组合修饰键", () => {
    const state = setup();
    state.target(2); down(state.container);
    state.target(6); down(state.container, { button: 2 });
    down(state.container, { ctrlKey: true }); down(state.container, { metaKey: true });
    expect(state.updateOptions).not.toHaveBeenCalled();
    state.adapter.dispose(); state.container.remove();
  });

  it("Alt 松开、窗口失焦和 editor 销毁均恢复，销毁后不再监听", () => {
    const state = setup();
    down(state.container); window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
    expect(state.modifier()).toBe("alt");
    down(state.container); window.dispatchEvent(new Event("blur"));
    expect(state.modifier()).toBe("alt");
    down(state.container); state.disposeEditor();
    expect(state.modifier()).toBe("alt");
    state.updateOptions.mockClear(); down(state.container);
    expect(state.updateOptions).not.toHaveBeenCalled();
    state.adapter.dispose(); state.container.remove();
  });

  it("不把原有 ctrlCmd 偏好改回 alt，重复 mousedown 不覆盖恢复值", () => {
    const state = setup("ctrlCmd");
    down(state.container); down(state.container);
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(state.modifier()).toBe("ctrlCmd");
    state.adapter.dispose(); state.container.remove();
  });
});
