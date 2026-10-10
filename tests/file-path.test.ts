import { expect, it } from "vitest";
import { pathFromUri } from "../src/editor/file-path";

it("Monaco 已解码路径保留字面量百分号与 UNC authority", () => {
  expect(pathFromUri({ path: "/D:/p/100%#name?.v", authority: "" })).toBe("D:/p/100%#name?.v");
  expect(pathFromUri({ path: "/share/编码%20.v", authority: "server" })).toBe("//server/share/编码%20.v");
});
