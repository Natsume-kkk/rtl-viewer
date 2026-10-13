// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { SearchPanel } from "../src/ui/search";

it("收起与 Escape 不清除查询结果，搜索命中可键盘聚焦并跳转", async () => {
  const root = document.createElement("section"), onClose = vi.fn(), onOpen = vi.fn();
  const panel = new SearchPanel(root, { onClose, onOpen, displayPath: file => file, onSearch: () => [{ file: "top.v", matches: [{ line: 3, text: "wire clk;", column: 6, length: 3 }] }] });
  panel.searchAll("clk");
  await vi.waitFor(() => expect(root.querySelectorAll(".search-match")).toHaveLength(1));
  const input = root.querySelector<HTMLInputElement>("input")!;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(onClose).toHaveBeenCalledOnce(); expect(input.value).toBe("clk");
  expect(root.querySelectorAll(".search-match")).toHaveLength(1);
  root.querySelector<HTMLButtonElement>(".search-match")!.click(); expect(onOpen).toHaveBeenCalledWith("top.v", 3, 6, 3);
  expect(root.querySelector(".search-match")?.tagName).toBe("BUTTON");
});

it("旧查询迟到和取消后的结果不能覆盖新查询，错误可恢复", async () => {
  let finish!: (value: []) => void;
  const onCancel = vi.fn(), root = document.createElement("section");
  const onSearch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce([{ file: "b.v", matches: [{ line: 1, column: 1, length: 3, text: "new", highlights: [{ index: 0, length: 3 }] }] }])
    .mockRejectedValueOnce(new Error("搜索超时"))
    .mockResolvedValueOnce([]);
  const panel = new SearchPanel(root, { onSearch, onCancel, onOpen: vi.fn(), displayPath: path => path });
  panel.searchAll("old"); panel.searchAll("new");
  await vi.waitFor(() => expect(root.querySelector("mark")?.textContent).toBe("new"));
  finish([]); await Promise.resolve();
  expect(root.querySelector("mark")?.textContent).toBe("new");
  await panel.run(); expect(root.textContent).toContain("搜索超时");
  await panel.run(); expect(root.textContent).toContain("无结果");
  expect(onCancel).toHaveBeenCalled();
});

it("清空工程取消尚未返回的搜索且不回填旧结果", async () => {
  let finish!: (value: []) => void;
  const root = document.createElement("section"), cancel = vi.fn();
  const panel = new SearchPanel(root, { onSearch: () => new Promise(resolve => { finish = resolve; }), onCancel: cancel, onOpen: vi.fn(), displayPath: path => path });
  panel.searchAll("clk"); panel.clear(); finish([]); await Promise.resolve();
  expect(root.querySelector(".search-count")?.textContent).toBe("");
  expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("");
});

it("查引用重置手工匹配选项，源码变化提示可刷新且保留查询", () => {
  const root = document.createElement("section"), onSearch = vi.fn(() => []);
  const panel = new SearchPanel(root, { onOpen: vi.fn(), displayPath: file => file, onSearch });
  root.querySelector<HTMLButtonElement>('[title="正则表达式"]')!.click();
  root.querySelector<HTMLButtonElement>('[title="区分大小写"]')!.click();
  panel.searchAll("CLK", false);
  expect(onSearch).toHaveBeenLastCalledWith("CLK", { wholeWord: true, useRegex: false, caseSensitive: false });
  panel.markStale();
  const refresh = root.querySelector<HTMLButtonElement>(".result-stale")!;
  expect(refresh.hidden).toBe(false); refresh.click(); expect(refresh.hidden).toBe(true);
  expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("CLK");
  panel.searchAll("clk", true);
  expect(onSearch).toHaveBeenLastCalledWith("clk", { wholeWord: true, useRegex: false, caseSensitive: true });
});
