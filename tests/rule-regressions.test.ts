import { expect, it } from "vitest";
import { analyzeFileFacts } from "../src/analysis/facts";
import { runGeneralRules } from "../src/analysis/general-rules";
import { runGjb10157Rules, runGjb9765Rules } from "../src/analysis/gjb-rules";

const verilog = (source: string, file = "demo.v") => runGjb10157Rules(analyzeFileFacts(file, source));
const vhdl = (source: string, file = "demo.vhd") => runGjb9765Rules(analyzeFileFacts(file, source));
const ids = (source: string, file = "demo.v") => verilog(source, file).map(item => item.ruleId);
const vhdlIds = (source: string, file = "demo.vhd") => vhdl(source, file).map(item => item.ruleId);

it("自动敏感列表不误报，显式列表检查条件中的信号并排除常量", () => {
  expect(ids("module demo(input a, output reg y); always @(*) y=a; endmodule")).not.toContain("10157-R-13-9");
  const source = "module demo(input a, sel, output reg y); localparam ONE=1; always @(a) if (sel == ONE) y=a; else y=0; endmodule";
  const missing = verilog(source).filter(item => item.ruleId === "10157-R-13-9");
  expect(missing.map(item => item.message)).toEqual([expect.stringContaining("“sel”")]);
  expect(ids("module demo(input a, output reg y); always @(a) begin : body reg temp; temp=a; if(temp) y=a; else y=0; end endmodule")).not.toContain("10157-R-13-9");
});

it("VHDL 敏感列表只检查信号读取，不要求常量和局部变量", () => {
  const source = `entity demo is port(a, sel:in integer; y:out integer); end;
architecture rtl of demo is constant OFFSET:integer:=1;
begin process(a) variable temp:integer; begin
temp:=a+OFFSET; if sel=1 then y<=temp; else y<=0; end if;
end process; end;`;
  const facts = analyzeFileFacts("demo.vhd", source);
  for (const diagnostics of [runGeneralRules(facts), runGjb9765Rules(facts)]) {
    expect(diagnostics.filter(item => /敏感列表/.test(item.message)).map(item => item.message)).toEqual([expect.stringContaining("“sel”")]);
  }
});

it("VHDL 不把不同过程同名局部变量合并为驱动，但保留真实信号多驱动", () => {
  const source = `entity demo is port(a,b:in integer; y,z:out integer); end;
architecture rtl of demo is begin
process(a) variable temp:integer; begin temp:=a; y<=temp; end process;
process(b) variable temp:integer; begin temp:=b; z<=temp; end process; end;`;
  const diagnostics = (text: string) => {
    const facts = analyzeFileFacts("demo.vhd", text);
    return [...runGeneralRules(facts), ...runGjb9765Rules(facts)].filter(item => ["VHD-SY-004", "9765-4.6-f"].includes(item.ruleId));
  };
  expect(diagnostics(source)).toEqual([]);
  expect(diagnostics(source.replace("z<=temp", "y<=temp"))).toHaveLength(2);
});

it("异步复位边沿不计作时钟，只有不同目标混用复位才报警", () => {
  const source = `module demo(input logic clk, rst, d, output logic q, r);
always @(posedge clk or negedge rst) begin
  if (!rst) q <= 1'b0;
  else q <= d;
end
endmodule`;
  expect(ids(source)).not.toContain("10157-A-4-1");
  expect(ids(source)).not.toContain("10157-R-6-1");
  expect(ids(source.replace("else q <= d;", "else q <= d; q <= d;"))).not.toContain("10157-R-6-1");
  expect(ids(source.replace("else q <= d;", "else q <= d; r <= d;"))).toContain("10157-R-6-1");
  expect(ids(source.replace("  if (!rst)", "  q <= d; r <= d; if (!rst)"))).toContain("10157-R-6-1");
});

it("内置规则明确标注条件编译的检查范围", () => {
  const source = "module demo;\n`ifdef OTHER\ninitial q = 0;\n`endif\nendmodule\n";
  const diagnostics = runGeneralRules(analyzeFileFacts("demo.sv", source));
  expect(diagnostics).toContainEqual(expect.objectContaining({ ruleId: "ANALYSIS-BOUNDARY", message: expect.stringContaining("全部源码分支") }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ ruleId: "VLG-SY-003" }));
});

