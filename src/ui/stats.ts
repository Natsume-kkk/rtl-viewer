import type { FileFacts } from "../analysis/facts";
import type { RuleDiagnostic } from "../analysis/general-rules";
import type { SyntaxCheckResult, SyntaxDiagnostic } from "../ipc";
import { filePathKey } from "../file-path";
import { setIcon } from "./icons";

interface StatsPanelCallbacks {
  displayPath(file: string): string;
  onOpenFile(file: string, line?: number): void;
  onOpenProblems(filter: { severity?: "error" | "warning" | "info"; file?: string }): void;
  onScopeChange(scope: "top" | "project"): void;
  onClose(): void;
}

export interface StatsTopologyNode {
  key: string;
  label: string;
  moduleName: string;
  file?: string;
  line?: number;
  children: StatsTopologyNode[];
}

export interface StatsView {
  facts: FileFacts[];
  files: string[];
  diagnostics: (RuleDiagnostic | SyntaxDiagnostic)[];
  done: number;
  total: number;
  external?: SyntaxCheckResult;
  running: boolean;
  stale: boolean;
  scope: "top" | "project";
  topName?: string;
  topology?: StatsTopologyNode[];
}

type SortKey = "file" | "code" | "comments" | "processes" | "instances" | "issues";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "file", label: "文件" },
  { key: "code", label: "代码行" },
  { key: "comments", label: "注释比例" },
  { key: "processes", label: "过程" },
  { key: "instances", label: "例化" },
  { key: "issues", label: "问题" },
];

export class StatsPanel {
  private readonly summary: HTMLElement;
  private readonly structures: HTMLElement;
  private readonly status: HTMLElement;
  private readonly table: HTMLElement;
  private readonly scopeFilter: HTMLSelectElement;
  private readonly modeFilter: HTMLSelectElement;
  private readonly expanded = new Set<string>();
  private readonly collapsed = new Set<string>();
  private sortKey: SortKey = "file";
  private ascending = true;
  private viewMode: "topology" | "files" = "topology";

