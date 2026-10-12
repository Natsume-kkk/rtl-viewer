import * as monaco from "monaco-editor/editor/editor.api";
import { appAlert } from "../ui/dialog";
import { registerEditorAction } from "./actions";

type Editor = monaco.editor.ICodeEditor;

/** 整行操作按行去重；以下一行第 1 列结束的选区不包含该行。 */
export function selectedLines(selections: readonly monaco.IRange[]): number[] {
  const lines = new Set<number>();
  for (const selection of selections) {
    const end = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1
      ? selection.endLineNumber - 1 : selection.endLineNumber;
    for (let line = selection.startLineNumber; line <= end; line++) lines.add(line);
  }
  return [...lines].sort((a, b) => a - b);
}

export async function clipboardLines(editor: Editor, cut: boolean): Promise<void> {
  const model = editor.getModel();
  const selections = editor.getSelections();
  if (!model || !selections?.length) return;
  const lines = selectedLines(selections);
  const version = model.getVersionId();
  const eol = model.getEOL();
  // Monaco 多个空光标的整行复制会在已有 EOL 之间再插入 LF。直接写标准文本，
  // 同时保证末行没有 EOL 时仍复制为完整一行，复制全程不改变原选区。
  await navigator.clipboard.writeText(lines.map(line => model.getLineContent(line)).join(eol) + eol);
  if (!cut) return;
  const current = editor.getSelections();
  // 剪贴板写入可能异步等待权限；不能删除等待期间已经修改或重新选择的源码。
  if (model.isDisposed() || editor.getModel() !== model || model.getVersionId() !== version
    || editor.getOption(monaco.editor.EditorOption.readOnly) || current?.length !== selections.length
    || current.some((selection, index) => {
      const original = selections[index];
      return selection.startLineNumber !== original.startLineNumber || selection.startColumn !== original.startColumn
        || selection.endLineNumber !== original.endLineNumber || selection.endColumn !== original.endColumn;
    })) return;
  const groups: { start: number; end: number }[] = [];
  for (const line of lines) {
    const previous = groups.at(-1);
    if (previous && previous.end + 1 === line) previous.end = line;
    else groups.push({ start: line, end: line });
  }
  const edits = groups.map(({ start, end }) => ({
    range: end < model.getLineCount() ? new monaco.Range(start, 1, end + 1, 1)
      : start > 1 ? new monaco.Range(start - 1, model.getLineMaxColumn(start - 1), end, model.getLineMaxColumn(end))
        : new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
    text: "", forceMoveMarkers: true,
  }));
  editor.pushUndoStop();
  editor.executeEdits("rtl.cut-lines", edits, inverse => inverse.map(edit =>
    new monaco.Selection(edit.range.startLineNumber, edit.range.startColumn, edit.range.startLineNumber, edit.range.startColumn)));
  editor.pushUndoStop();
}

let registered = false;

