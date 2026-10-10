import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile, parseXci, scanStructure } from "../src/parser";
import { ModuleIndex } from "../src/model";
import { buildHierarchy, type TreeNode } from "../src/model/hierarchy";
import { decode, walk } from "./helpers/fs-scan";
import { acceptanceRoot } from "./helpers/acceptance-root";

/**
 * CP7 真实工程验收：对 RTL_VIEWER_ACCEPTANCE_CP7 指定的 cameralink 工程副本（
 * 含 58 个 GBK 文件、2 个 .xci IP、IP 生成的 VHDL）跑完整解析管线。
 * 未配置时跳过，配置无效时失败；真实工程副本不入 Git。
 */
const PROJECT = acceptanceRoot("RTL_VIEWER_ACCEPTANCE_CP7") ?? "";

function findNode(node: TreeNode, pred: (n: TreeNode) => boolean): TreeNode | undefined {
  if (pred(node)) return node;
  for (const c of node.children) {
    const hit = findNode(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

describe.skipIf(!PROJECT)("CP7 真实工程验收（cameralink 副本）", () => {
  function build() {
    const files = { hdl: [] as string[], xci: [] as string[], con: [] as string[] };
    walk(PROJECT, files);
    // 与应用一致：.xci 所在目录树内的 HDL 不进索引（IP 生成目录）
    const xciDirs = files.xci.map((f) => f.slice(0, f.lastIndexOf("/")));
    const hdlFiles = files.hdl.filter(
      (f) => !xciDirs.some((dir) => f.startsWith(dir + "/") || f.startsWith(dir + "\\")),
    );
    const index = new ModuleIndex();
    const structures = new Map<string, ReturnType<typeof scanStructure>>();
    const encodings = new Map<string, string>();
    for (const file of hdlFiles) {
      const { content, encoding } = decode(readFileSync(file));
      encodings.set(file, encoding);
      const mods = scanStructure(content, file);
      index.addStructure(mods);
      structures.set(file, mods);
    }
    for (const file of files.xci) {
      const { content } = decode(readFileSync(file));
      index.addIp(parseXci(content, file).name, file);
    }
    const h = buildHierarchy(index, structures, "cameralink_converter_top");
    const hAuto = buildHierarchy(index, structures);
    return { files, h, hAuto, encodings };
  }

  it("GBK 文件解码无乱码", () => {
    const { encodings } = build();
    const gbkFiles = [...encodings.entries()].filter(([, e]) => e === "gbk");
    expect(gbkFiles.length).toBeGreaterThanOrEqual(2);
    const sample = gbkFiles.find(([f]) => f.includes("gbk_sample"));
    expect(sample).toBeDefined();
    const { content } = decode(readFileSync(sample![0]));
    expect(content).toContain("时钟复位模块");
    expect(content).toContain("中文注释");
    expect(content).not.toContain("�");
  });

  it("层级树：顶层正确、IP 解析为黑盒节点", () => {
    const { h } = build();
    expect(h.tops).toHaveLength(1);
    const root = h.tops[0];
    expect(root.moduleName).toBe("cameralink_converter_top");
    expect(root.children.length).toBeGreaterThan(2);
    for (const ipName of ["cl_clock_ip", "cl_line_ram_ip"]) {
      const node = findNode(root, (n) => n.moduleName === ipName);
      expect(node, `IP ${ipName} 应出现在树中`).toBeDefined();
      expect(node!.kind).toBe("ip");
    }
  });

  it("自动识别顶层：仿真封装环境解包出真实顶层", () => {
    const { hAuto } = build();
    expect(hAuto.tops[0]?.moduleName).toBe("cameralink_converter_top");
  });

  it("IP 端口可从 stub 提取（补全端口的候选路径）", () => {
    const cases: { xci: string; expectPorts: string[] }[] = [
      {
        xci: "ip/generated/ip-20261004-111410-ce9f5898/cl_clock_ip/cl_clock_ip.xci",
        expectPorts: ["clk_out1", "resetn", "locked", "clk_in1"],
      },
      {
        xci: "ip/generated/ip-20261004-111410-ce9f5898/cl_line_ram_ip/cl_line_ram_ip.xci",
        expectPorts: ["clka", "wea", "addra", "doutb"],
      },
    ];
    for (const c of cases) {
      const xciPath = join(PROJECT, c.xci).replace(/\\/g, "/");
      const name = c.xci.split("/").pop()!.replace(/\.xci$/i, "");
      const base = xciPath.replace(/\.xci$/i, "");
      const dir = xciPath.slice(0, xciPath.lastIndexOf("/"));
      const candidates = [
        `${base}.v`,
        `${dir}/synth/${name}.v`,
        `${dir}/sim/${name}.v`,
      ];
      let ports: string[] = [];
      for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        const { content } = decode(readFileSync(candidate));
        const mods = parseFile(content, candidate);
        const mod = mods.find((m) => m.name.toLowerCase() === name.toLowerCase()) ?? mods[0];
        if (mod && mod.ports.length > 0) {
          ports = mod.ports.map((p) => p.name);
          break;
        }
      }
      for (const p of c.expectPorts) {
        expect(ports, `${name} 应提取到端口 ${p}`).toContain(p);
      }
    }
  });

  it("未解析例化占比低，未使用分组有效", () => {
    const { h } = build();
    const unresolved: string[] = [];
    const collect = (n: TreeNode) => {
      if (n.kind === "unresolved") unresolved.push(n.moduleName);
      n.children.forEach(collect);
    };
    h.tops.forEach(collect);
    expect(unresolved.length).toBeLessThanOrEqual(5);
    expect(h.unused.length).toBeGreaterThan(0);
  });
});
