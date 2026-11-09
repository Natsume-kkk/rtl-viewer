// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { BottomPanels } from "../src/ui/bottom-panels";
import { StatsPanel } from "../src/ui/stats";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup(height = 710, width = 1000) {
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {} disconnect = disconnect;
  });
  document.body.innerHTML = '<div id="workspace"><section id="panels" hidden><div><section id="search" hidden><input value="clk"><p>已完成结果</p></section><aside id="flow" hidden><p>top/u0.clk</p></aside><section id="problems" hidden><p>语法问题</p></section><section id="stats" hidden><p>工程统计</p></section></div></section></div>';
  const workspace = document.getElementById("workspace")!, root = document.getElementById("panels")!;
  Object.defineProperty(workspace, "clientHeight", { get: () => height });
  Object.defineProperty(workspace, "clientWidth", { get: () => width });
  Object.defineProperty(root, "clientHeight", { get: () => Number.parseFloat(root.style.height) || 0 });
  const search = document.getElementById("search")!, flow = document.getElementById("flow")!, problems = document.getElementById("problems")!, stats = document.getElementById("stats")!;
  const changed = vi.fn();
  const activated: string[] = [];
  const panels = new BottomPanels(root, { search, flow, problems, stats }, changed, panel => activated.push(panel));
  cleanup.push(() => panels.dispose());
  const share = [...root.querySelectorAll("button")].find(button => button.textContent === "同时查看")!;
  return { panels, root, search, flow, problems, share, changed, activated, disconnect, resize: (next: number, nextWidth = width) => { height = next; width = nextWidth; resized(); } };
}

it("默认切换保留查询、追踪节点与滚动状态，收起后可重新打开", () => {
  const { panels, root, search, flow } = setup();
  panels.show("search");
  const input = search.querySelector("input")!;
  input.focus(); search.scrollTop = 80;
  panels.show("flow");
  expect(search.hidden).toBe(true); expect(flow.hidden).toBe(false);
  expect(search.contains(document.activeElement)).toBe(false);
  panels.show("search");
  expect(search.querySelector("input")).toBe(input);
  expect(input.value).toBe("clk"); expect(search.scrollTop).toBe(80);
  expect(flow.textContent).toBe("top/u0.clk");
  panels.hide("search"); expect(panels.isVisible("flow")).toBe(true);
  panels.hide("flow"); expect(root.hidden).toBe(true);
  panels.show("search"); expect(input.value).toBe("clk");
});

it("显式共存保护编辑区，缩窗退回切换并在放大后恢复偏好", () => {
  const { panels, root, search, flow, share, resize } = setup();
  panels.show("flow"); share.click();
  expect(search.hidden || flow.hidden).toBe(false);
  expect(710 - root.clientHeight).toBeGreaterThanOrEqual(320);
  resize(500);
  expect(search.hidden).toBe(true); expect(flow.hidden).toBe(false);
  expect(root.textContent).toContain("空间不足，暂用切换");
  expect(500 - root.clientHeight).toBeGreaterThanOrEqual(275);
  expect(share.getAttribute("aria-pressed")).toBe("false");
  resize(710);
  expect(search.hidden || flow.hidden).toBe(false);
  share.click(); expect(search.hidden).toBe(true);
});

it("键盘调整受空间上限约束，Home 恢复，销毁解除观察与键盘行为", () => {
  const { panels, root, disconnect } = setup(); panels.show("search");
  const resize = root.querySelector<HTMLElement>('[role="separator"]')!;
  for (let i = 0; i < 20; i++) resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  expect(root.clientHeight).toBe(390);
  resize.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" })); expect(root.clientHeight).toBe(380);
  panels.dispose(); expect(disconnect).toHaveBeenCalledOnce();
  resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" })); expect(root.clientHeight).toBe(380);
});

it("共存同时考虑宽度，退回时保留查询和偏好，不把未显示的面板标为按下", () => {
  const { panels, root, search, flow, share, resize } = setup();
  panels.show("flow"); share.click();
  const input = search.querySelector("input")!;
  input.focus();
  resize(710, 650);
  expect(root.classList.contains("panels-together")).toBe(false);
  expect(search.hidden).toBe(true); expect(flow.hidden).toBe(false);
  expect(search.contains(document.activeElement)).toBe(false);
  expect(input.value).toBe("clk");
  resize(710, 1000);
  expect(root.classList.contains("panels-together")).toBe(true);
  expect(search.querySelector("input")).toBe(input);
});

