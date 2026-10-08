import { setIcon } from "./icons";
import type { Window } from "@tauri-apps/api/window";

type WindowHost = Pick<Window, "minimize" | "toggleMaximize" | "close" | "isMaximized" | "onResized" | "onCloseRequested">;

/** 自定义按钮与 Alt+F4 共用原生关闭请求，不先关标签，取消后完整保留编辑状态。 */
export async function attachWindowControls(root: HTMLElement, host: WindowHost, confirmClose: () => Promise<boolean>, reportError: (message: string) => void): Promise<() => void> {
  const minimize = root.querySelector<HTMLButtonElement>("#window-minimize")!;
  const maximize = root.querySelector<HTMLButtonElement>("#window-maximize")!;
  const close = root.querySelector<HTMLButtonElement>("#window-close")!;
  setIcon(minimize, "minimize"); setIcon(close, "close");
  let disposed = false, pendingClose = false;
  const run = (action: () => Promise<unknown>) => { void action().catch(error => reportError(`窗口操作失败：${String(error)}`)); };
  const refresh = async () => {
    const maximized = await host.isMaximized();
    if (disposed) return;
    setIcon(maximize, maximized ? "restore" : "maximize");
    maximize.title = maximized ? "还原窗口" : "最大化";
    maximize.setAttribute("aria-label", maximize.title);
    maximize.setAttribute("aria-pressed", String(maximized));
  };
  const unclose = await host.onCloseRequested(async event => {
    if (pendingClose) { event.preventDefault(); return; }
    pendingClose = true;
    try { if (!(await confirmClose())) event.preventDefault(); }
    catch (error) { event.preventDefault(); reportError(`无法确认关闭：${String(error)}`); }
    finally { pendingClose = false; }
  });
  const unresize = await host.onResized(() => run(refresh));
  minimize.onclick = () => run(() => host.minimize());
  maximize.onclick = () => run(async () => { await host.toggleMaximize(); await refresh(); });
  close.onclick = () => run(() => host.close());
  await refresh();
  root.hidden = false;
  return () => { disposed = true; unclose(); unresize(); minimize.onclick = maximize.onclick = close.onclick = null; };
}
