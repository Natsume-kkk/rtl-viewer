import { beforeEach, expect, it, vi } from "vitest";
import { syncProblemMarkers } from "../src/app/problem-markers";

const mocks = vi.hoisted(() => ({ setModelMarkers: vi.fn() }));
vi.mock("../src/editor/monaco", () => ({
  monaco: {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: { setModelMarkers: mocks.setModelMarkers },
  },
}));

beforeEach(() => mocks.setModelMarkers.mockReset());

it("诊断按文件落到 Monaco，过期结果清除标记", () => {
  const model = { isDisposed: () => false, getLineCount: () => 2 };
  const diagnostic = { file: "D:/project/a.sv", line: 2, column: 3, severity: "warning", ruleId: "VERILATOR-TEST", source: "verilator", message: "example" };
  syncProblemMarkers([{ path: "D:/project/a.sv", model: model as never }], [diagnostic], false);
  expect(mocks.setModelMarkers).toHaveBeenCalledOnce();
  expect(mocks.setModelMarkers.mock.calls[0][2]).toHaveLength(1);
  expect(mocks.setModelMarkers.mock.calls[0][2][0]).toMatchObject({ startLineNumber: 2, startColumn: 3, severity: 4, message: "VERILATOR-TEST: Verilator 未分类诊断（悬停查看原文）\n原始诊断：example" });
  syncProblemMarkers([{ path: "D:/project/a.sv", model: model as never }], [diagnostic], true);
  expect(mocks.setModelMarkers.mock.calls[1][2]).toHaveLength(0);
});

it("外部结果过期时保留当前内置诊断标记", () => {
  const model = { isDisposed: () => false, getLineCount: () => 2 };
  const external = { file: "D:/project/a.sv", line: 2, column: 3, severity: "warning", ruleId: "VERILATOR-TEST", source: "verilator", message: "external" };
  const builtin = { file: "D:/project/a.sv", line: 1, column: 1, severity: "info", ruleId: "VLG-ST-001", source: "builtin", message: "current" };
  syncProblemMarkers([{ path: "D:/project/a.sv", model: model as never }], [external], true, [builtin]);
  expect(mocks.setModelMarkers).toHaveBeenCalledOnce();
  expect(mocks.setModelMarkers.mock.calls[0][2]).toHaveLength(1);
  expect(mocks.setModelMarkers.mock.calls[0][2][0]).toMatchObject({ startLineNumber: 1, message: "VLG-ST-001: current" });
});

it("单文件 Monaco 标记最多保留 500 条", () => {
  const model = { isDisposed: () => false, getLineCount: () => 2 };
  const diagnostics = Array.from({ length: 501 }, (_, index) => ({ file: "D:/project/a.sv", line: 1, column: 1, severity: "info", ruleId: `RULE-${index}`, source: "builtin", message: "current" }));
  syncProblemMarkers([{ path: "D:/project/a.sv", model: model as never }], diagnostics, false);
  expect(mocks.setModelMarkers.mock.calls[0][2]).toHaveLength(500);
});
