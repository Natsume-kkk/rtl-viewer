import { afterEach, expect, it, vi } from "vitest";
import { runSignalTraceInWorker } from "../src/app/signal-trace";
import { analyzeSignalTrace, type SignalTraceInput } from "../src/analysis/signal-trace";

afterEach(() => vi.unstubAllGlobals());

function input(): SignalTraceInput {
  const file = "D:/test/top.v", source = "module top; wire mid; assign mid = 1'b1; endmodule";
  return {
    sources: [[file, source]],
    structures: [[file, [{ name: "top", file, line: 1, ports: [], instances: [] }]]],
    context: { module: "top", path: "top" },
    signal: "mid",
    scope: -1,
    mode: "logic",
    source: { file, line: 1, column: 20 },
  };
}

class ImmediateWorker {
  static latest?: ImmediateWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: Event) => void;
  terminated = false;
  constructor() { ImmediateWorker.latest = this; }
  postMessage(message: { input: SignalTraceInput }) {
    void analyzeSignalTrace(message.input).then(result => this.onmessage?.({ data: { result } }));
  }
  terminate() { this.terminated = true; }
}

class PendingWorker extends ImmediateWorker {
  postMessage(_message: { input: SignalTraceInput }): void {}
}

it("信号追踪通过 Worker 返回完整依赖图", async () => {
  vi.stubGlobal("Worker", ImmediateWorker);
  const task = runSignalTraceInWorker(input(), () => false);
  const result = await task.promise;
  expect(result.graph?.nodes.some(node => node.id === result.graph?.root)).toBe(true);
  expect(ImmediateWorker.latest?.terminated).toBe(true);
});

it("取消信号追踪会终止 Worker 并拒绝当前任务", async () => {
  vi.stubGlobal("Worker", PendingWorker);
  const task = runSignalTraceInWorker(input(), () => false);
  const rejection = expect(task.promise).rejects.toThrow("cancelled");
  task.cancel();
  await rejection;
  expect(PendingWorker.latest?.terminated).toBe(true);
});