it("展开、恢复和关闭保留面板内容与原高度，并在全部收起后恢复编辑区", () => {
  const { panels, root, flow } = setup(); panels.show("flow");
  const expand = root.querySelector<HTMLButtonElement>('[aria-label="展开底部面板"]')!;
  const original = flow.firstChild;
  flow.scrollTop = 90;
  expand.click();
  expect(root.clientHeight).toBe(710);
  expect(root.parentElement!.classList.contains("panels-expanded")).toBe(true);
  expect(root.querySelector<HTMLElement>('[role="separator"]')!.hidden).toBe(true);
  panels.restoreEditor();
  expect(root.clientHeight).toBe(380); expect(flow.firstChild).toBe(original); expect(flow.scrollTop).toBe(90);
  expand.click(); panels.hide("flow");
  expect(root.parentElement!.classList.contains("panels-expanded")).toBe(false);
  panels.show("flow"); expect(root.clientHeight).toBe(380);
});

it("合并标题沿用原按钮事件，切换后焦点不留在隐藏标题，销毁归还标题", () => {
  const { panels, root, flow } = setup();
  const header = document.createElement("div"), action = document.createElement("button"), clicked = vi.fn();
  action.onclick = clicked; header.append(action); flow.prepend(header);
  panels.attachFlowHeader(header); panels.show("flow");
  expect(root.querySelector(".bottom-panel-header")!.contains(header)).toBe(true);
  action.click(); expect(clicked).toHaveBeenCalledOnce(); action.focus(); panels.show("search");
  expect(root.querySelector<HTMLElement>(".bottom-panel-header")!.hidden).toBe(true);
  expect(document.activeElement).not.toBe(action);
  panels.show("flow"); expect(root.querySelector<HTMLElement>(".bottom-panel-header")!.hidden).toBe(false);
  panels.dispose(); expect(flow.firstChild).toBe(header);
});

it("问题、统计及其他面板可按当前与上一面板组合查看", () => {
  const { panels, search, flow, problems, share } = setup();
  panels.show("problems");
  expect(share.disabled).toBe(false);
  share.click();
  expect(problems.hidden).toBe(false);
  expect(document.getElementById("stats")!.hidden).toBe(false);
  panels.show("stats");
  expect(document.getElementById("stats")!.hidden).toBe(false);
  expect(problems.hidden).toBe(false);
  share.click();
  expect(document.getElementById("stats")!.hidden).toBe(false);
  expect(problems.hidden).toBe(true);
  panels.show("flow"); share.click();
  expect(search.hidden).toBe(false); expect(flow.hidden).toBe(false);
});


it("底部标签激活真实统计面板时刷新隐藏期间的数据", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="workspace"><section id="panels" hidden><div><section id="search" hidden></section><aside id="flow" hidden></aside><section id="problems" hidden></section><section id="stats" hidden></section></div></section></div>';
  const workspace = document.getElementById("workspace")!, root = document.getElementById("panels")!;
  Object.defineProperty(workspace, "clientHeight", { get: () => 710 });
  Object.defineProperty(workspace, "clientWidth", { get: () => 1000 });
  Object.defineProperty(root, "clientHeight", { get: () => Number.parseFloat(root.style.height) || 0 });
  const stats = document.getElementById("stats")!;
  const view = new StatsPanel(stats, {
    displayPath: file => file,
    onOpenFile: () => {}, onOpenProblems: () => {}, onScopeChange: () => {}, onClose: () => {},
  });
  view.render({ facts: [], files: [], diagnostics: [], done: 0, total: 0, running: false, stale: false, scope: "top" });
  expect(stats.querySelector(".stats-summary")!.textContent).toBe("");
  const activated: string[] = [];
  const panels = new BottomPanels(root, {
    search: document.getElementById("search")!, flow: document.getElementById("flow")!,
    problems: document.getElementById("problems")!, stats,
  }, () => {}, id => { activated.push(id); if (id === "stats") view.refresh(); });
  cleanup.push(() => panels.dispose());
  root.querySelector<HTMLButtonElement>('button[aria-controls="stats"]')!.click();
  expect(activated).toEqual(["stats"]);
  expect(stats.querySelector(".stats-summary")!.textContent).toContain("HDL 文件 0");
  expect(stats.querySelector(".stats-table")!.textContent).toContain("合计");
});
