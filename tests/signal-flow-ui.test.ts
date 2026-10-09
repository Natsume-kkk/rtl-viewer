// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import type { TraceNode } from "../src/model/signal-flow";

const setup = (root: HTMLElement) => {
  const navigate = vi.fn();
  const panel = new SignalFlowPanel(root, { close: vi.fn(), context: vi.fn(), navigate });
  return { navigate, panel };
};
const leaf = (label: string, line: number, reason?: string): TraceNode => ({ label, file: "t.v", line, reason, children: [] });

it("条件标注显示在节点行尾，悬停提示包含完整路径与寄存器信息，点击跳转", () => {
  const root = document.createElement("aside");
  const { navigate, panel } = setup(root);
  const data: TraceNode = {
    label: "top.y",
    children: [{ label: "top.a", file: "t.v", line: 3, note: "条件: sel", tip: "寄存器级：clk", children: [leaf("top.src", 1, "顶层输入")] }],
  };
  panel.result("y", { label: "top.y", reason: "顶层输入", children: [] }, data, "");
  const button = root.querySelector<HTMLButtonElement>('button[data-line="3"]')!;
  expect(root.querySelector(".flow-note")?.textContent).toBe("条件: sel");
  expect(button.title).toContain("top.a");
  expect(button.title).toContain("寄存器级：clk");
  expect(button.title).toContain("条件: sel");
  button.click();
  expect(navigate).toHaveBeenCalledWith("t.v", 3);
});

it("单分支长链默认可读，各级无需展开即可跳转", () => {
  const root = document.createElement("aside");
  const { navigate, panel } = setup(root);
  const chain: TraceNode = {
    label: "top.a",
    children: [{ label: "top.b", file: "t.v", line: 2, children: [{ label: "top.c", file: "t.v", line: 3, children: [{ label: "top.d", file: "t.v", line: 4, children: [leaf("top.e", 5, "顶层输入")] }] }] }],
  };
  panel.result("a", chain, { label: "top.a", children: [] }, "");
  const compressed = root.querySelector<HTMLDetailsElement>("details.flow-chain")!;
  expect(compressed).not.toBeNull();
  expect(compressed.open).toBe(true);
  expect(compressed.querySelector("summary")?.textContent).toContain("3 级直通");
  root.querySelector<HTMLButtonElement>('button[data-line="3"]')!.click();
  expect(navigate).toHaveBeenCalledWith("t.v", 3);
  expect(root.querySelector<HTMLButtonElement>('button[data-line="5"]')?.textContent).toContain("e");
});

it("打开面板提示自动跟随，不再提供分析按钮", () => {
  const root = document.createElement("aside");
  setup(root);
  expect(root.textContent).toContain("点击源码中的信号");
  expect(root.textContent).not.toContain("分析光标处信号");
});

it("直接分支默认展开，点击节点定位不改变展开状态", () => {
  const root = document.createElement("aside");
  const { panel, navigate } = setup(root);
  const trace = { label: "top.a", children: [{ label: "top/u.i", file: "t.v", line: 2, children: [leaf("top/u.q", 3)] }] };
  panel.result("a", { label: "top.a", children: [] }, trace, "");
  const branch = root.querySelector<HTMLDetailsElement>("details")!;
  expect(branch.open).toBe(true);
  root.querySelector<HTMLButtonElement>('button[data-line="2"]')!.click();
  expect(navigate).toHaveBeenCalledWith("t.v", 2);
  expect(branch.open).toBe(true);
});

it("未知方向连接单独列出一次，不伪装为同时驱动和负载", () => {
  const root = document.createElement("aside");
  const { panel } = setup(root);
  const trace = { label: "top.a", children: [leaf("top/ip.clk", 3, "黑盒或缺失定义")] };
  panel.result("a", trace, trace, "");
  expect(root.textContent).toContain("方向待确认");
  expect(root.querySelectorAll('button[data-line="3"]')).toHaveLength(1);
});

it("大量分支显示前八条并可展开其余，不丢失结果", () => {
  const root = document.createElement("aside");
  const { panel } = setup(root);
  panel.result("a", { label: "top.a", children: [] }, { label: "top.a", children: Array.from({ length: 12 }, (_, i) => leaf(`top/u${i}.i`, i + 1)) }, "");
  const more = root.querySelector<HTMLDetailsElement>(".flow-more")!;
  expect(more.open).toBe(false);
  expect(more.querySelector("summary")?.textContent).toContain("另外 4 条");
  expect(more.querySelectorAll("button.flow-node")).toHaveLength(4);
});

it("时钟终点直接显示用途和源码入口，无需展开重复信号行", () => {
  const root = document.createElement("aside");
  const { panel, navigate } = setup(root);
  panel.result("clk", { label: "top.clk", children: [] }, { label: "top.clk", children: [{ label: "top/u.clk", file: "t.v", line: 2, children: [leaf("clk · t.v", 4, "控制/时钟信号，不作为数据链展开")] }] }, "");
  expect(root.querySelectorAll("details")).toHaveLength(0);
  root.querySelector<HTMLButtonElement>(".flow-usage")!.click();
  expect(navigate).toHaveBeenCalledWith("t.v", 4);
});

it("分叉不折叠，断点原因直接显示", () => {
  const root = document.createElement("aside");
  const { panel } = setup(root);
  const data: TraceNode = {
    label: "top.y",
    children: [
      { label: "top.a", file: "t.v", line: 1, children: [] },
      { label: "top.b", file: "t.v", line: 2, reason: "过程逻辑（不继续推导）", children: [] },
    ],
  };
  panel.result("y", { label: "top.y", children: [] }, data, "");
  expect(root.querySelector("details.flow-chain")).toBeNull();
  const reasons = [...root.querySelectorAll(".flow-reason")].map(el => el.textContent);
  expect(reasons.some(text => text?.includes("过程逻辑"))).toBe(true);
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button.flow-node")];
  expect(buttons.some(b => b.textContent === "a")).toBe(true);
  expect(buttons.some(b => b.textContent === "b")).toBe(true);
});
