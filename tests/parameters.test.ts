import { it, expect } from "vitest";
import { parseFile, parseFileDetail } from "../src/parser";

it("Verilog parameter 默认表达式按顶层逗号分隔，不把 localparam 当例化参数", () => {
  const mod = parseFile('module child #(parameter W=8, DEPTH=(1 << W), parameter MODE="FAST") (input clk); localparam X=0; endmodule', "child.v")[0];
  expect(mod.parameters).toEqual([{ name: "W", defaultValue: "8" }, { name: "DEPTH", defaultValue: "(1 << W)" }, { name: "MODE", defaultValue: '"FAST"' }]);
});
it("连接与参数中的字符串常量不丢失，注释不进入补全默认值", () => {
  const v = parseFileDetail('module t; child u(.MODE("a,b"), .a(x /* comment */)); endmodule', "t.v")[0];
  expect(v.instances[0].connections?.[0].expr).toBe('"a,b"');
  expect(v.instances[0].connections?.[1].expr).toBe("x");
  const h = parseFileDetail('entity t is end t; architecture rtl of t is begin u: child port map (MODE => "a,b", a => x); end rtl;', "t.vhd")[0];
  expect(h.instances[0].connections?.[0].expr).toBe('"a,b"');
  expect(parseFile('module m #(parameter W=8 /* width */)(input a); endmodule', "m.v")[0].parameters?.[0].defaultValue).toBe("8");
});
it("VHDL generic 提取名字与默认值，保留无默认值的必填项", () => {
  const mod = parseFile('entity child is generic (W, H : integer := 8; MODE : string := "FAST"; REQUIRED : integer); port (clk : in bit); end child;', "child.vhd")[0];
  expect(mod.parameters).toEqual([{ name: "W", defaultValue: "8" }, { name: "H", defaultValue: "8" }, { name: "MODE", defaultValue: '"FAST"' }, { name: "REQUIRED" }]);
});
