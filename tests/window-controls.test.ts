// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { attachWindowControls } from "../src/ui/window-controls";

it("窗口按钮调用宿主，最大化状态同步，取消关闭与重复请求均保留窗口", async () => {
  const root = document.createElement("div"); root.innerHTML = '<button id="window-minimize"></button><button id="window-maximize"></button><button id="window-close"></button>';
  let maximized = false;
  let onClose: (e: { preventDefault(): void }) => Promise<void> = async () => {};
  const unclose = vi.fn(), unresize = vi.fn();
  const host = {
    minimize: vi.fn(async () => {}), close: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => { maximized = !maximized; }), isMaximized: vi.fn(async () => maximized),
    onCloseRequested: vi.fn(async handler => { onClose = handler; return unclose; }),
    onResized: vi.fn(async () => unresize),
  };
  let resolve!: (answer: boolean) => void;
  const confirm = vi.fn(() => new Promise<boolean>(r => { resolve = r; }));
  const error = vi.fn();
  const dispose = await attachWindowControls(root, host as unknown as Parameters<typeof attachWindowControls>[1], confirm, error);
  root.querySelector<HTMLButtonElement>("#window-minimize")!.click(); expect(host.minimize).toHaveBeenCalledOnce();
  root.querySelector<HTMLButtonElement>("#window-maximize")!.click(); await vi.waitFor(() => expect(root.querySelector("#window-maximize")?.getAttribute("aria-label")).toBe("还原窗口"));
  root.querySelector<HTMLButtonElement>("#window-close")!.click(); expect(host.close).toHaveBeenCalledOnce();
  const first = { preventDefault: vi.fn() }, repeated = { preventDefault: vi.fn() };
  const pending = onClose(first); await onClose(repeated); expect(repeated.preventDefault).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
  resolve(false); await pending; expect(first.preventDefault).toHaveBeenCalledOnce();
  const allowed = { preventDefault: vi.fn() }; const next = onClose(allowed); resolve(true); await next; expect(allowed.preventDefault).not.toHaveBeenCalled();
  dispose(); expect(unclose).toHaveBeenCalledOnce(); expect(unresize).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled();
});

it("关闭确认异常阻止关闭，不吞掉失败", async () => {
  const root = document.createElement("div"); root.innerHTML = '<button id="window-minimize"></button><button id="window-maximize"></button><button id="window-close"></button>';
  let close!: (e: { preventDefault(): void }) => Promise<void>;
  const host = { isMaximized: async () => false, onResized: async () => vi.fn(), onCloseRequested: async (handler: typeof close) => { close = handler; return vi.fn(); } };
  const error = vi.fn(), preventDefault = vi.fn();
  const dispose = await attachWindowControls(root, host as unknown as Parameters<typeof attachWindowControls>[1], async () => { throw new Error("failed"); }, error);
  await close({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledWith(expect.stringContaining("failed")); dispose();
});
