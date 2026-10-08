let closeActive: (() => void) | undefined;

/** 菜单共用方向键、激活和焦点恢复；返回清理函数供所有关闭路径调用。 */
export function activateMenu(menu: HTMLElement, close: () => void, anchor?: HTMLElement): () => void {
  closeActive?.();
  closeActive = close;
  const previous = anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  menu.setAttribute("role", "menu");
  const items = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].filter(el => !el.hasAttribute("disabled"));
  for (const item of items()) item.tabIndex = -1;
  const onKey = (e: KeyboardEvent) => {
    if (!menu.contains(document.activeElement)) return;
    e.stopPropagation();
    const choices = items(), index = choices.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? choices.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      choices[next]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); choices[index]?.click();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault(); close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  if (items().length) items()[0].focus();
  else { menu.tabIndex = -1; menu.focus(); }
  return () => {
    document.removeEventListener("keydown", onKey, true);
    if (closeActive === close) closeActive = undefined;
    if (menu.contains(document.activeElement)) previous?.focus();
  };
}
