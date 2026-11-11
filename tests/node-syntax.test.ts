import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeSyntaxCheck } from "../src/app/node-syntax";
import { emptySyntaxCheckOptions } from "../src/ipc";
import { diagnosticDisplayMessage } from "../src/app/diagnostic-display";
import { syntaxDependencyFiles } from "../src/app/syntax-order";
import { verilogStub } from "../src/app/syntax-stubs";
import { buildStubs } from "../scripts/rtl-lint";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function syntaxFixture(sources: Record<string, string | Buffer>) {
  fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".tmp/syntax-regression-"));
  roots.push(root);
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  });
  return { requestId: 11, root, files, stubs: [], options: emptySyntaxCheckOptions };
}

it("VHDL 黑盒顶层不能屏蔽实际 Verilog 子模块的语义诊断", () => {
  const request = syntaxFixture({
    "top.vhd": "entity top is port(d:in bit; q:out bit); end; architecture rtl of top is component child port(d:in bit; q:out bit); end component; begin u:child port map(d,q); end;\n",
    "child.sv": "module child(input wire [7:0] d, output wire q); assign q=d; endmodule\n",
  });
  const result = runNodeSyntaxCheck({ ...request, top: "top", stubs: [{ name: "top", source: "module top(input d,output q); endmodule\n" }] });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ ruleId: "VERILATOR-WIDTHTRUNC", file: request.files[1].replaceAll("\\", "/") }));
});

it("黑盒保持参数默认值，不制造端口位宽差异", () => {
  const request = syntaxFixture({ "top.sv": "module top(input [7:0] data); child u(.data(data)); endmodule\n" });
  const source = verilogStub("child", [{ name: "data", direction: "in", width: "std_logic_vector(width-1 downto 0)" }], [{ name: "WIDTH", defaultValue: "8" }], true);
  const result = runNodeSyntaxCheck({ ...request, top: "top", stubs: [{ name: "child", source }] });
  expect(result.diagnostics.filter(item => item.severity === "error" || item.ruleId.startsWith("VERILATOR-WIDTH"))).toEqual([]);
});

it("未知黑盒默认值要求显式参数覆盖，不生成确定的假位宽", () => {
  const request = syntaxFixture({ "top.sv": "module top(input [7:0] data); child #(.WIDTH(8)) u(.data(data)); endmodule\n" });
  const source = verilogStub("child", [{ name: "data", direction: "input", width: "[WIDTH-1:0]" }], [{ name: "WIDTH", defaultValue: "vendor_width()" }]);
  const result = runNodeSyntaxCheck({ ...request, top: "top", stubs: [{ name: "child", source }] });
  expect(result.diagnostics.filter(item => item.severity === "error" || item.ruleId.startsWith("VERILATOR-WIDTH"))).toEqual([]);
  fs.writeFileSync(request.files[0], "module top(input [7:0] data); child u(.data(data)); endmodule\n");
  expect(runNodeSyntaxCheck({ ...request, top: "top", stubs: [{ name: "child", source }] }).diagnostics).toContainEqual(expect.objectContaining({ severity: "error", message: expect.stringMatching(/parameter|default/i) }));
});

