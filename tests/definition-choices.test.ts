import { expect, it } from "vitest";
import { analyzeDefinitionChoices } from "../src/app/definition-choices";
import type { TreeNode } from "../src/model/hierarchy";

function conflictNode(moduleName = "core", label = "u_core", instLine = 2): TreeNode {
  return {
    key: `top/${label}`,
    label,
    moduleName,
    kind: "unresolved",
    recursive: false,
    instFile: moduleName === "core" ? "top.v" : "top.vhd",
    instLine,
    problem: "存在多个同名定义",
    definitionCandidates: [
      { file: "old/core.v", line: 1 },
      { file: "new/core.v", line: 1 },
    ],
    children: [],
  };
}

it("唯一完整匹配命名端口和参数的候选标记为推荐，但不自动绑定", () => {
  const files = new Map([
    ["top.v", "module top;\ncore #(.WIDTH(8)) u_core(.clk(clk), .data(data));\nendmodule"],
    ["old/core.v", "module core(input clk); endmodule"],
    ["new/core.v", "module core #(parameter WIDTH = 8)(input clk, input [WIDTH-1:0] data); endmodule"],
  ]);
  const choices = analyzeDefinitionChoices(conflictNode(), file => files.get(file));
  expect(choices[0].match).toBe("mismatch");
  expect(choices[0].reason).toContain("缺少端口：data");
  expect(choices[0].reason).toContain("缺少参数：WIDTH");
  expect(choices[1]).toMatchObject({ file: "new/core.v", match: "match", recommended: true });
});

it("多个候选都匹配或候选接口未知时不给唯一推荐", () => {
  const node = conflictNode();
  const files = new Map([
    ["top.v", "module top;\ncore u_core(.clk(clk), .data(data));\nendmodule"],
    ["old/core.v", "module core(input clk, input data); endmodule"],
    ["new/core.v", "module core(input clk, input data); endmodule"],
  ]);
  const tied = analyzeDefinitionChoices(node, file => files.get(file));
  expect(tied.map(candidate => candidate.match)).toEqual(["match", "match"]);
  expect(tied.some(candidate => candidate.recommended)).toBe(false);

  files.delete("old/core.v");
  const unknown = analyzeDefinitionChoices(node, file => files.get(file));
  expect(unknown.map(candidate => candidate.match)).toEqual(["unknown", "match"]);
  expect(unknown.some(candidate => candidate.recommended)).toBe(false);
});

it("位置连接或没有命名接口证据时不猜测候选", () => {
  const node = conflictNode();
  const files = new Map([
    ["top.v", "module top;\ncore u_core(clk, data);\nendmodule"],
    ["old/core.v", "module core(input clk); endmodule"],
    ["new/core.v", "module core(input clk, input data); endmodule"],
  ]);
  const positional = analyzeDefinitionChoices(node, file => files.get(file));
  expect(positional.every(candidate => candidate.match === undefined)).toBe(true);

  files.set("top.v", "module top;\ncore u_core();\nendmodule");
  const empty = analyzeDefinitionChoices(node, file => files.get(file));
  expect(empty.every(candidate => candidate.match === undefined)).toBe(true);
});

it("VHDL 多 architecture 复用 entity 接口但不制造唯一推荐", () => {
  const node = {
    ...conflictNode("core", "u_core", 4),
    instFile: "top.vhd",
    definitionCandidates: [
      { file: "entity.vhd", line: 1 },
      { file: "a.vhd", line: 1 },
      { file: "b.vhd", line: 1 },
    ],
  };
  const files = new Map([
    ["top.vhd", "entity top is end;\narchitecture rtl of top is\nbegin\nu_core: entity work.core port map(clk => clk, data => data);\nend;"],
    ["entity.vhd", "entity core is port(clk:in bit; data:in bit); end;"],
    ["a.vhd", "architecture a of core is begin end;"],
    ["b.vhd", "architecture b of core is begin end;"],
  ]);
  const choices = analyzeDefinitionChoices(node, file => files.get(file));
  expect(choices.map(candidate => candidate.match)).toEqual(["match", "match", "match"]);
  expect(choices.some(candidate => candidate.recommended)).toBe(false);
});
