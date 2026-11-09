import { monaco } from "../editor/monaco";
import type { SyntaxDiagnostic } from "../ipc";
import { filePathKey } from "../file-path";
import { diagnosticDisplayMessage, isUnclassifiedDisplayMessage } from "./diagnostic-display";

interface MarkedModel {
  path: string;
  model: monaco.editor.ITextModel;
}

export function syncProblemMarkers(models: Iterable<MarkedModel>, diagnostics: SyntaxDiagnostic[], stale: boolean, currentDiagnostics: SyntaxDiagnostic[] = []): void {
  const grouped = new Map<string, SyntaxDiagnostic[]>();
  for (const diagnostic of currentDiagnostics) {
    if (!diagnostic.file) continue;
    const key = filePathKey(diagnostic.file);
    const items = grouped.get(key) ?? [];
    items.push(diagnostic);
    grouped.set(key, items);
  }
  if (!stale) {
    for (const diagnostic of diagnostics) {
      if (!diagnostic.file) continue;
      const key = filePathKey(diagnostic.file);
      const items = grouped.get(key) ?? [];
      items.push(diagnostic);
      grouped.set(key, items);
    }
  }
  for (const { path, model } of models) {
    if (model.isDisposed()) continue;
    const markers = (grouped.get(filePathKey(path)) ?? []).slice(0, 500).map(diagnostic => ({
      severity: diagnostic.severity === "error" ? monaco.MarkerSeverity.Error
        : diagnostic.severity === "warning" ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
      message: markerMessage(diagnostic),
      source: diagnostic.source,
      startLineNumber: Math.min(Math.max(1, diagnostic.line), model.getLineCount()),
      startColumn: Math.max(1, diagnostic.column),
      endLineNumber: Math.min(Math.max(1, diagnostic.line), model.getLineCount()),
      endColumn: Math.max(1, diagnostic.column) + 1,
    }));
    monaco.editor.setModelMarkers(model, "rtl.syntax", markers);
  }
}

function markerMessage(diagnostic: SyntaxDiagnostic): string {
  const display = diagnosticDisplayMessage(diagnostic);
  const original = isUnclassifiedDisplayMessage(display) ? `\n原始诊断：${diagnostic.message}` : "";
  return `${diagnostic.ruleId}: ${display}${original}`;
}
