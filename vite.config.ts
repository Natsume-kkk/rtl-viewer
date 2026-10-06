import { defineConfig, type Plugin } from "vite";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 仅开发模式：E2E 文件服务，供 src/e2e-mock.ts 的 IPC mock 使用。
 * 解码策略与 Rust 端 read_file 一致（BOM → 严格 UTF-8 → GBK 兜底）。
 * 写出仅支持 utf8/utf8-bom（GBK 写回由 Rust 侧 cargo test 覆盖）。
 */
function e2eFsPlugin(): Plugin {
  const SKIP_DIRS = new Set(["node_modules", "target", "dist"]);
  // 与 Rust 端 GENERATED_DIR_SUFFIXES 一致：EDA 生成目录不扫描
  const GENERATED_DIR_SUFFIXES = [".runs", ".sim", ".cache", ".hw", ".gen", ".ip_user_files"];
  const HDL_RE = /\.(v|sv|vh|svh|vhd|vhdl)$/i;

  function walk(dir: string, out: { hdl: string[]; xci: string[]; con: string[] }): void {
    for (const name of readdirSync(dir)) {
      if (
        name.startsWith(".") ||
        SKIP_DIRS.has(name) ||
        GENERATED_DIR_SUFFIXES.some((s) => name.endsWith(s))
      )
        continue;
      const p = join(dir, name).replace(/\\/g, "/");
      if (statSync(p).isDirectory()) {
        walk(p, out);
      } else if (HDL_RE.test(name)) {
        out.hdl.push(p);
      } else if (/\.xci$/i.test(name)) {
        out.xci.push(p);
      } else if (/\.(xdc|sdc)$/i.test(name)) {
        out.con.push(p);
      }
    }
  }

  function decode(buf: Buffer): { content: string; encoding: string } {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return { content: buf.subarray(3).toString("utf8"), encoding: "utf8-bom" };
    }
    try {
      return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf8" };
    } catch {
      return { content: new TextDecoder("gbk").decode(buf), encoding: "gbk" };
    }
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
            const label = forced === "gbk" ? "gbk" : "utf-8";
            json(res, { content: new TextDecoder(label).decode(buf), encoding: forced, mtime });
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