export function registerNotepadKeymap(): void {
  if (registered) return;
  registered = true;
  const ctrl = monaco.KeyMod.CtrlCmd, shift = monaco.KeyMod.Shift, alt = monaco.KeyMod.Alt;
  registerEditorAction({
    id: "rtl.cut-lines", label: "剪切整行", precondition: "!editorReadonly",
    run: editor => clipboardLines(editor, true).catch(error => appAlert(`剪切失败：无法写入剪贴板（${String(error)}）`)),
  });
  registerEditorAction({
    id: "rtl.copy-lines", label: "复制整行",
    run: editor => clipboardLines(editor, false).catch(error => appAlert(`复制失败：无法写入剪贴板（${String(error)}）`)),
  });
  // 后注册的应用规则覆盖 Monaco 的同键绑定，包括 Ctrl+K 组合键前缀。
  const bindings: [number, string, boolean?][] = [
    [ctrl | monaco.KeyCode.KeyD, "editor.action.duplicateSelection", true],
    [ctrl | monaco.KeyCode.KeyL, "rtl.cut-lines", true],
    [ctrl | shift | monaco.KeyCode.KeyL, "editor.action.deleteLines", true],
    [ctrl | shift | monaco.KeyCode.KeyX, "rtl.copy-lines"],
    [ctrl | monaco.KeyCode.KeyT, "editor.action.moveLinesUpAction", true],
    [ctrl | shift | monaco.KeyCode.UpArrow, "editor.action.moveLinesUpAction", true],
    [ctrl | shift | monaco.KeyCode.DownArrow, "editor.action.moveLinesDownAction", true],
    [ctrl | monaco.KeyCode.KeyQ, "editor.action.commentLine", true],
    [ctrl | monaco.KeyCode.KeyK, "editor.action.addCommentLine", true],
    [ctrl | shift | monaco.KeyCode.KeyK, "editor.action.removeCommentLine", true],
    [ctrl | shift | monaco.KeyCode.KeyQ, "editor.action.blockComment", true],
    [ctrl | monaco.KeyCode.KeyU, "editor.action.transformToLowercase", true],
    [ctrl | shift | monaco.KeyCode.KeyU, "editor.action.transformToUppercase", true],
    [ctrl | monaco.KeyCode.KeyB, "editor.action.jumpToBracket"],
    [ctrl | alt | monaco.KeyCode.KeyB, "editor.action.selectToBracket"],
    [alt | monaco.KeyCode.Digit0, "editor.foldAll"],
    [alt | shift | monaco.KeyCode.Digit0, "editor.unfoldAll"],
    [ctrl | alt | monaco.KeyCode.KeyF, "editor.fold"],
    [ctrl | alt | shift | monaco.KeyCode.KeyF, "editor.unfold"],
    [ctrl | monaco.KeyCode.KeyJ, "editor.action.joinLines", true],
    [ctrl | monaco.KeyCode.Enter, "editor.action.triggerSuggest", true],
    [ctrl | alt | monaco.KeyCode.Enter, "editor.action.insertLineBefore", true],
    [ctrl | alt | shift | monaco.KeyCode.Enter, "editor.action.insertLineAfter", true],
    [ctrl | monaco.KeyCode.Backslash, "cursorWordPartRight"],
    [ctrl | shift | monaco.KeyCode.Backslash, "cursorWordPartRightSelect"],
  ];
  monaco.editor.addKeybindingRules([
    // 显式取消旧行为，避免只读状态等条件下回落到 VS Code 的多光标操作。
    { keybinding: ctrl | monaco.KeyCode.KeyD, command: "-editor.action.addSelectionToNextFindMatch" },
    { keybinding: ctrl | shift | monaco.KeyCode.KeyL, command: "-editor.action.selectHighlights" },
    { keybinding: ctrl | monaco.KeyCode.KeyL, command: "-expandLineSelection" },
    { keybinding: ctrl | monaco.KeyCode.KeyU, command: "-cursorUndo" },
    ...bindings.map(([keybinding, command, writable]) => ({
      keybinding, command, when: writable ? "editorTextFocus && !editorReadonly" : "editorTextFocus",
    })),
  ]);
}

/**
 * Monaco 的默认 Alt 拖动移动最后一个光标，Alt+Shift 才矩形选择。
 * 仅在 Alt 左键手势中临时让 Alt 不再充当多光标修饰键，复用其矩形算法；
 * 平时仍用默认配置，保留 Ctrl+Click 跳转定义。
 */
export function installAltColumnDrag(editor: Editor): monaco.IDisposable {
  const container = editor.getContainerDomNode();
  const ownerWindow = container.ownerDocument.defaultView!;
  let previous: "alt" | "ctrlCmd" | undefined;
  const restore = () => {
    if (previous === undefined) return;
    const modifier = previous;
    previous = undefined;
    editor.updateOptions({ multiCursorModifier: modifier });
  };
  const down = (event: MouseEvent) => {
    if (event.button !== 0 || !event.altKey || event.ctrlKey || event.metaKey) return;
    // 小地图、行号和滚动条继续遵循 Monaco 自己的手势。
    const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
    if (target?.type !== monaco.editor.MouseTargetType.CONTENT_TEXT && target?.type !== monaco.editor.MouseTargetType.CONTENT_EMPTY) return;
    if (previous !== undefined) return;
    previous = editor.getRawOptions().multiCursorModifier ?? "alt";
    editor.updateOptions({ multiCursorModifier: "ctrlCmd" });
  };
  const keyup = (event: KeyboardEvent) => { if (event.key === "Alt") restore(); };
  container.addEventListener("mousedown", down, true);
  ownerWindow.addEventListener("mouseup", restore);
  ownerWindow.addEventListener("keyup", keyup);
  ownerWindow.addEventListener("blur", restore);
  const dispose = () => {
    restore();
    container.removeEventListener("mousedown", down, true);
    ownerWindow.removeEventListener("mouseup", restore);
    ownerWindow.removeEventListener("keyup", keyup);
    ownerWindow.removeEventListener("blur", restore);
  };
  const subscription = editor.onDidDispose(dispose);
  return { dispose() { dispose(); subscription.dispose(); } };
}
