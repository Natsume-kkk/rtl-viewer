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

  it("工程根本身位于 tests 等目录段内时不误判模块为仿真候选", () => {
    // 夹具或工程放在 tests/ 之类的父目录下时，sim/tb 目录判定只看工程相对路径；
    // 否则所有模块都被当成仿真环境，解包会一直走到叶子
    const h = buildFromFiles({
      "D:/proj/tests/cp7/project/tb_top.v": `module tb_top; big u_b (.x(1'b0)); endmodule`,
      "D:/proj/tests/cp7/project/big.v": `module big(input x); leaf u_l (.y(x)); endmodule`,
      "D:/proj/tests/cp7/project/leaf.v": `module leaf(input y); endmodule`,
    });
    expect(h.tops[0].moduleName).toBe("big");
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

  it("前缀与原语相近的用户模块按 unresolved 处理，不猜测归类为原语", () => {
    const userModules = ["buffer_ctrl", "buf_ctrl", "fdma", "ld_data", "srl_fifo", "keepalive"];
    const insts = userModules.map((m, i) => `  ${m} u_${i} ();`).join("\n");
    const h = buildFromFiles({ "top.v": `module top;\n${insts}\nendmodule` });
    for (const [i, name] of userModules.entries()) {
      const node = h.tops[0].children[i];
      expect(node.moduleName).toBe(name);
      expect(node.kind, `${name} 应为 unresolved 而非原语`).toBe("unresolved");
    }
  });

  it("真实 UNISIM 原语族名仍识别为原语叶子", () => {
    const primitives = [
      "FDRE", "FDCE", "LDCE", "SRLC32E", "RAMB36E1", "DSP48E1",
      "MMCME2_ADV", "PLLE2_ADV", "DCM_ADV", "IBUFDS", "OBUFDS",
      "IBUFG", "IBUFGDS", "BUFGCE", "BUFIO", "BUFR", "BUFMRCE", "IDELAYCTRL",
    ];
    const insts = primitives.map((m, i) => `  ${m} u_${i} ();`).join("\n");
    const h = buildFromFiles({ "top.v": `module top;\n${insts}\nendmodule` });
    for (const [i, name] of primitives.entries()) {
      const node = h.tops[0].children[i];
      expect(node.kind, `${name} 应为原语`).toBe("primitive");
      expect(node.children).toEqual([]);
    }
  });

  it("VHDL entity 与 architecture 分文件时例化边不丢失", () => {
    const files = {
      "top.vhd": `entity top is end entity;`,
      "top_rtl.vhd": `architecture rtl of top is
begin
  u_sub : entity work.sub_mod port map (clk => '0');
end architecture;`,
      "sub.vhd": `entity sub_mod is end entity;
architecture rtl of sub_mod is
begin
end architecture;`,
    };
    // entity 文件先扫描：空例化的 entity 结构先占位，architecture 结构的例化边仍须归并
    const h1 = buildFromFiles(files);
    expect(h1.tops[0].moduleName).toBe("top");
    expect(h1.tops[0].children.map((c) => c.moduleName)).toEqual(["sub_mod"]);
    // architecture 文件先扫描：例化边同样保留
    const h2 = buildFromFiles({
      "top_rtl.vhd": files["top_rtl.vhd"],
      "top.vhd": files["top.vhd"],
      "sub.vhd": files["sub.vhd"],
    });
    expect(h2.tops[0].children.map((c) => c.moduleName)).toEqual(["sub_mod"]);
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

describe("层级树性能", () => {
  it("深层菱形复用：children 懒构建，不沿例化路径组合爆炸", () => {
    // 链式菱形：lvl_i 例化 lvl_{i+1} 两次，例化路径数 2^26，全量展开必然超时/爆内存；
    // 懒构建只在访问 children 时物化直接子节点，成本随实际访问的层级走
    const depth = 26;
    const files: Record<string, string> = {
      "top.v": `module top;\n  lvl0 u_a ();\n  lvl0 u_b ();\nendmodule`,
    };
    for (let i = 0; i < depth; i++) {
      files[`lvl${i}.v`] = `module lvl${i};\n  lvl${i + 1} u_a ();\n  lvl${i + 1} u_b ();\nendmodule`;
    }
    files[`lvl${depth}.v`] = `module lvl${depth};\nendmodule`;
    const h = buildFromFiles(files, [], "top");
    expect(h.tops).toHaveLength(1);
    // 逐层深入访问仍正确（children 内容不受影响）
    let node = h.tops[0];
    for (let i = 0; i <= depth; i++) {
      expect(node.children).toHaveLength(2);
      expect(node.children[0].moduleName).toBe(`lvl${i}`);
      node = node.children[0];
    }
    expect(node.children).toHaveLength(0);
  });
});

it("entity 先扫描时，定义仍在 entity，例化定位保留 architecture 来源", () => {
  const h=buildFromFiles({
    "a_entity.vhd":"entity split_top is port(clk: in bit); end entity;",
    "b_arch.vhd":"architecture rtl of split_top is\nbegin\nu_leaf: entity work.leaf port map(clk=>clk);\nend architecture;",
    "c_leaf.vhd":"entity leaf is port(clk: in bit); end entity;"
  });
  expect(h.tops[0].file).toBe("a_entity.vhd");
  expect(h.tops[0].children[0].instFile).toBe("b_arch.vhd");
  expect(h.tops[0].children[0].instLine).toBe(3);
});
