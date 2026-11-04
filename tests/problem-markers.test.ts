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
  expect(mocks.setModelMarkers.mock.calls[0][2][0]).toMatchObject({ startLineNumber: 2, startColumn: 3, severity: 4 });
  syncProblemMarkers([{ path: "D:/project/a.sv", model: model as never }], [diagnostic], true);
  expect(mocks.setModelMarkers.mock.calls[1][2]).toHaveLength(0);
});
