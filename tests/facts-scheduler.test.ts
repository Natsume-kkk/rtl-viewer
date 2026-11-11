import { afterEach, expect, it, vi } from "vitest";
import { createFactsScheduler } from "../src/app/facts-scheduler";
import { analyzeFileFacts } from "../src/analysis/facts";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("跨文件编辑合并刷新，使用触发时最新内容且不分析无关文件", async () => {
  vi.useFakeTimers();
  const inputs = ["a", "b", "c"].map(name => ({ file: `${name}.sv`, content: `module ${name}; endmodule` }));
  const analyze = vi.fn(async (file: string, content: string) => ({ fingerprint: content, facts: analyzeFileFacts(file, content), diagnostics: [] }));
  const queue = createFactsScheduler({ files: () => inputs, priorityFile: () => undefined, result() {}, progress() {}, complete() {} }, analyze);
  queue.schedule("a.sv");
  await vi.advanceTimersByTimeAsync(200);
  queue.schedule("b.sv");
  inputs[0].content = "module changed; endmodule";
  expect(queue.running).toBe(true);
  await vi.advanceTimersByTimeAsync(400);
  expect(analyze.mock.calls.map(call => call[0])).toEqual(["a.sv", "b.sv"]);
  expect(queue.get("a.sv")?.definitions[0].name).toBe("changed");
  expect(queue.running).toBe(false);
});

it("切工程清空待刷新集合和运行状态，新工程完成后不会被旧回调污染", async () => {
  vi.useFakeTimers();
  let inputs = [{ file: "old.sv", content: "module old; endmodule" }];
  const queue = scheduler({ files: () => inputs, priorityFile: () => undefined, result() {}, progress() {}, complete() {} });
  queue.schedule("old.sv");
  queue.clear();
  expect(queue.running).toBe(false);
  inputs = [{ file: "new.sv", content: "module current; endmodule" }];
  await queue.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(queue.running).toBe(false);
  expect(queue.values().map(item => item.file)).toEqual(["new.sv"]);
});

it("编辑刷新中断后台队列后补齐剩余文件，失败不阻断其他编辑文件", async () => {
  vi.useFakeTimers();
  const inputs = ["a", "b", "c"].map(name => ({ file: `${name}.sv`, content: `module ${name}; endmodule` }));
  let release!: () => void;
  let first = true;
  const queue = createFactsScheduler({ files: () => inputs, priorityFile: () => undefined, result() {}, progress() {}, complete() {} }, async (file, content) => {
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
    if (content === "broken") throw new Error("failed");
    return { fingerprint: content, facts: analyzeFileFacts(file, content), diagnostics: [] };
  });
  const oldRun = queue.start();
  inputs[0].content = "broken";
  inputs[1].content = "module changed; endmodule";
  queue.schedule("a.sv"); queue.schedule("b.sv");
  await vi.advanceTimersByTimeAsync(400);
  release(); await oldRun;
  expect(queue.get("a.sv")).toBeUndefined();
  expect(queue.diagnosticValues()).toContainEqual(expect.objectContaining({ file: "a.sv", ruleId: "ANALYSIS-FAILED" }));
  expect(queue.get("b.sv")?.definitions[0].name).toBe("changed");
  expect(queue.get("c.sv")).toBeDefined();
  expect(queue.running).toBe(false);
});

it("删除或排除文件清除事实、诊断、失败及版本，范围外工程文件保留缓存", async () => {
  let inputs = ["keep", "removed", "bad"].map(name => ({ file: `${name}.sv`, content: `module ${name}; endmodule` }));
  let project = inputs.map(input => input.file);
  const analyze = vi.fn(async (file: string, content: string) => {
    if (file === "bad.sv") throw new Error("failed");
    return { fingerprint: content, facts: analyzeFileFacts(file, content), diagnostics: [{ file, line: 1, column: 1, severity: "warning" as const, source: "builtin" as const, category: "analysis" as const, ruleId: "TEST", message: "test" }] };
  });
  const queue = createFactsScheduler({ files: () => inputs, projectFiles: () => project, priorityFile: () => undefined, result() {}, progress() {}, complete() {} }, analyze);
  await queue.start();
  inputs = [];
  project = ["keep.sv"];
  await queue.start();
  expect(queue.values().map(item => item.file)).toEqual(["keep.sv"]);
  expect(queue.diagnosticValues().map(item => item.file)).toEqual(["keep.sv"]);
  inputs = [{ file: "removed.sv", content: "module removed; endmodule" }];
  project.push("removed.sv");
  await queue.start();
  expect(queue.get("removed.sv")).toBeDefined();
});

function scheduler(context: Parameters<typeof createFactsScheduler>[0]) {
  return createFactsScheduler(context, async (file, content) => ({ fingerprint: content, facts: analyzeFileFacts(file, content), diagnostics: [] }));
}

