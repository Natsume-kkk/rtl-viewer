// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SignalProject, traceSignal, type TraceNode } from "../src/analysis/signal-flow";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import { closeCtxMenu } from "../src/ui/menu";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); closeCtxMenu(); vi.restoreAllMocks(); });
const use = (path: string, line: number): TraceNode => ({label: "q ← i", owner: path, file: "leaf.sv", line, reason: "赋值位置", statement: "assign q = i;", children: []});
const module = (name: string, children?: TraceNode[], type = name): TraceNode => ({
  label: `top/${name}.i`, port: {path: `top/${name}`, name: "i", direction: "input"}, module: {name: type}, file: "top.sv", line: 3,
  children: children ?? [use(`top/${name}`, 8)],
});
const setup = (nodes: TraceNode[]) => {
  const root = document.createElement("aside"), navigate = vi.fn(); document.body.append(root);
  const panel = new SignalFlowPanel(root, {close() {}, context() {}, navigate});
  panel.result("i", {label: "top.i", children: []}, {label: "top.i", children: nodes}, "");
  cleanups.push(() => { panel.message(""); root.remove(); });
  return {root, panel, navigate, body: root.querySelector<HTMLElement>(".flow-body")!};
};
const card = (root: HTMLElement, path: string) => [...root.querySelectorAll<HTMLElement>(".module-summary")].find(card => card.getAttribute("aria-label") === path)!;
const fold = (card: HTMLElement) => card.querySelector<HTMLButtonElement>(".port-fold-toggle")!;
const only = (card: HTMLElement) => card.querySelector<HTMLButtonElement>(".only-module-toggle")!;
const textButton = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
const shown = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".logic-card")].filter(card => !card.hidden);

it("少量模块默认展开，多模块默认摘要，整行折叠与源码定位互不干扰", () => {
  const small = setup([module("u"), module("v")]);
  expect(shown(small.root).filter(card => card.querySelector(".assignment-context"))).toHaveLength(2);
  const {root, navigate} = setup([module("u"), module("v"), module("w")]);
  const u = card(root, "top/u");
  expect(shown(root)).toHaveLength(4);
  expect(root.querySelector(".assignment-context")).toBeNull();
  u.querySelector<HTMLButtonElement>(".source-jump")!.click();
  expect(navigate).toHaveBeenCalledWith("top.sv", 3);
  expect(fold(u).getAttribute("aria-expanded")).toBe("false");
  u.querySelector<HTMLElement>(".operation-name")!.click();
  expect(fold(u).getAttribute("aria-expanded")).toBe("true");
  expect(shown(root).filter(card => card.querySelector(".assignment-context"))).toHaveLength(1);
  u.querySelector<HTMLElement>(".logic-card-head")!.click();
  expect(shown(root)).toHaveLength(4);
  expect(root.querySelector(".flow-selected")!.textContent).toBe("i");
});

it("只看切换同级实例后取消，准确恢复展开、滚动和原选择", () => {
  const {root, panel, body} = setup([module("u"), module("v"), module("w")]);
  const u = card(root, "top/u"); fold(u).click();
  body.scrollLeft = 170; body.scrollTop = 31;
  const before = panel.capture(); only(u).click();
  expect(root.querySelector<HTMLElement>(".port-selection-actions")!.hidden).toBe(true);
  expect(root.querySelector(".port-view-count")!.textContent).toContain("当前范围 1 处位置／全部 3 处");
  expect(root.querySelector<HTMLButtonElement>(".port-previous-instance")!.disabled).toBe(true);
  const select = root.querySelector<HTMLSelectElement>(".port-instance-switcher select")!;
  select.value = [...select.options][1].value; select.dispatchEvent(new Event("change"));
  expect(only(card(root, "top/v")).getAttribute("aria-pressed")).toBe("true");
  only(card(root, "top/v")).click();
  const restored = panel.capture();
  expect(restored.ports?.expanded).toEqual(before.ports?.expanded);
  expect(restored.ports?.selected).toBe(before.ports?.selected);
  expect([restored.left, restored.top]).toEqual([170, 31]);
  expect(card(root, "top/w").hidden).toBe(false);
});

