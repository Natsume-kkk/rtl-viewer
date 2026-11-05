import type { FileFacts } from "../analysis/facts";
import type { RuleDiagnostic } from "../analysis/general-rules";

interface FactsInput {
  file: string;
  content: string;
}

interface FactsSchedulerContext {
  files(): FactsInput[];
  priorityFile(): string | undefined;
  result(facts: FileFacts): void;
  progress(done: number, total: number): void;
  complete(cancelled: boolean): void;
}

interface FactsAnalysis {
  fingerprint: string;
  facts: FileFacts;
  diagnostics: RuleDiagnostic[];
}

type FactsAnalyzer = (file: string, content: string) => Promise<FactsAnalysis>;

interface PendingAnalysis {
  resolve(result: FactsAnalysis): void;
  reject(error: Error): void;
}

export function createFactsScheduler(context: FactsSchedulerContext, analyzer?: FactsAnalyzer) {
  const facts = new Map<string, FileFacts>();
  const diagnostics = new Map<string, RuleDiagnostic[]>();
  const versions = new Map<string, string>();
  const pending = new Map<number, PendingAnalysis>();
  let worker: Worker | undefined;
  let serial = 0;
  let generation = 0;
  let running = false;

  function resetWorker(): void {
    worker?.terminate();
    worker = undefined;
    const error = new Error("分析已取消");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function analyzeInWorker(file: string, content: string): Promise<FactsAnalysis> {
    if (!worker) {
      worker = new Worker(new URL("../analysis/facts-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = event => {
        const response = event.data;
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if (response.error) request.reject(new Error(response.error));
        else request.resolve({ fingerprint: response.fingerprint, facts: response.facts, diagnostics: response.diagnostics });
      };
      worker.onerror = event => {
        const error = new Error(event.message || "事实分析 Worker 失败");
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        worker?.terminate();
        worker = undefined;
      };
    }
    return new Promise<FactsAnalysis>((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      worker!.postMessage({ id, file, content });
    });
  }

  const analyze = analyzer ?? analyzeInWorker;

  async function start(): Promise<void> {
    const request = ++generation;
    resetWorker();
    running = true;
    const priority = context.priorityFile();
    const inputs = context.files();
    inputs.sort((a, b) => Number(b.file === priority) - Number(a.file === priority) || a.file.localeCompare(b.file));
    for (let index = 0; index < inputs.length; index++) {
      if (request !== generation) return;
      const input = inputs[index];
      try {
        const next = await analyze(input.file, input.content);
        if (request !== generation) return;
        if (versions.get(input.file) !== next.fingerprint) {
          facts.set(input.file, next.facts);
          diagnostics.set(input.file, next.diagnostics);
          versions.set(input.file, next.fingerprint);
          context.result(next.facts);
        }
      } catch {
        if (request !== generation) return;
        facts.delete(input.file);
        diagnostics.delete(input.file);
      }
      context.progress(index + 1, inputs.length);
    }
    if (request === generation) {
      running = false;
      context.complete(false);
    }
  }

  async function refresh(file: string, content: string): Promise<void> {
    const resume = running;
    const request = ++generation;
    resetWorker();
    running = true;
    try {
      const next = await analyze(file, content);
      if (request !== generation) return;
      if (versions.get(file) !== next.fingerprint) {
        facts.set(file, next.facts);
        diagnostics.set(file, next.diagnostics);
        versions.set(file, next.fingerprint);
        context.result(next.facts);
      }
      running = false;
      if (resume) void start();
      else context.complete(false);
    } catch {
      if (request === generation) {
        facts.delete(file);
        diagnostics.delete(file);
        running = false;
        context.complete(false);
      }
    }
  }

  function cancel(): void {
    generation++;
    resetWorker();
    running = false;
    context.complete(true);
  }

  function clear(): void {
    cancel();
    facts.clear();
    diagnostics.clear();
    versions.clear();
  }

  return {
    start,
    refresh,
    cancel,
    clear,
    dispose: cancel,
    get: (file: string) => facts.get(file),
    values: () => [...facts.values()],
    diagnosticValues: () => [...diagnostics.values()].flat(),
    get running() { return running; },
  };
}
