import type { DefinitionRef, ModuleInfo } from "./types";
import { parseVerilog, scanVerilogDefinitions } from "./verilog";
import { parseVhdl, scanVhdlDefinitions } from "./vhdl";

export type HdlLang = "verilog" | "vhdl";

export function detectLang(file: string): HdlLang | null {
  const ext = file.toLowerCase().split(".").pop();
  if (ext === "v" || ext === "sv" || ext === "vh" || ext === "svh") return "verilog";
  if (ext === "vhd" || ext === "vhdl") return "vhdl";
  return null;
}

/** 第一级：只提取模块定义名（最小代价）。 */
export function scanDefinitions(src: string, file: string): DefinitionRef[] {
  const lang = detectLang(file);
  if (lang === "verilog") return scanVerilogDefinitions(src);
  if (lang === "vhdl") return scanVhdlDefinitions(src);
  return [];
}

/** 第一级结构扫描：模块定义 + 例化边，跳过端口提取。用于建树。 */
export function scanStructure(src: string, file: string): ModuleInfo[] {
  return parseFile(src, file, false);
}

/** 第二级：完整解析模块、端口、例化。用于编辑器与端口面板。 */
export function parseFile(src: string, file: string, withPorts = true): ModuleInfo[] {
  const lang = detectLang(file);
  if (lang === "verilog") return parseVerilog(src, file, withPorts);
  if (lang === "vhdl") return parseVhdl(src, file, withPorts);
  return [];
}

export * from "./types";
export { parseXci } from "./xci";
