// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppShortcuts, type AppShortcutActions } from "../src/ui/shortcuts";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); document.body.replaceChildren(); });

function setup() {
  const actions: AppShortcutActions = {
    newFile: vi.fn(), openFile: vi.fn(async () => {}), openProject: vi.fn(async () => {}),
    save: vi.fn(async () => {}), saveAs: vi.fn(async () => {}), saveAll: vi.fn(async () => {}),
    close: vi.fn(async () => {}), closeAll: vi.fn(async () => {}), reload: vi.fn(async () => {}),
    cycleTab: vi.fn(), switchView: vi.fn(), recent: vi.fn(), search: vi.fn(), back: vi.fn(), forward: vi.fn(), error: vi.fn(),
  };
  cleanup = registerAppShortcuts(actions);
  return actions;
}

function press(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe("应用快捷键", () => {
  it("展开当前块不触发全工程搜索，重载与最近工程使用独立修饰键", async () => {
    const actions = setup();
    expect(press("f", { ctrlKey: true, altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(actions.search).not.toHaveBeenCalled();
    press("f", { ctrlKey: true, shiftKey: true }); expect(actions.search).toHaveBeenCalledOnce();
    press("r", { ctrlKey: true }); expect(actions.reload).toHaveBeenCalledOnce();
    await vi.waitFor(() => { press("r", { ctrlKey: true, altKey: true }); expect(actions.recent).toHaveBeenCalledOnce(); });
  });

  it("保存从外围输入框执行一次，捕获阶段阻止 Monaco 再次分发", () => {
    const actions = setup(), input = document.createElement("input"), bubble = vi.fn();
    document.body.append(input); input.addEventListener("keydown", bubble);
    expect(press("s", { ctrlKey: true }, input).defaultPrevented).toBe(true);
    expect(actions.save).toHaveBeenCalledOnce(); expect(bubble).not.toHaveBeenCalled();
  });

  it("关闭确认、菜单和编辑器快速输入期间不执行文件命令", () => {
    const actions = setup();
    const overlay = document.createElement("div"); overlay.className = "choice-overlay"; document.body.append(overlay);
    press("w", { ctrlKey: true }); expect(actions.close).not.toHaveBeenCalled(); overlay.remove();
    for (const className of ["quick-input-widget", "menu"]) {
      const box = document.createElement("div"), input = document.createElement("input");
      box.className = className; if (className === "menu") box.setAttribute("role", "menu");
      box.append(input); document.body.append(box); press("s", { ctrlKey: true }, input); box.remove();
    }
    expect(actions.save).not.toHaveBeenCalled();
  });

  it("保存待完成时阻止重复关闭、新建和重载，完成后恢复", async () => {
    const actions = setup(); let resolve!: () => void;
    vi.mocked(actions.save).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    press("s", { ctrlKey: true }); press("w", { ctrlKey: true }); press("n", { ctrlKey: true }); press("r", { ctrlKey: true });
    expect(actions.close).not.toHaveBeenCalled(); expect(actions.newFile).not.toHaveBeenCalled(); expect(actions.reload).not.toHaveBeenCalled();
    resolve(); await vi.waitFor(() => { press("w", { ctrlKey: true }); expect(actions.close).toHaveBeenCalledOnce(); });
  });

  it("异步失败释放命令状态，长按不连续创建或打开对话框", async () => {
    const actions = setup(); vi.mocked(actions.saveAs).mockRejectedValue(new Error("failed"));
    press("s", { ctrlKey: true, altKey: true }); await vi.waitFor(() => expect(actions.error).toHaveBeenCalledOnce());
    await Promise.resolve(); press("n", { ctrlKey: true, repeat: true }); press("o", { ctrlKey: true, repeat: true });
    expect(actions.newFile).not.toHaveBeenCalled(); expect(actions.openFile).not.toHaveBeenCalled();
    press("n", { ctrlKey: true }); expect(actions.newFile).toHaveBeenCalledOnce();
  });

  it("标签按当前组切换，普通输入框 Alt 方向键不被导航抢走", () => {
    const actions = setup();
    press("Tab", { ctrlKey: true }); press("Tab", { ctrlKey: true, shiftKey: true });
    press("PageUp", { ctrlKey: true }); press("PageDown", { ctrlKey: true });
    expect(vi.mocked(actions.cycleTab).mock.calls).toEqual([[1], [-1], [-1], [1]]);
    const input = document.createElement("input"); document.body.append(input);
    expect(press("ArrowLeft", { altKey: true }, input).defaultPrevented).toBe(false); expect(actions.back).not.toHaveBeenCalled();
    const editor = document.createElement("div"); editor.className = "monaco-editor"; editor.append(input); document.body.append(editor);
    press("ArrowLeft", { altKey: true }, input); expect(actions.back).toHaveBeenCalledOnce();
  });
});
