// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { attachToolbarOverflow } from "../src/ui/toolbar-overflow";
import { closeCtxMenu } from "../src/ui/menu";

afterEach(() => { closeCtxMenu(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("空间不足时收进更多菜单，空间恢复后还原入口", () => {
  let width = 640;
  let resized = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const toolbar = document.createElement("div"), end = document.createElement("div");
  toolbar.append(end); document.body.append(toolbar);
  Object.defineProperty(toolbar, "clientWidth", { get: () => width });
  Object.defineProperty(toolbar, "scrollWidth", { get: () => {
    const more = toolbar.querySelector<HTMLButtonElement>(".toolbar-more");
    return 400 + [...end.children].filter(item => item instanceof HTMLButtonElement && !item.hidden && !item.classList.contains("toolbar-more")).length * 100 + (more && !more.hidden ? 60 : 0);
  } });
  const clicks = [0, 0, 0];
  const items = ["问题", "统计", "信号链"].map((label, index) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", () => { clicks[index]++; });
    end.append(button);
    return { button, label };
  });
  const dispose = attachToolbarOverflow(toolbar, end, items);
  const more = toolbar.querySelector<HTMLButtonElement>(".toolbar-more")!;
  expect(more.hidden).toBe(false);
  expect(items.map(item => item.button.hidden)).toEqual([true, true, false]);
  more.click();
  const labels = [...document.querySelectorAll<HTMLElement>(".ctx-item")].map(item => item.textContent);
  expect(labels).toEqual(["问题", "统计"]);
  document.querySelector<HTMLButtonElement>(".ctx-item")!.click();
  expect(clicks[0]).toBe(1);
  width = 900; resized();
  expect(items.every(item => !item.button.hidden)).toBe(true);
  expect(more.hidden).toBe(true);
  dispose();
});
