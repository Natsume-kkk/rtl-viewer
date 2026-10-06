import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseXci, scanStructure } from "../src/parser";
import { ModuleIndex } from "../src/model";
import { buildHierarchy, type Hierarchy, type TreeNode } from "../src/model/hierarchy";
import { decode, walk } from "./helpers/fs-scan";

/**
 * 主人真实工程验收（只读，不修改工程内任何内容）：
 * - P1 Vivado 工程（z7_test，Verilog 为主 + 27 个 xci IP）
 * - P2 ISE 工程（GDCX_ZHGL，VHDL + ipcore_dir coregen IP）
 * 路径不存在时跳过。
 */
const P1 = "D:/work/fpga/12xsensor/CMV50000_100/z7_test/project_5_det_rst";
const P2 =
  "D:/work/fpga/611/GDCX_ZHGL_S_2.03_time_check_download/GDCX_ZHGL_S_2.03_time_check_download";

function build(root: string): { h: Hierarchy; hdlCount: number; xciCount: number } {
  const files = { hdl: [] as string[], xci: [] as string[], con: [] as string[] };
  walk(root, files);
  const xciDirs = files.xci.map((f) => f.slice(0, f.lastIndexOf("/")));
  const hdlFiles = files.hdl.filter(
    (f) => !xciDirs.some((dir) => f.startsWith(dir + "/") || f.startsWith(dir + "\\")),
  );
  const index = new ModuleIndex();
  const structures = new Map<string, ReturnType<typeof scanStructure>>();
  for (const file of hdlFiles) {
    const { content } = decode(readFileSync(file));
    const mods = scanStructure(content, file);
    index.addStructure(mods);
    structures.set(file, mods);
  }
  for (const file of files.xci) {
    const { content } = decode(readFileSync(file));
    index.addIp(parseXci(content, file).name, file);
  }
  // 不传 topName：验证顶层自动识别
  return { h: buildHierarchy(index, structures), hdlCount: hdlFiles.length, xciCount: files.xci.length };
}

function collect(root: TreeNode, pred: (n: TreeNode) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (pred(n)) out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

function findNode(node: TreeNode, pred: (n: TreeNode) => boolean): TreeNode | undefined {
  return collect(node, pred)[0];
}

describe.skipIf(!existsSync(P1))("P1 Vivado 工程（z7_test）", () => {
  // 这 5 个 IP 在全工程无 xci、无定义文件（合成产物在已跳过的 .runs 中），
  // 属于预期黑盒，与 Vivado 缺 IP 时的表现一致。
  const P1_EXPECTED_BLACKBOX = new Set([
    "clk_wiz_1",
    "selectio_wiz_0",
    "c_addsub_0",
    "fifo_12_1024",
    "fifo_24x2048",
  ]);

  it("顶层自动识别，层级与 IP 节点解析正常", () => {
    const { h, hdlCount, xciCount } = build(P1);
    console.log(`P1: hdl=${hdlCount} xci=${xciCount} tops=${h.tops.map((t) => t.moduleName)} candidates=${h.topCandidates.length} unused=${h.unused.length}`);
    const unresolved = h.tops.flatMap((t) => collect(t, (n) => n.kind === "unresolved"));
    const ips = h.tops.flatMap((t) => collect(t, (n) => n.kind === "ip"));
    expect(h.tops).toHaveLength(1);
    expect(h.tops[0].children.length).toBeGreaterThan(0);
    expect(ips.length).toBeGreaterThan(0);
    const unexpected = [...new Set(unresolved.map((n) => n.moduleName))].filter(
      (n) => !P1_EXPECTED_BLACKBOX.has(n),
    );
    expect(unexpected, `出现预期外的未解析模块: ${unexpected}`).toEqual([]);
  });

  it("索引不包含工具生成目录（.runs/.ip_user_files 等）的文件", () => {
    const { h } = build(P1);
    const files = h.unused.map((u) => u.file);
    const collectFiles = (n: TreeNode): string[] => [
      ...(n.file ? [n.file] : []),
      ...n.children.flatMap(collectFiles),
    ];
    files.push(...h.tops.flatMap(collectFiles));
    for (const f of files) {
      expect(f).not.toMatch(/\.(runs|sim|cache|hw|gen|ip_user_files)[/\\]/);
    }
  });
});

describe.skipIf(!existsSync(P2))("P2 ISE 工程（GDCX_ZHGL）", () => {
  // wrapped_* 是 coregen 内部行为模型，定义在 ISE 安装库中、工程内无定义，
  // 属于预期黑盒。
  const P2_EXPECTED_BLACKBOX = new Set([
    "wrapped_fifo_async_512",
    "wrapped_fifo_tx_uart",
    "wrapped_fifo_16x128",
    "wrapped_sram_wr_fifo",
    "wrapped_fifo_1024x8",
  ]);

  it("顶层自动识别为 GDCX_ZHGL_TOP，coregen IP 与原语正确归类", () => {
    const { h, hdlCount } = build(P2);
    console.log(`P2: hdl=${hdlCount} tops=${h.tops.map((t) => t.moduleName)} candidates=${h.topCandidates.length} unused=${h.unused.length}`);
    const root = h.tops[0];
    const unresolved = collect(root, (n) => n.kind === "unresolved");
    const primitives = collect(root, (n) => n.kind === "primitive");
    expect(root.moduleName).toBe("GDCX_ZHGL_TOP");
    // CLK_SYS 是 dcm_0（ipcore_dir coregen 包装）的例化标签，必须解析到定义
    const clkSys = findNode(root, (n) => n.label === "CLK_SYS");
    expect(clkSys, "CLK_SYS 应出现在树中").toBeDefined();
    expect(clkSys!.moduleName.toLowerCase()).toBe("dcm_0");
    expect(clkSys!.kind).toBe("module");
    // BUFG/DCM_ADV 等按原语叶子，不再标 unresolved
    expect(primitives.length).toBeGreaterThan(0);
    const unexpected = [...new Set(unresolved.map((n) => n.moduleName))].filter(
      (n) => !P2_EXPECTED_BLACKBOX.has(n),
    );
    expect(unexpected, `出现预期外的未解析模块: ${unexpected}`).toEqual([]);
  });
});
