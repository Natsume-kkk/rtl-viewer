import { expect, it } from "vitest";
import { ALL_RULE_PREFERENCES, applyRulePreferences } from "../src/analysis/rule-preferences";
import type { RuleDiagnostic } from "../src/analysis/general-rules";

const diagnostic = (ruleId: string, message: string, category: RuleDiagnostic["category"] = "synth"): RuleDiagnostic => ({ file: "D:/project/a.sv", line: 4, column: 1, severity: "warning", ruleId, source: "builtin", category, message });

it("通用与 GJB 重复诊断合并并保留关联条款", () => {
  const result = applyRulePreferences([
    diagnostic("VLG-SY-001", "blocking"),
    diagnostic("10157-R-10-4", "gjb blocking", "gjb10157"),
  ], ALL_RULE_PREFERENCES);
  expect(result).toHaveLength(1);
  expect(result[0].relatedRuleIds).toEqual(["VLG-SY-001", "10157-R-10-4"]);
  expect(result[0].message).toContain("10157-R-10-4");
});

it("行宽保留最严格条款，Tab 冲突使用固定空格约定", () => {
  const width = applyRulePreferences([
    diagnostic("VLG-ST-001", "120", "style"),
    diagnostic("10157-A-1-4", "80", "gjb10157"),
    diagnostic("9765-4.14-d", "72", "gjb9765"),
  ], ALL_RULE_PREFERENCES);
  expect(width).toHaveLength(1);
  expect(width[0].ruleId).toBe("9765-4.14-d");
  const spaces = applyRulePreferences([diagnostic("VHD-ST-002", "tab", "style"), diagnostic("9765-4.14-b", "gjb tab", "gjb9765")], ALL_RULE_PREFERENCES);
  expect(spaces.map(item => item.ruleId)).toEqual(["VHD-ST-002"]);
});
