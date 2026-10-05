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

  it("Verilog：always 块带赋值目标（begin/end 与单语句）", () => {
    const items = extractOutline(
      `module m(input clk, input d, input en);
  reg q, r, s;
  always @(posedge clk) begin
    if (en) q <= d;
    r <= q;
  end
  always @(negedge clk) s <= q;
endmodule`,
      "m.v",
    );
    const procs = items.filter((i) => i.kind === "process").map((i) => i.name);
    expect(procs).toEqual([
      "always @(posedge clk) → q, r",
      "always @(negedge clk) → s",
    ]);
  });

  it("例化进大纲：inst : module 形式", () => {
    const items = extractOutline(
      `module top;
  sub #(.W(8)) u_sub (.a(a), .b(b));
  sub u_sub2 (.a(a));
endmodule`,
      "top.v",
    );
    const insts = items.filter((i) => i.kind === "instance");
    expect(insts.map((i) => [i.name, i.line])).toEqual([
      ["u_sub : sub", 2],
      ["u_sub2 : sub", 3],
    ]);
  });

  it("VHDL：process 带赋值目标", () => {
    const items = extractOutline(
      `entity top is
end entity;
architecture rtl of top is
  signal s_q, s_d : std_logic;
begin
  u_proc: process(clk)
  begin
    if rising_edge(clk) then
      s_q <= s_d;
    end if;
  end process;
end architecture;`,
      "top.vhd",
    );
    const proc = items.find((i) => i.kind === "process");
    expect(proc?.name).toBe("u_proc: process → s_q");
  });
});
