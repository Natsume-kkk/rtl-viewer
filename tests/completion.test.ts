import { describe, expect, it } from "vitest";
import { moduleInstSnippet, fileSymbolItems } from "../src/editor/completion-items";
import type { PortInfo } from "../src/parser";

describe("例化骨架 snippet", () => {
  it("端口名为固定文本，连接信号为同名 Tab 占位，编号连续", () => {
    const ports: PortInfo[] = [
      { name: "i_clk", direction: "input", width: "" },
      { name: "o_data", direction: "output", width: "[7:0]" },
    ];
    const s = moduleInstSnippet("cl_clock_reset", ports);
    expect(s).toBe(
      "cl_clock_reset ${1:u_cl_clock_reset} (\n" +
        "\t.i_clk(${2:i_clk}),\n" +
        "\t.o_data(${3:o_data})\n" +
        ");",
    );
  });

  it("无端口信息时退化为空括号", () => {
    expect(moduleInstSnippet("glbl", [])).toBe("glbl ${1:u_glbl} ($0);");
  });

  it("端口名含 $ 时转义不破坏 snippet 语法", () => {
    const s = moduleInstSnippet("mod", [{ name: "a$b", direction: "input", width: "" }]);
    expect(s).toContain(".a\\$b(${2:a\\$b})");
  });
});

describe("当前文件符号补全项", () => {
  it("提取信号与例化名，去重", () => {
    const items = fileSymbolItems(
      `module top;
  reg [2:0] s_state;
  wire w_en;
  sub u_sub (.x(s_state));
endmodule`,
      "top.v",
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("s_state");
    expect(labels).toContain("w_en");
    expect(labels).toContain("u_sub");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("例化名 detail 带模块名，信号 detail 为信号", () => {
    const items = fileSymbolItems(
      `module top;
  reg r_a;
  sub u_sub (.x(r_a));
endmodule`,
      "top.v",
    );
    expect(items.find((i) => i.label === "u_sub")?.detail).toBe("u_sub : sub");
    expect(items.find((i) => i.label === "r_a")?.detail).toBe("信号");
  });
});
