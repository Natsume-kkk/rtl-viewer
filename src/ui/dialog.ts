/**
 * 模态选择对话框：消息 + 若干按钮，返回点击的按钮下标；Esc/遮罩点击返回 -1。
 * 用于「磁盘已被外部修改」这类三选场景。
 * appConfirm/appAlert 是其两键/单键封装，替代 Tauri 原生 confirm（原生弹窗
 * 跟随系统主题且 warning 级会播放系统提示音，应用内弹窗则静默并贴合主题）。
 */
/** 弹窗栈：仅栈顶弹窗响应键盘，堆叠时一次按键不得同时驱动多个弹窗。 */
const dialogStack: object[] = [];
let dialogSequence = 0;
let modalApp: HTMLElement | null = null;
let appWasInert = false;
let appAriaHidden: string | null = null;

export function choiceDialog(message: string, options: string[], defaultIndex = 0): Promise<number> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "choice-overlay";
    const box = document.createElement("div");
    box.className = "choice-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const msg = document.createElement("div");
    msg.className = "choice-msg";
    msg.id = `rtl-dialog-message-${++dialogSequence}`;
    box.setAttribute("aria-labelledby", msg.id);
    msg.textContent = message;
    const buttons = document.createElement("div");
    buttons.className = "choice-buttons";
    // 打开前记住焦点，关闭后归还，避免焦点丢到 body 导致编辑器快捷键失灵
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let done = false;
    const token = {};
    dialogStack.push(token);
    if (dialogStack.length === 1) {
      modalApp = document.getElementById("app");
      if (modalApp) {
        appWasInert = modalApp.hasAttribute("inert");
        appAriaHidden = modalApp.getAttribute("aria-hidden");
        modalApp.inert = true;
        modalApp.setAttribute("inert", "");
        modalApp.setAttribute("aria-hidden", "true");
      }
    }
    const finish = (index: number) => {
      if (done) return;
      done = true;
      const at = dialogStack.indexOf(token);
      if (at >= 0) dialogStack.splice(at, 1);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (!dialogStack.length && modalApp) {
        modalApp.inert = appWasInert;
        if (appWasInert) modalApp.setAttribute("inert", "");
        else modalApp.removeAttribute("inert");
        if (appAriaHidden === null) modalApp.removeAttribute("aria-hidden");
        else modalApp.setAttribute("aria-hidden", appAriaHidden);
        modalApp = null;
      }
      prevFocus?.focus();
      resolve(index);
    };
    const onKey = (e: KeyboardEvent) => {
      // 非栈顶弹窗对键盘完全无感（上层弹窗会先拦截并 stopPropagation）
      if (dialogStack[dialogStack.length - 1] !== token) return;
      // 捕获阶段拦下全部按键：弹窗期间 Monaco/全局快捷键不得响应（键盘模态）
      e.stopPropagation();
      const btns = [...buttons.querySelectorAll("button")];
      if (e.key === "Escape") {
        finish(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
        finish(idx >= 0 ? idx : defaultIndex);
      } else if (e.key === "Tab") {
        // 焦点圈在按钮组内循环，不得 Tab 出弹窗
        e.preventDefault();
        const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.shiftKey ? (cur - 1 + btns.length) % btns.length : (cur + 1) % btns.length;
        btns[next]?.focus();
      }
    };

    options.forEach((label, i) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      if (i === defaultIndex) btn.className = "primary";
      btn.addEventListener("click", () => finish(i));
      buttons.appendChild(btn);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(-1);
    });
    document.addEventListener("keydown", onKey, true);

    box.append(msg, buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    (buttons.children[defaultIndex] as HTMLButtonElement | undefined)?.focus();
  });
}

/** 应用内确认框：确定=true，取消/Esc/遮罩=false。 */
export function appConfirm(message: string): Promise<boolean> {
  return choiceDialog(message, ["确定", "取消"]).then((i) => i === 0);
}

/** 应用内单键提示框（错误信息等），确定/Esc/遮罩均关闭。 */
export function appAlert(message: string): Promise<void> {
  return choiceDialog(message, ["确定"]).then(() => undefined);
}
