import { expect, it } from "vitest";
import { analyzeFileFacts } from "../src/analysis/facts";
import { runGjb10157Rules, runGjb9765Rules } from "../src/analysis/gjb-rules";
import { GJB10157_RULES, GJB9765_RULES, gjbCoverage } from "../src/analysis/gjb-catalog";

it("GJB 10157 的 28 条自动检查全部覆盖", () => {
  const source = `module bad_;
parameter p = 1;
reg VDD;
wire a, b;
assign clk = a & b;
assign a = 1'bz;
always @(posedge clk) a = 1;
always @(negedge clk) a = 1;
always @* if (a) b <= a;
always @(a | b) if (a == 1'bx) b = a + 1'bx;
always @(a) if (b) b = 0;
initial #10 a = 0;
defparam u.P = 1;
sub u(a, b);
casez (1'b1)
  value: a = 1;
  default:;
endcase
case (a)
  value: a = 1;
endcase
${" ".repeat(90)}
endmodule
module second; endmodule`;
  const ids = new Set(runGjb10157Rules(analyzeFileFacts("other.sv", source)).map(item => item.ruleId));
  for (const id of [
    "10157-R-2-2", "10157-R-2-4", "10157-R-2-5", "10157-R-2-9", "10157-R-4-3", "10157-R-6-2", "10157-R-8-2",
    "10157-R-9-4", "10157-R-9-5", "10157-R-10-3", "10157-R-10-4", "10157-R-10-6", "10157-R-11-1", "10157-R-11-2",
    "10157-R-11-4", "10157-R-11-5", "10157-R-11-6", "10157-R-13-2", "10157-R-13-9", "10157-R-14-2",
    "10157-A-1-4", "10157-A-1-8", "10157-A-2-1", "10157-A-2-2", "10157-A-2-6", "10157-A-4-1", "10157-A-11-2", "10157-A-11-5",
  ]) expect(ids, id).toContain(id);
});

it("GJB 9765 的 21 条自动检查全部覆盖", () => {
  const source = `entity bad_name is
port(clk : in std_logic; a : in std_logic; y : out std_logic; b : buffer std_logic);
end;
architecture rtl of bad_name is
  signal foo_ : std_logic;
  signal Foo : std_logic;
  signal foo : std_logic := '1';
begin
  foo_ <= 'Z';
  y <= foo_;
  clk <= a and b;
  process(a) begin
    if a = 'X' then foo_ <= y; end if;
  end process;
  process(b) begin foo_ <= a; end process;
  process(clk, a) begin
    if rising_edge(clk) then foo_ <= a; end if;
    if rising_edge(a) then foo_ <= a; end if;
  end process;
  process(clk) begin
    case a is
      when '0' => foo_ <= a;
      when others => null;
    end case;
    case a is
      when '0' => foo_ <= a;
    end case;
  end process;
  u1: entity work.sub port map(a, y);
  u2: entity work.sub port map(a => open, b => y, clk => clk);
end;${" ".repeat(80)}`;
  const ids = new Set(runGjb9765Rules(analyzeFileFacts("bad_name.vhd", source)).map(item => item.ruleId));
  for (const id of [
    "9765-4.1-a", "9765-4.1-b", "9765-4.2-b", "9765-4.2-c", "9765-4.3-a", "9765-4.4-c", "9765-4.4-d",
    "9765-4.5-c", "9765-4.5-d", "9765-4.6-f", "9765-4.8-c", "9765-4.8-d", "9765-4.9-c", "9765-4.9-d",
    "9765-4.10-e", "9765-4.11-a", "9765-4.12-c", "9765-4.13-a", "9765-4.14-b", "9765-4.14-d",
  ]) expect(ids, id).toContain(id);
});

it("补充命名、格式和简单结构检查具有实际诊断", () => {
  const source = `module _bad;
parameter p = 1;
parameter p = 2;
wire Vdd, vdd;
wire unused;
wire clk;
wire clk2;
wire rst;
logic b;
assign clk = a & b;
assign a = 4'h1f;
assign a = 2;
assign a = a;
always @* a = a;
always @(posedge clk or negedge clk) a = 1;
always @(posedge clk2) a = 1;
always @* if (rst) a = 1;
\`include "/absolute/path"
full_case
case (a)
  0: a = 1;
  0: a = 1;
  default: a = 1'bx;
endcase
repeat (a) a = 1;
endmodule
module module; endmodule`;
  const ids = new Set(runGjb10157Rules(analyzeFileFacts("module.sv", source)).map(item => item.ruleId));
  for (const id of ["R-2-1", "R-2-3", "R-2-6", "R-2-7", "R-2-8", "R-3-2", "R-7-2", "R-9-6", "R-13-7", "A-1-1", "A-2-3", "A-2-4", "A-2-7", "A-2-8", "A-4-3", "A-4-4", "A-9-2", "A-11-1", "A-11-3", "A-12-1", "A-16-1"]) {
    expect(ids, id).toContain(`10157-${id}`);
  }
});

