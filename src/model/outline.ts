import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";

export type OutlineKind = "module" | "architecture" | "signal" | "process" | "function";

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
      items.push({ name: m[1].replace(/\s+/g, " "), kind: "process", line });
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
      items.push({ name: m[1] ? `${m[1]}: process` : "process", kind: "process", line });
      continue;
    }
    m = text.match(/^\s*(?:function|procedure)\s+(\w+)/i);
    if (m) {
      items.push({ name: m[1], kind: "function", line });
    }
  }
  return items;
}

/** 提取当前文件大纲：模块/架构、信号声明、always/process 块、函数任务，按行号排序。 */
export function extractOutline(content: string, file: string): OutlineItem[] {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  const items =
    ext === "vhd" || ext === "vhdl"
      ? vhdlOutline(stripVhdlComments(content))
      : verilogOutline(stripComments(content));
  return items.sort((a, b) => a.line - b.line);
}
