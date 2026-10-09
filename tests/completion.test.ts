import { describe, expect, it, vi } from "vitest";
import { moduleInstSnippet, fileSymbolItems } from "../src/editor/completion-items";
import type { PortInfo } from "../src/parser";
import { connectionContext, instantiationContext } from "../src/editor/completion-context";
import { stripComments } from "../src/parser/verilog";
import { registerCompletionProviders } from "../src/editor/completion";
import * as monacoModule from "../src/editor/monaco";

vi.mock("../src/editor/monaco", () => {
  class Range {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number,
    ) {}
  }
  const providers = new Map<string, unknown>();
  return {
    monaco: {
      Range,
      languages: {
        CompletionItemKind: { Field: 5, Module: 8, Keyword: 17, Snippet: 25, Variable: 4, Struct: 22 },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider: (lang: string, provider: unknown) => providers.set(lang, provider),
      },
    },
    VERILOG_KEYWORDS: [] as string[],
    VHDL_KEYWORDS: [] as string[],
    __providers: providers,
  };
});

vi.mock("../src/parser/verilog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/parser/verilog")>();
  return { ...actual, stripComments: vi.fn(actual.stripComments) };
});

describe("例化骨架 snippet", () => {
  it("VHDL 生成 entity 和 port map，保留已输入的例化标签与库", () => {
    expect(moduleInstSnippet("child", [{ name: "clk" }, { name: "q" }], "vhdl")).toBe("${1:u_child} : entity work.child\n\tport map (\n\t\tclk => ${2:clk},\n\t\tq => ${3:q}\n\t);");
    expect(moduleInstSnippet("child", [{ name: "clk" }], "vhdl", "dut", "lib")).toContain("dut : entity lib.child");
    expect(moduleInstSnippet("empty", [], "vhdl")).toBe("${1:u_empty} : entity work.empty;$0");
  });
  it("端口名为固定文本，连接信号为同名 Tab 占位，编号连续", () => {
    const ports: PortInfo[] = [
      { name: "i_clk", direction: "input", width: "" },
      { name: "o_data", direction: "output", width: "[7:0]" },
    ];
    const s = moduleInstSnippet("cl_clock_reset", ports);
    expect(s).toBe(
      "cl_clock_reset ${1:u_cl_clock_reset} (\n" +
        "\t.i_clk(${2:i_clk}),\n" +
        "\t.o_data(${3:o_data})\n" +
        ");",
    );
  });

  it("无端口信息时退化为空括号", () => {
    expect(moduleInstSnippet("glbl", [])).toBe("glbl ${1:u_glbl} ($0);");
  });

  it("端口名含 $ 时转义不破坏 snippet 语法", () => {
    const s = moduleInstSnippet("mod", [{ name: "a$b", direction: "input", width: "" }]);
    expect(s).toContain(".a\\$b(${2:a\\$b})");
  });
});

describe("未写完的例化补全上下文", () => {
  const context = (s: string, lang: "vhdl" | "verilog") => connectionContext(s, s.length, lang);
  it("Verilog 参数后端口补全排除已连接端口，表达式内补信号", () => {
    expect(context("child #(.W(8)) u (.clk(clk), .", "verilog")).toMatchObject({ module: "child", used: ["clk"], value: false, dot: true });
    expect(context("child u (.clk(cl", "verilog")?.value).toBe(true);
    expect(context("module top(input cl", "verilog")).toBeUndefined();
  });
  it("VHDL 架构/generic map 后支持 port map 和大小写写法", () => {
    expect(context("u : entity work.child(rtl) generic map (W => 8) PORT MAP (CLK => clk, ", "vhdl")).toMatchObject({ module: "child", used: ["CLK"], value: false });
    expect(context("u : child port map (clk => cl", "vhdl")?.value).toBe(true);
    expect(instantiationContext("  dut : entity lib.", "vhdl")).toEqual({ start: 2, label: "dut", library: "lib" });
    expect(instantiationContext("assign a = ", "verilog")).toBeUndefined();
  });
});

describe("当前文件符号补全项", () => {
  it("连接右侧补全包含两种语言的头部端口和参数", () => {
    expect(fileSymbolItems("module m #(parameter W=8)(input clk); endmodule", "m.v").map(i => i.label)).toEqual(expect.arrayContaining(["clk", "W"]));
    expect(fileSymbolItems("entity m is generic(W:integer:=8); port(clk:in bit); end m;", "m.vhd").map(i => i.label)).toEqual(expect.arrayContaining(["clk", "W"]));
  });
  it("提取信号与例化名，去重", () => {
    const items = fileSymbolItems(
      `module top;
  reg [2:0] s_state;
  wire w_en;
  sub u_sub (.x(s_state));
endmodule`,
      "top.v",
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("s_state");
    expect(labels).toContain("w_en");
    expect(labels).toContain("u_sub");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("例化名 detail 带模块名，信号 detail 为信号", () => {
    const items = fileSymbolItems(
      `module top;
  reg r_a;
  sub u_sub (.x(r_a));
endmodule`,
      "top.v",
    );
    expect(items.find((i) => i.label === "u_sub")?.detail).toBe("u_sub : sub");
    expect(items.find((i) => i.label === "r_a")?.detail).toBe("信号");
  });
});

describe("连接上下文清洗文本按 model 版本缓存", () => {
  interface TestProvider {
    provideCompletionItems(
      model: unknown,
      position: { lineNumber: number; column: number },
      context: unknown,
      token: { isCancellationRequested: boolean },
    ): Promise<{ suggestions: { label: unknown }[] }>;
  }

  function fakeModel(text: string) {
    let value = text;
    let version = 1;
    return {
      uri: { toString: () => "file:///t.v", path: "/t.v" },
      getValue: () => value,
      setValue: (v: string) => {
        value = v;
        version += 1;
      },
      getVersionId: () => version,
      isDisposed: () => false,
      getOffsetAt: () => value.length,
      getLineContent: () => value,
      getWordUntilPosition: (position: { column: number }) => ({ startColumn: position.column, endColumn: position.column }),
    };
  }

  it("同一版本不重复清洗全文，编辑后重新计算且结果一致", async () => {
    registerCompletionProviders({
      allDefs: () => [],
      modulePorts: async () => [{ name: "clk" }, { name: "rst" }],
      moduleParameters: () => [],
    });
    const providers = (monacoModule as unknown as { __providers: Map<string, TestProvider> }).__providers;
    const provider = providers.get("verilog");
    expect(provider).toBeDefined();
    const model = fakeModel("child u (.clk(clk), .");
    const position = () => ({ lineNumber: 1, column: model.getValue().length + 1 });
    const token = { isCancellationRequested: false };
    const strip = vi.mocked(stripComments);
    strip.mockClear();

    const first = await provider!.provideCompletionItems(model, position(), {}, token);
    const second = await provider!.provideCompletionItems(model, position(), {}, token);
    expect(strip).toHaveBeenCalledTimes(1);
    expect(first.suggestions.map((s) => s.label)).toEqual(["rst"]);
    expect(second.suggestions.map((s) => s.label)).toEqual(first.suggestions.map((s) => s.label));

    model.setValue("child u (.clk(clk), .r");
    const third = await provider!.provideCompletionItems(model, position(), {}, token);
    expect(strip).toHaveBeenCalledTimes(2);
    expect(third.suggestions.map((s) => s.label)).toEqual(["rst"]);
  });
});
