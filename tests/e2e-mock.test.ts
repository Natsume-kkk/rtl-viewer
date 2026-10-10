// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const internals = () => (window as unknown as {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
});

afterEach(() => {
  delete internals().__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("浏览器对话框使用开发服务返回的夹具根目录", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ root: "E:/isolated sample/project" }) });
  vi.stubGlobal("fetch", fetch);
  await import("../src/e2e-mock");
  expect(fetch).toHaveBeenCalledWith("/__e2e_config");
  const invoke = internals().__TAURI_INTERNALS__!.invoke;
  expect(await invoke("plugin:dialog|open", { options: { directory: true } })).toBe("E:/isolated sample/project");
  expect(await invoke("plugin:dialog|save")).toBe("E:/isolated sample/project/e2e-out.v");
});

it.each([null, {}, { root: "" }])("夹具配置无效时停止安装 mock：%j", async (config) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => config }));
  await expect(import("../src/e2e-mock")).rejects.toThrow("RTL_VIEWER_E2E_ROOT");
  expect(internals().__TAURI_INTERNALS__).toBeUndefined();
});

it("未启动开发文件服务时给出配置提示", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  await expect(import("../src/e2e-mock")).rejects.toThrow("RTL_VIEWER_E2E_ROOT");
});
