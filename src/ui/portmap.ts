import { setIcon } from "./icons";

export interface PortMapRow {
  direction: string;
  width: string;
  port?: string;
  expr: string;
}

export interface PortMapData {
  instance: string;
  module: string;
  file: string;
  line: number;
  rows: PortMapRow[];
  hasDefinition: boolean;
}

export function renderPortMap(root: HTMLElement, data: PortMapData, actions: {
  close(): void;
  definition(): void;
  origin(): void;
  port(name: string): void;
  signal(name: string): void;
}): void {
  root.replaceChildren();
  const el = (tag: string, cls: string, text = "") => {
    const node = document.createElement(tag);
    node.className = cls;
    node.textContent = text;
    return node;
  };
  const button = (cls: string, text: string, action: () => void) => {
    const b = el("button", cls, text);
    b.addEventListener("click", action);
    return b;
  };
  const head = el("div", "panel-head");
  const close = button("icon-button", "", actions.close);
  close.setAttribute("aria-label", "收起端口映射");
  close.title = "收起端口映射";
  setIcon(close, "close");
  head.append(el("span", "", "端口映射"), close);
  const identity = el("div", "mapping-identity");
  const badge = el("span", "module-badge");
  setIcon(badge, "module");
  const instance = el("h2", "", data.instance);
  instance.title = data.instance;
  const module = el("p", "", data.module);
  module.title = data.module;
  identity.append(badge, el("span", "eyebrow", "正在查看的例化"), instance, module);
  if (data.hasDefinition) identity.append(button("text-button", "打开模块定义", actions.definition));
  const summary = el("div", "mapping-summary");
  const inputs = data.rows.filter(r => r.direction === "input" || r.direction === "in").length;
  const outputs = data.rows.filter(r => r.direction === "output" || r.direction === "out").length;
  summary.append(el("span", "", "端口连接"), el("span", "micro", `${inputs} 输入 / ${outputs} 输出 / ${data.rows.length} 总计`));
  const ports = el("div", "mapping-ports");
  for (const row of data.rows) {
    const item = el("div", "port-row");
    const direction = ({ input: "IN", output: "OUT", inout: "IO", in: "IN", out: "OUT" } as Record<string, string>)[row.direction] ?? row.direction;
    const dir = el("span", "port-direction", direction || "?");
    dir.dataset.direction = direction;
    const content = el("div", "port-content");
    const port = data.hasDefinition && row.port
      ? button("port-name", row.port, () => actions.port(row.port!))
      : el("span", "port-name", row.port ?? "?");
    port.title = row.port ?? "未知端口";
    const signal = /^[A-Za-z_]\w*$/.test(row.expr)
      ? button("pm-link", row.expr, () => actions.signal(row.expr))
      : el("span", row.expr ? "port-expression" : "pm-unconnected", row.expr || "（未连接）");
    signal.title = row.expr || "未连接";
    const connection = el("div", "port-connection");
    const arrow = el("span", "");
    setIcon(arrow, "arrow-right");
    connection.append(arrow, signal);
    content.append(port, connection);
    item.append(dir, content, el("span", "port-width", row.width || "1b"));
    ports.append(item);
  }
  if (!data.rows.length) ports.append(el("p", "mapping-note", "暂无可解析的端口连接"));
  const note = el("p", "mapping-note", "点击连接信号，跳到声明位置。");
  const origin = el("div", "mapping-origin");
  const location = button("text-button", `${data.file.split(/[\\/]/).pop()}:${data.line}`, actions.origin);
  location.title = `${data.file}:${data.line}`;
  origin.append(el("span", "eyebrow", "例化位置"), location);
  root.append(head, identity, summary, ports, note, origin);
}
