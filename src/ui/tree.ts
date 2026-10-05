import type { Hierarchy, TreeNode } from "../model/hierarchy";

export interface TreeCallbacks {
  /** 点击节点：打开文件并跳转行 */
  onOpen(node: TreeNode): void;
  /** 点击 IP 节点：显示端口面板 */
  onIpInfo?(node: TreeNode): void;
  /** 多顶层时用户选定顶层模块 */
  onSelectTop?(name: string): void;
}

export class HierarchyTree {
  private rootEl: HTMLElement;
  private callbacks: TreeCallbacks;
  private expanded = new Set<string>();

  constructor(rootEl: HTMLElement, callbacks: TreeCallbacks) {
    this.rootEl = rootEl;
    this.callbacks = callbacks;
  }

  render(h: Hierarchy): void {
    this.rootEl.textContent = "";
    if (h.topCandidates.length > 1) {
      this.renderTopSwitch(h.topCandidates, h.tops[0]?.moduleName);
    }
    if (h.tops.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "未找到模块定义";
      this.rootEl.appendChild(empty);
    } else {
      const ul = document.createElement("ul");
      ul.className = "tree";
      for (const top of h.tops) {
        this.expanded.add(top.key);
        ul.appendChild(this.renderNode(top, 0));
      }
      this.rootEl.appendChild(ul);
    }
    this.renderUnused(h.unused);
  }

  /** 多顶层候选时的切换下拉，当前自动识别/已选顶层为选中项。 */
  private renderTopSwitch(candidates: string[], current: string | undefined): void {
    const box = document.createElement("div");
    box.className = "top-switch";
    const label = document.createElement("span");
    label.className = "top-switch-label";
    label.textContent = "顶层";
    const sel = document.createElement("select");
    sel.className = "top-select";
    const names =
      current && !candidates.includes(current) ? [current, ...candidates] : candidates;
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
    sel.addEventListener("change", () => this.callbacks.onSelectTop?.(sel.value));
    box.append(label, sel);
    this.rootEl.appendChild(box);
  }

  private renderNode(node: TreeNode, depth: number): HTMLLIElement {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = `tree-row kind-${node.kind}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const hasChildren = node.children.length > 0 && !node.recursive;
    const isOpen = this.expanded.has(node.key);

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = hasChildren ? (isOpen ? "▾" : "▸") : "";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hasChildren) return;
      if (this.expanded.has(node.key)) this.expanded.delete(node.key);
      else this.expanded.add(node.key);
      this.refreshRow(li, node, depth);
    });
    row.appendChild(toggle);

    const label = document.createElement("span");
    label.className = "tree-label";
    let prefix = "";
    if (node.kind === "ip") prefix = "◆ ";
    else if (node.kind === "unresolved") prefix = "? ";
    label.textContent = prefix + node.label;
    if (node.recursive) {
      const mark = document.createElement("span");
      mark.className = "tree-recursive";
      mark.textContent = " (recursive)";
      label.appendChild(mark);
    }
    label.title = node.file ? `${node.file}:${node.line ?? 1}` : node.moduleName;
    row.appendChild(label);

    row.addEventListener("click", () => {
      if (node.kind === "ip") this.callbacks.onIpInfo?.(node);
      this.callbacks.onOpen(node);
    });

    li.appendChild(row);
    if (hasChildren && isOpen) {
      li.appendChild(this.renderChildren(node, depth));
    }
    return li;
  }

  private renderChildren(node: TreeNode, depth: number): HTMLUListElement {
    const ul = document.createElement("ul");
    for (const child of node.children) {
      ul.appendChild(this.renderNode(child, depth + 1));
    }
    return ul;
  }

  /** 就地刷新节点行（展开/收起），保留兄弟与父级状态 */
  private refreshRow(li: HTMLLIElement, node: TreeNode, depth: number): void {
    const fresh = this.renderNode(node, depth);
    li.replaceWith(fresh);
  }

  private renderUnused(unused: Hierarchy["unused"]): void {
    if (unused.length === 0) return;
    const box = document.createElement("div");
    box.className = "tree-unused";
    const title = document.createElement("div");
    title.className = "tree-unused-title";
    title.textContent = `未使用 (${unused.length})`;
    box.appendChild(title);
    const ul = document.createElement("ul");
    for (const u of unused) {
      const li = document.createElement("li");
      li.className = "tree-row kind-module";
      li.textContent = u.name;
      li.title = `${u.file}:${u.line}`;
      li.addEventListener("click", () => {
        this.callbacks.onOpen({
          key: `unused/${u.name}`,
          label: u.name,
          moduleName: u.name,
          kind: "module",
          file: u.file,
          line: u.line,
          recursive: false,
          children: [],
        });
      });
      ul.appendChild(li);
    }
    box.appendChild(ul);
    this.rootEl.appendChild(box);
  }
}