it("字面量只在非法数字或可能截断时报告位宽问题", () => {
  const valid = `module demo;
reg [7:0] a;
always @* begin
  a = {8'd16, 2'd0, 10'd512, 8'b1, 8'h0f, 3'h0, 8'dx};
end
endmodule`;
  expect(ids(valid)).not.toContain("10157-R-9-6");
  expect(ids("module demo; reg [7:0] a; always @* a = 8'd256; endmodule")).toContain("10157-R-9-6");
  expect(ids("module demo; reg [3:0] a; always @* a = 4'b10101; endmodule")).toContain("10157-R-9-6");
  expect(ids("module demo; reg [2:0] a; always @* a = 3'hf; endmodule")).toContain("10157-R-9-6");
  expect(ids("module demo; reg [1:0] a; always @* a = 2'b2; endmodule")).toContain("10157-R-9-6");
  expect(ids("module demo; reg [7:0] a; always @* a = 8'd18446744073709551616; endmodule")).toContain("10157-R-9-6");
});

it("端口和层级规则不要求无例化的叶子模块，也不匹配未引用向量", () => {
  const source = `module demo(input wire [7:0] a, input wire [7:0] b, input wire sel, output reg q);
always @* if (sel) q = 1'b0; else q = 1'b1;
endmodule`;
  const diagnostics = verilog(source);
  expect(diagnostics.some(item => item.ruleId === "10157-A-3-1" || item.ruleId === "10157-A-3-2")).toBe(false);
  expect(diagnostics.map(item => item.ruleId)).not.toContain("10157-A-9-1");
  expect(diagnostics.map(item => item.ruleId)).not.toContain("10157-A-11-4");
  expect(ids("module demo(input wire [7:0] a, input wire sel, output wire q); assign q = a[0] && sel; endmodule")).toContain("10157-A-9-1");
  expect(ids("module demo(input wire [7:0] a, input wire sel, output reg q); always @* if (a[0]) q = 1'b1; else q = 1'b0; endmodule")).toContain("10157-A-11-4");
  expect(vhdlIds("package pkg is end;")).not.toContain("9765-4.2-a");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is begin u: entity work.child port map(o => open); end;")).not.toContain("9765-4.1-b");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is begin process(a) begin q <= d; end process; end;")).not.toContain("9765-4.2-d");
});

it("反馈检查区分 Verilog 大小写和不同位选，同时保留真实反馈", () => {
  expect(ids("module demo; wire A,a; assign A = a; endmodule")).not.toContain("10157-R-7-1");
  expect(ids("module demo; wire A,a; assign A = a; endmodule")).not.toContain("10157-R-7-2");
  expect(ids("module demo; reg [1:0] a; always @* a[0] = a[1]; endmodule")).not.toContain("10157-R-13-7");
  expect(ids("module demo; reg a; always @* a = a; endmodule")).toContain("10157-R-13-7");
  expect(ids("module demo; reg [1:0] a; always @* a[0] = a[0]; endmodule")).toContain("10157-R-13-7");
});

