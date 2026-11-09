export interface DiagnosticMessageLike {
  source: string;
  ruleId: string;
  message: string;
}

const VERILATOR_RULE_LABELS: Record<string, string> = {
  PINNOTFOUND: "端口未找到",
  PINMISSING: "例化缺少端口连接",
  PINCONNECTEMPTY: "端口未连接",
  MODDUP: "模块重复定义",
  MODMISSING: "缺少模块定义",
  EOFNEWLINE: "文件末尾缺少换行",
  WIDTH: "位宽不匹配",
  WIDTHEXPAND: "位宽扩展",
  WIDTHTRUNC: "位宽截断",
  WIDTHDIGITS: "字面量位数超过声明宽度",
  WIDTHCONCAT: "拼接／复制位宽不确定",
  UNUSEDSIGNAL: "部分信号位未使用",
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
  PROTECTED: "已跳过加密保护代码段",
};

export function isVerilatorExitSummary(diagnostic: DiagnosticMessageLike): boolean {
  return diagnostic.source === "verilator" && /^Exiting due to\s+\d+\s+error\(s\)/i.test(diagnostic.message);
}

export function diagnosticDisplayMessage(diagnostic: DiagnosticMessageLike): string {
  if (diagnostic.source === "verilator") {
    const unexpected = /^Unexpected token\s+(.+)$/i.exec(diagnostic.message);
    if (unexpected) return `遇到意外标记：${unexpected[1]}`;
    const syntaxUnexpected = /^syntax error,\s*unexpected\s+(.+)$/i.exec(diagnostic.message);
    if (syntaxUnexpected) return `语法错误：遇到意外标记 ${syntaxUnexpected[1]}`;
    const undefinedDirective = /^Define or directive not defined:\s*(.+)$/i.exec(diagnostic.message);
    if (undefinedDirective) return `宏／编译指令未定义：${undefinedDirective[1]}`;
    const width = verilatorWidthMessage(diagnostic.message);
    if (width) return width;
    return withQuotedDetails(diagnosticRuleLabel(diagnostic), diagnostic.message);
  }
  if (diagnostic.source === "ghdl") return ghdlDisplayMessage(diagnostic.message);
  return diagnostic.message;
}

export function isUnclassifiedDisplayMessage(message: string): boolean {
  return message.startsWith("未分类诊断") || message.startsWith("Verilator 未分类诊断");
}

function verilatorWidthMessage(message: string): string | undefined {
  if (/^Unsized numbers\/parameters not allowed in concatenations/i.test(message)) return "拼接中包含未指定位宽的数值或参数";
  if (/^Unsized numbers\/parameters not allowed in replications/i.test(message)) return "复制中包含未指定位宽的数值或参数";
  const unusedBits = /^Bits of signal are not used:\s*(.+)$/i.exec(message);
  if (unusedBits) return `部分信号位未使用：${unusedBits[1]}`;
  const operator = /^Operator\s+(\w+)\s+expects\s+(.+?)\s+on the\s+(.+?),\s+but\s+.+?'s\s+VARREF\s+'([^']+)'\s+generates\s+(.+)$/i.exec(message);
  if (operator) {
    const role = operandRole(operator[3]);
    return `${operator[1]}${role ? ` 的${role}` : ""}要求 ${widthText(operator[2])}，但 '${operator[4]}' 实际为 ${widthText(operator[5])}`;
  }
  const port = /^(Input|Output)\s+port connection\s+'([^']+)'\s+expects\s+(.+?)\s+on the\s+.+?,\s+but\s+.+?'s\s+VARREF\s+'([^']+)'\s+generates\s+(.+)$/i.exec(message);
  if (port) return `端口 '${port[2]}' 要求 ${widthText(port[3])}，但 '${port[4]}' 实际为 ${widthText(port[5])}`;
  const index = /^Bit extraction of\s+(.+?)\s+requires\s+(\d+)\s+bit index,\s+not\s+(\d+)\s+bits?/i.exec(message);
  if (index) return `${index[1]} 的索引要求 ${index[2]} 位，实际为 ${index[3]} 位`;
  const digits = /^Too many digits for\s+(\d+)\s+bit number:\s*(.+)$/i.exec(message);
  if (digits) return `${digits[1]} 位数值包含过多数字：${digits[2]}`;
  return undefined;
}

function operandRole(role: string): string {
  return ({ "assign rhs": "赋值右侧", "assign lhs": "赋值左侧", rhs: "右操作数", lhs: "左操作数", "pin connection": "端口连接", index: "索引" } as Record<string, string>)[role.toLowerCase()] ?? "";
}

