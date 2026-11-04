// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ProblemPanel } from "../src/ui/problems";
import type { SyntaxCheckResult } from "../src/ipc";

afterEach(() => document.body.replaceChildren());

function result(): SyntaxCheckResult {
  return {
    requestId: 1,
    checkedFiles: 2,
    cancelled: false,
    backends: [{ name: "verilator", version: "5.050", files: 2, status: "completed" }],
    diagnostics: [
      { file: "D:/project/a.sv", line: 8, column: 3, severity: "error", ruleId: "VERILATOR-WIDTH", source: "verilator", message: "Width mismatch" },
      { file: "D:/project/b.sv", line: 4, column: 1, severity: "warning", ruleId: "VERILATOR-UNUSED", source: "verilator", message: "Unused signal" },
    ],
  };
}

function setup() {
  const root = document.createElement("section");
  document.body.append(root);
  const callbacks = { onRun: vi.fn(), onCancel: vi.fn(), onExport: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), displayPath: (file: string) => file.replace("D:/project/", "") };
  const panel = new ProblemPanel(root, callbacks);
  return { root, panel, callbacks };
}

it("运行、过滤、定位和过期状态共用同一份诊断结果", () => {
  const { root, panel, callbacks } = setup();
  const run = [...root.querySelectorAll("button")].find(button => button.textContent === "运行语法检查")!;
  run.click();
  expect(callbacks.onRun).toHaveBeenCalledOnce();
  panel.start();
  expect(run.disabled).toBe(true);
  panel.finish(result());
  expect(run.disabled).toBe(false);
  expect(root.querySelectorAll(".problem-row")).toHaveLength(2);
  expect(root.querySelector(".problem-summary")!.textContent).toContain("1 错误 · 1 警告");
  const severity = root.querySelector<HTMLSelectElement>('select[aria-label="严重程度"]')!;
  severity.value = "error";
  severity.dispatchEvent(new Event("change"));
  expect(root.querySelectorAll(".problem-row")).toHaveLength(1);
  (root.querySelector(".problem-row") as HTMLButtonElement).click();
  expect(callbacks.onOpen).toHaveBeenCalledWith(expect.objectContaining({ file: "D:/project/a.sv", line: 8 }));
  panel.markStale();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("结果待重新检查");
  panel.clear();
  expect(root.querySelectorAll(".problem-row")).toHaveLength(0);
});

it("取消和失败不会留下运行中的按钮状态", () => {
  const { root, panel } = setup();
  panel.start();
  const cancel = [...root.querySelectorAll("button")].find(button => button.textContent === "取消")!;
  cancel.click();
  expect(cancel.disabled).toBe(true);
  panel.finish({ ...result(), cancelled: true });
  expect(root.querySelector(".problem-summary")!.textContent).toContain("已取消");
  panel.start();
  panel.fail(new Error("backend unavailable"));
  expect(root.querySelector(".problem-summary")!.textContent).toContain("backend unavailable");
  expect([...root.querySelectorAll("button")].find(button => button.textContent === "运行语法检查")!.disabled).toBe(false);
});
