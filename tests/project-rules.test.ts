import { expect, it } from "vitest";
import { analyzeFileFacts } from "../src/analysis/facts";
import { runProjectRules } from "../src/analysis/project-rules";

it("跨文件参数重名和确定例化问题进入项目级诊断", () => {
  const files = [
    analyzeFileFacts("a.v", "module a; parameter WIDTH = 8; endmodule"),
    analyzeFileFacts("b.v", "module b; parameter WIDTH = 16; endmodule"),
  ];
  expect(runProjectRules(files).filter(item => item.ruleId === "10157-A-2-7")).toHaveLength(1);
});

it("例化表达式、确定位宽差异和双向直连按实际端口检查", () => {
  const files = [
    analyzeFileFacts("child.v", "module child(input [7:0] a, input [7:0] b, input [7:0] expr, inout pad); endmodule"),
    analyzeFileFacts("top.v", "module top(input en); wire [7:0] a; wire [3:0] b; child u(.a(a), .b(b), .expr(a & en), .pad(en)); endmodule"),
  ];
  const diagnostics = runProjectRules(files);
  expect(diagnostics.map(item => item.ruleId)).toEqual(expect.arrayContaining(["10157-R-3-1", "10157-R-10-1", "10157-A-8-1"]));
  expect(diagnostics.filter(item => item.ruleId === "10157-R-10-1")).toHaveLength(1);
  expect(diagnostics.find(item => item.ruleId === "10157-R-10-1")?.message).toContain("“b”");
});

it("VHDL 输入悬空和未使用输出 open 分开判断", () => {
  const files = [
    analyzeFileFacts("child.vhd", "entity child is port(a : in bit; y : out bit; unused : out bit); end;"),
    analyzeFileFacts("top.vhd", "entity top is end; architecture rtl of top is signal q : bit; begin u1 : entity work.child port map(a => open, y => open, unused => open); u2 : entity work.child port map(a => '0', y => q, unused => open); end;"),
  ];
  const diagnostics = runProjectRules(files);
  expect(diagnostics.filter(item => item.ruleId === "9765-4.1-b")).toHaveLength(1);
  expect(diagnostics.filter(item => item.ruleId === "9765-4.1-c")).toHaveLength(0);
});

it("重复定义冲突时不猜测例化端口绑定", () => {
  const files = [
    analyzeFileFacts("a.v", "module child(input [7:0] a); endmodule"),
    analyzeFileFacts("b.v", "module child(input [3:0] a); endmodule"),
    analyzeFileFacts("top.v", "module top; wire [7:0] a; child u(.a(a)); endmodule"),
  ];
  expect(runProjectRules(files).filter(item => item.ruleId === "10157-R-10-1")).toHaveLength(0);
});

it("省略带默认值的 VHDL 输入时，仅报告真正缺少连接的输入", () => {
  const child = analyzeFileFacts("child.vhd", "entity child is port(a : in bit := '0'; b : in bit; y : out bit); end;");
  const top = analyzeFileFacts("top.vhd", "entity top is port(y : out bit); end; architecture rtl of top is begin u: entity work.CHILD port map(Y => y); end;");
  const diagnostics = runProjectRules([child, top]);
  expect(diagnostics.map(item => item.message)).toEqual(["输入端口“b”悬空。"]);
});

it("Verilog 同名大小写变体的模块和端口分别匹配", () => {
  const child = analyzeFileFacts("child.sv", "module child(input wire A, input wire [7:0] a); endmodule");
  const other = analyzeFileFacts("CHILD.sv", "module CHILD(input wire a); endmodule");
  const top = analyzeFileFacts("top.sv", "module top(input wire scalar, input wire [3:0] vector); child u(.A(scalar), .a(vector)); endmodule");
  expect(runProjectRules([child, other, top]).filter(item => item.ruleId === "10157-R-10-1").map(item => item.message))
    .toEqual(["端口“a”位宽为 8，连接信号位宽为 4。"]);
});

it("Verilog 例化 VHDL 实体时继续检查黑盒接口的确定位宽", () => {
  const entity = analyzeFileFacts("vchild.vhd", "entity vchild is port(data : in bit_vector(7 downto 0)); end;");
  const top = analyzeFileFacts("top.sv", "module top(input wire [3:0] data); vchild u(.data(data)); endmodule");
  expect(runProjectRules([entity, top])).toContainEqual(expect.objectContaining({
    ruleId: "10157-R-10-1", message: "端口“data”位宽为 8，连接信号位宽为 4。",
  }));
});
