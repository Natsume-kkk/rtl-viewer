import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeSyntaxCheck } from "../src/app/node-syntax";
import { emptySyntaxCheckOptions } from "../src/ipc";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it("Node CLI 后端使用未保存快照并返回原路径诊断", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-syntax-"));
  roots.push(root);
  const source = path.join(root, "top.sv");
  fs.writeFileSync(source, "module top; invalid verilog\n");
  const result = runNodeSyntaxCheck({
    requestId: 1,
    root,
    files: [source],
    stubs: [],
    options: emptySyntaxCheckOptions,
    snapshots: [{ file: source, content: "module top(input logic a, output logic b); assign b = a; endmodule\n", encoding: "utf8" }],
  });
  expect(result.checkedFiles).toBe(1);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
});
