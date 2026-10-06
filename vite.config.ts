import { defineConfig, type Plugin } from "vite";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { decode, decodeAs, walk } from "./tests/helpers/fs-scan";

/**
 * 仅开发模式：E2E 文件服务，供 src/e2e-mock.ts 的 IPC mock 使用。
 * 扫描与解码规则走 tests/helpers/fs-scan.ts（逐条对齐 Rust 端，单一来源）。
 * 写出仅支持 utf8/utf8-bom（GBK/UTF-16 写回由 Rust 侧 cargo test 覆盖）。
 */
function e2eFsPlugin(): Plugin {
  function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  }

  return {
    name: "e2e-fs",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__e2e_scan", (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = url.searchParams.get("path") ?? "";
          const out = { hdl: [] as string[], xci: [] as string[], con: [] as string[] };
          walk(root, out);
          out.hdl.sort();
          out.xci.sort();
          out.con.sort();
          json(res, out);
        } catch (e) {
          json(res, { error: String(e) }, 500);
        }
      });
      server.middlewares.use("/__e2e_fs", (req, res) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const path = url.searchParams.get("path") ?? "";
        if (req.method === "PUT") {
          const encoding = url.searchParams.get("encoding") ?? "utf8";
          if (encoding !== "utf8" && encoding !== "utf8-bom") {
            json(res, { error: `e2e fs: unsupported write encoding ${encoding}` }, 400);
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const bytes =
              encoding === "utf8-bom"
                ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])
                : Buffer.from(text, "utf8");
            writeFileSync(path, bytes);
            json(res, Math.round(statSync(path).mtimeMs));
          });
          return;
        }
        try {
          const forced = url.searchParams.get("encoding");
          const buf = readFileSync(path);
          const mtime = Math.round(statSync(path).mtimeMs);
          if (forced && forced !== "null") {
            json(res, { ...decodeAs(buf, forced), mtime });
          } else {
            json(res, { ...decode(buf), mtime });
          }
        } catch (e) {
          json(res, { error: String(e) }, 500);
        }
      });
      server.middlewares.use("/__e2e_stat", (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const paths = JSON.parse(Buffer.concat(chunks).toString("utf8")) as string[];
            const states = paths.map((p) => {
              try {
                return Math.round(statSync(p).mtimeMs);
              } catch {
                return null;
              }
            });
            json(res, states);
          } catch (e) {
            json(res, { error: String(e) }, 500);
          }
        });
      });
      server.middlewares.use("/__e2e_exists", (req, res) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const path = url.searchParams.get("path") ?? "";
        try {
          statSync(path);
          json(res, true);
        } catch {
          json(res, false);
        }
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [e2eFsPlugin()],
  server: {
    port: 1420,
    strictPort: true,
    headers: {
      // 与 src-tauri/tauri.conf.json 的 csp 保持同步（dev 额外放行 HMR websocket），
      // 使浏览器 dev/e2e 环境与生产 webview 的 CSP 行为一致，问题提前暴露。
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; " +
        "connect-src 'self' ws://localhost:1420; object-src 'none'; base-uri 'none'",
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
