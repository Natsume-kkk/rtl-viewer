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
  it("同时显示实例、模块与定义文件，复用实例及同名实例不丢失身份", () => {
    const onOpen = vi.fn(), onOpenInst = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen, onOpenInst });
    const child = node({ key: "top/u_rx", label: "u_rx", moduleName: "receiver", file: "D:\\rtl\\serial.vhd", line: 10, instFile: "D:/rtl/top.v", instLine: 25 });
    const sibling = node({ ...child, key: "top/receiver", label: "receiver", instLine: 30 });
    tree.render({ tops: [node({ key: "top", label: "top", moduleName: "top", file: "D:/rtl/board.sv", children: [child, sibling] })], topCandidates: ["top"], unused: [] });
    expect([...rootEl.querySelectorAll(".tree-name")].map(n => n.textContent)).toEqual([
      "top (board.sv)", "u_rx : receiver (serial.vhd)", "receiver : receiver (serial.vhd)",
    ]);
    const row = rootEl.querySelectorAll<HTMLElement>(".tree-row")[1];
    expect(row.title).toContain("D:\\rtl\\serial.vhd:10");
    expect(row.getAttribute("aria-label")).toContain("文件 serial.vhd");
    row.click();
    row.querySelector<HTMLButtonElement>(".tree-inst")!.click();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(child);
    expect(onOpenInst).toHaveBeenCalledExactlyOnceWith(child);
  });

  it("IP 显示 xci，原语与未解析节点不借用例化文件冒充定义文件", () => {
    const { rootEl, tree } = makeTree({ onOpen: vi.fn() });
    tree.render({ tops: [node({ key: "top", label: "top", moduleName: "top", children: [
      node({ key: "top/u_ip", label: "u_ip", moduleName: "clk_wiz", kind: "ip", file: "D:/ip/clk_wiz.xci" }),
      node({ key: "top/u_buf", label: "u_buf", moduleName: "BUFG", kind: "primitive", instFile: "top.v", instLine: 5 }),
      node({ key: "top/u_missing", label: "u_missing", moduleName: "missing", kind: "unresolved", instFile: "top.v", instLine: 8 }),
    ] })], topCandidates: ["top"], unused: [] });
    expect([...rootEl.querySelectorAll(".tree-name")].map(n => n.textContent)).toEqual([
      "top", "u_ip : clk_wiz (clk_wiz.xci)", "u_buf : BUFG", "u_missing : missing",
    ]);
  });

  it("未使用模块附带文件名，特殊名称仅以文本显示", () => {
    const { rootEl, tree } = makeTree({ onOpen: vi.fn() });
    tree.render({ tops: [], topCandidates: [], unused: [{ name: "<unused>", file: "D:/rtl/<source>.v", line: 2 }] });
    expect(rootEl.querySelector(".tree-unused .tree-name")?.textContent).toBe("<unused> (<source>.v)");
    expect(rootEl.querySelector("unused, source")).toBeNull();
    expect(rootEl.querySelector<HTMLElement>(".tree-unused .tree-row")?.title).toContain("D:/rtl/<source>.v:2");
  });
  it("重渲染保留跳转按钮焦点及滚动位置，只有一行参与 Tab 导航", () => {
    const { rootEl, tree } = makeTree({ onOpen: vi.fn() }); document.body.append(rootEl);
    const h = { tops: [node({ key: "top", label: "top", moduleName: "top", children: [node({ key: "top/u", label: "u", moduleName: "sub", instFile: "top.v", instLine: 2 })] })], topCandidates: ["top"], unused: [] };
    tree.render(h);
    rootEl.querySelectorAll<HTMLElement>(".tree-row")[1].click();
    rootEl.querySelector<HTMLButtonElement>(".tree-inst")!.focus();
    rootEl.scrollTop = 123; rootEl.scrollLeft = 45;
    tree.render(h);
    expect(document.activeElement).toBe(rootEl.querySelector(".tree-inst"));
    expect(rootEl.scrollTop).toBe(123); expect(rootEl.scrollLeft).toBe(45);
    expect(rootEl.querySelectorAll('.tree-row[tabindex="0"]')).toHaveLength(1);
    rootEl.remove();
  });
  it("键盘可展开、逐行导航、打开定义及聚焦跳转按钮，完整名称留在提示中", () => {
    const onOpen = vi.fn();
    const onOpenInst = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen, onOpenInst });
    document.body.append(rootEl);
    const child = node({ key: "top/u_long", label: "u_very_long_instance_name", moduleName: "actual_module_definition", instFile: "top.v", instLine: 9 });
    tree.render({ tops: [node({ key: "top", label: "top", moduleName: "top", children: [child] })], topCandidates: ["top"], unused: [] });
    const key = (value: string) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    rootEl.querySelector<HTMLElement>(".tree-row")!.focus();
    key("ArrowLeft");
    expect(rootEl.querySelectorAll(".tree-row")).toHaveLength(1);
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
    key("ArrowRight");
    key("ArrowDown");
    expect(document.activeElement?.getAttribute("title")).toContain("actual_module_definition");
    expect(rootEl.querySelectorAll(".tree-label")[1].textContent).toBe(`${child.label} : ${child.moduleName}`);
    key("Enter");
    expect(onOpen).toHaveBeenCalledWith(child);
    const jump = rootEl.querySelector<HTMLButtonElement>("button.tree-inst")!;
    jump.focus();
    expect(document.activeElement).toBe(jump);
    expect(jump.getAttribute("aria-label")).toContain(child.label);
    jump.click();
    expect(onOpenInst).toHaveBeenCalledWith(child);
    expect(onOpen).toHaveBeenCalledTimes(1);
    rootEl.remove();
  });

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

  it("渲染顶层与子节点，IP/原语/未解析类型可区分且保留循环标记", () => {
    const onOpen = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen });
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
            node({ key: "top/u_buf", label: "u_buf", moduleName: "BUFG", kind: "primitive" }),
          ],
        }),
      ],
      topCandidates: ["top"],
      unused: [],
    };
    tree.render(h);
    const labels = [...rootEl.querySelectorAll(".tree-label")];
    expect(labels[0].textContent).toBe("top");
    const ipLabel = labels.find((el) => el.textContent === "u_ip : clk_wiz_0");
    expect(ipLabel?.querySelector(".icon-ip-diamond svg")).toBeTruthy();
    const unLabel = labels.find((el) => el.textContent === "u_m : missing");
    expect(unLabel?.querySelector(".icon-unresolved svg")).toBeTruthy();
    const primitiveRow = rootEl.querySelector(".kind-primitive")!;
    expect(primitiveRow.querySelector(".icon-primitive svg")).toBeTruthy();
    expect(primitiveRow.querySelector(".icon-module")).toBeNull();
    expect(primitiveRow.getAttribute("aria-label")).toBe("u_buf，厂商原语 BUFG");
    expect(primitiveRow.querySelector(".tree-type")?.getAttribute("title")).toBe("厂商原语 · BUFG");
    expect(rootEl.querySelector(".kind-unresolved")?.getAttribute("title")).toContain("未解析模块 · missing");
    expect(labels.some((t) => t.textContent?.includes("(recursive)"))).toBe(true);

    const rows = rootEl.querySelectorAll(".tree-row");
    (rows[1] as HTMLElement).click();
    expect(onOpen).toHaveBeenCalledOnce();
    (rows[2] as HTMLElement).click();
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

  it("约束文件分组渲染并可点击打开", () => {
    const onOpenFile = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen: vi.fn(), onOpenFile });
    const h: Hierarchy = {
      tops: [node({ key: "mod_a", label: "mod_a", moduleName: "mod_a" })],
      topCandidates: ["mod_a"],
      unused: [],
    };
    tree.render(h, ["D:/proj/constraints/pins.xdc", "D:/proj/timing.sdc"]);
    const rows = [...rootEl.querySelectorAll(".tree-row.kind-constraint")];
    expect(rows.map((r) => r.textContent)).toEqual(["pins.xdc", "timing.sdc"]);
    expect(rootEl.querySelector(".tree-unused-title")?.textContent).toBe("约束 (2)");
    rows[0].dispatchEvent(new Event("click", { bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledWith("D:/proj/constraints/pins.xdc");
  });

  it("有例化点的节点渲染跳例化图标，点击触发 onOpenInst 且不冒泡到 onOpen", () => {
    const onOpen = vi.fn();
    const onOpenInst = vi.fn();
    const { rootEl, tree } = makeTree({ onOpen, onOpenInst });
    const h: Hierarchy = {
      tops: [
        node({
          key: "top",
          label: "top",
          moduleName: "top",
          children: [
            node({
              key: "top/u_sub",
              label: "u_sub",
              moduleName: "sub",
              file: "rtl/sub.v",
              line: 5,
              instFile: "rtl/top.v",
              instLine: 24,
            }),
          ],
        }),
      ],
      topCandidates: ["top"],
      unused: [],
    };
    tree.render(h);
    const inst = rootEl.querySelector(".tree-inst") as HTMLElement;
    expect(inst).toBeTruthy();
    expect(inst.classList.contains("icon-jump-inst")).toBe(true);
    expect(inst.querySelector("svg")).toBeTruthy();
    inst.click();
    expect(onOpenInst).toHaveBeenCalledWith(
      expect.objectContaining({ instFile: "rtl/top.v", instLine: 24 }),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("右键节点弹出菜单：打开定义/跳例化点/复制/资源管理器定位", () => {
    const onOpen = vi.fn();
    const onOpenInst = vi.fn();
    const onRevealFile = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { rootEl, tree } = makeTree({ onOpen, onOpenInst, onRevealFile });
    const h: Hierarchy = {
      tops: [
        node({
          key: "top",
          label: "top",
          moduleName: "top",
          children: [
            node({
              key: "top/u_sub",
              label: "u_sub",
              moduleName: "sub",
              file: "rtl/sub.v",
              line: 5,
              instFile: "rtl/top.v",
              instLine: 24,
            }),
          ],
        }),
      ],
      topCandidates: ["top"],
      unused: [],
    };
    tree.render(h);
    const row = rootEl.querySelectorAll(".tree-row")[1] as HTMLElement;
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }),
    );
    const menu = document.querySelector(".ctx-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    const items = [...menu.querySelectorAll(".ctx-item")].map((el) => el.textContent);
    expect(items).toEqual([
      "打开定义",
      "跳到例化点",
      "复制模块名",
      "查看例化处",
      "复制文件名",
      "复制文件路径",
      "复制所在目录",
      "在资源管理器中显示",
    ]);

    (menu.querySelectorAll(".ctx-item")[1] as HTMLElement).click();
    expect(onOpenInst).toHaveBeenCalledWith(
      expect.objectContaining({ instFile: "rtl/top.v", instLine: 24 }),
    );
    expect(document.querySelector(".ctx-menu")).toBeNull();

    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }),
    );
    (document.querySelectorAll(".ctx-item")[2] as HTMLElement).click();
    expect(writeText).toHaveBeenCalledWith("sub");

    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }),
    );
    (document.querySelectorAll(".ctx-item")[7] as HTMLElement).click();
    expect(onRevealFile).toHaveBeenCalledWith("rtl/sub.v");
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
    const toggles = rootEl.querySelectorAll(".tree-toggle");
    // 顶层初始展开为 chevron-down；无子节点的行不渲染 toggle 图标
    expect(toggles[0].classList.contains("icon-chevron-down")).toBe(true);
    expect((toggles[1] as HTMLElement).querySelector("svg")).toBeNull();
    (toggles[0] as HTMLElement).click();
    expect(rootEl.querySelectorAll(".tree-label")).toHaveLength(1);
    // 收起后重渲染为 chevron-right
    expect(rootEl.querySelector(".tree-toggle")!.classList.contains("icon-chevron-right")).toBe(true);
  });
});
