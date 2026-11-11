import { GJB10157_RULES, GJB9765_RULES, type GjbRuleDefinition } from "./gjb-catalog";
import { assignmentScope, moduleScopeAt, type AssignmentFacts, type FileFacts, type ProcessFacts } from "./facts";
import type { RuleDiagnostic } from "./general-rules";
import { KEYWORDS } from "../parser/verilog";
import { expressionWidth, signalWidths, simpleBinary, sizedLiteralWidth } from "./width";

export function runGjb10157Rules(facts: FileFacts): RuleDiagnostic[] {
  if (facts.language !== "verilog") return [];
  const diagnostics: RuleDiagnostic[] = [];
  const emit = emitter(diagnostics, facts, "gjb10157", GJB10157_RULES);
  const names = allNames(facts);
  const clockNames = new Set(facts.processes.flatMap(process => process.clocks));
  const resetNames = new Set(facts.processes.flatMap(process => process.resets));
  const hasIdentifier = (expression: string, name: string) => containsIdentifier(expression, name, false);
  for (const { name, line } of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) emit("R-2-1", line, 1, `名称“${name}”必须以字母开始，且只能包含字母、数字和下划线。`);
    if (KEYWORDS.has(name) || ["sdffile", "edif", "config", "cell", "library", "entity", "architecture"].includes(name.toLowerCase())) emit("R-2-3", line, 1, `名称“${name}”与保留关键字同名。`);
    if (name.endsWith("_") || name.includes("__")) emit("R-2-2", line, 1, `名称“${name}”包含连续下划线或以下划线结尾。`);
    if (["VDD", "VSS", "VCC", "GND", "VREF"].includes(name.toUpperCase())) emit("R-2-4", line, 1, `名称“${name}”为禁用的电源或地参考名称。`);
    if (name.length < 2 || name.length > 32) emit("A-2-2", line, 1, `名称“${name}”的长度为 ${name.length}，建议为 2～32。`);
    if (clockNames.has(name) && !/^(?:clk_[a-z0-9_]+|Clk_[A-Za-z0-9_]+)$/.test(name)) emit("A-2-3", line, 1, `时钟“${name}”建议采用 clk_x 或 Clk_X 命名。`);
    if (resetNames.has(name.toLowerCase()) && !/^(?:rst|reset)_(?:[pn]|[A-Za-z0-9_]+)$/i.test(name)) emit("A-2-4", line, 1, `复位“${name}”建议采用 rst_x、reset_x、Rst_X 或 Reset_X 命名。`);
  }
  for (const declaration of facts.declarations) {
    if (declaration.kind === "other" && !/^(?:[a-z][a-z0-9_]*|[A-Z][A-Za-z0-9_]*)$/.test(declaration.name)) emit("A-2-5", declaration.line, 1, `变量“${declaration.name}”建议小写或仅首字母大写。`);
    if (declaration.kind !== "other" && !/^[A-Z][A-Z0-9_]*$/.test(declaration.name)) emit("A-2-5", declaration.line, 1, `常量“${declaration.name}”建议全部大写。`);
  }
  const caseNames = new Map<string, string>();
  for (const item of names) {
    const key = item.name.toLowerCase();
    const previous = caseNames.get(key);
    if (previous && previous !== item.name) emit("R-2-6", item.line, 1, `名称“${previous}”和“${item.name}”仅大小写不同。`);
    else caseNames.set(key, item.name);
  }
  const parameterNames = new Map<string, string>();
  const parameters = [
    ...facts.declarations.filter(item => item.kind === "parameter").map(item => ({ name: item.name, line: item.line, scope: item.scope })),
    ...facts.parameters.map(item => ({ name: item.name, line: item.line ?? 1, scope: item.scope })),
  ];
  for (const parameter of parameters) {
    const scope = moduleScopeAt(facts, parameter.line, parameter.scope);
    const previous = parameterNames.get(parameter.name);
    if (previous !== undefined && previous !== scope) emit("A-2-7", parameter.line, 1, `参数“${parameter.name}”在模块“${previous}”和“${scope}”中重复命名。`);
    else parameterNames.set(parameter.name, scope);
  }
  for (const declaration of facts.declarations.filter(item => item.kind === "other")) {
    const usedNames = usageNames(facts, moduleScopeAt(facts, declaration.line, declaration.scope));
    if (!usedNames.has(declaration.name)) emit("A-2-8", declaration.line, 1, `信号“${declaration.name}”声明后未被读取或赋值，可能为冗余声明。`);
  }
  const modules = facts.definitions.filter(item => item.kind === "module");
  if (modules.length > 1) emit("R-2-5", modules[1].line, 1, "同一文件中出现第二个 module，每个文件只允许一个。");
  for (const assignment of facts.processes.flatMap(process => process.assignments)) {
    const scope = assignmentScope(facts, assignment);
    if (facts.ports.some(port => moduleScopeAt(facts, port.line ?? 1, port.scope) === scope && (port.direction === "out" || port.direction === "output") && port.name === assignment.target && assignment.processIndex >= 0 && !facts.processes[assignment.processIndex].sequential)) {
      emit("A-3-3", assignment.line, 1, `输出端口“${assignment.target}”由组合逻辑直接驱动，建议改为寄存器输出。`);
    }
  }
  for (const line of facts.positionalInstanceLines) emit("R-2-9", line, 1, "例化疑似使用位置端口映射，请使用 .port(signal) 名称映射。");
  for (const process of facts.processes) {
    const seenAssignments = new Set<string>();
    for (const assignment of process.assignments) {
      if (process.combinational && assignment.operator === "<=") emit("R-10-3", assignment.line, 1, `组合逻辑对“${assignment.target}”使用非阻塞赋值。`);
      if (process.sequential && assignment.operator === "=") emit("R-10-4", assignment.line, 1, `时序逻辑对“${assignment.target}”使用阻塞赋值。`);
      if (process.combinational && selfFeedback(assignment, false)) emit("R-13-7", assignment.line, 1, `组合逻辑中“${assignment.target}”的赋值表达式包含自身，形成反馈。`);
      const assignmentKey = `${assignment.targetText}|${assignment.conditions.join("|")}`;
      if (seenAssignments.has(assignmentKey)) emit("R-10-5", assignment.line, 1, `同一条件下对“${assignment.target}”重复赋值。`);
      seenAssignments.add(assignmentKey);
    }
    for (const reset of process.resets) {
      if (resetPolarityMismatch(process, reset)) emit("R-6-3", process.startLine, 1, `复位“${reset}”的敏感边沿与进入复位分支的条件不一致。`);
    }
    if (process.sequential && !process.hasResetBranch) {
      emit("R-6-2", process.startLine, 1, "时序 always 未识别到规则所定义的复位初始化分支。");
      if (process.caseCount) emit("R-14-3", process.startLine, 1, "状态机过程未识别到初始状态复位或初始化。");
    }
    if (hasMixedResetTargets(process)) {
      emit("R-6-1", process.startLine, 1, "同一 always 中混用了有复位和无复位的触发器。");
    }
    if (process.resets.some(name => /set/.test(name)) && process.resets.some(name => /rst|reset/.test(name))) emit("A-5-4", process.startLine, 1, "同时使用了异步置位和异步复位信号，建议避免。");
    if (process.resets.length > 1) emit("A-5-5", process.startLine, 1, "同一 always 中使用了多个复位信号，建议只使用一个。");
    const scopeProcesses = facts.processes.filter(candidate => moduleScopeAt(facts, candidate.startLine, candidate.scope) === moduleScopeAt(facts, process.startLine, process.scope));
    if (process.incompleteConditionalAssignment && scopeProcesses.length > 1) emit("A-7-1", process.startLine, 1, "锁存器与其他组合逻辑过程混合描述，建议分开。");
    if (process.missingElse) emit("A-11-5", process.startLine, 1, "组合逻辑 always 中存在缺少 else 的 if 分支。");
    reportSensitivity(facts, process, emit, "R-13-9");
  }
  for (const item of facts.cases) {
    if (!item.hasDefault) emit("R-11-1", item.startLine, 1, "case 语句缺少 default 分支。");
    if (item.controlConstant) emit("R-11-2", item.startLine, 1, "case 控制表达式为固定常量。");
    if (item.nonconstantLabel) emit("R-11-6", item.startLine, 1, "case 分支表达式包含变量或运算，请使用常量分支。");
    const caseWidths = signalWidths(facts, item.scope ?? "");
    const controlWidth = expressionWidth(item.control, caseWidths);
    if (controlWidth !== undefined) {
      for (const label of item.labels) {
        const labelWidth = sizedLiteralWidth(label);
        if (labelWidth !== undefined && labelWidth !== controlWidth) emit("R-11-3", item.startLine, 1, `case 控制表达式位宽为 ${controlWidth}，分支“${label}”位宽为 ${labelWidth}。`);
      }
    }
    const stateCase = facts.processes.some(process => process.sequential && (item.scope === undefined || item.scope === process.scope) && item.startLine >= process.startLine && item.startLine <= process.endLine);
    const hasRecovery = item.defaultAssignments.some(assignment => assignment.target === item.control && assignment.expression !== item.control);
    if (stateCase && item.hasDefault && !hasRecovery) emit("R-14-2", item.startLine, 1, "default 分支未将状态寄存器恢复为确定状态。");
    if (new Set(item.labels).size !== item.labels.length) emit("A-11-1", item.startLine, 1, "case 分支表达式存在重叠或重复。");
    if (item.defaultHasX) emit("A-11-3", item.startLine, 1, "default 分支包含 x 值，建议避免。");
    if (item.labels.length > 40) emit("A-14-1", item.startLine, 1, `状态机分支数量为 ${item.labels.length}，建议不超过 40。`);
  }
  for (const signature of facts.signatures) {
    switch (signature.kind) {
      case "zLiteral":
        if (isTopLevelTriState(facts, signature.text)) break;
        emit("R-8-2", signature.line, signature.column, "检测到三态字面值 z，内部逻辑禁止使用。");
        if (/[&|^~]/.test(signature.text)) emit("R-8-1", signature.line, signature.column, "三态缓冲器使能端包含组合逻辑输出。");
        break;
      case "xzRelation": emit("R-9-4", signature.line, signature.column, "关系表达式使用了包含 x 或 z 的值。"); break;
      case "conditionXZ": emit("R-11-4", signature.line, signature.column, "if 条件或 case 控制表达式包含 x 或 z。"); break;
      case "xzArithmetic": emit("R-9-5", signature.line, signature.column, "算术表达式使用了包含 x 或 z 的值。"); break;
      case "delay": emit("R-10-6", signature.line, signature.column, "检测到延迟语句，可综合代码中禁止使用。"); break;
      case "defparam": emit("A-2-6", signature.line, signature.column, "检测到 defparam，建议避免使用。"); break;
      case "caseXZ": emit("A-11-2", signature.line, signature.column, "检测到 casex/casez，建议避免使用。"); break;
      case "sensitivityPipe": emit("R-11-5", signature.line, signature.column, "敏感列表使用了 | 或 ||，请改用 or 或逗号。"); break;
      case "absoluteInclude": emit("R-2-7", signature.line, signature.column, "文件引用使用绝对路径，请改用相对路径。"); break;
      case "forbiddenType": emit("R-2-8", signature.line, signature.column, "检测到规定范围之外的数据类型。"); break;
      case "fullCase": emit("A-16-1", signature.line, signature.column, "检测到 full_case 属性，建议避免使用。"); break;
      case "repeatVariable": emit("A-12-1", signature.line, signature.column, "repeat 表达式使用变量，建议改用常量。"); break;
      case "multiStatement": emit("A-1-6", signature.line, signature.column, "一行包含多个赋值语句，请分行描述。"); break;
      case "forNonconstant": emit("R-12-1", signature.line, signature.column, "for 的初始值或条件不是常量。"); break;
      case "forOtherArithmetic": emit("R-12-2", signature.line, signature.column, "for 循环体中对循环变量之外的变量进行了算术运算。"); break;
      case "forReset": emit("R-12-3", signature.line, signature.column, "复位部分和逻辑部分出现在同一个 for 循环中。"); break;
      case "zeroLoop": emit("R-12-4", signature.line, signature.column, "循环条件在初次判断时不成立，循环不会执行。"); break;
      case "recursiveFunction": emit("R-12-5", signature.line, signature.column, "检测到函数递归调用。"); break;
      case "taskTiming": emit("R-13-1", signature.line, signature.column, "task 中包含时序控制语句。"); break;
      case "functionNonblocking": emit("R-13-3", signature.line, signature.column, "function 中使用了非阻塞赋值。"); break;
      case "functionGlobalAssign": emit("R-13-4", signature.line, signature.column, "function／task 中存在赋值，请核对是否对全局信号赋值。"); break;
      case "arrayExpression": emit("A-13-1", signature.line, signature.column, "数组索引包含表达式，建议使用简单信号。"); break;
      default: break;
    }
  }
  for (const line of facts.initialLines) emit("R-13-2", line, 1, "检测到 initial 语句，GJB 10157 禁止使用。");
  if (!facts.firstNonEmptyComment) emit("A-1-1", 1, 1, "文件未以标准注释头开始。");
  for (const line of facts.multiDeclarationLines) emit("A-1-7", line, 1, "一行包含多个声明，请每行只说明一个 I/O 端口或对象。");
  for (const line of facts.lines) if (line.length >= 80) emit("A-1-4", line.line, 80, `本行包含 ${line.length} 个字符，GJB 10157 建议少于 80。`);
  if (facts.statistics.commentRatio < 0.2) emit("A-1-8", 1, 1, `注释比例为 ${Math.round(facts.statistics.commentRatio * 100)}%，低于建议的 20%。`);
  const fileBase = facts.file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "");
  if (modules[0] && fileBase && fileBase !== modules[0].name) emit("A-2-1", modules[0].line, 1, `模块名“${modules[0].name}”与文件名“${fileBase}”不一致。`);
  const edges = new Map<string, Set<string>>();
  const fallingClockLines = new Map<string, number>();
  for (const process of facts.processes) {
    const scope = moduleScopeAt(facts, process.startLine, process.scope);
    const kinds = edges.get(scope) ?? new Set<string>();
    for (const event of process.sensitivity) {
      const edge = /^(posedge|negedge)\s+([A-Za-z_]\w*)\b/.exec(event);
      if (!edge || !process.clocks.includes(edge[2])) continue;
      kinds.add(edge[1]);
      if (edge[1] === "negedge" && !fallingClockLines.has(scope)) fallingClockLines.set(scope, process.startLine);
    }
    edges.set(scope, kinds);
  }
  for (const [scope, line] of fallingClockLines) {
    if (edges.get(scope)?.has("posedge")) emit("A-4-1", line, 1, "同一模块同时使用了 posedge 和 negedge，建议避免混用时钟边沿。");
  }
  for (const parameter of facts.parameters) {
    if (parameter.defaultValue && /^\d+$/.test(parameter.defaultValue.trim())) emit("A-9-2", parameter.line ?? 1, 1, `参数“${parameter.name}”未显式指定进制和位宽。`);
  }
  for (const parameter of facts.declarations.filter(item => item.kind === "parameter")) {
    if (parameter.defaultValue && /^\d+$/.test(parameter.defaultValue)) emit("A-9-2", parameter.line, 1, `参数“${parameter.name}”未显式指定进制和位宽。`);
  }
  for (const assignment of [...facts.processes.flatMap(process => process.assignments), ...facts.concurrentAssignments]) {
    const scope = assignmentScope(facts, assignment);
    const scopeProcesses = facts.processes.filter(process => moduleScopeAt(facts, process.startLine, process.scope) === scope);
    const scopeClockNames = new Set(scopeProcesses.flatMap(process => process.clocks));
    const scopeResetNames = new Set(scopeProcesses.flatMap(process => process.resets));
    const scopeRegisterDriven = new Set(scopeProcesses.filter(process => process.sequential).flatMap(process => process.assignments.map(item => item.target)));
    const scopePorts = facts.ports.filter(port => moduleScopeAt(facts, port.line ?? 1, port.scope) === scope);
    const widths = signalWidths(facts, scope);
    const targetWidth = expressionWidth(assignment.targetText, widths);
    const valueWidth = expressionWidth(assignment.expression, widths);
    if (targetWidth !== undefined && valueWidth !== undefined && targetWidth !== valueWidth) emit("R-10-2", assignment.line, 1, `赋值目标位宽为 ${targetWidth}，表达式位宽为 ${valueWidth}。`);
    const relational = simpleBinary(assignment.expression, ["==", "!=", "<=", ">=", "<", ">"]);
    if (relational) {
      const left = expressionWidth(relational.left, widths), right = expressionWidth(relational.right, widths);
      if (left !== undefined && right !== undefined && left !== right) emit("R-9-1", assignment.line, 1, `关系操作符“${relational.operator}”两侧位宽分别为 ${left} 和 ${right}。`);
    }
    const bitwise = simpleBinary(assignment.expression, ["&", "|", "^"]);
    if (bitwise) {
      const left = expressionWidth(bitwise.left, widths), right = expressionWidth(bitwise.right, widths);
      if (left !== undefined && right !== undefined && left !== right) emit("R-9-2", assignment.line, 1, `位操作符“${bitwise.operator}”两侧位宽分别为 ${left} 和 ${right}。`);
    }
    const clockSource = assignment.expression.trim();
    if (scopeClockNames.has(assignment.target) && /^[A-Za-z_]\w*$/.test(clockSource) && scopeRegisterDriven.has(clockSource)) {
      emit("R-4-1", assignment.line, 1, `时钟“${assignment.target}”直接由另一信号驱动，请核对是否形成行波时钟。`);
    }
    for (const clock of scopeClockNames) {
      if (clock !== assignment.target && hasIdentifier(assignment.expression, clock)) emit("R-4-2", assignment.line, 1, `时钟“${clock}”参与了非时钟用途的赋值，请核对连接。`);
    }
    if (scopeProcesses.some(process => process.resets.includes(assignment.target.toLowerCase()))) {
      if (/[&|^~]/.test(assignment.expression)) {
        emit("R-5-3", assignment.line, 1, `复位“${assignment.target}”由组合逻辑产生，存在竞争冒险风险。`);
        if (modules.length === 1 && facts.instanceCount === 0) emit("A-5-1", assignment.line, 1, "复位产生电路宜放在独立模块中。");
        emit("A-5-3", assignment.line, 1, "内部生成信号被用作异步复位，建议避免。");
        emit("A-5-2", assignment.line, 1, `复位“${assignment.target}”的赋值包含逻辑操作，请核对异步复位线路。`);
      }
    }
    for (const reset of scopeResetNames) {
      if (hasIdentifier(assignment.expression, reset)) emit("R-5-1", assignment.line, 1, `复位“${reset}”被用于普通数据逻辑，请核对是否误接到非复位端。`);
    }
    const logicalVector = scopePorts.find(port => port.width && hasIdentifier(assignment.expression, port.name));
    if (logicalVector && /&&|\|\||!(?!=)/.test(assignment.expression)) emit("A-9-1", assignment.line, 1, `向量端口“${logicalVector.name}”参与逻辑运算，建议使用位宽明确的布尔表达式。`);
    const conditionVector = scopePorts.find(port => port.width && assignment.conditions.some(condition => hasIdentifier(condition, port.name)));
    if (conditionVector) emit("A-11-4", assignment.line, 1, `向量端口“${conditionVector.name}”参与条件表达式，建议改用单位宽条件。`);
    if (scopeProcesses.some(process => process.clocks.includes(assignment.target)) && /[&|^~]/.test(assignment.expression)) {
      emit("R-4-3", assignment.line, 1, `时钟“${assignment.target}”由组合逻辑产生。`);
      emit("A-4-3", assignment.line, 1, `时钟“${assignment.target}”由组合逻辑产生，建议避免门控时钟。`);
    }
    if (literalWidthMismatch(assignment.expression)) emit("R-9-6", assignment.line, 1, "数值的声明位宽与实际位宽不一致。");
    if (/^\d+$/.test(assignment.expression.trim())) emit("A-9-2", assignment.line, 1, "常量或 parameter 未显式指定进制和位宽。");
    if (assignment.processIndex === -1 && selfFeedback(assignment, false)) {
      emit("R-7-2", assignment.line, 1, `并发赋值中“${assignment.target}”由自身反馈形成锁存结构。`);
      emit("R-7-1", assignment.line, 1, `并发赋值中“${assignment.target}”由自身反馈，可能形成锁存器环路。`);
    }
  }
  const clockDomains = new Map<string, Set<string>>();
  for (const process of facts.processes) {
    const scope = moduleScopeAt(facts, process.startLine, process.scope);
    const domains = clockDomains.get(scope) ?? new Set<string>();
    for (const clock of process.clocks) domains.add(clock);
    clockDomains.set(scope, domains);
  }
  for (const [scope, domains] of clockDomains) {
    if (domains.size > 1) emit("A-4-4", facts.processes.find(process => moduleScopeAt(facts, process.startLine, process.scope) === scope && process.clocks.length)?.startLine ?? 1, 1, `模块“${scope}”检测到 ${domains.size} 个时钟域，建议仅使用一个时钟域。`);
  }
  return diagnostics;
}

