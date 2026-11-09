import { setIcon } from "./icons";

const WIDTH_KEY = "rtl-viewer.sidebarWidth";
const COLLAPSED_KEY = "rtl-viewer.sidebarCollapsed";
const clamp = (width: number) => Math.min(Math.max(width, 160), 600);

/** 恢复侧栏偏好；拖动完成或中断时保存，并释放本次拖动的监听器。 */
export function attachSidebarWidth(sidebar: HTMLElement, splitter: HTMLElement, toggle?: HTMLButtonElement): () => void {
  const app = document.getElementById("app");
  let collapsed = false;
  const renderCollapsed = () => {
    sidebar.hidden = collapsed;
    splitter.hidden = collapsed;
    app?.classList.toggle("sidebar-collapsed", collapsed);
    if (!toggle) return;
    const label = collapsed ? "展开侧栏" : "收起侧栏";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-controls", sidebar.id);
    setIcon(toggle, "sidebar");
  };
  const toggleCollapsed = () => {
    collapsed = !collapsed;
    renderCollapsed();
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* 折叠状态不可保存时仍保持本次操作。 */ }
  };
  try {
    const saved = localStorage.getItem(WIDTH_KEY);
    if (saved?.trim() && Number.isFinite(Number(saved))) sidebar.style.width = `${clamp(Number(saved))}px`;
    const savedCollapsed = localStorage.getItem(COLLAPSED_KEY);
    collapsed = savedCollapsed === null ? window.matchMedia?.("(max-width: 760px)").matches ?? false : savedCollapsed === "1";
  } catch { /* 偏好存储不可用时沿用默认布局。 */ }
  renderCollapsed();
  toggle?.addEventListener("click", toggleCollapsed);

  const saveWidth = () => {
    try { localStorage.setItem(WIDTH_KEY, String(clamp(Number.parseFloat(sidebar.style.width)))); }
    catch { /* 保存偏好失败不阻断布局操作。 */ }
  };
  const updateWidth = (width: number) => {
    sidebar.style.width = `${clamp(width)}px`;
    splitter.setAttribute("aria-valuenow", String(clamp(width)));
  };
  splitter.tabIndex = 0;
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-label", "调整侧栏宽度");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.setAttribute("aria-controls", sidebar.id);
  splitter.setAttribute("aria-valuemin", "160");
  splitter.setAttribute("aria-valuemax", "600");
  splitter.setAttribute("aria-valuenow", String(Math.round(sidebar.getBoundingClientRect().width)));
  const keyResize = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    updateWidth(event.key === "Home" ? 280 : sidebar.getBoundingClientRect().width + (event.key === "ArrowRight" ? 24 : -24));
    saveWidth();
  };
  splitter.addEventListener("keydown", keyResize);

  let stopDrag = () => {};
  function startDrag(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag();
    const startX = event.clientX, startWidth = sidebar.getBoundingClientRect().width;
    let changed = false;
    document.body.classList.add("resizing");
    const move = (ev: MouseEvent) => {
      updateWidth(startWidth + ev.clientX - startX);
      changed = true;
    };
    stopDrag = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stopDrag);
      window.removeEventListener("blur", stopDrag);
      if (changed) saveWidth();
      stopDrag = () => {};
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stopDrag);
    window.addEventListener("blur", stopDrag);
  }
  function dispose(): void {
    stopDrag();
    splitter.removeEventListener("mousedown", startDrag);
    splitter.removeEventListener("keydown", keyResize);
    toggle?.removeEventListener("click", toggleCollapsed);
    window.removeEventListener("pagehide", dispose);
  }
  splitter.addEventListener("mousedown", startDrag);
  window.addEventListener("pagehide", dispose);
  return dispose;
}
