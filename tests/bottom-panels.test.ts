// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { BottomPanels } from "../src/ui/bottom-panels";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup(height = 710) {
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {} disconnect = disconnect;
  });
  document.body.innerHTML = '<div id="workspace"><section id="panels" hidden><div><section id="search" hidden><input value="clk"><p>已完成结果</p></section><aside id="flow" hidden><p>top/u0.clk</p></aside></div></section></div>';
  const workspace = document.getElementById("workspace")!, root = document.getElementById("panels")!;
  Object.defineProperty(workspace, "clientHeight", { get: () => height });
  Object.defineProperty(root, "clientHeight", { get: () => Number.parseFloat(root.style.height) || 0 });
  const search = document.getElementById("search")!, flow = document.getElementById("flow")!;
  const changed = vi.fn();
  const panels = new BottomPanels(root, { search, flow }, changed);
  cleanup.push(() => panels.dispose());
  const share = [...root.querySelectorAll("button")].find(button => button.textContent === "同时查看")!;
  return { panels, root, search, flow, share, changed, disconnect, resize: (next: number) => { height = next; resized(); } };
}

it("默认切换保留查询、追踪节点与滚动状态，收起后可重新打开", () => {
  const { panels, root, search, flow } = setup();
  panels.show("search");
  const input = search.querySelector("input")!;
  input.focus(); search.scrollTop = 80;
  panels.show("flow");
  expect(search.hidden).toBe(true); expect(flow.hidden).toBe(false);
  expect(search.contains(document.activeElement)).toBe(false);
  panels.show("search");
  expect(search.querySelector("input")).toBe(input);
  expect(input.value).toBe("clk"); expect(search.scrollTop).toBe(80);
  expect(flow.textContent).toBe("top/u0.clk");
  panels.hide("search"); expect(panels.isVisible("flow")).toBe(true);
  panels.hide("flow"); expect(root.hidden).toBe(true);
  panels.show("search"); expect(input.value).toBe("clk");
});

it("显式共存保护编辑区，缩窗退回切换并在放大后恢复偏好", () => {
  const { panels, root, search, flow, share, resize } = setup();
  panels.show("flow"); share.click();
  expect(search.hidden || flow.hidden).toBe(false);
  expect(710 - root.clientHeight).toBeGreaterThanOrEqual(320);
  resize(500);
  expect(search.hidden).toBe(true); expect(flow.hidden).toBe(false);
  expect(root.textContent).toContain("高度不足，暂用切换");
  expect(500 - root.clientHeight).toBeGreaterThanOrEqual(275);
  expect(share.getAttribute("aria-pressed")).toBe("true");
  resize(710);
  expect(search.hidden || flow.hidden).toBe(false);
  share.click(); expect(search.hidden).toBe(true);
});

it("键盘调整受空间上限约束，Home 恢复，销毁解除观察与键盘行为", () => {
  const { panels, root, disconnect } = setup(); panels.show("search");
  const resize = root.querySelector<HTMLElement>('[role="separator"]')!;
  for (let i = 0; i < 20; i++) resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  expect(root.clientHeight).toBe(390);
  resize.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" })); expect(root.clientHeight).toBe(300);
  panels.dispose(); expect(disconnect).toHaveBeenCalledOnce();
  resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" })); expect(root.clientHeight).toBe(300);
});
