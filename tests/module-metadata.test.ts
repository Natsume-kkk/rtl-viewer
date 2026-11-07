import { describe, expect, it, vi } from "vitest";
import { readFile } from "../src/ipc";
import { createModuleMetadataLoader } from "../src/app/module-metadata";

import type { ModuleDef } from "../src/model";
import { ModuleIndex } from "../src/model";
import { scanStructure } from "../src/parser";

vi.mock("../src/ipc", () => ({ readFile: vi.fn() }));

it.each([false,true])("分文件 entity 的定义、端口及参数不依赖扫描排序（反序=%s）", async reverse => {
  const entries:[string,string][]=[
    ["a_arch.vhd","architecture rtl of leaf is begin end rtl;"],
    ["z_entity.vhd","entity leaf is generic(W:integer:=8); port(a:in bit;q:out bit); end leaf;"],
  ];
  const files=new Map(reverse ? entries.reverse() : entries), index=new ModuleIndex();
  for(const[file,source]of files) index.addStructure(scanStructure(source,file));
  const loader=createModuleMetadataLoader({ips:()=>[],resolveModule:name=>index.resolve(name),fileContent:file=>files.get(file),fileToken:file=>({identity:file,version:files.get(file)})});
  expect(index.resolve("leaf")?.file).toBe("z_entity.vhd");
  expect((await loader.modulePorts("leaf")).map(port=>port.name)).toEqual(["a","q"]);
  expect(loader.moduleParameters("leaf").map(parameter=>parameter.name)).toEqual(["W"]);
});

it("重复定义不提供跳转或端口补全，也不回退到同名 IP", async () => {
  const index=new ModuleIndex();
  index.addStructure(scanStructure("module core(input a); endmodule", "a.v"));
  index.addStructure(scanStructure("module core(output b); endmodule", "b.v"));
  index.addIp("core", "ip/core.xci");
  const loader=createModuleMetadataLoader({ips:()=>[{name:"core",file:"ip/core.xci"}],resolveModule:name=>index.resolve(name),fileContent:()=>undefined,fileToken:file=>({identity:file,version:1})});
  expect(index.resolve("core")).toBeUndefined(); expect(index.allDefs()).toEqual([]);
  expect(await loader.modulePorts("core")).toEqual([]);
});

it("IP 只读取端口和参数接口并缓存，不返回内部实现", async () => {
  vi.mocked(readFile).mockResolvedValue({ content: "module core #(parameter W = 8) (input clk, output [W-1:0] q); wire secret; endmodule", encoding: "utf8", mtime: 1 });
  const index = new ModuleIndex();
  index.addIp("core", "ip/core.xci");
  const loader = createModuleMetadataLoader({ ips: () => [{ name: "core", file: "ip/core.xci" }], resolveModule: name => index.resolve(name), fileContent: () => undefined, fileToken: file => ({ identity: file, version: 1 }) });
  expect((await loader.modulePorts("core")).map(port => [port.name, port.direction, port.width])).toEqual([["clk", "input", undefined], ["q", "output", "[W-1:0]"]]);
  expect((await loader.moduleIpParameters("core")).map(parameter => parameter.name)).toEqual(["W"]);
  expect(readFile).toHaveBeenCalledOnce();
});

describe("模块文件解析缓存", () => {
  const def: ModuleDef = { name: "m", file: "rtl/m.v", line: 1, isIp: false };
  function loaderWith(source: { content: string; token: unknown; identity?: object }) {
    return createModuleMetadataLoader({
      ips: () => [],
      resolveModule: () => def,
      fileContent: () => source.content,
      fileToken: () => ({ identity: source.identity ?? def, version: source.token }),
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
  it("重新打开文件的新模型即使版本号相同也不复用旧端口", async () => {
    const source = { content: "module m(input clk); endmodule", token: 1, identity: {} };
    const loader = loaderWith(source);
    expect((await loader.modulePorts("m")).map(port => port.name)).toEqual(["clk"]);
    source.identity = {};
    source.content = "module m(input clk, output result); endmodule";
    expect((await loader.modulePorts("m")).map(port => port.name)).toEqual(["clk", "result"]);
  });
});


it("IP 缓存失效后重新读取最新接口", async () => {
  vi.mocked(readFile)
    .mockResolvedValueOnce({ content: "module core(input a); endmodule", encoding: "utf8", mtime: 1 })
    .mockResolvedValueOnce({ content: "module core(input a, output q); endmodule", encoding: "utf8", mtime: 2 });
  const index = new ModuleIndex();
  index.addIp("core", "ip/core.xci");
  const loader = createModuleMetadataLoader({ ips: () => [{ name: "core", file: "ip/core.xci" }], resolveModule: name => index.resolve(name), fileContent: () => undefined, fileToken: file => ({ identity: file, version: 1 }) });
  expect((await loader.modulePorts("core")).map(port => port.name)).toEqual(["a"]);
  loader.invalidateIps();
  expect((await loader.modulePorts("core")).map(port => port.name)).toEqual(["a", "q"]);
});
