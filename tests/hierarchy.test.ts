import { describe, expect, it } from "vitest";
import { scanStructure } from "../src/parser";
import { ModuleIndex } from "../src/model";
import { buildHierarchy, findInstancesOf } from "../src/model/hierarchy";

function buildFromFiles(
  files: Record<string, string>,
  xci: { name: string; file: string }[] = [],
  topName?: string,
) {
  const index = new ModuleIndex();
  const structures = new Map<string, ReturnType<typeof scanStructure>>();
  for (const [file, src] of Object.entries(files)) {
    const mods = scanStructure(src, file);
    index.addStructure(mods);
    structures.set(file, mods);
  }
  for (const ip of xci) index.addIp(ip.name, ip.file);
  return buildHierarchy(index, structures, topName);
}

describe("层级树构建", () => {
  it("单顶层自动选择，例化逐层展开", () => {
    const h = buildFromFiles({
      "top.v": `module top;
  sub u_sub (.x(1'b0));
  sub u_sub2 (.x(1'b1));
endmodule`,
      "sub.v": `module sub(input x);
  leaf u_leaf (.y(x));
endmodule`,
      "leaf.v": `module leaf(input y);
endmodule`,
    });
    expect(h.tops).toHaveLength(1);
    expect(h.tops[0].label).toBe("top");
    expect(h.tops[0].children.map((c) => c.label)).toEqual(["u_sub", "u_sub2"]);
    expect(h.tops[0].children[0].children[0].moduleName).toBe("leaf");
    // 例化点：子节点记录父模块文件与例化行，顶层节点无
    expect(h.tops[0].instFile).toBeUndefined();
    expect(h.tops[0].children[0].instFile).toBe("top.v");
    expect(h.tops[0].children[0].instLine).toBe(2);
    expect(h.tops[0].children[1].instLine).toBe(3);
    expect(h.tops[0].children[0].children[0].instFile).toBe("sub.v");
    expect(h.unused).toEqual([]);
  });

  it("多顶层自动识别可达子图最大者，候选列表保留", () => {
    const h = buildFromFiles({
      "a.v": `module a; leaf u (.x(1'b0)); endmodule`,
      "b.v": `module b; endmodule`,
      "leaf.v": `module leaf(input x); endmodule`,
    });
    expect(h.tops).toHaveLength(1);
    expect(h.tops[0].moduleName).toBe("a");
    expect(h.topCandidates.sort()).toEqual(["a", "b"]);
    expect(h.unused.map((u) => u.name)).toEqual(["b"]);
  });

  it("未使用只含无父无子的孤儿模块，有例化的顶层候选（tb 等）不列入", () => {
    const h = buildFromFiles(
      {
        "a.v": `module a; leaf u (.x(1'b0)); endmodule`,
        "leaf.v": `module leaf(input x); endmodule`,
        "tb_top.v": `module tb_top; env u_env (); endmodule`,
        "env.v": `module env; endmodule`,
        "orphan.v": `module orphan; endmodule`,
      },
      [],
      "a",
    );
    // env 被 tb_top 例化（有父）；tb_top 例化了 env（有子，属顶层候选）；orphan 无父无子才是未使用
    expect(h.unused.map((u) => u.name)).toEqual(["orphan"]);
  });

  it("测试台候选向内解包出 DUT 顶层", () => {
    const h = buildFromFiles({
      "tb_top.v": `module tb_top; big u_b (.x(1'b0)); endmodule`,
      "big.v": `module big(input x); leaf u_l (.y(x)); endmodule`,
      "leaf.v": `module leaf(input y); endmodule`,
      "small.v": `module small; endmodule`,
    });
    expect(h.topCandidates.sort()).toEqual(["small", "tb_top"]);
    expect(h.tops[0].moduleName).toBe("big");
  });

  it("仿真目录内的封装环境同样解包，孤立小模块不误选", () => {
    const h = buildFromFiles({
      "sim/system/env_selftest.sv": `module env_selftest; dut u_d (.x(1'b0)); endmodule`,
      "rtl/dut.v": `module dut(input x); leaf u_l (.y(x)); endmodule`,
      "rtl/leaf.v": `module leaf(input y); endmodule`,
      "rtl/gbk_sample.v": `module gbk_sample; endmodule`,
    });
    expect(h.tops[0].moduleName).toBe("dut");
  });

  it("指定顶层后其余未引用模块归入未使用", () => {
    const h = buildFromFiles(
      {
        "a.v": `module a; leaf u (.x(1'b0)); endmodule`,
        "b.v": `module b; endmodule`,
        "leaf.v": `module leaf(input x); endmodule`,
      },
      [],
      "a",
    );
    expect(h.tops[0].moduleName).toBe("a");
    expect(h.unused.map((u) => u.name)).toEqual(["b"]);
  });

  it("循环例化标记 recursive 且不死循环", () => {
    const h = buildFromFiles(
      {
        "a.v": `module a; b u_b (.x(1'b0)); endmodule`,
        "b.v": `module b(input x); a u_a (.x(x)); endmodule`,
      },
      [],
      "a",
    );
    const b = h.tops[0].children[0];
    expect(b.moduleName).toBe("b");
    expect(b.children[0].moduleName).toBe("a");
    expect(b.children[0].recursive).toBe(true);
    expect(b.children[0].children).toEqual([]);
  });

  it("IP 核解析为黑盒叶子节点", () => {
    const h = buildFromFiles(
      {
        "top.v": `module top; clk_wiz_0 u_clk (.clk_in(1'b0)); missing u_m (.a(1'b0)); endmodule`,
      },
      [{ name: "clk_wiz_0", file: "ip/clk_wiz_0/clk_wiz_0.xci" }],
    );
    const [clk, missing] = h.tops[0].children;
    expect(clk.kind).toBe("ip");
    expect(clk.children).toEqual([]);
    expect(missing.kind).toBe("unresolved");
  });

  it("VHDL 工程建树", () => {
    const h = buildFromFiles({
      "top.vhd": `entity top is end entity;
architecture rtl of top is
begin
  u_sub : entity work.sub_mod port map (clk => '0');
end architecture;`,
      "sub.vhd": `entity sub_mod is end entity;
architecture rtl of sub_mod is
begin
end architecture;`,
    });
    expect(h.tops).toHaveLength(1);
    expect(h.tops[0].children[0].moduleName).toBe("sub_mod");
  });

  it("厂商原语显示为原语叶子，不标 unresolved", () => {
    const h = buildFromFiles({
      "top.vhd": `entity top is end entity;
architecture rtl of top is
begin
  CLKDV_BUFG_INST : BUFG port map (I => '0', O => open);
  u_sub : entity work.sub_mod port map (clk => '0');
end architecture;`,
      "sub.vhd": `entity sub_mod is end entity;
architecture rtl of sub_mod is
begin
end architecture;`,
    });
    const [bufg, sub] = h.tops[0].children;
    expect(bufg.kind).toBe("primitive");
    expect(bufg.children).toEqual([]);
    expect(sub.kind).toBe("module");
  });
});

describe("模块反向引用（被谁例化）", () => {
  it("列出所有例化位置，大小写不敏感", () => {
    const structures = new Map<string, ReturnType<typeof scanStructure>>();
    for (const [file, src] of Object.entries({
      "top.v": `module top;
  sub u_a (.x(1'b0));
  sub u_b (.x(1'b1));
endmodule`,
      "mid.v": `module mid;
  SUB u_c (.x(1'b0));
endmodule`,
      "sub.v": `module sub(input x);
endmodule`,
    })) {
      structures.set(file, scanStructure(src, file));
    }
    const sites = findInstancesOf(structures, "sub");
    expect(sites).toEqual([
      { parent: "top", file: "top.v", line: 2 },
      { parent: "top", file: "top.v", line: 3 },
      { parent: "mid", file: "mid.v", line: 2 },
    ]);
    expect(findInstancesOf(structures, "nonexistent")).toEqual([]);
  });
});
