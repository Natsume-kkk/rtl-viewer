// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SignalProject } from "../src/analysis/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic, loadPortSites } from "../src/analysis/local";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import { closeCtxMenu } from "../src/ui/menu";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); closeCtxMenu(); });
async function setup(source: string, signal = "q", file = "t.v") {
  const files = new Map([[file, source]]), project = new SignalProject(files), context = project.root("top")!;
  const graph = localLogic(new ComputationProject(files, project), project, context, signal);
  await loadPortSites(graph, project, () => false);
  const root = document.createElement("aside"), navigate = vi.fn(); document.body.append(root);
  const panel = new SignalFlowPanel(root, {close() {}, context() {}, navigate}); panel.logicResult(signal, context, graph, files, "");
  cleanups.push(() => { panel.message(""); root.remove(); });
  return {root, panel, graph, context, files, navigate, body: root.querySelector<HTMLElement>(".flow-body")!};
}
const instance = (root: HTMLElement, path: string) => [...root.querySelectorAll<HTMLElement>(".module-summary")].find(card => card.getAttribute("aria-label") === path)!;
const fold = (card: HTMLElement) => card.querySelector<HTMLButtonElement>(".port-fold-toggle")!;
const only = (card: HTMLElement) => card.querySelector<HTMLButtonElement>(".only-module-toggle")!;
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!;
const visibleModules = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".module-summary")].filter(card => !card.hidden);
const leaf = "module leaf(input i,clk); reg z; always @(posedge clk) z<=i; endmodule";
const array = (n: number) => "module top(input a,clk); wire q=a; " + Array.from({length: n}, (_, i) => `leaf u${i}(.i(q),.clk(clk));`).join(" ") + " endmodule " + leaf;

it("32 路内部信号引用先显示摘要，逐层展开不预建源码，选择实例后才创建片段", async () => {
  const {root, graph} = await setup(array(32));
  const group = root.querySelector<HTMLElement>(".repeated-summary")!;
  expect(group.textContent).toContain("leaf · 32 个实例"); expect(visibleModules(root)).toHaveLength(0);
  expect(root.querySelector(".port-site")).toBeNull();
  expect(root.querySelector(".flow-selected")!.textContent).toBe("q");
  button(root, "展开本层").click();
  expect(visibleModules(root)).toHaveLength(32); expect(root.querySelector(".port-site")).toBeNull();
  const u = instance(root, "top/u0"); fold(u).click();
  expect(root.querySelectorAll(".port-site")).toHaveLength(1);
  expect(u.textContent).toMatch(/z\s*<=\s*i;/);
  expect(graph.nodes.some(node => node.signal === "z")).toBe(false);
  expect(graph.nodes.filter(node => node.port)).toHaveLength(32);
  expect(parseFloat(u.style.left)).toBeGreaterThan(parseFloat(group.style.left));
  expect([...root.querySelectorAll<SVGElement>(".logic-wire")].some(edge => edge.dataset.from === group.dataset.node && edge.dataset.to === u.dataset.node)).toBe(true);
});

it("内部只看切换实例，取消恢复分组、过程块、筛选和视口，后续首次源码仍默认展开", async () => {
  const {root, panel, body} = await setup(array(4));
  const group = root.querySelector<HTMLElement>(".repeated-summary")!; fold(group).click();
  const input = group.querySelector<HTMLInputElement>("input")!;
  input.value = "u"; input.form!.dispatchEvent(new Event("submit", {cancelable: true}));
  fold(instance(root, "top/u1")).click(); instance(root, "top/u1").querySelector<HTMLDetailsElement>(".assignment-block")!.open = false;
  body.scrollLeft = 155; body.scrollTop = 37; const before = panel.capture();
  only(instance(root, "top/u0")).click();
  expect(visibleModules(root)).toHaveLength(1); expect(root.querySelector<HTMLElement>(".port-selection-actions")!.hidden).toBe(true);
  expect(root.querySelector(".port-view-count")!.textContent).toBe("当前范围 1 个实例／全部 4 个");
  const select = root.querySelector<HTMLSelectElement>(".port-instance-switcher select")!;
  select.value = [...select.options][2].value; select.dispatchEvent(new Event("change"));
  expect(only(instance(root, "top/u2")).getAttribute("aria-pressed")).toBe("true");
  expect(root.querySelector(".port-view-count")!.textContent).toBe("当前范围 1 个实例／全部 4 个");
  button(root, "显示全部").click();
  const after = panel.capture();
  expect(after.logic?.modules?.expanded).toEqual(before.logic?.modules?.expanded);
  expect(after.logic?.modules?.filters).toEqual(before.logic?.modules?.filters);
  expect(after.logic?.open).toEqual(before.logic?.open); expect(after.logic?.routes).toEqual(before.logic?.routes);
  expect([after.left, after.top]).toEqual([155, 37]);
  fold(instance(root, "top/u0")).click();
  expect(instance(root, "top/u0").querySelector<HTMLDetailsElement>(".assignment-block")!.open).toBe(true);
  expect(instance(root, "top/u1").querySelector<HTMLDetailsElement>(".assignment-block")!.open).toBe(false);
});

