// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { configuredPath, loadSyntaxOptions, saveSyntaxOptions, validateSyntaxOptions } from "../src/app/syntax-options";
import { emptySyntaxCheckOptions } from "../src/ipc";
import { showSyntaxOptionsDialog } from "../src/ui/syntax-options";

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

it("配置按工程保存并校验宏、顶层和 library", () => {
  const options = {
    top: "sample_top",
    defines: ["DEBUG=1", "SYNTHESIS"],
    includeDirs: ["include"],
    vhdlLibraries: [{ library: "vendor", file: "ip/vendor.vhd" }],
    verilatorArgs: ["--Wno-DECLFILENAME"],
    ghdlArgs: ["-frelaxed-rules"],
  };
  saveSyntaxOptions("D:/Demo", options);
  expect(loadSyntaxOptions("D:/Demo")).toEqual(options);
  expect(loadSyntaxOptions("D:/Other")).toEqual(emptySyntaxCheckOptions);
  expect(validateSyntaxOptions(options)).toEqual([]);
  expect(validateSyntaxOptions({ ...options, top: "bad name", defines: ["BAD-DEFINE"] })).toHaveLength(2);
  expect(configuredPath("D:/Demo", "include")).toBe("D:/Demo/include");
  expect(configuredPath("D:/Demo", "E:/shared/include")).toBe("E:/shared/include");
});

it("配置对话框支持路径选择、结构化参数和默认折叠的高级设置", async () => {
  const browseInclude = vi.fn(async () => "include");
  const browseLibrary = vi.fn(async () => "ip/vendor.vhd");
  const pending = showSyntaxOptionsDialog(emptySyntaxCheckOptions, { browseInclude, browseLibrary });
  const top = document.querySelector<HTMLInputElement>("input")!;
  top.value = "demo_top";
  const areas = document.querySelectorAll("textarea");
  areas[0].value = "DEBUG=1";
  [...document.querySelectorAll("button")].find(button => button.textContent === "添加目录")!.click();
  await vi.waitFor(() => expect(areas[1].value).toBe("include"));
  [...document.querySelectorAll("button")].find(button => button.textContent === "添加映射文件")!.click();
  await vi.waitFor(() => expect(areas[2].value).toBe("vendor=ip/vendor.vhd"));
  expect(document.querySelector<HTMLDetailsElement>(".syntax-options-advanced")!.open).toBe(false);
  [...document.querySelectorAll("button")].find(button => button.textContent === "保存配置")!.click();
  const result = await pending;
  expect(result?.top).toBe("demo_top");
  expect(result?.defines).toEqual(["DEBUG=1"]);
  expect(result?.includeDirs).toEqual(["include"]);
  expect(result?.vhdlLibraries).toEqual([{ library: "vendor", file: "ip/vendor.vhd" }]);
  const cancelled = showSyntaxOptionsDialog(emptySyntaxCheckOptions);
  [...document.querySelectorAll("button")].find(button => button.textContent === "取消")!.click();
  expect(await cancelled).toBeUndefined();
});
