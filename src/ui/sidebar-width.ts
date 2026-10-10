const WIDTH_KEY = "rtl-viewer.sidebarWidth";
const clamp = (width: number) => Math.min(Math.max(width, 160), 600);

/** 恢复侧栏偏好；拖动完成或中断时保存，并释放本次拖动的监听器。 */
export function attachSidebarWidth(sidebar: HTMLElement, splitter: HTMLElement): () => void {
  try {
    const saved = localStorage.getItem(WIDTH_KEY);
    if (saved?.trim() && Number.isFinite(Number(saved))) sidebar.style.width = `${clamp(Number(saved))}px`;
  } catch { /* 偏好存储不可用时沿用默认布局。 */ }

  let stopDrag = () => {};
  function startDrag(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag();
    const startX = event.clientX, startWidth = sidebar.getBoundingClientRect().width;
    let changed = false;
    document.body.classList.add("resizing");
    const move = (ev: MouseEvent) => {
      sidebar.style.width = `${clamp(startWidth + ev.clientX - startX)}px`;
      changed = true;
    };
    stopDrag = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stopDrag);
      window.removeEventListener("blur", stopDrag);
      if (changed) {
        try { localStorage.setItem(WIDTH_KEY, String(clamp(Number.parseFloat(sidebar.style.width)))); }
        catch { /* 保存偏好失败不阻断布局操作。 */ }
      }
      stopDrag = () => {};
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stopDrag);
    window.addEventListener("blur", stopDrag);
  }
  function dispose(): void {
    stopDrag();
    splitter.removeEventListener("mousedown", startDrag);
    window.removeEventListener("pagehide", dispose);
  }
  splitter.addEventListener("mousedown", startDrag);
  window.addEventListener("pagehide", dispose);
  return dispose;
}