it("只看保留模块路径，全部收起不丢失目标，展开本层一次仅开一层", () => {
  const nested = module("wrap", [module("wrap/rx"), module("wrap/tx")]);
  const {root} = setup([nested, module("v"), module("w")]);
  textButton(root, "展开本层").click();
  const rx = card(root, "top/wrap/rx");
  expect(rx.hidden).toBe(false);
  expect(fold(rx).getAttribute("aria-expanded")).toBe("false");
  only(rx).click();
  expect(card(root, "top/wrap").hidden).toBe(false);
  expect(card(root, "top/v").hidden).toBe(true);
  textButton(root, "全部收起").click();
  expect(rx.hidden).toBe(false);
  expect(fold(rx).getAttribute("aria-expanded")).toBe("false");
  textButton(root, "展开本层").click();
  expect(fold(rx).getAttribute("aria-expanded")).toBe("true");
  expect(textButton(root, "展开本层").disabled).toBe(true);
});

it("只看同一实例涵盖多个端口，汇合赋值仍只显示一次", async () => {
  const project = new SignalProject(new Map([["t.v", "module top(input a); leaf u(.i(a),.j(a)); leaf v(.i(a),.j(a)); endmodule module leaf(input i,j); wire q; assign q=i|j; endmodule"]]));
  const trace = await traceSignal(project, project.root("top")!, "a", "downstream", {stopAtAssignments: true});
  const {root} = setup(trace.children);
  const ports = [...root.querySelectorAll<HTMLElement>('.module-summary[aria-label="top/u"]')];
  only(ports[1]).click();
  expect(shown(root).filter(card => card.classList.contains("module-summary"))).toHaveLength(2);
  expect(shown(root).filter(card => card.querySelector(".assignment-context"))).toHaveLength(1);
  expect(root.querySelectorAll('.only-module-toggle[aria-pressed="true"]')).toHaveLength(2);
  const assignment = shown(root).find(card => card.querySelector(".assignment-context"))!;
  expect([...root.querySelectorAll<SVGElement>(".logic-wire")].filter(edge => edge.dataset.to === assignment.dataset.node)).toHaveLength(2);
  expect(root.querySelector<HTMLSelectElement>(".port-instance-switcher select")!.options).toHaveLength(2);
  const select = root.querySelector<HTMLSelectElement>(".port-instance-switcher select")!;
  select.dispatchEvent(new Event("change"));
  expect(root.querySelectorAll('.only-module-toggle[aria-pressed="true"]')).toHaveLength(2);
  textButton(root, "显示全部").click();
  root.querySelector<HTMLButtonElement>(".port-view-more")!.click();
  document.querySelector<HTMLButtonElement>(".ctx-menu button")!.click();
  ports[0].click(); textButton(root, "收起其他").click();
  expect(ports.every(card => fold(card).getAttribute("aria-expanded") === "true")).toBe(true);
  expect([...root.querySelectorAll<HTMLElement>('.module-summary[aria-label="top/v"]')].every(card => fold(card).getAttribute("aria-expanded") === "false")).toBe(true);
});

