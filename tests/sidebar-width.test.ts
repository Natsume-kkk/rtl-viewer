// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachSidebarWidth } from "../src/ui/sidebar-width";

const key = "rtl-viewer.sidebarWidth";
let dispose: (() => void) | undefined;
beforeEach(() => { localStorage.clear(); document.body.replaceChildren(); });
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); });

function mount() {
  const sidebar = document.createElement("aside"), splitter = document.createElement("div");
  document.body.append(sidebar, splitter);
  vi.spyOn(sidebar, "getBoundingClientRect").mockImplementation(() => ({ width: Number.parseFloat(sidebar.style.width) || 280 }) as DOMRect);
  dispose = attachSidebarWidth(sidebar, splitter);
  return { sidebar, splitter };
}

it("拖动结束保存宽度，重新初始化恢复", () => {
  let { sidebar, splitter } = mount();
  splitter.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 280 }));
  document.dispatchEvent(new MouseEvent("mousemove", { clientX: 440 }));
  expect(sidebar.style.width).toBe("440px");
  expect(localStorage.getItem(key)).toBeNull();
  document.dispatchEvent(new MouseEvent("mouseup"));
  expect(localStorage.getItem(key)).toBe("440");
  dispose!(); ({ sidebar } = mount());
  expect(sidebar.style.width).toBe("440px");
});

it("非法偏好回退默认样式，越界数值限制到原有宽度范围", () => {
  for (const value of ["", "NaN", "Infinity", "abc"]) {
    localStorage.setItem(key, value); const { sidebar } = mount();
    expect(sidebar.style.width).toBe(""); dispose!();
  }
  for (const [value, expected] of [["100", "160px"], ["900", "600px"]]) {
    localStorage.setItem(key, value); const { sidebar } = mount();
    expect(sidebar.style.width).toBe(expected); dispose!();
  }
});

it("失焦与销毁结束拖动并解除监听，随后可再次使用", () => {
  const { sidebar, splitter } = mount();
  const start = () => splitter.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 280 }));
  start(); document.dispatchEvent(new MouseEvent("mousemove", { clientX: 360 }));
  window.dispatchEvent(new Event("blur"));
  expect(document.body.classList.contains("resizing")).toBe(false);
  document.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
  expect(sidebar.style.width).toBe("360px"); expect(localStorage.getItem(key)).toBe("360");
  start(); document.dispatchEvent(new MouseEvent("mousemove", { clientX: 1000 }));
  expect(sidebar.style.width).toBe("600px"); dispose!();
  document.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }));
  expect(sidebar.style.width).toBe("600px"); expect(document.body.classList.contains("resizing")).toBe(false);
});

it("偏好存储不可用也能调整侧栏", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const { sidebar, splitter } = mount();
  splitter.dispatchEvent(new MouseEvent("mousedown", { clientX: 280 }));
  document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
  expect(() => document.dispatchEvent(new MouseEvent("mouseup"))).not.toThrow();
  expect(sidebar.style.width).toBe("400px");
});