it("同实例多端口一并只看，其他模块收起不隐藏摘要，标题与定位独立", async () => {
  const {root, navigate} = await setup("module top(input a,clk); wire q=a; leaf u(.i(q),.j(q),.clk(clk)); leaf v(.i(q),.j(q),.clk(clk)); endmodule module leaf(input i,j,clk); reg z; always @(posedge clk) z<=i|j; endmodule");
  const u = instance(root, "top/u");
  expect(visibleModules(root)).toHaveLength(4);
  const expanded = fold(u).getAttribute("aria-expanded"); u.querySelector<HTMLButtonElement>(".source-jump")!.click();
  expect(navigate).toHaveBeenCalled(); expect(fold(u).getAttribute("aria-expanded")).toBe(expanded);
  only(u).click();
  expect(visibleModules(root)).toHaveLength(2); expect(root.querySelectorAll('.only-module-toggle[aria-pressed="true"]')).toHaveLength(2);
  only(u).click(); u.click(); button(root, "收起其他").click();
  const v = [...root.querySelectorAll<HTMLElement>('.module-summary[aria-label="top/v"]')];
  expect(v.every(card => !card.hidden && fold(card).getAttribute("aria-expanded") === "false")).toBe(true);
});

it("只看时保留条件路径，全部收起后目标仍可见，恢复保留原分支状态", async () => {
  const {root, panel} = await setup("module top(input a,b,sel); reg q; always @* if(sel) q=a; else q=b; leaf u(.i(q)); endmodule module leaf(input i); wire z; assign z=i; endmodule");
  root.querySelector<HTMLElement>('[data-node="q"] summary')!.click();
  const before = panel.capture(); const u = instance(root, "top/u"); expect(u.hidden).toBe(false);
  only(u).click(); button(root, "全部收起").click(); expect(u.hidden).toBe(false);
  button(root, "显示全部").click(); expect(panel.capture().logic?.open).toEqual(before.logic?.open);
});

it("上下游角色不同的实例不误分组，未知方向保留分析边界和无箭头连线", async () => {
  const {root} = await setup("module top; wire q; missing u(.i(q)); endmodule");
  const u = instance(root, "top/u"); expect(u.textContent).toContain("黑盒或缺失定义");
  expect(root.querySelector(".repeated-summary")).toBeNull(); only(u).click();
  const edges = [...root.querySelectorAll<SVGElement>(".logic-wire")].filter(edge => edge.dataset.from === u.dataset.node || edge.dataset.to === u.dataset.node);
  expect(edges).toHaveLength(1);
  expect(root.querySelector(`.logic-arrow[data-from="${u.dataset.node}"],.logic-arrow[data-to="${u.dataset.node}"]`)).toBeNull();
});

it("输出端口分组沿真实方向连接，筛选无结果仍可恢复", async () => {
  const {root} = await setup("module top; wire q; driver u(.o(q)); driver v(.o(q)); driver w(.o(q)); endmodule module driver(output o); assign o=1'b0; endmodule");
  const group = root.querySelector<HTMLElement>(".repeated-summary")!; fold(group).click();
  const u = instance(root, "top/u");
  expect(parseFloat(u.style.left)).toBeLessThan(parseFloat(group.style.left));
  expect([...root.querySelectorAll<SVGElement>(".logic-wire")].some(edge => edge.dataset.from === u.dataset.node && edge.dataset.to === group.dataset.node)).toBe(true);
  only(u).click(); expect(visibleModules(root)).toHaveLength(1);
  button(root, "显示全部").click();
  const input = group.querySelector<HTMLInputElement>("input")!; input.value = "missing"; input.form!.dispatchEvent(new Event("submit", {cancelable: true}));
  expect(visibleModules(root)).toHaveLength(0); expect(group.hidden).toBe(false);
  input.value = ""; input.form!.dispatchEvent(new Event("submit", {cancelable: true})); expect(visibleModules(root)).toHaveLength(3);
});

it("内部模块没有后续引用时保留终点提示，不提供无效的折叠入口", async () => {
  const {root} = await setup("module top(input [7:0] a); wire [7:0] q=a; leaf u(.i(q[3:0])); leaf v(.i(q[3:0])); leaf w(.i(q[3:0])); endmodule module leaf(input [3:0] i); endmodule");
  fold(root.querySelector<HTMLElement>(".repeated-summary")!).click();
  const u = instance(root, "top/u");
  expect(u.querySelector(".port-fold-toggle")).toBeNull();
  expect(u.querySelector<HTMLElement>(".logic-module-content")!.hidden).toBe(false);
  expect(u.textContent).toContain("无后续引用"); expect(u.querySelector(".port-mapping")!.textContent).toBe(".i(q[3:0])");
});

it("VHDL 内部信号可只看，重建恢复源码和模块状态，同目标刷新仅继承宽度", async () => {
  const data = await setup(`entity top is port(a: in bit); end top; architecture rtl of top is signal q: bit; begin q<=a;
u: entity work.leaf port map(i=>q); v: entity work.leaf port map(i=>q); end rtl;
entity leaf is port(i: in bit); end leaf; architecture rtl of leaf is signal z: bit; begin z<=i; end rtl;`, "q", "t.vhd");
  const {root, panel, context, graph, files} = data; only(instance(root, "top/u")).click();
  const before = panel.capture();
  panel.logicResult("q", context, graph, files, ""); panel.restore(before);
  expect(only(instance(root, "top/u")).getAttribute("aria-pressed")).toBe("true");
  button(root, "显示全部").click(); expect(visibleModules(root)).toHaveLength(2);
  only(instance(root, "top/u")).click(); panel.logicResult("q", context, graph, files, "", true);
  expect(panel.capture().logic?.modules?.only).toBeUndefined(); expect(root.querySelectorAll(".port-view-context")).toHaveLength(1);
  panel.message(""); expect(root.querySelector(".port-view-context")).toBeNull();
});
