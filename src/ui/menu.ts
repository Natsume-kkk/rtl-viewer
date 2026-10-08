import { activateMenu } from "./menu-keyboard";
/** 右键菜单与文件路径操作的公共件：树节点与标签页共用。 */

export interface MenuItem {
  label: string;
  action: () => void;
  checked?: boolean;
}

let ctxMenu: HTMLDivElement | null = null;
let releaseKeyboard: (() => void) | undefined;

export function closeCtxMenu(): void {
  releaseKeyboard?.(); releaseKeyboard = undefined;
  ctxMenu?.remove();
  ctxMenu = null;
}

export function showCtxMenu(x: number, y: number, items: MenuItem[], anchor?: HTMLElement): void {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
    if (item.checked !== undefined) row.setAttribute("aria-checked", String(item.checked));
    row.className = "menu-item ctx-item";
    row.textContent = item.label;
    row.addEventListener("click", () => {
      closeCtxMenu();
      item.action();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // 防出屏：先渲染再按实际尺寸收回视口内
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  ctxMenu = menu;
  releaseKeyboard = activateMenu(menu, closeCtxMenu, anchor);
}

document.addEventListener("click", closeCtxMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCtxMenu();
});

export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

export function fileBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function fileDirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
  return i > 0 ? path.slice(0, i) : path;
}

/** 文件路径相关菜单项：复制文件名/路径/所在目录 + 资源管理器定位。 */
export function filePathMenuItems(path: string, onReveal?: (path: string) => void): MenuItem[] {
  const items: MenuItem[] = [
    { label: "复制文件名", action: () => copyText(fileBasename(path)) },
    { label: "复制文件路径", action: () => copyText(path) },
    { label: "复制所在目录", action: () => copyText(fileDirname(path)) },
  ];
  if (onReveal) {
    items.push({ label: "在资源管理器中显示", action: () => onReveal(path) });
  }
  return items;
}
