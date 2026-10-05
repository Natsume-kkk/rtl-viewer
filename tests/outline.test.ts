import { describe, expect, it } from "vitest";
import { extractOutline } from "../src/model/outline";

describe("文件大纲提取", () => {
  it("Verilog：模块、信号、always、函数按行排序", () => {
    const items = extractOutline(
      `// 注释里的 wire fake; 不算
module top(input clk);
  wire a, b;
  reg [7:0] data = 8'd0;
  /* block reg nope; */
  always @(posedge clk) begin
  end
  function automatic [3:0] f1;
  endfunction
endmodule`,
      "top.v",
    );
    expect(items.map((i) => [i.kind, i.name, i.line])).toEqual([
      ["module", "top", 2],
      ["signal", "a", 3],
      ["signal", "b", 3],
      ["signal", "data", 4],
      ["process", "always @(posedge clk)", 6],
      ["function", "f1", 8],
    ]);
  });

  it("SystemVerilog：logic 多声明与 always_ff", () => {
    const items = extractOutline(
      `module m;
  logic signed [3:0] x, y;
  always_ff @(posedge clk) begin
  end
endmodule`,
      "m.sv",
    );
    expect(items.filter((i) => i.kind === "signal").map((i) => i.name)).toEqual(["x", "y"]);
    expect(items.find((i) => i.kind === "process")?.name).toBe("always_ff @(posedge clk)");
  });

  it("VHDL：entity、architecture、signal、带标号 process", () => {
    const items = extractOutline(
      `-- signal fake : std_logic;
library ieee;
entity top is
end entity;
architecture rtl of top is
  signal s_a, s_b : std_logic;
begin
  u_proc: process(clk)
  begin
  end process;
end architecture;`,
      "top.vhd",
    );
    expect(items.map((i) => [i.kind, i.name, i.line])).toEqual([
      ["module", "top", 3],
      ["architecture", "rtl (top)", 5],
      ["signal", "s_a", 6],
      ["signal", "s_b", 6],
      ["process", "u_proc: process", 8],
    ]);
  });

  it("非 HDL 扩展名按 Verilog 规则兜底，不抛异常", () => {
    expect(() => extractOutline("module m; endmodule", "a.txt")).not.toThrow();
    expect(extractOutline("module m; endmodule", "a.txt")[0].name).toBe("m");
  });
});
