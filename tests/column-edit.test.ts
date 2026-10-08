import { describe, it, expect } from "vitest";
import { columnTargets, columnValues, type ColumnOptions } from "../src/editor/column-edit";

const options: Extract<ColumnOptions, { mode: "number" }> = { mode: "number", initial: "14", step: "1", repeat: "1", base: 10, leading: "none", uppercase: true };
const range = (line: number, start: number, end = start) => ({ startLineNumber: line, endLineNumber: line, startColumn: start, endColumn: end });
describe("column editor", () => {
  it("递增、重复、空增量和空重复次数", () => {
    expect(columnValues(options, 3)).toEqual(["14", "15", "16"]);
    expect(columnValues({ ...options, repeat: "2" }, 5)).toEqual(["14", "14", "15", "15", "16"]);
    expect(columnValues({ ...options, step: "", repeat: "" }, 3)).toEqual(["14", "14", "14"]);
  });
  it("各进制输入输出、前导零与空格、十六进制大小写", () => {
    expect(columnValues({ ...options, base: 16, initial: "E", leading: "zeros" }, 3)).toEqual(["0E", "0F", "10"]);
    expect(columnValues({ ...options, base: 16, initial: "a", step: "b", uppercase: false }, 3)).toEqual(["a", "15", "20"]);
    expect(columnValues({ ...options, base: 8, initial: "7", leading: "spaces" }, 2)).toEqual([" 7", "10"]);
    expect(columnValues({ ...options, base: 2, initial: "11" }, 3)).toEqual(["11", "100", "101"]);
  });
  it("负数、递减和超出 JS 安全整数不会失真", () => {
    expect(columnValues({ ...options, initial: "1", step: "-1" }, 4)).toEqual(["1", "0", "-1", "-2"]);
    expect(columnValues({ ...options, initial: "-1", step: "-10", leading: "zeros" }, 2)).toEqual(["-01", "-11"]);
    expect(columnValues({ ...options, initial: "9007199254740992" }, 2)).toEqual(["9007199254740992", "9007199254740993"]);
  });
  it("非法进制数字、重复次数和多行文本不应用", () => {
    for (const repeat of ["0", "-1", "1.5"]) expect(() => columnValues({ ...options, repeat }, 2)).toThrow();
    expect(() => columnValues({ ...options, base: 2, initial: "2" }, 2)).toThrow();
    expect(() => columnValues({ mode: "text", text: "a\nb" }, 2)).toThrow();
    expect(columnValues({ mode: "text", text: "sig_" }, 2)).toEqual(["sig_", "sig_"]);
  });
  it("逆序多光标按文档位置排序，只替换选中列", () => {
    const targets = columnTargets(["abc", "def", "ghi"], [range(3, 2, 3), range(1, 2, 3)], 4);
    expect(targets.map(t => t.range)).toEqual([range(1, 2, 3), range(3, 2, 3)]);
  });
  it("单光标从当前行到文件末尾，短行补空格，Tab 内插入保持后方对齐", () => {
    const targets = columnTargets(["skip", "abXYZ", "", "\tend"], [range(2, 3)], 4);
    expect(targets).toEqual([
      { range: range(2, 3), before: "", after: "" },
      { range: range(3, 1), before: "  ", after: "" },
      { range: range(4, 1, 2), before: "  ", after: "  " },
    ]);
  });
  it("单行非空选区只替换该处，拒绝跨行普通选择与重叠", () => {
    expect(columnTargets(["abcd", "efgh"], [range(1, 2, 4)], 4)).toHaveLength(1);
    expect(() => columnTargets(["a", "b"], [{ ...range(1, 1), endLineNumber: 2 }], 4)).toThrow("矩形");
    expect(() => columnTargets(["abc"], [range(1, 1, 3), range(1, 2)], 4)).toThrow("重叠");
  });
  it("Unicode 字符不拆开，中文和表情按编辑器显示列对齐", () => {
    expect(columnTargets(["😀x", "中文", "ab"], [range(1, 3)], 4).map(t => t.range)).toEqual([range(1, 3), range(2, 2), range(3, 3)]);
    expect(columnTargets(["a", "😀x"], [range(1, 2)], 4)[1]).toEqual({ range: range(2, 1), before: "", after: "" });
  });
});