it("CLI 分文件 entity 和 architecture 只生成一个完整接口", () => {
  const request = syntaxFixture({
    "top.sv": "module top(input a,output y); child u(.a(a),.y(y)); endmodule\n",
    "a_entity.vhd": "entity child is port(a:in bit; y:out bit); end;\n",
    "z_arch.vhd": "architecture rtl of child is begin y<=a; end;\n",
  });
  const stubs = buildStubs(request.files);
  expect(stubs.stubs).toHaveLength(1);
  expect(runNodeSyntaxCheck({ ...request, top: "top", ...stubs }).diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

it("CLI 重复 entity 不猜选黑盒接口", () => {
  const request = syntaxFixture({
    "one.vhd": "entity child is port(a:in bit); end;\n",
    "two.vhd": "entity CHILD is port(b:in bit); end;\n",
  });
  expect(buildStubs(request.files).stubs).toEqual([]);
});

it.each(["automatic", "static"])("package %s 的依赖被选入并先于使用者检查", lifetime => {
  const request = syntaxFixture({
    "a_top.sv": "module top(output pkg::word_t y); assign y=0; endmodule\n",
    "z_pkg.sv": `package ${lifetime} pkg; typedef logic [7:0] word_t; endpackage\n`,
  });
  const files = syntaxDependencyFiles(request.files.map(actual => ({ actual, library: "work" })), new Set([request.files[0]]), file => fs.readFileSync(file.actual, "utf8"));
  expect(files).toEqual(request.files);
  expect(runNodeSyntaxCheck({ ...request, files, top: "top" }).diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

it("GHDL 拒绝无位置的无效参数时返回后端失败", () => {
  const request = syntaxFixture({ "top.vhd": "entity top is end;\n" });
  const options = { ...request.options, ghdlArgs: ["--definitely-not-a-ghdl-option"] };
  const result = runNodeSyntaxCheck({ ...request, options });
  expect(result.checkedFiles).toBe(0);
  expect(result.backends[0].status).toBe("failed");
  expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "error", source: "system", message: expect.stringContaining("unknown command option") })]);
});

it("Verilator 的工程级参数错误保留原文并将后端记为失败", () => {
  const request = syntaxFixture({ "top.sv": "module top; endmodule\n" });
  const options = { ...request.options, verilatorArgs: ["--definitely-not-a-verilator-option"] };
  const result = runNodeSyntaxCheck({ ...request, options });
  expect(result.checkedFiles).toBe(0);
  expect(result.backends[0].status).toBe("failed");
  expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "error", source: "verilator", file: "", message: expect.stringMatching(/Invalid option/i) })]);
});

