import { expect, it } from "vitest";
import { scanStructure } from "../src/parser";
import { syntaxScope } from "../src/app/syntax-scope";
import { orderVhdlFiles, syntaxDependencyFiles } from "../src/app/syntax-order";
import { filePathKey } from "../src/file-path";

it("Verilog 严格按大小写跟踪两个模块各自的传递依赖", () => {
  const sources = {
    "top.sv": "module top; core u(); CORE v(); endmodule",
    "a.sv": "module core; leaf u(); endmodule",
    "b.sv": "module CORE; LEAF v(); endmodule",
    "c.sv": "module leaf; endmodule",
    "d.sv": "module LEAF; endmodule",
  };
  const scope = syntaxScope(new Map(Object.entries(sources).map(([file, source]) => [file, scanStructure(source, file)])), [], new Map(), "top");
  expect(scope.files).toEqual(new Set(Object.keys(sources)));
  expect(scope.topology[0].children.map(node => node.children[0]?.moduleName)).toEqual(["leaf", "LEAF"]);
});

it("旧版小写定义选择由已保存的文件迁移到实际 Verilog 名称", () => {
  const sources = {
    "top.sv": "module top; Core u(); core v(); endmodule",
    "a.sv": "module Core; omitted u(); endmodule",
    "b.sv": "module Core; leaf u(); endmodule",
    "lower.sv": "module core; endmodule",
    "leaf.sv": "module leaf; endmodule",
  };
  const index = syntaxScope(new Map(Object.entries(sources).map(([file, source]) => [file, scanStructure(source, file)])), [], new Map([["core", "b.sv"]]), "top");
  expect(index.files).toEqual(new Set(["top.sv", "b.sv", "lower.sv", "leaf.sv"]));
});

it("VHDL context 跨库传递依赖加入检查范围并先于引用方分析", () => {
  const top = { actual: "a_top.vhd", library: "work", source: "library shared; context shared.common; entity top is end;" };
  const ctx = { actual: "b_context.vhd", library: "shared", source: "context common is library shared; use shared.types.all; end context;" };
  const pkg = { actual: "c_package.vhd", library: "shared", source: "package types is end package;" };
  const files = [top, ctx, pkg];
  expect(syntaxDependencyFiles(files, new Set([top.actual]), file => file.source)).toEqual(files.map(file => file.actual));
  expect(orderVhdlFiles(files, file => file.source)).toEqual([pkg, ctx, top]);
});

it("检查层级保留定义选择，重复定义不猜测子依赖", () => {
  const structures = new Map([
    ["D:/p/top.sv", scanStructure("module top; child u(); endmodule", "D:/p/top.sv")],
    ["D:/p/a.sv", scanStructure("module child; leaf u(); endmodule", "D:/p/a.sv")],
    ["D:/p/b.sv", scanStructure("module child; endmodule", "D:/p/b.sv")],
    ["D:/p/leaf.sv", scanStructure("module leaf; endmodule", "D:/p/leaf.sv")],
  ]);
  const original = [...structures];
  const ambiguous = syntaxScope(structures, [], new Map(), "top");
  expect(ambiguous.files).toEqual(new Set(["D:/p/top.sv", "D:/p/a.sv", "D:/p/b.sv"].map(filePathKey)));
  const chosen = syntaxScope(structures, [], new Map([["child", "D:/p/b.sv"]]), "top");
  expect(chosen.files).toEqual(new Set(["D:/p/top.sv", "D:/p/b.sv"].map(filePathKey)));
  expect([...structures]).toEqual(original);
});

it("VHDL 声明与实现分文件时追踪到 Verilog 后代，递归例化有界", () => {
  const sources = new Map([
    ["D:/p/top.vhd", "entity top is end;"],
    ["D:/p/rtl.vhd", "architecture rtl of top is component child is end component; begin u: child port map(); end;"],
    ["D:/p/child.sv", "module child; leaf u(); endmodule"],
    ["D:/p/leaf.sv", "module leaf; child u(); endmodule"],
  ]);
  const structures = new Map([...sources].map(([file, content]) => [file, scanStructure(content, file)]));
  expect(syntaxScope(structures, [], new Map(), "top").files).toEqual(new Set([...sources.keys()].map(filePathKey)));
});
