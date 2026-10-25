import { describe, expect, it } from "vitest";
import { findSignalDeclLine, findModuleSignalPosition } from "../src/model/signals";

it("刷新定位区分 Verilog 大小写，支持同一行多个模块及 VHDL 声明与实现", () => {
  const source="module a; wire mid; endmodule module b; wire mid; endmodule";
  expect(findModuleSignalPosition(source,"inline.v","b","mid")).toEqual({line:1,column:source.lastIndexOf("mid")+1});
  expect(findModuleSignalPosition(source,"inline.v","B","mid")).toBeUndefined();
  expect(findModuleSignalPosition(source,"inline.v","b","gone")).toBeUndefined();
  const vhdl="entity A is port(mid:in bit); end A; entity B is port(mid:in bit); end B; architecture rtl of B is signal w:bit; begin w<=mid; end rtl;";
  expect(findModuleSignalPosition(vhdl,"inline.vhd","b","MID")?.column).toBe(vhdl.indexOf("mid",vhdl.indexOf("entity B"))+1);
  expect(findModuleSignalPosition(vhdl,"inline.vhd","b","w")?.column).toBe(vhdl.indexOf("w:bit")+1);
});

describe("文件内信号声明定位", () => {
  it("verilog：ANSI 端口、体内 wire、多声明行均可定位", () => {
    const src = `module top(
  input  wire       clk,
  input  wire       rst_n,
  output reg  [7:0] data_o
);
  wire [7:0] s_data;
  wire a, b_en;
  assign data_o = s_data;
endmodule
`;
    expect(findSignalDeclLine(src, "top.v", "clk")).toBe(2);
    expect(findSignalDeclLine(src, "top.v", "s_data")).toBe(6);
    expect(findSignalDeclLine(src, "top.v", "b_en")).toBe(7);
    expect(findSignalDeclLine(src, "top.v", "missing_sig")).toBeUndefined();
  });

  it("verilog：注释与赋值行不误判", () => {
    const src = `module top;
  // wire fake_sig;
  wire real_sig;
  assign real_sig = fake_sig;
endmodule
`;
    expect(findSignalDeclLine(src, "top.v", "fake_sig")).toBeUndefined();
    expect(findSignalDeclLine(src, "top.v", "real_sig")).toBe(3);
  });

  it("vhdl：signal 与 entity 端口可定位，port map 连接不误判", () => {
    const src = `entity top is
  port (
    clk   : in  std_logic;
    q_out : out std_logic
  );
end entity;
architecture rtl of top is
  signal s_data : std_logic;
begin
  u_sub : entity work.sub_mod port map (clk => clk, q => s_data);
end architecture;
`;
    expect(findSignalDeclLine(src, "top.vhd", "clk")).toBe(3);
    expect(findSignalDeclLine(src, "top.vhd", "q_out")).toBe(4);
    expect(findSignalDeclLine(src, "top.vhd", "s_data")).toBe(8);
    expect(findSignalDeclLine(src, "top.vhd", "sub_mod")).toBeUndefined();
  });
});
