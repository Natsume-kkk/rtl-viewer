/** meridian 图标集：16px 栅格、stroke 1.5、currentColor 随主题着色。
 *  设计源：design-agent outputs/rtl-viewer-meridian/assets/icons/，修改须先改设计源再同步此处。 */
export type IconName =
  | "chevron-down"
  | "chevron-right"
  | "ip-diamond"
  | "unresolved"
  | "jump-inst"
  | "moon"
  | "sun"
  | "close"
  | "outline"
  | "warning"
  | "arrow-left"
  | "arrow-right";

const SW = `stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

const ICONS: Record<IconName, string> = {
  "chevron-down": `<path d="M4.5 6l3.5 3.5L11.5 6" ${SW}/>`,
  "chevron-right": `<path d="M6 4.5L9.5 8 6 11.5" ${SW}/>`,
  "ip-diamond": `<path d="M8 3.2l4.8 4.8-4.8 4.8-4.8-4.8z" fill="currentColor"/>`,
  "unresolved": `<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2" ${SW} stroke-dasharray="2.6 2.2"/>`,
  "jump-inst": `<path d="M9.5 13V6.5H4.8" ${SW}/><path d="M7.3 4 4.3 7l3 3" ${SW}/>`,
  "moon": `<path d="M13.2 9.8A5.4 5.4 0 1 1 6.2 2.8a4.5 4.5 0 0 0 7 7z" ${SW}/>`,
  "sun": `<circle cx="8" cy="8" r="3" ${SW}/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" ${SW}/>`,
  "close": `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" ${SW}/>`,
  "outline": `<rect x="2.6" y="3" width="2.2" height="2.2" fill="currentColor"/><rect x="2.6" y="6.9" width="2.2" height="2.2" fill="currentColor"/><rect x="2.6" y="10.8" width="2.2" height="2.2" fill="currentColor"/><path d="M6.8 4.1h6.4M6.8 8h4.6M6.8 11.9h5.6" ${SW}/>`,
  "warning": `<path d="M8 2.8l6 10.4H2z" ${SW}/><path d="M8 6.6v3.2" ${SW}/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/>`,
  "arrow-left": `<path d="M13 8H4M7 4.5L3.5 8 7 11.5" ${SW}/>`,
  "arrow-right": `<path d="M3 8h9M9 4.5L12.5 8 9 11.5" ${SW}/>`,
};

/** 把 el 设置为指定图标：加 icon 基类与 icon-<name> 修饰类，注入内联 SVG（静态可信字符串，CSP 安全）。
 *  幂等：重复调用会清掉旧的 icon-<name> 修饰类（如主题切换 moon/sun 互换）。 */
export function setIcon(el: HTMLElement, name: IconName): void {
  for (const c of [...el.classList]) if (c.startsWith("icon-")) el.classList.remove(c);
  el.classList.add("icon", `icon-${name}`);
  el.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[name]}</svg>`;
}
