import type { SyntaxCheckOptions, SyntaxCheckResult } from "../ipc";
import type { FileFacts } from "../analysis/facts";

export interface SyntaxReportContext {
  options?: SyntaxCheckOptions;
  facts?: FileFacts[];
  stale?: boolean;
  failure?: string;
}

export function syntaxReportHtml(folder: string, result: SyntaxCheckResult, generated = new Date(), context: SyntaxReportContext = {}): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === "error") counts.error++;
    else if (diagnostic.severity === "warning") counts.warning++;
    else counts.info++;
  }
  const rows = result.diagnostics.map(diagnostic => `<tr><td class="${escapeHtml(diagnostic.severity)}">${escapeHtml(diagnostic.severity)}</td><td>${escapeHtml(diagnostic.source)}</td><td>${escapeHtml(diagnostic.ruleId)}</td><td>${escapeHtml(diagnostic.file)}</td><td>${diagnostic.line}</td><td>${diagnostic.column}</td><td>${escapeHtml(diagnostic.message)}</td></tr>`).join("\n");
  const backends = result.backends.map(backend => `<tr><td>${escapeHtml(backend.name)}</td><td>${escapeHtml(backend.version)}</td><td>${backend.files}</td><td>${escapeHtml(backend.status)}</td></tr>`).join("\n");
  const options = context.options ? escapeHtml(JSON.stringify(context.options)) : "未提供";
  const facts = context.facts ?? [];
  const codeLines = facts.reduce((sum, item) => sum + item.statistics.codeLines, 0);
  const commentLines = facts.reduce((sum, item) => sum + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
  const denominator = facts.reduce((sum, item) => sum + item.statistics.codeLines + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
  const externalStatus = result.backends.length ? `外部检查 ${result.checkedFiles} 个文件` : "外部后端未运行";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>RTL 工程检查报告</title>
<style>body{font:14px sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%;margin:12px 0 24px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eee}.error{color:#b42318}.warning{color:#9a6700}.info{color:#175cd3}code{word-break:break-all}</style></head><body>
<h1>RTL 工程检查报告</h1>
<p>工程：<code>${escapeHtml(folder)}</code></p><p>生成时间：${escapeHtml(generated.toISOString())}</p>
<p>纳入统计 ${facts.length} 个 HDL 文件；${externalStatus}；${counts.error} 个错误，${counts.warning} 个警告，${counts.info} 个提示${result.cancelled ? "；检查已取消，结果可能不完整" : ""}${context.stale ? "；源码或配置已变化，外部诊断待重新检查" : ""}。</p>
${context.failure ? `<p>最近一次检查失败：${escapeHtml(context.failure)}。下方外部诊断与后端状态来自上次返回的结果。</p>` : ""}
<h2>后端状态</h2>${backends ? `<table><thead><tr><th>后端</th><th>版本</th><th>文件数</th><th>状态</th></tr></thead><tbody>${backends}</tbody></table>` : "<p>本次仅包含内置分析结果。</p>"}
<h2>检查配置</h2><p><code>${options}</code></p>
<h2>工程统计</h2><p>代码行 ${codeLines}，注释行 ${commentLines}，注释比例 ${denominator ? Math.round(commentLines / denominator * 100) : 0}%。</p>
<h2>检查范围</h2><p>执行全部已实现的自动检查，报告包含全部诊断，不受桌面显示筛选影响。不包含综合、实现、时序分析、器件配置和完整跨时钟域验证；分析受限以诊断或后端状态明确说明。</p>
<h2>诊断明细</h2><table><thead><tr><th>程度</th><th>来源</th><th>规则</th><th>文件</th><th>行</th><th>列</th><th>消息</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

export function syntaxReportCsv(result: SyntaxCheckResult, context: SyntaxReportContext = {}): string {
  const rows = ["Severity,Source,Rule,File,Line,Column,Message"];
  for (const diagnostic of result.diagnostics) {
    rows.push([diagnostic.severity, diagnostic.source, diagnostic.ruleId, diagnostic.file, String(diagnostic.line), String(diagnostic.column), diagnostic.message].map(csvField).join(","));
  }
  if (!context.options && !context.facts && context.stale === undefined && !context.failure) return rows.join("\r\n") + "\r\n";
  rows.push("");
  rows.push(["Backend", "Version", "Files", "Status"].map(csvField).join(","));
  if (result.backends.length) {
    for (const backend of result.backends) rows.push([backend.name, backend.version, String(backend.files), backend.status].map(csvField).join(","));
  } else rows.push(["external", "未运行", "0", "not_run"].map(csvField).join(","));
  rows.push(["Stale", context.stale ? "true" : "false"].map(csvField).join(","));
  if (context.failure) rows.push(["Failure", context.failure].map(csvField).join(","));
  rows.push(["Options", JSON.stringify(context.options ?? {})].map(csvField).join(","));
  const facts = context.facts ?? [];
  const codeLines = facts.reduce((sum, item) => sum + item.statistics.codeLines, 0);
  const commentLines = facts.reduce((sum, item) => sum + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
  const denominator = facts.reduce((sum, item) => sum + item.statistics.codeLines + item.statistics.commentOnlyLines + item.statistics.inlineCommentLines, 0);
  rows.push(["CodeLines", "CommentLines", "CommentRatio"].map(csvField).join(","));
  rows.push([String(codeLines), String(commentLines), `${denominator ? Math.round(commentLines / denominator * 100) : 0}%`].map(csvField).join(","));
  return rows.join("\r\n") + "\r\n";
}

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
