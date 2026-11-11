// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { ProblemPanel } from "../src/ui/problems";
import { emptySyntaxCheckOptions, type SyntaxCheckResult } from "../src/ipc";
import { syntaxReportCsv, syntaxReportHtml } from "../src/app/syntax-report";
import { filePathKey } from "../src/file-path";

// 执行真实入口函数，仅替换桌面 IO 与周边界面；避免加载整个 Monaco 应用。
function setup() {
  const source = readFileSync("src/main.ts", "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["runProjectSyntaxCheck", "cancelProjectSyntaxCheck", "exportSyntaxReport", "reportFileName"]);
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "")).map(node => node.getText(ast)).join("\n");
  const panel = new ProblemPanel(document.createElement("section"), { onConfigure() {}, onCancel() {}, onScopeChange() {}, onExport() {}, onOpen() {}, onClose() {} });
  const old: SyntaxCheckResult = { requestId: 1, checkedFiles: 1, cancelled: false, backends: [{ name: "verilator", version: "old", files: 1, status: "completed" }], diagnostics: [] };
  panel.finish(old);
  const context = vm.createContext({
    window, Date, filePathKey, state: { folder: "D:/p", ips: [], structures: new Map(), contents: new Map() },
    projectReady: true, syntaxRefreshTimer: undefined, syntaxSerial: 1, runningSyntaxRequest: 0, syntaxChangedWhileRunning: false,
    syntaxOptions: { ...emptySyntaxCheckOptions }, lastSyntaxOptions: { ...emptySyntaxCheckOptions }, lastSyntaxResult: old,
    validateSyntaxOptions: () => [], moduleMetadataLoader: { invalidateIps() {} }, groups: [], analysisScope: "project",
    projectHdlFiles: vi.fn(() => ["D:/p/a.sv"]), analysisHdlFiles: vi.fn(() => ["D:/p/a.sv"]),
    cancelSyntaxCheck: vi.fn(), runSyntaxCheck: vi.fn(), explainVerilatorSyntax() {},
    problemPanel: panel, refreshFactsViews: vi.fn(), statusbar: { hint: vi.fn(), error: vi.fn() },
    choiceDialog: vi.fn(async () => 1), saveReportDialog: vi.fn(async () => "D:/p/report.csv"), writeFile: vi.fn(),
    factsScheduler: { values: () => [] }, inAnalysisScope: () => true, syntaxReportCsv, syntaxReportHtml,
  });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { context, panel, old };
}

it.each([false, true])("删除最后一个文件取消在飞检查，迟到结果或失败不能回填（失败=%s）", async failed => {
  const { context, panel, old } = setup();
  let finish!: (value: SyntaxCheckResult) => void;
  let reject!: (reason: Error) => void;
  context.runSyntaxCheck.mockImplementation(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
  const pending = context.runProjectSyntaxCheck();
  await vi.waitFor(() => expect(context.runSyntaxCheck).toHaveBeenCalledOnce());
  const request = context.runningSyntaxRequest;
  context.projectHdlFiles.mockReturnValue([]); context.analysisHdlFiles.mockReturnValue([]);
  await context.runProjectSyntaxCheck();
  expect(context.cancelSyntaxCheck).toHaveBeenCalledWith(request);
  expect(context.runningSyntaxRequest).toBe(0);
  expect(context.lastSyntaxResult.checkedFiles).toBe(0);
  expect(panel.indicator.running).toBe(false);
  if (failed) reject(new Error("old request failed"));
  else finish({ ...old, requestId: request, checkedFiles: 99 });
  await pending;
  expect(context.lastSyntaxResult.checkedFiles).toBe(0);
  expect(panel.indicator).toMatchObject({ running: false, stale: false, failed: false });
});

it("调用失败后导出旧结果仍记录过期和失败，成功重试后清除失败", async () => {
  const { context, panel, old } = setup();
  panel.markStale();
  context.runSyntaxCheck.mockRejectedValueOnce(new Error("backend <unavailable>"));
  expect(await context.runProjectSyntaxCheck()).toBe(false);
  await context.exportSyntaxReport("csv");
  expect(context.choiceDialog).toHaveBeenCalledOnce();
  expect(context.writeFile.mock.calls[0][1]).toContain('"Stale","true"');
  expect(context.writeFile.mock.calls[0][1]).toContain('"Failure","Error: backend <unavailable>"');
  await context.exportSyntaxReport("html");
  expect(context.writeFile.mock.calls[1][1]).toContain("backend &lt;unavailable&gt;");
  context.runSyntaxCheck.mockResolvedValueOnce({ ...old, requestId: 3 });
  expect(await context.runProjectSyntaxCheck()).toBe(true);
  expect(panel.indicator).toMatchObject({ stale: false, failed: false });
});
