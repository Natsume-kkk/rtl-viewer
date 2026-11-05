import type { SyntaxCheckOptions } from "../ipc";
import { setIcon, type IconName } from "./icons";

export interface SyntaxOptionsDialogActions {
  browseInclude?: () => Promise<string | undefined>;
  browseLibrary?: () => Promise<string | undefined>;
}

export function showSyntaxOptionsDialog(options: SyntaxCheckOptions, actions: SyntaxOptionsDialogActions = {}): Promise<SyntaxCheckOptions | undefined> {
  return new Promise(resolve => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.className = "choice-overlay";
    const box = document.createElement("div");
    box.className = "choice-box syntax-options-dialog";
    const title = document.createElement("div");
    title.className = "choice-msg";
    title.textContent = "检查配置";
    const form = document.createElement("div");
    form.className = "syntax-options-form";
    const top = input("顶层模块（留空自动识别）", options.top);
    top.field.placeholder = "自动识别";
    const defines = textarea("Verilog 宏，每行一个，例如 DEBUG=1", options.defines.join("\n"));
    const includes = textarea("额外 include 目录，每行一个；相对路径按工程根解析", options.includeDirs.join("\n"));
    if (actions.browseInclude) includes.label.append(browseButton("添加目录", "folder", async () => {
      const path = await actions.browseInclude!();
      if (path) appendLine(includes.field, path);
    }));
    const libraries = textarea("VHDL library 映射，每行 library=文件路径", options.vhdlLibraries.map(item => `${item.library}=${item.file}`).join("\n"));
    if (actions.browseLibrary) libraries.label.append(browseButton("添加映射文件", "file", async () => {
      const path = await actions.browseLibrary!();
      if (path) appendLine(libraries.field, `${libraryName(path)}=${path}`);
    }));
    const verilatorArgs = textarea("Verilator 附加参数，每行一个", options.verilatorArgs.join("\n"));
    const ghdlArgs = textarea("GHDL 附加参数，每行一个", options.ghdlArgs.join("\n"));
    const advanced = document.createElement("details");
    advanced.className = "syntax-options-advanced";
    const advancedTitle = document.createElement("summary");
    const advancedIcon = document.createElement("span");
    setIcon(advancedIcon, "chevron-right");
    advancedTitle.append(advancedIcon, document.createTextNode("高级设置（通常无需修改）"));
    advanced.addEventListener("toggle", () => setIcon(advancedIcon, advanced.open ? "chevron-down" : "chevron-right"));
    const advancedFields = document.createElement("div");
    advancedFields.className = "syntax-options-advanced-fields";
    advancedFields.append(verilatorArgs.label, ghdlArgs.label);
    advanced.append(advancedTitle, advancedFields);
    form.append(top.label, defines.label, includes.label, libraries.label, advanced);
    const buttons = document.createElement("div");
    buttons.className = "choice-buttons";
    const save = document.createElement("button");
    save.textContent = "保存配置";
    save.className = "primary";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    buttons.append(save, cancel);
    box.append(title, form, buttons);
    overlay.append(box);
    document.body.append(overlay);

    const finish = (result?: SyntaxCheckOptions) => {
      overlay.remove();
      previous?.focus();
      resolve(result);
    };
    save.onclick = () => finish({
      top: top.field.value.trim(),
      defines: lines(defines.field.value),
      includeDirs: lines(includes.field.value),
      vhdlLibraries: lines(libraries.field.value).map(line => {
        const separator = line.indexOf("=");
        return { library: separator < 0 ? line.trim() : line.slice(0, separator).trim(), file: separator < 0 ? "" : line.slice(separator + 1).trim() };
      }),
      verilatorArgs: lines(verilatorArgs.field.value),
      ghdlArgs: lines(ghdlArgs.field.value),
    });
    cancel.onclick = () => finish();
    overlay.onclick = event => { if (event.target === overlay) finish(); };
    overlay.onkeydown = event => {
      if (event.key === "Escape") finish();
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        save.click();
      }
      if (event.key === "Tab") {
        const focusable = [...box.querySelectorAll<HTMLElement>("input, textarea, button, summary")].filter(element => !element.closest("details:not([open])"));
        const current = focusable.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (current - 1 + focusable.length) % focusable.length : (current + 1) % focusable.length;
        event.preventDefault();
        focusable[next]?.focus();
      }
      event.stopPropagation();
    };
    top.field.focus();
  });
}

function input(labelText: string, value: string) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const field = document.createElement("input");
  field.value = value;
  label.append(field);
  return { label, field };
}

function textarea(labelText: string, value: string) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const field = document.createElement("textarea");
  field.rows = 3;
  field.value = value;
  label.append(field);
  return { label, field };
}

function browseButton(text: string, icon: IconName, action: () => Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-ghost btn-inline syntax-options-browse";
  const glyph = document.createElement("span");
  setIcon(glyph, icon);
  button.append(glyph, document.createTextNode(text));
  button.onclick = async () => {
    button.disabled = true;
    try { await action(); }
    finally { button.disabled = false; }
  };
  return button;
}

function appendLine(field: HTMLTextAreaElement, value: string): void {
  field.value = `${field.value.trimEnd()}${field.value.trimEnd() ? "\n" : ""}${value}`;
}

function libraryName(path: string): string {
  const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "work";
  return name.replace(/[^A-Za-z0-9_]/g, "_") || "work";
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
