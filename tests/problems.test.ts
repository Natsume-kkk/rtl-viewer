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
  const callbacks = { onConfigure: vi.fn(), onCancel: vi.fn(), onScopeChange: vi.fn(), onExport: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onIndicator: vi.fn() };
  const panel = new ProblemPanel(root, callbacks);
  return { root, panel, callbacks };
}

it("复查失败保留旧结果的过期标记，收到新结果才清除", () => {
  const { panel } = setup();
  panel.finish(result());
  panel.markStale();
  panel.start();
  expect(panel.isStale).toBe(true);
  panel.fail("backend unavailable");
  expect(panel.indicator).toMatchObject({ stale: true, failed: true, running: false });
  panel.start();
  panel.finish({ ...result(), requestId: 2 });
  expect(panel.indicator).toMatchObject({ stale: false, failed: false });
});

it("未预先标记过期的结果在调用失败后也必须标记为旧结果", () => {
  const { panel } = setup();
  panel.finish(result());
  panel.start();
  panel.fail("backend unavailable");
  expect(panel.isStale).toBe(true);
  expect(panel.failureMessage).toBe("backend unavailable");
  panel.finish(result(), true);
  expect(panel.isStale).toBe(true);
  expect(panel.failureMessage).toBe("");
});

it("同一文件不同 GHDL 错误共组时使用中性标题，明细和悬停保留各自原因", () => {
  const { root, panel, callbacks } = setup();
  const external = result();
  external.diagnostics = [
    { ...external.diagnostics[0], source: "ghdl", ruleId: "GHDL", message: 'error: identifier "duplicate_signal" already used for a declaration' },
    { ...external.diagnostics[0], source: "ghdl", ruleId: "GHDL", line: 9, message: 'error: no declaration for "missing_signal"' },
  ];
  panel.finish(external);
  const group = root.querySelector<HTMLDetailsElement>(".problem-error-group")!;
  expect(root.querySelectorAll(".problem-group")).toHaveLength(1);
  expect(group.querySelector("summary")!.textContent).toContain("GHDL 语法与语义诊断 · 2 条");
  group.querySelector("summary")!.click();
  group.dispatchEvent(new Event("toggle"));
  const rows = group.querySelectorAll<HTMLButtonElement>(".problem-row");
  expect(rows[0].textContent).toContain('标识符 "duplicate_signal" 已被其他声明使用');
  expect(rows[1].textContent).toContain('未找到 "missing_signal" 的声明');
  expect(rows[1].title).toContain('原始诊断：error: no declaration for "missing_signal"');
  rows[1].click();
  expect(callbacks.onOpen).toHaveBeenCalledWith(external.diagnostics[1]);
  panel.finish({ ...external, diagnostics: [external.diagnostics[1]] });
  expect(group.open).toBe(true);
  expect(group.querySelector("summary")!.textContent).toContain('未找到 "missing_signal" 的声明 · 1 条');
});

it("补充源码解释后问题组及已展开明细更新为缺少实例名", () => {
  const { root, panel } = setup();
  const initial = result();
  initial.diagnostics = [{ ...initial.diagnostics[0], ruleId: "VERILATOR-GENERAL", message: "syntax error, unexpected '('" }];
  panel.finish(initial);
  const group = root.querySelector<HTMLDetailsElement>(".problem-error-group")!;
  group.querySelector("summary")!.click();
  group.dispatchEvent(new Event("toggle"));
  panel.finish({ ...initial, diagnostics: [{ ...initial.diagnostics[0], syntaxKind: "missing-instance-name" }] });
  expect(group.querySelector("summary")!.textContent).toContain("模块例化缺少实例名");
  expect(group.querySelector(".problem-row")!.textContent).toContain("模块例化缺少实例名");
});

