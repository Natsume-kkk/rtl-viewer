import { describe, expect, it } from "vitest";
import { extractOutline, itemAtLine, breadcrumbAt } from "../src/model/outline";

describe("文件大纲提取", () => {
  it("always @*、@(*) 及裸 always_comb/latch 的赋值目标都进大纲", () => {
    const text = "module top;\nalways @* q = d;\nalways @(*) r = d;\nalways_comb s = d;\nalways_latch t = d;\nendmodule";
    const names = extractOutline(text, "top.sv").filter(item => item.kind === "process").map(item => item.name);
    expect(names).toEqual(["always @* → q", "always @(*) → r", "always_comb → s", "always_latch → t"]);
  });
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

  it("Verilog：begin 独占下一行的 always 块也能提到赋值目标", () => {
    const items = extractOutline(
      `module m(input clk, input d);
  reg q, r;
  always @(posedge clk)
  begin
    q <= d;
    r <= q;
  end
endmodule`,
      "m.v",
    );
    const proc = items.find((i) => i.kind === "process");
    expect(proc?.name).toBe("always @(posedge clk) → q, r");
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

describe("大纲光标跟随", () => {
  const items = extractOutline(
    `module top(input clk);
  wire a;
  always @(posedge clk) begin
    a <= 1'b0;
  end
  always @(*) begin
  end
endmodule`,
    "top.v",
  );
  // 行号：module=1, wire=2, always#1=3, always#2=6

  it("itemAtLine：光标落在最后一个起点不晚于该行的条目", () => {
    expect(itemAtLine(items, 1)?.name).toBe("top");
    expect(itemAtLine(items, 2)?.name).toBe("a");
    expect(itemAtLine(items, 4)?.kind).toBe("process"); // always 块内部归到块本身
    expect(itemAtLine(items, 7)?.line).toBe(6);
    expect(itemAtLine(items, 0)).toBeUndefined();
    expect(itemAtLine([], 5)).toBeUndefined();
  });

  it("breadcrumbAt：模块 › 进程，块外只显示模块", () => {
    expect(breadcrumbAt(items, 1)).toBe("top");
    expect(breadcrumbAt(items, 4)).toBe("top › always @(posedge clk) → a");
    expect(breadcrumbAt(items, 6)).toBe("top › always @(*)");
    expect(breadcrumbAt([], 3)).toBe("");
  });
});
