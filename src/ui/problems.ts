import type { SyntaxCheckResult, SyntaxDiagnostic, SyntaxProgress } from "../ipc";
import type { RuleDiagnostic } from "../analysis/general-rules";
import { setIcon, type IconName } from "./icons";

interface ProblemPanelCallbacks {
  onConfigure(): void;
  onCancel(): void;
  onScopeChange(scope: "top" | "project"): void;
  onExport(format: "html" | "csv"): void;
  onOpen(diagnostic: SyntaxDiagnostic): void;
  onClose(): void;
}

export interface ProblemDisplayFilter {
  severity?: "error" | "warning" | "info";
  file?: string;
}

type Diagnostic = SyntaxDiagnostic | RuleDiagnostic;
type ProblemGroupElement = HTMLDetailsElement & {
  update(title: string, rows: () => HTMLButtonElement[], onJump?: () => void): void;
  dispose(): void;
};

const SEVERITIES = ["error", "warning", "info"] as const;
const SOURCES = ["external", "general", "gjb10157", "gjb9765"] as const;
const SEVERITY_LABELS: Record<string, string> = { error: "错误", warning: "警告", info: "提示" };
const SOURCE_LABELS: Record<string, string> = { external: "外部工具", general: "通用规则", gjb10157: "GJB 10157", gjb9765: "GJB 9765" };
const STATUS_LABELS: Record<string, string> = { completed: "已完成", cancelled: "已取消", timed_out: "超时", failed: "失败" };
const VERILATOR_RULE_LABELS: Record<string, string> = {
  PINNOTFOUND: "端口未找到",
  PINCONNECTEMPTY: "端口未连接",
  MODDUP: "模块重复定义",
  EOFNEWLINE: "文件末尾缺少换行",
  WIDTH: "位宽不匹配",
  UNUSED: "信号未使用",
  UNDRIVEN: "信号未驱动",
  DECLFILENAME: "文件名与模块名不一致",
  CASEINCOMPLETE: "case 分支不完整",
  CASEOVERLAP: "case 分支重叠",
  LATCH: "可能产生锁存器",
  MULTIDRIVEN: "信号多重驱动",
  BLKSEQ: "时序逻辑使用阻塞赋值",
  COMBDLY: "组合逻辑使用非阻塞赋值",
  IMPLICIT: "隐式信号声明",
  SELRANGE: "选择范围越界",
  SYNCASYNCNET: "信号同时用于同步和异步场景",
  VARHIDDEN: "变量隐藏",
  SYNTAX: "语法错误",
};

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
  private readonly progressBar: HTMLProgressElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly exportButtons: HTMLButtonElement[] = [];
  private readonly scopeFilter: HTMLSelectElement;
  private readonly configureButton: HTMLButtonElement;
  private readonly focusButton: HTMLButtonElement;
  private readonly groups = new Map<string, ProblemGroupElement>();
  private labels = new Map<string, string>();
  private empty?: HTMLElement;

  constructor(private readonly root: HTMLElement, private callbacks: ProblemPanelCallbacks) {
    root.className = "problem-panel";
    const bar = document.createElement("div");
    bar.className = "problem-bar";
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
    this.focusButton = button("仅看错误和警告", () => {
      const focused = this.severities.size !== SEVERITIES.length;
      this.severities.clear();
      for (const severity of focused ? SEVERITIES : ["error", "warning"] as const) this.severities.add(severity);
      this.syncFilterControls();
      this.renderResults();
    }, "filter");
    this.focusButton.className = "btn btn-ghost";
    this.configureButton = button("修复环境", callbacks.onConfigure, "settings");
    this.configureButton.className = "btn btn-ghost";
    this.configureButton.hidden = true;
    this.configureButton.title = "处理自动检查遇到的顶层、include 或 library 依赖问题";
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
    bar.append(this.cancelButton, this.scopeFilter, this.focusButton, filterToggle, this.configureButton, ...this.exportButtons, close);

    filters.append(filterGroup("程度", SEVERITIES, SEVERITY_LABELS, this.severities, () => this.renderResults()));
    const sourceFilters = document.createElement("details");
    sourceFilters.className = "problem-advanced-filters";
    const sourceTitle = document.createElement("summary");
    sourceTitle.textContent = "来源筛选";
    sourceFilters.append(sourceTitle, filterGroup("来源", SOURCES, SOURCE_LABELS, this.sources, () => this.renderResults()));
    filters.append(sourceFilters);
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
    this.progressBar = document.createElement("progress");
    this.progressBar.className = "problem-progress";
    this.progressBar.hidden = true;
    this.progressBar.setAttribute("aria-label", "后台检查进度");
    root.append(bar, this.progressBar, filters, this.summary, this.backends, this.list);
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

  refresh(): void {
    this.renderResults();
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
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    this.empty?.remove();
    this.empty = undefined;
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
    this.cancelButton.hidden = !this.running;
    this.cancelButton.disabled = !this.running || this.cancelling;
    this.cancelButton.textContent = this.cancelling ? "正在取消…" : "取消";
    this.progressBar.hidden = !this.running;
    this.exportButtons.forEach(button => { button.disabled = !this.hasResults || this.running; });
    this.focusButton.textContent = this.severities.size === SEVERITIES.length ? "仅看错误和警告" : "查看全部问题";
    this.focusButton.setAttribute("aria-pressed", String(this.severities.size !== SEVERITIES.length));
    if (this.running) {
      const current = this.progress;
      const stage = current?.stage === "ghdl" ? "GHDL" : "Verilator";
      const location = current?.file ? ` · ${fileName(current.file)}` : "";
      if (current?.total) {
        this.progressBar.max = current.total;
        this.progressBar.value = current.completed;
      } else {
        this.progressBar.removeAttribute("value");
      }
      this.summary.textContent = current
        ? `后台检查 · ${stage} ${current.completed}/${current.total}${location}${this.result ? " · 下方为上次结果" : ""}`
        : `后台检查准备中…${this.result ? " · 下方为上次结果" : ""}`;
      return;
    }
    if (this.error) {
      this.summary.textContent = `检查失败：${this.error}`;
      return;
    }
    if (!this.hasResults) {
      this.summary.textContent = "工程载入后自动执行全部检查；编辑停顿后自动复查。";
      return;
    }
    const all = this.allDiagnostics();
    const counts = severityCounts(all);
    const filtered = this.filteredDiagnostics();
    const status = this.result ? this.result.cancelled ? "已取消，结果可能不完整" : `已检查 ${this.result.checkedFiles} 个文件` : "内置分析";
    const environment = all.filter(isEnvironmentDiagnostic).length;
    const environmentText = environment ? ` · ${environment} 分析环境` : "";
    const stale = this.stale ? " · 外部结果为上次快照，等待自动复查" : "";
    this.summary.textContent = `${status} · ${counts.error} 错误 · ${counts.warning} 警告 · ${counts.info} 提示${environmentText} · 显示 ${filtered.length}/${all.length} 条${stale}`;
  }

  private renderResults(): void {
    if (this.root.hidden) return;
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
    const scrollTop = this.list.scrollTop;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusKey = active?.dataset.diagnosticKey;
    const focusGroup = active?.closest("details")?.getAttribute("data-group-key");
    const all = this.allDiagnostics();
    this.configureButton.hidden = !all.some(needsConfiguration);
    const filtered = this.filteredDiagnostics();
    this.empty?.remove();
    this.empty = undefined;
    if (!filtered.length) {
      for (const group of this.groups.values()) group.dispose();
      this.groups.clear();
      this.empty = document.createElement("p");
      this.empty.className = "problem-empty";
      this.empty.textContent = all.length
        ? "当前筛选条件下没有匹配诊断，可清除筛选查看全部结果。"
        : this.hasResults ? "本次检查未发现问题；不包含综合、实现、时序分析和完整跨时钟域验证。" : "尚未产生诊断。";
      this.list.append(this.empty);
      return;
    }
    const labels = fileLabels(all.map(item => item.file));
    this.labels = labels;
    const nextGroups = new Map<string, Diagnostic[]>();
    for (const diagnostic of filtered.filter(item => !isStubHint(item))) {
      const key = `${isEnvironmentDiagnostic(diagnostic) ? "environment" : diagnostic.severity}|${diagnostic.file}|${diagnostic.ruleId}`;
      const group = nextGroups.get(key) ?? [];
      group.push(diagnostic);
      nextGroups.set(key, group);
    }
    const nextKeys = new Set(nextGroups.keys());
    if (filtered.some(isStubHint)) nextKeys.add("stubs");
    for (const [key, group] of this.groups) {
      if (!nextKeys.has(key)) {
        group.dispose();
        this.groups.delete(key);
      }
    }
    const ordered = [...nextGroups.entries()].sort((left, right) => {
      const leftRank = isEnvironmentDiagnostic(left[1][0]) ? 2 : severityRank(left[1][0].severity);
      const rightRank = isEnvironmentDiagnostic(right[1][0]) ? 2 : severityRank(right[1][0].severity);
      return leftRank - rightRank || left[0].localeCompare(right[0]);
    });
    for (const [key, diagnostics] of ordered) {
      const first = diagnostics[0];
      const environment = isEnvironmentDiagnostic(first);
      const severity = environment ? "environment" : first.severity;
      const type = environment ? "分析环境" : SEVERITY_LABELS[severity] ?? severity;
      const title = `${type} · ${labels.get(first.file) ?? "工程级"} · ${diagnosticRuleLabel(first)} · ${diagnostics.length} 条`;
      const fingerprint = diagnostics.map(diagnosticFingerprint).join("\n");
      this.syncGroup(key, `problem-${severity}-group`, title, `${first.file}\n${first.ruleId}: ${first.message}`, fingerprint, () => diagnostics.map(item => this.createRow(item)), first.file ? () => this.callbacks.onOpen(first) : undefined);
    }
    const stubs = filtered.filter(isStubHint);
    if (stubs.length) {
      this.syncGroup("stubs", "problem-stub-group", `黑盒／生成文件提示 · ${stubs.length} 条`, "黑盒或生成文件产生的提示", stubs.map(diagnosticFingerprint).join("\n"), () => stubs.map(item => this.createRow(item)));
    }
    this.list.scrollTop = scrollTop;
    if (focusKey) {
      for (const group of this.groups.values()) {
        const row = [...group.querySelectorAll<HTMLElement>(".problem-row")].find(item => item.dataset.diagnosticKey === focusKey);
        if (row) {
          row.focus();
          break;
        }
      }
    } else if (focusGroup) {
      const group = this.groups.get(focusGroup);
      if (active?.classList.contains("problem-group-jump")) group?.querySelector<HTMLButtonElement>(".problem-group-jump")?.focus();
      else group?.querySelector("summary")?.focus();
    }
  }

  private syncGroup(key: string, className: string, title: string, tooltip: string, fingerprint: string, rows: () => HTMLButtonElement[], onJump?: () => void): void {
    let group = this.groups.get(key);
    if (!group) {
      group = diagnosticGroup(className, title, rows, onJump);
      group.dataset.groupKey = key;
      this.groups.set(key, group);
    } else if (group.dataset.fingerprint === fingerprint) {
      this.list.append(group);
      return;
    }
    group.dataset.fingerprint = fingerprint;
    group.title = tooltip;
    group.update(title, rows, onJump);
    this.list.append(group);
  }

  private createRow(diagnostic: Diagnostic): HTMLButtonElement {
    const stub = isStubDiagnostic(diagnostic);
    const row = document.createElement("button");
    row.className = `problem-row problem-${diagnostic.severity}`;
    row.dataset.diagnosticKey = `${diagnostic.file}|${diagnostic.line}|${diagnostic.column}|${diagnostic.ruleId}`;
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
    const locationLabel = this.labels.get(diagnostic.file) ?? fileName(diagnostic.file);
    location.textContent = stub ? `黑盒 ${locationLabel}:${diagnostic.line}:${diagnostic.column}` : diagnostic.file ? `${locationLabel}:${diagnostic.line}:${diagnostic.column}` : "工程级";
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
    const labels = fileLabels(files);
    for (const file of files) {
      const option = document.createElement("option");
      option.value = file;
      option.textContent = `${isStubPath(file) ? "黑盒 " : ""}${labels.get(file) ?? fileName(file)}`;
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
  return /cannot find file containing|include file.*not found|cannot open.*include|cannot find.*(?:library|package)|unit\s+"[^"]+"\s+not found in library|top-level module|TOPLEVEL|CANNOTOPEN|INCLUDE/i.test(diagnostic.message);
}

function isEnvironmentDiagnostic(diagnostic: Diagnostic): boolean {
  return isStubDiagnostic(diagnostic) || diagnostic.ruleId === "VERILATOR-MODDUP" || diagnostic.ruleId === "VERILATOR-MODMISSING" || needsConfiguration(diagnostic);
}

function diagnosticFingerprint(diagnostic: Diagnostic): string {
  return `${diagnostic.file}|${diagnostic.line}|${diagnostic.column}|${diagnostic.severity}|${diagnostic.ruleId}|${diagnostic.message}`;
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

function diagnosticRuleLabel(diagnostic: Diagnostic): string {
  if (diagnostic.source === "verilator") {
    const label = VERILATOR_RULE_LABELS[diagnostic.ruleId.replace(/^VERILATOR-/, "")];
    if (label) return label;
    if (/^Exiting due to/i.test(diagnostic.message)) return "检查因错误停止";
    if (/cannot find file containing|undefined module|module not found/i.test(diagnostic.message)) return "缺少模块定义";
    if (/include file.*not found|cannot open.*include|CANNOTOPEN|INCLUDE/i.test(diagnostic.message)) return "include 文件缺失";
    if (/top-level module|TOPLEVEL/i.test(diagnostic.message)) return "无法确定顶层";
    if (/cannot find.*(?:library|package)/i.test(diagnostic.message)) return "VHDL library／package 缺失";
    return diagnostic.message;
  }
  if (diagnostic.source === "ghdl") {
    if (/unit\s+"[^"]+"\s+not found in library/i.test(diagnostic.message)) return "VHDL 依赖单元缺失";
    return "VHDL 语法或语义检查";
  }
  return diagnostic.message;
}

function severityRank(severity: string): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

function isStubPath(file: string): boolean {
  return /[\\/](?:verilator|ghdl)[\\/]stubs[\\/]/i.test(file);
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

function fileLabels(files: string[]): Map<string, string> {
  const paths = [...new Set(files.filter(Boolean).map(file => file.replace(/\\/g, "/")))];
  const labels = new Map(paths.map(file => [file, fileName(file)]));
  for (const file of paths) {
    const base = fileName(file);
    const directory = file.split("/").slice(0, -1);
    const others = paths.filter(other => other.toLowerCase() !== file.toLowerCase() && fileName(other).toLowerCase() === base.toLowerCase()).map(other => other.split("/").slice(0, -1));
    for (let count = 1; others.length && count <= directory.length; count++) {
      const suffix = directory.slice(-count).join("/");
      if (others.every(other => other.slice(-count).join("/").toLowerCase() !== suffix.toLowerCase())) {
        labels.set(file, `${base} (${suffix})`);
        break;
      }
    }
  }
  return labels;
}

function diagnosticGroup(className: string, title: string, rows: () => HTMLButtonElement[], onJump?: () => void): ProblemGroupElement {
  const details = document.createElement("details") as ProblemGroupElement;
  details.className = `problem-group ${className}`;
  const summary = document.createElement("summary");
  const glyph = document.createElement("span");
  setIcon(glyph, "chevron-right");
  const titleElement = document.createElement("span");
  titleElement.className = "problem-group-title";
  titleElement.textContent = title;
  summary.append(glyph, titleElement);
  let jump: HTMLButtonElement | undefined;
  let rowFactory = rows;
  let rowElements: HTMLButtonElement[] = [];
  let loaded = false;
  let offset = 0;
  let loadMore: HTMLButtonElement | undefined;
  let observer: IntersectionObserver | undefined;

  const appendBatch = () => {
    for (const row of rowElements.slice(offset, offset + 500)) details.insertBefore(row, loadMore ?? null);
    offset = Math.min(offset + 500, rowElements.length);
    loadMore?.remove();
    observer?.disconnect();
    const remaining = rowElements.length - offset;
    if (!remaining) {
      loadMore = undefined;
      return;
    }
    loadMore = button(`继续加载（剩余 ${remaining} 条）`, appendBatch, "chevron-down");
    loadMore.className = "problem-empty problem-load-more";
    details.append(loadMore);
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) appendBatch();
      }, { root: details.parentElement, rootMargin: "240px" });
      observer.observe(loadMore);
    }
  };

  details.update = (nextTitle, nextRows, onJump) => {
    titleElement.textContent = nextTitle;
    rowFactory = nextRows;
    if (onJump) {
      if (!jump) {
        jump = document.createElement("button");
        jump.className = "icon-button problem-group-jump";
        jump.title = "定位到第一条诊断";
        jump.setAttribute("aria-label", jump.title);
        setIcon(jump, "jump-inst");
        summary.append(jump);
      }
      jump.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        onJump();
      };
    } else {
      jump?.remove();
      jump = undefined;
    }
    if (loaded) {
      offset = 0;
      for (const child of [...details.children]) if (child !== summary) child.remove();
      loadMore = undefined;
      observer?.disconnect();
      rowElements = rowFactory();
      appendBatch();
    }
  };
  details.dispose = () => {
    observer?.disconnect();
    details.remove();
  };
  details.addEventListener("toggle", () => {
    setIcon(glyph, details.open ? "chevron-down" : "chevron-right");
    if (details.open && !loaded) {
      loaded = true;
      rowElements = rowFactory();
      appendBatch();
    }
  });
  details.append(summary);
  details.update(title, rows, onJump);
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
