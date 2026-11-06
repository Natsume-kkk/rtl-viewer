import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeSyntaxCheck } from "../src/app/node-syntax";
import { emptySyntaxCheckOptions } from "../src/ipc";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

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
