// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openColumnEditor } from "../src/editor/column-editor";
vi.mock("../src/editor/monaco", () => ({ monaco: { editor: { EditorOption: { readOnly: 1 } }, Selection: class {} } }));

beforeEach(() => document.body.replaceChildren());
function setup() {
  let version = 1;
  const model = { getLinesContent: () => ["abc", "def"], getOptions: () => ({ tabSize: 4 }), getVersionId: () => version, isDisposed: () => false };
  const editor = { getModel: () => model, getSelections: () => [{ startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1, isEmpty: () => true }], getOption: () => false, focus: vi.fn(), pushUndoStop: vi.fn(), executeEdits: vi.fn(() => true) };
  return { editor, change: () => version++, open: () => openColumnEditor(editor as unknown as Parameters<typeof openColumnEditor>[0]) };
}
const field = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
function fill(name: string, value: string) { field(name).value = value; field(name).dispatchEvent(new Event("input", { bubbles: true })); }
const submit = () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
describe("column editor dialog", () => {
  it("提交前不改源码，取消归还焦点", async () => {
    const { editor, open } = setup(); await open();
    expect(document.querySelector(".column-scope")?.textContent).toContain("2 行");
    fill("initial", "14"); expect(editor.executeEdits).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("form")).toBeNull(); expect(editor.focus).toHaveBeenCalled();
  });
  it("合法序列一次应用，包围独立撤销边界", async () => {
    const { editor, open } = setup(); await open(); fill("initial", "14"); fill("step", "1"); submit();
    expect(editor.executeEdits).toHaveBeenCalledOnce();
    const edits = (editor.executeEdits.mock.calls[0] as unknown as [string, { text: string }[]])[1];
    expect(edits.map(e => e.text)).toEqual(["14", "15"]); expect(editor.pushUndoStop).toHaveBeenCalledTimes(2);
    expect(document.querySelector("form")).toBeNull();
  });
  it("无效重复次数或模型变化不写入", async () => {
    const { editor, open, change } = setup(); await open(); fill("repeat", "0"); submit();
    expect(editor.executeEdits).not.toHaveBeenCalled(); expect(document.querySelector(".column-error")?.textContent).toContain("大于 0");
    fill("repeat", "1"); change(); submit();
    expect(editor.executeEdits).not.toHaveBeenCalled(); expect(document.querySelector(".column-error")?.textContent).toContain("已变化");
    document.querySelector<HTMLButtonElement>(".column-cancel")!.click();
  });
});