  constructor(root: HTMLElement, private callbacks: StatsPanelCallbacks) {
    root.className = "stats-panel";
    const bar = document.createElement("div");
    bar.className = "stats-bar";
    const title = document.createElement("strong");
    const titleIcon = document.createElement("span");
    setIcon(titleIcon, "stats");
    title.append(titleIcon, document.createTextNode("工程统计"));
    this.scopeFilter = document.createElement("select");
    this.scopeFilter.className = "stats-scope";
    this.scopeFilter.setAttribute("aria-label", "统计范围");
    for (const [value, text] of [["top", "当前顶层"], ["project", "全部工程"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.scopeFilter.append(option);
    }
    this.scopeFilter.addEventListener("change", () => callbacks.onScopeChange(this.scopeFilter.value === "project" ? "project" : "top"));
    this.modeFilter = document.createElement("select");
    this.modeFilter.className = "stats-view-mode";
    this.modeFilter.setAttribute("aria-label", "统计视图");
    for (const [value, text] of [["topology", "模块拓扑"], ["files", "文件列表"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.modeFilter.append(option);
    }
    this.modeFilter.addEventListener("change", () => {
      this.viewMode = this.modeFilter.value === "files" ? "files" : "topology";
      if (this.currentView) this.render(this.currentView);
    });
    const close = document.createElement("button");
    close.className = "icon-button";
    close.title = "收起统计";
    close.setAttribute("aria-label", "收起统计");
    setIcon(close, "close");
    close.onclick = callbacks.onClose;
    bar.append(title, this.modeFilter, this.scopeFilter, close);
    this.summary = document.createElement("div");
    this.summary.className = "stats-summary";
    this.structures = document.createElement("div");
    this.structures.className = "stats-structures";
    this.status = document.createElement("div");
    this.status.className = "stats-structures stats-check-status";
    this.table = document.createElement("div");
    this.table.className = "stats-table";
    root.append(bar, this.summary, this.structures, this.status, this.table);
  }

  private currentView?: StatsView;

  render(view: StatsView): void {
    this.currentView = view;
    const { facts, files, done, total } = view;
    this.scopeFilter.value = view.scope;
    this.scopeFilter.title = view.scope === "top" ? `只统计当前顶层${view.topName ? `：${view.topName}` : ""}` : "统计全部工程文件";
    this.modeFilter.value = this.viewMode;
    const codeLines = facts.reduce((sum, item) => sum + item.statistics.codeLines, 0);
    const commentLines = facts.reduce((sum, item) => sum + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
    const commentDenominator = facts.reduce((sum, item) => sum + item.statistics.codeLines + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
    const counts = {
      modules: facts.reduce((sum, item) => sum + item.definitions.filter(definition => definition.kind !== "architecture").length, 0),
      initial: facts.reduce((sum, item) => sum + item.initialCount, 0),
      functions: facts.reduce((sum, item) => sum + item.functionTaskCount, 0),
      cases: facts.reduce((sum, item) => sum + item.caseCount, 0),
      loops: facts.reduce((sum, item) => sum + item.loopCount, 0),
      generates: facts.reduce((sum, item) => sum + item.generateCount, 0),
      instances: facts.reduce((sum, item) => sum + item.instanceCount, 0),
    };
    this.summary.textContent = "";
    for (const [label, value] of [
      ["HDL 文件", done < total ? `${facts.length}/${files.length}` : files.length],
      ["设计单元", counts.modules],
      ["代码行", codeLines],
      ["注释比例", `${commentDenominator ? Math.round(commentLines / commentDenominator * 100) : 0}%`],
      ["内置分析", `${done}/${total}`],
    ] as const) {
      const card = document.createElement("span");
      card.className = "stats-card";
      card.textContent = `${label} ${value}`;
      this.summary.append(card);
    }
    this.structures.textContent = `例化语句 ${counts.instances} · initial ${counts.initial} · 函数／任务 ${counts.functions} · case ${counts.cases} · 循环 ${counts.loops} · generate ${counts.generates}`;
    this.renderStatus(view);
    if (this.viewMode === "topology" && view.scope === "top" && view.topology?.length) this.renderTopology(view);
    else this.renderTable(view);
  }

  private renderStatus(view: StatsView): void {
    this.status.textContent = "";
    const builtin = document.createElement("span");
    builtin.textContent = view.done < view.total ? `内置分析：进行中 ${view.done}/${view.total}` : "内置分析：已更新到当前源码";
    const external = document.createElement("span");
    const externalStatus = view.running ? "检查中" : view.external ? view.external.cancelled ? "已取消，结果可能不完整" : `已检查 ${view.external.checkedFiles} 个文件` : "未运行";
    external.textContent = `外部检查：${externalStatus}${view.stale && view.external ? " · 上次快照，待重新检查" : ""}`;
    this.status.append(builtin, external);
    for (const severity of ["error", "warning", "info"] as const) {
      const count = view.diagnostics.filter(item => item.severity === severity).length;
      const button = document.createElement("button");
      button.className = `btn btn-ghost btn-inline stats-diagnostic stats-${severity}`;
      button.textContent = `${severity === "error" ? "错误" : severity === "warning" ? "警告" : "提示"} ${count}`;
      const glyph = document.createElement("span");
      setIcon(glyph, severity === "error" ? "error" : severity === "warning" ? "warning" : "info");
      button.prepend(glyph);
      button.onclick = () => this.callbacks.onOpenProblems({ severity });
      this.status.append(button);
    }
  }

  private renderTopology(view: StatsView): void {
    const facts = new Map(view.facts.map(item => [filePathKey(item.file), item]));
    const issueCounts = issueCountsByFile(view.diagnostics);
    this.table.textContent = "";
    const tree = document.createElement("div");
    tree.className = "stats-topology";
    tree.append(topologyHeader(), topologyTotal(view));
    for (const node of view.topology ?? []) tree.append(this.topologyNode(node, 0, facts, issueCounts));
    this.table.append(tree);
  }

  private topologyNode(node: StatsTopologyNode, depth: number, facts: Map<string, FileFacts>, issueCounts: Map<string, number>): HTMLElement {
    const children = node.children.map(child => this.topologyNode(child, depth + 1, facts, issueCounts));
    const hasChildren = children.length > 0;
    const container = hasChildren ? document.createElement("details") : document.createElement("div");
    container.className = "stats-topology-node";
    const row = hasChildren ? document.createElement("summary") : document.createElement("div");
    row.className = "stats-topology-row";
    row.style.setProperty("--stats-depth", String(depth));
    const glyph = document.createElement("span");
    if (hasChildren) setIcon(glyph, "chevron-right");
    else glyph.className = "stats-leaf-spacer";
    row.append(glyph);
    const label = document.createElement("span");
    label.className = "stats-topology-label";
    label.textContent = depth === 0 ? node.moduleName : `${node.label} : ${node.moduleName}`;
    label.title = node.file ?? node.moduleName;
    row.append(label);
    const fact = node.file ? facts.get(filePathKey(node.file)) : undefined;
    row.append(metric(fact?.statistics.codeLines ?? 0), metric(`${Math.round((fact?.statistics.commentRatio ?? 0) * 100)}%`), metric(fact?.processes.length ?? 0), metric(fact?.instanceCount ?? 0));
    const issues = node.file ? issueCounts.get(filePathKey(node.file)) ?? 0 : 0;
    const issueButton = document.createElement("button");
    issueButton.className = "stats-topology-issues";
    issueButton.textContent = String(issues);
    issueButton.title = node.file ? "查看此文件诊断" : "IP 黑盒";
    if (node.file) issueButton.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onOpenProblems({ file: node.file });
    };
    else issueButton.disabled = true;
    row.append(issueButton);
    if (node.file) {
      const open = document.createElement("button");
      open.className = "icon-button stats-open-file";
      open.title = `打开 ${shortFileName(node.file)}${node.line ? `:${node.line}` : ""}`;
      open.setAttribute("aria-label", open.title);
      setIcon(open, "jump-inst");
      open.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.onOpenFile(node.file!, node.line);
      };
      row.append(open);
    } else {
      const file = document.createElement("span");
      file.className = "stats-ip-label";
      file.textContent = "IP";
      row.append(file);
    }
    container.append(row, ...children);
    if (hasChildren && container instanceof HTMLDetailsElement) {
      container.open = this.expanded.has(node.key) || depth === 0 && !this.collapsed.has(node.key);
      container.addEventListener("toggle", () => {
        if (container.open) {
          this.expanded.add(node.key);
          this.collapsed.delete(node.key);
        } else {
          this.expanded.delete(node.key);
          this.collapsed.add(node.key);
        }
        setIcon(glyph, container.open ? "chevron-down" : "chevron-right");
      });
    }
    return container;
  }

  private renderTable(view: StatsView): void {
    const facts = new Map(view.facts.map(item => [filePathKey(item.file), item]));
    const issueCounts = issueCountsByFile(view.diagnostics);
    const rows = view.files.map(file => {
      const item = facts.get(filePathKey(file));
      return {
        file,
        item,
        code: item?.statistics.codeLines ?? -1,
        comments: item?.statistics.commentRatio ?? -1,
        processes: item?.processes.length ?? -1,
        instances: item?.instanceCount ?? -1,
        issues: item ? issueCounts.get(filePathKey(file)) ?? 0 : -1,
      };
    });
    rows.sort((a, b) => {
      const left = this.sortKey === "file" ? shortFileName(a.file) : a[this.sortKey];
      const right = this.sortKey === "file" ? shortFileName(b.file) : b[this.sortKey];
      const result = typeof left === "string" && typeof right === "string" ? left.localeCompare(right) : Number(left) - Number(right);
      return (this.ascending ? result : -result) || shortFileName(a.file).localeCompare(shortFileName(b.file));
    });
    this.table.textContent = "";
    const table = document.createElement("table");
    const header = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const column of COLUMNS) {
      const cell = document.createElement("th");
      const button = document.createElement("button");
      button.textContent = column.label;
      if (this.sortKey === column.key) {
        const glyph = document.createElement("span");
        setIcon(glyph, this.ascending ? "sort-asc" : "sort-desc");
        button.append(glyph);
      }
      button.title = `按${column.label}排序`;
      button.onclick = () => {
        if (this.sortKey === column.key) this.ascending = !this.ascending;
        else {
          this.sortKey = column.key;
          this.ascending = column.key === "file";
        }
        this.renderTable(view);
      };
      cell.append(button);
      headerRow.append(cell);
    }
    header.append(headerRow);
    const body = document.createElement("tbody");
    const totals = statsTotals(view);
    const totalRow = document.createElement("tr");
    totalRow.className = "stats-total-row";
    totalRow.append(textCell("合计"), textCell(totals.codeLines), textCell(totals.commentRatio), textCell(totals.processes), textCell(totals.instances), textCell(totals.issues));
    body.append(totalRow);
    for (const row of rows) {
      const line = document.createElement("tr");
      const file = document.createElement("td");
      const link = document.createElement("button");
      link.textContent = shortFileName(row.file);
      link.title = row.file;
      link.onclick = () => this.callbacks.onOpenFile(row.file);
      file.append(link);
      line.append(file);
      if (!row.item) {
        for (let index = 0; index < COLUMNS.length - 2; index++) line.append(textCell("—"));
        line.append(textCell("待分析"));
        body.append(line);
        continue;
      }
      line.append(textCell(row.item.statistics.codeLines));
      line.append(textCell(`${Math.round(row.item.statistics.commentRatio * 100)}%`));
      line.append(textCell(row.item.processes.length));
      line.append(textCell(row.item.instanceCount));
      const issues = document.createElement("td");
      const count = issueCounts.get(filePathKey(row.file)) ?? 0;
      if (count) {
        const button = document.createElement("button");
        button.textContent = String(count);
        button.title = "查看此文件诊断";
        button.onclick = () => this.callbacks.onOpenProblems({ file: row.file });
        issues.append(button);
      } else issues.textContent = "0";
      line.append(issues);
      body.append(line);
    }
    table.append(header, body);
    this.table.append(table);
  }
}

function issueCountsByFile(diagnostics: (RuleDiagnostic | SyntaxDiagnostic)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const file = filePathKey(diagnostic.file);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

function shortFileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function statsTotals(view: StatsView) {
  const commentLines = view.facts.reduce((sum, item) => sum + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
  const commentDenominator = view.facts.reduce((sum, item) => sum + item.statistics.codeLines + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
  return {
    codeLines: view.facts.reduce((sum, item) => sum + item.statistics.codeLines, 0),
    commentRatio: `${commentDenominator ? Math.round(commentLines / commentDenominator * 100) : 0}%`,
    processes: view.facts.reduce((sum, item) => sum + item.processes.length, 0),
    instances: view.facts.reduce((sum, item) => sum + item.instanceCount, 0),
    issues: view.diagnostics.length,
  };
}

function topologyTotal(view: StatsView): HTMLElement {
  const totals = statsTotals(view);
  const total = document.createElement("div");
  total.className = "stats-topology-row stats-topology-total";
  total.title = "按当前范围内的 HDL 文件汇总，不因模块重复例化重复计数";
  const label = document.createElement("span");
  label.className = "stats-topology-label";
  label.textContent = "合计";
  total.append(document.createElement("span"), label, metric(totals.codeLines), metric(totals.commentRatio), metric(totals.processes), metric(totals.instances), metric(totals.issues), document.createElement("span"));
  return total;
}

function topologyHeader(): HTMLElement {
  const header = document.createElement("div");
  header.className = "stats-topology-row stats-topology-head";
  const label = document.createElement("span");
  label.textContent = "模块／实例";
  header.append(document.createElement("span"), label, metric("代码行"), metric("注释"), metric("过程"), metric("例化"), metric("问题"));
  const locate = document.createElement("span");
  locate.textContent = "定位";
  header.append(locate);
  return header;
}

function metric(value: string | number): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "stats-topology-metric";
  span.textContent = String(value);
  return span;
}

function textCell(value: string | number): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = String(value);
  return cell;
}
