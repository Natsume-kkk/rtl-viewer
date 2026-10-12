import { describe, it, expect } from "vitest";
import { SignalProject, traceSignal, type TraceNode } from "../src/model/signal-flow";
import { parseVhdlProcess } from "../src/parser/procedural";

const flatten = (n: TraceNode): string => [n.label, n.reason ?? "", ...n.children.map(flatten)].join("\n");
it("当前信号定位保留追踪入口行，跨层节点保留实例与端口身份", async () => {
  const files=new Map([["top.vhd",`entity top is
port (
  rx : in bit
);
end top;
architecture rtl of top is begin
u: entity work.child port map(i => rx);
end rtl;`],["child.vhd",`entity child is port(i: in bit); end child;
architecture rtl of child is signal x: bit; begin x <= i; end rtl;`]]);
  const p=new SignalProject(files),ctx=p.root("top")!;
  const trace=await traceSignal(p,ctx,"rx","downstream",{stopAtAssignments:true,source:{file:"top.vhd",line:3,column:3}});
  expect(trace.line).toBe(3);expect(trace.file).toBe("top.vhd");
  expect(trace.port).toEqual({path:"top",name:"rx",direction:"in"});
  expect(trace.children[0].port).toEqual({path:"top/u",name:"i",direction:"in"});
  expect(trace.children[0].line).toBe(7);
});
interface Flat { label: string; note?: string; tip?: string; reason?: string }
const collect = (n: TraceNode, out: Flat[] = []): Flat[] => {
  out.push({ label: n.label, note: n.note, tip: n.tip, reason: n.reason });
  n.children.forEach(c => collect(c, out));
  return out;
};

