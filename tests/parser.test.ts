import { describe, expect, it } from "vitest";
import { parseFile, parseFileDetail, parseXci, scanDefinitions } from "../src/parser";
import { parseVerilogProcess, parseVhdlProcess } from "../src/parser/procedural";

describe("verilog 定义扫描（第一级）", () => {
  it("提取 module 定义名与行号", () => {
    const src = `// header
module top(input clk);
endmodule

module sub_mod;
endmodule
`;
    const defs = scanDefinitions(src, "a.v");
    expect(defs.map((d) => d.name)).toEqual(["top", "sub_mod"]);
    expect(defs[0].line).toBe(2);
    expect(defs[1].line).toBe(5);
  });

  it("注释与字符串中的 module 不算定义", () => {
    const src = `// module fake1;
/* module fake2; */
module real_mod;
// "module fake3;"
endmodule
`;
    expect(scanDefinitions(src, "a.v").map((d) => d.name)).toEqual(["real_mod"]);
  });
});

describe("verilog 完整解析（第二级）", () => {
  it("解析 ANSI 端口与参数化例化", () => {
    const src = `module top #(
  parameter WIDTH = 8
)(
  input  wire             clk,
  input  wire             rst_n,
  output reg  [WIDTH-1:0] data_o
);
  sub_mod #(
    .WIDTH (WIDTH),
    .DEPTH (4)
  ) u_sub (
    .clk   (clk),
    .rst_n (rst_n),
    .q     (data_o)
  );
endmodule

module sub_mod #(parameter WIDTH = 8, parameter DEPTH = 2)(
  input  wire             clk,
  input  wire             rst_n,
  output reg  [WIDTH-1:0] q
);
endmodule
`;
    const mods = parseFile(src, "top.v");
    expect(mods.map((m) => m.name)).toEqual(["top", "sub_mod"]);
    const top = mods[0];
    expect(top.ports.map((p) => p.name)).toEqual(["clk", "rst_n", "data_o"]);
    expect(top.ports[2].direction).toBe("output");
    expect(top.ports[2].width).toBe("[WIDTH-1:0]");
    expect(top.instances).toEqual([{ module: "sub_mod", inst: "u_sub", line: 8 }]);
  });

  it("注释与字符串里的例化不生效，关键字不误判", () => {
    const src = `module top(input clk, input d, output reg q);
  // fake_mod u_fake ( .clk(clk) );
  /* blk_mod u_blk ( .clk(clk) ); */
  assign s = "fake u_x ( .clk(clk) );";
  always @(posedge clk) begin
    q <= d;
  end
  real_mod u_real (
    .clk(clk)
  );
endmodule
`;
    const mods = parseFile(src, "top.v");
    expect(mods[0].instances).toEqual([{ module: "real_mod", inst: "u_real", line: 8 }]);
  });

  it("宏分支内的例化按文本扫到，解析不出不中断", () => {
    const src = `\`ifdef USE_A
module top;
  mod_a u_a ( .clk(clk) );
\`else
  mod_b u_b ( .clk(clk) );
\`endif
endmodule
`;
    const mods = parseFile(src, "top.v");
    expect(mods[0].instances.map((i) => i.module).sort()).toEqual(["mod_a", "mod_b"]);
  });

  it("一个文件多个 module 各自独立", () => {
    const src = `module a;
  child u_c1 (.x(1'b0));
endmodule
module b;
  child u_c2 (.x(1'b1));
endmodule
module child(input x);
endmodule
`;
    const mods = parseFile(src, "multi.v");
    expect(mods.map((m) => m.name)).toEqual(["a", "b", "child"]);
    expect(mods[0].instances[0].inst).toBe("u_c1");
    expect(mods[1].instances[0].inst).toBe("u_c2");
    expect(mods[2].instances).toEqual([]);
  });
});

