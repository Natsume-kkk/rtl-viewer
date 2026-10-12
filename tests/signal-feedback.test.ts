import { describe, expect, it } from "vitest";
import { localLogic, type LogicGraph } from "../src/analysis/local";
import { ComputationProject } from "../src/analysis/project";
import { SignalProject } from "../src/model/signal-flow";

function graph(source: string, signal: string, vhdl = false): LogicGraph {
  const files = new Map([[vhdl ? "top.vhd" : "top.v", source]]);
  const project = new SignalProject(files);
  return localLogic(new ComputationProject(files, project), project, project.root("top")!, signal);
}
const verilog = (body: string) => `module top(input clk,en,d); reg q,r; wire next,a,b; ${body} endmodule`;
const vhdl = (body: string) => `entity top is port(clk,en,d: in bit); end;
architecture rtl of top is signal q,r,next,a,b: bit; begin ${body} end;`;
const feedback = (g: LogicGraph) => g.nodes.filter(node => node.detail.includes("组合反馈"));
function expectClockBoundary(g: LogicGraph) {
  expect(feedback(g)).toEqual([]);
  expect(g.nodes.some(node => node.signal === "q" && node.kind === "current")).toBe(true);
  expect(g.edges.some(edge => edge.current && g.nodes.find(node => node.id === edge.from)?.signal === "q")).toBe(true);
  expect(g.nodes.find(node => node.id === "q")?.kind).toBe("register");
  expect(g.nodes.every(node => node.path === "top")).toBe(true);
  expect(g.truncated).toBe(false);
}

describe("寄存器反馈与组合循环", () => {
  it.each(["q", "next"])("Verilog Q→next→Q 从 %s 起点按当前值结束", signal => {
    const g = graph(verilog("assign next=~q; always @(posedge clk) q<=next;"), signal);
    expectClockBoundary(g);
    expect(g.edges).toContainEqual(expect.objectContaining({ from: "next", to: "q" }));
  });
  it.each(["q", "NEXT"])("VHDL Q→next→Q 从 %s 起点按当前值结束", signal => {
    const g = graph(vhdl("next<=not q; process(clk) begin if rising_edge(clk) then q<=next; end if; end process;"), signal, true);
    expectClockBoundary(g);
  });
  it.each(["q", "next"])("经过两级组合逻辑的寄存器反馈从 %s 起点不误报", signal => {
    expectClockBoundary(graph(verilog("assign a=~q; assign next=a^d; always @(posedge clk) q<=next;"), signal));
  });
  it.each(["q", "next"])("条件更新与自保持保留时序边界：%s", signal => {
    expectClockBoundary(graph(verilog("assign next=en?~q:d; always @(posedge clk) if(en) q<=next;"), signal));
  });
  it.each(["q", "r"])("不同过程寄存器互读保持直接时序依赖：%s", signal => {
    const g = graph(verilog("always @(posedge clk) q<=r; always @(posedge clk) r<=q;"), signal);
    expect(feedback(g)).toEqual([]);
    expect(g.nodes.some(node => node.kind === "current")).toBe(true);
    expect(g.nodes.filter(node => node.kind === "register").map(node => node.signal).sort()).toEqual(["q", "r"]);
  });
  it("同过程非阻塞互读保留当前值，阻塞顺序仍由过程表达式决定", () => {
    const deferred = graph(verilog("always @(posedge clk) begin q<=r; r<=q; end"), "q");
    expect(feedback(deferred)).toEqual([]);
    expect(deferred.edges.some(edge => edge.current)).toBe(true);
    const immediate = graph(verilog("assign next=~q; always @(posedge clk) begin q=next; r=q; end"), "next");
    expect(feedback(immediate)).toEqual([]);
    expect(immediate.edges).toContainEqual(expect.objectContaining({ from: "next", to: "r", current: false }));
    expect(immediate.edges.some(edge => edge.from === "q" && edge.to === "r")).toBe(false);
  });
  it.each(["assign a=~a;", "assign a=b; assign b=~a;"])("真实组合循环仍保留边界：%s", body => {
    const g = graph(verilog(body), "a");
    expect(feedback(g).length).toBeGreaterThan(0);
    expect(g.nodes.some(node => node.kind === "current")).toBe(false);
    expect(g.truncated).toBe(false);
  });
  it("寄存器回路共存的组合环不能被时序边界掩盖", () => {
    const g = graph(verilog("assign a=q^b; assign b=~a; always @(posedge clk) q<=a;"), "q");
    expect(feedback(g).length).toBeGreaterThan(0);
    expect(g.nodes.some(node => node.signal === "q" && node.kind === "current")).toBe(true);
  });
  it("同一信号存在时序和组合混合驱动时不冒充单一寄存器", () => {
    const g = graph(verilog("assign next=~q; assign q=next; always @(posedge clk) q<=d;"), "next");
    expect(g.nodes.find(node => node.id === "q")?.kind).toBe("resolved");
    expect(feedback(g).length).toBeGreaterThan(0);
  });
  it("条件分支中的真实组合环仍显示边界", () => {
    const g = graph(verilog("assign a=en?b:q; assign b=~a; always @(posedge clk) q<=d;"), "a");
    expect(feedback(g).length).toBeGreaterThan(0);
  });
  it.each(["q", "next"])("next 与 tmp 的真实组合环在 %s 起点保留", signal => {
    const g = graph(verilog("assign next=a^q; assign a=next^d; always @(posedge clk) q<=next;"), signal);
    expect(feedback(g).length).toBeGreaterThan(0);
    expect(g.nodes.some(node => node.signal === "q" && node.kind === "current")).toBe(true);
  });
  it.each(["q", "next"])("寄存器在 select 条件中仍保留当前值：%s", signal => {
    const g = graph(verilog("assign next=q?d:1'b0; always @(posedge clk) q<=next;"), signal);
    expectClockBoundary(g);
    expect(g.edges.some(edge => edge.control && edge.current && g.nodes.find(node => node.id === edge.from)?.signal === "q")).toBe(true);
  });
  it("不支持的时钟过程不推断为确定寄存器", () => {
    const g = graph(verilog("assign next=~q; always @(posedge clk) q<=mystery(next);"), "next");
    expect(g.nodes.find(node => node.id === "q")?.kind).toBe("boundary");
    expect(g.nodes.some(node => node.signal === "q" && node.kind === "current")).toBe(false);
  });
  it("补齐上游寄存器更新来源不展开其无关扇出", () => {
    const g = graph(verilog("assign next=~q; always @(posedge clk) q<=d; always @(posedge clk) r<=q; assign a=q;"), "next");
    expect(g.nodes.map(node => node.signal)).toEqual(expect.arrayContaining(["next", "q", "d"]));
    expect(g.nodes.some(node => node.signal === "r" || node.signal === "a")).toBe(false);
  });
});
