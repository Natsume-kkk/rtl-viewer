import type { Hierarchy, TreeNode } from "../model/hierarchy";
import { setIcon } from "./icons";
import {
  copyText,
  filePathMenuItems,
  showCtxMenu,
  type MenuItem,
} from "./menu";

export interface TreeCallbacks {
  /** 点击节点：打开模块定义文件并跳转行 */
  onOpen(node: TreeNode): void;
  /** 点击节点的例化点图标：跳到父模块中的例化行 */
  onOpenInst?(node: TreeNode): void;
  /** 右键「在资源管理器中显示」 */
  onRevealFile?(path: string): void;
  /** 多顶层时用户选定顶层模块 */
  onSelectTop?(name: string): void;
  /** 点击约束文件：打开查看 */
  onOpenFile?(path: string): void;
  /** 右键「查看例化处」：列出工程内例化该模块的位置 */
  onFindInstances?(moduleName: string): void;
}

export class HierarchyTree {
  private rootEl: HTMLElement;
  private callbacks: TreeCallbacks;
  private expanded = new Set<string>();
  /** 出现过的顶层 key：顶层只在首次出现时自动展开，之后 render 不得覆盖用户的折叠状态 */
  private seenTops = new Set<string>();
  private selectedKey = "";

  constructor(rootEl: HTMLElement, callbacks: TreeCallbacks) {
    this.rootEl = rootEl;
    this.callbacks = callbacks;
    rootEl.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.renderPanelHead({ tops: [], topCandidates: [], unused: [] });
  }

  render(h: Hierarchy, constraints: string[] = []): void {
    this.rootEl.textContent = "";
    this.renderPanelHead(h);
    if (h.tops.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "未找到模块定义";
      this.rootEl.appendChild(empty);
    } else {
      const ul = document.createElement("ul");
      ul.className = "tree";
      ul.setAttribute("role", "tree");
      ul.setAttribute("aria-label", "模块层级");
      for (const top of h.tops) {
        if (!this.seenTops.has(top.key)) {
          this.seenTops.add(top.key);
          this.expanded.add(top.key);
        }
        ul.appendChild(this.renderNode(top, 0));
      }
      this.rootEl.appendChild(ul);
    }
    this.renderUnused(h.unused);
    this.renderConstraints(constraints);
    const first = this.rootEl.querySelector<HTMLElement>(".tree-row");
    if (first) first.tabIndex = 0;
  }

