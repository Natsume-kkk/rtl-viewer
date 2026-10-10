// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
vi.mock("../src/editor/monaco", () => ({ setEditorTheme: vi.fn() }));

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
it("首帧初始化脚本与运行期主题对有效、无效及空偏好保持一致", async () => {
  const { initTheme, currentTheme } = await import("../src/ui/theme");
  for (const saved of [null, "dark", "light", "invalid"]) for (const light of [false, true]) {
    localStorage.clear(); if (saved) localStorage.setItem("rtl-viewer.theme", saved);
    const media = { matches: light, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("matchMedia", () => media);
    const firstFrame = { documentElement: { dataset: {} as Record<string, string> } };
    runInNewContext(readFileSync("public/theme-init.js", "utf8"), { document: firstFrame, localStorage, matchMedia: () => media });
    initTheme(); expect(currentTheme()).toBe(firstFrame.documentElement.dataset.theme);
  }
  vi.unstubAllGlobals();
});
it("无偏好时系统主题变化联动 Monaco，手动选择后忽略系统变化且重复初始化不重复监听", async () => {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const media = { matches: false, addEventListener: vi.fn((_, fn) => listeners.add(fn)), removeEventListener: vi.fn((_, fn) => listeners.delete(fn)) };
  vi.stubGlobal("matchMedia", () => media);
  const theme = await import("../src/ui/theme");
  const { setEditorTheme } = await import("../src/editor/monaco");
  theme.initTheme(); theme.initTheme(); expect(listeners.size).toBe(1);
  for (const fn of listeners) fn({ matches: true });
  expect(theme.currentTheme()).toBe("light"); expect(setEditorTheme).toHaveBeenLastCalledWith("light");
  theme.toggleTheme(); for (const fn of listeners) fn({ matches: true });
  expect(theme.currentTheme()).toBe("dark"); expect(localStorage.getItem("rtl-viewer.theme")).toBe("dark");
  vi.unstubAllGlobals();
});