it("后台进度、取消、定位和过期状态共用同一份诊断结果", () => {
  const { root, panel, callbacks } = setup();
  expect([...root.querySelectorAll("button")].some(button => button.textContent === "检查")).toBe(false);
  const progress = root.querySelector<HTMLProgressElement>(".problem-progress")!;
  const cancel = [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "取消")!;
  expect(progress.hidden).toBe(true);
  expect(cancel.hidden).toBe(true);
  panel.start();
  expect(progress.hidden).toBe(false);
  expect(cancel.hidden).toBe(false);
  expect(root.querySelector(".problem-summary")!.textContent).toContain("后台检查准备中");
  panel.update({ stage: "ghdl", file: "D:/project/b.sv", completed: 1, total: 2 });
  expect(progress.max).toBe(2);
  expect(progress.value).toBe(1);
  expect(root.querySelector(".problem-summary")!.textContent).toContain("GHDL 1/2");
  panel.finish(result());
  expect(progress.hidden).toBe(true);
  expect(cancel.hidden).toBe(true);
  expect(root.querySelectorAll(".problem-group")).toHaveLength(2);
  expect(root.querySelectorAll(".problem-row")).toHaveLength(0);
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 2/2 条");
  const errorGroup = root.querySelector<HTMLDetailsElement>(".problem-error-group")!;
  errorGroup.querySelector("summary")!.click();
  errorGroup.dispatchEvent(new Event("toggle"));
  (errorGroup.querySelector(".problem-row") as HTMLButtonElement).click();
  expect(callbacks.onOpen).toHaveBeenCalledWith(expect.objectContaining({ file: "D:/project/a.sv", line: 8 }));
  panel.markStale();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("等待自动复查");
  panel.start();
  cancel.click();
  expect(cancel.disabled).toBe(true);
  panel.finish({ ...result(), cancelled: true });
  expect(root.querySelector(".problem-summary")!.textContent).toContain("结果可能不完整");
  panel.start();
  panel.fail(new Error("backend unavailable"));
  expect(root.querySelector(".problem-summary")!.textContent).toContain("后端不可用");
  expect(root.querySelector(".problem-summary")!.textContent).not.toContain("backend unavailable");
  expect(root.querySelector<HTMLElement>(".problem-summary")!.title).toContain("backend unavailable");
  expect(progress.hidden).toBe(true);
});

