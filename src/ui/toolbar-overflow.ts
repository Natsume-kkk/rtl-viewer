import { setIcon } from "./icons";
import { closeCtxMenu, showCtxMenu } from "./menu";

export interface ToolbarOverflowItem {
  button: HTMLButtonElement;
  label: string;
}

export function attachToolbarOverflow(toolbar: HTMLElement, end: HTMLElement, items: ToolbarOverflowItem[]): () => void {
  const more = document.createElement("button");
  more.className = "btn btn-ghost toolbar-more";
  more.type = "button";
  more.title = "更多操作";
  more.setAttribute("aria-label", "更多操作");
  more.setAttribute("aria-haspopup", "menu");
  const glyph = document.createElement("span");
  setIcon(glyph, "more");
  more.append(glyph, document.createTextNode("更多"));
  more.hidden = true;
  end.append(more);

  let frame = 0;
  const update = () => {
    frame = 0;
    closeCtxMenu();
    for (const item of items) item.button.hidden = false;
    more.hidden = true;
    if (toolbar.scrollWidth <= toolbar.clientWidth) return;
    more.hidden = false;
    for (const item of items) {
      if (toolbar.scrollWidth <= toolbar.clientWidth) break;
      item.button.hidden = true;
    }
  };
  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  more.addEventListener("click", event => {
    event.stopPropagation();
    const rect = more.getBoundingClientRect();
    showCtxMenu(rect.right, rect.bottom, items.filter(item => item.button.hidden).map(item => ({
      label: item.label,
      action: () => item.button.click(),
    })), more);
  });
  const observer = new ResizeObserver(schedule);
  observer.observe(toolbar);
  update();

  const dispose = () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    more.remove();
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
