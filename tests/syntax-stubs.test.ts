import { expect, it } from "vitest";
import { verilogPrimitiveStubs, verilogStub, vhdlStub } from "../src/app/syntax-stubs";
import { parseFile, parseFileDetail } from "../src/parser";

it("VHDL 黑盒保留端口方向、参数和常见位宽", () => {
  const source = verilogStub("demo", [
    { name: "clk", direction: "in" },
    { name: "data", direction: "in", width: "std_logic_vector(7 downto 0)" },
    { name: "count", direction: "out", width: "std_logic_vector(0 to 3)" },
    { name: "bus", direction: "inout", width: "integer" },
  ], [{ name: "WIDTH", defaultValue: "8" }]);
  expect(source).toContain("module demo #(parameter WIDTH = 8)");
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

it("厂商原语黑盒合并例化端口和参数，真实定义与未知模块不生成 Stub", () => {
  const modules = parseFileDetail("module top; LUT2 #(.INIT(4'h0)) u_lut(.I0(a), .I1(b), .O(y)); IOBUF u_io(.I(a), .O(y), .T(b), .IO(bus)); BUFG u_buf(.I(a), .O(y)); missing u_missing(); endmodule", "top.sv");
  const stubs = verilogPrimitiveStubs(modules, new Set(["BUFG"]));
  expect(stubs.map(stub => stub.name)).toEqual(["LUT2", "IOBUF"]);
  expect(stubs[0].source).toContain("module LUT2 #(parameter INIT = 0) (input wire I0, input wire I1, output wire O);");
  expect(stubs[1].source).toContain("input wire I, output wire O, input wire T, inout wire IO");
  expect(stubs[0].source).not.toContain("assign");
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

it("参数表达式保留可覆盖关系，未知默认值不伪造为 1", () => {
  const parameters = [{ name: "WIDTH", defaultValue: "8" }, { name: "DEPTH", defaultValue: "WIDTH * 2" }, { name: "UNKNOWN", defaultValue: "vendor_fn(4)" }];
  expect(verilogStub("demo", [], parameters)).toContain("parameter DEPTH = WIDTH * 2, parameter UNKNOWN)");
  expect(vhdlStub("demo", [], parameters)).toContain("DEPTH : integer := WIDTH * 2;\n    UNKNOWN : integer\n");
  expect(verilogStub("demo", [], [{ name: "WIDTH", defaultValue: "8" }, { name: "DEPTH", defaultValue: "width * 2" }])).not.toContain("DEPTH =");
  expect(verilogStub("demo", [], [{ name: "WIDTH", defaultValue: "8" }, { name: "DEPTH", defaultValue: "width * 2" }], true)).toContain("DEPTH = WIDTH * 2");
  expect(vhdlStub("demo", [], [{ name: "WIDTH", defaultValue: "8'd8" }])).toContain("WIDTH : integer := 8");
  expect(verilogStub("demo", [], [{ name: "MODE", defaultValue: '"true"' }], true)).toContain('MODE = "true"');
});
