import { expect, it } from "vitest";
import { diagnosticDisplayMessage, diagnosticGroupMessage, diagnosticHoverMessage, explainVerilatorSyntax, isUnclassifiedDisplayMessage } from "../src/app/diagnostic-display";
import type { SyntaxDiagnostic } from "../src/ipc";

function display(source: string, ruleId: string, message: string): string {
  return diagnosticDisplayMessage({ source, ruleId, message });
}

it.each([
  ["VERILATOR-PINNOTFOUND", "Parameter not found: 'BAD_WIDTH'", "参数未找到：'BAD_WIDTH'"],
  ["VERILATOR-PINNOTFOUND", "Parameter pin not found: 'BAD_WIDTH'", "参数未找到：'BAD_WIDTH'"],
  ["VERILATOR-PINNOTFOUND", "Pin not found: 'bad_data'", "端口未找到：'bad_data'"],
  ["VERILATOR-GENERAL", "Instance of module must be named", "模块例化缺少实例名"],
  ["VERILATOR-GENERAL", "Can't find definition of variable: 'nonexistent'", "未找到变量 'nonexistent' 的定义"],
  ["VERILATOR-FUTURE", "Can't resolve RHS's object 'signal_name'", "Verilator 未分类诊断（悬停查看原文）：'signal_name'"],
  ["VERILATOR-FUTURE", "Unknown constant '8'hff'", "Verilator 未分类诊断（悬停查看原文）：'8'hff'"],
  ["VERILATOR-WIDTHTRUNC", "Operator ASSIGNW expects 4 bits on the Assign RHS, but Assign RHS's CONST '8'hff' generates 8 bits.", "ASSIGNW 的赋值右侧要求 4 位，但常量 '8'hff' 实际为 8 位"],
  ["VERILATOR-WIDTHTRUNC", "Operator ASSIGNW expects 4 bits on the Assign RHS, but Assign RHS's REPLICATE generates 12 bits.", "ASSIGNW 的赋值右侧要求 4 位，但拼接／复制表达式实际为 12 位"],
  ["VERILATOR-WIDTHEXPAND", "Input port connection 'data' expects 8 bits on the pin connection, but pin connection's CONST '4'hf' generates 4 bits.", "端口 'data' 要求 8 位，但常量 '4'hf' 实际为 4 位"],
  ["VERILATOR-SELRANGE", "Selection index out of range: 9:9 outside 7:0", "选择索引 9:9 超出声明范围 7:0"],
  ["VERILATOR-SELRANGE", "Selection index out of range: -1:-1 outside 7:0.", "选择索引 -1:-1 超出声明范围 7:0"],
  ["VERILATOR-WIDTHEXPAND", "Operator COND expects 8 bits on the Conditional False, but Conditional False's ADD generates 4 bits.", "COND 要求 8 位，但表达式实际为 4 位"],
])("Verilator 真实消息保留原因、标识和数值：%s %s", (ruleId, message, expected) => {
  expect(display("verilator", ruleId, message)).toBe(expected);
  expect(diagnosticHoverMessage({ source: "verilator", ruleId, message })).toBe(`${expected}\n原始诊断：${message}`);
});

it.each([
  ["error: missing \";\" at end of object declaration", "声明末尾缺少 \";\""],
  ["error: missing \";\" at end of signal declaration", "声明末尾缺少 \";\""],
  ["error: missing \";\" at end of statement", "语句末尾缺少 \";\""],
])("GHDL 缺分号区分声明与语句：%s", (message, expected) => {
  expect(display("ghdl", "GHDL", message)).toBe(expected);
  expect(diagnosticHoverMessage({ source: "ghdl", ruleId: "GHDL", message })).toContain(message);
});

