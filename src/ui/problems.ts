import type { SyntaxCheckResult, SyntaxDiagnostic, SyntaxProgress } from "../ipc";
import type { RuleDiagnostic } from "../analysis/general-rules";
import { setIcon, type IconName } from "./icons";

interface ProblemPanelCallbacks {
  onRun(): void;
  onConfigure(): void;
  onCancel(): void;
  onScopeChange(scope: "top" | "project"): void;
  onExport(format: "html" | "csv"): void;
  onOpen(diagnostic: SyntaxDiagnostic): void;
  onClose(): void;
  displayPath(file: string): string;
}

export interface ProblemDisplayFilter {
  severity?: "error" | "warning" | "info";
  file?: string;
}

type Diagnostic = SyntaxDiagnostic | RuleDiagnostic;

const SEVERITIES = ["error", "warning", "info"] as const;
const SOURCES = ["external", "general", "gjb10157", "gjb9765"] as const;
const SEVERITY_LABELS: Record<string, string> = { error: "错误", warning: "警告", info: "提示" };
const SOURCE_LABELS: Record<string, string> = { external: "外部工具", general: "通用规则", gjb10157: "GJB 10157", gjb9765: "GJB 9765" };
const STATUS_LABELS: Record<string, string> = { completed: "已完成", cancelled: "已取消", timed_out: "超时", failed: "失败" };
const MAX_VISIBLE = 500;

export class ProblemPanel {
  private result?: SyntaxCheckResult;
  private builtin: RuleDiagnostic[] = [];
  private builtinAnalyzed = false;
  private running = false;
  private cancelling = false;
  private stale = false;
  private progress?: SyntaxProgress;
  private error = "";
  private readonly severities = new Set<string>(SEVERITIES);
  private readonly sources = new Set<string>(SOURCES);
  private file = "all";
  private query = "";
  private fileOptionsSignature = "";
  private readonly summary: HTMLElement;
  private readonly backends: HTMLElement;
  private readonly list: HTMLElement;
  private readonly fileFilter: HTMLSelectElement;
  private readonly queryFilter: HTMLInputElement;
  private readonly runButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly exportButtons: HTMLButtonElement[] = [];
  private readonly scopeFilter: HTMLSelectElement;
  private readonly configureButton: HTMLButtonElement;

