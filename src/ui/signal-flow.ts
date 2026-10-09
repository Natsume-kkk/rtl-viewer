import { setIcon } from "./icons";
import type { TraceNode, SignalContext } from "../model/signal-flow";

export class SignalFlowPanel {
  private body: HTMLElement;
  private contexts: HTMLSelectElement;
  private status: HTMLElement;
  private stale: HTMLButtonElement;
  private following: HTMLElement;
  constructor(root: HTMLElement, actions: { close(): void; refresh?(): void; context(index: number): void; navigate(file: string, line: number): void }) {
    const head = document.createElement("div"); head.className = "panel-head"; head.textContent = "信号链分析";
    const close = document.createElement("button"); close.className = "icon-button"; close.setAttribute("aria-label", "收起信号链分析");
    setIcon(close, "close"); close.onclick = actions.close; head.append(close);
    const tools = document.createElement("div"); tools.className = "flow-tools";
    this.following = document.createElement("p"); this.following.className = "flow-following";
    this.following.setAttribute("role", "status");
    this.contexts = document.createElement("select"); this.contexts.setAttribute("aria-label", "信号所在实例路径"); this.contexts.hidden = true;
    this.contexts.onchange = () => actions.context(this.contexts.selectedIndex);
    this.status = document.createElement("p"); this.status.className = "mapping-note";
    tools.append(this.following, this.contexts);
    this.body = document.createElement("div"); this.body.className = "flow-body";
    this.stale = document.createElement("button"); this.stale.className = "text-button result-stale";
    this.stale.textContent = "源码已变化，刷新当前信号链"; this.stale.hidden = true; this.stale.onclick = () => actions.refresh?.();
    root.append(head, tools, this.stale, this.status, this.body);
    root.addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-file]");
      if (button?.dataset.file) {
        event.preventDefault();
        actions.navigate(button.dataset.file, Number(button.dataset.line));
      }
    });
    this.hint("点击源码中的信号，即可自动查看链路。");
  }
  hint(text: string): void { this.following.textContent = text; }
  message(text: string): void { this.status.textContent = text; this.body.replaceChildren(); }
  markStale(): void { this.stale.hidden = false; }
  clearStale(): void { this.stale.hidden = true; }
  setContexts(items: SignalContext[], selected: number): void {
    this.contexts.replaceChildren(...items.map(item => { const option = document.createElement("option"); option.textContent = item.path; option.title = item.path; return option; }));
    this.contexts.selectedIndex = selected;
    this.contexts.hidden = items.length < 2;
  }
  result(signal: string, upstream: TraceNode, downstream: TraceNode, note: string): void {
    this.message(note);
    const selected = document.createElement("strong"); selected.className = "flow-selected"; selected.textContent = signal;
    this.status.prepend(selected);
    const path = document.createElement("span"); path.className = "flow-path";
    path.textContent = upstream.label.slice(0, upstream.label.lastIndexOf("."));
    path.title = path.textContent; selected.after(path);
    this.status.title = "端口、连续赋值与过程内赋值的分析快照；修改源码后重新分析。";
    const briefReason = (reason: string) => reason
      .replace("存在多个 architecture，尚未确定绑定", "多个实现，尚未确定绑定")
      .replace("未发现可继续追踪的连线（不代表未使用）", "没有可继续解析的连线")
      .replace("运算或范围转换（不继续推导）", "到达运算或范围转换")
      .replace("黑盒或缺失定义", "黑盒 · 方向未知，无法追踪内部")
      .replace("控制/时钟信号，不作为数据链展开", "用作时钟或控制条件，数据链在此停止");
    const link = (node: TraceNode, label: string) => {
      const button = document.createElement("button"); button.className = "flow-node"; button.textContent = label;
      button.title = [node.label, node.tip, node.note].filter(Boolean).join("\n");
      if (node.file) { button.dataset.file = node.file; button.dataset.line = String(node.line ?? 1); }
      else button.disabled = true;
      return button;
    };
    const rel = (node: TraceNode, base: string) =>
      node.label.startsWith(base + "/") || node.label.startsWith(base + ".") ? node.label.slice(base.length + 1) : node.label;
    const noteSpan = (node: TraceNode) => {
      const span = document.createElement("span"); span.className = "flow-note"; span.textContent = node.note ?? ""; return span;
    };
    const reasonP = (reason: string) => {
      const p = document.createElement("p"); p.className = "flow-reason"; p.textContent = briefReason(reason); p.title = reason; return p;
    };
    const render = (node: TraceNode, base: string, depth = 0): HTMLElement => {
      const terminal = node.children.length === 1 ? node.children[0] : undefined;
      if (terminal && !terminal.children.length && terminal.reason?.startsWith("控制/时钟信号")) {
        const item = document.createElement("li"); item.className = "flow-terminal";
        item.append(link(node, rel(node, base)));
        if (node.note) item.append(noteSpan(node));
        const usage = link(terminal, "用作时钟或控制条件 · 查看使用位置");
        usage.classList.add("flow-usage"); item.append(usage);
        return item;
      }
      if (!node.children.length) {
        const item = document.createElement("li");
        item.append(link(node, rel(node, base)));
        if (node.note) item.append(noteSpan(node));
        if (node.reason) item.append(reasonP(node.reason));
        return item;
      }
      const item = document.createElement("li");
      const details = document.createElement("details"), summary = document.createElement("summary");
      details.className = "flow-branch";
      details.open = depth < 2;
      const name = link(node, rel(node, base)); name.classList.add("flow-branch-name");
      const count = document.createElement("span"); count.className = "flow-count";
      count.textContent = node.children.length === 1 ? rel(node.children[0], base) : `${node.children.length} 个分支`;
      summary.append(name, count); details.append(summary);
      if (node.note) summary.append(noteSpan(node));
      const list = document.createElement("ul");
      renderChildren(node, base, list, depth + 1);
      details.append(list);
      item.append(details);
      if (node.reason) item.append(reasonP(node.reason));
      return item;
    };
    /** 简单链默认可读；长链平铺以免缩进挤压名称，复杂分支才收起。 */
    const renderChain = (chain: TraceNode[], base: string, depth: number): HTMLElement => {
      const item = document.createElement("li");
      const details = document.createElement("details"), summary = document.createElement("summary");
      details.className = "flow-branch flow-chain";
      details.open = depth < 2;
      const name = link(chain[0], rel(chain[0], base)); name.classList.add("flow-branch-name");
      const count = document.createElement("span"); count.className = "flow-count";
      count.textContent = `${chain.length - 1} 级直通 · ${rel(chain.at(-1)!, base)}`;
      summary.append(name, count); details.append(summary);
      const list = document.createElement("ul");
      for (const node of chain.slice(1, -1)) {
        const li = document.createElement("li");
        li.append(link(node, rel(node, base)));
        if (node.note) li.append(noteSpan(node));
        list.append(li);
      }
      list.append(render(chain[chain.length - 1], base, depth + 1));
      details.append(list);
      item.append(details);
      return item;
    };
    const renderChildren = (node: TraceNode, base: string, list: HTMLUListElement, depth = 0) => {
      let target = list;
      for (const [index, child] of node.children.entries()) {
        if (index === 8) {
          const item = document.createElement("li"), more = document.createElement("details"), summary = document.createElement("summary");
          more.className = "flow-branch flow-more";
          summary.textContent = `另外 ${node.children.length - 8} 条连接`;
          target = document.createElement("ul"); more.append(summary, target); item.append(more); list.append(item);
        }
        const chain = [child];
        while (!chain.at(-1)!.note && !chain.at(-1)!.reason && chain[chain.length - 1].children.length === 1) {
          const next = chain[chain.length - 1].children[0];
          if (!next.children.length) { chain.push(next); break; }
          if (next.reason || next.note) break;
          chain.push(next);
        }
        target.append(chain.length >= 3 ? renderChain(chain, base, depth) : render(child, base, depth));
      }
    };
    const unknown = new Map<string, TraceNode>();
    const known = (root: TraceNode): TraceNode => ({ ...root, children: root.children.filter(node => {
      if (!/黑盒或缺失定义|端口方向未知/.test(node.reason ?? "")) return true;
      unknown.set([node.label, node.file, node.line].join(":"), node);
      return false;
    }) });
    const sections: [string, TraceNode][] = [["谁驱动它", known(upstream)], ["它连接到哪里", known(downstream)]];
    if (unknown.size) sections.push(["方向待确认", { label: upstream.label, children: [...unknown.values()] }]);
    for (const [label, root] of sections) {
      const section = document.createElement("section"), title = document.createElement("h3"), list = document.createElement("ul");
      const base = root.label.slice(0, root.label.lastIndexOf("."));
      title.textContent = `${label}${root.children.length ? ` · ${root.children.length}` : ""}`;
      renderChildren(root, base, list);
      if (!root.children.length) {
        const reason = document.createElement("li"); reason.className = "flow-reason"; reason.textContent = briefReason(root.reason ?? "没有可继续解析的连线"); list.append(reason);
      }
      section.append(title, list); this.body.append(section);
    }
  }
}
