import { setIcon } from "./icons";
import { showCtxMenu } from "./menu";

export type NewFileType = "v" | "sv" | "vhd";
const key = "rtl-viewer.newFileType";
const types = [{ ext: "v", name: "Verilog" }, { ext: "sv", name: "SystemVerilog" }, { ext: "vhd", name: "VHDL" }] as const;

export function preferredNewFileType(): NewFileType {
  const value = localStorage.getItem(key);
  return value === "sv" || value === "vhd" ? value : "v";
}

export function createNewFileControl(create: (extension: NewFileType) => void): HTMLElement {
  const wrap = document.createElement("span"); wrap.className = "new-file-control";
  const main = document.createElement("button"); main.className = "btn btn-ghost";
  const label = document.createElement("span"), icon = document.createElement("span"); setIcon(icon, "plus");
  main.append(icon, label);
  const update = () => { label.textContent = `新建 .${preferredNewFileType()}`; main.title = `新建 .${preferredNewFileType()} 文件 (Ctrl+N)`; };
  update();
  main.onclick = () => create(preferredNewFileType());
  const arrow = document.createElement("button"); arrow.className = "btn btn-ghost new-file-types";
  arrow.title = "选择新建文件类型"; arrow.setAttribute("aria-label", arrow.title); arrow.setAttribute("aria-haspopup", "menu"); setIcon(arrow, "chevron-down");
  arrow.onclick = e => {
    e.stopPropagation();
    const rect = wrap.getBoundingClientRect();
    showCtxMenu(rect.left, rect.bottom + 4, types.map(type => ({
      label: `${type.name} (.${type.ext})`, checked: preferredNewFileType() === type.ext,
      action: () => { localStorage.setItem(key, type.ext); update(); create(type.ext); },
    })), arrow);
  };
  wrap.append(main, arrow); return wrap;
}
