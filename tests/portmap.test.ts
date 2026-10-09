// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderPortMap, type PortMapData } from "../src/ui/portmap";
import { createPortMapLoader } from "../src/app/portmap";
import type { ModuleDef } from "../src/model";

describe("模块文件解析缓存", () => {
  const def: ModuleDef = { name: "m", file: "rtl/m.v", line: 1, isIp: false };
  function loaderWith(source: { content: string; token: unknown }) {
    return createPortMapLoader({
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

describe("端口映射侧栏", () => {
  const data: PortMapData = {
    instance: "u_clock", module: "clock", file: "rtl/top.v", line: 24, hasDefinition: true,
    rows: [
      { direction: "input", width: "", port: "clk", expr: "i_clk" },
      { direction: "output", width: "[7:0]", port: "data", expr: "{a, b}" },
      { direction: "output", width: "", port: "unused", expr: "" },
    ],
  };
  const actions = () => ({ close: vi.fn(), definition: vi.fn(), origin: vi.fn(), port: vi.fn(), signal: vi.fn() });
  it("查看实例无需钉住，连接跳转保留面板内容", () => {
    const root = document.createElement("aside"), cb = actions();
    renderPortMap(root, data, cb);
    expect(root.querySelector(".pin-status")).toBeNull();
    root.querySelector<HTMLButtonElement>(".pm-link")!.click();
    expect(cb.signal).toHaveBeenCalledWith("i_clk");
    expect(root.querySelector("h2")?.textContent).toBe("u_clock");
    expect(cb.close).not.toHaveBeenCalled();
  });
  it("保持真实连接、端口与例化位置跳转，并允许收起", () => {
    const root = document.createElement("aside"), cb = actions();
    renderPortMap(root, data, cb);
    root.querySelector<HTMLButtonElement>(".pm-link")!.click();
    expect(cb.signal).toHaveBeenCalledWith("i_clk");
    root.querySelector<HTMLButtonElement>(".port-name")!.click();
    expect(cb.port).toHaveBeenCalledWith("clk");
    root.querySelector<HTMLButtonElement>(".mapping-origin button")!.click();
    expect(cb.origin).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>(".mapping-identity button")!.click();
    expect(cb.definition).toHaveBeenCalledOnce();
    root.querySelector<HTMLButtonElement>(".icon-button")!.click();
    expect(cb.close).toHaveBeenCalledOnce();
    expect(root.querySelectorAll(".pm-link")).toHaveLength(1);
    expect(root.querySelector(".port-expression")?.textContent).toBe("{a, b}");
    expect(root.querySelector(".pm-unconnected")?.textContent).toBe("（未连接）");
  });
  it("无定义的 IP 不提供无效定义操作，空表可收起且名称按文本渲染", () => {
    const root = document.createElement("aside");
    renderPortMap(root, { ...data, instance: "<img src=x>", hasDefinition: false, rows: [] }, actions());
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("h2")?.textContent).toBe("<img src=x>");
    expect(root.querySelector(".mapping-identity button")).toBeNull();
    expect(root.textContent).toContain("暂无可解析的端口连接");
    expect(root.querySelector("button[aria-label='收起端口映射']")).toBeTruthy();
  });
});