it("函数、循环和数组检查接受正常局部逻辑与常量范围", () => {
  const source = `module demo;
parameter WIDTH = 8;
wire [WIDTH-1:0] a;
function f;
  input a,b;
  reg tmp;
  begin
    if (a <= b) begin
      tmp = a;
      f = tmp;
    end
  end
endfunction
always @* for (i = 0; i < WIDTH; i = i + 1) begin end
endmodule`;
  const diagnostics = ids(source);
  expect(diagnostics).not.toContain("10157-R-13-3");
  expect(diagnostics).not.toContain("10157-R-13-4");
  expect(diagnostics).not.toContain("10157-R-12-5");
  expect(diagnostics).not.toContain("10157-R-12-1");
  expect(diagnostics).not.toContain("10157-A-13-1");
  expect(diagnostics).not.toContain("10157-A-1-6");
  const violations = ids("module demo; function f; begin g(); a <= 1; end endfunction assign a[1+2] = 1'b0; endmodule");
  expect(violations).toContain("10157-R-13-3");
  expect(violations).toContain("10157-R-13-4");
  expect(violations).not.toContain("10157-R-12-5");
  expect(violations).toContain("10157-A-13-1");
  const loop = vhdlIds("entity demo is end; architecture rtl of demo is begin process begin for i in 0 to 7 loop x := i; end loop; end process; end;");
  expect(loop).not.toContain("9765-4.7-a");
  expect(loop).not.toContain("9765-4.7-b");
  const integerFunction = ids("module demo; function integer clogb2(input integer bit_depth); begin for(clogb2=0; bit_depth>0; clogb2=clogb2+1) bit_depth=bit_depth>>1; end endfunction endmodule");
  expect(integerFunction).not.toContain("10157-R-12-5");
});

it("case 支持单行、常量参数、VHDL 标签和正规枚举", () => {
  const facts = analyzeFileFacts("demo.v", "module demo; localparam IDLE=0; reg q; always @* case(q) IDLE: q=0; default: q=1; endcase endmodule");
  expect(facts.cases).toHaveLength(1);
  expect(facts.cases[0].nonconstantLabel).toBe(false);
  const vhdlFacts = analyzeFileFacts("demo.vhd", "entity demo is end; architecture rtl of demo is type state_t is (IDLE,RUN); signal state:state_t; begin process(state) begin case state is when IDLE => state <= RUN; when choice => state <= IDLE; when others => state <= IDLE; end case; end process; end;");
  expect(vhdlFacts.cases[0].labels).toEqual(expect.arrayContaining(["IDLE", "choice"]));
  expect(vhdlFacts.cases[0].nonconstantLabel).toBe(true);
  expect(vhdlFacts.signatures.some(signature => signature.kind === "enum")).toBe(true);
});

it("case 数字标签不会被前一段 begin end 或嵌套分支拼接", () => {
  const source = `module demo;
reg [1:0] state;
reg condition;
reg result;
always @* case (state)
  2'd0: begin
    if (condition) result = 1'b0;
    else result = 1'b1;
  end
  2'd1: if (condition) begin result = 1'b1; end
  2'd2: result = 1'b0;
  default: result = 1'b0;
endcase
endmodule`;
  const facts = analyzeFileFacts("demo.v", source);
  expect(facts.cases).toHaveLength(1);
  expect(facts.cases[0].labels).toEqual(["2'd0", "2'd1", "2'd2"]);
  expect(facts.cases[0].nonconstantLabel).toBe(false);
  expect(ids(source)).not.toContain("10157-R-11-6");
  const expression = analyzeFileFacts("demo.v", "module demo; localparam A=0,B=1; reg state; always @* case (state) A+B: state = 0; endcase endmodule").cases[0];
  expect(expression.labels).toEqual(["A+B"]);
  expect(expression.nonconstantLabel).toBe(false);
  expect(analyzeFileFacts("demo.v", "module demo; reg state; always @* case (state) choice: state = 0; endcase endmodule").cases[0].nonconstantLabel).toBe(true);
});