it("多个通用诊断的组标题使用中性类别，内置与单条提示保留原因", () => {
  const variable = { source: "verilator", ruleId: "VERILATOR-GENERAL", message: "Can't find definition of variable: 'nonexistent'" };
  expect(diagnosticGroupMessage([variable])).toBe("未找到变量 'nonexistent' 的定义");
  expect(diagnosticGroupMessage([variable, { ...variable, message: "Instance of module must be named" }])).toBe("Verilator 语法与语义诊断");
  expect(diagnosticGroupMessage([{ ...variable, source: "ghdl", ruleId: "GHDL" }, { ...variable, source: "ghdl", ruleId: "GHDL" }])).toBe("GHDL 语法与语义诊断");
  expect(diagnosticGroupMessage([{ ...variable, ruleId: "VERILATOR-PINNOTFOUND" }, { ...variable, ruleId: "VERILATOR-PINNOTFOUND" }])).toBe("端口／参数未找到");
  expect(diagnosticHoverMessage({ source: "builtin", ruleId: "RULE", message: "中文提示" })).toBe("中文提示");
  expect(diagnosticGroupMessage([])).toBe("");
});

it.each([
  "child #(.WIDTH(8))  (.data(signal));",
  "child #(8)\n  (.data(signal));",
  "child #(\n  .WIDTH(fn(4, (2 + 2))) // parameter\n) /* instance */ (.data(signal));",
])("参数覆盖后缺少实例名显示具体原因：%s", source => {
  const offset = source.lastIndexOf("(.data");
  const prefix = source.slice(0, offset).split("\n");
  const diagnostic: SyntaxDiagnostic = {
    source: "verilator", ruleId: "VERILATOR-GENERAL", severity: "error", file: "top.sv",
    line: prefix.length, column: prefix.at(-1)!.length + 1, message: "syntax error, unexpected '('",
  };
  explainVerilatorSyntax([diagnostic], () => `module top;\n${source}\nendmodule`);
  expect(diagnostic.syntaxKind).toBeUndefined(); // 错位的源码上下文不能用于推断。
  diagnostic.line++;
  explainVerilatorSyntax([diagnostic], () => `module top;\n${source}\nendmodule`);
  expect(diagnosticDisplayMessage(diagnostic)).toBe("模块例化缺少实例名：请在参数列表 #(...) 与端口列表之间填写实例名。");
  expect(diagnostic.message).toBe("syntax error, unexpected '('");
  expect(diagnostic.ruleId).toBe("VERILATOR-GENERAL");
  expect(diagnostic.severity).toBe("error");
});

it.each([
  "child #(.WIDTH(8)) u_child (.data(signal));",
  "module child #(parameter WIDTH = 8) (.data(signal));",
  "and #(8) (.data(signal));",
  "nmos #(8) (.data(signal));",
  "// child #(.WIDTH(8)) (.data(signal));",
  "child #(.WIDTH(8) (.data(signal));",
])("不把其他左括号错误推断为缺少实例名：%s", source => {
  const diagnostic: SyntaxDiagnostic = {
    source: "verilator", ruleId: "VERILATOR-GENERAL", severity: "error", file: "top.sv",
    line: 1, column: source.lastIndexOf("(.data") + 1, message: "syntax error, unexpected '('",
  };
  explainVerilatorSyntax([diagnostic], () => source);
  expect(diagnosticDisplayMessage(diagnostic)).toBe("语法错误：遇到意外标记 '('");
});

it("缺少源码时保留后端通用错误，同一文件的上下文只读取一次", () => {
  const diagnostic: SyntaxDiagnostic = {
    source: "verilator", ruleId: "VERILATOR-GENERAL", severity: "error", file: "top.sv",
    line: 1, column: 1, message: "syntax error, unexpected '('",
  };
  let reads = 0;
  explainVerilatorSyntax([diagnostic, { ...diagnostic }], () => { reads++; return undefined; });
  expect(reads).toBe(1);
  expect(diagnostic.syntaxKind).toBeUndefined();
});

it.each([
  ["error: digit expected after exponent", "指数部分缺少数字"],
  ["error: '==' is not the vhdl equality, replaced by '='", "VHDL 相等比较应使用 =，不是 =="],
  ["error: literal overflow", "字面量超出目标范围"],
  ["error: literal beyond integer bounds", "整数字面量超出范围"],
  ["error: cannot find resource library \"unisim\"", "找不到资源库 \"unisim\""],
  ["error: missing entity, architecture, package or configuration", "缺少 VHDL 设计单元（实体／架构／包／配置）"],
  ["error: entity \"DSP_mux_tb\" was not analysed", "实体 \"DSP_mux_tb\" 尚未分析，请先处理前序错误"],
  ["warning: declaration of \"CLK_74\" hides entity \"clk_74\" [-Whide]", "声明 \"CLK_74\" 隐藏了实体 \"clk_74\""],
])("GHDL 真实消息显示具体中文原因：%s", (message, expected) => {
  expect(display("ghdl", "GHDL", message)).toBe(expected);
});

