import type { SyntaxCheckResult, SyntaxDiagnostic, SyntaxProgress } from "../ipc";
import { setIcon } from "./icons";

interface ProblemPanelCallbacks {
  onRun(): void;
  onCancel(): void;
  onExport(format: "html" | "csv"): void;
  onOpen(diagnostic: SyntaxDiagnostic): void;
  onClose(): void;
  displayPath(file: string): string;
}

const SEVERITY_LABELS: Record<string, string> = { error: "错误", warning: "警告", info: "提示" };
const STATUS_LABELS: Record<string, string> = { completed: "已完成", cancelled: "已取消", timed_out: "超时", failed: "失败" };
const MAX_VISIBLE = 500;

export class ProblemPanel {
  private result?: SyntaxCheckResult;
  private running = false;
  private cancelling = false;
  private stale = false;
  private progress?: SyntaxProgress;
  private error = "";
  private severity = "all";
  private source = "all";
  private readonly summary: HTMLElement;
  private readonly backends: HTMLElement;
  private readonly list: HTMLElement;
  private readonly runButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly exportButtons: HTMLButtonElement[] = [];

  constructor(root: HTMLElement, private callbacks: ProblemPanelCallbacks) {
    root.className = "problem-panel";
    const bar = document.createElement("div");
    bar.className = "problem-bar";
    this.runButton = button("运行语法检查", () => callbacks.onRun());
    this.runButton.className = "btn btn-primary";
    this.cancelButton = button("取消", () => {
      this.cancelling = true;
      this.cancelButton.disabled = true;
      callbacks.onCancel();
    });
    this.cancelButton.disabled = true;
    for (const format of ["html", "csv"] as const) {
      const exportButton = button(`导出 ${format.toUpperCase()}`, () => callbacks.onExport(format));
      exportButton.disabled = true;
      this.exportButtons.push(exportButton);
    }
    const severity = select("严重程度", [["all", "全部程度"], ["error", "错误"], ["warning", "警告"], ["info", "提示"]], value => {
      this.severity = value;
      this.renderResults();
    });
    const source = select("检查来源", [["all", "全部来源"], ["verilator", "Verilator"], ["ghdl", "GHDL"], ["system", "应用"]], value => {
      this.source = value;
      this.renderResults();
    });
    const close = button("", callbacks.onClose);
    close.className = "icon-button";
    close.title = "收起问题";
    close.setAttribute("aria-label", "收起问题");
    setIcon(close, "close");
    bar.append(this.runButton, this.cancelButton, severity, source, ...this.exportButtons, close);

    this.summary = document.createElement("div");
    this.summary.className = "problem-summary";
    this.summary.setAttribute("role", "status");
    this.backends = document.createElement("div");
    this.backends.className = "problem-backends";
    this.list = document.createElement("div");
    this.list.className = "problem-list";
    root.append(bar, this.summary, this.backends, this.list);
    this.renderResults();
  }

  start(): void {
    this.running = true;
    this.cancelling = false;
    this.stale = false;
    this.error = "";
    this.progress = undefined;
    this.renderResults();
  }

  update(progress: SyntaxProgress): void {
    this.progress = progress;
    this.renderSummary();
  }

  finish(result: SyntaxCheckResult): void {
    this.result = result;
    this.running = false;
    this.cancelling = false;
    this.progress = undefined;
    this.error = "";
    this.renderResults();
  }

  fail(error: unknown): void {
    this.running = false;
    this.cancelling = false;
    this.progress = undefined;
    this.error = String(error);
    this.renderResults();
  }

  markStale(): void {
    if (!this.result) return;
    this.stale = true;
    this.renderSummary();
  }

  get isStale(): boolean { return this.stale; }

  clear(): void {
    this.result = undefined;
    this.running = false;
    this.cancelling = false;
    this.stale = false;
    this.progress = undefined;
    this.error = "";
    this.renderResults();
  }