function widthText(value: string): string {
  return value.replace(/(\d+)\s+bits?\b/g, "$1 位").replace(/\bor\b/g, "或").replace(/\.$/, "");
}

function ghdlDisplayMessage(message: string): string {
  const missingUnit = /unit\s+"([^"]+)"\s+not found in library\s+"([^"]+)"/i.exec(message);
  if (missingUnit) return `VHDL 库 "${missingUnit[2]}" 中未找到单元 "${missingUnit[1]}"`;
  if (/digit expected after exponent/i.test(message)) return "指数部分缺少数字";
  if (/literal beyond integer bounds/i.test(message)) return "整数字面量超出范围";
  if (/literal overflow/i.test(message)) return "字面量超出目标范围";
  if (/['"]==['"]\s+is not the vhdl equality/i.test(message)) return "VHDL 相等比较应使用 =，不是 ==";
  const missingLibrary = /cannot find resource library\s+"([^"]+)"/i.exec(message);
  if (missingLibrary) return `找不到资源库 "${missingLibrary[1]}"`;
  if (/missing entity, architecture, package or configuration/i.test(message)) return "缺少 VHDL 设计单元（实体／架构／包／配置）";
  const notAnalysed = /entity\s+"([^"]+)"\s+was not analysed/i.exec(message);
  if (notAnalysed) return `实体 "${notAnalysed[1]}" 尚未分析，请先处理前序错误`;
  const hiddenEntity = /declaration of\s+"([^"]+)"\s+hides entity\s+"([^"]+)"/i.exec(message);
  if (hiddenEntity) return `声明 "${hiddenEntity[1]}" 隐藏了实体 "${hiddenEntity[2]}"`;
  const missingToken = /missing\s+"([^"]+)"\s+at end of statement/i.exec(message);
  if (missingToken) return `语句末尾缺少 "${missingToken[1]}"`;
  if (/missing choice\(s\)/i.test(message)) return "case 分支未覆盖全部可能取值";
  const noDeclaration = /no declaration for\s+"([^"]+)"/i.exec(message);
  if (noDeclaration) return `未找到 "${noDeclaration[1]}" 的声明`;
  const typeMismatch = /can't match\s+.+?\s+with type\s+(.+)$/i.exec(message);
  if (typeMismatch) return `值与类型 ${typeMismatch[1]} 不匹配`;
  const invalidAssignment = /port\s+"([^"]+)"\s+can't be assigned/i.exec(message);
  if (invalidAssignment) return `端口 "${invalidAssignment[1]}" 不可赋值`;
  const duplicate = /identifier\s+"([^"]+)"\s+already used for a declaration/i.exec(message);
  if (duplicate) return `标识符 "${duplicate[1]}" 已被其他声明使用`;
  const previous = /previous declaration:\s*(\w+)\s+"([^"]+)"/i.exec(message);
  if (previous) return `此前声明：${declarationKind(previous[1])} "${previous[2]}"`;
  return withQuotedDetails("未分类诊断（悬停查看原文）", message);
}

function declarationKind(kind: string): string {
  return ({ signal: "信号", variable: "变量", constant: "常量", port: "端口", generic: "参数", type: "类型", function: "函数", procedure: "过程" } as Record<string, string>)[kind.toLowerCase()] ?? kind;
}

function withQuotedDetails(label: string, message: string): string {
  const details = [...message.matchAll(/'[^']+'|"[^"]+"/g)].map(match => match[0]).filter((detail, index, all) => all.indexOf(detail) === index);
  return details.length ? `${label}：${details.join("、")}` : label;
}

function diagnosticRuleLabel(diagnostic: DiagnosticMessageLike): string {
  if (diagnostic.source === "verilator") {
    const label = VERILATOR_RULE_LABELS[diagnostic.ruleId.replace(/^VERILATOR-/, "")];
    if (label) return label;
    if (/cannot find file containing|undefined module|module not found/i.test(diagnostic.message)) return "缺少模块定义";
    if (/include file.*not found|cannot open.*include|CANNOTOPEN|INCLUDE/i.test(diagnostic.message)) return "include 文件缺失";
    if (/top-level module|TOPLEVEL/i.test(diagnostic.message)) return "无法确定顶层";
    if (/cannot find.*(?:library|package)/i.test(diagnostic.message)) return "VHDL 库／包缺失";
    return "Verilator 未分类诊断（悬停查看原文）";
  }
  if (diagnostic.source === "ghdl") return ghdlDisplayMessage(diagnostic.message);
  return diagnostic.message;
}
