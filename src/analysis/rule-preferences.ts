import type { RuleDiagnostic } from "./general-rules";
import { filePathKey } from "../file-path";

export interface RulePreferences {
  style: boolean;
  gjb10157: boolean;
  gjb9765: boolean;
  tabPolicy: "spaces" | "tabs";
  disabledRules: string[];
  severityOverrides: Record<string, "error" | "warning" | "info">;
  excludes: string[];
}

export const ALL_RULE_PREFERENCES: RulePreferences = { style: true, gjb10157: true, gjb9765: true, tabPolicy: "spaces", disabledRules: [], severityOverrides: {}, excludes: [] };

export function applyRulePreferences(diagnostics: RuleDiagnostic[], preferences: RulePreferences): RuleDiagnostic[] {
  const disabled = new Set(preferences.disabledRules);
  const excludes = preferences.excludes.map(filePathKey);
  const filtered = diagnostics.filter(diagnostic => {
    if (disabled.has(diagnostic.ruleId)) return false;
    if (diagnostic.category === "style" && !preferences.style) return false;
    if (diagnostic.category === "gjb10157" && !preferences.gjb10157) return false;
    if (diagnostic.category === "gjb9765" && !preferences.gjb9765) return false;
    if (preferences.tabPolicy === "tabs" && diagnostic.ruleId === "VHD-ST-002") return false;
    if (preferences.tabPolicy === "spaces" && diagnostic.ruleId === "9765-4.14-b") return false;
    const file = filePathKey(diagnostic.file);
    return !excludes.some(exclude => {
      const normalized = exclude.replace(/\/+$/, "");
      return normalized && (file === normalized || file.startsWith(`${normalized}/`) || file.includes(`/${normalized}/`) || file.endsWith(`/${normalized}`));
    });
  });
  const grouped = new Map<string, RuleDiagnostic>();
  for (const diagnostic of filtered) {
    const override = preferences.severityOverrides[diagnostic.ruleId];
    if (override) diagnostic.severity = override;
    const key = `${dedupeFamily(diagnostic.ruleId)}|${filePathKey(diagnostic.file)}|${diagnostic.line}|${diagnostic.column}`;
    const previous = grouped.get(key);
    if (!previous) {
      grouped.set(key, { ...diagnostic, relatedRuleIds: diagnostic.relatedRuleIds ?? [diagnostic.ruleId] });
      continue;
    }
    const related = [...new Set([...previous.relatedRuleIds ?? [previous.ruleId], ...diagnostic.relatedRuleIds ?? [diagnostic.ruleId]])];
    const first = widthRank(previous.ruleId) <= widthRank(diagnostic.ruleId) ? previous : diagnostic;
    grouped.set(key, {
      ...first,
      severity: severityRank(previous.severity) < severityRank(diagnostic.severity) ? previous.severity : diagnostic.severity,
      relatedRuleIds: related,
      message: related.length > 1 ? `${first.message}（关联 ${related.filter(id => id !== first.ruleId).join("、")}）` : first.message,
    });
  }
  return [...grouped.values()];
}

function dedupeFamily(ruleId: string): string {
  const families: [string, string][] = [
    ["VLG-SY-001|10157-R-10-4", "sequentialBlocking"],
    ["VLG-SY-002|10157-R-10-3", "combinationalNonblocking"],
    ["VHD-SY-002|9765-4.3-a", "sensitivity"],
    ["VHD-SY-004|9765-4.6-f", "multiDriver"],
    ["VLG-SY-003|10157-R-13-2", "initial"],
    ["VLG-ST-001|10157-A-1-4|9765-4.14-d", "lineWidth"],
    ["VHD-ST-001|9765-4.14-d", "lineWidth"],
    ["VLG-ST-004|10157-A-1-1", "fileHeader"],
    ["VHD-ST-004|9765-4.13-a", "fileHeader"],
    ["VHD-SY-003|9765-4.2-f", "latch"],
  ];
  for (const [ids, family] of families) if (ids.split("|").includes(ruleId)) return family;
  return ruleId;
}

function widthRank(ruleId: string): number {
  if (ruleId === "9765-4.14-d") return 0;
  if (ruleId === "10157-A-1-4") return 1;
  return 2;
}

function severityRank(severity: string): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}
