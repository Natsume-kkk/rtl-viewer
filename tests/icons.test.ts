// @vitest-environment jsdom
import { expect, it } from "vitest";
import { setIcon, type IconName } from "../src/ui/icons";

it("功能图标统一使用 16 px 视图、线性描边和主题颜色", () => {
  const names: IconName[] = ["check", "cancel", "settings", "export", "filter", "filter-clear", "error", "info", "sort-asc", "sort-desc", "stats", "more", "sidebar", "only-module"];
  for (const name of names) {
    const element = document.createElement("span");
    setIcon(element, name);
    const svg = element.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.innerHTML).toContain('stroke="currentColor"');
    expect(svg.innerHTML).toContain('stroke-width="1.5"');
    expect(svg.innerHTML).not.toContain("#");
    expect(svg.innerHTML).not.toContain("var(--surface");
  }
});

it("图标切换保留基类并替换旧图标", () => {
  const element = document.createElement("button");
  setIcon(element, "chevron-right");
  setIcon(element, "chevron-down");
  expect(element.classList.contains("icon")).toBe(true);
  expect(element.classList.contains("icon-chevron-right")).toBe(false);
  expect(element.classList.contains("icon-chevron-down")).toBe(true);
  expect(element.querySelectorAll("svg")).toHaveLength(1);
});
