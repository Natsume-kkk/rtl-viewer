import type { ScanResult } from "../ipc";
import { filePathKey } from "../file-path";

/** 只排除明确的网表文件名／导出命令头，不根据 LUT/FD 等原语猜测。 */
export function isGeneratedNetlist(file: string, content = ""): boolean {
  if (/(?:_funcsim|_timesim|_sim_netlist)\.(?:v|sv|vhd|vhdl)$/i.test(file)) return true;
  const header = content.slice(0, 16384).split(/\b(?:module|entity)\s+[A-Za-z_]\w*\b/)[0];
  return /^(?:\/\/|--)\s*Command\s*:\s*write_(?:verilog|vhdl)\b/im.test(header);
}

/** 首次扫描和目录增量使用同一份生成文件边界。 */
export function projectFiles(scan: ScanResult) {
  const ipDirs = scan.xci.map(file => { const key = filePathKey(file); return key.slice(0, key.lastIndexOf("/")) + "/"; });
  const isIpGenerated = (file: string) => {
    const key = filePathKey(file);
    return ipDirs.some(dir => key.startsWith(dir));
  };
  return { hdl: scan.hdl.filter(file => !isIpGenerated(file) && !isGeneratedNetlist(file)), con: scan.con.filter(file => !isIpGenerated(file)), isIpGenerated };
}