export function runGjb9765Rules(facts: FileFacts): RuleDiagnostic[] {
  if (facts.language !== "vhdl") return [];
  const diagnostics: RuleDiagnostic[] = [];
  const emit = emitter(diagnostics, facts, "gjb9765", GJB9765_RULES);
  if (facts.definitions.some(definition => definition.kind === "entity") && !facts.ports.length) emit("4.2-a", facts.definitions[0]?.line ?? 1, 1, "模块／单元未识别到输入／输出端口。");
  const names = allNames(facts);
  const declarationKinds = new Map<string, string>();
  for (const { name, line, kind: objectKind } of names) {
    if (KEYWORDS.has(name) || ["entity", "architecture", "signal", "variable", "constant", "process", "package", "library", "use"].includes(name.toLowerCase())) emit("4.5-a", line, 1, `标识符“${name}”与语言关键字重复。`);
    if (name.endsWith("_") || name.includes("__")) emit("4.5-c", line, 1, `标识符“${name}”以下划线结尾或包含连续下划线。`);
    if (!/^[a-z][a-z0-9_]*$/.test(name)) emit("4.5-f", line, 1, `标识符“${name}”不符合统一的小写下划线命名建议。`);
    const previousKind = declarationKinds.get(name.toLowerCase());
    if (previousKind && previousKind !== objectKind) emit("4.5-b", line, 1, `不同类型对象使用了相同标识符“${name}”（${previousKind}／${objectKind}）。`);
    else declarationKinds.set(name.toLowerCase(), objectKind);
  }
  const caseNames = new Map<string, { name: string; line: number }>();
  for (const item of names) {
    const key = item.name.toLowerCase();
    const previous = caseNames.get(key);
    if (previous && previous.name !== item.name) emit("4.5-d", item.line, 1, `标识符“${previous.name}”和“${item.name}”仅大小写不同。`);
    else caseNames.set(key, item);
  }
  for (const declaration of facts.declarations.filter(item => item.kind === "other")) {
    const usedNames = usageNames(facts, moduleScopeAt(facts, declaration.line, declaration.scope));
    if (!usedNames.has(declaration.name)) emit("4.4-b", declaration.line, 1, `信号“${declaration.name}”声明后未被使用，可能为多余信号。`);
  }
  for (const line of facts.positionalInstanceLines) emit("4.1-a", line, 1, "检测到位置端口映射，请改用名称关联（=>）。");
  for (const process of facts.processes) {
    if (process.incompleteConditionalAssignment) emit("4.2-f", process.startLine, 1, "组合过程中存在未覆盖的条件赋值路径，可能产生非预期锁存器。");
    for (const clock of process.clocks) {
      if (!/^clk/i.test(clock)) emit("4.5-e", process.startLine, 1, `时钟“${clock}”建议与时钟用途相区别的名称（如 clk 前缀）。`);
    }
    if (process.sequential && process.caseCount && !process.hasResetBranch) emit("4.11-c", process.startLine, 1, "状态机过程未识别到合法初始状态。");
    if (process.eventCount > 1) emit("4.4-d", process.startLine, 1, `进程包含 ${process.eventCount} 个事件控制，只允许一个。`);
    if (process.missingElse) emit("4.8-d", process.startLine, 1, "组合逻辑进程中的 if 语句缺少 else 分支。");
    if (new Set(process.clocks).size > 1) emit("4.9-d", process.startLine, 1, `进程使用了 ${new Set(process.clocks).size} 个不同的时钟信号。`);
    reportSensitivity(facts, process, emit, "4.3-a");
  }
  const stateMachine = facts.processes.some(process => process.sequential && process.caseCount);
  if (stateMachine && facts.processes.length !== 3) emit("4.11-d", facts.processes[0]?.startLine ?? 1, 1, "状态机建议使用三段式描述。");
  if (stateMachine && !facts.signatures.some(signature => signature.kind === "enum")) emit("4.11-e", facts.processes[0]?.startLine ?? 1, 1, "状态机建议使用枚举类型声明状态。");
  for (const item of facts.cases) {
    if (!item.fullyCovered) emit("4.8-c", item.startLine, 1, "case 未完全覆盖且缺少 when others 分支。");
    if (item.labels.length > 40) emit("4.11-f", item.startLine, 1, "状态数量或编码方式需要按复杂度、速度和资源综合评估。");
    if (item.controlConstant) emit("4.8-a", item.startLine, 1, "case 表达式为固定常量。");
    if (item.nonconstantLabel) emit("4.8-b", item.startLine, 1, "case 分支使用了变量或变量表达式。");
    const stateCase = facts.processes.some(process => process.sequential && (item.scope === undefined || item.scope === process.scope) && item.startLine >= process.startLine && item.startLine <= process.endLine);
    const hasRecovery = item.defaultAssignments.some(assignment => assignment.target.toLowerCase() === item.control.toLowerCase() && assignment.expression.toLowerCase() !== item.control.toLowerCase());
    if (stateCase && item.hasDefault && !hasRecovery) emit("4.11-a", item.startLine, 1, "when others 未将状态寄存器恢复为确定状态。");
  }
  for (const signature of facts.signatures) {
    switch (signature.kind) {
      case "zLiteral":
        if (isTopLevelTriState(facts, signature.text)) break;
        emit("4.2-c", signature.line, signature.column, "检测到三态值 Z，请避免在内部逻辑中使用。");
        if (/\b(?:and|or|not|xor|nand|nor)\b/i.test(signature.text)) emit("4.6-i", signature.line, signature.column, "三态使能端包含组合逻辑，建议避免。");
        break;
      case "conditionXZ": emit("4.4-c", signature.line, signature.column, "条件表达式使用了 X、Z 或 ? 状态，请避免。"); break;
      case "declarationInit": emit("4.10-e", signature.line, signature.column, "检测到声明时初始化，建议改用复位逻辑初始化。"); break;
      case "bufferPort": emit("4.12-c", signature.line, signature.column, "检测到 buffer 模式端口，请改用 out 并配合中间信号。"); break;
      case "multiPortMapping": emit("4.14-d", signature.line, signature.column, "一行包含多个端口映射，请每行只映射一个信号。"); break;
      case "missingWidth": emit("4.4-a", signature.line, signature.column, "多位信号或变量声明未设置位宽。"); break;
      case "whileConstant": emit("4.7-c", signature.line, signature.column, "while 条件表达式不应为常量。"); break;
      case "forNonconstant": emit("4.7-a", signature.line, signature.column, "循环终止条件使用了非常量参数。"); break;
      case "forOtherArithmetic": emit("4.7-b", signature.line, signature.column, "for 循环体内修改了循环变量。"); break;
      case "emptyStatement": emit("4.8-e", signature.line, signature.column, "进程中存在空语句，建议明确处理意图。"); break;
      case "spacing": emit("4.14-c", signature.line, signature.column, "赋值符号或运算符两侧宜保留一个空格。"); break;
      case "delay": emit("4.12-a", signature.line, signature.column, "检测到不可综合的延迟语句，请核对综合用途。"); break;
      case "multiStatement": emit("4.14-d", signature.line, signature.column, "一行包含多个 HDL 语句，请分行描述。"); break;
      case "absoluteInclude": emit("4.14-d", signature.line, signature.column, "文件引用使用绝对路径，请改用相对路径。"); break;
      default: break;
    }
  }
  for (const constant of facts.declarations.filter(item => item.kind === "constant" && item.defaultValue)) {
    const scope = moduleScopeAt(facts, constant.line, constant.scope);
    const nonconstants = new Set([
      ...facts.ports.filter(port => moduleScopeAt(facts, port.line ?? 1, port.scope) === scope).map(port => port.name.toLowerCase()),
      ...facts.declarations.filter(item => item.kind === "other" && moduleScopeAt(facts, item.line, item.scope) === scope).map(item => item.name.toLowerCase()),
    ]);
    if ((constant.defaultValue!.match(/[A-Za-z_]\w*/g) ?? []).some(name => nonconstants.has(name.toLowerCase()))) emit("4.6-c", constant.line, 1, `常量“${constant.name}”的初始化引用了非常量对象。`);
  }
  for (const assignment of [...facts.processes.flatMap(process => process.assignments), ...facts.concurrentAssignments]) {
    const scope = assignmentScope(facts, assignment);
    const scopeProcesses = facts.processes.filter(process => moduleScopeAt(facts, process.startLine, process.scope) === scope);
    const scopeClockNames = new Set(scopeProcesses.flatMap(process => process.clocks));
    const scopeRegisterDriven = new Set(scopeProcesses.filter(process => process.sequential).flatMap(process => process.assignments.map(item => item.target.toLowerCase())));
    const sourceProcess = assignment.processIndex >= 0 ? facts.processes[assignment.processIndex] : undefined;
    const widths = signalWidths(facts, scope);
    const binary = simpleBinary(assignment.expression, ["=", "/=", "<=", ">=", "<", ">", "+", "-", "*", "/"]);
    if (binary) {
      const left = expressionWidth(binary.left, widths), right = expressionWidth(binary.right, widths);
      if (left !== undefined && right !== undefined && left !== right) emit("4.6-b", assignment.line, 1, `运算符“${binary.operator}”两侧位宽分别为 ${left} 和 ${right}。`);
    }
    for (const port of facts.ports.filter(port => moduleScopeAt(facts, port.line ?? 1, port.scope) === scope && (port.direction === "out" || port.direction === "output"))) {
      if (containsIdentifier(assignment.expression, port.name) || assignment.conditions.some(condition => containsIdentifier(condition, port.name))) {
        emit("4.2-b", assignment.line, 1, `读取输出端口“${port.name}”参与模块内部逻辑，请使用中间信号。`);
      }
    }
    if (sourceProcess?.combinational) {
      for (const clock of scopeClockNames) {
        if (assignment.conditions.some(condition => containsIdentifier(condition, clock))) emit("4.9-b", assignment.line, 1, `时钟“${clock}”参与组合条件选择控制，请核对多路选择器控制端。`);
      }
    }
    if (scopeClockNames.has(assignment.target.toLowerCase())) {
      if (containsIdentifier(assignment.expression, assignment.target)) emit("4.9-a", assignment.line, 1, `时钟“${assignment.target}”发生再汇聚或反馈。`);
      const source = assignment.expression.trim().toLowerCase();
      if (/^[a-z_]\w*$/.test(source) && scopeRegisterDriven.has(source)) emit("4.9-g", assignment.line, 1, `时钟“${assignment.target}”直接由另一寄存器输出驱动，属于行波时钟。`);
      if (/\b(?:not|buf|bufif)\b/i.test(assignment.expression)) emit("4.9-j", assignment.line, 1, `时钟“${assignment.target}”的路径包含反相器或缓冲器。`);
    }
    if (scopeClockNames.has(assignment.target.toLowerCase()) && /\b(?:and|or|not|xor|nand|nor)\b/i.test(assignment.expression)) {
      emit("4.9-c", assignment.line, 1, `时钟信号“${assignment.target}”由逻辑运算产生，属于门控时钟。`);
      emit("4.9-e", assignment.line, 1, `时钟信号“${assignment.target}”由组合逻辑产生。`);
    }
  }
  const clockDomains = new Map<string, Set<string>>();
  for (const process of facts.processes) {
    const scope = moduleScopeAt(facts, process.startLine, process.scope);
    const domains = clockDomains.get(scope) ?? new Set<string>();
    for (const clock of process.clocks) domains.add(clock);
    clockDomains.set(scope, domains);
  }
  for (const [scope, domains] of clockDomains) {
    if (domains.size > 1) emit("4.9-h", facts.processes.find(process => moduleScopeAt(facts, process.startLine, process.scope) === scope && process.clocks.length)?.startLine ?? 1, 1, `模块“${scope}”检测到 ${domains.size} 个时钟域，建议减少并尽量只使用一个。`);
  }
  const edgeKinds = new Map<string, Set<string>>();
  for (const signature of facts.signatures.filter(item => item.kind === "posedge" || item.kind === "negedge")) {
    const scope = moduleScopeAt(facts, signature.line, signature.scope);
    const edges = edgeKinds.get(scope) ?? new Set<string>();
    edges.add(signature.kind);
    edgeKinds.set(scope, edges);
  }
  for (const [scope, edges] of edgeKinds) {
    if (edges.size > 1) emit("4.9-i", facts.signatures.find(signature => signature.kind === "negedge" && moduleScopeAt(facts, signature.line, signature.scope) === scope)?.line ?? 1, 1, "同一模块同时存在上升沿和下降沿触发的寄存器。");
  }
  for (const process of facts.processes) {
    if (process.clocks.some(clock => process.resets.includes(clock))) emit("4.10-h", process.startLine, 1, "同一信号同时用作时钟和复位／置位，请避免。");
  }
  const drivers = new Map<string, AssignmentFacts>();
  const reported = new Set<string>();
  for (const assignment of [...facts.processes.flatMap(process => process.assignments), ...facts.concurrentAssignments]) {
    const target = assignment.targetText.trim();
    if (target !== assignment.target || !/^[A-Za-z_]\w*$/.test(target)) continue;
    const key = `${assignmentScope(facts, assignment)}|${target.toLowerCase()}`;
    const first = drivers.get(key);
    if (first && (first.processIndex !== assignment.processIndex || first.processIndex === -1) && !reported.has(key)) {
      reported.add(key);
      emit("4.6-f", assignment.line, 1, `信号“${target}”还由第 ${first.line} 行的过程或并发语句驱动。`);
    } else if (!first) drivers.set(key, assignment);
  }
  const useBeforeDriver = new Set<string>();
  for (const process of facts.processes) {
    const localVariables = new Set(process.localVariables);
    const localDrivers = new Map<string, AssignmentFacts>();
    for (const assignment of process.assignments) if (!localDrivers.has(assignment.target.toLowerCase())) localDrivers.set(assignment.target.toLowerCase(), assignment);
    for (const assignment of process.assignments) {
      for (const read of assignment.reads) {
        const name = read.toLowerCase();
        const driver = localDrivers.get(name);
        if (localVariables.has(name) && driver && driver.line > assignment.line && useBeforeDriver.add(`${process.startLine}|${name}|${assignment.line}`)) {
          emit("4.6-a", assignment.line, 1, `局部变量“${read}”在第 ${driver.line} 行赋值前被使用。`);
        }
      }
    }
  }
  if (!facts.firstNonEmptyComment) emit("4.13-a", 1, 1, "文件未以注释头开始。");
  const documented = new Set(facts.commentLines);
  const hasNearbyComment = (line: number) => documented.has(line) || documented.has(line - 1);
  for (const port of facts.ports) {
    if (!hasNearbyComment(port.line ?? 1)) emit("4.13-b", port.line ?? 1, 1, `端口“${port.name}”缺少就近注释说明。`);
  }
  for (const declaration of facts.declarations) {
    if (!hasNearbyComment(declaration.line)) emit("4.13-c", declaration.line, 1, `对象“${declaration.name}”缺少就近注释说明。`);
  }
  if (!facts.statistics.blankLines) emit("4.14-a", 1, 1, "代码各节之间宜使用空行分隔。");
  for (const line of facts.lines) {
    if (line.trailingWhitespaceColumn !== undefined) emit("4.14-b", line.line, line.trailingWhitespaceColumn, "检测到行尾空白字符。");
    if (line.length > 72) emit("4.14-d", line.line, 73, `本行包含 ${line.length} 个字符，GJB 9765 建议不超过 72。`);
  }
  return diagnostics;
}

