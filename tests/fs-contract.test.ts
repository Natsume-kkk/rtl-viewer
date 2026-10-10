import { describe, expect, it } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode, decodeAs, walk, SKIP_DIRS, GENERATED_DIR_SUFFIXES } from "./helpers/fs-scan";

describe("开发夹具与 Rust 文件契约", () => {
  it("扫描过滤常量与 Rust 一致，普通 sim 和 ISE 包装目录仍保留", () => {
    const rust = readFileSync("src-tauri/src/main.rs", "utf8");
    const names = (key: string) => [...new RegExp(`const ${key}:.*?= &\\[([^\\]]+)\\]`).exec(rust)![1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect([...SKIP_DIRS]).toEqual(names("SKIP_DIRS"));
    expect(GENERATED_DIR_SUFFIXES).toEqual(names("GENERATED_DIR_SUFFIXES"));
    const tempDir = join(process.cwd(), ".tmp");
    mkdirSync(tempDir, { recursive: true });
    const root = mkdtempSync(join(tempDir, "fs-contract-"));
    try {
      for (const folder of ["rtl", "sim", "ipcore_dir", ...SKIP_DIRS, ...GENERATED_DIR_SUFFIXES.map(s => `p${s}`), ".hidden"]) {
        mkdirSync(join(root, folder), { recursive: true }); writeFileSync(join(root, folder, "top.v"), "");
      }
      const out = { hdl: [] as string[], xci: [] as string[], con: [] as string[] }; walk(root, out);
      expect(out.hdl.map(p => p.slice(p.lastIndexOf("/", p.length - 7) + 1)).sort()).toEqual(["ipcore_dir/top.v", "rtl/top.v", "sim/top.v"].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("有效 UTF-16 保持内容，损坏 UTF-16/GBK 与 UTF-32 明确拒绝", () => {
    expect(decode(Buffer.from([0xff, 0xfe, 0x61, 0]))).toEqual({ content: "a", encoding: "utf16le" });
    for (const bytes of [[0xff, 0xfe, 0, 0xd8], [0xff, 0xfe, 0x61], [0x81], [0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]]) expect(() => decode(Buffer.from(bytes))).toThrow();
    expect(() => decodeAs(Buffer.from([0x81]), "gbk")).toThrow();
    expect(() => decodeAs(Buffer.from([0, 0xd8]), "utf16le")).toThrow();
  });
});
