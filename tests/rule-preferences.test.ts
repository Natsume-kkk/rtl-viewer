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

it("行宽保留最严格条款，空格约定保留行尾空白诊断", () => {
  const width = applyRulePreferences([
    { ...diagnostic("VLG-ST-001", "120", "style"), column: 121 },
    { ...diagnostic("10157-A-1-4", "80", "gjb10157"), column: 80 },
    { ...diagnostic("9765-4.14-d", "本行包含 123 个字符，GJB 9765 建议不超过 72。", "gjb9765"), column: 73 },
  ], ALL_RULE_PREFERENCES);
  expect(width).toHaveLength(1);
  expect(width[0].ruleId).toBe("9765-4.14-d");
  const spaces = applyRulePreferences([diagnostic("VHD-ST-002", "tab", "style"), diagnostic("9765-4.14-b", "检测到行尾空白字符。", "gjb9765")], ALL_RULE_PREFERENCES);
  expect(spaces.map(item => item.ruleId)).toEqual(["VHD-ST-002", "9765-4.14-b"]);
});

it("保留同一位置的不同问题，只合并相同对象的相关条款", () => {
  const missingA = diagnostic("9765-4.1-b", "输入端口“a”悬空。", "gjb9765");
  const missingB = diagnostic("9765-4.1-b", "输入端口“b”悬空。", "gjb9765");
  const result = applyRulePreferences([
    missingA, missingB, missingA,
    diagnostic("VHD-SY-002", "信号“a”在过程内被读取，但未出现在敏感列表中。"),
    diagnostic("VHD-SY-002", "信号“b”在过程内被读取，但未出现在敏感列表中。"),
    diagnostic("9765-4.3-a", "信号“b”在过程内被读取，但未列入敏感列表。", "gjb9765"),
  ], ALL_RULE_PREFERENCES);
  expect(result).toHaveLength(4);
  expect(result[3].relatedRuleIds).toEqual(["VHD-SY-002", "9765-4.3-a"]);
});
