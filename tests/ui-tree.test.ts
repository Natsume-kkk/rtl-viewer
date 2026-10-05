// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { HierarchyTree } from "../src/ui/tree";
import type { Hierarchy, TreeNode } from "../src/model/hierarchy";

function node(partial: Partial<TreeNode> & Pick<TreeNode, "key" | "label" | "moduleName">): TreeNode {
  return {
    kind: "module",
    recursive: false,
    children: [],
    ...partial,
  };
}

function makeTree(callbacks: ConstructorParameters<typeof HierarchyTree>[1]) {
  const rootEl = document.createElement("div");
  return { rootEl, tree: new HierarchyTree(rootEl, callbacks) };
}

describe("HierarchyTree", () => {
  it("多顶层候选渲染切换下拉，选择回调 onSelectTop", () => {
    const onSelectTop = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen: vi.fn(), onSelectTop });
    const h: Hierarchy = {
      tops: [node({ key: "mod_a", label: "mod_a", moduleName: "mod_a" })],
      topCandidates: ["mod_a", "mod_b"],
      unused: [],
    };
    tree.render(h);
    const sel = rootEl.querySelector("select.top-select") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["mod_a", "mod_b"]);
    expect(sel.value).toBe("mod_a");
    sel.value = "mod_b";
    sel.dispatchEvent(new Event("change"));
    expect(onSelectTop).toHaveBeenCalledWith("mod_b");
  });

  it("渲染顶层与子节点，IP/unresolved/recursive 标记正确", () => {
    const onOpen = vi.fn();
    const onIpInfo = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen, onIpInfo });
    const h: Hierarchy = {
      tops: [
        node({
          key: "top",
          label: "top",
          moduleName: "top",
          children: [
            node({ key: "top/u_ip", label: "u_ip", moduleName: "clk_wiz_0", kind: "ip" }),
            node({ key: "top/u_m", label: "u_m", moduleName: "missing", kind: "unresolved" }),
            node({ key: "top/u_r", label: "u_r", moduleName: "top", recursive: true }),
          ],
        }),
      ],
      topCandidates: ["top"],
      unused: [],
    };
    tree.render(h);
    const labels = [...rootEl.querySelectorAll(".tree-label")].map((el) => el.textContent);
    expect(labels[0]).toBe("top");
    expect(labels).toContain("◆ u_ip");
    expect(labels).toContain("? u_m");
    expect(labels.some((t) => t?.includes("(recursive)"))).toBe(true);

    const rows = rootEl.querySelectorAll(".tree-row");
    (rows[1] as HTMLElement).click();
    expect(onIpInfo).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    (rows[2] as HTMLElement).click();
    expect(onIpInfo).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("未使用分组渲染并可点击打开", () => {
    const onOpen = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen });
    const h: Hierarchy = {
      tops: [node({ key: "top", label: "top", moduleName: "top" })],
      topCandidates: ["top"],
      unused: [
        { name: "stale_mod", file: "rtl/stale.v", line: 3 },
        { name: "stale2", file: "rtl/stale2.v", line: 1 },
      ],
    };
    tree.render(h);
    expect(rootEl.querySelector(".tree-unused-title")?.textContent).toBe("未使用 (2)");
    const items = rootEl.querySelectorAll(".tree-unused li");
    (items[0] as HTMLElement).click();
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: "stale_mod", file: "rtl/stale.v", line: 3 }),
    );
  });

  it("toggle 展开/收起子节点", () => {
    const { rootEl, tree } = makeTree({ onOpen: vi.fn() });
    const h: Hierarchy = {
      tops: [
        node({
          key: "top",
          label: "top",
          moduleName: "top",
          children: [node({ key: "top/u_sub", label: "u_sub", moduleName: "sub" })],
        }),
      ],
      topCandidates: ["top"],
      unused: [],
    };
    tree.render(h);
    expect(rootEl.querySelectorAll(".tree-label")).toHaveLength(2);
    (rootEl.querySelector(".tree-toggle") as HTMLElement).click();
    expect(rootEl.querySelectorAll(".tree-label")).toHaveLength(1);
  });
});
