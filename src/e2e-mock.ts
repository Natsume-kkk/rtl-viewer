/**
 * E2E 模式（URL 带 ?e2e）：在纯浏览器里 mock Tauri IPC，文件操作走 vite dev
 * 中间件 /__e2e_scan 与 /__e2e_fs，对话框固定返回 fixture 工程路径。
 * 仅用于自动化验收，生产构建不受影响（tauri 应用内不存在 ?e2e）。
 */
const FIXTURE = "D:/workspace/projects/rtl-viewer/.tmp/cp7-acceptance/project";

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const internals: TauriInternals = {
  async invoke(cmd, args = {}) {
    const path = typeof args.path === "string" ? args.path : "";
    switch (cmd) {
      case "scan_folder":
        return (await fetch(`/__e2e_scan?path=${encodeURIComponent(path)}`)).json();
      case "read_file": {
        const enc = typeof args.encoding === "string" ? args.encoding : "";
        const res = await fetch(
          `/__e2e_fs?path=${encodeURIComponent(path)}&encoding=${encodeURIComponent(enc)}`,
        );
        const body = await res.json();
        if (body?.error) throw new Error(body.error);
        return body;
      }
      case "write_file": {
        const enc = typeof args.encoding === "string" ? args.encoding : "utf8";
        const res = await fetch(
          `/__e2e_fs?path=${encodeURIComponent(path)}&encoding=${encodeURIComponent(enc)}`,
          { method: "PUT", body: String(args.content ?? "") },
        );
        const body = await res.json();
        if (body?.error) throw new Error(body.error);
        return body;
      }
      case "file_states": {
        const res = await fetch("/__e2e_stat", {
          method: "POST",
          body: JSON.stringify(args.paths ?? []),
        });
        return res.json();
      }
      case "path_exists":
        return (await fetch(`/__e2e_exists?path=${encodeURIComponent(path)}`)).json();
      case "is_directory":
        return true; // e2e 拖放测试固定用 fixture 目录
      case "show_in_folder":
        return null; // e2e 环境不起资源管理器
      // 对话框：选文件夹固定返回 fixture，另存为写到 fixture 下的输出文件
      case "plugin:dialog|open":
        return FIXTURE;
      case "plugin:dialog|save":
        return `${FIXTURE}/e2e-out.v`;
      case "plugin:dialog|confirm":
      case "plugin:dialog|message":
        return true;
      default:
        throw new Error(`e2e mock: unhandled command ${cmd}`);
    }
  },
};

(window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__ = internals;

export {};
