import type monacoNs from "monaco-editor";

export interface StatusBarCallbacks {
  onReopen(encoding: string): void;
  onSetSaveEncoding(encoding: string): void;
}

const ENCODING_LABELS: Record<string, string> = {
  utf8: "UTF-8",
  "utf8-bom": "UTF-8 BOM",
  utf16le: "UTF-16 LE",
  utf16be: "UTF-16 BE",
  gbk: "GBK",
};

export class StatusBar {
  private rootEl: HTMLElement;
  private posEl: HTMLSpanElement;
  private langEl: HTMLSpanElement;
  private encEl: HTMLSpanElement;
  private callbacks: StatusBarCallbacks;
  private menu: HTMLDivElement | null = null;
  private hintEl!: HTMLSpanElement;
  private hintTimer: number | undefined;

  /** 瞬态提示（找不到跳转目标等），3 秒后自动消失。 */
  hint(text: string): void {
    window.clearTimeout(this.hintTimer);
    this.hintEl.textContent = text;
    this.hintTimer = window.setTimeout(() => {
      this.hintEl.textContent = "";
    }, 3000);
  }

  constructor(rootEl: HTMLElement, callbacks: StatusBarCallbacks) {
    this.rootEl = rootEl;
    this.callbacks = callbacks;
    this.rootEl.className = "statusbar";

    this.posEl = document.createElement("span");
    this.posEl.className = "status-item";
    this.langEl = document.createElement("span");
    this.langEl.className = "status-item";
    this.encEl = document.createElement("span");
    this.encEl.className = "status-item clickable";
    this.encEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleEncodingMenu();
    });

    const left = document.createElement("div");
    left.className = "status-left";
    this.hintEl = document.createElement("span");
    this.hintEl.className = "status-item status-hint";
    left.appendChild(this.hintEl);
    const right = document.createElement("div");
    right.className = "status-right";
    right.append(this.langEl, this.encEl, this.posEl);
    this.rootEl.append(left, right);

    document.addEventListener("click", () => this.closeMenu());

    this.update(null, null);
  }

  attachEditor(editor: monacoNs.editor.IStandaloneCodeEditor): void {
    editor.onDidChangeCursorPosition(() => {
      const pos = editor.getPosition();
      if (pos) this.posEl.textContent = `行 ${pos.lineNumber}, 列 ${pos.column}`;
    });
  }

  /** active 为 null 表示无打开文件 */
  update(lang: string | null, encoding: string | null): void {
    this.posEl.textContent = lang ? this.posEl.textContent || "行 1, 列 1" : "";
    this.langEl.textContent = lang ?? "";
    this.encEl.textContent = encoding ? (ENCODING_LABELS[encoding] ?? encoding) : "";
  }

  private toggleEncodingMenu(): void {
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "encoding-menu";

    const reopenTitle = document.createElement("div");
    reopenTitle.className = "menu-title";
    reopenTitle.textContent = "以指定编码重新打开";
    menu.appendChild(reopenTitle);
    for (const enc of ["utf8", "gbk"]) {
      menu.appendChild(this.menuItem(ENCODING_LABELS[enc], () => this.callbacks.onReopen(enc)));
    }

    const saveTitle = document.createElement("div");
    saveTitle.className = "menu-title";
    saveTitle.textContent = "以指定编码保存";
    menu.appendChild(saveTitle);
    for (const enc of ["utf8", "gbk", "utf8-bom"]) {
      menu.appendChild(this.menuItem(ENCODING_LABELS[enc], () => this.callbacks.onSetSaveEncoding(enc)));
    }

    menu.addEventListener("click", (e) => e.stopPropagation());
    this.rootEl.appendChild(menu);
    this.menu = menu;
  }

  private menuItem(text: string, action: () => void): HTMLDivElement {
    const item = document.createElement("div");
    item.className = "menu-item";
    item.textContent = text;
    item.addEventListener("click", () => {
      this.closeMenu();
      action();
    });
    return item;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
