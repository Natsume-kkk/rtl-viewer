import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ComputationProject } from "../src/analysis/project";
import { codeExpr, readingSteps, selectBranch, keepReadingPrefix } from "../examples/computation/reading";
import { parseExpression } from "../src/analysis/expression";

const example = new ComputationProject(new Map([["arithmetic.v", readFileSync("examples/computation/arithmetic.v", "utf8")]]));
const graph = () => example.trace("signal_example", "out", 5);
const names = (steps: ReturnType<typeof readingSteps>) => steps.map(s => s.node.label);

describe("按分支阅读运算路径", () => {
  it("选复位、保持或常量仍保留已读前缀，不伪造有效数据连接", () => {
    const g = graph(), choices = new Map<string, number>();
    const initial = readingSteps(g);
    const key = initial.at(-1)!.branches[0].key;
    selectBranch(choices, key, 2);
    const held = keepReadingPrefix(initial, readingSteps(g, choices), key);
    expect(names(held)).toEqual(["sum", "product", "result", "out"]);
    expect(held[0].contextOnly).toBe(true);
    expect(held[2].dependencies).toEqual([]);
    expect(held[2].contextDependencies).toEqual([held[1].node.id]);
    const outputKey = held[3].branches[0].key;
    selectBranch(choices, outputKey, 0);
    const constant = keepReadingPrefix(held, readingSteps(g, choices), outputKey);
    expect(names(constant)).toEqual(names(held));
    expect(constant[2].branches[0].selected).toBe(2);
    expect(constant[3].dependencies).toEqual([]);
    selectBranch(choices, key, 1);
    const changed = keepReadingPrefix(constant, readingSteps(g, choices), key);
    expect(names(changed)).toEqual(names(initial).concat("out"));
    expect(changed[0].contextOnly).not.toBe(true);
    expect(changed[2].dependencies).toEqual([changed[1].node.id]);
    expect(changed[3].pending).toBe(true);
  });
  it("首次停在寄存器分支，选使能后才出现后面的限幅分支", () => {
    const g = graph(), choices = new Map<string, number>();
    const initial = readingSteps(g, choices);
    expect(names(initial)).toEqual(["sum", "product", "result"]);
    const branch = initial.at(-1)!.branches[0];
    expect(branch.options.map(o => o.guard)).toEqual(["if (!rst_n)", "else if (en)", "else"]);
    selectBranch(choices, branch.key, 1);
    const next = readingSteps(g, choices);
    expect(names(next)).toEqual(["sum", "product", "result", "out"]);
    expect(next[2].code).toBe("result <= product;");
    expect(next[2].branches[0].options[1].context).toContain("if (!rst_n) …");
    expect(next[3].pending).toBe(true);
    selectBranch(choices, next[3].branches[0].key, 1);
    expect(readingSteps(g, choices).at(-1)!.code).toBe("out = result[7:0];");
  });
  it.each([0, 2])("复位或保持分支 %s 不再追踪乘法输入", index => {
    const g = graph(), choices = new Map<string, number>();
    selectBranch(choices, readingSteps(g).at(-1)!.branches[0].key, index);
    const steps = readingSteps(g, choices);
    expect(names(steps)).toEqual(["result", "out"]);
    expect(steps[0].code).toBe(index === 0 ? "result <= 17'd0;" : "result <= result;");
    expect(steps[0].dependencies).toEqual([]);
  });
  it("改选上游清除后续条件；选择键跨目标追踪保持稳定", () => {
    const g = graph(), choices = new Map<string, number>();
    const key = readingSteps(g).at(-1)!.branches[0].key;
    selectBranch(choices, key, 1);
    const out = readingSteps(g, choices).at(-1)!.branches[0].key;
    selectBranch(choices, out, 1);
    selectBranch(choices, key, 0);
    expect(choices.has(out)).toBe(false);
    expect(readingSteps(example.trace("signal_example", "result", 5), choices).at(-1)!.branches[0].selected).toBe(0);
  });
  it("嵌套分支逐次打开，外层改选后丢弃内层条件", () => {
    const p = new ComputationProject(new Map([["nested.v", "module m(input a,b,x,y,z,output reg q); always @* if(a) begin if(b) q=x; else q=y; end else q=z; endmodule"]]));
    const g = p.trace("m", "q", 5), choices = new Map<string, number>();
    const outer = readingSteps(g).at(-1)!.branches[0];
    selectBranch(choices, outer.key, 0);
    let step = readingSteps(g, choices).at(-1)!;
    expect(step.branches).toHaveLength(2);
    expect(step.branches[1].selected).toBeUndefined();
    selectBranch(choices, step.branches[1].key, 1);
    expect(readingSteps(g, choices).at(-1)!.code).toContain("y");
    selectBranch(choices, outer.key, 1);
    step = readingSteps(g, choices).at(-1)!;
    expect(step.branches).toHaveLength(1);
    expect(step.code).toContain("z");
  });
  it("表达式三目、VHDL elsif 与切片保留语言写法", () => {
    const g = graph(), choices = new Map<string, number>();
    selectBranch(choices, readingSteps(g).at(-1)!.branches[0].key, 1);
    expect(readingSteps(g, choices).at(-1)!.branches[0].options[0].guard).toBe("(result > 17'd255) ?");
    const p = new ComputationProject(new Map([["m.vhd", "entity m is port(a,b,x,y,z: in bit; q: out bit); end; architecture rtl of m is begin process(all) begin if a='1' then q<=x; elsif b='1' then q<=y; else q<=z; end if; end process; end;"]]));
    const branch = readingSteps(p.trace("m", "q", 5)).at(-1)!.branches[0];
    expect(branch.options[1].guard).toBe("elsif b = '1' then");
    expect(codeExpr(parseExpression("d(0 to 7)", "vhdl", 0, new Set(["d"])), true)).toBe("d(0 to 7)");
  });
  it("独立操作数不产生串行连线，多驱动不变成择一来源", () => {
    const p = new ComputationProject(new Map([["m.v", "module m(input a,b,c,d,output y, inout bus); wire x=a+b; wire z=c+d; assign y=x*z; assign bus=x; endmodule"]]));
    const steps = readingSteps(p.trace("m", "y", 5));
    expect(names(steps)).toEqual(["x", "z", "y"]);
    expect(steps[1].dependencies).not.toContain(steps[0].node.id);
    expect(steps[2].dependencies).toEqual([steps[0].node.id, steps[1].node.id]);
    const bus = readingSteps(p.trace("m", "bus", 5));
    expect(bus.some(s => s.node.kind === "external")).toBe(true);
    expect(bus.at(-1)!.node.kind).toBe("resolved");
    expect(bus.at(-1)!.dependencies.length).toBe(2);
  });
  it("深度截止的寄存器不提前展示尚未展开的分支", () => {
    const steps = readingSteps(example.trace("signal_example", "out", 0));
    expect(steps.find(s => s.node.label === "result")!.branches).toEqual([]);
    expect(steps.at(-1)!.node.label).toBe("out");
    expect(steps.at(-1)!.pending).toBe(true);
  });
  it("复用模块的两个实例可分别选择，不串用表达式缓存上的分支", () => {
    const p = new ComputationProject(new Map([["m.v", `module unit(input sel,a,b,output q); assign q=sel?a:b; endmodule
      module top(input sa,sb,a,b,c,d,output out); wire x,y;
      unit ua(.sel(sa),.a(a),.b(b),.q(x)); unit ub(.sel(sb),.a(c),.b(d),.q(y)); assign out=x+y; endmodule`]]));
    const g = p.trace("top", "out", 8), choices = new Map<string, number>();
    const first = readingSteps(g).at(-1)!;
    expect(first.node.path).toBe("top/ua");
    selectBranch(choices, first.branches[0].key, 0);
    const second = readingSteps(g, choices).at(-1)!;
    expect(second.node.path).toBe("top/ub");
    selectBranch(choices, second.branches[0].key, 1);
    const steps = readingSteps(g, choices);
    const inputs = steps.filter(s => s.node.kind === "input").map(s => `${s.node.path}/${s.node.label}`);
    expect(inputs).toEqual(["top/ua/a", "top/ub/b"]);
  });
});