it("复位、时钟、三态和端口类型只在对应上下文中报警", () => {
  const first = ids("module first; wire first; always @(posedge clk) first <= 1'b0; endmodule");
  expect(first).not.toContain("10157-A-2-4");
  expect(first).not.toContain("10157-A-5-2");
  expect(ids("module demo; always @(posedge clk) if (clear) q <= 1'b0; else q <= d; endmodule")).not.toContain("10157-R-6-2");
  expect(ids("module demo(clk_in,clk,q); input clk_in; output clk,q; assign clk=clk_in; always @(posedge clk) q<=1'b0; endmodule")).not.toContain("10157-R-4-1");
  const asyncReset = analyzeFileFacts("demo.v", "module demo; always @(posedge clk or negedge rst_n) if(!rst_n) q<=1'b0; else q<=d; endmodule");
  expect(asyncReset.processes[0].clocks).toEqual(["clk"]);
  expect(ids("module demo; reg source,clk; always @(posedge source) clk<=source; always @(posedge clk) source<=1'b0; always @(posedge clk) q<=1'b0; endmodule")).toContain("10157-R-4-1");
  expect(ids("module demo(pad,en,a); inout pad; input en,a; assign pad = en ? a : 1'bz; endmodule")).not.toContain("10157-R-8-2");
  expect(ids("module demo; reg a,en; always @* a = en ? 1'b1 : 1'bz; endmodule")).toContain("10157-R-8-2");
  expect(ids("module demo; logic a; endmodule", "demo.sv")).not.toContain("10157-R-3-2");
  expect(ids("module demo(input logic a); endmodule", "demo.sv")).not.toContain("10157-R-3-2");
  expect(ids("module demo; // `include \"/absolute/path\"\nendmodule")).not.toContain("10157-R-2-7");
  expect(ids("module demo; `include \"/absolute/path\"\nendmodule")).toContain("10157-R-2-7");
});

it("VHDL 并发语句不按行号判先后，局部变量仍检查首次赋值", () => {
  const concurrent = vhdlIds("entity demo is end;\narchitecture rtl of demo is begin\nprocess(all) begin a <= b; end process;\nb <= c;\nend;");
  expect(concurrent).not.toContain("9765-4.6-a");
  const initialized = vhdlIds("entity demo is end;\narchitecture rtl of demo is begin\nprocess\n variable tmp: bit;\nbegin\n tmp := a;\n b := tmp;\nend process;\nend;");
  expect(initialized).not.toContain("9765-4.6-a");
  const before = vhdlIds("entity demo is end;\narchitecture rtl of demo is begin\nprocess\n variable tmp: bit;\nbegin\n b := tmp;\n tmp := a;\nend process;\nend;");
  expect(before).toContain("9765-4.6-a");
});

it("端口位宽、logic 声明、并发读取和连续 assign 多驱动进入共享事实", () => {
  const ports = analyzeFileFacts("demo.v", "module demo(a,b); input [7:0] a,b; endmodule");
  expect(ports.ports).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "a", direction: "input", width: "[7:0]" }),
    expect.objectContaining({ name: "b", direction: "input", width: "[7:0]" }),
  ]));
  const logic = analyzeFileFacts("demo.sv", "module demo; logic unused; endmodule");
  expect(logic.declarations.map(declaration => declaration.name)).toContain("unused");
  const concurrent = analyzeFileFacts("demo.vhd", "entity demo is end;\narchitecture rtl of demo is begin\na <= b;\nend;");
  expect(concurrent.concurrentAssignments[0].reads).toContain("b");
  const drivers = runGeneralRules(analyzeFileFacts("demo.v", "module demo; wire a,b,c; assign a=b; assign a=c; endmodule"));
  expect(drivers.map(item => item.ruleId)).toContain("VLG-SY-005");
});

it("文件名规则同时支持 Windows 和 POSIX 路径", () => {
  expect(ids("module demo; endmodule", "D:\\project\\demo.v")).not.toContain("10157-A-2-1");
  expect(ids("module demo; endmodule", "D:/project/demo.v")).not.toContain("10157-A-2-1");
  expect(ids("module demo; endmodule", "D:\\project\\other.v")).toContain("10157-A-2-1");
});

it("条件覆盖按目标和互补分支判断，时序 if 不冒充组合逻辑", () => {
  expect(ids("module demo; always @(posedge clk) if (en) q <= d; endmodule")).not.toContain("10157-A-11-5");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is begin process(clk) begin if rising_edge(clk) then if en = '1' then q <= d; end if; end if; end process; end;")).not.toContain("9765-4.8-d");
  expect(runGeneralRules(analyzeFileFacts("demo.v", "module demo; always @* begin q = 0; if (sel) r = a; end endmodule")).map(item => item.ruleId)).toContain("VLG-SY-004");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is begin process begin q <= '0'; if sel = '1' then r <= a; end if; end process; end;")).toContain("9765-4.2-f");
  expect(runGeneralRules(analyzeFileFacts("demo.v", "module demo; always @* if (sel) q = a; else q = b; endmodule")).map(item => item.ruleId)).not.toContain("VLG-SY-004");
  expect(runGeneralRules(analyzeFileFacts("demo.vhd", "entity demo is end; architecture rtl of demo is begin process(all) begin if sel = '1' then q <= a; else q <= b; end if; end process; end;")).map(item => item.ruleId)).not.toContain("VHD-SY-003");
});