describe("信号链：过程作用域与嵌套边界回归", () => {
  const localsSource = `entity t is port(a,b,tmp: in bit; y,z,w: out bit); end t;
architecture rtl of t is begin
p1: process(a) variable tmp, spare: bit; begin TMP := a; y <= tmp; end process;
p2: process(b) variable TMP: bit; begin tmp := b; z <= TMP; end process;
w <= tmp;
end rtl;`;
  it("同名过程变量双向隔离，并保留模块同名端口的连线", async () => {
    const p = new SignalProject(new Map([["t.vhd", localsSource]])), ctx = p.root("t")!;
    const y = collect(await traceSignal(p, ctx, "y", "upstream"));
    expect(y.some(n => n.label === "t.a")).toBe(true);
    expect(y.some(n => n.label === "t.b" || n.reason === "顶层输入" && n.label === "tmp")).toBe(false);
    expect(y.some(n => n.note?.includes("多驱动"))).toBe(false);
    const a = flatten(await traceSignal(p, ctx, "a", "downstream"));
    expect(a).toContain("t.y");
    expect(a).not.toContain("t.z");
    expect(a).not.toContain("t.w");
    const w = flatten(await traceSignal(p, ctx, "w", "upstream"));
    expect(w).toContain("顶层输入");
    expect(w).not.toContain("t.a");
    expect(w).not.toContain("t.b");
  });
  it("直接选择局部变量时用源码位置区分两个过程", async () => {
    const p = new SignalProject(new Map([["t.vhd", localsSource]])), ctx = p.root("t")!;
    const first = flatten(await traceSignal(p, ctx, "tmp", "upstream", { source: { file: "t.vhd", line: 3, column: 27 } }));
    const second = flatten(await traceSignal(p, ctx, "tmp", "upstream", { source: { file: "t.vhd", line: 4, column: 27 } }));
    expect(first).toContain("t.a"); expect(first).not.toContain("t.b");
    expect(second).toContain("t.b"); expect(second).not.toContain("t.a");
  });
  it("局部变量的位选断点不会泄漏到另一个过程", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(a,b: in bit; y,z: out bit); end t;
architecture rtl of t is begin
process(a) variable tmp: bit_vector(0 to 0); begin tmp(0) := a; y <= tmp(0); end process;
process(b) variable tmp: bit; begin tmp := b; z <= tmp; end process;
end rtl;`]]));
    const z = flatten(await traceSignal(p, p.root("t")!, "z", "upstream"));
    expect(z).toContain("t.b"); expect(z).not.toContain("位选/切片赋值");
  });
  it("同一行的不同过程仍按光标列区分局部对象", async () => {
    const source = localsSource.replaceAll("\n", " ");
    const p = new SignalProject(new Map([["t.vhd", source]]));
    const column = source.indexOf("variable TMP") + "variable ".length + 1;
    const tree = flatten(await traceSignal(p, p.root("t")!, "tmp", "upstream", { source: { file: "t.vhd", line: 1, column } }));
    expect(tree).toContain("t.b"); expect(tree).not.toContain("t.a");
  });
  it("尚未写完或错误配对的嵌套过程显示边界，不伪造并发赋值", async () => {
    for (const ending of ["", "end process;"]) {
      const p = new SignalProject(new Map([["t.vhd", `entity t is port(a: in bit; y: out bit); end t;
architecture rtl of t is begin
process(a) function helper return bit is begin return '0'; ${ending}
begin y <= a;
end architecture;`]]));
      expect(p.module("t")!.assignments).toEqual([]);
      expect(flatten(await traceSignal(p, p.root("t")!, "y", "upstream"))).toContain("过程边界未确定");
    }
  });
  it("elsif 和 else 累积此前所有否定条件，并保留外层条件", () => {
    const parsed = parseVhdlProcess(`process(all) begin if en then
      if c1 then y <= a; elsif c2 then y <= b; elsif c3 then y <= c; else y <= d; end if;
      z <= a;
    end if; end process;`);
    expect(parsed.assignments.map(a => a.conditions)).toEqual([
      ["en", "c1"], ["en", "!(c1)", "c2"], ["en", "!(c1)", "!(c2)", "c3"],
      ["en", "!(c1)", "!(c2)", "!(c3)"], ["en"],
    ]);
  });
  it.each(["end;", "end helper;", "end function;", "end function helper;"])("内层函数以 %s 收尾，不截断时钟过程或吞掉后续过程", async closing => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(clk,a,b: in bit; y,z: out bit); end t;
architecture rtl of t is begin
process(clk)
  function helper(x: bit) return bit is begin return x; ${closing}
begin if rising_edge(clk) then y <= a; end if; end process;
process(b) begin z <= b; end process;
end rtl;`]]));
    expect(p.module("t")!.assignments.map(a => [a.target, a.proc])).toEqual([["y", 0], ["z", 1]]);
    const y = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    expect(y.some(n => n.label === "t.a" && n.tip?.includes("clk"))).toBe(true);
  });
  it("函数原型、嵌套子程序和 record 声明不混入外层过程赋值", () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(a: in bit; y: out bit); end t;
architecture rtl of t is begin
process(a)
  function helper(x: bit) return bit;
  function helper(x: bit) return bit is
    procedure nested is begin y <= '0'; end procedure nested;
  begin return x; end function helper;
  type pair is record left_value: bit; right_value: bit; end record pair;
  variable tmp: bit;
begin tmp := a; y <= tmp; end process;
end rtl;`]]));
    expect(p.module("t")!.assignments.map(a => [a.target, a.expression, a.proc])).toEqual([["tmp", "a", 0], ["y", "tmp", 0]]);
  });
});
describe("信号链：按实例追踪端口与直接赋值", () => {
  it("时钟终点定位每个实际过程的使用行", async () => {
    const project = new SignalProject(new Map([["t.v", "module t(input clk, input d, output reg q, output reg r);\nalways @(posedge clk) q <= d;\nalways @(posedge clk) r <= d;\nendmodule"]]));
    const down = await traceSignal(project, project.root("t")!, "clk", "downstream");
    expect(down.children.filter(n => n.reason?.startsWith("控制/时钟信号")).map(n => n.line)).toEqual([2, 3]);
  });
  it("链路节点定位到对应赋值或端口连接，而不是模块首行", async () => {
    const project = new SignalProject(new Map([["top.v", "module top(input a, output q);\nwire n;\nassign n = a;\nchild u(.i(n), .q(q));\nendmodule"], ["child.v", "module child(input i, output q);\nassign q = i;\nendmodule"]]));
    const down = await traceSignal(project, project.root("top")!, "a", "downstream");
    expect(down.children[0]).toMatchObject({ label: "top.n", file: "top.v", line: 3 });
    expect(down.children[0].children[0]).toMatchObject({ label: "top/u.i", file: "top.v", line: 4 });
    expect(down.children[0].children[0].children[0]).toMatchObject({ label: "top/u.q", file: "child.v", line: 2 });
  });
  it("Verilog 跨两层、扇出与返回父层，穿透寄存器到达顶层出口", async () => {
    const project = new SignalProject(new Map([
      ["top.v", "module top(input clk, output q); wire link; child a(.i(clk), .o(link)); child b(.i(clk), .o(q)); endmodule"],
      ["child.v", "module child(input i, output o); wire next; assign next = i; leaf x(.d(next), .q(o)); endmodule"],
      ["leaf.v", "module leaf(input d, output q); always @(posedge d) begin q <= d; end endmodule"],
    ]));
    const root = project.root("top")!;
    const down = await traceSignal(project, root, "clk", "downstream");
    const flat = collect(down);
    expect(flatten(down)).toContain("top/a/x.d");
    expect(flatten(down)).toContain("top/b/x.d");
    // leaf 里的 always @(posedge d) q <= d：d 既是时钟又是数据，穿透寄存器继续走
    expect(flatten(down)).toContain("top/a/x.q");
    expect(flat.some(n => n.label === "top/a/x.q" && n.tip?.includes("寄存器"))).toBe(true);
    expect(flatten(down)).toContain("顶层输出");
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
  it("运算穿透、未解析模块、循环和搜索预算均正确显示", async () => {
    const project = new SignalProject(new Map([["top.v", "module top(input a, input b, output q); wire c; assign q = a & b; assign c = c; missing u(.i(a)); endmodule"]]));
    const root = project.root("top")!;
    const down = collect(await traceSignal(project, root, "a", "downstream"));
    // 运算表达式穿透：a & b 继续追到 q，表达式作为标注
    const q = down.find(n => n.label === "top.q");
    expect(q).toBeDefined();
    expect(q!.note).toContain("a & b");
    expect(down.some(n => n.reason === "顶层输出")).toBe(true);
    expect(flatten(await traceSignal(project, root, "a", "downstream"))).toContain("黑盒或缺失定义");
    expect(flatten(await traceSignal(project, root, "c", "downstream"))).toContain("循环连接");
    expect(flatten(await traceSignal(project, root, "a", "downstream", { maxNodes: 1 }))).toContain("分析预算");
  });
  it("同一模块的多个实例提供独立上下文，不混合相邻模块信号", () => {
    const project = new SignalProject(new Map([["all.v", "module top(input a); child x(.i(a)); child y(.i(a)); endmodule module child(input i); endmodule module other(input i); wire x; assign x=i; endmodule"]]));
    const contexts = project.contexts("top", "child");
    expect(contexts.items.map(c => c.path)).toEqual(["top/x", "top/y"]);
    expect(project.module("child")!.assignments).toHaveLength(0);
  });
  it("同一文件多模块、多赋值的节点各自定位正确行号", async () => {
    const source = [
      "module first(input a, output q);",
      "wire n;",
      "assign n = a;",
      "assign q = n;",
      "endmodule",
      "module second(input b, output r);",
      "wire m1; wire m2;",
      "assign m1 = b;",
      "assign m2 = m1;",
      "assign r = m2;",
      "endmodule",
    ].join("\n");
    const rows = (n: TraceNode, out: TraceNode[] = []): TraceNode[] => { out.push(n); n.children.forEach(c => rows(c, out)); return out; };
    const project = new SignalProject(new Map([["multi.v", source]]));
    const down = rows(await traceSignal(project, project.root("second")!, "b", "downstream"));
    expect(down.find(n => n.label === "second.m1")?.line).toBe(8);
    expect(down.find(n => n.label === "second.m2")?.line).toBe(9);
    expect(down.find(n => n.label === "second.r")?.line).toBe(10);
    const up = rows(await traceSignal(project, project.root("first")!, "q", "upstream"));
    expect(up.find(n => n.label === "first.n")?.line).toBe(4);
    expect(up.find(n => n.label === "first.a")?.line).toBe(3);
  });
  it("同一文件名内容变化后行号按新内容定位", async () => {
    const rows = (n: TraceNode, out: TraceNode[] = []): TraceNode[] => { out.push(n); n.children.forEach(c => rows(c, out)); return out; };
    const project = new SignalProject(new Map([["t.v", "module t(input a, output q);\nassign q = a;\nendmodule"]]));
    expect(rows(await traceSignal(project, project.root("t")!, "q", "upstream")).find(n => n.label === "t.a")?.line).toBe(2);
    const next = new SignalProject(new Map([["t.v", "\n\nmodule t(input a, output q);\n\nassign q = a;\nendmodule"]]));
    expect(rows(await traceSignal(next, next.root("t")!, "q", "upstream")).find(n => n.label === "t.a")?.line).toBe(5);
  });
  it("分析取消不会继续展开", async () => {
    const project = new SignalProject(new Map([["t.v", "module t(input a); endmodule"]]));
    await expect(traceSignal(project, project.root("t")!, "a", "upstream", { cancelled: () => true })).rejects.toThrow("cancelled");
  });
  it("过程外连线不误归入前面的 always，VHDL 裸 end 过程不当作直接赋值", async () => {
    const project = new SignalProject(new Map([["t.v", "module t(input a, input clk, output q); reg x; always @(posedge clk) begin x <= clk; end assign q = a; endmodule"]]));
    const text = flatten(await traceSignal(project, project.root("t")!, "a", "downstream"));
    expect(text).toContain("顶层输出"); expect(text).not.toContain("过程逻辑");
    const vhdl = new SignalProject(new Map([["t.vhd", "entity t is port(a:in bit;q:out bit);end t; architecture rtl of t is begin process(a) begin q<=a; end; end process; end rtl;"]]));
    // VHDL 裸 end 过程同样穿透（过程范围到 end 为止，不误吞后续）
    expect(vhdl.module("t")!.assignments).toHaveLength(1);
    const vDown = flatten(await traceSignal(vhdl, vhdl.root("t")!, "a", "downstream"));
    expect(vDown).toContain("t.q");
    expect(vDown).toContain("顶层输出");
    expect(vDown).not.toContain("过程逻辑");
  });
  it("时钟在敏感表不作为数据链展开，数据穿过寄存器继续追踪", async () => {
    const project = new SignalProject(new Map([
      ["t.v", "module t(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule"],
    ]));
    const ctx = project.root("t")!;
    const up = collect(await traceSignal(project, ctx, "q", "upstream"));
    expect(up.some(n => n.label === "t.d" && n.tip?.includes("寄存器"))).toBe(true);
    expect(up.some(n => n.reason === "顶层输入")).toBe(true);
    expect(up.some(n => n.label.includes("clk"))).toBe(false);
    const clkDown = flatten(await traceSignal(project, ctx, "clk", "downstream"));
    expect(clkDown).toContain("不作为数据链展开");
    expect(clkDown).not.toContain("t.q");
    const dDown = collect(await traceSignal(project, ctx, "d", "downstream"));
    expect(dDown.some(n => n.label === "t.q" && n.tip?.includes("寄存器"))).toBe(true);
    // VHDL 时钟过程同样穿透：q 的来源追到 clk（此处 clk 是数据），并带寄存器提示
    const vhdl = new SignalProject(new Map([["t.vhd", "entity t is port(clk:in bit;q:out bit);end t; architecture rtl of t is begin process(clk) begin if rising_edge(clk) then q<=clk; end if; end process; end rtl;"]]));
    const vUp = collect(await traceSignal(vhdl, vhdl.root("t")!, "q", "upstream"));
    expect(vUp.some(n => n.label.toLowerCase() === "t.clk" && n.tip?.includes("寄存器"))).toBe(true);
  });
  it("切片保留范围提示，静态 generate 展开带独立作用域的连线", async () => {
    const p = new SignalProject(new Map([["t.v", "module t(input [7:0] a, output q); assign q = a[0]; endmodule"]]));
    expect(flatten(await traceSignal(p, p.root("t")!, "a", "downstream"))).toContain("范围转换");
    const g = new SignalProject(new Map([["g.v", "module g(input a); generate if(1) begin wire x; assign x=a; end endgenerate endmodule"]]));
    const generated=g.moduleForContext(g.root("g")!)!;
    expect(generated.assignments).toHaveLength(1);
    expect(generated.assignments[0].expression).toBe("a");
    expect(generated.assignments[0].target).toMatch(/^__gen_.*_x$/);
    const traced=flatten(await traceSignal(g, g.root("g")!, "a", "downstream"));
    expect(traced).toContain(generated.assignments[0].target);
    expect(traced).not.toContain("generate 需展开");
  });
});

describe("信号链：穿透过程块（赋值池模型）", () => {
  it("带复位和使能的寄存器：数据穿透、条件作标注、常量是终点、复位不展开", async () => {
    const p = new SignalProject(new Map([["t.v", `module t(input clk, input rst_n, input en, input d, output reg q);
      always @(posedge clk or negedge rst_n) begin
        if (!rst_n) q <= 1'b0;
        else if (en) q <= d;
      end
    endmodule`]]));
    const ctx = p.root("t")!;
    const up = collect(await traceSignal(p, ctx, "q", "upstream"));
    const d = up.find(n => n.label === "t.d");
    expect(d).toBeDefined();
    expect(d!.note).toContain("en");
    expect(d!.tip).toContain("寄存器");
    const constant = up.find(n => n.reason?.includes("常量"));
    expect(constant).toBeDefined();
    expect(constant!.label).toContain("1'b0");
    const rstDown = flatten(await traceSignal(p, ctx, "rst_n", "downstream"));
    expect(rstDown).toContain("不作为数据链展开");
    expect(rstDown).not.toContain("t.q");
  });
  it("组合 if/else 多分支并列，选择信号只作标注", async () => {
    const p = new SignalProject(new Map([["t.v", "module t(input sel, input a, input b, output reg y); always @* begin if (sel) y = a; else y = b; end endmodule"]]));
    const ctx = p.root("t")!;
    const up = collect(await traceSignal(p, ctx, "y", "upstream"));
    const a = up.find(n => n.label === "t.a"), b = up.find(n => n.label === "t.b");
    expect(a).toBeDefined(); expect(b).toBeDefined();
    expect(a!.note).toContain("sel"); expect(b!.note).toContain("sel");
    const selDown = flatten(await traceSignal(p, ctx, "sel", "downstream"));
    expect(selDown).toContain("不作为数据链展开");
    expect(selDown).not.toContain("t.y");
  });
  it("case 各分支并列，default 常量是终点", async () => {
    const p = new SignalProject(new Map([["t.v", `module t(input [1:0] s, input a, input b, output reg y);
      always @* case (s)
        2'b00: y = a;
        2'b01: y = b;
        default: y = 1'b0;
      endcase
    endmodule`]]));
    const up = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    expect(up.some(n => n.label === "t.a" && n.note?.includes("s"))).toBe(true);
    expect(up.some(n => n.label === "t.b" && n.note?.includes("s"))).toBe(true);
    expect(up.some(n => n.reason?.includes("常量") && n.label.includes("1'b0"))).toBe(true);
  });
  it("过程内运算穿透且中间变量链可追踪", async () => {
    const p = new SignalProject(new Map([["t.v", `module t(input a, input m, output reg y);
      reg t1;
      always @* begin
        t1 = a & m;
        y = t1;
      end
    endmodule`]]));
    const up = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    const t1 = up.find(n => n.label === "t.t1");
    expect(t1).toBeDefined();
    const a = up.find(n => n.label === "t.a"), m = up.find(n => n.label === "t.m");
    expect(a).toBeDefined(); expect(m).toBeDefined();
    expect(a!.note).toContain("a & m");
  });
  it("同一过程多次赋值列全部并提示覆盖", async () => {
    const p = new SignalProject(new Map([["t.v", "module t(input a, input b, output reg y); always @* begin y = a; y = b; end endmodule"]]));
    const up = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    const a = up.find(n => n.label === "t.a"), b = up.find(n => n.label === "t.b");
    expect(a).toBeDefined(); expect(b).toBeDefined();
    expect(a!.note).toContain("覆盖"); expect(b!.note).toContain("覆盖");
  });
  it("多个 always 驱动同一信号列全部并标注多驱动", async () => {
    const p = new SignalProject(new Map([["t.v", `module t(input c1, input c2, input a, input b, output reg y);
      always @(posedge c1) y <= a;
      always @(posedge c2) y <= b;
    endmodule`]]));
    const up = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    expect(up.some(n => n.label === "t.a" && n.note?.includes("多驱动"))).toBe(true);
    expect(up.some(n => n.label === "t.b" && n.note?.includes("多驱动"))).toBe(true);
  });
  it("begin/end 包裹的连续过程块全部收集，多驱动不误判", async () => {
    const p = new SignalProject(new Map([["t.v", `module t(input clk, input c2, input a, input b, input d, output reg y, output reg z);
      always @(posedge clk) begin y <= a; end
      always @(posedge c2) begin y <= b; end
      initial begin z = d; end
    endmodule`]]));
    const mod = p.module("t")!;
    expect(mod.assignments.map(a => `${a.target}@${a.proc}`)).toEqual(["y@0", "y@1", "z@2"]);
    const up = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    expect(up.some(n => n.label === "t.a" && n.note?.includes("多驱动"))).toBe(true);
    expect(up.some(n => n.label === "t.b" && n.note?.includes("多驱动"))).toBe(true);
    expect(collect(await traceSignal(p, p.root("t")!, "z", "upstream")).some(n => n.label === "t.d")).toBe(true);
  });
  it("位选、动态下标、函数调用和循环是断点并说明原因", async () => {
    const p = new SignalProject(new Map([["t.v", `module t(input [3:0] d, input [3:0] s, input a, output reg q, output reg r, output reg m);
      integer i;
      always @* q = d[3:0];
      always @* r = fn(a);
      always @* for (i = 0; i < 4; i = i + 1) m = s[i];
    endmodule`]]));
    const ctx = p.root("t")!;
    expect(flatten(await traceSignal(p, ctx, "q", "upstream"))).toContain("范围转换");
    expect(flatten(await traceSignal(p, ctx, "d", "downstream"))).toContain("范围转换");
    expect(flatten(await traceSignal(p, ctx, "r", "upstream"))).toContain("函数调用");
    const sDown = flatten(await traceSignal(p, ctx, "s", "downstream"));
    expect(sDown).toContain("循环");
    expect(sDown).not.toContain("t.m");
  });
  it("跨模块穿透寄存器形成完整链条", async () => {
    const p = new SignalProject(new Map([
      ["top.v", "module top(input a, input clk, output y); wire w; sub u1(.i(a), .c(clk), .o(w)); assign y = w; endmodule"],
      ["sub.v", "module sub(input i, input c, output reg o); always @(posedge c) o <= i; endmodule"],
    ]));
    const down = flatten(await traceSignal(p, p.root("top")!, "a", "downstream"));
    expect(down).toContain("top/u1.i");
    expect(down).toContain("top/u1.o");
    expect(down).toContain("top.w");
    expect(down).toContain("顶层输出");
    const up = flatten(await traceSignal(p, p.root("top")!, "y", "upstream"));
    expect(up).toContain("top/u1.i");
    expect(up).toContain("顶层输入");
  });
});

describe("信号链：VHDL 过程穿透（赋值池模型）", () => {
  it("时钟过程穿透，敏感表时钟不作为数据链展开", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(clk: in bit; d: in bit; q: out bit); end t;
      architecture rtl of t is begin
        process(clk) begin
          if rising_edge(clk) then q <= d; end if;
        end process;
      end rtl;`]]));
    const ctx = p.root("t")!;
    const up = collect(await traceSignal(p, ctx, "q", "upstream"));
    expect(up.some(n => n.label === "t.d" && n.tip?.includes("寄存器"))).toBe(true);
    expect(up.some(n => n.label.toLowerCase().includes("clk"))).toBe(false);
    const clkDown = flatten(await traceSignal(p, ctx, "clk", "downstream"));
    expect(clkDown).toContain("不作为数据链展开");
    expect(clkDown).not.toContain("t.q");
  });
  it("异步复位与使能作条件标注，常量是终点，复位不展开", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(clk: in bit; rst_n: in bit; en: in bit; d: in bit; q: out bit); end t;
      architecture rtl of t is begin
        process(clk, rst_n) begin
          if rst_n = '0' then q <= '0';
          elsif rising_edge(clk) then
            if en = '1' then q <= d; end if;
          end if;
        end process;
      end rtl;`]]));
    const ctx = p.root("t")!;
    const up = collect(await traceSignal(p, ctx, "q", "upstream"));
    const d = up.find(n => n.label === "t.d");
    expect(d).toBeDefined();
    expect(d!.note).toContain("en");
    expect(d!.tip).toContain("寄存器");
    expect(up.some(n => n.reason?.includes("常量"))).toBe(true);
    const rstDown = flatten(await traceSignal(p, ctx, "rst_n", "downstream"));
    expect(rstDown).toContain("不作为数据链展开");
    expect(rstDown).not.toContain("t.q");
  });
  it("组合 if/else 并列分支，选择信号只作标注", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(sel: in bit; a: in bit; b: in bit; y: out bit); end t;
      architecture rtl of t is begin
        process(all) begin
          if sel = '1' then y <= a; else y <= b; end if;
        end process;
      end rtl;`]]));
    const ctx = p.root("t")!;
    const up = collect(await traceSignal(p, ctx, "y", "upstream"));
    expect(up.some(n => n.label === "t.a" && n.note?.includes("sel"))).toBe(true);
    expect(up.some(n => n.label === "t.b" && n.note?.includes("sel"))).toBe(true);
    expect(flatten(await traceSignal(p, ctx, "sel", "downstream"))).toContain("不作为数据链展开");
  });
  it("case/when 各分支并列，others 常量是终点", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(s: in bit_vector(1 downto 0); a: in bit; b: in bit; y: out bit); end t;
      architecture rtl of t is begin
        process(all) begin
          case s is
            when "00" => y <= a;
            when "01" => y <= b;
            when others => y <= '0';
          end case;
        end process;
      end rtl;`]]));
    const up = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    expect(up.some(n => n.label === "t.a" && n.note?.includes("s"))).toBe(true);
    expect(up.some(n => n.label === "t.b" && n.note?.includes("s"))).toBe(true);
    expect(up.some(n => n.reason?.includes("常量"))).toBe(true);
  });
  it("位选下标、函数调用与循环是断点并说明原因", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(d: in bit_vector(3 downto 0); s: in bit_vector(3 downto 0); a: in bit; q: out bit; r: out bit; m: out bit); end t;
      architecture rtl of t is begin
        process(all) begin
          q <= d(3);
          r <= fn(a);
        end process;
        process(all) begin
          for i in 0 to 3 loop
            m <= s(i);
          end loop;
        end process;
      end rtl;`]]));
    const ctx = p.root("t")!;
    expect(flatten(await traceSignal(p, ctx, "q", "upstream"))).toContain("位选");
    expect(flatten(await traceSignal(p, ctx, "r", "upstream"))).toContain("位选");
    const sDown = flatten(await traceSignal(p, ctx, "s", "downstream"));
    expect(sDown).toContain("循环");
    expect(sDown).not.toContain("t.m");
  });
  it("变量赋值链穿透，运算符表达式全部信号列为候选", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(a: in bit; m: in bit; y: out bit); end t;
      architecture rtl of t is begin
        process(all)
          variable t1 : bit;
        begin
          t1 := a and m;
          y <= t1;
        end process;
      end rtl;`]]));
    const up = collect(await traceSignal(p, p.root("t")!, "y", "upstream"));
    expect(up.some(n => n.label === "t.t1")).toBe(true);
    expect(up.some(n => n.label === "t.a" && n.note?.includes("a and m"))).toBe(true);
    expect(up.some(n => n.label === "t.m")).toBe(true);
  });
  it("裸 end 与标签 end 收尾的过程不吞噬后续 process，多驱动按过程区分", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(a: in bit; b: in bit; y: out bit); end t;
      architecture rtl of t is begin
        p1: process(all) begin
          y <= a;
        end p1;
        process(all) begin
          y <= b;
        end;
      end rtl;`]]));
    const mod = p.module("t")!;
    expect(mod.assignments.map(a => `${a.target}@${a.proc}`)).toEqual(["y@0", "y@1"]);
    expect(mod.multiDriver.has("y")).toBe(true);
  });
  it("字符串字面量不产生赋值/读取边", async () => {
    const v = new SignalProject(new Map([["t.v", `module t(input a, output y);
      localparam MSG = "assign x = y;";
      assign y = a;
    endmodule`]]));
    expect(v.module("t")!.assignments.map(a => a.target)).toEqual(["y"]);
    const vhd = new SignalProject(new Map([["t.vhd", `entity t is port(a: in bit; y: out bit); end t;
      architecture rtl of t is constant MSG : string := "a <= b;"; begin y <= a; end rtl;`]]));
    expect(vhd.module("t")!.assignments.map(a => a.target)).toEqual(["y"]);
    const up = collect(await traceSignal(vhd, vhd.root("t")!, "y", "upstream"));
    expect(up.some(n => n.label === "t.a")).toBe(true);
    expect(up.some(n => n.label === "t.b")).toBe(false);
  });
  it("with...select 选择赋值产生边界，不把选项列表硬拆成条件链", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(sel: in bit; a: in bit; b: in bit; y: out bit); end t;
      architecture rtl of t is begin
        with sel select y <= a when '0', b when others;
      end rtl;`]]));
    const ctx = p.root("t")!;
    const up = flatten(await traceSignal(p, ctx, "y", "upstream"));
    expect(up).toContain("选择赋值（不继续推导）");
    expect(up).not.toContain("t.a");
    expect(up).not.toContain("t.b");
    const bDown = flatten(await traceSignal(p, ctx, "b", "downstream"));
    expect(bDown).toContain("选择赋值（不继续推导）");
    expect(bDown).not.toContain("t.y");
  });
  it("并发条件赋值 when/else：条件作标注，数据候选穿透", async () => {
    const p = new SignalProject(new Map([["t.vhd", `entity t is port(en: in bit; a: in bit; b: in bit; y: out bit); end t;
      architecture rtl of t is begin
        y <= a when en = '1' else b;
      end rtl;`]]));
    const ctx = p.root("t")!;
    const up = collect(await traceSignal(p, ctx, "y", "upstream"));
    expect(up.some(n => n.label === "t.a" && n.note?.includes("en"))).toBe(true);
    expect(up.some(n => n.label === "t.b")).toBe(true);
    expect(up.some(n => n.label === "t.en")).toBe(false);
  });
});

describe("信号链：VHDL/Verilog 混合工程", () => {
  it("链路从 Verilog 顶层穿过 VHDL 寄存器再回到 Verilog", async () => {
    const p = new SignalProject(new Map([
      ["top.v", "module top(input a, input clk, output y); wire w; child u(.i(a), .c(clk), .o(w)); assign y = w; endmodule"],
      ["child.vhd", `entity child is port(i: in bit; c: in bit; o: out bit); end child;
        architecture rtl of child is begin
          process(c) begin
            if rising_edge(c) then o <= i; end if;
          end process;
        end rtl;`],
    ]));
    const down = collect(await traceSignal(p, p.root("top")!, "a", "downstream"));
    expect(down.some(n => n.label === "top/u.i")).toBe(true);
    expect(down.some(n => n.label === "top/u.o" && n.tip?.includes("寄存器"))).toBe(true);
    expect(down.some(n => n.label === "top.w")).toBe(true);
    expect(down.some(n => n.reason === "顶层输出")).toBe(true);
    const up = flatten(await traceSignal(p, p.root("top")!, "y", "upstream"));
    expect(up).toContain("top/u.i");
    expect(up).toContain("顶层输入");
  });
});