describe("vhdl 解析", () => {
  const src = `library ieee;
use ieee.std_logic_1164.all;

entity top is
  port (
    clk    : in  std_logic;
    rst_n  : in  std_logic;
    data_o : out std_logic_vector(7 downto 0)
  );
end entity top;

architecture rtl of top is
begin
  u_sub : entity work.sub_mod
    port map (
      clk => clk,
      q   => data_o
    );

  u_legacy : component old_mod
    port map ( clk => clk );

  main : process(clk) is
  begin
    if rising_edge(clk) then
      null;
    end if;
  end process;
end architecture rtl;

entity sub_mod is
  port (
    clk : in  std_logic;
    q   : out std_logic_vector(7 downto 0)
  );
end entity;

architecture rtl of sub_mod is
begin
end architecture;
`;

  it("第一级提取 entity 定义", () => {
    const defs = scanDefinitions(src, "top.vhd");
    expect(defs.map((d) => d.name)).toEqual(["top", "sub_mod"]);
  });

  it("解析端口、例化归属到正确 entity，process 标签不误判", () => {
    const mods = parseFile(src, "top.vhd");
    expect(mods.map((m) => m.name)).toEqual(["top", "sub_mod"]);
    const top = mods[0];
    expect(top.ports.map((p) => p.name)).toEqual(["clk", "rst_n", "data_o"]);
    expect(top.ports[2].direction).toBe("out");
    expect(top.instances.map((i) => [i.module, i.inst])).toEqual([
      ["sub_mod", "u_sub"],
      ["old_mod", "u_legacy"],
    ]);
    expect(mods[1].instances).toEqual([]);
  });

  it("entity 后库名带空白、带架构选择器、generate 块内例化均可识别", () => {
    const src2 = `entity top2 is
end entity;

architecture rtl of top2 is
begin
  u_a : entity work.  sub_mod port map (clk => '0', q => open);
  u_b : entity work.sub_mod(rtl) port map (clk => '0', q => open);
  gen : for i in 0 to 1 generate
    u_c : entity work.sub_mod port map (clk => '0', q => open);
  end generate;
end architecture;
`;
    const mods = parseFile(src2, "top2.vhd");
    expect(mods[0].instances.map((i) => [i.module, i.inst])).toEqual([
      ["sub_mod", "u_a"],
      ["sub_mod", "u_b"],
      ["sub_mod", "u_c"],
    ]);
  });

  it("end <构造> <标签>; 收尾不破坏深度计数，同文件后续设计单元归属正确", () => {
    const src = `entity foo is
end entity foo;

architecture rtl of foo is
  function f return integer is
  begin
    return 0;
  end function f;

  procedure p is
  begin
    null;
  end procedure p;

  type t_rec is record
    a : integer;
  end record t_rec;
begin
  b1 : block is
  begin
    null;
  end block b1;

  p1 : process is
  begin
    null;
  end process p1;

  u_child : entity work.child port map (x => '0');
end architecture rtl;

entity bar is
end entity bar;

architecture rtl of bar is
begin
  u_child2 : entity work.child port map (x => '0');
end architecture rtl;
`;
    const mods = parseFile(src, "labeled.vhd");
    expect(mods.map((m) => m.name)).toEqual(["foo", "bar"]);
    expect(mods[0].instances.map((i) => [i.module, i.inst])).toEqual([["child", "u_child"]]);
    expect(mods[1].instances.map((i) => [i.module, i.inst])).toEqual([["child", "u_child2"]]);
  });
});

describe("verilog 语法变体覆盖", () => {
  it("例化数组与逗号分隔的多例化", () => {
    const src = `module top(input clk);
  leaf u_a (.x(clk)), u_b (.x(clk));
  leaf #(.W(1)) u_arr [7:0] (.x(clk));
  leaf u_c [3:0] (.x(clk)), u_d (.x(clk));
endmodule

module leaf #(parameter W = 1)(input x);
endmodule
`;
    const mods = parseFile(src, "top.v");
    expect(mods[0].instances.map((i) => [i.module, i.inst])).toEqual([
      ["leaf", "u_a"],
      ["leaf", "u_b"],
      ["leaf", "u_arr"],
      ["leaf", "u_c"],
      ["leaf", "u_d"],
    ]);
  });

  it("SystemVerilog interface 定义与例化按模块处理", () => {
    const src = `interface bus_if(input logic clk);
  logic [7:0] data;
  modport master(output data);
endinterface

module top(input clk);
  bus_if u_bus (.clk(clk));
endmodule
`;
    expect(scanDefinitions(src, "top.sv").map((d) => d.name)).toEqual(["bus_if", "top"]);
    const mods = parseFile(src, "top.sv");
    expect(mods.map((m) => m.name)).toEqual(["bus_if", "top"]);
    expect(mods[0].instances).toEqual([]);
    expect(mods[1].instances).toEqual([{ module: "bus_if", inst: "u_bus", line: 7 }]);
  });

  it("非 ANSI 端口风格提取端口名", () => {
    const src = `module legacy (clk, rst_n, q);
input clk;
input rst_n;
output [7:0] q;
endmodule
`;
    const mods = parseFile(src, "legacy.v");
    expect(mods[0].ports.map((p) => p.name)).toEqual(["clk", "rst_n", "q"]);
  });

  it("ANSI 端口逗号连写时，无方向项继承最近的方向与宽度", () => {
    const src = `module top(
  input clk, rst_n,
  input [7:0] a, b,
  output reg [3:0] x,
                 y,
  input c, output d,
  input wire [15:0] e, f
);
endmodule
`;
    const ports = parseFile(src, "top.v")[0].ports;
    expect(ports.map((p) => [p.name, p.direction, p.width])).toEqual([
      ["clk", "input", undefined],
      ["rst_n", "input", undefined],
      ["a", "input", "[7:0]"],
      ["b", "input", "[7:0]"],
      ["x", "output", "[3:0]"],
      ["y", "output", "[3:0]"],
      ["c", "input", undefined],
      // 显式方向重新开始：d 不继承 c 项之前的宽度
      ["d", "output", undefined],
      ["e", "input", "[15:0]"],
      ["f", "input", "[15:0]"],
    ]);
  });

  it("module 名与端口表之间的属性不干扰端口与例化解析", () => {
    const src = `(* keep = "true" *) module top (* dont_touch = "yes" *) (input clk);
  leaf u_l (.x(clk));
endmodule
`;
    const mods = parseFile(src, "top.v");
    expect(mods[0].ports.map((p) => p.name)).toEqual(["clk"]);
    expect(mods[0].instances.map((i) => i.inst)).toEqual(["u_l"]);
  });
});

