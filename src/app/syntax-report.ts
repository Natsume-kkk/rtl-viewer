import type { SyntaxCheckResult } from "../ipc";

export function syntaxReportHtml(folder: string, result: SyntaxCheckResult, generated = new Date()): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === "error") counts.error++;
    else if (diagnostic.severity === "warning") counts.warning++;
    else counts.info++;
  }
  const rows = result.diagnostics.map(diagnostic => `<tr><td class="${escapeHtml(diagnostic.severity)}">${escapeHtml(diagnostic.severity)}</td><td>${escapeHtml(diagnostic.source)}</td><td>${escapeHtml(diagnostic.ruleId)}</td><td>${escapeHtml(diagnostic.file)}</td><td>${diagnostic.line}</td><td>${diagnostic.column}</td><td>${escapeHtml(diagnostic.message)}</td></tr>`).join("\n");
  const backends = result.backends.map(backend => `<tr><td>${escapeHtml(backend.name)}</td><td>${escapeHtml(backend.version)}</td><td>${backend.files}</td><td>${escapeHtml(backend.status)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>RTL 语法检查报告</title>
<style>body{font:14px sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%;margin:12px 0 24px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eee}.error{color:#b42318}.warning{color:#9a6700}.info{color:#175cd3}code{word-break:break-all}</style></head><body>
<h1>RTL 语法检查报告</h1>
<p>工程：<code>${escapeHtml(folder)}</code></p><p>生成时间：${escapeHtml(generated.toISOString())}</p>
<p>已检查 ${result.checkedFiles} 个文件；${counts.error} 个错误，${counts.warning} 个警告，${counts.info} 个提示${result.cancelled ? "；检查已取消" : ""}。</p>
<h2>后端与覆盖</h2><table><thead><tr><th>后端</th><th>版本</th><th>文件数</th><th>状态</th></tr></thead><tbody>${backends}</tbody></table>
<h2>诊断明细</h2><table><thead><tr><th>程度</th><th>来源</th><th>规则</th><th>文件</th><th>行</th><th>列</th><th>消息</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

export function syntaxReportCsv(result: SyntaxCheckResult): string {
  const rows = ["Severity,Source,Rule,File,Line,Column,Message"];
  for (const diagnostic of result.diagnostics) {
    rows.push([diagnostic.severity, diagnostic.source, diagnostic.ruleId, diagnostic.file, String(diagnostic.line), String(diagnostic.column), diagnostic.message].map(csvField).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
