import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseExpression, expressionRelations } from "../src/analysis/expression";
import { ComputationProject } from "../src/analysis/project";
import { SignalProject } from "../src/model/signal-flow";
import { localLogic } from "../src/analysis/local";

const setup = (source: string, file = "objects.vhd") => {
  const files = new Map([[file, source]]), project = new SignalProject(files);
  const ctx = project.root("top")!, comp = new ComputationProject(files, project);
  return { project, ctx, comp };
};

describe("源码对象与访问关系", () => {
  it("自定义数组、record 和 ROM 初始化具有声明身份与原文", () => {
    const { comp, ctx } = setup(`entity top is port(addr: in integer; q: out bit_vector(7 downto 0)); end;
architecture rtl of top is
type rom_t is array (0 to 3) of bit_vector(7 downto 0);
type pair_t is record data: bit_vector(7 downto 0); valid: bit; end record;
constant ROM: rom_t := (0 => x"12", 1 => x"34", others => x"00");
signal payload: pair_t;
begin q <= ROM(addr); end;`);
    const data = comp.moduleData(ctx)!;
    expect(data.objects.get("rom_t")?.kind).toBe("type");
    expect(data.objects.get("rom")?.array?.elementType).toBe("bit_vector(7 downto 0)");
    expect(data.objects.get("rom")?.initializer).toContain('0 => x"12"');
    expect(data.objects.get("payload")?.record?.fields.map(f => f.name)).toEqual(["data", "valid"]);
    const graph = comp.trace("top", "q");
    expect(graph.nodes.some(n => n.signal === "rom" && n.kind === "constant")).toBe(true);
    expect(graph.edges.some(e => e.role === "地址")).toBe(true);
  });

  it("动态多维下标和 record 字段保留基对象，已知转换说明宽度与符号", () => {
    const e = parseExpression("mem[row][col] + packet.data", "verilog");
    expect(e.kind).toBe("op");
    expect(e.args[0].access?.kind).toBe("index");
    expect(e.args[0].args[0].access?.kind).toBe("index");
    expect(e.args[1].access).toEqual({ kind: "field", field: "data" });
    const convert = parseExpression("std_logic_vector(to_unsigned(value, 8))", "vhdl");
    expect(convert.conversion?.name).toBe("std_logic_vector");
    expect(convert.args[0].conversion).toEqual(expect.objectContaining({ name: "to_unsigned", width: "8", signed: false }));
    expect(expressionRelations(parseExpression("enable(index)", "vhdl", 0, new Set(["enable"])), "条件")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "enable", role: "条件" }),
      expect.objectContaining({ name: "index", role: "地址" }),
    ]));
    expect(expressionRelations(parseExpression("unknown_call(packet.data)", "verilog"))).toContainEqual(expect.objectContaining({ name: "packet", role: "调用参数", unknown: true }));
  });

  it("未知调用保留外层已知数据，参数关系明确为未知调用参数", () => {
    const { comp, project, ctx } = setup("module top(input a,b, output y); wire x; assign x = a + mystery(b); assign y = x; endmodule", "objects.v");
    const graph = localLogic(comp, project, ctx, "x");
    expect(graph.nodes.map(n => n.label)).toEqual(expect.arrayContaining(["a", "b", "x"]));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "a", to: "x", unknown: false }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "b", to: "x", role: "调用参数", unknown: true }));
    expect(graph.nodes.find(n => n.label === "x")?.reason).toContain("mystery");
  });

  it("动态部分写入保留地址、条件和独立正常目标，不误判为多驱动", () => {
    const { comp, project, ctx } = setup("module top(input clk,en,a,b, input [1:0] addr); reg [3:0] q; reg clean; always @(posedge clk) begin if(en) q[addr] <= a; clean <= b; end endmodule", "objects.v");
    const data = comp.moduleData(ctx)!;
    expect(data.drivers.get("clean")?.some(d => !d.relation)).toBe(true);
    expect(data.drivers.get("q")?.some(d => d.relation && d.targetText === "q[addr]")).toBe(true);
    const graph = localLogic(comp, project, ctx, "q");
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "addr", to: "q", role: "地址" }));
    expect(graph.edges.some(e => graph.nodes.find(n => n.id === e.from)?.signal === "en" && e.to === "q" && e.control)).toBe(true);
    expect(graph.nodes.find(n => n.label === "q")?.kind).not.toBe("resolved");
  });

  it("局部类型、constant 和变量不混入模块对象，不把同名局部读连接到模块信号", () => {
    const { comp, ctx } = setup(`entity top is port(a: in bit; q: out bit); end;
architecture rtl of top is signal shadow: bit; begin
process(all) type local_t is array(0 to 1) of bit; constant private_c: bit := '0'; variable shadow: bit;
begin shadow := a; q <= shadow; end process; end;`);
    const data = comp.moduleData(ctx)!;
    expect(data.objects.has("local_t")).toBe(false);
    expect(data.objects.has("private_c")).toBe(false);
    expect(data.objects.get("shadow")?.kind).toBe("signal");
    expect(data.drivers.has("shadow")).toBe(false);
  });

  it("枚举类型与成员保留声明身份，record 字段不是模块信号", () => {
    const vhdl = setup(`entity top is port(q: out bit); end; architecture rtl of top is
type state_t is (IDLE, RUN); signal state: state_t; begin state <= IDLE; end;`);
    const data = vhdl.comp.moduleData(vhdl.ctx)!;
    expect(data.objects.get("state_t")?.kind).toBe("type");
    expect(data.objects.get("idle")?.kind).toBe("constant");
    expect(localLogic(vhdl.comp, vhdl.project, vhdl.ctx, "state").nodes.find(n => n.signal === "idle")?.reason).toBeUndefined();
    const sv = setup("module top; typedef struct packed { logic [7:0] data; bit valid; } packet_t; packet_t packet; endmodule", "objects.sv");
    const svData = sv.comp.moduleData(sv.ctx)!;
    expect(svData.objects.get("packet")?.record?.fields.map(f => f.name)).toEqual(["data", "valid"]);
    expect(svData.objects.has("data")).toBe(false);
    expect(svData.objects.has("valid")).toBe(false);
  });

  it("时钟内部分写入保留已知状态身份，q/next 均不误报组合环", () => {
    const { comp, project, ctx } = setup("module top(input clk); reg [1:0] q; wire [1:0] next=~q; always @(posedge clk) q[0]<=next[0]; endmodule", "objects.v");
    for (const signal of ["q", "next"]) {
      const graph = localLogic(comp, project, ctx, signal);
      expect(graph.nodes.some(n => n.detail.includes("组合反馈"))).toBe(false);
      expect(graph.nodes.some(n => n.signal === "q" && n.kind === "current")).toBe(true);
      expect(graph.nodes.find(n => n.signal === "q" && n.kind !== "current")?.drivers.some(d => d.relation)).toBe(true);
    }
  });

  it("record 端口与 ROM 地址引用使用原对象身份，不生成虚构字段信号", () => {
    const { comp, project, ctx } = setup(`entity top is port(addr: in integer); end;
architecture rtl of top is type rom_t is array(0 to 3) of bit_vector(7 downto 0);
type pair_t is record data: bit_vector(7 downto 0); end record;
constant rom: rom_t := (x"00", x"01", x"02", x"03"); signal packet: pair_t;
begin child_inst: entity work.child port map(din => rom(addr)); packet.data <= rom(addr); end;
entity child is port(din: in bit_vector(7 downto 0)); end; architecture rtl of child is begin end;`);
    const graph = localLogic(comp, project, ctx, "packet");
    expect(graph.nodes.some(n => n.signal === "data")).toBe(false);
    expect(graph.edges.some(e => e.from === "rom" && e.to === "packet" && e.role === "数据")).toBe(true);
    expect(graph.edges.some(e => e.from === "addr" && e.to === "packet" && e.role === "地址")).toBe(true);
  });

  it("声明初值不与时钟更新形成多驱动，初值仍可阅读", () => {
    for (const [file, source] of [
      ["objects.v", "module top(input clk,d); reg q=0; always @(posedge clk) q<=d; endmodule"],
      ["objects.vhd", "entity top is port(clk,d: in bit); end; architecture rtl of top is signal q:bit:='0'; begin process(clk) begin if rising_edge(clk) then q<=d; end if; end process; end;"],
    ]) {
      const { comp, project, ctx } = setup(source, file), graph = localLogic(comp, project, ctx, "q");
      const target = graph.nodes.find(n => n.id === graph.root)!;
      expect(target.kind).toBe("register");
      expect(target.drivers.some(d => d.initialization)).toBe(true);
      expect(comp.trace("top", "q").nodes.find(n => n.signal === "q")?.kind).toBe("register");
    }
  });

  it("Verilog 同名用户函数不是 VHDL 转换，系统有符号转换才确认语义", () => {
    for (const text of ["resize(a, 8)", "unsigned(a)", "std_logic_vector(a)", "to_unsigned(a, 8)"]) {
      expect(parseExpression(text, "verilog").conversion).toBeUndefined();
    }
    expect(parseExpression("$signed(a)", "verilog").conversion?.signed).toBe(true);
    expect(parseExpression("$unsigned(a)", "verilog").conversion?.signed).toBe(false);
    expect(parseExpression("$signed(a)", "vhdl").conversion).toBeUndefined();
  });

  it("generate 特化缩短标识符后，未知副作用语句边界仍回指完整原文", () => {
    const source = "module child #(parameter LONG_PARAMETER=1)(input a,output reg [7:0] q,y); generate for(genvar wide_index=0;wide_index<1;wide_index=wide_index+1) begin : blocks always @* begin q[LONG_PARAMETER+wide_index]=a; mutate(q); y=q; end end endgenerate endmodule module top(input a,output [7:0] q,y); child #(.LONG_PARAMETER(2)) u(.a(a),.q(q),.y(y)); endmodule";
    const comp = new ComputationProject(new Map([["boundary.v", source]]));
    const data = comp.moduleData(comp.context("top/u")!)!;
    const boundary = data.drivers.get("q")?.[0].process?.boundaries?.find(b => b.text === "mutate(q);");
    expect(boundary).toBeDefined();
    expect(source.slice(boundary!.start, boundary!.end)).toBe("mutate(q);");
  });

  it("VHDL 部分时钟写入的 edge predicate 是已知控制，其他条件调用仍保留边界", () => {
    for (const clock of ["rising_edge", "falling_edge"]) {
      const { comp, project, ctx } = setup(`entity top is port(clk,a:in bit); end;
architecture rtl of top is signal q:bit_vector(1 downto 0); begin
process(clk) begin if ${clock}(clk) then q(0)<=a; end if; end process; end;`);
      const graph = localLogic(comp, project, ctx, "q");
      const edges = graph.edges.filter(e => graph.nodes.find(n => n.id === e.from)?.signal === "clk" && e.to === "q");
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every(e => e.control && e.role === "条件" && !e.unknown)).toBe(true);
    }
    const { comp, project, ctx } = setup(`entity top is port(clk,a:in bit); end;
architecture rtl of top is signal q:bit_vector(1 downto 0); begin
process(all) begin if unknown_predicate(clk) then q(0)<=a; end if; end process; end;`);
    const graph = localLogic(comp, project, ctx, "q");
    expect(graph.edges.some(e => graph.nodes.find(n => n.id === e.from)?.signal === "clk" && e.unknown && e.role === "调用参数")).toBe(true);
    const sampleFile = "tests/samples/analysis/analysis_top.vhd";
    const files = new Map([[sampleFile, readFileSync(sampleFile, "utf8")]]), sampleProject = new SignalProject(files);
    const sampleCtx = sampleProject.root("analysis_top")!;
    const sampleGraph = localLogic(new ComputationProject(files, sampleProject), sampleProject, sampleCtx, "lane_valid");
    const clocks = sampleGraph.edges.filter(e => sampleGraph.nodes.find(n => n.id === e.from)?.signal === "clk" && e.to === "lane_valid");
    expect(clocks.length).toBeGreaterThan(0);
    expect(clocks.every(e => e.control && e.role === "条件" && !e.unknown)).toBe(true);
    const enables = sampleGraph.edges.filter(e => sampleGraph.nodes.find(n => n.id === e.from)?.signal === "enable" && e.to === "lane_valid");
    expect(enables.length).toBeGreaterThan(0);
    expect(enables.every(e => e.control && e.role === "条件" && !e.unknown)).toBe(true);
  });
});