it("补充 VHDL 结构、格式和时钟检查具有实际诊断", () => {
  const source = `entity bad_name is
port(a : in std_logic; y : out std_logic);
end;
architecture rtl of bad_name is
  signal value : std_logic_vector;
  signal foo : std_logic;
  signal process : std_logic;
begin
  value<=a;
  y <= 'Z' and a;
  clk <= a and b;
  process(a) begin
    while true loop
      if a then value <= y; end if;
      full_case
      case '0' is
        when '0' => value <= a;
        when '1' => value <= a;
      end case;
      null;
    end loop;
  end process;
  process(clk) begin
    if rising_edge(clk) then value <= a; end if;
    if falling_edge(clk) then value <= a; end if;
  end process;
  #10 value <= a;
end;`;
  const ids = new Set(runGjb9765Rules(analyzeFileFacts("bad_name.vhd", source)).map(item => item.ruleId));
  for (const id of ["4.4-a", "4.5-a", "4.6-i", "4.7-c", "4.8-a", "4.8-e", "4.9-e", "4.9-i", "4.11-b", "4.12-a", "4.13-b", "4.13-c", "4.14-a", "4.14-c"]) {
    expect(ids, id).toContain(`9765-${id}`);
  }
});

it("循环、函数与数组结构检查覆盖 Verilog 和 VHDL", () => {
  const source = `module demo;
for (i = initial; i < limit; i = i + 1) begin end
for (i = 0; i < 0; i = i + 1) begin rst = 1; i = i + 1; end
task t; #10; endtask
function f; f(); a <= 1; endfunction
wire [7:0] a;
assign a[1+2] = 1;
endmodule`;
  const ids = new Set(runGjb10157Rules(analyzeFileFacts("demo.sv", source)).map(item => item.ruleId));
  for (const id of ["R-12-1", "R-12-2", "R-12-3", "R-12-4", "R-12-5", "R-13-1", "R-13-3", "R-13-4", "A-13-1"]) expect(ids, id).toContain(`10157-${id}`);
  const vhdl = `entity demo is end;\narchitecture rtl of demo is begin\n  process begin\n    for i in start to last loop\n      i := i + 1;\n    end loop;\n  end process;\nend;`;
  const vhdlIds = new Set(runGjb9765Rules(analyzeFileFacts("demo.vhd", vhdl)).map(item => item.ruleId));
  expect(vhdlIds).toContain("9765-4.7-a");
  expect(vhdlIds).toContain("9765-4.7-b");
});

it("Verilog Wrapper 的端口连接、敏感列表和条件使用不算冗余声明", () => {
  const wrapper = `module design_1_wrapper(aclken, clk, sel, data_in, data_out, unused);
input aclken, clk, sel, data_in;
output data_out;
wire aclken, clk, sel, data_in, data_out, unused;
child design_1_i(
  .aclken(aclken),
  .clk(clk),
  .sel(sel),
  .data_in(data_in),
  .data_out(data_out)
);
endmodule`;
  const facts = analyzeFileFacts("design_1_wrapper.v", wrapper);
  expect(facts.instanceReads).toEqual(expect.arrayContaining(["aclken", "clk", "sel", "data_in", "data_out"]));
  const unused = runGjb10157Rules(facts).filter(item => item.ruleId === "10157-A-2-8");
  expect(unused.map(item => item.message)).toHaveLength(1);
  expect(unused[0].message).toContain("unused");
  const processSource = `module condition_usage;
wire clk, sel, rst;
reg q;
always @(posedge clk) begin
  if (sel) begin
    if (rst) q <= 1'b0;
    else q <= 1'b1;
  end
end
endmodule`;
  expect(runGjb10157Rules(analyzeFileFacts("condition_usage.v", processSource)).filter(item => item.ruleId === "10157-A-2-8")).toHaveLength(0);
});

it("VHDL 端口映射、敏感列表和条件使用不算多余信号", () => {
  const source = `entity wrapper is
  port(clk, sel, d : in bit; q : out bit);
end;
architecture rtl of wrapper is
  signal unused : bit;
begin
  u1 : child port map(clk => clk, sel => sel, d => d, q => q);
  process(clk, sel) begin
    if sel = '1' then q <= d;
    end if;
  end process;
end;`;
  const unused = runGjb9765Rules(analyzeFileFacts("wrapper.vhd", source)).filter(item => item.ruleId === "9765-4.4-b");
  expect(unused.map(item => item.message)).toHaveLength(1);
  expect(unused[0].message).toContain("unused");
});

it("完整标准目录保持 110＋81 条，自动检查不冒充完整合规", () => {
  expect(gjbCoverage(GJB10157_RULES)).toEqual({ automatic: 81, total: 110, manual: 29 });
  expect(gjbCoverage(GJB9765_RULES)).toEqual({ automatic: 56, total: 81, manual: 25 });
});