it("当前文件优先，后续跳过未变化内容并支持刷新", async () => {
  const inputs = [
    { file: "a.sv", content: "module a; endmodule" },
    { file: "b.sv", content: "module b; endmodule" },
    { file: "c.sv", content: "module c; endmodule" },
  ];
  const order: string[] = [];
  let completed: (() => void) | undefined;
  const queue = scheduler({
    files: () => inputs,
    priorityFile: () => "b.sv",
    result: facts => order.push(facts.file),
    progress: () => undefined,
    complete: () => completed?.(),
  });
  const done = new Promise<void>(resolve => { completed = resolve; });
  await queue.start();
  await done;
  expect(order[0]).toBe("b.sv");
  expect(queue.get("a.sv")?.definitions[0].name).toBe("a");
  await queue.refresh("a.sv", "module changed; endmodule");
  expect(queue.get("a.sv")?.definitions[0].name).toBe("changed");
});

it("取消使旧队列停止，清空后不保留旧事实", async () => {
  const complete = vi.fn();
  const queue = scheduler({
    files: () => [{ file: "a.sv", content: "module a; endmodule" }],
    priorityFile: () => undefined,
    result: () => undefined,
    progress: () => undefined,
    complete,
  });
  const pending = queue.start();
  queue.cancel();
  await pending;
  expect(complete).toHaveBeenCalledWith(true);
  queue.clear();
  expect(queue.values()).toEqual([]);
});

it("单文件分析失败保留明确诊断而不冒充无问题", async () => {
  const queue = createFactsScheduler({
    files: () => [{ file: "bad.sv", content: "module bad; endmodule" }],
    priorityFile: () => undefined,
    result: () => undefined,
    progress: () => undefined,
    complete: () => undefined,
  }, async () => { throw new Error("parser failed"); });
  await queue.start();
  expect(queue.get("bad.sv")).toBeUndefined();
  expect(queue.diagnosticValues()).toEqual([expect.objectContaining({ file: "bad.sv", ruleId: "ANALYSIS-FAILED", severity: "error", message: expect.stringContaining("parser failed") })]);
});

it("队列完成后合并跨文件项目级诊断", async () => {
  const queue = scheduler({
    files: () => [
      { file: "a.sv", content: "module a; parameter WIDTH = 8; endmodule" },
      { file: "b.sv", content: "module b; parameter WIDTH = 16; endmodule" },
    ],
    priorityFile: () => undefined,
    result: () => undefined,
    progress: () => undefined,
    complete: () => undefined,
  });
  await queue.start();
  expect(queue.diagnosticValues().filter(item => item.ruleId === "10157-A-2-7")).toHaveLength(1);
});

it("后台队列中的刷新失败会恢复并分析剩余文件", async () => {
  const calls: { file: string; resolve: (result: { fingerprint: string; facts: ReturnType<typeof analyzeFileFacts>; diagnostics: never[] }) => void; reject: (error: Error) => void }[] = [];
  let finished: (() => void) | undefined;
  const queue = createFactsScheduler({
    files: () => [{ file: "a.sv", content: "module a; endmodule" }, { file: "b.sv", content: "module b; endmodule" }],
    priorityFile: () => undefined,
    result: () => undefined,
    progress: () => undefined,
    complete: () => finished?.(),
  }, (file, content) => new Promise((resolve, reject) => {
    calls.push({ file, resolve: value => resolve(value), reject });
  }));
  const initial = queue.start();
  await Promise.resolve();
  const refreshing = queue.refresh("a.sv", "broken");
  await Promise.resolve();
  expect(calls).toHaveLength(2);
  calls[1].reject(new Error("synthetic failure"));
  await refreshing;
  expect(calls).toHaveLength(3);
  calls[2].resolve({ fingerprint: "a2", facts: analyzeFileFacts("a.sv", "module a; endmodule"), diagnostics: [] });
  await Promise.resolve();
  expect(calls).toHaveLength(4);
  calls[3].resolve({ fingerprint: "b", facts: analyzeFileFacts("b.sv", "module b; endmodule"), diagnostics: [] });
  const done = new Promise<void>(resolve => { finished = resolve; });
  calls[0].resolve({ fingerprint: "a", facts: analyzeFileFacts("a.sv", "module a; endmodule"), diagnostics: [] });
  await Promise.all([initial, done]);
  expect(queue.values().map(facts => facts.file).sort()).toEqual(["a.sv", "b.sv"]);
  expect(queue.running).toBe(false);
});

it("诊断版本只在分析生命周期推进，供 Monaco 跳过无效重算", async () => {
  const queue = scheduler({
    files: () => [{ file: "a.sv", content: "module a; endmodule" }],
    priorityFile: () => undefined,
    result: () => undefined,
    progress: () => undefined,
    complete: () => undefined,
  });
  const initial = queue.diagnosticsRevision;
  await queue.start();
  expect(queue.diagnosticsRevision).toBeGreaterThan(initial);
  const completed = queue.diagnosticsRevision;
  await queue.refresh("a.sv", "module a; endmodule");
  expect(queue.diagnosticsRevision).toBeGreaterThan(completed);
});
