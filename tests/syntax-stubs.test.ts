import { expect, it } from "vitest";
import { verilogStub, vhdlStub } from "../src/app/syntax-stubs";
import { parseFile } from "../src/parser";

it("VHDL 黑盒保留端口方向、参数和常见位宽", () => {
  const source = verilogStub("demo", [
    { name: "clk", direction: "in" },
    { name: "data", direction: "in", width: "std_logic_vector(7 downto 0)" },
    { name: "count", direction: "out", width: "std_logic_vector(0 to 3)" },
    { name: "bus", direction: "inout", width: "integer" },
  ], [{ name: "WIDTH", defaultValue: "8" }]);
  expect(source).toContain("module demo #(parameter WIDTH = 1)");
  expect(source).toContain("input wire clk");
  expect(source).toContain("input wire [7:0] data");
  expect(source).toContain("output wire [3:0] count");
  expect(source).toContain("inout wire [31:0] bus");
  expect(source).toContain("endmodule");
});

it("未知 VHDL 类型不猜测为向量", () => {
  expect(verilogStub("demo", [{ name: "value", direction: "in", width: "custom_record" }], [])).toContain("input wire value");
});

it("Verilog IP 黑盒保留输入输出方向和位宽，不包含内部实现", () => {
  const module = parseFile("module ip(input wire clk, output wire [7:0] data); wire secret; assign secret = clk; endmodule", "ip.v")[0];
  const source = verilogStub("ip", module.ports, []);
  expect(source).toContain("input wire clk");
  expect(source).toContain("output wire [7:0] data");
  expect(source).not.toContain("inout wire clk");
  expect(source).not.toContain("secret");
});

it("GHDL 黑盒生成独立 entity 接口并转换 Verilog 位宽", () => {
  const module = parseFile("module ip #(parameter WIDTH = 8) (input wire clk, input wire [WIDTH-1:0] data, output wire [0:3] count, inout wire enable); wire secret; endmodule", "ip.v")[0];
  const source = vhdlStub("ip", module.ports, module.parameters ?? []);
  expect(source).toContain("entity ip is");
  expect(source).toContain("WIDTH : integer := 8");
  expect(source).toContain("clk : in std_logic");
  expect(source).toContain("data : in std_logic_vector(WIDTH-1 downto 0)");
  expect(source).toContain("count : out std_logic_vector(0 to 3)");
  expect(source).toContain("enable : inout std_logic");
  expect(source).toContain("end entity ip;");
  expect(source).not.toContain("secret");
});
