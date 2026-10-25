/** 界面图标集：16px 栅格、stroke 1.5、圆角收口，currentColor 随主题着色。 */
export type IconName =
  | "chevron-down"
  | "chevron-right"
  | "ip-diamond"
  | "primitive"
  | "unresolved"
  | "jump-inst"
  | "moon"
  | "sun"
  | "close"
  | "outline"
  | "warning"
  | "arrow-left"
  | "arrow-right"
  | "module" | "folder" | "plus" | "save" | "search" | "split" | "ports"
  | "minimize" | "maximize" | "restore";

const SW = `stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

const ICONS: Record<IconName, string> = {
  "minimize": `<path d="M3 8h10" ${SW}/>`,
  "maximize": `<rect x="3" y="3" width="10" height="10" ${SW}/>`,
  "restore": `<path d="M6 3h7v7M3 6h7v7H3z" ${SW}/>`,
  "module": `<rect x="4" y="4" width="8" height="8" rx="2" ${SW}/><path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5" ${SW}/>`,
  "folder": `<path d="M2 5V4a1.5 1.5 0 0 1 1.5-1.5H6L8 5h4.5A1.5 1.5 0 0 1 14 6.5v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5Z" ${SW}/>`,
  "plus": `<path d="M8 3v10M3 8h10" ${SW}/>`,
  "save": `<path d="M4.5 2.5h6l3 3v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" ${SW}/><path d="M5.5 2.5v4h5v-4M5.5 13.5v-4h5v4" ${SW}/>`,
  "search": `<circle cx="7" cy="7" r="4.5" ${SW}/><path d="m10.3 10.3 3.2 3.2" ${SW}/>`,
  "split": `<rect x="2" y="2.5" width="12" height="11" rx="2" ${SW}/><path d="M8 2.5v11" ${SW}/>`,
  "ports": `<rect x="2" y="2" width="4" height="4" rx="1.3" ${SW}/><rect x="10" y="10" width="4" height="4" rx="1.3" ${SW}/><path d="M6 4h4a2 2 0 0 1 2 2v4M4 6v4a2 2 0 0 0 2 2h4" ${SW}/>`,
  "chevron-down": `<path d="M4.5 6l3.5 3.5L11.5 6" ${SW}/>`,
  "chevron-right": `<path d="M6 4.5L9.5 8 6 11.5" ${SW}/>`,
  "ip-diamond": `<path d="M8 3.2l4.8 4.8-4.8 4.8-4.8-4.8z" fill="currentColor"/>`,
  "primitive": `<rect x="5" y="3" width="6" height="10" rx="2" ${SW}/><path d="M2 8h3M11 8h3" ${SW}/>`,
  "unresolved": `<rect x="2.5" y="2.5" width="11" height="11" rx="3" ${SW}/><path d="M6.5 6a1.5 1.5 0 0 1 3 0c0 1-1.5 1.25-1.5 2.5" ${SW}/><circle cx="8" cy="10.75" r=".75" fill="currentColor"/>`,
  "jump-inst": `<path d="M10 2.5h1.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10M2 8h7.5M7 5.5 9.5 8 7 10.5" ${SW}/>`,
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
  for (const c of [...el.classList]) {
    if (c.startsWith("icon-") && Object.hasOwn(ICONS, c.slice(5))) el.classList.remove(c);
  }
  el.classList.add("icon", `icon-${name}`);
  el.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[name]}</svg>`;
}
