// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeCtxMenu, showCtxMenu } from "../src/ui/menu";

const pressKey = (key: string) => document.activeElement!.dispatchEvent(
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
);

afterEach(() => {
  closeCtxMenu();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("路径菜单浮层", () => {
  it("受视口约束后的尺寸参与定位，缩窗重新收回且关闭释放监听", () => {
    const oldWidth = window.innerWidth, oldHeight = window.innerHeight;
    window.innerWidth = 900;
    window.innerHeight = 600;
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width: Math.min(650, window.innerWidth - 8), height: Math.min(350, window.innerHeight - 8),
    } as DOMRect));
    try {
      showCtxMenu(600, 150, [{ label: "D:/directory/".repeat(26), action: vi.fn() }]);
      const menu = document.querySelector<HTMLElement>(".ctx-menu")!;
      expect(menu.style.left).toBe("246px");
      expect(menu.style.top).toBe("150px");
      window.innerWidth = 600;
      window.innerHeight = 400;
      window.dispatchEvent(new Event("resize"));
      expect(measure).toHaveBeenCalledTimes(2);
      expect(menu.style.left).toBe("4px");
      expect(menu.style.top).toBe("46px");
      closeCtxMenu();
      window.dispatchEvent(new Event("resize"));
      expect(measure).toHaveBeenCalledTimes(2);
    } finally {
      window.innerWidth = oldWidth;
      window.innerHeight = oldHeight;
    }
  });

  it("26 个深层路径保留标签与动作，首尾和方向键可选，Escape 归还焦点", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.focus();
    const actions = Array.from({ length: 26 }, () => vi.fn());
    const items = actions.map((action, i) => ({ label: `D:/${"directory/".repeat(i + 1)}`, action }));
    showCtxMenu(600, 150, items, anchor);
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".ctx-menu button")];
    expect(rows.map(row => row.textContent)).toEqual(items.map(item => item.label));
    pressKey("End");
    expect(document.activeElement).toBe(rows[25]);
    pressKey("ArrowDown");
    expect(document.activeElement).toBe(rows[0]);
    pressKey("ArrowUp");
    expect(document.activeElement).toBe(rows[25]);
    pressKey("Home");
    expect(document.activeElement).toBe(rows[0]);
    pressKey("End");
    pressKey("Enter");
    expect(actions[25]).toHaveBeenCalledOnce();
    expect(actions.slice(0, 25).every(action => action.mock.calls.length === 0)).toBe(true);
    expect(document.activeElement).toBe(anchor);
    showCtxMenu(600, 150, items, anchor);
    pressKey("End");
    pressKey("Escape");
    expect(document.querySelector(".ctx-menu")).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(actions[25]).toHaveBeenCalledOnce();
  });
});