  private renderSummary(): void {
    this.runButton.disabled = this.running;
    this.cancelButton.disabled = !this.running || this.cancelling;
    this.cancelButton.textContent = this.cancelling ? "正在取消…" : "取消";
    this.exportButtons.forEach(button => { button.disabled = !this.result || this.running; });
    if (this.running) {
      const current = this.progress;
      const stage = current?.stage === "ghdl" ? "GHDL" : "Verilator";
      const location = current?.file ? ` · ${this.callbacks.displayPath(current.file)}` : "";
      this.summary.textContent = current
        ? `${stage} 检查中 ${current.completed}/${current.total}${location}${this.result ? " · 下方为上次结果" : ""}`
        : `准备检查工具与工程文件…${this.result ? " · 下方为上次结果" : ""}`;
      return;
    }
    if (this.error) {
      this.summary.textContent = `检查失败：${this.error}`;
      return;
    }
    if (!this.result) {
      this.summary.textContent = "对当前工程运行 Verilator／GHDL 语法与语义检查。检查读取磁盘文件，未保存修改需先保存。";
      return;
    }
    const counts = severityCounts(this.result.diagnostics);
    const status = this.result.cancelled ? "已取消" : `已检查 ${this.result.checkedFiles} 个文件`;
    this.summary.textContent = `${status} · ${counts.error} 错误 · ${counts.warning} 警告 · ${counts.info} 提示${this.stale ? " · 源码已变化，结果待重新检查" : ""}`;
  }

  private renderResults(): void {
    this.renderSummary();
    this.backends.textContent = "";
    for (const backend of this.result?.backends ?? []) {
      const item = document.createElement("span");
      item.textContent = `${backend.name === "ghdl" ? "GHDL" : "Verilator"} · ${backend.version} · ${STATUS_LABELS[backend.status] ?? backend.status}`;
      this.backends.append(item);
    }
    this.list.textContent = "";
    if (!this.result) return;
    const filtered = this.result.diagnostics.filter(diagnostic =>
      (this.severity === "all" || diagnostic.severity === this.severity)
      && (this.source === "all" || diagnostic.source === this.source));
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "problem-empty";
      empty.textContent = this.result.diagnostics.length ? "当前过滤条件下没有问题。" : "未发现诊断。请同时核对检查覆盖和后端状态。";
      this.list.append(empty);
      return;
    }
    if (filtered.length > MAX_VISIBLE) {
      const notice = document.createElement("p");
      notice.className = "problem-empty";
      notice.textContent = `过滤后有 ${filtered.length} 条，仅显示前 ${MAX_VISIBLE} 条；报告仍包含全部结果。`;
      this.list.append(notice);
    }
    for (const diagnostic of filtered.slice(0, MAX_VISIBLE)) {
      const row = document.createElement("button");
      row.className = `problem-row problem-${diagnostic.severity}`;
      row.disabled = !diagnostic.file;
      row.title = diagnostic.file ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}\n${diagnostic.ruleId}: ${diagnostic.message}` : diagnostic.message;
      const severity = document.createElement("span");
      severity.className = "problem-severity";
      severity.textContent = SEVERITY_LABELS[diagnostic.severity] ?? diagnostic.severity;
      const source = document.createElement("span");
      source.className = "problem-source";
      source.textContent = diagnostic.source === "ghdl" ? "GHDL" : diagnostic.source === "verilator" ? "Verilator" : "应用";
      const location = document.createElement("span");
      location.className = "problem-location";
      location.textContent = diagnostic.file ? `${this.callbacks.displayPath(diagnostic.file)}:${diagnostic.line}:${diagnostic.column}` : "工程级";
      const message = document.createElement("span");
      message.className = "problem-message";
      message.textContent = `${diagnostic.ruleId} · ${diagnostic.message}`;
      row.append(severity, source, location, message);
      if (diagnostic.file) row.addEventListener("click", () => this.callbacks.onOpen(diagnostic));
      this.list.append(row);
    }
  }
}

function severityCounts(diagnostics: SyntaxDiagnostic[]): Record<"error" | "warning" | "info", number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") counts.error++;
    else if (diagnostic.severity === "warning") counts.warning++;
    else counts.info++;
  }
  return counts;
}

function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  element.addEventListener("click", action);
  return element;
}

function select(label: string, options: [string, string][], changed: (value: string) => void): HTMLSelectElement {
  const element = document.createElement("select");
  element.setAttribute("aria-label", label);
  for (const [value, text] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    element.append(option);
  }
  element.addEventListener("change", () => changed(element.value));
  return element;
}
