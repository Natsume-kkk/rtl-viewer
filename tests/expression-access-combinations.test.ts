import { describe, expect, it } from "vitest";
import { SignalProject } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";
import { expressionRelations, parseExpression } from "../src/analysis/expression";

function graph(source: string, signal: string, file = "access.vhd") {
  const files = new Map([[file, source]]), project = new SignalProject(files), ctx = project.root("top")!, comp = new ComputationProject(files, project);
  return { graph: localLogic(comp, project, ctx, signal), data: comp.moduleData(ctx)! };
}

describe("表达式角色与类型访问组合", () => {
  it("已知转换递归保留条件、地址和未知调用参数角色", () => {
    expect(expressionRelations(parseExpression("to_integer(unsigned(enable)) > 0", "vhdl"), "条件")).toContainEqual(expect.objectContaining({ name: "enable", role: "条件" }));
    expect(expressionRelations(parseExpression("word[$unsigned(addr)]", "verilog"))).toContainEqual(expect.objectContaining({ name: "addr", role: "地址" }));
    const unknown = expressionRelations(parseExpression("mystery($signed(word[index]))", "verilog"));
    expect(unknown).toContainEqual(expect.objectContaining({ name: "word", role: "调用参数", unknown: true }));
    expect(unknown).toContainEqual(expect.objectContaining({ name: "index", role: "地址", unknown: true }));
    const { graph: g } = graph("entity top is port(a:in bit; enable:in bit_vector(1 downto 0)); end; architecture rtl of top is signal q:bit_vector(1 downto 0); begin process(all) begin if to_integer(unsigned(enable)) > 0 then q(0)<=a; end if; end process; end;", "q");
    expect(g.edges.some(e => g.nodes.find(n => n.id === e.from)?.signal === "enable" && e.to === "q" && e.role === "条件" && e.control)).toBe(true);
  });

  it("转换后的动态下标不能成为子模块输出的被驱动目标", () => {
    const { graph: g } = graph("module top(input [1:0] addr,output [7:0] y); child u(.dout(y[$unsigned(addr)])); endmodule module child(output dout); assign dout=1'b0; endmodule", "addr", "access.v");
    expect(g.edges.some(e => e.to === "addr" && g.nodes.find(n => n.id === e.from)?.port?.name === "dout")).toBe(false);
    const { graph: target } = graph("module top(input [1:0] addr,output [7:0] y); child u(.dout(y[$unsigned(addr)])); endmodule module child(output dout); assign dout=1'b0; endmodule", "y", "access.v");
    expect(target.edges.some(e => e.to === "y" && target.nodes.find(n => n.id === e.from)?.port?.name === "dout")).toBe(true);
  });

  it("record 内向量字段的索引保留基对象与地址", () => {
    const { graph: g, data } = graph("entity top is port(index:in integer;q:out bit); end; architecture rtl of top is type pair_t is record data:bit_vector(1 downto 0); end record; signal packet:pair_t; begin q<=packet.data(index); end;", "q");
    expect(data.objects.get("packet")?.record?.fields[0].name).toBe("data");
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "packet", to: "q", role: "数据" }), expect.objectContaining({ from: "index", to: "q", role: "地址" })]));
    expect(g.nodes.some(n => n.signal === "data")).toBe(false);
  });

  it("嵌套 record 与 record 数组组合访问逐级保留对象和地址", () => {
    const { graph: g } = graph("entity top is port(row,index:in integer;q:out bit); end; architecture rtl of top is type inner_t is record data:bit_vector(3 downto 0); end record; type outer_t is record nested:inner_t; end record; type table_t is array(0 to 2) of outer_t; signal packets:table_t; begin q<=packets(row).nested.data(index); end;", "q");
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "packets", to: "q", role: "数据" }), expect.objectContaining({ from: "row", to: "q", role: "地址" }), expect.objectContaining({ from: "index", to: "q", role: "地址" })]));
  });

  it("内建向量多级 subtype 可索引，标量和循环 alias 不猜为数组", () => {
    const { graph: g } = graph("entity top is port(index:in integer;q:out bit); end; architecture rtl of top is subtype data_t is bit_vector(1 downto 0); subtype alias_t is data_t; signal word:alias_t; begin q<=word(index); end;", "q");
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "word", to: "q", role: "数据" }), expect.objectContaining({ from: "index", to: "q", role: "地址" })]));
    for (const declarations of ["signal counter:integer range 0 to 3;", "subtype loop_a is loop_b; subtype loop_b is loop_a; signal counter:loop_a;"]) {
      const { data } = graph(`entity top is port(index:in integer;q:out integer); end; architecture rtl of top is ${declarations} begin q<=counter(index); end;`, "q");
      expect(data.drivers.get("q")?.[0].expression.kind).toBe("call");
      expect(data.vectors.has("counter")).toBe(false);
    }
  });

  it("record 输出的位地址不会成为驱动目标，未确认字段不会当确定数组", () => {
    const source = "entity top is port(index:in integer); end; architecture rtl of top is type pair_t is record data:bit_vector(3 downto 0); end record; signal packet:pair_t; begin u:entity work.child port map(dout=>packet.data(to_integer(index))); end; entity child is port(dout:out bit); end; architecture rtl of child is begin dout<='0'; end;";
    const { graph: address } = graph(source, "index");
    expect(address.edges.some(e => e.to === "index" && address.nodes.find(n => n.id === e.from)?.port?.name === "dout")).toBe(false);
    const { graph: target } = graph(source, "packet");
    expect(target.edges.some(e => e.to === "packet" && target.nodes.find(n => n.id === e.from)?.port?.name === "dout")).toBe(true);
    const { data } = graph("entity top is port(index:in integer;q:out bit); end; architecture rtl of top is type pair_t is record value:bit; end record; signal packet:pair_t; begin q<=packet.missing(index); end;", "q");
    expect(data.drivers.get("q")?.[0].expression.kind).toBe("call");
    expect(data.vectors.has("packet.missing")).toBe(false);
  });

  it("非法循环 record 的分支访问分析受模块预算限制，不阻塞独立正常信号", () => {
    const source = "entity top is port(index:in integer;q:out bit); end; architecture rtl of top is signal ordinary:bit_vector(1 downto 0); type recursive_t is record a,b,c,d:recursive_t; value:bit_vector(1 downto 0); end record; signal packet:recursive_t; begin q<=ordinary(index); end;";
    const { data, graph: g } = graph(source, "q");
    expect(data.vectors.size).toBeLessThanOrEqual(1024);
    expect(g.edges).toContainEqual(expect.objectContaining({ from: "ordinary", to: "q", role: "数据" }));
  }, 2000);

  it("生成局部对象只把展示标签改为源码作用域，内部身份与原文不变", () => {
    const source = "module top(input a,output [1:0] y);generate for(genvar i=0;i<2;i++)begin:lanes wire w;assign w=a;for(genvar j=0;j<1;j++)begin:nested wire x;assign x=w;assign y[i]=x;end end endgenerate endmodule";
    const files = new Map([["labels.v", source]]), project = new SignalProject(files), ctx = project.root("top")!, comp = new ComputationProject(files, project);
    const selected = project.signalCandidates(ctx, "w", { file: "labels.v", line: 1, column: source.indexOf("w=a") + 1 })[1];
    const g = localLogic(comp, project, ctx, selected.name), root = g.nodes.find(n => n.id === g.root)!;
    expect(root.id).toBe(selected.name);
    expect(root.signal).toBe(selected.name);
    expect(root.label).toBe("lanes[1].w");
    expect(source.slice(root.source!.start, root.source!.end)).toBe("a");
    expect(root.drivers[0].expression.text).toBe("a");
    expect(g.nodes.some(n => n.label.includes("__gen_"))).toBe(false);
  });
});
