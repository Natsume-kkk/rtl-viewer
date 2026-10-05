import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import { scanStructure } from "../parser";

export type OutlineKind = "module" | "architecture" | "signal" | "process" | "function" | "instance";

export interface OutlineItem {
  name: string;
  kind: OutlineKind;
  line: number;
}

export const OUTLINE_KIND_LABELS: Record<OutlineKind, string> = {
  module: "模块",
  architecture: "架构",
  signal: "信号",
  process: "进程",
  function: "函数/任务",
  instance: "例化",
};

/** 逗号分隔声明中提取标识符：`[7:0] a, b = 1'b0` → ["a", "b"] */
function declNames(decl: string): string[] {
  const names: string[] = [];
  for (const seg of decl.split(",")) {
    const m = seg.match(/([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\])?\s*(?::?=|$)/);
    if (m) names.push(m[1]);
  }
  return names;
}

/** 行首（允许 if/else 前缀）的赋值左值：`if (en) q <= d;` → q；`if (a <= b)` 不算。 */
const ASSIGN_LHS_RE = /^\s*(?:(?:if|else\s+if)\s*\([^;]*?\)\s*|else\s+)?([A-Za-z_]\w*)\s*(?:<=|=(?![=<>]))/;

/** always 块的赋值目标：跟踪 begin/end 深度，收集块内赋值左值，最多前 2 个。 */
function verilogAlwaysTargets(lines: string[], startIdx: number): string[] {
  const targets: string[] = [];
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const text = lines[i];
    // 单语句 always（无 begin）：只看紧跟的第一条赋值
    if (i === startIdx && !/\bbegin\b/.test(text)) {
      const rest = text.replace(/^\s*always(?:_ff|_comb|_latch)?\s*@\s*\([^)]*\)/, "");
      const single = rest.match(ASSIGN_LHS_RE) ?? lines[i + 1]?.match(ASSIGN_LHS_RE);
      if (single) targets.push(single[1]);
      break;
    }
    const am = text.match(ASSIGN_LHS_RE);
    if (am && started && !targets.includes(am[1])) targets.push(am[1]);
    const begins = (text.match(/\bbegin\b/g) ?? []).length;
    const ends = (text.match(/\bend\b/g) ?? []).length;
    depth += begins - ends;
    if (begins > 0) started = true;
    if (started && depth <= 0) break;
    if (targets.length >= 2 && started && depth <= 0) break;
  }
  return targets.slice(0, 2);
}

/** VHDL process 的赋值目标：扫到 end process，收集信号赋值左值，最多前 2 个。 */
function vhdlProcessTargets(lines: string[], startIdx: number): string[] {
  const targets: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const text = lines[i];
    if (i > startIdx && /^\s*end\s+process\b/i.test(text)) break;
    const m = text.match(/^\s*([A-Za-z_]\w*)\s*<=/);
    if (m && !targets.includes(m[1])) targets.push(m[1]);
    if (targets.length >= 2) break;
  }
  return targets.slice(0, 2);
}

function withTargets(name: string, targets: string[]): string {
  return targets.length > 0 ? `${name} → ${targets.join(", ")}` : name;
}

function verilogOutline(stripped: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const line = i + 1;
    let m = text.match(/^\s*(?:macro)?module\s+([\w$]+)/);
    if (m) {
      items.push({ name: m[1], kind: "module", line });
      continue;
    }
    m = text.match(/^\s*interface\s+([\w$]+)/);
    if (m) {
      items.push({ name: m[1], kind: "module", line });
      continue;
    }
    m = text.match(/^\s*(?:wire|reg|logic)\b\s*(?:signed\s+)?(?:\[[^\]]*\]\s*)?([^;]+);/);
    if (m) {
      for (const name of declNames(m[1])) {
        items.push({ name, kind: "signal", line });
      }
      continue;
    }
    m = text.match(/^\s*(always(?:_ff|_comb|_latch)?\s*@\s*\([^)]*\))/);
    if (m) {
      const label = m[1].replace(/\s+/g, " ");
      items.push({ name: withTargets(label, verilogAlwaysTargets(lines, i)), kind: "process", line });
      continue;
    }
    m = text.match(/^\s*initial\b/);
    if (m) {
      items.push({ name: "initial", kind: "process", line });
      continue;
    }
    m = text.match(/^\s*(?:function|task)\b(?:\s+(?:automatic|static))?(?:\s+[\w$:[\]]+\s+)?\s*([\w$]+)/);
    if (m) {
      items.push({ name: m[1], kind: "function", line });
    }
  }
  return items;
}

function vhdlOutline(stripped: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const line = i + 1;
    let m = text.match(/^\s*entity\s+(\w+)\s+is/i);
    if (m) {
      items.push({ name: m[1], kind: "module", line });
      continue;
    }
    m = text.match(/^\s*architecture\s+(\w+)\s+of\s+(\w+)/i);
    if (m) {
      items.push({ name: `${m[1]} (${m[2]})`, kind: "architecture", line });
      continue;
    }
    m = text.match(/^\s*signal\s+([^:]+)\s*:/i);
    if (m) {
      for (const seg of m[1].split(",")) {
        const name = seg.trim();
        if (/^[A-Za-z_]\w*$/.test(name)) items.push({ name, kind: "signal", line });
      }
      continue;
    }
    m = text.match(/^\s*(?:(\w+)\s*:\s*)?process\b/i);
    if (m) {
      const label = m[1] ? `${m[1]}: process` : "process";
      items.push({ name: withTargets(label, vhdlProcessTargets(lines, i)), kind: "process", line });
      continue;
    }
    m = text.match(/^\s*(?:function|procedure)\s+(\w+)/i);
    if (m) {
      items.push({ name: m[1], kind: "function", line });
    }
  }
  return items;
}

/** 提取当前文件大纲：模块/架构、信号声明、always/process 块（带赋值目标）、例化、函数任务，按行号排序。 */
export function extractOutline(content: string, file: string): OutlineItem[] {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  const items =
    ext === "vhd" || ext === "vhdl"
      ? vhdlOutline(stripVhdlComments(content))
      : verilogOutline(stripComments(content));
  // 例化走解析器（结构扫描，文本正则难以覆盖各写法）
  try {
    for (const mod of scanStructure(content, file)) {
      for (const inst of mod.instances) {
        items.push({ name: `${inst.inst} : ${inst.module}`, kind: "instance", line: inst.line });
      }
    }
  } catch {
    // 解析失败只丢例化条目，不影响其余大纲
  }
  return items.sort((a, b) => a.line - b.line);
}
