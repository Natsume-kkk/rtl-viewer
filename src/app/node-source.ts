import fs from "node:fs";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const strictGbk = new TextDecoder("gbk", { fatal: true });

export function readNodeSource(file: string): string {
  return decodeNodeSource(fs.readFileSync(file));
}

function startsWith(bytes: Buffer, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

export function decodeNodeSource(bytes: Buffer): string {
  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) || startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    throw new Error("暂不支持 UTF-32，请先转换为 UTF-8 或 UTF-16");
  }
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  const bom = startsWith(bytes, [0xef, 0xbb, 0xbf]);
  const body = bom ? bytes.subarray(3) : bytes;
  try {
    return strictUtf8.decode(body);
  } catch {
    return strictGbk.decode(body);
  }
}
