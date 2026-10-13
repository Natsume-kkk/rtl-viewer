import type { ScanResult } from "../ipc";
import { filePathKey } from "../file-path";

/** 首次扫描和目录增量使用同一份 IP 生成目录边界。 */
export function projectFiles(scan: ScanResult) {
  const ipDirs = scan.xci.map(file => { const key = filePathKey(file); return key.slice(0, key.lastIndexOf("/")) + "/"; });
  const isIpGenerated = (file: string) => {
    const key = filePathKey(file);
    return ipDirs.some(dir => key.startsWith(dir));
  };
  return { hdl: scan.hdl.filter(file => !isIpGenerated(file)), con: scan.con.filter(file => !isIpGenerated(file)), isIpGenerated };
}
