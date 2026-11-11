// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { SignalProject, traceSignal } from "../src/analysis/signal-flow";
import { SignalFlowPanel } from "../src/ui/signal-flow";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
async function ports(source: string, signal = "a") {
  const project = new SignalProject(new Map([["t.v", source]])), context = project.root("top")!;
  const up = await traceSignal(project, context, signal, "upstream", {stopAtAssignments: true});
  const down = await traceSignal(project, context, signal, "downstream", {stopAtAssignments: true});
  const root = document.createElement("aside"); document.body.append(root);
  const panel = new SignalFlowPanel(root, {close() {}, context() {}, navigate() {}});
  panel.result(signal, up, down, "");
  cleanups.push(() => { panel.message(""); root.remove(); });
  return {root, panel};
}
const named = (root: HTMLElement, path: string) => [...root.querySelectorAll<HTMLElement>(".module-summary")].find(card => card.getAttribute("aria-label") === path)!;
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;

it("终点端口无展开入口时仍可看到切片映射", async () => {
  const style = document.createElement("style"); style.textContent = readFileSync("src/style.css", "utf8");
  document.head.append(style); cleanups.push(() => style.remove());
  const {root} = await ports("module top(input [7:0] a); leaf u(.i(a[3:0])); endmodule module leaf(input [3:0] i); endmodule");
  const card = named(root, "top/u"), mapping = card.querySelector<HTMLElement>(".port-mapping")!;
  expect(mapping.textContent).toBe(".i(a[3:0])");
  expect(card.querySelector(".port-fold-toggle")).toBeNull();
  expect(getComputedStyle(mapping).display).not.toBe("none");
});

it("只看共享下级保留所有祖先路径，收起和恢复不漏掉另一端口", async () => {
  const {root, panel} = await ports("module top(input a); wrap u(.i(a),.j(a)); endmodule module wrap(input i,j); leaf v(.d(i|j)); endmodule module leaf(input d); wire q; assign q=d; endmodule");
  root.querySelector<HTMLButtonElement>(".port-view-more")!.click(); document.querySelector<HTMLButtonElement>(".ctx-menu button")!.click();
  const child = named(root, "top/u/v"); child.querySelector<HTMLButtonElement>(".only-module-toggle")!.click();
  const shownPorts = () => [...root.querySelectorAll<HTMLElement>(".module-summary")].filter(card => !card.hidden).map(card => card.querySelector(".port-pin")!.textContent);
  expect(shownPorts()).toEqual(["input i", "input d", "input j"]);
  expect([...root.querySelectorAll<SVGElement>(".logic-wire")].filter(edge => edge.dataset.to === child.dataset.node)).toHaveLength(2);
  button(root, "全部收起").click(); expect(shownPorts()).toEqual(["input i", "input d", "input j"]);
  const state = panel.capture(); panel.restore(state); expect(shownPorts()).toEqual(["input i", "input d", "input j"]);
  button(root, "显示全部").click(); expect(shownPorts()).toEqual(["input i", "input d", "input j"]);
});

it("取消只看不把首次创建的过程源码改为关闭，原来关闭的源码仍关闭", async () => {
  const {root, panel} = await ports("module top(input a,clk); leaf u(.i(a),.clk(clk)); leaf v(.i(a),.clk(clk)); leaf w(.i(a),.clk(clk)); endmodule module leaf(input i,clk); reg q; always @(posedge clk) q<=i; endmodule");
  root.querySelector<HTMLButtonElement>(".repeated-summary .port-fold-toggle")!.click();
  named(root, "top/v").querySelector<HTMLButtonElement>(".port-fold-toggle")!.click();
  const block = (owner: string) => [...root.querySelectorAll<HTMLDetailsElement>(".assignment-block")].find(block => block.closest(".logic-card")!.querySelector(".assignment-context")!.textContent === owner)!;
  block("top/v").open = false;
  named(root, "top/u").querySelector<HTMLButtonElement>(".only-module-toggle")!.click();
  expect(block("top/u").open).toBe(true);
  button(root, "显示全部").click();
  named(root, "top/u").querySelector<HTMLButtonElement>(".port-fold-toggle")!.click();
  expect(block("top/u").open).toBe(true); expect(block("top/v").open).toBe(false);
  const saved = panel.capture(); panel.restore(saved);
  expect(block("top/u").open).toBe(true); expect(block("top/v").open).toBe(false);
});
