// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createProjectSearch } from "../src/app/project-search";

class SearchWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  reply(data: unknown) { this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data })); }
}
afterEach(() => vi.useRealTimers());

it("超时终止 Worker，随后可重新查询并释放成功任务", async () => {
  vi.useFakeTimers(); const workers: SearchWorker[] = [];
  const service = createProjectSearch(() => { const worker = new SearchWorker(); workers.push(worker); return worker; });
  const rejected = expect(service.search([], "(a+)+$", { useRegex: true })).rejects.toThrow("超过 2 秒");
  await vi.advanceTimersByTimeAsync(2000); await rejected;
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  const next = service.search([], "clk", {}); workers[1].reply({ results: [] });
  expect(await next).toEqual([]); expect(workers[1].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("替换、取消和 Worker 错误都释放资源，旧回调脱离", async () => {
  vi.useFakeTimers(); const workers: SearchWorker[] = [];
  const service = createProjectSearch(() => { const worker = new SearchWorker(); workers.push(worker); return worker; });
  const old = expect(service.search([], "old", {})).rejects.toThrow("已取消");
  const next = expect(service.search([], "new", {})).rejects.toThrow("执行失败"); await old;
  expect(workers[0].onmessage).toBeNull();
  workers[1].onerror?.call(workers[1] as unknown as Worker, new ErrorEvent("error")); await next;
  const last = expect(service.search([], "last", {})).rejects.toThrow("已取消"); service.cancel(); await last;
  expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("发送数据失败仍清理 Worker，返回可见错误", async () => {
  vi.useFakeTimers(); const worker = new SearchWorker();
  worker.postMessage.mockImplementation(() => { throw new Error("cannot clone"); });
  const service = createProjectSearch(() => worker);
  await expect(service.search([], "clk", {})).rejects.toThrow("cannot clone");
  expect(worker.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
