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
  expect([...root.querySelectorAll(".stats-table th button")].map(button => button.textContent)).toEqual(["文件", "总行数", "代码行", "注释比例", "例化", "问题"]);
  expect([...root.querySelectorAll(".stats-table tbody tr:first-child td")].map(cell => cell.textContent)).toEqual(["合计", "6", "4", "20%", "0", String(diagnostics.length)]);
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
    topology: [{ key: "a", label: "a", moduleName: "a", kind: "module", file: "D:/project/a.sv", line: 1, children: [{ key: "a/u_b", label: "u_b", moduleName: "b", kind: "module", file: "D:/project/b.sv", line: 2, children: [{ key: "a/u_b/u_c", label: "u_c", moduleName: "c", kind: "unresolved", children: [] }] }] }],
  });
  const rootNode = root.querySelector<HTMLDetailsElement>(".stats-topology-node")!;
  const childNode = rootNode.querySelector<HTMLDetailsElement>(".stats-topology-node")!;
  expect(rootNode.open).toBe(true);
  expect(childNode.open).toBe(false);
  const header = root.querySelector(".stats-topology-head")!;
  const rootRow = rootNode.querySelector(":scope > summary")!;
  expect(header.children).toHaveLength(rootRow.children.length);
  expect(header.nextElementSibling).toBe(root.querySelector(".stats-topology-total"));
  expect(rootRow.children[1]).toBe(rootRow.querySelector(".stats-topology-label"));
  expect(rootRow.lastElementChild).toBe(rootRow.querySelector(".stats-open-file"));
  expect([...root.querySelector(".stats-topology-total")!.children].map(cell => cell.textContent)).toEqual(["", "合计", "2", "2", "0%", "0", "1", ""]);
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


it("隐藏统计不渲染，恢复后刷新且孙级节点仅在展开时物化", async () => {
  const root = document.createElement("section");
  root.hidden = true;
  document.body.append(root);
  const panel = new StatsPanel(root, { displayPath: file => file, onOpenFile: vi.fn(), onOpenProblems: vi.fn(), onScopeChange: vi.fn(), onClose: vi.fn() });
  let grandchildReads = 0;
  const grandchild = { key: "a/u/u_g", label: "u_g", moduleName: "g", kind: "module" as const, children: [] };
  Object.defineProperty(grandchild, "children", { get: () => { grandchildReads++; return []; } });
  const child = { key: "a/u", label: "u", moduleName: "u", kind: "module" as const, children: [grandchild] };
  const view = { facts: [], files: [], diagnostics: [], done: 0, total: 0, running: false, stale: false, scope: "top" as const, topology: [{ key: "a", label: "a", moduleName: "a", kind: "module" as const, children: [child] }] };
  panel.render(view);
  expect(root.querySelector(".stats-topology")).toBeNull();
  root.hidden = false;
  panel.refresh();
  expect(grandchildReads).toBe(0);
  const childNode = root.querySelector<HTMLDetailsElement>(".stats-topology-node .stats-topology-node")!;
  childNode.open = true;
  childNode.dispatchEvent(new Event("toggle"));
  await vi.waitFor(() => expect(grandchildReads).toBe(1));
});

it("拓扑中的未分析文件显示待分析而不是零统计", () => {
  const root = document.createElement("section");
  document.body.append(root);
  const panel = new StatsPanel(root, { displayPath: file => file, onOpenFile: vi.fn(), onOpenProblems: vi.fn(), onScopeChange: vi.fn(), onClose: vi.fn() });
  panel.render({ facts: [], files: ["D:/project/a.sv"], diagnostics: [], done: 0, total: 1, running: false, stale: false, scope: "top", topology: [{ key: "a", label: "a", moduleName: "a", kind: "module", file: "D:/project/a.sv", children: [] }] });
  const issue = root.querySelector<HTMLButtonElement>(".stats-topology-issues")!;
  expect(issue.textContent).toBe("待分析");
  expect(issue.disabled).toBe(true);
  expect(root.querySelector(".stats-topology-row")!.textContent).not.toContain("0%");
});

