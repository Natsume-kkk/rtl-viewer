// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { PathBreadcrumb } from "../src/ui/breadcrumb";
import { closeCtxMenu } from "../src/ui/menu";

afterEach(() => { closeCtxMenu(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("工程路径按 Windows 身份显示相对目录，完整路径菜单仍可打开祖先与复制", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const root = document.createElement("div"), open = vi.fn(), reveal = vi.fn(); document.body.append(root);
  const breadcrumb = new PathBreadcrumb(root, open, reveal);
  breadcrumb.setPath("D:\\work\\Project\\rtl\\top.v", "top.v", "d:/WORK/project/");
  expect(root.textContent).toBe("…›Project›rtl›top.v");
  expect(root.title).toBe("D:\\work\\Project\\rtl\\top.v");
  root.querySelector<HTMLButtonElement>('[aria-label="查看完整路径"]')!.click();
  expect(document.querySelector(".ctx-menu")?.textContent).toContain("D:/work");
  expect(document.querySelector(".ctx-menu")?.textContent).toContain("复制文件路径");
  closeCtxMenu();
  root.querySelector<HTMLButtonElement>(".path-file")!.click(); expect(reveal).toHaveBeenCalledWith("D:/work/Project/rtl/top.v");
  Object.defineProperty(root, "scrollWidth", { value: 600 });
  Object.defineProperty(root, "clientWidth", { value: 200 });
  breadcrumb.setPath("D:/work/Project/a/b/top.v", "top.v", "D:/work/Project");
  expect(root.textContent).toBe("…›b›top.v"); expect(root.querySelectorAll(".path-overflow")).toHaveLength(1);
  breadcrumb.dispose();
});

it("相邻同前缀目录标记工程外，UNC、盘符根及未命名文件不误判", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const root = document.createElement("div");
  const breadcrumb = new PathBreadcrumb(root, vi.fn(), vi.fn());
  breadcrumb.setPath("D:/proj-copy/top.v", "top.v", "D:/proj"); expect(root.textContent).toContain("工程外");
  breadcrumb.setPath("//server/share/proj/top.v", "top.v", "\\\\SERVER\\share\\proj"); expect(root.textContent).toBe("…›proj›top.v");
  breadcrumb.setPath("D:/rtl/top.v", "top.v", "d:/"); expect(root.textContent).toBe("D:›rtl›top.v");
  breadcrumb.setPath("", "未命名.v", "D:/proj"); expect(root.textContent).toBe("未命名.v");
  breadcrumb.dispose();
});
