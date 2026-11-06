// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { analyzeFileFacts } from "../src/analysis/facts";
import { runGeneralRules, type RuleDiagnostic } from "../src/analysis/general-rules";
import type { SyntaxDiagnostic } from "../src/ipc";
import { StatsPanel } from "../src/ui/stats";

afterEach(() => document.body.replaceChildren());

it("统计与诊断口径一致，支持排序、下钻和部分分析状态", () => {
  const root = document.createElement("section");
  document.body.append(root);
  const onOpenFile = vi.fn();
  const onOpenProblems = vi.fn();
  const panel = new StatsPanel(root, { displayPath: file => file.replace("D:/project/", ""), onOpenFile, onOpenProblems, onScopeChange: vi.fn(), onClose: vi.fn() });
  const facts = [
    analyzeFileFacts("D:/project/a.sv", "module a;\ninitial a = 0;\n\n// comment\nendmodule"),
    analyzeFileFacts("D:/project/b.vhd", "entity b is end;"),
  ];
  const diagnostics: (RuleDiagnostic | SyntaxDiagnostic)[] = facts.flatMap(item => runGeneralRules(item));
  diagnostics.push({ file: "D:/project/a.sv", line: 2, column: 1, severity: "error", ruleId: "VERILATOR", source: "verilator", message: "external" });
  const view = {
    facts,
    files: [...facts.map(item => item.file), "D:/project/c.sv"],
    diagnostics,
    done: 2,
    total: 3,
    external: { requestId: 1, checkedFiles: 3, cancelled: false, backends: [], diagnostics: [] },
    running: false,
    stale: true,
    scope: "top" as const,
    topName: "demo",
  };
  panel.render(view);
  expect(root.querySelector(".stats-summary")!.textContent).toContain("HDL 文件 2/3");
  expect(root.querySelector(".stats-summary")!.textContent).toContain("设计单元 2");
  expect(root.querySelector(".stats-structures")!.textContent).toContain("initial 1");
  expect(root.querySelector(".stats-check-status")!.textContent).toContain("上次快照");
  expect(root.querySelector(".stats-check-status")!.textContent).not.toContain("人工核对");
  expect(root.querySelector(".stats-table")!.textContent).toContain("待分析");
  expect([...root.querySelectorAll(".stats-table tfoot td")].map(cell => cell.textContent)).toEqual(["合计", "4", "20%", "0", "0", String(diagnostics.length)]);
  [...root.querySelectorAll<HTMLButtonElement>(".stats-diagnostic")].find(button => button.textContent === "错误 1")!.click();
  expect(onOpenProblems).toHaveBeenCalledWith({ severity: "error" });
  const fileLink = [...root.querySelectorAll<HTMLButtonElement>(".stats-table td button")].find(button => button.title === "D:/project/a.sv")!;
  fileLink.click();
  expect(onOpenFile).toHaveBeenCalledWith("D:/project/a.sv");
  [...root.querySelectorAll<HTMLButtonElement>(".stats-table th button")].find(button => button.textContent?.startsWith("代码行"))!.click();
  expect(root.querySelector(".stats-table tbody tr td button")!.textContent).toBe("a.sv");
  const issueLink = [...root.querySelectorAll<HTMLButtonElement>(".stats-table td button")].find(button => button.title === "查看此文件诊断")!;
  issueLink.click();
  expect(onOpenProblems).toHaveBeenCalledWith({ file: "D:/project/a.sv" });
});

it("模块拓扑按需展开，定位按钮打开定义行且不显示长目录", () => {
  const root = document.createElement("section");
  document.body.append(root);
  const onOpenFile = vi.fn();
  const onOpenProblems = vi.fn();
  const panel = new StatsPanel(root, { displayPath: file => file, onOpenFile, onOpenProblems, onScopeChange: vi.fn(), onClose: vi.fn() });
  const facts = [analyzeFileFacts("D:/project/a.sv", "module a; endmodule"), analyzeFileFacts("D:/project/b.sv", "module b; endmodule")];
  panel.render({
    facts,
    files: facts.map(item => item.file),
    diagnostics: [{ file: "D:/project/b.sv", line: 1, column: 1, severity: "info", ruleId: "RULE", source: "builtin", category: "style", message: "hint" }],
    done: 2,
    total: 2,
    running: false,
    stale: false,
    scope: "top",
    topName: "a",
    topology: [{ key: "a", label: "a", moduleName: "a", file: "D:/project/a.sv", line: 1, children: [{ key: "a/u_b", label: "u_b", moduleName: "b", file: "D:/project/b.sv", line: 2, children: [{ key: "a/u_b/u_c", label: "u_c", moduleName: "c", children: [] }] }] }],
  });
  const rootNode = root.querySelector<HTMLDetailsElement>(".stats-topology-node")!;
  const childNode = rootNode.querySelector<HTMLDetailsElement>(".stats-topology-node")!;
  expect(rootNode.open).toBe(true);
  expect(childNode.open).toBe(false);
  const header = root.querySelector(".stats-topology-head")!;
  const rootRow = rootNode.querySelector(":scope > summary")!;
  expect(header.children).toHaveLength(rootRow.children.length);
  expect(rootRow.children[1]).toBe(rootRow.querySelector(".stats-topology-label"));
  expect(rootRow.lastElementChild).toBe(rootRow.querySelector(".stats-open-file"));
  expect([...root.querySelector(".stats-topology-total")!.children].map(cell => cell.textContent)).toEqual(["", "合计", "2", "0%", "0", "0", "1", ""]);
  expect(root.textContent).not.toContain("D:/project");
  childNode.querySelector("summary")!.click();
  expect(childNode.open).toBe(true);
  childNode.querySelector<HTMLButtonElement>(".stats-open-file")!.click();
  expect(onOpenFile).toHaveBeenCalledWith("D:/project/b.sv", 2);
  childNode.querySelector<HTMLButtonElement>(".stats-topology-issues")!.click();
  expect(onOpenProblems).toHaveBeenCalledWith({ file: "D:/project/b.sv" });
  root.querySelector<HTMLSelectElement>(".stats-view-mode")!.value = "files";
  root.querySelector<HTMLSelectElement>(".stats-view-mode")!.dispatchEvent(new Event("change"));
  expect(root.querySelector(".stats-table table")).not.toBeNull();
});
