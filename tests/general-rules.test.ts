import { expect, it } from "vitest";
import { analyzeFileFacts } from "../src/analysis/facts";
import { runGeneralRules } from "../src/analysis/general-rules";

it("Verilog 七条风格规则全部来自统一事实", () => {
  const source = `module Demo;\n\tparameter width = 8;\nwire a, b;\nassign a = b;${" ".repeat(130)}`;
  const ids = new Set(runGeneralRules(analyzeFileFacts("Demo.sv", source), true).map(item => item.ruleId));
  expect(ids).toEqual(new Set(Array.from({ length: 7 }, (_, index) => `VLG-ST-00${index + 1}`)));
});

it("Verilog 五类可综合性检查返回明确规则编号", () => {
  const source = `module demo;
initial a = 0;
always @(posedge clk) a = 1;
always @* begin if (a) b <= a; end
always @* begin b = 0; end
endmodule`;
  const diagnostics = runGeneralRules(analyzeFileFacts("demo.sv", source));
  const ids = new Set(diagnostics.map(item => item.ruleId));
  expect(ids).toEqual(new Set(["VLG-SY-001", "VLG-SY-002", "VLG-SY-003", "VLG-SY-004", "VLG-SY-005"]));
});

it("VHDL 风格与过程检查共享声明和敏感列表事实", () => {
  const styleSource = `entity Demo is\nport(a : in std_logic; b : out std_logic);\nend;\n\tconstant width : integer := 8;${" ".repeat(130)}`;
  const styleIds = new Set(runGeneralRules(analyzeFileFacts("Demo.vhd", styleSource), true).map(item => item.ruleId));
  expect(styleIds).toEqual(new Set(Array.from({ length: 7 }, (_, index) => `VHD-ST-00${index + 1}`)));
  const source = `entity demo is end;
architecture rtl of demo is begin
  process(clk) begin if rising_edge(clk) then q <= d; end if; end process;
  process(a) begin if a then q <= d; end if; end process;
  process(b) begin if b then q <= d; end if; end process;
end;`;
  const ids = new Set(runGeneralRules(analyzeFileFacts("demo.vhd", source)).map(item => item.ruleId));
  expect(ids).toEqual(new Set(["VHD-SY-001", "VHD-SY-002", "VHD-SY-003", "VHD-SY-004"]));
});

it("完整默认赋值和 process(all) 不触发覆盖或敏感列表提示", () => {
  const source = `entity demo is end;
architecture rtl of demo is begin
  process(all) begin
    q <= '0';
    if a then q <= '1'; end if;
  end process;
end;`;
  const diagnostics = runGeneralRules(analyzeFileFacts("demo.vhd", source));
  expect(diagnostics.filter(item => item.ruleId === "VHD-SY-002" || item.ruleId === "VHD-SY-003")).toEqual([]);
});
