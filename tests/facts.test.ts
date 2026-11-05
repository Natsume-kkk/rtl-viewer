import { expect, it } from "vitest";
import { analyzeFileFacts, codeStatistics } from "../src/analysis/facts";

it("代码统计区分纯注释、混合注释、空行与字符串中的注释符", () => {
  const stats = codeStatistics('// header\nmodule x; // inline\n\n/* block\nend */\nmodule y; string s = "// not comment";\n', "verilog");
  expect(stats).toEqual({ physicalLines: 6, codeLines: 2, commentOnlyLines: 3, inlineCommentLines: 1, blankLines: 1, commentRatio: 4 / 6 });
  const vhdl = codeStatistics('-- header\nentity x is\nend;\n', "vhdl");
  expect(vhdl.commentOnlyLines).toBe(1);
  expect(vhdl.codeLines).toBe(2);
});

it("共享事实保留过程、赋值、行级格式与检查边界", () => {
  const source = `// header
module demo(input logic a, output logic b);
  always_comb begin
    if (a) begin
      b = a; // blocking
    end
  end
  always_ff @(posedge a) begin
    b <= a;
  end
endmodule`;
  const facts = analyzeFileFacts("demo.sv", source);
  expect(facts.definitions).toEqual([{ name: "demo", kind: "module", line: 2 }]);
  expect(facts.processes).toHaveLength(2);
  expect(facts.processes[0].combinational).toBe(true);
  expect(facts.processes[0].assignments[0]).toMatchObject({ target: "b", operator: "=", processIndex: 0 });
  expect(facts.processes[1].sequential).toBe(true);
  expect(facts.processes[1].assignments[0].operator).toBe("<=");
  expect(facts.firstNonEmptyComment).toBe(true);
  expect(facts.eofNewline).toBe(false);
  expect(facts.lines.some(line => line.trailingWhitespaceColumn !== undefined)).toBe(false);
});

it("VHDL 过程敏感列表和赋值使用同一事实结构", () => {
  const source = `-- header\nentity demo is end;\narchitecture rtl of demo is\nbegin\n  process(clk)\n  begin\n    if rising_edge(clk) then\n      q <= d;\n    end if;\n  end process;\nend;`;
  const facts = analyzeFileFacts("demo.vhd", source);
  expect(facts.processes[0].sensitivity).toEqual(["clk"]);
  expect(facts.processes[0].sequential).toBe(true);
  expect(facts.processes[0].assignments[0]).toMatchObject({ target: "q", operator: "<=" });
});
