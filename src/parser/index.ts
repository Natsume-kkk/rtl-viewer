import type { ModuleInfo } from "./types";
import { parseVerilog } from "./verilog";
import { parseVhdl } from "./vhdl";

export type HdlLang = "verilog" | "vhdl";

export function detectLang(file: string): HdlLang | null {
  const ext = file.toLowerCase().split(".").pop();
  if (ext === "v" || ext === "sv" || ext === "vh" || ext === "svh") return "verilog";
  if (ext === "vhd" || ext === "vhdl") return "vhdl";
  return null;
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

/** 第三级：在完整解析基础上额外提取例化端口连接与收尾行。用于信号链分析。 */
export function parseFileDetail(src: string, file: string): ModuleInfo[] {
  const lang = detectLang(file);
  if (lang === "verilog") return parseVerilog(src, file, true, true);
  if (lang === "vhdl") return parseVhdl(src, file, true, true);
  return [];
}

export * from "./types";
export { parseXci } from "./xci";