describe("vhdl 语法变体覆盖", () => {
  it("end architecture <名>; 与 end <架构名>; 结尾下例化归属正确", () => {
    const src = `entity a is end entity;
architecture rtl of a is
begin
  u_x : entity work.x port map (clk => '0');
end architecture rtl;

entity b is end entity;
architecture beh of b is
begin
  u_y : entity work.y port map (clk => '0');
end beh;
`;
    const mods = parseFile(src, "ab.vhd");
    expect(mods.map((m) => m.name)).toEqual(["a", "b"]);
    expect(mods[0].instances.map((i) => i.module)).toEqual(["x"]);
    expect(mods[1].instances.map((i) => i.module)).toEqual(["y"]);
  });

  it("architecture 内函数以裸 end; 收尾不截断后续例化", () => {
    // function/procedure 允许裸 end;（不带关键字与名称）收尾，不得被当作 architecture 终点
    const src = `entity a is end;
architecture rtl of a is
  function add1(x : integer) return integer is
  begin
    return x + 1;
  end;
begin
  u_x : entity work.x port map (clk => '0');
end;
`;
    const mods = parseFile(src, "a.vhd");
    expect(mods.map((m) => m.name)).toEqual(["a"]);
    expect(mods[0].instances.map((i) => i.module)).toEqual(["x"]);
  });

  it("port 支持 linkage 模式与逗号多名字", () => {
    const src = `entity e is
  port (
    a, b : in std_logic;
    c : linkage std_logic
  );
end entity;
`;
    const mods = parseFile(src, "e.vhd");
    expect(mods[0].ports.map((p) => p.name)).toEqual(["a", "b", "c"]);
    expect(mods[0].ports[2].direction).toBe("linkage");
  });

  it("关键字大小写不敏感", () => {
    const src = `ENTITY TOP IS END ENTITY;
ARCHITECTURE RTL OF TOP IS
BEGIN
  U1 : ENTITY WORK.SUB_MOD PORT MAP (CLK => '0');
END ARCHITECTURE;
`;
    const mods = parseFile(src, "t.vhd");
    expect(mods[0].instances).toEqual([{ module: "SUB_MOD", inst: "U1", line: 4 }]);
  });

  it("generic map 与 port map 并列、跨行的例化", () => {
    const src = `entity top is end entity;
architecture rtl of top is
begin
  u_g : entity work.sub_mod
    generic map (W => 8)
    port map (clk => '0');
  u_c : component old_mod
    generic map (W => 4)
    port map (clk => '0');
end architecture;
`;
    const mods = parseFile(src, "t.vhd");
    expect(mods[0].instances.map((i) => [i.module, i.inst])).toEqual([
      ["sub_mod", "u_g"],
      ["old_mod", "u_c"],
    ]);
  });

  it("只有 generic map 的例化不错抓下一个例化的 port map", () => {
    const src = `entity top is end entity;
architecture rtl of top is
begin
  u1 : entity work.sub_mod
    generic map (W => 8);
  u2 : entity work.other
    port map (clk => clk);
end architecture;
`;
    const mods = parseFileDetail(src, "top.vhd");
    const [i1, i2] = mods[0].instances;
    expect(i1.inst).toBe("u1");
    expect(i1.connections).toBeUndefined();
    expect(i1.endLine).toBeUndefined();
    expect(i2.inst).toBe("u2");
    expect(i2.connections).toEqual([{ port: "clk", expr: "clk", line: 7 }]);
    expect(i2.endLine).toBe(7);
  });

  it("architecture 与 entity 分文件时，例化保留并归属 entity 名", () => {
    const src = `architecture rtl of top is
begin
  u_sub : entity work.sub_mod port map (clk => clk);
end architecture;
`;
    const mods = parseFile(src, "top_rtl.vhd");
    expect(mods).toHaveLength(1);
    expect(mods[0].name).toBe("top");
    expect(mods[0].file).toBe("top_rtl.vhd");
    expect(mods[0].instances.map((i) => [i.module, i.inst])).toEqual([["sub_mod", "u_sub"]]);
  });

  it("字符串内容（含 -- 与伪例化文本）与 VHDL-2008 块注释不参与扫描", () => {
    const src = `entity top is end entity;
architecture rtl of top is
begin
  report "-------- u_fake : entity work.sub_mod port map (clk => clk);";
  /* u_blk : entity work.sub_mod port map (clk => clk);
     entity fake_ent is */
  u_real : entity work.sub_mod port map (clk => clk);
end architecture;
`;
    const mods = parseFile(src, "t.vhd");
    expect(mods.map((m) => m.name)).toEqual(["top"]);
    expect(mods[0].instances.map((i) => i.inst)).toEqual(["u_real"]);
    expect(mods[0].instances[0].line).toBe(7);
  });

  it("vector 端口 width 无尾随空格，标量端口无 width", () => {
    const src = `entity e is
  port (
    q : out std_logic_vector(7 downto 0);
    s : in std_logic
  );
end entity;
`;
    const ports = parseFile(src, "e.vhd")[0].ports;
    expect(ports[0].width).toBe("std_logic_vector(7 downto 0)");
    expect(ports[1].width).toBeUndefined();
  });
});

