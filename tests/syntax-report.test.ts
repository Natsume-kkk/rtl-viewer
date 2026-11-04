import { expect, it } from "vitest";
import { syntaxReportCsv, syntaxReportHtml } from "../src/app/syntax-report";
import type { SyntaxCheckResult } from "../src/ipc";

const result: SyntaxCheckResult = {
  requestId: 3,
  checkedFiles: 1,
  cancelled: false,
  backends: [{ name: "ghdl", version: "6.0.0", files: 1, status: "completed" }],
  diagnostics: [{ file: "D:/p/<top>.vhd", line: 2, column: 4, severity: "error", ruleId: "GHDL", source: "ghdl", message: "bad \"value\", <detail> & more" }],
};

it("HTML 报告包含覆盖信息并转义源码消息", () => {
  const html = syntaxReportHtml("D:/p/<demo>", result, new Date("2026-11-04T00:00:00Z"));
  expect(html).toContain("GHDL");
  expect(html).toContain("6.0.0");
  expect(html).toContain("D:/p/&lt;demo&gt;");
  expect(html).toContain("bad &quot;value&quot;, &lt;detail&gt; &amp; more");
  expect(html).not.toContain("<top>.vhd");
});

it("CSV 按字段转义引号、逗号和换行", () => {
  const csv = syntaxReportCsv(result);
  expect(csv).toContain('"D:/p/<top>.vhd"');
  expect(csv).toContain('"bad ""value"", <detail> & more"');
  expect(csv.endsWith("\r\n")).toBe(true);
});
