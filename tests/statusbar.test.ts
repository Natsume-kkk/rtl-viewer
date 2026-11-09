// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { StatusBar } from "../src/ui/statusbar";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

it("普通提示自动消失，错误持续保留并提供实时播报语义", () => {
  vi.useFakeTimers();
  const root = document.createElement("footer");
  document.body.append(root);
  const bar = new StatusBar(root, { onReopen: () => {}, onSetSaveEncoding: () => {} });
  const hint = root.querySelector<HTMLElement>(".status-hint")!;
  expect(hint.getAttribute("role")).toBe("status");
  expect(hint.getAttribute("aria-live")).toBe("polite");
  bar.hint("已保存");
  expect(hint.textContent).toBe("已保存");
  vi.advanceTimersByTime(3000);
  expect(hint.textContent).toBe("");
  bar.error("导出失败");
  expect(hint.classList.contains("status-error")).toBe(true);
  expect(hint.title).toBe("导出失败");
  vi.advanceTimersByTime(10000);
  expect(hint.textContent).toBe("导出失败");
  bar.hint("已重试");
  expect(hint.classList.contains("status-error")).toBe(false);
});
