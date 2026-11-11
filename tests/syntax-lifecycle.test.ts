// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { ProblemPanel } from "../src/ui/problems";
import { emptySyntaxCheckOptions, type SyntaxCheckResult } from "../src/ipc";
import { syntaxReportCsv, syntaxReportHtml } from "../src/app/syntax-report";
import { filePathKey, indexedFilePath } from "../src/file-path";
import { scanStructure } from "../src/parser";
import { syntaxDependencyFiles } from "../src/app/syntax-order";
import { syntaxScope } from "../src/app/syntax-scope";
import { createStructureScanner } from "../src/app/structure-scanner";

// 执行真实入口函数，仅替换桌面 IO 与周边界面；避免加载整个 Monaco 应用。
function setup() {
  const source = readFileSync("src/main.ts", "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["runProjectSyntaxCheck", "cancelProjectSyntaxCheck", "cancelRunningSyntaxCheck", "exportSyntaxReport", "reportFileName"]);
  const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "")).map(node => node.getText(ast)).join("\n");
  const panel = new ProblemPanel(document.createElement("section"), { onConfigure() {}, onCancel() {}, onScopeChange() {}, onExport() {}, onOpen() {}, onClose() {} });
  const old: SyntaxCheckResult = { requestId: 1, checkedFiles: 1, cancelled: false, backends: [{ name: "verilator", version: "old", files: 1, status: "completed" }], diagnostics: [] };
  panel.finish(old);
  const context = vm.createContext({
    window, Date, filePathKey, indexedFilePath, syntaxScope, createStructureScanner,
    syntaxScopeScanner: undefined, syntaxBackendStarted: false, activeTopFiles: new Set(), activeTopModules: new Set(), activeTopology: [], effectiveAnalysisTop: () => undefined,
    state: { folder: "D:/p", ips: [], structures: new Map(), contents: new Map(), definitionPreferences: new Map() },
    projectReady: true, syntaxRefreshTimer: undefined, syntaxSerial: 1, runningSyntaxRequest: 0, syntaxChangedWhileRunning: false,
    syntaxOptions: { ...emptySyntaxCheckOptions }, lastSyntaxOptions: { ...emptySyntaxCheckOptions }, lastSyntaxResult: old,
    validateSyntaxOptions: () => [], moduleMetadataLoader: { invalidateIps() {} }, groups: [], analysisScope: "project",
    projectHdlFiles: vi.fn(() => ["D:/p/a.sv"]), analysisHdlFiles: vi.fn(() => ["D:/p/a.sv"]),
    cancelSyntaxCheck: vi.fn(), runSyntaxCheck: vi.fn(), explainVerilatorSyntax() {},
    problemPanel: panel, refreshFactsViews: vi.fn(), statusbar: { hint: vi.fn(), error: vi.fn() },
    choiceDialog: vi.fn(async () => 1), saveReportDialog: vi.fn(async () => "D:/p/report.csv"), writeFile: vi.fn(),
    factsScheduler: { values: () => [], start: vi.fn() }, inAnalysisScope: () => true, syntaxReportCsv, syntaxReportHtml,
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

it("取消未保存结构扫描时终止 Worker，旧任务不发布范围或启动后端", async () => {
  const { context, panel } = setup();
  context.state.contents.set("D:/p/a.sv", { content: "module a; endmodule" });
  context.groups = [{ tabs: { allTabs: [{ path: "D:/p/a.sv", dirty: true, encoding: "utf8", model: { getValue: () => "module a; child u(); endmodule" } }] } }];
  let reject!: (error: Error) => void;
  const dispose = vi.fn(() => reject?.(new Error("结构解析已取消")));
  context.createStructureScanner = () => ({ scan: () => new Promise((_, fail) => { reject = fail; }), dispose });
  const pending = context.runProjectSyntaxCheck();
  context.cancelRunningSyntaxCheck();
  expect(await pending).toBe(false);
  expect(dispose).toHaveBeenCalled();
  expect(context.runSyntaxCheck).not.toHaveBeenCalled();
  expect(context.cancelSyntaxCheck).not.toHaveBeenCalled();
  expect(context.lastSyntaxResult.cancelled).toBe(true);
  expect(panel.indicator).toMatchObject({ running: false, failed: false });
});

it("未保存新增例化按快照纳入传递子模块，移除后退出检查范围", async () => {
  const { context, old } = setup();
  const sources = new Map([
    ["D:/p/top.sv", "module top(input d,output q); assign q=d; endmodule"],
    ["D:/p/blocks.sv", "module child(input d,output q); leaf u(.d(d),.q(q)); endmodule"],
    ["D:/p/leaf.sv", "module leaf(input d,output q); assign q=d; endmodule"],
  ]);
  context.state.contents = new Map([...sources].map(([file, content]) => [file, { content }]));
  context.state.structures = new Map([...sources].map(([file, content]) => [file, scanStructure(content, file)]));
  let edited = "module top(input d,output q); child u(.d(d),.q(q)); endmodule";
  context.groups = [{ tabs: { allTabs: [{ dirty: true, path: "D:/p/top.sv", encoding: "utf8", model: { getValue: () => edited } }] } }];
  context.analysisScope = "top";
  context.effectiveAnalysisTop = () => "top";
  context.activeTopModules = new Set(["top"]);
  context.activeTopFiles = new Set([filePathKey("D:/p/top.sv")]);
  context.fileContent = (file: string) => file === "D:/p/top.sv" ? edited : sources.get(file);
  context.syntaxDependencyFiles = syntaxDependencyFiles;
  context.projectHdlFiles.mockReturnValue([...sources.keys()]);
  context.analysisHdlFiles.mockReturnValue(["D:/p/top.sv"]);
  context.runSyntaxCheck.mockResolvedValue(old);
  await context.runProjectSyntaxCheck();
  expect(new Set(context.runSyntaxCheck.mock.calls[0][1])).toEqual(new Set(sources.keys()));
  edited = sources.get("D:/p/top.sv")!;
  await context.runProjectSyntaxCheck();
  expect(context.runSyntaxCheck.mock.calls[1][1]).toEqual(["D:/p/top.sv"]);
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

it("保存对话框期间重新分析时，导出固定的完整结果快照", async () => {
  const { context, panel } = setup();
  panel.setBuiltins([{ file: "D:/p/a.sv", line: 1, column: 1, severity: "warning", ruleId: "OLD", source: "builtin", category: "synth", message: "完整结果" }]);
  context.saveReportDialog.mockImplementation(async () => {
    panel.setBuiltins([{ file: "D:/p/a.sv", line: 1, column: 1, severity: "warning", ruleId: "PARTIAL", source: "builtin", category: "synth", message: "部分结果" }], true, true);
    return "D:/p/report.csv";
  });
  await context.exportSyntaxReport("csv");
  const output = context.writeFile.mock.calls[0][1];
  expect(output).toContain("完整结果");
  expect(output).not.toContain("部分结果");
});
