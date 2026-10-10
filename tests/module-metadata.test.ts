import { describe, expect, it } from "vitest";
import { createModuleMetadataLoader } from "../src/app/module-metadata";
import type { ModuleDef } from "../src/model";

describe("模块文件解析缓存", () => {
  const def: ModuleDef = { name: "m", file: "rtl/m.v", line: 1, isIp: false };
  function loaderWith(source: { content: string; token: unknown }) {
    return createModuleMetadataLoader({
      ips: () => [],
      resolveModule: () => def,
      fileContent: () => source.content,
      fileToken: () => source.token,
    });
  }
  it("内容令牌不变复用解析结果，令牌变化后重新解析", async () => {
    const source = { content: "module m #(parameter W = 8) (input clk); endmodule", token: 1 };
    const loader = loaderWith(source);
    expect((await loader.modulePorts("m")).map(p => p.name)).toEqual(["clk"]);
    expect(loader.moduleParameters("m").map(p => p.name)).toEqual(["W"]);
    source.content = "module m #(parameter W = 8) (input clk, output q); endmodule";
    expect((await loader.modulePorts("m")).map(p => p.name)).toEqual(["clk"]);
    source.token = 2;
    expect((await loader.modulePorts("m")).map(p => p.name)).toEqual(["clk", "q"]);
  });
  it("reset 清空模块文件缓存，reset 后仍可正常使用", async () => {
    const source = { content: "module m(input clk); endmodule", token: 1 };
    const loader = loaderWith(source);
    await loader.modulePorts("m");
    loader.reset();
    source.content = "module m(input clk, output q); endmodule";
    expect((await loader.modulePorts("m")).map(p => p.name)).toEqual(["clk", "q"]);
  });
});
