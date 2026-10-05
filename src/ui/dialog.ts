/**
 * 模态选择对话框：消息 + 若干按钮，返回点击的按钮下标；Esc/遮罩点击返回 -1。
 * 用于「磁盘已被外部修改」这类三选场景（Tauri 原生 confirm 只有两键）。
 */
export function choiceDialog(message: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "choice-overlay";
    const box = document.createElement("div");
    box.className = "choice-box";
    const msg = document.createElement("div");
    msg.className = "choice-msg";
    msg.textContent = message;
    const buttons = document.createElement("div");
    buttons.className = "choice-buttons";

    let done = false;
    const finish = (index: number) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(index);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(-1);
      }
    };

    options.forEach((label, i) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      if (i === 0) btn.className = "primary";
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
    (buttons.firstChild as HTMLButtonElement | null)?.focus();
  });
}