function emitter(diagnostics: RuleDiagnostic[], facts: FileFacts, category: "gjb10157" | "gjb9765", definitions: GjbRuleDefinition[]) {
  const severities = new Map(definitions.map(definition => [definition.id, definition.severity]));
  return (id: string, line: number, column: number, message: string) => {
    diagnostics.push({ file: facts.file, line, column, severity: severities.get(id) ?? "warning", ruleId: `${category === "gjb10157" ? "10157" : "9765"}-${id}`, source: "builtin", category, message });
  };
}

function usageNames(facts: FileFacts, scope?: string): Set<string> {
  const names = new Set<string>(scope === undefined ? facts.instanceReads : facts.instanceReadSites.filter(site => (site.scope ?? moduleScopeAt(facts, site.line)) === scope).map(site => site.name));
  const assignments = [...facts.processes.flatMap(process => process.assignments), ...facts.concurrentAssignments].filter(assignment => scope === undefined || assignmentScope(facts, assignment) === scope);
  for (const assignment of assignments) {
    names.add(assignment.target);
    for (const name of assignment.expression.match(/[A-Za-z_]\w*/g) ?? []) names.add(name);
    for (const condition of assignment.conditions) for (const name of condition.match(/[A-Za-z_]\w*/g) ?? []) names.add(name);
  }
  for (const process of facts.processes.filter(process => scope === undefined || moduleScopeAt(facts, process.startLine, process.scope) === scope)) {
    for (const sensitivity of process.sensitivity) for (const name of sensitivity.match(/[A-Za-z_]\w*/g) ?? []) names.add(name);
  }
  return names;
}