it("Verilator 语法错误、未定义宏和加密段不再落入未分类", () => {
  expect(display("verilator", "VERILATOR-GENERAL", "syntax error, unexpected bit")).toBe("语法错误：遇到意外标记 bit");
  expect(display("verilator", "VERILATOR-GENERAL", "syntax error, unexpected ']'")).toBe("语法错误：遇到意外标记 ']'");
  expect(display("verilator", "VERILATOR-GENERAL", "Define or directive not defined: '`BD_WRAPPER'")).toBe("宏／编译指令未定义：'`BD_WRAPPER'");
  expect(display("verilator", "VERILATOR-PROTECTED", "A '`pragma protected data_block' encrypted section was detected and will be skipped.")).toBe("已跳过加密保护代码段：'`pragma protected data_block'");
});

it("Verilator 位宽、拼接和未使用信号显示完整中文细节", () => {
  expect(display("verilator", "VERILATOR-WIDTHCONCAT", "Unsized numbers/parameters not allowed in concatenations.")).toBe("拼接中包含未指定位宽的数值或参数");
  expect(display("verilator", "VERILATOR-WIDTHCONCAT", "Unsized numbers/parameters not allowed in replications.")).toBe("复制中包含未指定位宽的数值或参数");
  expect(display("verilator", "VERILATOR-WIDTHEXPAND", "Operator ASSIGNW expects 32 bits on the Assign RHS, but Assign RHS's VARREF 'din' generates 1 bits.")).toBe("ASSIGNW 的赋值右侧要求 32 位，但 'din' 实际为 1 位");
  expect(display("verilator", "VERILATOR-WIDTHTRUNC", "Operator ASSIGNW expects 1 bits on the Assign RHS, but Assign RHS's VARREF 'din' generates 32 bits.")).toBe("ASSIGNW 的赋值右侧要求 1 位，但 'din' 实际为 32 位");
  expect(display("verilator", "VERILATOR-WIDTHEXPAND", "Input port connection 'clk' expects 8192 bits on the pin connection, but pin connection's VARREF 'clk' generates 1 bits.")).toBe("端口 'clk' 要求 8192 位，但 'clk' 实际为 1 位");
  expect(display("verilator", "VERILATOR-WIDTHEXPAND", "Bit extraction of array[4:0] requires 3 bit index, not 2 bits.")).toBe("array[4:0] 的索引要求 3 位，实际为 2 位");
  expect(display("verilator", "VERILATOR-WIDTHDIGITS", "Too many digits for 4 bit number: '4'hDF")).toBe("4 位数值包含过多数字：'4'hDF");
  expect(display("verilator", "VERILATOR-UNUSEDSIGNAL", "Bits of signal are not used: 'din'[31:1]")).toBe("部分信号位未使用：'din'[31:1]");
  expect(display("verilator", "VERILATOR-UNUSEDSIGNAL", "Signal is not used: 'din'")).toBe("信号未使用：'din'");
});

it("真正未知的消息明确提示悬停查看原文并保留可识别标记", () => {
  const unknown = display("verilator", "VERILATOR-FUTURE", "Future backend failure without quotes");
  expect(unknown).toBe("Verilator 未分类诊断（悬停查看原文）");
  expect(isUnclassifiedDisplayMessage(unknown)).toBe(true);
  expect(isUnclassifiedDisplayMessage(display("ghdl", "GHDL", "Future GHDL failure \"detail\""))).toBe(true);
  expect(isUnclassifiedDisplayMessage(display("verilator", "VERILATOR-PINMISSING", "Cell has missing pin: 'aclen'"))).toBe(false);
});
