import type { Tab, TabManager } from "../editor/tabs";

interface TabDrop { source: number; target: number; tab: Tab; before?: Tab; x: number; y: number; split: boolean }

/** 使用指针手势，不向系统拖放文件；越出窗口、Esc、失焦均取消。 */
export function attachTabDrag(managers: readonly TabManager[], splitVisible: () => boolean, drop: (target: TabDrop) => void): () => void {
  const area = document.getElementById("main-area")!;
  const panes = [1, 2].map(n => document.getElementById(`group-${n}`)!);
  const bars = ["tabbar", "tabbar-2"].map(id => document.getElementById(id)!);
  let cancel = () => {};
  function start(e: PointerEvent) {
    if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest("button")) return;
    const source = bars.findIndex(bar => bar.contains(e.target as Node));
    const tab = source < 0 ? undefined : managers[source].tabAt(e.target);
    if (!tab) return;
    cancel();
    let dragging = false, hit: TabDrop | undefined;
    const marker = document.createElement("div");
    marker.className = "tab-drop-hint";
    function clear() {
      panes.forEach(pane => pane.classList.remove("tab-drop-target"));
      area.querySelectorAll(".tab-drop-before").forEach(el => el.classList.remove("tab-drop-before"));
    }
    const move = (event: PointerEvent) => {
      if (!dragging && Math.hypot(event.clientX - e.clientX, event.clientY - e.clientY) < 6) return;
      dragging = true; event.preventDefault();
      if (!marker.isConnected) document.body.append(marker);
      clear(); hit = undefined;
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const target = panes.findIndex(pane => !pane.hidden && element && pane.contains(element));
      marker.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 210)}px`;
      marker.style.top = `${Math.min(event.clientY + 12, window.innerHeight - 36)}px`;
      if (target < 0 || !element) { marker.textContent = "松开取消移动"; return; }
      const inBar = bars[target].contains(element);
      const split = !splitVisible() && !inBar;
      if (target === source && !inBar && !split) { marker.textContent = "拖到另一视图或标签栏"; return; }
      const before = inBar ? managers[target].tabAt(element) : undefined;
      hit = { source, target, tab, before, x: event.clientX, y: event.clientY, split };
      if (before) before.element.classList.add("tab-drop-before");
      else panes[target].classList.add("tab-drop-target");
      marker.textContent = split ? "松开选择移动或克隆到另一视图" : target === source ? "松开调整标签顺序" : "松开移动到此视图";
    };
    const up = () => {
      const result = hit;
      if (dragging) {
        const suppress = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
        document.addEventListener("click", suppress, { capture: true, once: true });
        setTimeout(() => document.removeEventListener("click", suppress, true), 0);
      }
      cancel();
      if (result) drop(result);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    cancel = () => {
      clear(); marker.remove();
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
      cancel = () => {};
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
  }
  area.addEventListener("pointerdown", start);
  return () => { cancel(); area.removeEventListener("pointerdown", start); };
}
