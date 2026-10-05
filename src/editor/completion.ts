/**
 * HDL 补全：当前文件信号/例化名（复用大纲解析，按 model 版本缓存）、语法关键字与
 * 常用块 snippet、工程模块名（选中时懒解析端口生成例化骨架，仅 Verilog）。
 * 性能：击键路径只有单文件解析缓存与内存索引查询，端口解析在 resolve（选中）阶段。
 */
import { monaco, VERILOG_KEYWORDS, VHDL_KEYWORDS } from "./monaco";
import { moduleInstSnippet, fileSymbolItems } from "./completion-items";
import type { ModuleDef } from "../model";
import type { PortInfo } from "../parser";

export interface CompletionDeps {
  /** 工程模块索引（模块名补全），每次调用取最新 */
  allDefs(): ModuleDef[];
  /** 模块端口（选中例化补全项时才调用） */
  modulePorts(name: string): Promise<PortInfo[]>;
}

const VERILOG_SNIPPETS: { label: string; snippet: string; detail: string }[] = [
  {
    label: "always @(posedge …)",
    snippet: "always @(posedge ${1:i_clk} or negedge ${2:i_rst_n}) begin\n\t$0\nend",
    detail: "时序逻辑块",
  },
  {
    label: "always @(*)",
    snippet: "always @(*) begin\n\t$0\nend",
    detail: "组合逻辑块",
  },
  {
    label: "module … endmodule",
    snippet: "module ${1:name} (\n\t${2:ports}\n);\n\t$0\nendmodule",
    detail: "模块骨架",
  },
];

const VHDL_SNIPPETS: { label: string; snippet: string; detail: string }[] = [
  {
    label: "process(clk, rst_n)",
    snippet: "process(${1:i_clk}, ${2:i_rst_n})\nbegin\n\t$0\nend process;",
    detail: "进程骨架",
  },
];

export function registerCompletionProviders(deps: CompletionDeps): void {
  // 当前文件符号缓存：uri → model 版本对应的补全项
  const symbolCache = new Map<string, { version: number; items: { label: string; detail: string }[] }>();
  // resolve 阶段找回模块名（item 对象同一引用流经 resolve）
  const moduleItemMeta = new WeakMap<object, string>();

  function symbolsFor(model: monaco.editor.ITextModel): { label: string; detail: string }[] {
    const key = model.uri.toString();
    const version = model.getVersionId();
    const hit = symbolCache.get(key);
    if (hit?.version === version) return hit.items;
    const items = fileSymbolItems(model.getValue(), model.uri.path);
    symbolCache.set(key, { version, items });
    return items;
  }

  function makeProvider(lang: "verilog" | "vhdl"): monaco.languages.CompletionItemProvider {
    const keywords = lang === "verilog" ? VERILOG_KEYWORDS : VHDL_KEYWORDS;
    const snippets = lang === "verilog" ? VERILOG_SNIPPETS : VHDL_SNIPPETS;
    return {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        const K = monaco.languages.CompletionItemKind;
        const suggestions: monaco.languages.CompletionItem[] = [];

        for (const s of symbolsFor(model)) {
          suggestions.push({
            label: s.label,
            kind: s.detail === "信号" ? K.Variable : K.Struct,
            detail: s.detail,
            sortText: `1~${s.label}`,
            insertText: s.label,
            range,
          });
        }
        for (const def of deps.allDefs()) {
          const item: monaco.languages.CompletionItem = {
            label: def.name,
            kind: K.Module,
            detail: def.isIp ? "IP 核" : def.file.split("/").pop(),
            sortText: `2~${def.name}`,
            insertText: def.name,
            range,
          };
          if (lang === "verilog") moduleItemMeta.set(item, def.name);
          suggestions.push(item);
        }
        for (const kw of keywords) {
          suggestions.push({
            label: kw,
            kind: K.Keyword,
            sortText: `3~${kw}`,
            insertText: kw,
            range,
          });
        }
        for (const sn of snippets) {
          suggestions.push({
            label: sn.label,
            kind: K.Snippet,
            detail: sn.detail,
            sortText: `3~${sn.label}`,
            insertText: sn.snippet,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          });
        }
        return { suggestions };
      },
      async resolveCompletionItem(item) {
        // 选中 Verilog 模块项时懒解析端口，展开例化骨架
        const name = moduleItemMeta.get(item);
        if (!name) return item;
        try {
          const ports = await deps.modulePorts(name);
          item.insertText = moduleInstSnippet(name, ports);
          item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
        } catch {
          // 端口解析失败保留纯名插入
        }
        return item;
      },
    };
  }

  monaco.languages.registerCompletionItemProvider("verilog", makeProvider("verilog"));
  monaco.languages.registerCompletionItemProvider("vhdl", makeProvider("vhdl"));
}
