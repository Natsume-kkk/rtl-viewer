import { describe, expect, it } from "vitest";
import { parseExpression, formatExpr } from "../src/analysis/expression";
import { analyzeProcess } from "../src/analysis/process";
import { ComputationProject } from "../src/analysis/project";

describe("运算图表达式", () => {
  it("按优先级生成运算树，并保留切片、拼接和条件的角色", () => {
    const e = parseExpression("a + b * c > 255 ? 8'd255 : result[7:0]", "verilog");
    expect(e.kind).toBe("select");
    expect(e.args[0].value).toBe(">");
    expect(e.args[0].args[0].args[1].value).toBe("*");
    expect(e.args[2].kind).toBe("slice");
    expect(parseExpression("{1'b0, data_in}", "verilog").kind).toBe("concat");
  });
  it("VHDL when/else 是有序条件选择，已声明向量才解析为切片", () => {
    expect(parseExpression("a when en = '1' else b", "vhdl").kind).toBe("select");
    expect(parseExpression("data(7 downto 0)", "vhdl", 0, new Set(["data"])).kind).toBe("slice");
    expect(parseExpression("to_unsigned(n, 20)", "vhdl").kind).toBe("call");
  });
  it("不吞掉未知语法、动态下标、四态常量或恶意文本", () => {
    expect(parseExpression("a inside {b}", "verilog").kind).toBe("unknown");
    expect(parseExpression("a[i]", "verilog").kind).toBe("unknown");
    expect(parseExpression("1'bz", "verilog").value).toBe("1'bz");
    expect(parseExpression("<img src=x>", "verilog").kind).toBe("unknown");
  });
});

describe("运算图过程语义", () => {
  const verilog = (body: string) => analyzeProcess(`always @(posedge clk) begin ${body} end`, "verilog");
  it("非阻塞读旧值，阻塞读已更新值", () => {
    const nb = verilog("a <= b; q <= a;");
    const bl = verilog("a = b; q <= a;");
    expect(formatExpr(nb.updates.get("q")!)).toBe("a");
    expect(bl.updates.get("q")!.kind).toBe("cast");
    expect(bl.updates.get("q")!.value).toBe("a");
    expect(bl.updates.get("q")!.args[0].value).toBe("b");
  });
  it("同过程后赋值覆盖先赋值，同时保留条件成立时的覆盖", () => {
    const p = verilog("q <= a; if (en) q <= b;");
    expect(formatExpr(p.updates.get("q")!)).toBe("if en then b else a");
    expect(formatExpr(verilog("q <= a; q <= b;").updates.get("q")!)).toBe("b");
  });
  it("分支条件使用进入分支时的值，不受分支内部写入改变", () => {
    const p = verilog("if (en) begin en = 0; q <= a; end");
    expect(formatExpr(p.updates.get("q")!)).toBe("if en then a else q");
  });
  it("复位、时钟和保持明确，沿敏感表不把异步复位当成另一个时钟", () => {
    const p = analyzeProcess("always @(posedge clk or negedge rst_n) begin if (!rst_n) q <= 0; else if (en) q <= d; end", "verilog");
    expect(p.clock).toBe("posedge clk");
    expect(p.events).toEqual(["posedge clk", "negedge rst_n"]);
    expect(formatExpr(p.updates.get("q")!)).toContain("if en then d else q");
    expect(p.mode).toBe("clocked");
  });
  it("VHDL 变量立即生效，信号赋值读取旧值，elsif 保留优先级", () => {
    const p = analyzeProcess("process(clk) variable tmp: bit; begin if rising_edge(clk) then tmp := a; q <= tmp; a <= b; z <= a; end if; end process;", "vhdl");
    expect(p.updates.get("q")!.value).toBe("tmp");
    expect(p.updates.get("q")!.args[0].value).toBe("a");
    expect(formatExpr(p.updates.get("z")!)).toBe("a");
    expect(p.locals).toContain("tmp");
    const c = analyzeProcess("process(all) begin if a='1' then q<=x; elsif b='1' then q<=y; else q<=z; end if; end process;", "vhdl");
    const q = c.updates.get("q")!;
    expect(q.args[0].value).toBe("=");
    expect(q.args[1].value).toBe("x");
    expect(q.args[2].kind).toBe("select");
    expect(q.args[2].args.slice(1).map(e => e.value)).toEqual(["y", "z"]);
  });
  it("组合缺省保留显式存储提示；不支持的循环和部分写入使过程停止推导", () => {
    expect(analyzeProcess("always @* if(en) q = d;", "verilog").mode).toBe("combinational");
    expect(verilog("for(i=0;i<8;i=i+1) q<=a;").issues.length).toBeGreaterThan(0);
    expect(verilog("q[0] <= a;").issues.length).toBeGreaterThan(0);
    expect(verilog("q[0] <= a;").updates.size).toBe(0);
  });
  it("case 精确匹配和 default 合并，casex 保留边界", () => {
    const p = verilog("case(sel) 2'b00: q<=a; 2'b01,2'b10: q<=b; default: q<=c; endcase");
    expect(p.issues).toEqual([]);
    expect(formatExpr(p.updates.get("q")!)).toContain("===");
    expect(formatExpr(p.updates.get("q")!)).toContain("else c");
    expect(verilog("casex(sel) 2'b0x: q<=a; endcase").mode).toBe("boundary");
  });
  it("VHDL case、后写覆盖及组合保持均保留过程语义", () => {
    const p = analyzeProcess("process(all) begin q<=a; case sel is when '0' => q<=b; when others => null; end case; end process;", "vhdl");
    expect(formatExpr(p.updates.get("q")!)).toBe("if (sel = '0') then b else a");
    expect(p.updates.get("q")!.procedural).toBe(true);
  });
  it("阻塞赋值的窄化转换没有被代入优化抹去", () => {
    const p = verilog("a = wide; q <= a + 1;");
    expect(p.updates.get("q")!.args[0].kind).toBe("cast");
    expect(p.updates.get("q")!.args[0].value).toBe("a");
  });
  it("混合赋值、错误源码和过深表达式不产生可靠更新声明", () => {
    expect(verilog("q = a; q <= b;").mode).toBe("boundary");
    expect(verilog("if (en) begin q <= a;").updates.size).toBe(0);
    expect(parseExpression("(".repeat(150) + "a" + ")".repeat(150), "verilog").kind).toBe("unknown");
  });
});

