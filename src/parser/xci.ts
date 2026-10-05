import type { IpInfo } from "./types";

/** 解析 Vivado IP 配置（.xci）：实例名取文件名，VLNV 从 XML 提取。 */
export function parseXci(content: string, file: string): IpInfo {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  const name = base.replace(/\.xci$/i, "");
  const fields: Record<string, string> = {};
  const re = /<spirit:(vendor|library|name|version)>([^<]*)<\/spirit:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (!(m[1] in fields)) fields[m[1]] = m[2];
  }
  const parts = [fields.vendor, fields.library, fields.name, fields.version].filter(Boolean);
  return {
    name,
    file,
    vlnv: parts.length === 4 ? parts.join(":") : undefined,
  };
}