describe("例化端口连接提取（悬停端口映射用）", () => {
  it("verilog 命名连接跨行提取端口、表达式与行号", () => {
    const src = `module top(input clk, input rst_n, output [7:0] q);
  wire [7:0] s_data;
  sub_mod u_sub (
    .clk   (clk),
    .rst_n (rst_n),
    .q     (s_data)
  );
endmodule
module sub_mod(input clk, input rst_n, output [7:0] q);
endmodule
`;
    const mods = parseFileDetail(src, "top.v");
    const inst = mods[0].instances[0];
    expect(inst.connections).toEqual([
      { port: "clk", expr: "clk", line: 4 },
      { port: "rst_n", expr: "rst_n", line: 5 },
      { port: "q", expr: "s_data", line: 6 },
    ]);
    expect(inst.endLine).toBe(7);
  });

  it("verilog 参数覆盖不进连接表，位置连接无端口名", () => {
    const src = `module top(input clk);
  sub_mod #(.WIDTH(8), .DEPTH(4)) u_sub (clk, 1'b0, {a, b});
endmodule
`;
    const inst = parseFileDetail(src, "top.v")[0].instances[0];
    expect(inst.connections).toEqual([
      { expr: "clk", line: 2 },
      { expr: "1'b0", line: 2 },
      { expr: "{a, b}", line: 2 },
    ]);
  });

  it("verilog 空连接与默认 parseFile 不带连接字段", () => {
    const src = `module top;
  sub_mod u_sub (.clk(), .rst_n(rst_n));
endmodule
`;
    const inst = parseFileDetail(src, "top.v")[0].instances[0];
    expect(inst.connections).toEqual([
      { port: "clk", expr: "", line: 2 },
      { port: "rst_n", expr: "rst_n", line: 2 },
    ]);
    const plain = parseFile(src, "top.v")[0].instances[0];
    expect(plain.connections).toBeUndefined();
    expect(plain.endLine).toBeUndefined();
  });

  it("vhdl port map 命名与位置连接混排", () => {
    const src = `entity top is
end entity;
architecture rtl of top is
  signal s_clk : std_logic;
begin
  u_sub : entity work.sub_mod(rtl)
    generic map (WIDTH => 8)
    port map (
      clk    => s_clk,
      rst_n  => rst_n,
      data_o
    );
end architecture;
`;
    const mods = parseFileDetail(src, "top.vhd");
    const inst = mods[0].instances[0];
    expect(inst.connections).toEqual([
      { port: "clk", expr: "s_clk", line: 9 },
      { port: "rst_n", expr: "rst_n", line: 10 },
      { expr: "data_o", line: 11 },
    ]);
    expect(inst.endLine).toBe(12);
  });
});

