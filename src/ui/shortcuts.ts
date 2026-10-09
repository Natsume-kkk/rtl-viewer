export interface AppShortcutActions {
  newFile(): void;
  openFile(): Promise<unknown>;
  openProject(): Promise<unknown>;
  save(): Promise<unknown>;
  saveAs(): Promise<unknown>;
  saveAll(): Promise<unknown>;
  close(): Promise<unknown>;
  closeAll(): Promise<unknown>;
  reload(): Promise<unknown>;
  cycleTab(delta: number): void;
  switchView(): void;
  recent(): void;
  search(): void;
  back(): void;
  forward(): void;
  error(error: unknown): void;
}

/** 应用命令先于 Monaco 分发；文件操作串行，弹窗和菜单不穿透。 */
export function registerAppShortcuts(actions: AppShortcutActions): () => void {
  let busy = false;
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.isComposing || document.querySelector(".choice-overlay")) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="menu"], .quick-input-widget')) return;
    const key = event.key.toLowerCase();
    let run: (() => unknown) | undefined;
    let fileOperation = false;
    if (event.ctrlKey && !event.altKey) {
      if (key === "n" && !event.shiftKey) run = actions.newFile;
      else if (key === "o" && !event.shiftKey) { run = actions.openFile; fileOperation = true; }
      else if (key === "s") { run = event.shiftKey ? actions.saveAll : actions.save; fileOperation = true; }
      else if (key === "w") { run = event.shiftKey ? actions.closeAll : actions.close; fileOperation = true; }
      else if (key === "r" && !event.shiftKey) { run = actions.reload; fileOperation = true; }
      else if (key === "tab") run = () => actions.cycleTab(event.shiftKey ? -1 : 1);
      else if (key === "pageup" && !event.shiftKey) run = () => actions.cycleTab(-1);
      else if (key === "pagedown" && !event.shiftKey) run = () => actions.cycleTab(1);
      else if (key === "f" && event.shiftKey) run = actions.search;
    } else if (event.ctrlKey && event.altKey && !event.shiftKey) {
      if (key === "s") { run = actions.saveAs; fileOperation = true; }
      else if (key === "o") { run = actions.openProject; fileOperation = true; }
      else if (key === "r") run = actions.recent;
    } else if (!event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (key === "f8") run = actions.switchView;
      else if (key === "f7") run = actions.search;
    } else if (event.altKey && !event.ctrlKey && !event.shiftKey) {
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]') && !target.closest(".monaco-editor");
      if (!typing && key === "arrowleft") run = actions.back;
      else if (!typing && key === "arrowright") run = actions.forward;
    }
    if (!run) return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || event.repeat && (fileOperation || key === "n")) return;
    if (fileOperation) busy = true;
    try {
      const result = run();
      if (fileOperation) void Promise.resolve(result).catch(actions.error).finally(() => { busy = false; });
    } catch (error) {
      busy = false;
      actions.error(error);
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