it("重复实例按已知模块分组，展开不预建终点，筛选与只看相互独立并可恢复", () => {
  const nodes = Array.from({length: 32}, (_, i) => ({...module(`g[${i}].u`, undefined, "fifo"), module: {name: "fifo", parameters: `DEPTH=${i < 16 ? 16 : 32}`}}));
  const {root, panel} = setup(nodes);
  const group = root.querySelector<HTMLElement>(".repeated-summary")!;
  expect(shown(root)).toHaveLength(2);
  expect(group.textContent).toContain("DEPTH=16 × 16");
  expect(root.querySelector(".assignment-context")).toBeNull();
  fold(group).click();
  expect(shown(root).filter(card => card.classList.contains("module-summary"))).toHaveLength(32);
  expect(root.querySelector(".assignment-context")).toBeNull();
  const input = group.querySelector<HTMLInputElement>("input")!;
  input.value = "DEPTH=32"; input.form!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
  expect(group.querySelector(".port-filter-count")!.textContent).toBe("显示 16 / 32 个实例");
  const before = panel.capture(); only(card(root, "top/g[16].u")).click();
  expect(root.querySelector<HTMLSelectElement>(".port-instance-switcher select")!.options).toHaveLength(16);
  textButton(root, "显示全部").click();
  expect(panel.capture().ports?.filters).toEqual(before.ports?.filters);
  expect(shown(root).filter(card => card.classList.contains("module-summary"))).toHaveLength(16);
  expect(panel.capture().ports?.expanded).toEqual(before.ports?.expanded);
});

it("未知模块不猜测分组，分析受限不当作零使用，无效筛选可清空恢复", () => {
  const nodes = [module("u", [], "one"), module("v", [], "two"), {...module("ip", [], "vendor"), reason: "黑盒或缺失定义，无法展开内部实现"}];
  const {root} = setup(nodes);
  only(card(root, "top/ip")).click();
  expect(root.querySelector(".port-view-count")!.textContent).toContain("含分析边界");
  expect(root.querySelector(".repeated-summary")).toBeNull();
  const repeated = setup(Array.from({length: 3}, (_, i) => module(`u${i}`, undefined, "fifo")));
  const group = repeated.root.querySelector<HTMLElement>(".repeated-summary")!; fold(group).click();
  const input = group.querySelector<HTMLInputElement>("input")!;
  input.value = "missing"; input.form!.dispatchEvent(new Event("submit", {cancelable: true}));
  expect(group.querySelector(".port-filter-count")!.textContent).toBe("显示 0 / 3 个实例");
  input.value = ""; input.form!.dispatchEvent(new Event("submit", {cancelable: true}));
  expect(group.querySelector(".port-filter-count")!.textContent).toBe("显示 3 / 3 个实例");
});

it("同实例的多个重复端口组不重复平移共享赋值，只看跨组保留所有端口", () => {
  const nodes = Array.from({length: 3}, (_, i) => {
    const shared = use(`top/u${i}`, 8);
    const first = module(`u${i}`, [shared], "fifo");
    const second = {...first, label: `top/u${i}.j`, port: {...first.port!, name: "j"}};
    return [first, second];
  }).flat();
  const {root, panel} = setup(nodes);
  expect(root.querySelectorAll(".repeated-summary")).toHaveLength(2);
  root.querySelector<HTMLButtonElement>(".port-view-more")!.click();
  document.querySelector<HTMLButtonElement>(".ctx-menu button")!.click();
  const sites = shown(root).filter(card => card.querySelector(".assignment-context"));
  expect(sites).toHaveLength(3);
  const columns = [...new Set(shown(root).map(card => parseFloat(card.style.left)))].sort((a, b) => a - b);
  expect(columns).toEqual([24, 300, 576, 852]);
  const groups = [...root.querySelectorAll<HTMLElement>(".repeated-summary")];
  const input = groups[1].querySelector<HTMLInputElement>("input")!;
  input.value = "u1"; input.form!.dispatchEvent(new Event("submit", {cancelable: true}));
  const before = panel.capture(); only(card(root, "top/u0")).click();
  expect(shown(root).filter(card => card.classList.contains("module-summary"))).toHaveLength(2);
  expect(root.querySelector(".port-view-count")!.textContent).toContain("当前范围 1 处位置／全部 3 处");
  textButton(root, "显示全部").click();
  expect(panel.capture().ports?.filters).toEqual(before.ports?.filters);
});

