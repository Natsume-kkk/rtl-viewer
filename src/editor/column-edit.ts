// 复用 Monaco 的列宽算法，保持 Tab、宽字符与字素边界一致。
import { CursorColumns } from "monaco-editor/editor/common/core/cursorColumns";

export interface ColumnRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
export interface ColumnTarget { range: ColumnRange; before: string; after: string }
export type ColumnOptions = { mode: "text"; text: string } | {
  mode: "number"; initial: string; step: string; repeat: string;
  base: 2 | 8 | 10 | 16; leading: "none" | "zeros" | "spaces"; uppercase: boolean;
};

function integer(text: string, base: number, label: string): bigint {
  const value = text.trim();
  const digits = value.replace(/^[+-]/, "");
  if (!digits || digits.length > 64 || ![...digits].every(c => /^[0-9a-f]$/i.test(c) && parseInt(c, 16) < base)) {
    throw new Error(`${label}必须是有效的 ${base} 进制整数（最多 64 位）。`);
  }
  let result = 0n;
  for (const c of digits) result = result * BigInt(base) + BigInt(parseInt(c, 16));
  return value.startsWith("-") ? -result : result;
}

/** 输出格式与输入框均使用所选进制；重复次数表示每个数连续出现的次数。 */
export function columnValues(options: ColumnOptions, count: number): string[] {
  if (options.mode === "text") {
    if (!options.text || /[\r\n]/.test(options.text)) throw new Error("请输入单行文本。");
    return Array(count).fill(options.text);
  }
  const initial = integer(options.initial, options.base, "初始值");
  const step = integer(options.step.trim() || "0", options.base, "增量");
  const repeat = integer(options.repeat.trim() || "1", options.base, "重复次数");
  if (repeat <= 0n) throw new Error("重复次数必须大于 0。");
  const format = (n: bigint) => options.uppercase ? n.toString(options.base).toUpperCase() : n.toString(options.base);
  const end = initial + BigInt(Math.max(0, count - 1)) / repeat * step;
  const width = Math.max(format(initial).length, format(end).length);
  return Array.from({ length: count }, (_, i) => {
    const text = format(initial + BigInt(i) / repeat * step);
    if (options.leading === "spaces") return text.padStart(width, " ");
    if (options.leading === "zeros") return text.startsWith("-") ? "-" + text.slice(1).padStart(width - 1, "0") : text.padStart(width, "0");
    return text;
  });
}

/** 单光标从所在列处理到末行；矩形/多光标仅处理其选区，不跨行删除文本。 */
export function columnTargets(lines: string[], selections: ColumnRange[], tabSize: number): ColumnTarget[] {
  if (!selections.length) throw new Error("没有可编辑的选区。");
  if (selections.some(s => s.startLineNumber !== s.endLineNumber)) throw new Error("请先用 Alt+Shift+方向键或 Alt+拖动选择矩形区域，再打开列编辑。");
  const sorted = [...selections].sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
  const selection = sorted[0];
  if (sorted.length > 1 || selection.startColumn !== selection.endColumn) {
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (a.startLineNumber === b.startLineNumber && (a.endColumn > b.startColumn || a.startColumn === b.startColumn)) throw new Error("选区重叠，请重新选择。");
    }
    return sorted.map(range => ({ range, before: "", after: "" }));
  }
  const visible = (text: string, column: number): number => CursorColumns.visibleColumnFromColumn(text, column, tabSize);
  const visual = visible(lines[selection.startLineNumber - 1], selection.startColumn);
  return lines.slice(selection.startLineNumber - 1).map((text, i) => {
    let offset: number = CursorColumns.columnFromVisibleColumn(text, visual, tabSize) - 1;
    if (offset > 0 && text[offset - 1] === "\t" && visible(text, offset + 1) > visual) offset--;
    const column = visible(text, offset + 1);
    const withinTab = text[offset] === "\t" && column < visual;
    const before = withinTab || offset === text.length ? " ".repeat(Math.max(0, visual - column)) : "";
    const after = withinTab ? " ".repeat(visible(text, offset + 2) - visual) : "";
    const line = selection.startLineNumber + i;
    return { range: { startLineNumber: line, endLineNumber: line, startColumn: offset + 1, endColumn: offset + 1 + Number(withinTab) }, before, after };
  });
}
