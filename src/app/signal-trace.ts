import type { SignalTraceInput, SignalTraceResult } from "../analysis/signal-trace";

export interface SignalTraceTask {
  promise: Promise<SignalTraceResult>;
  cancel(): void;
}

export function runSignalTraceInWorker(input: SignalTraceInput, cancelled: () => boolean): SignalTraceTask {
  if (typeof Worker === "undefined") {
    return {
      promise: import("../analysis/signal-trace").then(({ analyzeSignalTrace }) => analyzeSignalTrace(input, cancelled)),
      cancel: () => undefined,
    };
  }
  let worker: Worker | undefined;
  let rejectTask: ((error: Error) => void) | undefined;
  const promise = new Promise<SignalTraceResult>((resolve, reject) => {
    rejectTask = reject;
    worker = new Worker(new URL("../analysis/signal-trace-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = event => {
      const response = event.data as { result?: SignalTraceResult; error?: string };
      worker?.terminate();
      worker = undefined;
      if (response.error) reject(new Error(response.error));
      else if (response.result) resolve(response.result);
      else reject(new Error("信号分析 Worker 未返回结果"));
    };
    worker.onerror = event => {
      event.preventDefault();
      worker?.terminate();
      worker = undefined;
      reject(new Error(event.message || "信号分析 Worker 执行失败"));
    };
    worker.postMessage({ id: 1, input });
  });
  return {
    promise,
    cancel: () => {
      worker?.terminate();
      worker = undefined;
      rejectTask?.(new Error("cancelled"));
    },
  };
}
