import { afterAll, beforeAll, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import config, { e2eFsPlugin } from "../vite.config";

let server: ViteDevServer;
let root: string;
let base: string;

beforeAll(async () => {
  mkdirSync(".tmp", { recursive: true });
  root = mkdtempSync(resolve(".tmp/e2e fs-"));
  cpSync("tests/samples/basic", root, { recursive: true });
  server = await createServer({
    configFile: false, plugins: [e2eFsPlugin(root)], logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  try { await server?.close(); }
  finally { if (root) rmSync(root, { recursive: true, force: true }); }
});

it("配置与扫描共用实际根目录，含空格路径可读写隔离副本", async () => {
  expect(await (await fetch(`${base}/__e2e_config`)).json()).toEqual({ root: realpathSync(root).replace(/\\/g, "/") });
  const scan = await (await fetch(`${base}/__e2e_scan?path=${encodeURIComponent(root)}`)).json();
  expect(scan.hdl).toHaveLength(3);
  const path = join(root, "e2e-out.v");
  const response = await fetch(`${base}/__e2e_fs?path=${encodeURIComponent(path)}`, { method: "PUT", body: "module saved; endmodule" });
  expect(response.ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("module saved; endmodule");
});

it("新增配置接口保留同源约束，文件服务仍拒绝越界读取", async () => {
  expect((await fetch(`${base}/__e2e_config`, { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
  expect((await fetch(`${base}/__e2e_fs?path=${encodeURIComponent(resolve("package.json"))}`)).status).toBe(403);
});

it("生产构建不读取 E2E 根目录，默认开发不启用文件服务", async () => {
  const { vi } = await import("vitest");
  try {
    vi.stubEnv("RTL_VIEWER_E2E_ROOT", "missing-fixture-path");
    expect(typeof config).toBe("function");
    if (typeof config !== "function") throw new Error("expected config factory");
    expect((await config({ command: "build", mode: "production" })).plugins).toEqual([]);
    vi.stubEnv("RTL_VIEWER_E2E_ROOT", "");
    expect((await config({ command: "serve", mode: "development" })).plugins).toEqual([]);
    expect(() => e2eFsPlugin("package.json")).toThrow("must be a directory");
  } finally { vi.unstubAllEnvs(); }
});
