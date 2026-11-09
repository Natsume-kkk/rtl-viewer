import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collect, parseArgs, syntaxOptions } from "../scripts/rtl-lint";
import { decodeNodeSource } from "../src/app/node-source";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it("CLI 与桌面扫描规则一致排除 EDA 生成目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-cli-scan-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "good.v"), "module good; endmodule\n");
  for (const directory of ["build.cache", "build.hw", "build.runs", "build.sim", "build.gen", "build.ip_user_files"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, "generated.v"), "module generated; endmodule\n");
  }
  expect(collect(root)).toEqual([path.join(root, "good.v")]);
});

it("Node 磁盘读取使用严格 UTF-8 和 GBK 兜底", () => {
  expect(decodeNodeSource(Buffer.from([0x6d, 0x6f, 0x64, 0x75, 0x6c, 0x65, 0x20, 0x2f, 0x2f, 0x20, 0xd6, 0xd0]))).toBe("module // 中");
  expect(() => decodeNodeSource(Buffer.from([0x81, 0x30]))).toThrow();
});

it("CLI 未显式传入路径时扫描 root 而不是当前目录", () => {
  expect(parseArgs(["--root", "D:/project", "--no-external"]).paths).toEqual(["D:/project"]);
  expect(parseArgs(["--root", "D:/project", "src/top.v"]).paths).toEqual(["src/top.v"]);
});

it("CLI 相对 include 和 library 按 root 解析", () => {
  const options = syntaxOptions(parseArgs(["--root", "D:/project", "--include", "inc", "--include", "D:/shared", "--library", "vendor=lib/types.vhd"]));
  expect(options.includeDirs).toEqual([path.resolve("D:/project", "inc"), path.resolve("D:/shared")]);
  expect(options.vhdlLibraries).toEqual([{ library: "vendor", file: path.resolve("D:/project", "lib/types.vhd") }]);
});
