/**
 * 目录扫描与文件解码的共享实现，逐条对齐 Rust 端 scan_folder / decode / decode_as
 *（src-tauri/src/main.rs）。vite.config.ts 的 e2e 中间件与两个验收测试共用，
 * 规则变化时只需改这一处和 Rust 端，避免多份复制漂移。
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SKIP_DIRS = new Set(["node_modules", "target", "dist"]);
export const GENERATED_DIR_SUFFIXES = [".runs", ".sim", ".cache", ".hw", ".gen", ".ip_user_files"];
const HDL_RE = /\.(v|sv|vh|svh|vhd|vhdl)$/i;
/** 与 Rust MAX_WALK_DEPTH 一致：异常目录结构的兜底 */
const MAX_WALK_DEPTH = 64;

export interface ScanOut {
  hdl: string[];
  xci: string[];
  con: string[];
}

export function walk(dir: string, out: ScanOut, depth = 0): void {
  if (depth >= MAX_WALK_DEPTH) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // lstat：不跟随符号链接/junction（环状链接会无限递归）
    let meta;
    try {
      meta = lstatSync(p);
    } catch {
      continue;
    }
    if (meta.isSymbolicLink()) continue;
    if (meta.isDirectory()) {
      // 与 Rust 一致：三类过滤只作用于目录，文件按扩展名判定
      if (
        name.startsWith(".") ||
        SKIP_DIRS.has(name) ||
        GENERATED_DIR_SUFFIXES.some((s) => name.endsWith(s))
      )
        continue;
      walk(p, out, depth + 1);
      continue;
    }
    const norm = p.replace(/\\/g, "/");
    if (HDL_RE.test(name)) out.hdl.push(norm);
    else if (/\.xci$/i.test(name)) out.xci.push(norm);
    else if (/\.(xdc|sdc)$/i.test(name)) out.con.push(norm);
  }
}

/** 与 Rust decode 同策略：UTF-8 BOM（严格校验失败落 GBK）→ UTF-32 BOM 剥离 → UTF-16 BOM → 严格 UTF-8 → GBK 兜底。 */
export function decode(buf: Buffer): { content: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const body = buf.subarray(3);
    try {
      return { content: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf8-bom" };
    } catch {
      return { content: new TextDecoder("gbk").decode(body), encoding: "gbk" };
    }
  }
  // UTF-32 BOM 先于 UTF-16 嗅探（FF FE 00 00 会被 UTF-16LE 抢先命中）
  let body = buf;
  if (
    buf.length >= 4 &&
    ((buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) ||
      (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff))
  ) {
    body = buf.subarray(4);
  }
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    return { content: new TextDecoder("utf-16le").decode(body.subarray(2)), encoding: "utf16le" };
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    return { content: new TextDecoder("utf-16be").decode(body.subarray(2)), encoding: "utf16be" };
  }
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf8" };
  } catch {
    return { content: new TextDecoder("gbk").decode(body), encoding: "gbk" };
  }
}

/** 与 Rust decode_as 同策略：按指定编码重读，utf8 系严格校验失败报错而非兜底。 */
export function decodeAs(buf: Buffer, encoding: string): { content: string; encoding: string } {
  let skip = 0;
  if (encoding === "utf8-bom" && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    skip = 3;
  } else if (encoding === "utf16le" && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    skip = 2;
  } else if (encoding === "utf16be" && buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    skip = 2;
  }
  const body = buf.subarray(skip);
  if (encoding === "utf8" || encoding === "utf8-bom") {
    try {
      return { content: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding };
    } catch {
      throw new Error(`文件内容不是有效的 UTF-8: ${encoding}`);
    }
  }
  return { content: new TextDecoder(encoding).decode(body), encoding };
}