it("多种参数覆盖只显示简短摘要，完整分组原文可通过悬停查看", () => {
  const {root} = setup(Array.from({length: 5}, (_, i) => ({...module(`u${i}`, undefined, "fifo"), module: {name: "fifo", parameters: `N=${i}`}})));
  const summary = root.querySelector<HTMLElement>(".port-parameter-summary")!;
  expect(summary.textContent).toBe("N=0 × 1 · N=1 × 1 · 另 3 组参数");
  expect(summary.title).toContain("N=4 × 1");
});

it("重建视图后恢复只看状态，刷新仅沿用宽度，清理移除视图操作栏", () => {
  const nodes = [module("u"), module("v"), module("w")];
  const {root, panel} = setup(nodes);
  fold(card(root, "top/u")).click(); only(card(root, "top/v")).click();
  const saved = panel.capture();
  panel.result("i", {label: "top.i", children: []}, {label: "top.i", children: nodes}, ""); panel.restore(saved);
  expect(only(card(root, "top/v")).getAttribute("aria-pressed")).toBe("true");
  textButton(root, "显示全部").click();
  expect(fold(card(root, "top/u")).getAttribute("aria-expanded")).toBe("true");
  only(card(root, "top/v")).click();
  panel.result("i", {label: "top.i", children: []}, {label: "top.i", children: nodes}, "", "端口连接", true);
  expect(panel.capture().ports?.only).toBeUndefined();
  expect(root.querySelectorAll(".port-view-context")).toHaveLength(1);
  panel.message("分析中"); expect(root.querySelector(".port-view-context")).toBeNull();
});

it("菜单在只看时不提供收起其他，方向键和 Escape 可访问并恢复焦点", () => {
  const {root} = setup([module("u"), module("v"), module("w")]);
  const u = card(root, "top/u"), trigger = u.querySelector<HTMLButtonElement>(".port-module-more")!;
  only(u).click(); trigger.click();
  expect(document.querySelector(".ctx-menu")!.textContent).not.toContain("收起其他");
  expect(document.querySelector(".ctx-menu")!.contains(document.activeElement)).toBe(true);
  document.dispatchEvent(new KeyboardEvent("keydown", {key: "End", bubbles: true, cancelable: true}));
  expect(document.activeElement?.textContent).toBe("显示全部模块");
  document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
  expect(document.querySelector(".ctx-menu")).toBeNull(); expect(document.activeElement).toBe(trigger);
  textButton(root, "显示全部").click();
  fold(card(root, "top/v")).click();
  u.click(); textButton(root, "收起其他").click();
  expect(fold(u).getAttribute("aria-expanded")).toBe("true");
  expect(fold(card(root, "top/v")).getAttribute("aria-expanded")).toBe("false");
  expect(card(root, "top/w").hidden).toBe(false);
});

it("真实 Verilog 参数实例元数据保留覆盖原文，VHDL 复用实例同样可折叠", async () => {
  const project = new SignalProject(new Map([["t.v", "module top(input a); leaf #(.N(8)) u(.i(a)); leaf #(.N(16)) v(.i(a)); endmodule module leaf #(parameter N=4)(input i); wire q; assign q=i; endmodule"]]));
  const trace = await traceSignal(project, project.root("top")!, "a", "downstream", {stopAtAssignments: true});
  expect(trace.children.map(node => node.module)).toEqual([{name: "leaf", parameters: "N=8"}, {name: "leaf", parameters: "N=16"}]);
  const vhdl = new SignalProject(new Map([["t.vhd", `entity top is port(a: in bit); end top;
architecture rtl of top is begin u: entity work.leaf port map(i=>a); v: entity work.leaf port map(i=>a); end rtl;
entity leaf is port(i: in bit); end leaf; architecture rtl of leaf is signal q: bit; begin q<=i; end rtl;`]]));
  const down = await traceSignal(vhdl, vhdl.root("top")!, "a", "downstream", {stopAtAssignments: true});
  const {root} = setup(down.children); only(card(root, "top/u")).click();
  expect(shown(root).filter(card => card.classList.contains("module-summary"))).toHaveLength(1);
  expect(root.querySelector(".assignment-context")!.textContent).toBe("top/u");
});