  /** 约束文件分组（.xdc/.sdc），只读查看入口，不参与层级。 */
  private renderConstraints(files: string[]): void {
    if (files.length === 0) return;
    const box = document.createElement("div");
    box.className = "tree-unused";
    const title = document.createElement("div");
    title.className = "tree-unused-title";
    title.textContent = `约束 (${files.length})`;
    box.appendChild(title);
    const ul = document.createElement("ul");
    for (const file of files) {
      const li = document.createElement("li");
      li.className = "tree-row kind-constraint";
      li.textContent = file.split(/[\\/]/).pop() ?? file;
      li.title = file;
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.addEventListener("click", () => this.callbacks.onOpenFile?.(file));
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, [
          { label: "打开", action: () => this.callbacks.onOpenFile?.(file) },
          ...filePathMenuItems(file, this.callbacks.onRevealFile),
        ]);
      });
      ul.appendChild(li);
    }
    box.appendChild(ul);
    this.rootEl.appendChild(box);
  }

  /** 面板头：「层级」标题常驻；多顶层候选时右端放切换下拉，当前自动识别/已选顶层为选中项。 */
  private renderPanelHead(h: Hierarchy): void {
    const head = document.createElement("div");
    head.className = "panel-head";
    const title = document.createElement("span");
    title.textContent = "工程层级";
    head.appendChild(title);
    const hint = document.createElement("span");
    hint.className = "micro";
    hint.textContent = "HDL";
    head.appendChild(hint);
    this.rootEl.appendChild(head);
    if (h.tops.length) {
      const picker = document.createElement("label");
      picker.className = "root-selector";
      const caption = document.createElement("span");
      caption.textContent = "顶层模块";
      const sel = document.createElement("select");
      sel.className = "top-select";
      sel.setAttribute("aria-label", "顶层模块");
      const current = h.tops[0]?.moduleName;
      const candidates = h.topCandidates;
      const names =
        current && !candidates.includes(current) ? [current, ...candidates] : candidates;
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      if (current) sel.value = current;
      sel.title = sel.value;
      sel.addEventListener("change", () => this.callbacks.onSelectTop?.(sel.value));
      picker.append(caption, sel);
      this.rootEl.appendChild(picker);
    }
  }

  private renderNode(node: TreeNode, depth: number): HTMLLIElement {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = `tree-row kind-${node.kind}`;
    row.dataset.key = node.key;
    row.tabIndex = this.selectedKey === node.key ? 0 : -1;
    row.classList.toggle("active", this.selectedKey === node.key);
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(depth + 1));
    row.setAttribute("aria-selected", String(this.selectedKey === node.key));
    const kindLabel = { module: "模块", ip: "IP 核", primitive: "厂商原语", unresolved: "未解析模块" }[node.kind];
    row.setAttribute("aria-label", `${node.label}，${kindLabel} ${node.moduleName}${node.recursive ? "，循环例化" : ""}`);
    row.title = `${node.label}\n${kindLabel} · ${node.moduleName}${node.file ? `\n${node.file}:${node.line ?? 1}` : ""}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.style.minWidth = `${160 + depth * 14}px`;

    const hasChildren = node.children.length > 0 && !node.recursive;
    const isOpen = this.expanded.has(node.key);
    if (hasChildren) row.setAttribute("aria-expanded", String(isOpen));

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    if (hasChildren) setIcon(toggle, isOpen ? "chevron-down" : "chevron-right");
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
    {
      const mark = document.createElement("span");
      mark.className = "tree-type";
      setIcon(mark, node.kind === "ip" ? "ip-diamond" : node.kind);
      mark.title = `${kindLabel} · ${node.moduleName}`;
      label.appendChild(mark);
    }
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = node.label;
    label.appendChild(name);
    if (node.recursive) {
      const mark = document.createElement("span");
      mark.className = "tree-recursive";
      mark.textContent = " (recursive)";
      label.appendChild(mark);
    }
    label.title = row.title;
    row.appendChild(label);
    // 深层行可能宽于侧栏；聚焦时把名称而非行的空白缩进滚入视口。
    row.addEventListener("focus", () => label.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
    if (node.kind === "ip") {
      const badge = document.createElement("span");
      badge.className = "tree-badge";
      badge.textContent = "IP";
      row.appendChild(badge);
    }

    if (node.instFile && node.instLine !== undefined) {
      const inst = document.createElement("button");
      inst.className = "tree-inst";
      setIcon(inst, "jump-inst");
      inst.title = `跳到父模块中的例化点\n${node.instFile}:${node.instLine}`;
      inst.setAttribute("aria-label", `跳到 ${node.label} 例化点`);
      inst.addEventListener("click", (e) => {
        e.stopPropagation();
        this.callbacks.onOpenInst?.(node);
      });
      row.appendChild(inst);
    }

    row.addEventListener("click", () => {
      this.selectedKey = node.key;
      this.rootEl.querySelectorAll<HTMLElement>(".tree-row").forEach((r) => {
        r.classList.toggle("active", r === row);
        if (r.getAttribute("role") === "treeitem") r.setAttribute("aria-selected", String(r === row));
        r.tabIndex = r === row ? 0 : -1;
      });
      this.callbacks.onOpen(node);
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items: MenuItem[] = [];
      if (node.file) {
        items.push({ label: "打开定义", action: () => this.callbacks.onOpen(node) });
      }
      if (node.instFile && node.instLine !== undefined) {
        items.push({
          label: "跳到例化点",
          action: () => this.callbacks.onOpenInst?.(node),
        });
      }
      items.push({ label: "复制模块名", action: () => copyText(node.moduleName) });
      items.push({
        label: "查看例化处",
        action: () => this.callbacks.onFindInstances?.(node.moduleName),
      });
      if (node.file) {
        items.push(...filePathMenuItems(node.file, this.callbacks.onRevealFile));
      }
      showCtxMenu(e.clientX, e.clientY, items);
    });

    li.appendChild(row);
    if (hasChildren && isOpen) {
      li.appendChild(this.renderChildren(node, depth));
    }
    return li;
  }

  private renderChildren(node: TreeNode, depth: number): HTMLUListElement {
    const ul = document.createElement("ul");
    ul.setAttribute("role", "group");
    for (const child of node.children) {
      ul.appendChild(this.renderNode(child, depth + 1));
    }
    return ul;
  }

  /** 就地刷新节点行（展开/收起），保留兄弟与父级状态 */
  private refreshRow(li: HTMLLIElement, node: TreeNode, depth: number): void {
    const fresh = this.renderNode(node, depth);
    const focused = li.contains(document.activeElement);
    li.replaceWith(fresh);
    if (focused) fresh.querySelector<HTMLElement>(".tree-row")?.focus();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row || e.target !== row) return;
    const rows = [...this.rootEl.querySelectorAll<HTMLElement>(".tree-row")];
    const idx = rows.indexOf(row);
    let next: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown": next = rows[idx + 1]; break;
      case "ArrowUp": next = rows[idx - 1]; break;
      case "Home": next = rows[0]; break;
      case "End": next = rows.at(-1); break;
      case "ArrowRight":
        if (row.getAttribute("aria-expanded") === "false") row.querySelector<HTMLElement>(".tree-toggle")?.click();
        else if (row.getAttribute("aria-expanded") === "true") next = rows[idx + 1];
        break;
      case "ArrowLeft":
        if (row.getAttribute("aria-expanded") === "true") row.querySelector<HTMLElement>(".tree-toggle")?.click();
        else next = row.parentElement?.parentElement?.closest("li")?.querySelector<HTMLElement>(".tree-row") ?? undefined;
        break;
      case "Enter": case " ": row.click(); break;
      default: return;
    }
    e.preventDefault();
    if (next) { row.tabIndex = -1; next.tabIndex = 0; next.focus(); }
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
      li.tabIndex = 0;
      li.setAttribute("role", "button");
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
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const openAction = () =>
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
        showCtxMenu(e.clientX, e.clientY, [
          { label: "打开定义", action: openAction },
          { label: "复制模块名", action: () => copyText(u.name) },
          { label: "查看例化处", action: () => this.callbacks.onFindInstances?.(u.name) },
          ...filePathMenuItems(u.file, this.callbacks.onRevealFile),
        ]);
      });
      ul.appendChild(li);
    }
    box.appendChild(ul);
    this.rootEl.appendChild(box);
  }
}
