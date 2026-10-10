import { describe, expect, it } from "vitest";
import { searchContents, countMatches, buildMatcher, buildAllMatcher } from "../src/model/search";
import { NavHistory } from "../src/model/history";

describe("全局搜索", () => {
  it("正则与纯文本整词统一采用 HDL 标识符边界", () => {
    const line = "$clk clk$ clk clk2";
    for (const useRegex of [false, true]) {
      expect(buildMatcher("clk", { wholeWord: true, useRegex })!(line)).toEqual({ index: 10, length: 3 });
      expect(buildAllMatcher("clk", { wholeWord: true, useRegex })(line)).toEqual([{ index: 10, length: 3 }]);
      expect(buildAllMatcher("\\$clk", { wholeWord: true, useRegex: true })("$clk")).toEqual([{ index: 0, length: 4 }]);
    }
  });

  it("正则空匹配不阻止后续非空命中，重复扫描无状态残留", () => {
    const first = buildMatcher("^|clk", { useRegex: true })!;
    const all = buildAllMatcher("^|clk", { useRegex: true });
    for (let i = 0; i < 2; i++) {
      expect(first("  clk clk")).toEqual({ index: 2, length: 3 });
      expect(all("  clk clk")).toEqual([{ index: 2, length: 3 }, { index: 6, length: 3 }]);
      expect(all("none")).toEqual([]);
    }
  });
  const contents = new Map([
    ["a.v", { content: "module top;\n  wire clk;\n  // clk comment\nendmodule" }],
    ["b.v", { content: "module sub(input CLK);\nendmodule" }],
    ["c.v", { content: "module other;\nendmodule" }],
  ]);

  it("默认大小写不敏感，逐行列出命中", () => {
    const r = searchContents(contents, "clk");
    expect(r).toHaveLength(2);
    expect(r[0].file).toBe("a.v");
    expect(r[0].matches.map((m) => [m.line, m.column])).toEqual([
      [2, 8],
      [3, 6],
    ]);
    expect(r[1].matches).toHaveLength(1);
    expect(countMatches(r)).toBe(3);
  });

  it("大小写敏感只命中精确匹配", () => {
    const r = searchContents(contents, "clk", { caseSensitive: true });
    expect(countMatches(r)).toBe(2);
    expect(r.every((f) => f.file === "a.v")).toBe(true);
  });

  it("空查询返回空，命中上限截断", () => {
    expect(searchContents(contents, "")).toEqual([]);
    const r = searchContents(contents, "module", { maxMatches: 1 });
    expect(countMatches(r)).toBe(1);
  });

  it("整词匹配：不命中标识符内部，命中独立词", () => {
    const ww = new Map([
      ["d.v", { content: "wire i_clk;\nwire clk2;\nwire clk;\nassign clk = i_clk;" }],
    ]);
    const r = searchContents(ww, "clk", { wholeWord: true });
    expect(countMatches(r)).toBe(2);
    expect(r[0].matches.map((m) => m.line)).toEqual([3, 4]);
    // 不开启整词时四处全命中
    expect(countMatches(searchContents(ww, "clk"))).toBe(4);
  });

  it("正则模式：按正则解释查询串，记录真实命中长度", () => {
    const rx = new Map([
      ["e.v", { content: "wire i_sys_clk;\nwire i_clk;\nwire clk;" }],
    ]);
    const r = searchContents(rx, "i_.*_clk", { useRegex: true });
    expect(countMatches(r)).toBe(1);
    expect(r[0].matches[0].line).toBe(1);
    expect(r[0].matches[0].length).toBe(9);
    // 正则 + 大小写敏感
    const cs = searchContents(rx, "I_.*_CLK", { useRegex: true, caseSensitive: true });
    expect(countMatches(cs)).toBe(0);
  });

  it("无效正则返回空结果", () => {
    expect(searchContents(contents, "clk(", { useRegex: true })).toEqual([]);
  });
});

describe("导航历史", () => {
  it("跳转记录、后退、前进", () => {
    const h = new NavHistory();
    h.push({ path: "a.v", line: 10 });
    h.push({ path: "b.v", line: 20 });
    expect(h.canBack).toBe(true);
    expect(h.goBack({ path: "c.v", line: 30 })).toEqual({ path: "b.v", line: 20 });
    expect(h.canForward).toBe(true);
    expect(h.goBack({ path: "b.v", line: 20 })).toEqual({ path: "a.v", line: 10 });
    expect(h.goForward({ path: "a.v", line: 10 })).toEqual({ path: "b.v", line: 20 });
  });

  it("同位置连续 push 去重；新跳转清空前进栈", () => {
    const h = new NavHistory();
    h.push({ path: "a.v", line: 1 });
    h.push({ path: "a.v", line: 1 });
    h.push({ path: "b.v", line: 2 });
    h.goBack({ path: "c.v", line: 3 });
    expect(h.canForward).toBe(true);
    h.push({ path: "d.v", line: 4 });
    expect(h.canForward).toBe(false);
    expect(h.goBack({ path: "x.v", line: 9 })).toEqual({ path: "d.v", line: 4 });
    expect(h.goBack({ path: "d.v", line: 4 })).toEqual({ path: "a.v", line: 1 });
    expect(h.canBack).toBe(false);
  });
});