  constructor(root: HTMLElement, private callbacks: ProblemPanelCallbacks) {
    root.className = "problem-panel";
    const bar = document.createElement("div");
    bar.className = "problem-bar";
    this.runButton = button("检查", () => callbacks.onRun(), "check");
    this.runButton.className = "btn btn-primary";
    this.cancelButton = button("取消", () => {
      this.cancelling = true;
      this.cancelButton.disabled = true;
      callbacks.onCancel();
    }, "cancel");
    this.cancelButton.className = "btn btn-ghost";
    this.cancelButton.disabled = true;
    this.scopeFilter = document.createElement("select");
    this.scopeFilter.className = "problem-scope";
    this.scopeFilter.setAttribute("aria-label", "检查范围");
    for (const [value, text] of [["top", "当前顶层"], ["project", "全部工程"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.scopeFilter.append(option);
    }
    this.scopeFilter.addEventListener("change", () => callbacks.onScopeChange(this.scopeFilter.value === "project" ? "project" : "top"));
    const filters = document.createElement("div");
    filters.className = "problem-filters";
    filters.id = "problem-filters";
    const filterToggle = button("筛选", () => setFiltersVisible(filters.hidden), "filter");
    filterToggle.className = "btn btn-ghost";
    filterToggle.setAttribute("aria-controls", filters.id);
    this.configureButton = button("检查设置", callbacks.onConfigure, "settings");
    this.configureButton.className = "btn btn-ghost";
    this.configureButton.hidden = true;
    this.configureButton.title = "仅在自动检查无法定位顶层、include 或 library 依赖时设置";
    for (const format of ["html", "csv"] as const) {
      const exportButton = button(`导出 ${format.toUpperCase()}`, () => callbacks.onExport(format), "export");
      exportButton.className = "btn btn-ghost";
      exportButton.disabled = true;
      this.exportButtons.push(exportButton);
    }
    const close = button("", callbacks.onClose);
    close.className = "icon-button";
    close.title = "收起问题";
    close.setAttribute("aria-label", "收起问题");
    setIcon(close, "close");
    bar.append(this.runButton, this.cancelButton, this.scopeFilter, filterToggle, this.configureButton, ...this.exportButtons, close);

    filters.append(
      filterGroup("程度", SEVERITIES, SEVERITY_LABELS, this.severities, () => this.renderResults()),
      filterGroup("来源", SOURCES, SOURCE_LABELS, this.sources, () => this.renderResults()),
    );
    this.fileFilter = document.createElement("select");
    this.fileFilter.setAttribute("aria-label", "文件筛选");
    this.fileFilter.addEventListener("change", () => {
      this.file = this.fileFilter.value;
      this.renderResults();
    });
    this.queryFilter = document.createElement("input");
    this.queryFilter.type = "search";
    this.queryFilter.placeholder = "搜索规则或诊断";
    this.queryFilter.setAttribute("aria-label", "搜索规则或诊断");
    this.queryFilter.addEventListener("input", () => {
      this.query = this.queryFilter.value.trim().toLowerCase();
      this.renderResults();
    });
    const clear = button("清除筛选", () => this.clearFilters(), "filter-clear");
    clear.className = "btn btn-ghost btn-inline problem-clear-filter";
    filters.append(this.fileFilter, this.queryFilter, clear);

    const setFiltersVisible = (visible: boolean) => {
      filters.hidden = !visible;
      filterToggle.setAttribute("aria-expanded", String(visible));
    };
    filterToggle.setAttribute("aria-expanded", "true");
    this.summary = document.createElement("div");
    this.summary.className = "problem-summary";
    this.summary.setAttribute("role", "status");
    this.backends = document.createElement("div");
    this.backends.className = "problem-backends";
    this.list = document.createElement("div");
    this.list.className = "problem-list";
    root.append(bar, filters, this.summary, this.backends, this.list);
    if (window.matchMedia?.("(max-width: 1100px)").matches) setFiltersVisible(false);
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

  setBuiltins(diagnostics: RuleDiagnostic[], analyzed = true): void {
    this.builtin = diagnostics;
    this.builtinAnalyzed = analyzed;
    this.renderResults();
  }

  get builtinDiagnostics(): RuleDiagnostic[] { return this.builtin; }
  get hasResults(): boolean { return !!this.result || this.builtinAnalyzed; }

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

  setScope(scope: "top" | "project", topName?: string): void {
    this.scopeFilter.value = scope;
    this.scopeFilter.title = scope === "top" ? `只分析当前顶层${topName ? `：${topName}` : ""}` : "分析全部工程文件";
  }

  setDisplayFilter(filter: ProblemDisplayFilter): void {
    this.severities.clear();
    for (const severity of filter.severity ? [filter.severity] : SEVERITIES) this.severities.add(severity);
    for (const source of SOURCES) this.sources.add(source);
    this.file = filter.file ?? "all";
    this.query = "";
    this.queryFilter.value = "";
    this.syncFilterControls();
    this.renderResults();
  }

  clearFilters(): void {
    for (const severity of SEVERITIES) this.severities.add(severity);
    for (const source of SOURCES) this.sources.add(source);
    this.file = "all";
    this.query = "";
    this.queryFilter.value = "";
    this.syncFilterControls();
    this.renderResults();
  }

  clear(): void {
    this.result = undefined;
    this.builtin = [];
    this.builtinAnalyzed = false;
    this.running = false;
    this.cancelling = false;
    this.stale = false;
    this.progress = undefined;
    this.error = "";
    this.fileOptionsSignature = "";
    this.clearFilters();
  }

  private syncFilterControls(): void {
    for (const input of document.querySelectorAll<HTMLInputElement>("input[data-problem-severity]")) {
      input.checked = this.severities.has(input.dataset.problemSeverity!);
    }
    for (const input of document.querySelectorAll<HTMLInputElement>("input[data-problem-source]")) {
      input.checked = this.sources.has(input.dataset.problemSource!);
    }
    this.fileFilter.value = this.file;
  }

  private renderSummary(): void {
    this.runButton.disabled = this.running;
    this.cancelButton.disabled = !this.running || this.cancelling;
    this.cancelButton.textContent = this.cancelling ? "正在取消…" : "取消";
    this.exportButtons.forEach(button => { button.disabled = !this.hasResults || this.running; });
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
    if (!this.hasResults) {
      this.summary.textContent = "点击“检查”运行全部自动检查，使用当前编辑缓冲区的隔离快照。";
      return;
    }
    const all = this.allDiagnostics();
    const counts = severityCounts(all);
    const filtered = this.filteredDiagnostics();
    const status = this.result ? this.result.cancelled ? "已取消，结果可能不完整" : `已检查 ${this.result.checkedFiles} 个文件` : "内置分析";
    const stale = this.stale ? " · 外部结果为上次快照，待重新检查" : "";
    this.summary.textContent = `${status} · ${counts.error} 错误 · ${counts.warning} 警告 · ${counts.info} 提示 · 显示 ${filtered.length}/${all.length} 条${stale}`;
  }

  private renderResults(): void {
    this.renderFileOptions();
    this.renderSummary();
    this.backends.textContent = "";
    const builtinStatus = document.createElement("span");
    builtinStatus.textContent = this.builtinAnalyzed ? "内置分析 · 已更新到当前源码" : "内置分析 · 等待分析";
    this.backends.append(builtinStatus);
    for (const backend of this.result?.backends ?? []) {
      const item = document.createElement("span");
      item.textContent = `${backendLabel(backend.name, backend.version)} · ${STATUS_LABELS[backend.status] ?? backend.status}`;
      item.title = backend.version;
      this.backends.append(item);
    }
    this.list.textContent = "";
    const all = this.allDiagnostics();
    this.configureButton.hidden = !all.some(needsConfiguration);
    const filtered = this.filteredDiagnostics();
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "problem-empty";
      empty.textContent = all.length
        ? "当前筛选条件下没有匹配诊断，可清除筛选查看全部结果。"
        : this.hasResults ? "本次检查未发现问题；不包含综合、实现、时序分析和完整跨时钟域验证。" : "尚未产生诊断。";
      this.list.append(empty);
      return;
    }
    if (filtered.length > MAX_VISIBLE) {
      const notice = document.createElement("p");
      notice.className = "problem-empty";
      notice.textContent = `筛选后有 ${filtered.length} 条，仅显示前 ${MAX_VISIBLE} 条；报告仍包含全部结果。`;
      this.list.append(notice);
    }
    const visible = filtered.slice(0, MAX_VISIBLE);
    for (const diagnostic of visible.filter(item => item.severity !== "info" && !isStubHint(item))) {
      this.list.append(this.createRow(diagnostic));
    }
    const infoGroups = new Map<string, Diagnostic[]>();
    for (const diagnostic of visible.filter(item => item.severity === "info" && !isStubHint(item))) {
      const key = `${diagnostic.file}|${diagnostic.ruleId}`;
      infoGroups.set(key, [...infoGroups.get(key) ?? [], diagnostic]);
    }
    for (const diagnostics of infoGroups.values()) {
      const first = diagnostics[0];
      const title = `${first.file ? this.callbacks.displayPath(first.file) : "工程级"} · ${first.ruleId} · ${diagnostics.length} 条提示`;
      this.list.append(diagnosticGroup("problem-info-group", title, diagnostics.map(item => this.createRow(item)), first.file ? () => this.callbacks.onOpen(first) : undefined));
    }
    const stubs = visible.filter(isStubHint);
    if (stubs.length) {
      this.list.append(diagnosticGroup("problem-stub-group", `黑盒／生成文件提示 · ${stubs.length} 条`, stubs.map(item => this.createRow(item))));
    }
  }

  private createRow(diagnostic: Diagnostic): HTMLButtonElement {
    const stub = isStubDiagnostic(diagnostic);
    const row = document.createElement("button");
    row.className = `problem-row problem-${diagnostic.severity}`;
    row.disabled = !diagnostic.file || stub;
    row.title = diagnostic.file ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}\n${diagnostic.ruleId}: ${diagnostic.message}` : diagnostic.message;
    const severity = document.createElement("span");
    severity.className = "problem-severity";
    severity.textContent = SEVERITY_LABELS[diagnostic.severity] ?? diagnostic.severity;
    const source = document.createElement("span");
    source.className = "problem-source";
    source.textContent = diagnostic.source === "ghdl" ? "GHDL" : diagnostic.source === "verilator" ? "Verilator" : diagnostic.source === "builtin" && "category" in diagnostic && diagnostic.category === "gjb10157" ? "10157" : diagnostic.source === "builtin" && "category" in diagnostic && diagnostic.category === "gjb9765" ? "9765" : diagnostic.source === "builtin" ? "通用" : "应用";
    const location = document.createElement("span");
    location.className = "problem-location";
    location.textContent = stub ? `黑盒 ${fileName(diagnostic.file)}:${diagnostic.line}:${diagnostic.column}` : diagnostic.file ? `${this.callbacks.displayPath(diagnostic.file)}:${diagnostic.line}:${diagnostic.column}` : "工程级";
    const message = document.createElement("span");
    message.className = "problem-message";
    message.textContent = `${diagnostic.ruleId} · ${diagnostic.message}`;
    row.append(severity, source, location, message);
    if (diagnostic.file && !stub) row.addEventListener("click", () => this.callbacks.onOpen(diagnostic));
    return row;
  }

  private renderFileOptions(): void {
    const files = [...new Set(this.allDiagnostics().map(item => item.file).filter(Boolean))].sort();
    const signature = files.join("\0");
    if (signature === this.fileOptionsSignature) return;
    this.fileOptionsSignature = signature;
    this.fileFilter.textContent = "";
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "全部文件";
    this.fileFilter.append(all);
    for (const file of files) {
      const option = document.createElement("option");
      option.value = file;
      option.textContent = isStubPath(file) ? `黑盒 ${fileName(file)}` : this.callbacks.displayPath(file);
      this.fileFilter.append(option);
    }
    if (this.file !== "all" && !files.includes(this.file)) this.file = "all";
    this.fileFilter.value = this.file;
  }

  private filteredDiagnostics(): Diagnostic[] {
    return this.allDiagnostics().filter(diagnostic => {
      if (!this.severities.has(diagnostic.severity)) return false;
      if (!this.sources.has(sourceGroup(diagnostic))) return false;
      if (this.file !== "all" && diagnostic.file !== this.file) return false;
      if (this.query && !`${diagnostic.ruleId}\n${diagnostic.message}\n${diagnostic.file}`.toLowerCase().includes(this.query)) return false;
      return true;
    });
  }

  private allDiagnostics(): Diagnostic[] {
    return [...this.builtin, ...this.result?.diagnostics ?? []];
  }
}

function needsConfiguration(diagnostic: Diagnostic): boolean {
  return /cannot find file containing|include file.*not found|cannot open.*include|cannot find.*(?:library|package)|top-level module|TOPLEVEL|CANNOTOPEN|INCLUDE/i.test(diagnostic.message);
}

function sourceGroup(diagnostic: Diagnostic): string {
  if (diagnostic.source !== "builtin" || !("category" in diagnostic)) return "external";
  return diagnostic.category === "gjb10157" || diagnostic.category === "gjb9765" ? diagnostic.category : "general";
}

function backendLabel(name: string, version: string): string {
  const match = (name === "ghdl" ? /GHDL\s+(\d+\.\d+\.\d+)/i.exec(version) : /Verilator\s+(\d+\.\d+)/i.exec(version)) ?? /(\d+\.\d+(?:\.\d+)?)/.exec(version);
  return `${name === "ghdl" ? "GHDL" : "Verilator"}${match ? ` ${match[1]}` : ""}`;
}

function severityCounts(diagnostics: Diagnostic[]): Record<"error" | "warning" | "info", number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") counts.error++;
    else if (diagnostic.severity === "warning") counts.warning++;
    else counts.info++;
  }
  return counts;
}

function isStubPath(file: string): boolean {
  return /[\\/]verilator[\\/]stubs[\\/]/i.test(file);
}

function isStubDiagnostic(diagnostic: Diagnostic): boolean {
  return isStubPath(diagnostic.file);
}

function isStubHint(diagnostic: Diagnostic): boolean {
  return diagnostic.severity !== "error" && isStubDiagnostic(diagnostic);
}

function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function diagnosticGroup(className: string, title: string, rows: HTMLElement[], onJump?: () => void): HTMLElement {
  const details = document.createElement("details");
  details.className = `problem-group ${className}`;
  const summary = document.createElement("summary");
  const glyph = document.createElement("span");
  setIcon(glyph, "chevron-right");
  summary.append(glyph, document.createTextNode(title));
  if (onJump) {
    const jump = document.createElement("button");
    jump.className = "icon-button problem-group-jump";
    jump.title = "定位到第一条诊断";
    jump.setAttribute("aria-label", jump.title);
    setIcon(jump, "jump-inst");
    jump.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      onJump();
    };
    summary.append(jump);
  }
  details.addEventListener("toggle", () => setIcon(glyph, details.open ? "chevron-down" : "chevron-right"));
  details.append(summary, ...rows);
  return details;
}

function filterGroup(title: string, values: readonly string[], labels: Record<string, string>, selected: Set<string>, changed: () => void): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "problem-filter-group";
  const legend = document.createElement("legend");
  legend.textContent = title;
  fieldset.append(legend);
  const kind = title === "程度" ? "problem-severity" : "problem-source";
  for (const value of values) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.setAttribute(`data-${kind}`, value);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(value);
      else selected.delete(value);
      changed();
    });
    label.append(input, document.createTextNode(labels[value]));
    fieldset.append(label);
  }
  return fieldset;
}

function button(label: string, action: () => void, icon?: IconName): HTMLButtonElement {
  const element = document.createElement("button");
  if (icon) {
    const glyph = document.createElement("span");
    setIcon(glyph, icon);
    element.append(glyph);
  }
  element.append(document.createTextNode(label));
  element.addEventListener("click", action);
  return element;
}
