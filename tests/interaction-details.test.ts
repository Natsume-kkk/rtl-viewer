// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { showCtxMenu, closeCtxMenu, fileDirname } from "../src/ui/menu";
import { createNewFileControl, preferredNewFileType } from "../src/ui/new-file";
import { pathSegments } from "../src/ui/breadcrumb";
import { RecentMenu } from "../src/ui/recent";
import { StatusBar } from "../src/ui/statusbar";
vi.mock("../src/ui/theme", () => ({ currentTheme: () => "light", toggleTheme: vi.fn() }));

const key = (value: string) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
beforeEach(() => { closeCtxMenu(); document.body.replaceChildren(); localStorage.clear(); });
describe("interaction details", () => {
  it("新建一键复用类型，选择后持久化，Esc 取消不创建也不改偏好", () => {
    const create = vi.fn(); let control = createNewFileControl(create); document.body.append(control);
    control.querySelector<HTMLButtonElement>("button")!.click(); expect(create).toHaveBeenLastCalledWith("v");
    control.querySelector<HTMLButtonElement>(".new-file-types")!.click(); key("ArrowDown"); key("Enter");
    expect(create).toHaveBeenLastCalledWith("sv"); expect(preferredNewFileType()).toBe("sv");
    control.remove(); control = createNewFileControl(create); document.body.append(control);
    expect(control.textContent).toContain("新建 .sv");
    const arrow = control.querySelector<HTMLButtonElement>(".new-file-types")!; arrow.click(); key("ArrowDown"); key("Escape");
    expect(document.activeElement).toBe(arrow); expect(create).toHaveBeenCalledTimes(2); expect(preferredNewFileType()).toBe("sv");
    localStorage.setItem("rtl-viewer.newFileType", "exe"); expect(preferredNewFileType()).toBe("v");
  });
  it("右键菜单方向键、首尾、Enter 与关闭焦点一致", () => {
    const anchor = document.createElement("button"); document.body.append(anchor); anchor.focus(); const action = vi.fn();
    showCtxMenu(0, 0, [{ label: "first", action }, { label: "last", action }]);
    key("End"); expect(document.activeElement?.textContent).toBe("last");
    key("ArrowDown"); expect(document.activeElement?.textContent).toBe("first");
    key("Enter"); expect(action).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(anchor);
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });
  it("最近工程与编码菜单同样支持键盘选择及 Esc 返回入口", () => {
    const anchor = document.createElement("div"); document.body.append(anchor);
    const recent = new RecentMenu(anchor, { onPick: vi.fn(), onRemove: vi.fn() }); recent.setItems(["D:/one", "D:/two"]); recent.toggle();
    key("End"); expect(document.activeElement?.getAttribute("aria-label")).toContain("D:/two"); key("Escape"); expect(recent.isOpen).toBe(false);
    const status = new StatusBar(anchor, { onReopen: vi.fn(), onSetSaveEncoding: vi.fn() }); status.update("verilog", "utf8");
    const encoding = anchor.querySelector<HTMLButtonElement>('button[title="选择文件编码"]')!;
    encoding.click(); expect(document.activeElement?.textContent).toBe("UTF-8"); key("ArrowDown"); expect(document.activeElement?.textContent).toBe("GBK");
    key("Escape"); expect(document.activeElement).toBe(encoding);
  });
  it("盘符、UNC、中文与特殊字符路径保留真实目标", () => {
    expect(fileDirname("D:/top.v")).toBe("D:/");
    expect(pathSegments("D:\\中文 目录\\rtl\\top.v").map(p => p.path)).toEqual(["D:/", "D:/中文 目录", "D:/中文 目录/rtl", "D:/中文 目录/rtl/top.v"]);
    expect(pathSegments("\\\\server\\share\\dir\\a#%.v").map(p => p.path)).toEqual(["//server/share/", "//server/share/dir", "//server/share/dir/a#%.v"]);
  });
});
