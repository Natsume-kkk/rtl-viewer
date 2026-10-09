import { monaco } from "./monaco";
import { columnTargets, columnValues, type ColumnOptions } from "./column-edit";
import { appAlert } from "../ui/dialog";

let last: ColumnOptions = { mode: "number", initial: "1", step: "1", repeat: "1", base: 10, leading: "none", uppercase: true };

export async function openColumnEditor(editor: monaco.editor.IStandaloneCodeEditor): Promise<void> {
  const model = editor.getModel(), selections = editor.getSelections();
  if (!model || !selections || editor.getOption(monaco.editor.EditorOption.readOnly) || document.querySelector(".choice-overlay")) return;
  let targets;
  try { targets = columnTargets(model.getLinesContent(), selections, model.getOptions().tabSize); }
  catch (error) { await appAlert((error as Error).message); editor.focus(); return; }
  const version = model.getVersionId();
  const overlay = document.createElement("div"); overlay.className = "choice-overlay";
  const form = document.createElement("form"); form.className = "choice-box column-editor";
  form.setAttribute("role", "dialog"); form.setAttribute("aria-modal", "true"); form.setAttribute("aria-labelledby", "column-editor-title");
  form.innerHTML = `<h2 id="column-editor-title">列编辑</h2>
    <p class="column-scope"></p>
    <label class="column-mode"><input type="radio" name="mode" value="text">插入文本</label>
    <fieldset class="column-text"><label>文本<input name="text" type="text" autocomplete="off"></label></fieldset>
    <label class="column-mode"><input type="radio" name="mode" value="number">插入数字</label>
    <fieldset class="column-numbers">
      <label>初始值<input name="initial" value="1" maxlength="65" autocomplete="off"></label>
      <label>增量<input name="step" value="1" maxlength="65" autocomplete="off"></label>
      <label>重复次数<input name="repeat" value="1" maxlength="65" autocomplete="off"></label>
      <label>进制<select name="base"><option value="10">十进制</option><option value="16">十六进制</option><option value="8">八进制</option><option value="2">二进制</option></select></label>
      <label>前导填充<select name="leading"><option value="none">无</option><option value="zeros">补零</option><option value="spaces">补空格</option></select></label>
      <label>十六进制<select name="uppercase"><option value="true">大写 A-F</option><option value="false">小写 a-f</option></select></label>
      <p class="column-help">数字输入框使用所选进制；重复次数表示同一个数连续填入几处。</p>
    </fieldset>
    <div class="column-preview" aria-live="polite"></div><div class="column-error" role="alert"></div>
    <div class="choice-buttons"><button type="submit" class="primary">确定</button><button type="button" class="column-cancel">取消</button></div>`;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const scope = targets.length === 1 ? "当前选区，共 1 处" : selections.length === 1 && selections[0].isEmpty()
    ? `从第 ${selections[0].startLineNumber} 行当前列到文件末尾，共 ${targets.length} 行`
    : `当前矩形／多光标选区，共 ${targets.length} 处，从上到下填入`;
  form.querySelector(".column-scope")!.textContent = scope;
  (form.querySelector(`input[name="mode"][value="${last.mode}"]`) as HTMLInputElement).checked = true;
  for (const [key, value] of Object.entries(last)) if (key !== "mode") field(key).value = String(value);
  const read = (): ColumnOptions => (form.querySelector('input[name="mode"]:checked') as HTMLInputElement).value === "text"
    ? { mode: "text", text: field("text").value }
    : { mode: "number", initial: field("initial").value, step: field("step").value, repeat: field("repeat").value,
      base: Number(field("base").value) as 2 | 8 | 10 | 16, leading: field("leading").value as "none" | "zeros" | "spaces", uppercase: field("uppercase").value === "true" };
  const errorEl = form.querySelector<HTMLElement>(".column-error")!;
  const preview = form.querySelector<HTMLElement>(".column-preview")!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const update = () => {
    const options = read();
    (form.querySelector(".column-text") as HTMLFieldSetElement).disabled = options.mode !== "text";
    (form.querySelector(".column-numbers") as HTMLFieldSetElement).disabled = options.mode !== "number";
    field("uppercase").disabled = options.mode !== "number" || options.base !== 16;
    try {
      const values = columnValues(options, targets.length);
      if (values.reduce((sum, value) => sum + value.length, 0) > 5_000_000) throw new Error("插入内容过大，请缩小选区。");
      preview.textContent = `预览：${values.slice(0, 6).map(value => JSON.stringify(value)).join("，")}${values.length > 6 ? "，…" : ""}`;
      errorEl.textContent = ""; submit.disabled = false;
    } catch (error) { errorEl.textContent = (error as Error).message; preview.textContent = ""; submit.disabled = true; }
  };
  const close = () => { document.removeEventListener("keydown", onKey, true); overlay.remove(); editor.focus(); };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const controls = [...form.querySelectorAll<HTMLElement>("input, select, button")].filter(el => !el.matches(":disabled"));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0 || !event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus(); }
    }
  };
  form.addEventListener("input", update); form.addEventListener("change", update);
  form.querySelector(".column-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  form.onsubmit = event => {
    event.preventDefault(); update(); if (submit.disabled) return;
    if (model.isDisposed() || editor.getModel() !== model || model.getVersionId() !== version || editor.getOption(monaco.editor.EditorOption.readOnly)) {
      errorEl.textContent = "源码或编辑状态已变化，请取消后重新选择。"; return;
    }
    const options = read(), values = columnValues(options, targets.length);
    editor.pushUndoStop();
    const ok = editor.executeEdits("rtl.column-editor", targets.map((target, i) => ({ range: target.range, text: target.before + values[i] + target.after, forceMoveMarkers: true })), inverse => inverse.map(op => new monaco.Selection(op.range.startLineNumber, op.range.startColumn, op.range.endLineNumber, op.range.endColumn)));
    editor.pushUndoStop();
    if (!ok) { errorEl.textContent = "无法应用列编辑。"; return; }
    last = options; close();
  };
  overlay.append(form); document.body.append(overlay); document.addEventListener("keydown", onKey, true);
  update(); field(last.mode === "text" ? "text" : "initial").focus();
}

export function registerColumnActions(): void {
  monaco.editor.addEditorAction({ id: "rtl.column-editor", label: "列编辑…", keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyC], precondition: "editorTextFocus && !editorReadonly", contextMenuGroupId: "modification", run: openColumnEditor });
  monaco.editor.addEditorAction({ id: "rtl.column-selection", label: "切换矩形选择模式", contextMenuGroupId: "view", run: editor => editor.updateOptions({ columnSelection: !editor.getOption(monaco.editor.EditorOption.columnSelection) }) });
  for (const [key, command] of [[monaco.KeyCode.UpArrow, "cursorColumnSelectUp"], [monaco.KeyCode.DownArrow, "cursorColumnSelectDown"], [monaco.KeyCode.LeftArrow, "cursorColumnSelectLeft"], [monaco.KeyCode.RightArrow, "cursorColumnSelectRight"], [monaco.KeyCode.PageUp, "cursorColumnSelectPageUp"], [monaco.KeyCode.PageDown, "cursorColumnSelectPageDown"]] as const) {
    monaco.editor.addEditorAction({ id: `rtl.${command}`, label: command, precondition: "editorTextFocus", keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | key], run: editor => editor.trigger("keyboard", command, {}) });
  }
}