function allNames(facts: FileFacts): { name: string; line: number; kind: string }[] {
  return [
    ...facts.definitions.filter(item => item.kind !== "architecture").map(item => ({ name: item.name, line: item.line, kind: item.kind })),
    ...facts.declarations.map(item => ({ name: item.name, line: item.line, kind: item.kind })),
    ...facts.ports.map(item => ({ name: item.name, line: item.line ?? 1, kind: "port" })),
    ...facts.parameters.map(item => ({ name: item.name, line: item.line ?? 1, kind: "parameter" })),
  ];
}

function hasMixedResetTargets(process: ProcessFacts): boolean {
  if (!process.sequential || !process.hasResetBranch) return false;
  const assignments = process.assignments.filter(item => item.targetText === item.target);
  const condition = assignments.find(item => item.conditions.length)?.conditions[0];
  if (!condition) return false;
  const simple = /^!?\s*([A-Za-z_]\w*)(?:\s*={2,3}\s*(?:1'b[01]|[01]))?$/.exec(condition);
  if (!simple || !process.resets.includes(simple[1].toLowerCase())) return false;
  const resetTargets = new Map<string, "reset" | "normal" | "unknown">();
  const normalTargets = new Set<string>();
  for (const item of assignments) {
    const branch = item.conditions[0];
    if (branch === undefined || branch === `!(${condition})`) normalTargets.add(item.target);
    if (branch === undefined) resetTargets.set(item.target, "normal");
    if (branch === condition) resetTargets.set(item.target, item.conditions.length === 1 ? "reset" : "unknown");
  }
  return [...resetTargets.values()].includes("reset")
    && [...normalTargets].some(target => (resetTargets.get(target) ?? "normal") === "normal");
}

function resetPolarityMismatch(process: ProcessFacts, reset: string): boolean {
  const escaped = reset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sensitivity = process.sensitivity.find(item => new RegExp(`\\b(?:posedge|negedge)\\s+${escaped}\\b`, "i").test(item));
  if (!sensitivity) return false;
  const conditions = process.assignments.flatMap(assignment => assignment.conditions).filter(condition => new RegExp(`\\b${escaped}\\b`, "i").test(condition)).sort((left, right) => left.length - right.length);
  const condition = conditions[0]?.trim();
  if (!condition) return false;
  const activeLow = new RegExp(`^!\\s*\\(?\\s*${escaped}\\b`, "i").test(condition) || new RegExp(`\\b${escaped}\\s*(?:==|=)\\s*(?:1'b0|'0'|0)\\b`, "i").test(condition);
  const activeHigh = new RegExp(`^\\(?\\s*${escaped}\\b`, "i").test(condition) || new RegExp(`\\b${escaped}\\s*(?:==|=)\\s*(?:1'b1|'1'|1)\\b`, "i").test(condition);
  if (activeLow === activeHigh) return false;
  return activeLow !== /negedge/i.test(sensitivity);
}

function reportSensitivity(facts: FileFacts, process: ProcessFacts, emit: (id: string, line: number, column: number, message: string) => void, id: string): void {
  if (!process.combinational || !process.explicitSensitivity || process.sensitivity.includes("all")) return;
  const sensitivity = new Set(process.sensitivity);
  const missing = new Set<string>();
  for (const assignment of process.assignments) {
    for (const read of [...assignment.reads, ...assignment.conditions]) {
      const name = facts.language === "vhdl" ? read.toLowerCase() : read;
      if (/^[A-Za-z_]\w*$/.test(name) && !sensitivity.has(name)) missing.add(name);
    }
  }
  for (const name of [...missing].slice(0, 3)) emit(id, process.startLine, 1, `信号“${name}”在过程内被读取，但未列入敏感列表。`);
}

function literalWidthMismatch(expression: string): boolean {
  for (const match of expression.matchAll(/\b(\d+)'\s*[sS]?([bBoOdDhH])([0-9a-fA-FxXzZ_?]+)/g)) {
    const declared = Number(match[1]);
    const digits = match[3].replaceAll("_", "");
    const base = match[2].toLowerCase();
    if (declared < 1 || base === "b" && !/^[01xz?]+$/i.test(digits) || base === "o" && !/^[0-7xz?]+$/i.test(digits) || base === "h" && !/^[0-9a-fxz?]+$/i.test(digits) || base === "d" && !/^[0-9xz?]+$/i.test(digits)) return true;
    if (/[xz?]/i.test(digits)) continue;
    const value = base === "b" ? BigInt(`0b${digits || "0"}`) : base === "o" ? BigInt(`0o${digits || "0"}`) : base === "h" ? BigInt(`0x${digits || "0"}`) : BigInt(digits || "0");
    if (declared < value.toString(2).length) return true;
  }
  return false;
}

function selfFeedback(assignment: AssignmentFacts, ignoreCase: boolean): boolean {
  const targetText = assignment.targetText.trim();
  if (targetText !== assignment.target) {
    const normalize = (text: string) => {
      const compact = text.replace(/\s+/g, "");
      return ignoreCase ? compact.toLowerCase() : compact;
    };
    return normalize(assignment.expression).includes(normalize(targetText));
  }
  return containsIdentifier(assignment.expression, assignment.target, ignoreCase);
}

function isTopLevelTriState(facts: FileFacts, text: string): boolean {
  const target = (/\bassign\s+([A-Za-z_]\w*)\s*=/.exec(text) ?? /^\s*([A-Za-z_]\w*)\s*<=/.exec(text))?.[1];
  return !!target && facts.ports.some(port => port.direction === "inout" && port.name === target);
}

function containsIdentifier(expression: string, name: string, ignoreCase = true): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, ignoreCase ? "i" : "").test(expression);
}
