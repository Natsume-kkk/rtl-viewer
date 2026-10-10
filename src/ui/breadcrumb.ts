import { filePathMenuItems, showCtxMenu, type MenuItem } from "./menu";

export function pathSegments(path: string): { name: string; path: string }[] {
  const normalized = path.replace(/\\/g, "/");
  const root = normalized.match(/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/)?.[0] ?? "";
  let current = root;
  const result = root ? [{ name: root.replace(/\/$/, "") || "/", path: root }] : [];
  for (const name of normalized.slice(root.length).split("/").filter(Boolean)) {
    current = current ? `${current.replace(/\/$/, "")}/${name}` : name;
    result.push({ name, path: current });
  }
  return result;
}

/** 窄栏只折叠祖先目录，父目录与文件名保持可见，折叠项仍能通过菜单访问。 */
export class PathBreadcrumb {
  private path = "";
  private title = "";
  private observer: ResizeObserver;
  private onContextMenu = (event: MouseEvent) => {
    if (!this.path) return;
    event.preventDefault(); showCtxMenu(event.clientX, event.clientY, filePathMenuItems(this.path, this.reveal));
  };
  private onPageHide = () => this.dispose();
  constructor(private root: HTMLElement, private openDirectory: (path: string) => void, private reveal: (path: string) => void) {
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(root);
    root.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("pagehide", this.onPageHide, { once: true });
  }
  dispose(): void {
    this.observer.disconnect();
    this.root.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("pagehide", this.onPageHide);
  }
  setPath(path: string, title: string): void { this.path = path; this.title = title; this.render(); }
  private render(): void {
    this.root.replaceChildren(); this.root.title = this.path || this.title;
    if (!this.path) { this.root.textContent = this.title; return; }
    const segments = pathSegments(this.path);
    const button = (part: { name: string; path: string }, file: boolean) => {
      const el = document.createElement("button"); el.type = "button"; el.className = "path-segment";
      el.textContent = part.name; el.title = `${file ? "在资源管理器中显示" : "打开文件夹"}：${part.path}`;
      el.onclick = () => file ? this.reveal(part.path) : this.openDirectory(part.path);
      return el;
    };
    const separator = () => { const el = document.createElement("span"); el.className = "path-separator"; el.textContent = "›"; el.setAttribute("aria-hidden", "true"); return el; };
    const nodes = segments.map((part, i) => button(part, i === segments.length - 1));
    nodes.forEach((el, i) => { if (i) this.root.append(separator()); this.root.append(el); });
    if (this.root.scrollWidth > this.root.clientWidth && segments.length > 2) {
      const overflow = document.createElement("button"); overflow.className = "path-overflow"; overflow.textContent = "…";
      overflow.title = "上级目录"; overflow.setAttribute("aria-label", "展开上级目录"); overflow.setAttribute("aria-haspopup", "menu");
      overflow.onclick = event => {
        event.stopPropagation(); const rect = overflow.getBoundingClientRect();
        const items: MenuItem[] = segments.slice(0, -2).map(part => ({ label: part.path, action: () => this.openDirectory(part.path) }));
        showCtxMenu(rect.left, rect.bottom, items, overflow);
      };
      this.root.replaceChildren(overflow, separator(), nodes[nodes.length - 2], separator(), nodes[nodes.length - 1]);
    }
    nodes.at(-1)?.classList.add("path-file");
    nodes.at(-2)?.classList.add("path-parent");
  }
}
