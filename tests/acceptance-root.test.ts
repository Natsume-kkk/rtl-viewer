import { afterEach, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { acceptanceRoot } from "./helpers/acceptance-root";

afterEach(() => vi.unstubAllEnvs());

it("可选私有工程不配置时返回空，配置后解析为真实目录", () => {
  vi.stubEnv("RTL_VIEWER_ACCEPTANCE_P1", "");
  expect(acceptanceRoot("RTL_VIEWER_ACCEPTANCE_P1")).toBeUndefined();
  vi.stubEnv("RTL_VIEWER_ACCEPTANCE_P1", "tests/samples/basic");
  expect(acceptanceRoot("RTL_VIEWER_ACCEPTANCE_P1")).toBe(realpathSync("tests/samples/basic"));
});

it.each(["tests/samples/missing-project", "package.json"])("显式配置无效时失败：%s", (path) => {
  vi.stubEnv("RTL_VIEWER_ACCEPTANCE_P1", path);
  expect(() => acceptanceRoot("RTL_VIEWER_ACCEPTANCE_P1")).toThrow("RTL_VIEWER_ACCEPTANCE_P1");
});