describe("运算图跨模块与双向端口", () => {
  const files = new Map([
    ["top.v", "module top(input clk,en, inout dq, output sampled); wire dq_in; wire dq_out; assign dq = en ? dq_out : 1'bz; assign dq_in = dq; child u(.clk(clk),.din(dq_in),.dout(dq_out),.q(sampled)); endmodule"],
    ["child.vhd", "entity child is port(clk,din:in bit; dout,q:out bit); end child; architecture rtl of child is begin dout <= '0'; process(clk) begin if rising_edge(clk) then q <= din; end if; end process; end rtl;"],
  ]);
  it("连接来源含外部驱动、内部三态选择及子模块输出", () => {
    const p = new ComputationProject(files);
    const g = p.trace("top", "dq_in", 5);
    expect(g.nodes.some(n => n.kind === "resolved")).toBe(true);
    expect(g.nodes.some(n => n.kind === "external")).toBe(true);
    expect(g.nodes.some(n => n.label.includes("释放驱动"))).toBe(true);
    expect(g.nodes.some(n => n.path === "top/u" && n.signal === "dout")).toBe(true);
  });
  it("负载从真实绑定生成，反向展开复用模块时不串实例", () => {
    const p = new ComputationProject(files);
    expect(p.loads("top", "dq_in").some(n => n.path === "top/u" && n.signal === "din")).toBe(true);
    const g = p.trace("top/u", "q", 5);
    expect(g.nodes.some(n => n.path === "top" && n.signal === "dq_in")).toBe(true);
    expect(g.nodes.some(n => n.kind === "current")).toBe(false);
  });
  it("连续多驱动不伪装成优先级选择，反馈不会无限展开", () => {
    const p = new ComputationProject(new Map([["t.v", "module t(input a,b); wire q; assign q=a; assign q=b; wire x; assign x=x+1; endmodule"]]));
    expect(p.trace("t", "q").nodes.some(n => n.kind === "resolved")).toBe(true);
    expect(p.trace("t", "x", 20).nodes.length).toBeLessThan(20);
  });
  it("不支持过程中的比较条件不被误报成另一个驱动", () => {
    const p = new ComputationProject(new Map([["t.vhd", `entity t is port(clk,a: in bit; q: out bit); end t;
architecture rtl of t is signal state: bit; signal data: bit_vector(0 to 7); begin
process(clk) begin if rising_edge(clk) then state <= a; end if; end process;
process(clk) begin if rising_edge(clk) then if state = '1' then data(0) <= a; end if; end if; end process;
q <= state; end rtl;`]]));
    const g = p.trace("t", "state");
    expect(g.nodes.find(n => n.id === g.root)?.kind).toBe("register");
    expect(p.loads("t", "a").some(l => l.signal === "data" && l.label.includes("分析边界"))).toBe(true);
  });
  it("同模块两个实例按路径绑定，函数调用不伪装为已知运算", () => {
    const p = new ComputationProject(new Map([["t.v", `module t(input a,b, output x,y); child u1(.a(a),.q(x)); child u2(.a(b),.q(y)); endmodule
module child(input a,output q); assign q=a; endmodule`]]));
    const g = p.trace("t/u2", "q", 5);
    expect(g.nodes.some(n => n.path === "t" && n.signal === "b")).toBe(true);
    expect(g.nodes.some(n => n.path === "t" && n.signal === "a")).toBe(false);
    const call = new ComputationProject(new Map([["f.v", "module f(input a,output q); assign q=foo(a); endmodule"]])).trace("f", "q");
    expect(call.nodes.some(n => n.kind === "boundary" && n.label === "foo(a)")).toBe(true);
  });
  it("同一文件多模块的驱动源码偏移按真实位置计算", () => {
    const source = [
      "module first(input a, output q);",
      "assign q = a;",
      "endmodule",
      "module second(input b, output r);",
      "wire m;",
      "assign m = b;",
      "assign r = m;",
      "endmodule",
    ].join("\n");
    const p = new ComputationProject(new Map([["multi.v", source]]));
    const g = p.trace("second", "r", 5);
    const rLine = source.indexOf("assign r = m;");
    expect(g.nodes.find(n => n.id === g.root)?.source).toEqual({ file: "multi.v", start: rLine + 11, end: rLine + 12 });
    const mLine = source.indexOf("assign m = b;");
    expect(g.nodes.find(n => n.signal === "m")?.source).toEqual({ file: "multi.v", start: mLine + 11, end: mLine + 12 });
    expect(g.nodes.some(n => n.signal === "a" || n.signal === "q")).toBe(false);
  });
  it("多个子模块输出同接一根线也明确列为多来源", () => {
    const p = new ComputationProject(new Map([["t.v", "module t(output q); c u1(.q(q)); c u2(.q(q)); endmodule module c(output q); assign q=1'b0; endmodule"]]));
    const g = p.trace("t", "q");
    expect(g.nodes.find(n => n.id === g.root)?.kind).toBe("resolved");
  });
});
