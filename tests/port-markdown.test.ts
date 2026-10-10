import { expect, it } from "vitest";
import { portMapMarkdown } from "../src/app/port-markdown";

it("源表达式中的 Markdown/HTML/换行不会生成额外命令或破坏表格", () => {
  const value = portMapMarkdown("u_name", "m", [{ direction: "input", port: "i_data", width: "", expr: '[run](command:external) | <img src=x>\nnext' }], "D:/p/a.v");
  expect(value.isTrusted).toEqual({ enabledCommands: ["rtl.gotoPort", "rtl.gotoSignal"] });
  expect(value.value).toContain("i\\_data");
  expect(value.value).toContain('\\[run\\]\\(command:external\\) \\| \\<img src=x\\> next');
  expect(value.value.split("\n")).toHaveLength(5);
});