it("VHDL 顶层补齐包的传递依赖，并把 WORK 解释为当前逻辑库", () => {
  const request = syntaxFixture({
    "a_top.vhd": "use work.dep.all; entity top is port(y : out bit); end; architecture rtl of top is begin y <= VALUE; end;\n",
    "y_dep.vhd": "use work.base.all; package dep is constant VALUE : bit := BASE_VALUE; end package;\n",
    "z_base.vhd": "package base is constant BASE_VALUE : bit := '1'; end package;\n",
    "unrelated.vhd": "entity unrelated is end;\n",
  });
  const [top, dep, base] = request.files;
  const sources = request.files.map(actual => ({ actual, library: "RTL" }));
  const files = syntaxDependencyFiles(sources, new Set([top]), file => fs.readFileSync(file.actual, "utf8"));
  expect(files).toEqual([top, dep, base]);
  const options = { ...request.options, vhdlLibraries: files.map(file => ({ file, library: "RTL" })) };
  const result = runNodeSyntaxCheck({ ...request, files, options });
  expect(result.checkedFiles).toBe(3);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

it("无顶层参数时 Verilator 检查独立根模块的位宽", () => {
  const request = syntaxFixture({
    "selected.sv": "module selected(input wire d, output wire q); assign q=d; endmodule\n",
    "unselected.sv": "module unselected(input wire [7:0] d, output wire q); assign q=d; endmodule\n",
  });
  expect(runNodeSyntaxCheck({ ...request, top: "selected" }).diagnostics.some(item => item.ruleId === "VERILATOR-WIDTHTRUNC")).toBe(false);
  const diagnostics = runNodeSyntaxCheck(request).diagnostics;
  expect(diagnostics.some(item => item.ruleId === "VERILATOR-WIDTHTRUNC")).toBe(true);
  expect(diagnostics.some(item => item.ruleId === "VERILATOR-MULTITOP")).toBe(false);
});

it("未保存 include 覆盖磁盘文件，并把诊断映射回原路径", () => {
  const request = syntaxFixture({
    "rtl/top.sv": '`include "../inc/defs.svh"\nmodule top; endmodule\n',
    "inc/defs.svh": "`define WIDTH 8\n",
  });
  const [source, header] = request.files;
  const result = runNodeSyntaxCheck({
    ...request, files: [source],
    snapshots: [{ file: header, content: "invalid_header_syntax !\n", encoding: "utf16le" }],
  });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", file: header.replaceAll("\\", "/") }));
  expect(fs.readFileSync(header, "utf8")).toBe("`define WIDTH 8\n");
  expect(runNodeSyntaxCheck(request).diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

it("外部工具读取 UTF-16 磁盘文件及快照时统一使用 UTF-8", () => {
  const verilog = "module top; endmodule\n";
  const vhdl = "entity vtop is end; architecture rtl of vtop is begin end;\n";
  const utf16 = (source: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]);
  const request = syntaxFixture({ "top.sv": utf16(verilog), "vtop.vhd": utf16(vhdl) });
  const [source, entity] = request.files;
  const snapshots = [
    { file: source, content: verilog, encoding: "utf16le" },
    { file: entity, content: vhdl, encoding: "utf16le" },
  ];
  for (const result of [runNodeSyntaxCheck(request), runNodeSyntaxCheck({ ...request, snapshots })]) {
    expect(result.checkedFiles).toBe(2);
    expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  }
});

it("真实 Verilator 的缺少实例名诊断结合未保存快照解释，补上实例名后通过", () => {
  fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".tmp/missing-instance-"));
  roots.push(root);
  const file = path.join(root, "top.sv");
  const valid = "module top(input [7:0] signal); child #(.WIDTH(8)) u_child (.data(signal)); endmodule\n";
  fs.writeFileSync(file, valid);
  const request = {
    requestId: 9, root, files: [file], options: emptySyntaxCheckOptions,
    stubs: [{ name: "child", source: "module child #(parameter WIDTH = 8)(input [WIDTH-1:0] data); endmodule\n" }],
  };
  const result = runNodeSyntaxCheck({ ...request, snapshots: [{ file, content: valid.replace("u_child ", ""), encoding: "utf8" }] });
  const error = result.diagnostics.find(diagnostic => diagnostic.syntaxKind === "missing-instance-name");
  expect(error).toMatchObject({ file: file.replaceAll("\\", "/"), severity: "error", ruleId: "VERILATOR-GENERAL", message: "syntax error, unexpected '('" });
  expect(diagnosticDisplayMessage(error!)).toContain("模块例化缺少实例名");
  expect(fs.readFileSync(file, "utf8")).toBe(valid);
  const fixed = runNodeSyntaxCheck(request);
  expect(fixed.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
  expect(fixed.diagnostics.some(diagnostic => diagnostic.syntaxKind)).toBe(false);
});

it.each([
  { name: "参数名错误", extension: "sv", source: "module top(input [7:0] signal); child #(.BAD_WIDTH(8)) u_child (.data(signal)); endmodule\n", fixed: "module top(input [7:0] signal); child #(.WIDTH(8)) u_child (.data(signal)); endmodule\n", raw: /^Parameter not found:/, expected: "参数未找到：'BAD_WIDTH'" },
  { name: "端口名错误", extension: "sv", source: "module top(input [7:0] signal); child u_child (.bad_data(signal)); endmodule\n", fixed: "module top(input [7:0] signal); child u_child (.data(signal)); endmodule\n", raw: /^Pin not found:/, expected: "端口未找到：'bad_data'" },
  { name: "无参数缺实例名", extension: "sv", source: "module top(input [7:0] signal); child (.data(signal)); endmodule\n", fixed: "module top(input [7:0] signal); child u_child (.data(signal)); endmodule\n", raw: /^Instance of module must be named/, expected: "模块例化缺少实例名" },
  { name: "变量未声明", extension: "sv", source: "module top(input signal, output reg result); always @* result = nonexistent; endmodule\n", fixed: "module top(input signal, output reg result); always @* result = signal; endmodule\n", raw: /^Can't find definition of variable:/, expected: "未找到变量 'nonexistent' 的定义" },
  { name: "常量位宽", extension: "sv", source: "module top(output [3:0] result); assign result = 8'hff; endmodule\n", fixed: "module top(output [3:0] result); assign result = 4'hf; endmodule\n", raw: /CONST.*generates 8 bits/, expected: "ASSIGNW 的赋值右侧要求 4 位，但常量 '8'hff' 实际为 8 位" },
  { name: "拼接位宽", extension: "sv", source: "module top(input [7:0] signal, output [3:0] result); assign result = {4'b0, signal}; endmodule\n", fixed: "module top(input [7:0] signal, output [11:0] result); assign result = {4'b0, signal}; endmodule\n", raw: /REPLICATE generates 12 bits/, expected: "ASSIGNW 的赋值右侧要求 4 位，但拼接／复制表达式实际为 12 位" },
  { name: "选择越界", extension: "sv", source: "module top(input [7:0] signal, output result); assign result = signal[9]; endmodule\n", fixed: "module top(input [7:0] signal, output result); assign result = signal[7]; endmodule\n", raw: /^Selection index out of range:/, expected: "选择索引 9:9 超出声明范围 7:0" },
  { name: "VHDL 声明缺分号", extension: "vhd", source: "entity top is end; architecture rtl of top is\nsignal aa:bit\nbegin end;\n", fixed: "entity top is end; architecture rtl of top is\nsignal aa:bit;\nbegin end;\n", raw: /missing ";" at end of object declaration/, expected: '声明末尾缺少 ";"' },
])("真实后端诊断与修正后的正常路径：$name", ({ extension, source, fixed, raw, expected }) => {
  fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".tmp/diagnostic-message-"));
  roots.push(root);
  const file = path.join(root, `top.${extension}`);
  const request = { requestId: 10, root, files: [file], options: emptySyntaxCheckOptions,
    stubs: extension === "sv" ? [{ name: "child", source: "module child #(parameter WIDTH = 8)(input [WIDTH-1:0] data); endmodule\n" }] : [] };
  fs.writeFileSync(file, source);
  const result = runNodeSyntaxCheck(request);
  const diagnostic = result.diagnostics.find(item => raw.test(item.message));
  expect(diagnostic).toBeDefined();
  expect(diagnosticDisplayMessage(diagnostic!)).toBe(expected);
  expect(diagnostic!.ruleId).toMatch(extension === "sv" ? /^VERILATOR-/ : /^GHDL$/);
  expect(fs.readFileSync(file, "utf8")).toBe(source);
  fs.writeFileSync(file, fixed);
  const corrected = runNodeSyntaxCheck(request);
  expect(corrected.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  expect(corrected.diagnostics.some(item => raw.test(item.message))).toBe(false);
});

it("Node CLI 后端使用未保存快照并返回原路径诊断", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-syntax-"));
  roots.push(root);
  const source = path.join(root, "top.sv");
  fs.writeFileSync(source, "module top; invalid verilog\n");
  const result = runNodeSyntaxCheck({
    requestId: 1,
    root,
    files: [source],
    stubs: [],
    options: emptySyntaxCheckOptions,
    snapshots: [{ file: source, content: "module top(input logic a, output logic b); assign b = a; endmodule\n", encoding: "utf8" }],
  });
  expect(result.checkedFiles).toBe(1);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

it("Node CLI 将空端口连接归为提示", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-pin-"));
  roots.push(root);
  const source = path.join(root, "top.sv");
  fs.writeFileSync(source, "module top; child u(.full()); endmodule\n");
  const result = runNodeSyntaxCheck({
    requestId: 2,
    root,
    files: [source],
    stubs: [{ name: "child", source: "module child(output wire full); endmodule\n" }],
    options: emptySyntaxCheckOptions,
  });
  expect(result.diagnostics.find(item => item.ruleId === "VERILATOR-PINCONNECTEMPTY")?.severity).toBe("info");
});

it("Node CLI 过滤 Verilator 退出摘要但保留真实错误", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-exit-summary-"));
  roots.push(root);
  const source = path.join(root, "top.sv");
  fs.writeFileSync(source, "module top; invalid verilog\n");
  const result = runNodeSyntaxCheck({ requestId: 8, root, files: [source], stubs: [], options: emptySyntaxCheckOptions });
  expect(result.diagnostics.some(item => item.severity === "error")).toBe(true);
  expect(result.diagnostics.some(item => /^Exiting due to/i.test(item.message))).toBe(false);
});

it("Node CLI 按 entity 依赖排序并向 GHDL 提供 IP 黑盒", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-vhdl-"));
  roots.push(root);
  const consumer = path.join(root, "consumer.vhd");
  const ipConsumer = path.join(root, "ip-consumer.vhd");
  const provider = path.join(root, "provider.vhd");
  fs.writeFileSync(consumer, "library ieee; use ieee.std_logic_1164.all; entity consumer is port(a:in std_logic;b:out std_logic); end; architecture rtl of consumer is begin u: entity work. provider port map(a=>a,b=>b); end;\n");
  fs.writeFileSync(ipConsumer, "library ieee; use ieee.std_logic_1164.all; entity ip_consumer is port(clk:in std_logic;din:in std_logic;dout:out std_logic); end; architecture rtl of ip_consumer is begin u: entity work.fifo_256x8 port map(clk=>clk,din=>din,dout=>dout); end;\n");
  fs.writeFileSync(provider, "library ieee; use ieee.std_logic_1164.all; entity provider is port(a:in std_logic;b:out std_logic); end; architecture rtl of provider is begin b<=a; end;\n");
  const result = runNodeSyntaxCheck({
    requestId: 3,
    root,
    files: [consumer, ipConsumer, provider],
    stubs: [],
    vhdlStubs: [{ name: "fifo_256x8", source: "library ieee; use ieee.std_logic_1164.all; entity fifo_256x8 is port(clk:in std_logic;din:in std_logic;dout:out std_logic); end entity;\n" }],
    options: emptySyntaxCheckOptions,
  });
  expect(result.checkedFiles).toBe(3);
  expect(result.backends.find(backend => backend.name === "ghdl")?.files).toBe(3);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
});


it("Node CLI 在 package 使用者之前编译定义", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-package-"));
  roots.push(root);
  const consumer = path.join(root, "a_consumer.sv");
  const provider = path.join(root, "z_package.sv");
  fs.writeFileSync(consumer, "module top; import types::*; byte_t value; assign value = 8'h00; endmodule\n");
  fs.writeFileSync(provider, "package types; typedef logic [7:0] byte_t; endpackage\n");
  const result = runNodeSyntaxCheck({
    requestId: 4,
    root,
    files: [consumer, provider],
    stubs: [],
    options: emptySyntaxCheckOptions,
  });
  expect(result.checkedFiles).toBe(2);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

it("Node CLI 后端启动失败返回 Error 和 failed，不冒充检查成功", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-missing-tools-"));
  roots.push(root);
  const source = path.join(root, "top.sv");
  fs.writeFileSync(source, "module top; endmodule\n");
  const previous = process.env.RTL_VIEWER_TOOLS;
  process.env.RTL_VIEWER_TOOLS = path.join(root, "missing-tools");
  try {
    const result = runNodeSyntaxCheck({ requestId: 5, root, files: [source], stubs: [], options: emptySyntaxCheckOptions });
    expect(result.checkedFiles).toBe(0);
    expect(result.backends[0]?.status).toBe("failed");
    expect(result.diagnostics.some(item => item.severity === "error" && item.message.includes("Verilator"))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.RTL_VIEWER_TOOLS;
    else process.env.RTL_VIEWER_TOOLS = previous;
  }
});


it("Node CLI 依赖排序使用未保存快照中的定义", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-snapshot-order-"));
  roots.push(root);
  const consumer = path.join(root, "consumer.vhd");
  const provider = path.join(root, "provider.vhd");
  fs.writeFileSync(consumer, "entity consumer is end; architecture rtl of consumer is begin u: entity work.provider; end;\n");
  fs.writeFileSync(provider, "entity legacy is end;\n");
  const result = runNodeSyntaxCheck({
    requestId: 6,
    root,
    files: [consumer, provider],
    stubs: [],
    options: emptySyntaxCheckOptions,
    snapshots: [{ file: provider, content: "entity provider is end;\n", encoding: "utf8" }],
  });
  expect(result.checkedFiles).toBe(2);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
});

it("Node CLI 在独立 architecture 之前分析对应 entity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-node-split-entity-"));
  roots.push(root);
  const architecture = path.join(root, "a_rtl.vhd");
  const entity = path.join(root, "z_entity.vhd");
  fs.writeFileSync(architecture, "architecture rtl of split_entity is begin end architecture;\n");
  fs.writeFileSync(entity, "entity split_entity is end entity;\n");
  const result = runNodeSyntaxCheck({ requestId: 7, root, files: [architecture, entity], stubs: [], options: emptySyntaxCheckOptions });
  expect(result.checkedFiles).toBe(2);
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
});