it("时钟域和多驱动按模块隔离，不把同文件当作同一设计单元", () => {
  const source = "module a; always @(posedge clk_a) q <= d; endmodule module b; always @(posedge clk_b) q <= d; endmodule";
  expect(ids(source)).not.toContain("10157-A-4-4");
  expect(runGeneralRules(analyzeFileFacts("demo.v", source)).map(item => item.ruleId)).not.toContain("VLG-SY-005");
  expect(ids("module demo; always @(posedge clk_a) q <= d; always @(posedge clk_b) r <= d; endmodule")).toContain("10157-A-4-4");
});

it("VHDL case、复位和行波时钟只在真实条件不满足时报警", () => {
  const full = "entity demo is end; architecture rtl of demo is signal a,q:bit; begin process(a) begin case a is when '0' => q <= '0'; when '1' => q <= '1'; end case; end process; end;";
  expect(vhdlIds(full)).not.toContain("9765-4.8-c");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is signal a,q:bit; begin process(a) begin case a is when '0' => q <= '0'; end case; end process; end;")).toContain("9765-4.8-c");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is begin process(clk,rst_a,rst_b) begin if rst_a = '1' then q <= '0'; elsif rst_b = '1' then q <= '0'; elsif rising_edge(clk) then q <= d; end if; end process; end;")).not.toContain("9765-4.6-g");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is signal clk,source:bit; begin clk <= source; process(clk) begin if rising_edge(clk) then q <= d; end if; end process; end;")).not.toContain("9765-4.9-g");
  const ripple = "entity demo is end; architecture rtl of demo is signal clk,source:bit; begin process(source_clk) begin if rising_edge(source_clk) then source <= d; end if; end process; clk <= source; process(clk) begin if rising_edge(clk) then q <= d; end if; end process; end;";
  expect(vhdlIds(ripple)).toContain("9765-4.9-g");
  expect(vhdlIds("entity foo is end; architecture rtl of foo is signal foo:bit; begin end;")).toContain("9765-4.5-b");
});

it("状态 default 和 parameter 字面量按条款目标检查", () => {
  expect(ids("module demo; reg [1:0] state; always @(posedge clk) case(state) 0: state <= 1; default: q <= 0; endcase endmodule")).toContain("10157-R-14-2");
  expect(ids("module demo; reg [1:0] state; always @(posedge clk) case(state) 0: state <= 1; default: state <= 0; endcase endmodule")).not.toContain("10157-R-14-2");
  expect(ids("module demo; parameter P = 1; endmodule")).toContain("10157-A-9-2");
  expect(ids("module demo; parameter P = 1'b1; endmodule")).not.toContain("10157-A-9-2");
});

it("端口和声明注释按就近位置判断，文件头不再掩盖缺失", () => {
  const source = `-- file header
entity demo is
  port(a : in bit);
end;
architecture rtl of demo is
  -- documented b
  signal b : bit;
  signal c : bit; -- documented c
begin
end;`;
  const diagnostics = vhdl(source);
  expect(diagnostics.some(item => item.ruleId === "9765-4.13-b" && item.message.includes("“a”"))).toBe(true);
  expect(diagnostics.filter(item => item.ruleId === "9765-4.13-c")).toHaveLength(0);
});