it("外部诊断明细和提示使用中文，保留标识并支持中英文筛选", async () => {
  const { root, panel } = setup();
  const external = result();
  external.diagnostics = [
    { file: "D:/project/pins.sv", line: 8, column: 3, severity: "warning", ruleId: "VERILATOR-PINMISSING", source: "verilator", message: "Cell has missing pin: 'aclen'" },
    { file: "D:/project/missing.sv", line: 4, column: 3, severity: "error", ruleId: "VERILATOR-MODMISSING", source: "verilator", message: "Cannot find file containing module: 'missing'" },
    { file: "D:/project/consumer.vhd", line: 8, column: 12, severity: "error", ruleId: "GHDL", source: "ghdl", message: "error: unit \"fifo_256x8\" not found in library \"work\"" },
    { file: "D:/project/other.sv", line: 2, column: 1, severity: "warning", ruleId: "VERILATOR-OTHER", source: "verilator", message: "Unexpected token 'ready'" },
  ];
  panel.finish(external);
  for (const group of root.querySelectorAll<HTMLDetailsElement>(".problem-group")) {
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
  }
  const messages = [...root.querySelectorAll(".problem-message")].map(item => item.textContent);
  expect(messages).toEqual(expect.arrayContaining([
    "VERILATOR-PINMISSING · 例化缺少端口连接：'aclen'",
    "VERILATOR-MODMISSING · 缺少模块定义：'missing'",
    "GHDL · VHDL 库 \"work\" 中未找到单元 \"fifo_256x8\"",
    "VERILATOR-OTHER · 遇到意外标记：'ready'",
  ]));
  expect(root.textContent).not.toContain("Cell has missing pin");
  expect(root.textContent).not.toContain("Cannot find file containing module");
  expect(root.textContent).not.toContain("Unexpected token");
  const pinGroup = [...root.querySelectorAll<HTMLDetailsElement>(".problem-group")].find(group => group.title.includes("VERILATOR-PINMISSING"))!;
  expect(pinGroup.title).toContain("原始诊断：Cell has missing pin: 'aclen'");

  const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索规则或诊断"]')!;
  search.value = "例化缺少端口";
  search.dispatchEvent(new Event("input"));
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 4/4 条");
  await vi.waitFor(() => expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1/4 条"));
  search.value = "Cell has missing pin";
  search.dispatchEvent(new Event("input"));
  await vi.waitFor(() => expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1/4 条"));
  search.value = "aclen";
  search.dispatchEvent(new Event("input"));
  await vi.waitFor(() => expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1/4 条"));
});

it("GHDL 常见诊断显示具体原因，未识别消息明确标记未分类", () => {
  const { root, panel } = setup();
  const external = result();
  const ghdl = (file: string, message: string) => ({ file: `D:/project/${file}.vhd`, line: 2, column: 1, severity: "error" as const, ruleId: "GHDL", source: "ghdl" as const, message });
  external.diagnostics = [
    ghdl("syntax", "error: missing \";\" at end of statement"),
    ghdl("choices", "error: missing choice(s)"),
    ghdl("unknown", "error: no declaration for \"missing_name\""),
    ghdl("type", "error: can't match integer literal with type bit"),
    ghdl("input", "error: port \"a\" can't be assigned"),
    ghdl("duplicate", "error: identifier \"value\" already used for a declaration"),
    ghdl("previous", "error: previous declaration: signal \"value\""),
    ghdl("other", "error: custom analysis failure \"detail\""),
    { file: "D:/project/new.sv", line: 2, column: 1, severity: "warning", ruleId: "VERILATOR-NEW", source: "verilator", message: "New backend condition 'flag'" },
  ];
  panel.finish(external);
  for (const group of root.querySelectorAll<HTMLDetailsElement>(".problem-group")) {
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
  }
  const messages = [...root.querySelectorAll(".problem-message")].map(item => item.textContent);
  expect(messages).toEqual(expect.arrayContaining([
    "GHDL · 语句末尾缺少 \";\"",
    "GHDL · case 分支未覆盖全部可能取值",
    "GHDL · 未找到 \"missing_name\" 的声明",
    "GHDL · 值与类型 bit 不匹配",
    "GHDL · 端口 \"a\" 不可赋值",
    "GHDL · 标识符 \"value\" 已被其他声明使用",
    "GHDL · 此前声明：信号 \"value\"",
    "GHDL · 未分类诊断（悬停查看原文）：\"detail\"",
    "VERILATOR-NEW · Verilator 未分类诊断（悬停查看原文）：'flag'",
  ]));
  expect(root.textContent).not.toContain("语法或语义");
  expect(root.textContent).not.toContain("检查问题");
  expect(root.textContent).not.toContain("no declaration for");
  expect(root.textContent).not.toContain("can't be assigned");
  const unclassifiedGroup = [...root.querySelectorAll<HTMLDetailsElement>(".problem-group")].find(group => group.title.includes("custom analysis failure"));
  expect(unclassifiedGroup?.title).toContain("原始诊断：error: custom analysis failure");
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
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1/4 条");
  [...root.querySelectorAll("button")].find(button => button.textContent === "清除筛选")!.click();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 4/4 条");
  expect(panel.hasResults).toBe(true);
  panel.setDisplayFilter({ severity: "error", file: "D:/project/a.sv" });
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1/4 条");
});

it("所有诊断按规则折叠，黑盒提示独立折叠且错误按严重程度归组", () => {
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
  expect(infoGroup.querySelector("summary")!.textContent).toContain("a.sv");
  expect(infoGroup.querySelector("summary")!.textContent).not.toContain("D:/project");
  expect(infoGroup.title).toContain("D:/project/a.sv");
  expect(infoGroup.title).toContain("10157-A-1-1");
  const firstError = root.querySelector<HTMLDetailsElement>(".problem-error-group")!;
  firstError.querySelector("summary")!.click();
  firstError.dispatchEvent(new Event("toggle"));
  expect(firstError.querySelector(".problem-location")!.textContent).toBe("a.sv:8:3");
  expect([...root.querySelectorAll('select[aria-label="文件筛选"] option')].map(option => option.textContent)).not.toContain("D:/project/a.sv");
  expect(infoGroup.open).toBe(false);
  infoGroup.querySelector<HTMLButtonElement>(".problem-group-jump")!.click();
  expect(callbacks.onOpen).toHaveBeenCalledWith(expect.objectContaining({ file: "D:/project/a.sv", line: 3, column: 1 }));
  expect(infoGroup.open).toBe(false);
  expect(infoGroup.querySelector(".problem-row")).toBeNull();
  infoGroup.querySelector("summary")!.click();
  infoGroup.dispatchEvent(new Event("toggle"));
  expect(infoGroup.open).toBe(true);
  expect(infoGroup.querySelector(".problem-row")).not.toBeNull();
  expect(stubGroup.open).toBe(false);
  expect(stubGroup.textContent).toContain("黑盒／生成文件提示 · 1 条");
  stubGroup.querySelector("summary")!.click();
  stubGroup.dispatchEvent(new Event("toggle"));
  expect(stubGroup.querySelector("button")!.disabled).toBe(true);
  const stubErrorGroup = [...root.querySelectorAll<HTMLDetailsElement>(".problem-environment-group")].find(group => group.textContent?.includes("语法错误"))!;
  stubErrorGroup.querySelector("summary")!.click();
  stubErrorGroup.dispatchEvent(new Event("toggle"));
  expect(stubErrorGroup.textContent).toContain("语法错误");
  expect(stubErrorGroup.textContent).not.toContain("Bad stub");
  expect(stubErrorGroup).not.toBe(stubGroup);
});

it("内置分析完成即可导出，不依赖外部检查", () => {
  const { root, panel } = setup();
  const html = [...root.querySelectorAll("button")].find(button => button.textContent === "导出 HTML") as HTMLButtonElement;
  expect(html.disabled).toBe(true);
  panel.setBuiltins([], true, true);
  expect(html.disabled).toBe(true);
  panel.setBuiltins([], true, false);
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
  const configure = [...root.querySelectorAll("button")].find(button => button.textContent === "修复环境")!;
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

it("同规则大量警告按批创建并显示全部诊断，刷新保留已加载数量", () => {
  const { root, panel } = setup();
  const external = result();
  external.diagnostics = Array.from({ length: 1200 }, (_, index) => ({
    file: "D:/project/a.sv", line: index + 1, column: 1, severity: "warning", ruleId: "VERILATOR-WIDTH", source: "verilator", message: `warning ${index}`,
  }));
  panel.finish(external);
  const group = root.querySelector<HTMLDetailsElement>(".problem-warning-group")!;
  expect(group.open).toBe(false);
  expect(group.querySelector("summary")!.textContent).toContain("位宽不匹配");
  expect(group.querySelector("summary")!.textContent).toContain("1200 条");
  expect(group.querySelectorAll(".problem-row")).toHaveLength(0);
  expect(root.textContent).not.toContain("仅显示前");
  const createElement = document.createElement.bind(document);
  let createdButtons = 0;
  const elementSpy = vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    if (tagName === "button") createdButtons++;
    return createElement(tagName, options);
  }) as typeof document.createElement);
  group.querySelector("summary")!.click();
  group.dispatchEvent(new Event("toggle"));
  expect(group.querySelectorAll(".problem-row")).toHaveLength(500);
  expect(createdButtons).toBe(501);
  group.querySelector<HTMLButtonElement>(".problem-load-more")!.click();
  expect(group.querySelectorAll(".problem-row")).toHaveLength(1000);
  group.querySelector<HTMLButtonElement>(".problem-load-more")!.click();
  expect(group.querySelectorAll(".problem-row")).toHaveLength(1200);
  expect(group.querySelector(".problem-load-more")).toBeNull();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 1200/1200 条");
  expect(root.textContent).not.toContain("仅显示前");
  createdButtons = 0;
  panel.finish({ ...external, diagnostics: [...external.diagnostics, { file: "D:/project/a.sv", line: 1201, column: 1, severity: "warning", ruleId: "VERILATOR-WIDTH", source: "verilator", message: "warning 1200" }] });
  expect(createdButtons).toBe(1);
  expect(group.querySelectorAll(".problem-row")).toHaveLength(1200);
  expect(group.querySelector(".problem-load-more")!.textContent).toContain("剩余 1 条");
  group.querySelector<HTMLButtonElement>(".problem-load-more")!.click();
  expect(createdButtons).toBe(2);
  expect(group.querySelectorAll(".problem-row")).toHaveLength(1201);
  elementSpy.mockRestore();
});

it("刷新只更新变化分组并保留展开、滚动位置和焦点", () => {
  const { root, panel } = setup();
  panel.finish(result());
  const group = root.querySelector<HTMLDetailsElement>(".problem-error-group")!;
  group.querySelector("summary")!.click();
  group.dispatchEvent(new Event("toggle"));
  const list = root.querySelector<HTMLElement>(".problem-list")!;
  list.scrollTop = 120;
  const row = group.querySelector<HTMLButtonElement>(".problem-row")!;
  row.focus();
  expect(document.activeElement).toBe(row);
  panel.setBuiltins([builtin("VLG-ST-001", "style")]);
  expect(root.querySelector(".problem-error-group")).toBe(group);
  expect(group.open).toBe(true);
  expect(list.scrollTop).toBe(120);
  expect(document.activeElement).toBe(row);
  const external = result();
  external.diagnostics[0].message = "Changed width diagnostic";
  panel.finish(external);
  expect(root.querySelector(".problem-error-group")).toBe(group);
  expect(group.open).toBe(true);
  expect(list.scrollTop).toBe(120);
  expect(group.textContent).toContain("位宽不匹配");
  expect(group.textContent).not.toContain("Changed width diagnostic");
  expect(document.activeElement).toBe(group.querySelector(".problem-row"));
});

it("依赖环境、重名最短目录和工程级中文摘要清晰可辨", () => {
  const { root, panel } = setup();
  const external = result();
  external.diagnostics = [
    { file: "D:/p/project_2.srcs/sources_1/bd/design_1/hdl/design_1_wrapper.v", line: 1, column: 1, severity: "warning", ruleId: "VERILATOR-MODDUP", source: "verilator", message: "Duplicate declaration" },
    { file: "D:/p/HWDCMCS.srcs/sources_1/bd/design_1/hdl/design_1_wrapper.v", line: 1, column: 1, severity: "warning", ruleId: "VERILATOR-MODDUP", source: "verilator", message: "Duplicate declaration" },
    { file: "D:/p/consumer.vhd", line: 8, column: 12, severity: "error", ruleId: "GHDL", source: "ghdl", message: "error: unit \"fifo_256x8\" not found in library \"work\"" },
    { file: "D:/p/missing.v", line: 4, column: 3, severity: "error", ruleId: "VERILATOR-MODMISSING", source: "verilator", message: "Cannot find file containing module: 'missing'" },
    { file: "", line: 1, column: 1, severity: "error", ruleId: "VERILATOR", source: "verilator", message: "Exiting due to 2 error(s)" },
  ];
  panel.finish(external);
  const environments = [...root.querySelectorAll<HTMLDetailsElement>(".problem-environment-group")];
  expect(environments).toHaveLength(4);
  expect(environments[0].textContent).toContain("分析环境");
  const environmentText = environments.map(group => group.textContent).join("\n");
  expect(environmentText).toContain("project_2.srcs");
  expect(environmentText).toContain("HWDCMCS.srcs");
  expect(environmentText).toContain("VHDL 库 \"work\" 中未找到单元 \"fifo_256x8\"");
  expect(environmentText).toContain("缺少模块定义");
  expect(root.querySelector(".problem-error-group")).toBeNull();
  expect(root.textContent).not.toContain("Exiting due to");
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 4/4 条");
  const options = [...root.querySelectorAll('select[aria-label="文件筛选"] option')].map(option => option.textContent);
  expect(options.some(text => text?.includes("project_2.srcs"))).toBe(true);
  expect(options.some(text => text?.includes("HWDCMCS.srcs"))).toBe(true);
});

it("快捷严重程度筛选可切换，来源筛选默认折叠", () => {
  const { root, panel } = setup();
  panel.setBuiltins([builtin("VLG-ST-001", "style"), builtin("10157-A-1-1", "gjb10157")]);
  panel.finish(result());
  expect(root.querySelector<HTMLDetailsElement>(".problem-advanced-filters")!.open).toBe(false);
  const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "仅看错误和警告")!;
  toggle.click();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 2/4 条");
  const restore = [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "查看全部问题")!;
  restore.click();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("显示 4/4 条");
});


it("隐藏问题面板不重建结果，恢复显示时刷新最新诊断", () => {
  const { root, panel } = setup();
  root.hidden = true;
  panel.finish(result());
  expect(root.querySelector(".problem-group")).toBeNull();
  root.hidden = false;
  panel.refresh();
  expect(root.querySelector(".problem-summary")!.textContent).toContain("1 错误");
  expect(root.querySelectorAll(".problem-group").length).toBeGreaterThan(0);
});


it("顶部指示状态汇总诊断、运行、过期和失败", () => {
  const { panel, callbacks } = setup();
  const latest = () => callbacks.onIndicator.mock.calls.at(-1)?.[0];
  panel.setBuiltins([builtin("VLG-ST-001", "style"), builtin("10157-A-1-1", "gjb10157")], true, false);
  expect(latest()).toMatchObject({ running: false, errors: 0, warnings: 0, infos: 2, stale: false, failed: false });
  panel.start();
  expect(latest()).toMatchObject({ running: true });
  panel.finish(result());
  expect(latest()).toMatchObject({ running: false, errors: 1, warnings: 1, infos: 2 });
  panel.markStale();
  expect(latest()).toMatchObject({ stale: true });
  panel.fail(new Error("backend unavailable"));
  expect(latest()).toMatchObject({ running: false, failed: true });
});


it("面板隐藏时仍向顶部按钮推送检查结果", () => {
  const { root, panel, callbacks } = setup();
  root.hidden = true;
  panel.finish(result());
  expect(callbacks.onIndicator).toHaveBeenCalledWith(expect.objectContaining({ errors: 1, warnings: 1, running: false }));
});
