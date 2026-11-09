import { expect, it } from "vitest";
import { syntaxReportCsv, syntaxReportHtml } from "../src/app/syntax-report";
import type { SyntaxCheckResult } from "../src/ipc";
import { analyzeFileFacts } from "../src/analysis/facts";
import { emptySyntaxCheckOptions } from "../src/ipc";

const result: SyntaxCheckResult = {
  requestId: 3,
  checkedFiles: 1,
  cancelled: false,
  backends: [{ name: "ghdl", version: "6.0.0", files: 1, status: "completed" }],
  diagnostics: [{ file: "D:/p/<top>.vhd", line: 2, column: 4, severity: "error", ruleId: "GHDL", source: "ghdl", message: "bad \"value\", <detail> & more" }],
};

it("HTML 报告包含后端信息并转义源码消息", () => {
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

it("HTML 报告包含配置、统计和分析边界，不包含人工核对或合规率", () => {
  const html = syntaxReportHtml("D:/p/demo", result, new Date("2026-11-04T00:00:00Z"), {
    options: { ...emptySyntaxCheckOptions, top: "demo" },
    facts: [analyzeFileFacts("D:/p/demo.vhd", "entity demo is end;")],
    stale: true,
  });
  expect(html).toContain("工程统计");
  expect(html).toContain("检查范围");
  expect(html).toContain("源码或配置已变化，外部诊断待重新检查");
  expect(html).not.toContain("人工核对");
  expect(html).not.toContain("未自动检查条款");
  expect(html).not.toContain("GJB 10157 自动检查");
});

it("仅有内置结果时明确外部后端未运行", () => {
  const html = syntaxReportHtml("D:/p/demo", { ...result, checkedFiles: 0, backends: [], diagnostics: [] });
  expect(html).toContain("外部后端未运行");
  expect(html).toContain("本次仅包含内置分析结果");
});

it("CSV 在诊断表后保留后端、配置、统计和过期状态", () => {
  const csv = syntaxReportCsv(result, { options: { ...emptySyntaxCheckOptions, top: "demo" }, facts: [analyzeFileFacts("D:/p/demo.vhd", "-- header\nentity demo is end;")], stale: true });
  expect(csv).toContain('"Backend","Version","Files","Status"');
  expect(csv).toContain('"ghdl","6.0.0","1","completed"');
  expect(csv).toContain('"Stale","true"');
  expect(csv).toContain('"Options","{""top"":""demo""');
  expect(csv).toContain('"CodeLines","CommentLines","CommentRatio"');
});