it("确定位宽的不一致进入赋值、运算符和 case 分支检查", () => {
  const diagnostics = ids("module demo; wire [7:0] a; wire [3:0] b; assign a = b; assign q = a == b; assign r = a & b; always @* case(a) 4'd0: q = 0; endcase endmodule");
  expect(diagnostics).toEqual(expect.arrayContaining(["10157-R-10-2", "10157-R-9-1", "10157-R-9-2", "10157-R-11-3"]));
  const valid = ids("module demo; wire [7:0] a; assign a = 8'd1; assign q = a == 8'd0; assign r = a & 8'h0f; always @* case(a) 8'd0: q = 0; endcase endmodule");
  for (const id of ["10157-R-10-2", "10157-R-9-1", "10157-R-9-2", "10157-R-11-3"]) expect(valid).not.toContain(id);
});

it("异步复位边沿与进入条件保持一致", () => {
  expect(ids("module demo; always @(posedge clk or negedge rst_n) if (rst_n) q <= 0; else q <= d; endmodule")).toContain("10157-R-6-3");
  expect(ids("module demo; always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else q <= d; endmodule")).not.toContain("10157-R-6-3");
});

it("VHDL 确定位宽和常量初始化引用按对象类型检查", () => {
  const source = "entity demo is end; architecture rtl of demo is signal a : std_logic_vector(7 downto 0); signal b : std_logic_vector(3 downto 0); signal input_value : integer; constant C : integer := input_value; constant D : integer := C; begin process(all) begin q <= a = b; end process; end;";
  const diagnostics = vhdlIds(source);
  expect(diagnostics).toContain("9765-4.6-b");
  expect(diagnostics.filter(id => id === "9765-4.6-c")).toHaveLength(1);
  expect(vhdlIds("entity demo is end; architecture rtl of demo is constant C : integer := 1; constant D : integer := C; begin end;")).not.toContain("9765-4.6-c");
  expect(vhdlIds("entity demo is end; architecture rtl of demo is signal a,b : std_logic_vector(7 downto 0); begin process(all) begin q <= a = b; end process; end;")).not.toContain("9765-4.6-b");
});

it("完整 case 不报警但分支漏赋目标仍报告覆盖不足", () => {
  for (const source of [
    "module demo; wire sel; always @* case (sel) 0: q = 0; default: q = 1; endcase endmodule",
    "module demo; wire sel; always @* case (sel) 0: q = 0; 1: q = 1; endcase endmodule",
  ]) expect(runGeneralRules(analyzeFileFacts("demo.v", source)).map(item => item.ruleId)).not.toContain("VLG-SY-004");
  expect(runGeneralRules(analyzeFileFacts("demo.v", "module demo; always @* case (sel) 0: q = 0; 1: r = 1; default: q = 1; endcase endmodule")).map(item => item.ruleId)).toContain("VLG-SY-004");
  const fullVhdl = "entity demo is end; architecture rtl of demo is signal a,q:bit; begin process(a) begin case a is when '0' => q <= '0'; when others => q <= '1'; end case; end process; end;";
  expect(runGeneralRules(analyzeFileFacts("demo.vhd", fullVhdl)).map(item => item.ruleId)).not.toContain("VHD-SY-003");
  expect(vhdlIds(fullVhdl)).not.toContain("9765-4.2-f");
  const missingVhdl = "entity demo is end; architecture rtl of demo is signal a,q,r:bit; begin process(a) begin case a is when '0' => r <= '0'; when others => q <= '1'; end case; end process; end;";
  expect(runGeneralRules(analyzeFileFacts("demo.vhd", missingVhdl)).map(item => item.ruleId)).toContain("VHD-SY-003");
});

it("同一行不同设计单元的边沿签名保持独立", () => {
  const verilog = "module a; always @(posedge clk) q <= d; endmodule module b; always @(negedge clk) q <= d; endmodule";
  expect(ids(verilog)).not.toContain("10157-A-4-1");
  expect(ids("module demo; always @(posedge clk) q <= d; always @(negedge clk) r <= d; endmodule")).toContain("10157-A-4-1");
  const vhdl = "entity a is end; architecture rtl of a is begin process(clk) begin if rising_edge(clk) then q <= d; end if; end process; end; entity b is end; architecture rtl of b is begin process(clk) begin if falling_edge(clk) then q <= d; end if; end process; end;";
  expect(vhdlIds(vhdl)).not.toContain("9765-4.9-i");
});
