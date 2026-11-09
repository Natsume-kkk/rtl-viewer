import { expect, it } from "vitest";
import { diagnosticDisplayMessage, isUnclassifiedDisplayMessage } from "../src/app/diagnostic-display";

function display(source: string, ruleId: string, message: string): string {
  return diagnosticDisplayMessage({ source, ruleId, message });
}

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
});

it("真正未知的消息明确提示悬停查看原文并保留可识别标记", () => {
  const unknown = display("verilator", "VERILATOR-FUTURE", "Future backend failure without quotes");
  expect(unknown).toBe("Verilator 未分类诊断（悬停查看原文）");
  expect(isUnclassifiedDisplayMessage(unknown)).toBe(true);
  expect(isUnclassifiedDisplayMessage(display("ghdl", "GHDL", "Future GHDL failure \"detail\""))).toBe(true);
  expect(isUnclassifiedDisplayMessage(display("verilator", "VERILATOR-PINMISSING", "Cell has missing pin: 'aclen'"))).toBe(false);
});
