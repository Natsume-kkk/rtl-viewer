import { expect, it, vi } from "vitest";
import { createFactsScheduler } from "../src/app/facts-scheduler";
import { analyzeFileFacts } from "../src/analysis/facts";

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