describe("vhdl 过程体语句解析", () => {
  it("子程序调用语句产生调用边界，不静默跳过", () => {
    const parsed = parseVhdlProcess(`process(clk) begin
  incr(cnt);
  y <= a;
end process;`);
    expect(parsed.boundaries.some(b => b.reason.includes("调用"))).toBe(true);
    expect(parsed.assignments.map(a => a.target)).toEqual(["y"]);
  });

  it("位选/索引赋值保持位选边界，不判为调用", () => {
    const parsed = parseVhdlProcess(`process(clk) begin
  a(3) <= x;
  arr(i) := x;
end process;`);
    expect(parsed.assignments).toEqual([]);
    expect(parsed.boundaries.map(b => b.reason)).toEqual([
      "位选/切片赋值（范围转换）",
      "位选/切片赋值（范围转换）",
    ]);
  });
});

describe("过程表达式字面量遮蔽", () => {
  it("verilog 字符串内容不产生读取，表达式展示保留原文", () => {
    const parsed = parseVerilogProcess(`always @(*) begin
  x = "hello";
  y = c;
end`);
    expect(parsed.assignments).toHaveLength(2);
    expect(parsed.assignments[0].reads).toEqual([]);
    expect(parsed.assignments[0].expression).toBe('"hello"');
    expect(parsed.assignments[1].reads).toEqual(["c"]);
  });

  it("verilog 字符串内的分号与括号不打断语句切分", () => {
    const parsed = parseVerilogProcess(`always @(*) begin
  x = "a;(b";
  y = c;
end`);
    expect(parsed.assignments.map(a => a.target)).toEqual(["x", "y"]);
    expect(parsed.assignments[0].reads).toEqual([]);
  });

  it("verilog 转义引号不提前结束字符串", () => {
    const parsed = parseVerilogProcess(`always @(*) begin
  x = "a\\"b";
  y = c;
end`);
    expect(parsed.assignments.map(a => a.target)).toEqual(["x", "y"]);
    expect(parsed.assignments[0].reads).toEqual([]);
  });

  it("verilog 条件中的字符串不产生控制信号", () => {
    const parsed = parseVerilogProcess(`always @(*) begin
  if (mode == "run") x = a;
end`);
    expect(parsed.controlSignals).toEqual(["mode"]);
    expect(parsed.assignments[0].reads).toEqual(["a"]);
  });

  it("vhdl 字符串与字符/基符字面量是值不是标识符", () => {
    const parsed = parseVhdlProcess(`process(clk) begin
  a <= "hello";
  b <= 'U';
  c <= x"FF";
  d <= e;
end process;`);
    expect(parsed.assignments.map(a => a.target)).toEqual(["a", "b", "c", "d"]);
    expect(parsed.assignments[0].reads).toEqual([]);
    expect(parsed.assignments[0].expression).toBe('"hello"');
    expect(parsed.assignments[1].reads).toEqual([]);
    expect(parsed.assignments[2].reads).toEqual([]);
    expect(parsed.assignments[3].reads).toEqual(["e"]);
  });

  it("vhdl 字符串内的分号不打断语句切分", () => {
    const parsed = parseVhdlProcess(`process(clk) begin
  a <= "x;y";
  b <= c;
end process;`);
    expect(parsed.assignments.map(a => a.target)).toEqual(["a", "b"]);
    expect(parsed.assignments[0].reads).toEqual([]);
  });
});

describe("xci 解析", () => {
  it("实例名取文件名，VLNV 从 XML 提取", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<spirit:component>
  <spirit:vendor>xilinx.com</spirit:vendor>
  <spirit:library>ip</spirit:library>
  <spirit:name>clk_wiz</spirit:name>
  <spirit:version>6.0</spirit:version>
</spirit:component>`;
    const info = parseXci(content, "D:/proj/ip/clk_wiz_0/clk_wiz_0.xci");
    expect(info.name).toBe("clk_wiz_0");
    expect(info.vlnv).toBe("xilinx.com:ip:clk_wiz:6.0");
  });

  it("缺字段时无 VLNV 不报错", () => {
    const info = parseXci("<spirit:component/>", "my_ip.xci");
    expect(info.name).toBe("my_ip");
    expect(info.vlnv).toBeUndefined();
  });
});
