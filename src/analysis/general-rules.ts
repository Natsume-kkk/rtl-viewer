import type { AssignmentFacts, FileFacts } from "./facts";

export interface RuleDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  ruleId: string;
  source: "builtin";
  category: "style" | "synth" | "gjb10157" | "gjb9765";
  message: string;
  relatedRuleIds?: string[];
}

export function runGeneralRules(facts: FileFacts, includeStyle = false): RuleDiagnostic[] {
  const diagnostics: RuleDiagnostic[] = [];
  const emit = (severity: RuleDiagnostic["severity"], ruleId: string, category: RuleDiagnostic["category"], line: number, column: number, message: string) => {
    diagnostics.push({ file: facts.file, line, column, severity, ruleId, source: "builtin", category, message });
  };
  if (includeStyle) {
    const prefix = facts.language === "vhdl" ? "VHD" : "VLG";
    for (const line of facts.lines) {
      if (line.length > 120) emit("info", `${prefix}-ST-001`, "style", line.line, 121, `本行包含 ${line.length} 个字符，超过 120。`);
      if (line.firstTabColumn !== undefined) emit("info", `${prefix}-ST-002`, "style", line.line, line.firstTabColumn, "检测到 Tab 缩进，请按所选编码风格处理。");
    }
    if (!facts.eofNewline) emit("info", `${prefix}-ST-003`, "style", Math.max(1, facts.lines.length), 1, "文件末尾没有换行。");
    if (!facts.firstNonEmptyComment) emit("info", `${prefix}-ST-004`, "style", 1, 1, "第一条非空行不是文件头注释。");
    for (const definition of facts.definitions.filter(item => item.kind !== "architecture")) {
      if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) emit("info", `${prefix}-ST-005`, "style", definition.line, 1, `${definition.kind === "module" ? "module" : "entity"} “${definition.name}”不符合 lower_case_with_underscores。`);
    }
    for (const declaration of facts.declarations.filter(item => item.kind !== "other")) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(declaration.name)) emit("info", `${prefix}-ST-006`, "style", declaration.line, 1, `${declaration.kind === "parameter" ? "parameter" : "constant"} “${declaration.name}”不符合 UPPER_CASE_WITH_UNDERSCORES。`);
    }
    for (const line of facts.multiDeclarationLines) emit("info", `${prefix}-ST-007`, "style", line, 1, "一行包含多个声明，请每行只声明一个对象。");
  }

  for (const process of facts.processes) {
    if (facts.language === "verilog") {
      for (const assignment of process.assignments) {
        if (process.sequential && assignment.operator === "=") emit("warning", "VLG-SY-001", "synth", assignment.line, 1, `时序 always 中对“${assignment.target}”使用阻塞赋值，请使用 <=。`);
        if (process.combinational && assignment.operator === "<=") emit("warning", "VLG-SY-002", "synth", assignment.line, 1, `组合 always 中对“${assignment.target}”使用非阻塞赋值，请使用 =。`);
      }
      if (process.incompleteConditionalAssignment) emit("info", "VLG-SY-004", "synth", process.startLine, 1, "组合 always 中存在未覆盖的条件赋值路径，未检测到无条件默认赋值。");
    } else {
      if (process.sequential && !process.hasResetBranch) emit("info", "VHD-SY-001", "synth", process.startLine, 1, "时序过程中未识别到规则所定义的复位分支。");
      if (process.incompleteConditionalAssignment) emit("info", "VHD-SY-003", "synth", process.startLine, 1, "组合过程中存在未覆盖的条件赋值路径，未检测到无条件默认赋值。");
      if (process.combinational && process.explicitSensitivity && !process.sensitivity.includes("all")) {
        const sensitivity = new Set(process.sensitivity);
        const missing = new Set<string>();
        for (const assignment of process.assignments) {
          for (const read of [...assignment.reads, ...assignment.conditions]) {
            const name = read.toLowerCase();
            if (/^[a-z][a-z0-9_]*$/.test(name) && !sensitivity.has(name)) missing.add(name);
          }
        }
        for (const name of [...missing].slice(0, 3)) emit("info", "VHD-SY-002", "synth", process.startLine, 1, `信号“${name}”在过程内被读取，但未出现在敏感列表中。`);
      }
    }
  }
  for (const line of facts.initialLines) emit("info", "VLG-SY-003", "synth", line, 1, "检测到 initial；请核对目标器件与仿真用途。");
  emitMultipleDrivers(facts, emit);
  return diagnostics;
}

function emitMultipleDrivers(facts: FileFacts, emit: (severity: RuleDiagnostic["severity"], ruleId: string, category: RuleDiagnostic["category"], line: number, column: number, message: string) => void): void {
  const drivers = new Map<string, AssignmentFacts>();
  const reported = new Set<string>();
  for (const process of facts.processes) {
    for (const assignment of process.assignments) {
      const target = assignment.targetText.trim();
      if (target !== assignment.target || !/^[A-Za-z_]\w*$/.test(target)) continue;
      const key = facts.language === "vhdl" ? target.toLowerCase() : target;
      const first = drivers.get(key);
      if (first && first.processIndex !== assignment.processIndex && !reported.has(key)) {
        reported.add(key);
        const id = facts.language === "vhdl" ? "VHD-SY-004" : "VLG-SY-005";
        emit("warning", id, "synth", assignment.line, 1, `信号“${target}”还在第 ${first.line} 行的另一个过程中被赋值。`);
      } else if (!first) {
        drivers.set(key, assignment);
      }
    }
  }
}
