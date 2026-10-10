import { describe, expect, it } from "vitest";
import { sourceEntry } from "../src/analysis/source-cache";

describe("源码共享缓存", () => {
  it("CRLF、空行、中文与末行偏移保持原文件坐标", () => {
    const raw = "中文\r\n\r\nmodule a;\n", entry = sourceEntry("coords.v", raw);
    expect(entry.lineStarts).toEqual([0, 4, 6, raw.length]);
    for (let i = 0; i <= raw.length; i++) expect(entry.lineAt(i)).toBe(raw.slice(0, i).split("\n").length);
    expect(entry.lineOffset(2)).toBe(4); expect(entry.lineOffset(99)).toBe(raw.length + 1);
  });
  it("遮蔽与保留字符串模式隔离，作用域忽略字符串中的假模块", () => {
    const raw = 'module top; // module fake\nlocalparam MSG="module fake2;"; endmodule';
    const entry = sourceEntry("modes.v", raw);
    expect(entry.text(false)).toContain('"module fake2;"');
    expect(entry.text(true)).not.toContain("fake2");
    expect(entry.text(true).length).toBe(raw.length);
    expect(entry.scopes(true, true).map(s => s.name)).toEqual(["top"]);
  });
  it("源码变化失效，LRU 上限与大文件旁路不改变结果", () => {
    const old = sourceEntry("invalidate.v", "module old;");
    expect(sourceEntry("invalidate.v", "module old;")).toBe(old);
    expect(sourceEntry("invalidate.v", "module new;").scopes(true, true)[0].name).toBe("new");
    const first = sourceEntry("evict.v", "module first;");
    for (let i = 0; i < 32; i++) sourceEntry(`evict-${i}.v`, "module a;");
    expect(sourceEntry("evict.v", "module first;")).not.toBe(first);
    const large = " ".repeat(4 * 1024 * 1024 + 1);
    expect(sourceEntry("large.v", large)).not.toBe(sourceEntry("large.v", large));
  });
  it("VHDL 基符位串整体遮蔽，保留原文模式不擦除字面量", () => {
    const raw = 'architecture rtl of top is begin q <= x"FF"; end rtl;';
    const entry = sourceEntry("literal.vhd", raw);
    expect(entry.text(true)).not.toContain("x");
    expect(entry.text(false)).toContain('x"FF"');
  });
});
