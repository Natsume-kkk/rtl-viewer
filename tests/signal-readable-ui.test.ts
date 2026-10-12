// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import type { LogicGraph } from "../src/analysis/local";
import type { Driver } from "../src/analysis/project";
import type { ProcessResult } from "../src/analysis/process";
import { SignalProject } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";

function render(graph: LogicGraph, source = "", file = "t.vhd") {
  const root = document.createElement("aside"), navigate = vi.fn();
  const panel = new SignalFlowPanel(root, { close: vi.fn(), context: vi.fn(), navigate });
  panel.logicResult("q", { module: "t", path: "t" }, graph, new Map([[file, source]]), "");
  return { root, panel, navigate };
}

it("生成对象选择列表展示词法路径并将选择交回控制器",()=>{
  const root=document.createElement("aside"),context=vi.fn();
  const panel=new SignalFlowPanel(root,{close:vi.fn(),context,navigate:vi.fn()});
  panel.setContexts([{module:"top",path:"top"},{module:"top",path:"top"}],0,["top/lanes[0].w","top/lanes[1].w"]);
  const select=root.querySelector("select")!;
  expect(select.hidden).toBe(false);expect([...select.options].map(o=>o.textContent)).toEqual(["top/lanes[0].w","top/lanes[1].w"]);
  select.selectedIndex=1;select.dispatchEvent(new Event("change"));expect(context).toHaveBeenCalledWith(1);
});

it("部分写入按过程展示原始目标和语句，不把同过程赋值称为多个驱动", () => {
  const source = "q(0) <= a;\nq(1) <= b;";
  const process:ProcessResult = { mode: "clocked", clock: "rising_edge(clk)", updates:new Map(), operators:new Map(), sites:new Map(), locals:[], events:[], issues:[] };
  const drivers:Driver[] = ["a", "b"].map((name, index) => ({
    expression: { kind: "ref", value: name, text: name, args: [], start: index * 11 + 8, end: index * 11 + 9 },
    source: { file: "t.vhd", start: index * 11, end: index * 11 + 10 },
    process, operator: "<=", relation: true, targetText: `q(${index})`, selectors: [], conditions: [], contexts:["for i in 0 to 1 loop"],
  }));
  const graph:LogicGraph = { root: "q", nodes: [{ id: "q", label: "q", signal: "q", path: "t", kind: "register", detail: "", drivers }], edges: [], truncated: false };
  const { root, navigate } = render(graph, source);
  expect(root.textContent).toContain("q(0) <= a;");
  expect(root.textContent).toContain("q(1) <= b;");
  expect(root.textContent).toContain("源码关系");
  expect(root.textContent).toContain("for i in 0 to 1 loop");
  expect(root.textContent).not.toContain("驱动 2");
  expect(root.querySelectorAll(".assignment-block")).toHaveLength(1);
  root.querySelector<HTMLButtonElement>('.assignment-source[data-line="2"]')!.click();
  expect(navigate).toHaveBeenCalledWith("t.vhd", 2);
});

it("地址与未知调用参数有可见角色，调用参数不显示为确定方向", () => {
  const node = (id: string):LogicGraph["nodes"][number] => ({ id, label: id, signal: id, path: "t", kind: "signal", detail: "", drivers: [] });
  const graph:LogicGraph = { root: "q", nodes: [node("q"), node("addr"), node("arg")], edges: [
    { from: "addr", to: "q", role: "地址" },
    { from: "arg", to: "q", role: "调用参数", unknown: true },
  ], truncated: false };
  const { root } = render(graph);
  expect(root.textContent).toContain("地址：addr");
  expect(root.textContent).toContain("调用参数：arg");
  expect(root.querySelector('.logic-wire[data-from="arg"]')?.hasAttribute("marker-end")).toBe(false);
});

it("已识别类型转换保留调用写法而非显示分析边界", () => {
  const graph = { root: "q", nodes: [{ id: "q", label: "q", signal: "q", path: "t", kind: "signal", detail: "", drivers: [{
    expression: { kind: "call", value: "resize", text: "resize(a, 8)", args: [], start: 0, end: 12, conversion: { name: "resize", width: "8", description: "调整宽度；结果值未计算" } },
    source: { file: "t.vhd", start: 0, end: 12 }, operator: "<=",
  }] }], edges: [], truncated: false } as LogicGraph;
  const { root } = render(graph);
  expect(root.textContent).toContain("resize(a, 8)");
  expect(root.textContent).not.toContain("分析边界");
});

it("类型提示可定位声明并保留已有信号链", () => {
  const graph = { root: "q", nodes: [{ id: "q", label: "q", path: "t", kind: "signal", detail: "", drivers: [] }], edges: [], truncated: false } as LogicGraph;
  const { root, panel, navigate } = render(graph);
  panel.objectHint("rom_type", "数组类型", { file: "t.vhd", line: 3 });
  expect(root.querySelector(".flow-following")?.textContent).toContain("rom_type 是数组类型");
  expect(root.querySelector(".flow-selected")?.textContent).toBe("q");
  root.querySelector<HTMLButtonElement>('.flow-following button[data-line="3"]')!.click();
  expect(navigate).toHaveBeenCalledWith("t.vhd", 3);
});

it("未知调用的副作用边界保留原文与定位，不只显示泛化限制",()=>{
  const source="module top(input a,output reg q,y); always @* begin q=a; mutate(q); y=q; end endmodule";
  const files=new Map([["t.v",source]]),project=new SignalProject(files),ctx=project.root("top")!;
  const graph=localLogic(new ComputationProject(files,project),project,ctx,"q");
  const {root}=render(graph,source,"t.v");
  expect(root.querySelector('[data-node="q"]')?.textContent).toContain("mutate(q);");
  expect(root.querySelector('[data-node="q"] .assignment-source[data-line="1"]')).not.toBeNull();
});
