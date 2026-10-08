import { describe, it, expect } from "vitest";
import { SignalProject, traceSignal, type TraceNode } from "../src/model/signal-flow";

const flatten = (n: TraceNode): string => [n.label, n.reason ?? "", ...n.children.map(flatten)].join("\n");
describe("信号链：按实例追踪端口与直接赋值", () => {
  it("Verilog 跨两层、扇出与返回父层，终止于过程逻辑和顶层出口", async () => {
    const project = new SignalProject(new Map([
      ["top.v", "module top(input clk, output q); wire link; child a(.i(clk), .o(link)); child b(.i(clk), .o(q)); endmodule"],
      ["child.v", "module child(input i, output o); wire next; assign next = i; leaf x(.d(next), .q(o)); endmodule"],
      ["leaf.v", "module leaf(input d, output q); always @(posedge d) begin q <= d; end endmodule"],
    ]));
    const root = project.root("top")!;
    const down = await traceSignal(project, root, "clk", "downstream");
    expect(flatten(down)).toContain("top/a/x.d");
    expect(flatten(down)).toContain("top/b/x.d");
    expect(flatten(down)).toContain("过程逻辑");
    const child = project.child(root, project.module("top")!.instances[1]);
    expect(flatten(await traceSignal(project, child, "o", "downstream"))).toContain("顶层输出");
    expect(flatten(await traceSignal(project, child, "i", "upstream"))).toContain("顶层输入");
  });
  it("VHDL 大小写、位置连接、entity/architecture 分文件和直接赋值", async () => {
    const project = new SignalProject(new Map([
      ["top.vhd", "entity top is port (CLK : in bit; Q : out bit); end top; architecture rtl of top is begin u : entity work.child port map (CLK, Q); end rtl;"],
      ["child.vhd", "entity child is port (i : in bit; o : out bit); end child;"],
      ["child_rtl.vhd", "architecture rtl of child is begin o <= i; end rtl;"],
    ]));
    const text = flatten(await traceSignal(project, project.root("top")!, "clk", "downstream"));
    expect(text).toContain("top/u.i");
    expect(text).toContain("top/u.o");
    expect(text).toContain("顶层输出");
  });
  it("运算、切片、未解析模块、循环和搜索预算均显示边界", async () => {
    const project = new SignalProject(new Map([["top.v", "module top(input a, input b, output q); wire c; assign q = a & b; assign c = c; missing u(.i(a)); endmodule"]]));
    const root = project.root("top")!;
    const down = flatten(await traceSignal(project, root, "a", "downstream"));
    expect(down).toContain("运算或范围转换");
    expect(down).toContain("黑盒或缺失定义");
    expect(flatten(await traceSignal(project, root, "c", "downstream"))).toContain("循环连接");
    expect(flatten(await traceSignal(project, root, "a", "downstream", { maxNodes: 1 }))).toContain("分析预算");
  });
  it("同一模块的多个实例提供独立上下文，不混合相邻模块信号", () => {
    const project = new SignalProject(new Map([["all.v", "module top(input a); child x(.i(a)); child y(.i(a)); endmodule module child(input i); endmodule module other(input i); wire x; assign x=i; endmodule"]]));
    const contexts = project.contexts("top", "child");
    expect(contexts.items.map(c => c.path)).toEqual(["top/x", "top/y"]);
    expect(project.module("child")!.assignments).toHaveLength(0);
  });
  it("分析取消不会继续展开", async () => {
    const project = new SignalProject(new Map([["t.v", "module t(input a); endmodule"]]));
    await expect(traceSignal(project, project.root("t")!, "a", "upstream", { cancelled: () => true })).rejects.toThrow("cancelled");
  });
  it("过程外连线不误归入前面的 always，VHDL 裸 end 过程不当作直接赋值", async () => {
    const project = new SignalProject(new Map([["t.v", "module t(input a, input clk, output q); reg x; always @(posedge clk) begin x <= clk; end assign q = a; endmodule"]]));
    const text = flatten(await traceSignal(project, project.root("t")!, "a", "downstream"));
    expect(text).toContain("顶层输出"); expect(text).not.toContain("过程逻辑");
    const vhdl = new SignalProject(new Map([["t.vhd", "entity t is port(a:in bit;q:out bit);end t; architecture rtl of t is begin process(a) begin q<=a; end; end rtl;"]]));
    expect(vhdl.module("t")!.assignments).toHaveLength(0);
    expect(flatten(await traceSignal(vhdl, vhdl.root("t")!, "a", "downstream"))).toContain("过程逻辑");
  });
  it("过程读取时钟属于去向，只有赋值目标的来源才显示该过程", async () => {
    for (const [file, source] of [
      ["t.v", "module t(input clk, output q); always @(posedge clk) begin q <= clk; end endmodule"],
      ["t.vhd", "entity t is port(clk:in bit;q:out bit);end t; architecture rtl of t is begin process(clk) begin if rising_edge(clk) then q<=clk; end if; end process; end rtl;"],
    ]) {
      const p = new SignalProject(new Map([[file, source]])), ctx = p.root("t")!;
      expect(flatten(await traceSignal(p, ctx, "clk", "upstream"))).not.toContain("过程逻辑");
      expect(flatten(await traceSignal(p, ctx, "q", "upstream"))).toContain("过程逻辑");
      expect(flatten(await traceSignal(p, ctx, "q", "downstream"))).not.toContain("过程逻辑");
    }
  });
  it("切片与 generate 不冒充已展开的精确连线", async () => {
    const p = new SignalProject(new Map([["t.v", "module t(input [7:0] a, output q); assign q = a[0]; endmodule"]]));
    expect(flatten(await traceSignal(p, p.root("t")!, "a", "downstream"))).toContain("范围转换");
    const g = new SignalProject(new Map([["g.v", "module g(input a); generate if(1) begin wire x; assign x=a; end endgenerate endmodule"]]));
    expect(flatten(await traceSignal(g, g.root("g")!, "a", "downstream"))).toContain("generate 需展开");
  });
});
