import { defineConfig, type Plugin } from "vite";
import { readFileSync, statSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { decode, decodeAs, walk } from "./tests/helpers/fs-scan";

/**
 * 仅开发模式：E2E 文件服务，供 src/e2e-mock.ts 的 IPC mock 使用。
 * 扫描与解码规则走 tests/helpers/fs-scan.ts（逐条对齐 Rust 端，单一来源）。
 * 写出仅支持 utf8/utf8-bom（GBK/UTF-16 写回由 Rust 侧 cargo test 覆盖）。
 */
function e2eFsPlugin(rootPath: string): Plugin {
  const root = realpathSync(rootPath);
  function scopedPath(path: string): string {
    if (!path || !isAbsolute(path)) throw new Error("e2e fs: absolute path required");
    const candidate = existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), path.split(/[\\/]/).pop()!);
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("e2e fs: path outside configured root");
    return candidate;
  }
  function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  }

  return {
    name: "e2e-fs",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/__e2e_") && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
          json(res, { error: "e2e fs: cross-origin request rejected" }, 403);
          return;
        }
        next();
      });
      server.middlewares.use("/__e2e_scan", (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://localhost");
          const root = scopedPath(url.searchParams.get("path") ?? "");
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
        let path: string;
        try { path = scopedPath(url.searchParams.get("path") ?? ""); }
        catch (e) { json(res, { error: String(e) }, 403); return; }
        if (req.method === "PUT") {
          const encoding = url.searchParams.get("encoding") ?? "utf8";
          if (encoding !== "utf8" && encoding !== "utf8-bom") {
            json(res, { error: `e2e fs: unsupported write encoding ${encoding}` }, 400);
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              const bytes =
                encoding === "utf8-bom"
                  ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])
                  : Buffer.from(text, "utf8");
              writeFileSync(scopedPath(path), bytes);
              json(res, Math.round(statSync(path).mtimeMs));
            } catch (e) { json(res, { error: String(e) }, 500); }
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
            if (!Array.isArray(paths) || paths.some(p => typeof p !== "string")) throw new Error("e2e fs: invalid paths");
            const states = paths.map((p) => {
              const path = scopedPath(p);
              try {
                const meta = statSync(path);
                if (!meta.isFile()) throw new Error("e2e fs: not a file");
                return Math.round(meta.mtimeMs);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
        try {
          const path = scopedPath(url.searchParams.get("path") ?? "");
          statSync(path);
          json(res, true);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") json(res, false);
          else json(res, { error: String(e) }, 403);
        }
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: process.env.RTL_VIEWER_E2E_ROOT ? [e2eFsPlugin(process.env.RTL_VIEWER_E2E_ROOT)] : [],
  server: {
    watch: { ignored: ["**/.tmp/**", "**/src-tauri/target/**", "**/src-tauri/gen/**", "**/release/**"] },
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
