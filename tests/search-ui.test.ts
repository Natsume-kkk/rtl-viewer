// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { SearchPanel } from "../src/ui/search";

it("收起与 Escape 不清除查询结果，搜索命中可键盘聚焦并跳转", () => {
  const root = document.createElement("section"), onClose = vi.fn(), onOpen = vi.fn();
  const panel = new SearchPanel(root, { onClose, onOpen, displayPath: file => file, onSearch: () => [{ file: "top.v", matches: [{ line: 3, text: "wire clk;", column: 6, length: 3 }] }] });
  panel.searchAll("clk");
  const input = root.querySelector<HTMLInputElement>("input")!;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(onClose).toHaveBeenCalledOnce(); expect(input.value).toBe("clk");
  expect(root.querySelectorAll(".search-match")).toHaveLength(1);
  root.querySelector<HTMLButtonElement>(".search-match")!.click(); expect(onOpen).toHaveBeenCalledWith("top.v", 3, 6, 3);
  expect(root.querySelector(".search-match")?.tagName).toBe("BUTTON");
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