it("拓扑和文件列表区分黑盒、未解析、分析失败与待分析", () => {
  const root = document.createElement("section");
  document.body.append(root);
  const onOpenProblems = vi.fn();
  const panel = new StatsPanel(root, { displayPath: file => file, onOpenFile: vi.fn(), onOpenProblems, onScopeChange: vi.fn(), onClose: vi.fn() });
  const failure: RuleDiagnostic = { file: "D:/project/failed.sv", line: 1, column: 1, severity: "error", ruleId: "ANALYSIS-FAILED", source: "builtin", category: "analysis", message: "内置分析失败" };
  panel.render({
    facts: [],
    files: ["D:/project/failed.sv"],
    diagnostics: [failure],
    done: 1,
    total: 1,
    running: false,
    stale: false,
    scope: "top",
    topology: [{
      key: "top", label: "top", moduleName: "top", kind: "module", file: "D:/project/failed.sv", children: [
        { key: "top/u_ip", label: "u_ip", moduleName: "clk_wiz", kind: "ip", file: "D:/project/ip/clk_wiz.xci", children: [] },
        { key: "top/u_primitive", label: "u_primitive", moduleName: "BUFG", kind: "primitive", children: [] },
        { key: "top/u_missing", label: "u_missing", moduleName: "missing", kind: "unresolved", children: [] },
      ],
    }],
  });
  const rows = [...root.querySelectorAll(".stats-topology-row")].filter(row => !row.classList.contains("stats-topology-total") && !row.classList.contains("stats-topology-head"));
  const issueText = (index: number) => rows[index].querySelector(".stats-topology-issues")!.textContent;
  expect(issueText(0)).toBe("分析失败");
  expect(rows[0].querySelector<HTMLButtonElement>(".stats-topology-issues")!.disabled).toBe(false);
  expect(issueText(1)).toBe("IP");
  expect(rows[1].querySelector<HTMLButtonElement>(".stats-topology-issues")!.title).toBe("IP 黑盒，不纳入内置代码统计与规则分析");
  expect(issueText(2)).toBe("原语");
  expect(rows[2].querySelector<HTMLButtonElement>(".stats-topology-issues")!.title).toBe("厂商原语，不纳入内置代码统计与规则分析");
  expect(issueText(3)).toBe("未解析");
  expect(rows[3].querySelector(".stats-ip-label")!.textContent).toBe("—");
  expect(root.querySelector(".stats-table")!.textContent).not.toContain("待分析");
  rows[0].querySelector<HTMLButtonElement>(".stats-topology-issues")!.click();
  expect(onOpenProblems).toHaveBeenCalledWith({ file: "D:/project/failed.sv" });

  root.querySelector<HTMLSelectElement>(".stats-view-mode")!.value = "files";
  root.querySelector<HTMLSelectElement>(".stats-view-mode")!.dispatchEvent(new Event("change"));
  const failedRow = root.querySelector(".stats-table tbody tr:last-child")!;
  expect(failedRow.textContent).toContain("分析失败");
  expect(failedRow.textContent).not.toContain("待分析");
  failedRow.querySelector<HTMLButtonElement>("td:last-child button")!.click();
  expect(onOpenProblems).toHaveBeenCalledWith({ file: "D:/project/failed.sv" });
});

it("同一份拓扑刷新复用节点，后展开子节点使用最新诊断", () => {
  const root = document.createElement("section");
  document.body.append(root);
  const panel = new StatsPanel(root, { displayPath: file => file, onOpenFile: vi.fn(), onOpenProblems: vi.fn(), onScopeChange: vi.fn(), onClose: vi.fn() });
  const topology = [{ key: "a", label: "a", moduleName: "a", kind: "module" as const, file: "D:/project/a.sv", children: [{ key: "a/u", label: "u", moduleName: "b", kind: "module" as const, file: "D:/project/b.sv", children: [] }] }];
  const view = { facts: [analyzeFileFacts("D:/project/a.sv", "module a; endmodule"), analyzeFileFacts("D:/project/b.sv", "module b; endmodule")], files: ["D:/project/a.sv", "D:/project/b.sv"], diagnostics: [], done: 2, total: 2, running: false, stale: false, scope: "top" as const, topology };
  panel.render(view);
  const rootNode = root.querySelector<HTMLDetailsElement>(".stats-topology-node")!;
  panel.render({ ...view, diagnostics: [{ file: "D:/project/b.sv", line: 1, column: 1, severity: "info" as const, ruleId: "RULE", source: "builtin" as const, category: "style" as const, message: "hint" }] });
  expect(root.querySelector(".stats-topology-node")).toBe(rootNode);
  rootNode.querySelector("summary")!.click();
  const childNode = rootNode.querySelector<HTMLDetailsElement>(".stats-topology-node")!;
  expect(childNode.querySelector(".stats-topology-issues")!.textContent).toBe("1");
});

it("全部工程文件按二百行加载，刷新保留已加载数量", () => {
  const root = document.createElement("section");
  document.body.append(root);
  const panel = new StatsPanel(root, { displayPath: file => file, onOpenFile: vi.fn(), onOpenProblems: vi.fn(), onScopeChange: vi.fn(), onClose: vi.fn() });
  const files = Array.from({ length: 450 }, (_, index) => `D:/project/file-${index}.sv`);
  const view = { facts: [], files, diagnostics: [], done: 0, total: files.length, running: false, stale: false, scope: "project" as const };
  panel.render(view);
  expect(root.querySelectorAll(".stats-table tr[data-file]")).toHaveLength(200);
  root.querySelector<HTMLButtonElement>(".stats-load-more")!.click();
  expect(root.querySelectorAll(".stats-table tr[data-file]")).toHaveLength(400);
  root.querySelector<HTMLButtonElement>(".stats-load-more")!.click();
  expect(root.querySelectorAll(".stats-table tr[data-file]")).toHaveLength(450);
  expect(root.querySelector(".stats-load-more")).toBeNull();
  panel.render(view);
  expect(root.querySelectorAll(".stats-table tr[data-file]")).toHaveLength(450);
});
