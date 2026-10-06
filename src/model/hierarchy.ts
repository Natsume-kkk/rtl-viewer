import type { ModuleInfo } from "../parser";
import { ModuleIndex } from "./index";

export type NodeKind = "module" | "ip" | "unresolved" | "primitive";

/**
 * 常见厂商原语（Xilinx UNISIM 家族）。只在例化无定义时生效：
 * 命中按原语叶子显示、不标 unresolved；已定义的同名模块仍按 module 处理。
 */
const PRIMITIVE_RE =
  /^(?:gnd|vcc|pulldown|pullup|inv|bufg\w*|bufio\w*|i?o?buf\w*|dcm\w*|mmcm\w*|pll\w*|ramb?\d\w*|dsp48\w*|fd\w*|ld\w*|iddr\w*|oddr\w*|(?:i|o)serdes\w*|idelay\w*|odelay\w*|carry\d|muxcy\w*|xorcy\w*|muxf\d|srl\w*|lut\d|and\d|or\d|nand\d|nor\d|xor\d|xnor\d|startupe?\w*|gt[phex]\w*|bscan\w*|icap\w*|keep\w*)$/i;

export function isVendorPrimitive(name: string): boolean {
  return PRIMITIVE_RE.test(name);
}

export interface InstanceSite {
  /** 例化它的父模块名 */
  parent: string;
  file: string;
  line: number;
}

/** 反向引用：工程内哪些模块在什么位置例化了指定模块（大小写不敏感）。 */
export function findInstancesOf(
  structures: Map<string, ModuleInfo[]>,
  moduleName: string,
): InstanceSite[] {
  const key = moduleName.toLowerCase();
  const sites: InstanceSite[] = [];
  for (const modules of structures.values()) {
    for (const m of modules) {
      for (const inst of m.instances) {
        if (inst.module.toLowerCase() === key) {
          sites.push({ parent: m.name, file: m.file, line: inst.line });
        }
      }
    }
  }
  return sites;
}

export interface TreeNode {
  /** 树内唯一键：例化路径 */
  key: string;
  /** 显示名：例化名（顶层为模块名） */
  label: string;
  moduleName: string;
  kind: NodeKind;
  file?: string;
  line?: number;
  /** 例化点（父模块文件与该例化所在行），顶层节点无；用于「跳到父模块中的例化位置」 */
  instFile?: string;
  instLine?: number;
  recursive: boolean;
  children: TreeNode[];
}

export interface Hierarchy {
  tops: TreeNode[];
  /** 候选顶层模块名（未被任何模块例化） */
  topCandidates: string[];
  /** 孤儿模块定义：无父（未被例化）且无子（不例化任何模块） */
  unused: { name: string; file: string; line: number }[];
}

/** 测试台命名（次优先信号）：tb_/tbs_/test_ 前缀或 _tb/_test 后缀。 */
const TB_NAME_RE = /^(?:tb|tbs|test)_|_(?:tb|test)$/i;
/** 验证环境目录（主优先信号）：定义文件位于 sim/tb/test 等目录段内的候选靠后。 */
const SIM_PATH_RE =
  /(^|[/\\])(sim|sim_\d+|tb|tbs|test|tests|testbench|verification|simulation|dv|uvm|bench)([/\\]|$)/i;

/**
 * 多候选顶层自动识别：测试台/仿真候选先向内「解包」出 DUT（可达子图最大的已定义子模块），
 * 再在所有候选的有效顶层中取可达子图最大者。仿真环境通常例化真实顶层，
 * 导致真实顶层不在候选中，直接过滤仿真候选会误选孤立小模块。
 */
function autoPickTop(
  candidates: string[],
  structByModule: Map<string, ModuleInfo>,
): string | undefined {
  if (candidates.length === 0) return undefined;
  const sizeCache = new Map<string, number>();
  const reachableSize = (root: string): number => {
    const cached = sizeCache.get(root.toLowerCase());
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const stack = [root.toLowerCase()];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const inst of structByModule.get(cur)?.instances ?? []) {
        stack.push(inst.module.toLowerCase());
      }
    }
    sizeCache.set(root.toLowerCase(), seen.size);
    return seen.size;
  };
  const fileOf = (name: string) => structByModule.get(name.toLowerCase())?.file ?? "";
  const isTb = (name: string) =>
    TB_NAME_RE.test(name) || SIM_PATH_RE.test(fileOf(name));
  const unwrap = (name: string): string => {
    let cur = name;
    const seen = new Set([cur.toLowerCase()]);
    while (isTb(cur)) {
      const children = (structByModule.get(cur.toLowerCase())?.instances ?? [])
        .map((i) => i.module)
        .filter((m) => structByModule.has(m.toLowerCase()) && !seen.has(m.toLowerCase()));
      if (children.length === 0) break;
      let bestChild = children[0];
      for (const c of children.slice(1)) {
        if (reachableSize(c) > reachableSize(bestChild)) bestChild = c;
      }
      cur = bestChild;
      seen.add(cur.toLowerCase());
    }
    return cur;
  };
  let best: string | undefined;
  let bestSize = -1;
  for (const name of candidates) {
    const eff = unwrap(name);
    const size = reachableSize(eff);
    if (size > bestSize || (size === bestSize && best !== undefined && isTb(best) && !isTb(eff))) {
      best = eff;
      bestSize = size;
    }
  }
  return best;
}

