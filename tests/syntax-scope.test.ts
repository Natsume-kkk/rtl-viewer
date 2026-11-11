import { expect, it } from "vitest";
import { scanStructure } from "../src/parser";
import { syntaxScope } from "../src/app/syntax-scope";
import { filePathKey } from "../src/file-path";

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
