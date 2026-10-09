// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { appAlert, appConfirm, choiceDialog } from "../src/ui/dialog";
import { openFolderDialog, openFileDialog, saveFileDialog } from "../src/ipc";
import { open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

function pressKey(key: string, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  document.dispatchEvent(e);
  return e;
}

function dialogButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".choice-overlay .choice-buttons button")];
}

describe("choiceDialog", () => {
  it("关闭确认可默认选择取消，Enter 不会丢弃修改", async () => {
    const result = choiceDialog("未保存", ["保存并关闭", "不保存", "取消"], 2);
    expect(document.activeElement?.textContent).toBe("取消");
    pressKey("Enter"); await expect(result).resolves.toBe(2);
  });
  it("点击按钮返回其下标并移除弹窗", async () => {
    const p = choiceDialog("msg", ["甲", "乙", "丙"]);
    dialogButtons()[1].click();
    await expect(p).resolves.toBe(1);
    expect(document.querySelector(".choice-overlay")).toBeNull();
  });

  it("Esc 与遮罩点击返回 -1", async () => {
    const p1 = choiceDialog("msg", ["确定"]);
    pressKey("Escape");
    await expect(p1).resolves.toBe(-1);

    const p2 = choiceDialog("msg", ["确定"]);
    const overlay = document.querySelector(".choice-overlay") as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(p2).resolves.toBe(-1);
  });

  it("Enter 触发焦点按钮，无焦点时触发首按钮", async () => {
    const p1 = choiceDialog("msg", ["覆盖", "放弃", "取消"]);
    dialogButtons()[2].focus();
    pressKey("Enter");
    await expect(p1).resolves.toBe(2);

    const p2 = choiceDialog("msg", ["覆盖", "取消"]);
    (document.activeElement as HTMLElement)?.blur();
    pressKey("Enter");
    await expect(p2).resolves.toBe(0);
  });

  it("Tab 在按钮组内循环，不跳出弹窗", async () => {
    const p = choiceDialog("msg", ["一", "二"]);
    const btns = dialogButtons();
    btns[0].focus();
    pressKey("Tab");
    expect(document.activeElement).toBe(btns[1]);
    pressKey("Tab");
    expect(document.activeElement).toBe(btns[0]);
    pressKey("Tab", true);
    expect(document.activeElement).toBe(btns[1]);
    btns[0].click();
    await expect(p).resolves.toBe(0);
  });

  it("堆叠时仅顶层弹窗响应键盘，关闭顶层后底层恢复", async () => {
    let bottomResult: number | null = null;
    const bottom = choiceDialog("底层", ["确定", "取消"]);
    void bottom.then((i) => { bottomResult = i; });
    const top = choiceDialog("顶层", ["确定", "取消"]);

    pressKey("Enter");
    await expect(top).resolves.toBe(0);
    await Promise.resolve();
    expect(bottomResult).toBeNull(); // 顶层的 Enter 不得误触发底层默认「确定」
    expect(document.querySelectorAll(".choice-overlay")).toHaveLength(1);

    const top2 = choiceDialog("顶层2", ["确定"]);
    pressKey("Escape");
    await expect(top2).resolves.toBe(-1);
    await Promise.resolve();
    expect(bottomResult).toBeNull(); // 顶层的 Escape 同样不影响底层
    expect(document.querySelectorAll(".choice-overlay")).toHaveLength(1);

    pressKey("Escape"); // 顶层已关闭，底层恢复响应
    await expect(bottom).resolves.toBe(-1);
    expect(document.querySelector(".choice-overlay")).toBeNull();
  });

  it("弹窗期间按键不传播给外层（键盘模态）", async () => {
    const seen: string[] = [];
    document.addEventListener("keydown", (e) => seen.push(e.key));
    const p = choiceDialog("msg", ["确定"]);
    pressKey("a");
    expect(seen).toEqual([]); // stopPropagation 后外层监听器收不到
    dialogButtons()[0].click();
    await p;
  });

  it("关闭后焦点归还打开前的元素", async () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    anchor.focus();
    expect(document.activeElement).toBe(anchor);

    const p = choiceDialog("msg", ["确定"]);
    expect(document.activeElement).not.toBe(anchor);
    pressKey("Escape");
    await p;
    expect(document.activeElement).toBe(anchor);
    anchor.remove();
  });
});

describe("appConfirm / appAlert", () => {
  it("appConfirm：确定=true，取消/Esc=false", async () => {
    const ok = appConfirm("确认？");
    dialogButtons()[0].click();
    await expect(ok).resolves.toBe(true);

    const no = appConfirm("确认？");
    dialogButtons()[1].click();
    await expect(no).resolves.toBe(false);

    const esc = appConfirm("确认？");
    pressKey("Escape");
    await expect(esc).resolves.toBe(false);
  });

  it("appAlert：单键，确定/Esc/遮罩均关闭且 resolve", async () => {
    const a = appAlert("出错了");
    expect(dialogButtons()).toHaveLength(1);
    dialogButtons()[0].click();
    await expect(a).resolves.toBeUndefined();

    const b = appAlert("出错了");
    pressKey("Escape");
    await expect(b).resolves.toBeUndefined();
  });
});

describe("对话框入站路径归一", () => {
  it("打开单文件使用文件对话框并归一路径，取消不产生文件", async () => {
    vi.mocked(tauriOpen).mockResolvedValue("D:\\p\\a.v");
    await expect(openFileDialog("D:/p")).resolves.toBe("D:/p/a.v");
    expect(tauriOpen).toHaveBeenLastCalledWith(expect.objectContaining({ directory: false, multiple: false, defaultPath: "D:/p" }));
    vi.mocked(tauriOpen).mockResolvedValue(null);
    await expect(openFileDialog()).resolves.toBeNull();
  });
  it("openFolderDialog 将 Windows 反斜杠归一为正斜杠", async () => {
    vi.mocked(tauriOpen).mockResolvedValue("D:\\proj\\rtl");
    await expect(openFolderDialog()).resolves.toBe("D:/proj/rtl");
  });

  it("UNC 路径转为 //server/share，正斜杠路径不变", async () => {
    vi.mocked(tauriOpen).mockResolvedValue("\\\\server\\share\\proj");
    await expect(openFolderDialog()).resolves.toBe("//server/share/proj");
    vi.mocked(tauriOpen).mockResolvedValue("C:/already/fine");
    await expect(openFolderDialog()).resolves.toBe("C:/already/fine");
  });

  it("saveFileDialog 归一返回路径，取消返回 null", async () => {
    vi.mocked(tauriSave).mockResolvedValue("D:\\p\\sub\\a.v");
    await expect(saveFileDialog("D:/p")).resolves.toBe("D:/p/sub/a.v");
    vi.mocked(tauriSave).mockResolvedValue(null);
    await expect(saveFileDialog()).resolves.toBeNull();
  });
});
