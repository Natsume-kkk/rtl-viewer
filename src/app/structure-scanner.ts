import { scanStructure, type ModuleInfo } from "../parser";

interface PendingScan {
  resolve(modules: ModuleInfo[]): void;
  reject(error: Error): void;
}

export function createStructureScanner() {
  let worker: Worker | undefined;
  let serial = 0;
  const pending = new Map<number, PendingScan>();

  function scanInWorker(file: string, content: string): Promise<ModuleInfo[]> {
    if (!worker) {
      worker = new Worker(new URL("../parser/structure-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = event => {
        const response = event.data;
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if (response.error) request.reject(new Error(response.error));
        else request.resolve(response.modules);
      };
      worker.onerror = event => {
        rejectAll(new Error(event.message || "结构解析 Worker 失败"));
        worker?.terminate();
        worker = undefined;
      };
    }
    return new Promise<ModuleInfo[]>((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      worker!.postMessage({ id, file, content });
    });
  }

  function rejectAll(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function dispose(): void {
    worker?.terminate();
    worker = undefined;
    rejectAll(new Error("结构解析已取消"));
  }

  return {
    scan: (file: string, content: string): Promise<ModuleInfo[]> => typeof Worker === "undefined"
      ? Promise.resolve().then(() => scanStructure(content, file))
      : scanInWorker(file, content),
    dispose,
  };
}