/**
 * 构建例化层级树。
 * @param index 模块索引
 * @param structures 文件路径 → 该文件的模块结构（含例化边）
 * @param topName 指定顶层；缺省自动识别（唯一候选直接采用，多候选时仿真/测试台候选先解包出 DUT，再取可达子图最大者）
 */
export function buildHierarchy(
  index: ModuleIndex,
  structures: Map<string, ModuleInfo[]>,
  topName?: string,
): Hierarchy {
  const structByModule = new Map<string, ModuleInfo>();
  for (const modules of structures.values()) {
    for (const m of modules) {
      const key = m.name.toLowerCase();
      const existing = structByModule.get(key);
      if (!existing) {
        structByModule.set(key, m);
      } else if (existing.instances.length === 0 && m.instances.length > 0) {
        // VHDL entity 与 architecture 分文件：entity 结构先占位（无例化），
        // 孤儿 architecture 结构的例化边按名归并进来，定义位置仍取 entity
        structByModule.set(key, { ...existing, instances: m.instances });
      }
    }
  }

  const instantiated = new Set<string>();
  for (const modules of structures.values()) {
    for (const m of modules) {
      for (const inst of m.instances) {
        instantiated.add(inst.module.toLowerCase());
      }
    }
  }

  const topCandidates = index
    .allDefs()
    .filter((d) => !d.isIp && !instantiated.has(d.name.toLowerCase()))
    .map((d) => d.name);

  const chosenTop = topName ?? autoPickTop(topCandidates, structByModule);

  const buildNode = (
    moduleName: string,
    label: string,
    key: string,
    ancestors: Set<string>,
  ): TreeNode => {
    const def = index.resolve(moduleName);
    const lower = moduleName.toLowerCase();
    const node: TreeNode = {
      key,
      label,
      moduleName,
      kind: def ? (def.isIp ? "ip" : "module") : isVendorPrimitive(moduleName) ? "primitive" : "unresolved",
      file: def?.file,
      line: def?.line,
      recursive: ancestors.has(lower),
      children: [],
    };
    if (node.recursive) return node;
    const struct = structByModule.get(lower);
    if (!struct || struct.instances.length === 0) return node;
    // children 懒构建：getter 首次访问时才物化直接子节点（子节点的 children 同样懒）。
    // 菱形复用高的工程例化路径数随深度指数增长，全量展开会组合爆炸；
    // UI 只渲染展开的行，懒构建让成本随实际访问的层级走。
    const nextAncestors = new Set(ancestors).add(lower);
    let built: TreeNode[] | undefined;
    Object.defineProperty(node, "children", {
      enumerable: true,
      get: () => {
        built ??= struct.instances.map((inst) => {
          const child = buildNode(inst.module, inst.inst, `${key}/${inst.inst}`, nextAncestors);
          child.instFile = struct.file;
          child.instLine = inst.line;
          return child;
        });
        return built;
      },
    });
    return node;
  };

  const tops: TreeNode[] = [];
  if (chosenTop) {
    tops.push(buildNode(chosenTop, chosenTop, chosenTop, new Set()));
  }

  // 未使用 = 无父（未被任何模块例化）且无子（自身不例化任何模块）的孤儿模块；
  // tb 等有子的顶层候选、被其他顶层收纳的模块都不算
  const unused = index
    .allDefs()
    .filter(
      (d) =>
        !d.isIp &&
        !instantiated.has(d.name.toLowerCase()) &&
        (structByModule.get(d.name.toLowerCase())?.instances.length ?? 0) === 0 &&
        d.name.toLowerCase() !== chosenTop?.toLowerCase(),
    )
    .map((d) => ({ name: d.name, file: d.file, line: d.line }));

  return { tops, topCandidates, unused };
}
