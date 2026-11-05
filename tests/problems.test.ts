// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ProblemPanel } from "../src/ui/problems";
import type { SyntaxCheckResult } from "../src/ipc";
import type { RuleDiagnostic } from "../src/analysis/general-rules";

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

function builtin(ruleId: string, category: RuleDiagnostic["category"]): RuleDiagnostic {
  return { file: "D:/project/a.sv", line: 3, column: 1, severity: "info", ruleId, source: "builtin", category, message: `${ruleId} hint` };
}

function setup() {
  const root = document.createElement("section");
  document.body.append(root);
  const callbacks = { onRun: vi.fn(), onConfigure: vi.fn(), onCancel: vi.fn(), onScopeChange: vi.fn(), onExport: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), displayPath: (file: string) => file.replace("D:/project/", "") };
  const panel = new ProblemPanel(root, callbacks);
  return { root, panel, callbacks };
}

it("运行、取消、定位和过期状态共用同一份诊断结果", () => {
  const { root, panel, callbacks } = setup();
  const run = [...root.querySelectorAll("button")].find(button => button.textContent === "检查")!;
  run.click();
  expect(callbacks.onRun).toHaveBeenCalledOnce();
  panel.start();
  expect(run.disabled).toBe(true);
  panel.finish(result());
  expect(run.disabled).toBe(false);
  expect(root.querySelectorAll(".problem-row")).toHaveLength(2);
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 2/2 条");
  (root.querySelector(".problem-row") as HTMLButtonElement).click();
  expect(callbacks.onOpen).toHaveBeenCalledWith(expect.objectContaining({ file: "D:/project/a.sv", line: 8 }));
  panel.markStale();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("上次快照");
  panel.start();
  const cancel = [...root.querySelectorAll("button")].find(button => button.textContent === "取消")!;
  cancel.click();
  expect(cancel.disabled).toBe(true);
  panel.finish({ ...result(), cancelled: true });
  expect(root.querySelector(".problem-summary")!.textContent).toContain("结果可能不完整");
  panel.start();
  panel.fail(new Error("backend unavailable"));
  expect(root.querySelector(".problem-summary")!.textContent).toContain("backend unavailable");
  expect(run.disabled).toBe(false);
});

it("多选、文件和文本筛选只改变显示，清除后恢复全部诊断", () => {
  const { root, panel } = setup();
  panel.setBuiltins([builtin("VLG-ST-001", "style"), builtin("10157-A-1-1", "gjb10157")]);
  panel.finish(result());
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 4/4 条");
  const error = root.querySelector<HTMLInputElement>('input[data-problem-severity="error"]')!;
  error.click();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 3/4 条");
  const external = root.querySelector<HTMLInputElement>('input[data-problem-source="external"]')!;
  external.click();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 2/4 条");
  const files = root.querySelector<HTMLSelectElement>('select[aria-label="文件筛选"]')!;
  files.value = "D:/project/b.sv";
  files.dispatchEvent(new Event("change"));
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 0/4 条");
  files.value = "all";
  files.dispatchEvent(new Event("change"));
  const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索规则或诊断"]')!;
  search.value = "10157";
  search.dispatchEvent(new Event("input"));
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1/4 条");
  [...root.querySelectorAll("button")].find(button => button.textContent === "清除筛选")!.click();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 4/4 条");
  expect(panel.hasResults).toBe(true);
  panel.setDisplayFilter({ severity: "error", file: "D:/project/a.sv" });
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1/4 条");
});

it("提示按规则折叠，黑盒提示独立折叠且错误仍直接显示", () => {
  const { root, panel, callbacks } = setup();
  const external = result();
  external.diagnostics.push(
    { file: "D:/tmp/verilator/stubs/clock.sv", line: 2, column: 1, severity: "warning", ruleId: "VERILATOR-UNUSED", source: "verilator", message: "Unused stub" },
    { file: "D:/tmp/verilator/stubs/clock.sv", line: 3, column: 1, severity: "error", ruleId: "VERILATOR-SYNTAX", source: "verilator", message: "Bad stub" },
  );
  panel.setBuiltins([builtin("10157-A-1-1", "gjb10157")]);
  panel.finish(external);
  const infoGroup = root.querySelector<HTMLDetailsElement>(".problem-info-group")!;
  const stubGroup = root.querySelector<HTMLDetailsElement>(".problem-stub-group")!;
  expect(infoGroup.open).toBe(false);
  infoGroup.querySelector<HTMLButtonElement>(".problem-group-jump")!.click();
  expect(callbacks.onOpen).toHaveBeenCalledWith(expect.objectContaining({ file: "D:/project/a.sv", line: 3, column: 1 }));
  expect(infoGroup.open).toBe(false);
  infoGroup.querySelector("summary")!.click();
  expect(infoGroup.open).toBe(true);
  expect(stubGroup.open).toBe(false);
  expect(stubGroup.textContent).toContain("黑盒／生成文件提示 · 1 条");
  expect(stubGroup.querySelector("button")!.disabled).toBe(true);
  expect([...root.querySelectorAll(".problem-error")].some(row => row.textContent?.includes("Bad stub") && !stubGroup.contains(row))).toBe(true);
});

it("内置分析完成即可导出，不依赖外部检查", () => {
  const { root, panel } = setup();
  const html = [...root.querySelectorAll("button")].find(button => button.textContent === "导出 HTML") as HTMLButtonElement;
  expect(html.disabled).toBe(true);
  panel.setBuiltins([], true);
  expect(html.disabled).toBe(false);
});

it("筛选区可折叠且后端版本保持简短", () => {
  const { root, panel } = setup();
  panel.finish(result());
  const toggle = [...root.querySelectorAll("button")].find(button => button.textContent === "筛选")!;
  const filters = root.querySelector<HTMLElement>("#problem-filters")!;
  toggle.click();
  expect(filters.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  expect(filters.hidden).toBe(false);
  expect(root.querySelector(".problem-backends")!.textContent).toBe("内置分析 · 等待分析Verilator 5.050 · 已完成");
  expect(root.querySelector(".problem-backends")!.textContent).not.toContain("rev");
});

it("常规状态隐藏检查设置，依赖错误和范围切换提供明确入口", () => {
  const { root, panel, callbacks } = setup();
  const configure = [...root.querySelectorAll("button")].find(button => button.textContent === "检查设置")!;
  expect(configure.hidden).toBe(true);
  panel.finish(result());
  expect(configure.hidden).toBe(true);
  const external = result();
  external.diagnostics[0].message = "Cannot open include file";
  panel.finish(external);
  expect(configure.hidden).toBe(false);
  const scope = root.querySelector<HTMLSelectElement>('select[aria-label="检查范围"]')!;
  scope.value = "project";
  scope.dispatchEvent(new Event("change"));
  expect(callbacks.onScopeChange).toHaveBeenCalledWith("project");
  panel.setScope("top", "demo");
  expect(scope.value).toBe("top");
  expect(scope.title).toContain("demo");
});
