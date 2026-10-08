import { setIcon } from "./icons";
import type { TraceNode, SignalContext } from "../model/signal-flow";

export class SignalFlowPanel {
  private body: HTMLElement;
  private contexts: HTMLSelectElement;
  private status: HTMLElement;
  private stale: HTMLButtonElement;
  constructor(root: HTMLElement, actions: { close(): void; analyze(): void; refresh?(): void; context(index: number): void; navigate(file: string, line: number): void }) {
    const head = document.createElement("div"); head.className = "panel-head"; head.textContent = "信号链分析";
    const close = document.createElement("button"); close.className = "icon-button"; close.setAttribute("aria-label", "收起信号链分析");
    setIcon(close, "close"); close.onclick = actions.close; head.append(close);
    const tools = document.createElement("div"); tools.className = "flow-tools";
    const analyze = document.createElement("button"); analyze.className = "btn btn-primary"; analyze.textContent = "分析光标处信号"; analyze.onclick = actions.analyze;
    this.contexts = document.createElement("select"); this.contexts.setAttribute("aria-label", "信号所在实例路径"); this.contexts.hidden = true;
    this.contexts.onchange = () => actions.context(this.contexts.selectedIndex);
    this.status = document.createElement("p"); this.status.className = "mapping-note";
    tools.append(analyze, this.contexts);
    this.body = document.createElement("div"); this.body.className = "flow-body";
    this.stale = document.createElement("button"); this.stale.className = "text-button result-stale";
    this.stale.textContent = "源码已变化，刷新当前信号链"; this.stale.hidden = true; this.stale.onclick = () => actions.refresh?.();
    root.append(head, tools, this.stale, this.status, this.body);
    root.addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-file]");
      if (button?.dataset.file) actions.navigate(button.dataset.file, Number(button.dataset.line));
    });
    this.message("将光标放在信号名上，然后点击分析。结果保持不动，便于沿链路跳转查看。");
  }
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
    this.status.title = "端口与直接赋值的分析快照；修改源码后重新分析。";
    const isProcess = (node: TraceNode) => !!node.reason?.startsWith("过程逻辑");
    const briefReason = (reason: string) => reason
      .replace("存在多个 architecture，尚未确定绑定", "多个实现，尚未确定绑定")
      .replace("未发现可继续追踪的连线（不代表未使用）", "没有可继续解析的连线")
      .replace("运算或范围转换（不继续推导）", "到达运算或范围转换")
      .replace("黑盒或缺失定义", "无可查看的内部实现");
    const link = (node: TraceNode, label: string) => {
      const button = document.createElement("button"); button.className = "flow-node"; button.textContent = label; button.title = node.label;
      if (node.file) { button.dataset.file = node.file; button.dataset.line = String(node.line ?? 1); }
      else button.disabled = true;
      return button;
    };
    const processes = (nodes: TraceNode[]) => {
      const list = document.createElement("ul"); list.className = "flow-usages";
      for (const node of nodes) {
        const li = document.createElement("li");
        li.append(link(node, `${node.file?.split(/[\\/]/).pop() ?? "过程"}:${node.line ?? "?"}`)); list.append(li);
      }
      const note = document.createElement("li"); note.className = "flow-reason"; note.textContent = "内部过程使用，追踪到此。"; list.append(note);
      return list;
    };
    const render = (node: TraceNode, base: string): HTMLElement => {
      const item = document.createElement("li");
      const label = node.label.startsWith(base + "/") || node.label.startsWith(base + ".") ? node.label.slice(base.length + 1) : node.label;
      const uses = node.children.filter(isProcess), connections = node.children.filter(n => !isProcess(n));
      if (node.children.length) {
        const details = document.createElement("details"), summary = document.createElement("summary");
        details.className = "flow-branch";
        const name = document.createElement("span"); name.className = "flow-branch-name"; name.textContent = label; name.title = node.label;
        const count = document.createElement("span"); count.className = "flow-count";
        count.textContent = [uses.length ? `${uses.length} 处使用` : "", connections.length ? `${connections.length} 条连接` : ""].filter(Boolean).join(" · ");
        summary.append(name, count); details.append(summary);
        const open = link(node, "打开声明"); open.classList.add("flow-definition"); details.append(open);
        if (uses.length) details.append(processes(uses));
        if (connections.length) {
          const list = document.createElement("ul"); list.append(...connections.map(child => render(child, base))); details.append(list);
        }
        item.append(details);
      } else item.append(link(node, label));
      if (node.reason) { const reason = document.createElement("p"); reason.className = "flow-reason"; reason.textContent = briefReason(node.reason); reason.title = node.reason; item.append(reason); }
      return item;
    };
    for (const [label, root] of [["来源", upstream], ["去向", downstream]] as const) {
      const section = document.createElement("section"), title = document.createElement("h3"), list = document.createElement("ul");
      const base = root.label.slice(0, root.label.lastIndexOf("."));
      title.textContent = label;
      const uses = root.children.filter(isProcess), connections = root.children.filter(n => !isProcess(n));
      list.append(...connections.map(node => render(node, base)));
      if (uses.length) {
        const item = document.createElement("li"), details = document.createElement("details"), summary = document.createElement("summary");
        details.className = "flow-branch"; summary.textContent = `本模块 · ${uses.length} 处过程使用`;
        details.append(summary, processes(uses)); item.append(details); list.append(item);
      }
      if (!root.children.length) {
        const reason = document.createElement("li"); reason.className = "flow-reason"; reason.textContent = briefReason(root.reason ?? "没有可继续解析的连线"); list.append(reason);
      }
      section.append(title, list); this.body.append(section);
    }
  }
}
