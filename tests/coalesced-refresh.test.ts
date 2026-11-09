// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createCoalescedRefresh } from "../src/app/coalesced-refresh";

afterEach(() => vi.useRealTimers());

it("后台结果按时间窗合并，完成时立即刷新并取消尾随任务", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const refresh = vi.fn();
  const coalesced = createCoalescedRefresh(refresh, 250);
  coalesced.schedule();
  coalesced.schedule();
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(0);
  expect(refresh).toHaveBeenCalledOnce();
  coalesced.schedule();
  vi.advanceTimersByTime(100);
  coalesced.schedule();
  expect(refresh).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(149);
  expect(refresh).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  coalesced.schedule();
  coalesced.flush();
  expect(refresh).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(500);
  expect(refresh).toHaveBeenCalledTimes(3);
  coalesced.schedule();
  coalesced.cancel();
  vi.advanceTimersByTime(500);
  expect(refresh).toHaveBeenCalledTimes(3);
});
