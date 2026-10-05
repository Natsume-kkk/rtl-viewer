import * as monaco from "monaco-editor";
// monaco-editor 0.57 的 exports 映射未开放深层 esm 路径，改用直接文件路径引入 worker
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import type { ModuleDef } from "../model";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export const VERILOG_KEYWORDS = [
  "module", "endmodule", "input", "output", "inout", "wire", "reg", "logic",
  "always", "always_ff", "always_comb", "always_latch", "assign", "if", "else",
  "case", "casez", "casex", "default", "endcase", "begin", "end", "generate",
  "endgenerate", "genvar", "for", "while", "parameter", "localparam", "function",
  "endfunction", "task", "endtask", "initial", "posedge", "negedge", "or",
  "typedef", "enum", "struct", "union", "packed", "interface", "endinterface",
  "package", "endpackage", "import", "return", "integer", "real", "time",
  "signed", "unsigned", "bit", "byte", "int", "tri", "supply0", "supply1",
];

const VERILOG_OPERATORS = [
  "and", "nand", "nor", "not", "xnor", "xor", "buf",
];

export const VHDL_KEYWORDS = [
  "entity", "architecture", "port", "signal", "variable", "constant", "process",
  "begin", "end", "if", "then", "else", "elsif", "case", "when", "others",
  "loop", "for", "while", "generate", "component", "map", "generic", "library",
  "use", "package", "body", "is", "of", "in", "out", "inout", "buffer", "type",
  "subtype", "record", "array", "std_logic", "std_logic_vector", "rising_edge",
  "falling_edge", "function", "procedure", "return", "wait", "until", "downto",
  "to", "integer", "natural", "boolean", "all", "configuration",
];

const VHDL_OPERATORS = [
  "and", "or", "not", "nand", "nor", "xor", "xnor", "mod", "rem", "abs", "sll",
  "srl", "sla", "sra", "rol", "ror",
];

function registerVerilog(): void {
  monaco.languages.register({ id: "verilog", extensions: [".v", ".sv", ".vh", ".svh"] });
  monaco.languages.setLanguageConfiguration("verilog", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["(", ")"], ["[", "]"], ["begin", "end"]],
    autoClosingPairs: [
      { open: "(", close: ")" }, { open: "[", close: "]" },
      { open: '"', close: '"' }, { open: "'", close: "'", notIn: ["string", "comment"] },
    ],
  });
  monaco.languages.setMonarchTokensProvider("verilog", {
    defaultToken: "",
    keywords: VERILOG_KEYWORDS,
    operators: VERILOG_OPERATORS,
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/`\w+/, "keyword.directive"],
        [/"/, "string", "@string"],
        [/\d*'[bodhBODH][0-9a-fA-FxzXZ_?]+/, "number.hex"],
        [/\d[\d_]*\.?\d*([eE][+-]?\d+)?/, "number"],
        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@operators": "keyword.operator",
            "@default": "identifier",
          },
        }],
        [/[;,.()[\]{}]/, "delimiter"],
        [/[<>=!+\-*/%&|^~?:#@]+/, "operator"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
    },
  } as monaco.languages.IMonarchLanguage);
}

function registerVhdl(): void {
  monaco.languages.register({ id: "vhdl", extensions: [".vhd", ".vhdl"] });
  monaco.languages.setLanguageConfiguration("vhdl", {
    comments: { lineComment: "--" },
    brackets: [["(", ")"], ["[", "]"]],
    autoClosingPairs: [
      { open: "(", close: ")" }, { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider("vhdl", {
    defaultToken: "",
    ignoreCase: true,
    keywords: VHDL_KEYWORDS,
    operators: VHDL_OPERATORS,
    tokenizer: {
      root: [
        [/--.*$/, "comment"],
        [/"/, "string", "@string"],
        [/'[a-zA-Z0-9_']'/, "string"],
        [/\d[\d_]*#\w[\w_]*#/, "number.hex"],
        [/\d[\d_]*\.?\d*([eE][+-]?\d+)?/, "number"],
        [/[a-zA-Z_]\w*/, {
          cases: {
            "@keywords": "keyword",
            "@operators": "keyword.operator",
            "@default": "identifier",
          },
        }],
        [/[;,.()[\]{}]/, "delimiter"],
        [/(:=|=>|<=|>=|\/=|[<>=!+\-*/%&|^~?])+/, "operator"],
      ],
      string: [
        [/[^"]+/, "string"],
        [/""/, "string.escape"],
        [/"/, "string", "@pop"],
      ],
    },
  } as monaco.languages.IMonarchLanguage);
}

export function langForFile(file: string): string {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  if (["v", "sv", "vh", "svh"].includes(ext)) return "verilog";
  if (["vhd", "vhdl"].includes(ext)) return "vhdl";
  // 约束文件本质是 Tcl 命令，复用 monaco 内置 tcl 高亮
  if (["xdc", "sdc"].includes(ext)) return "tcl";
  return "plaintext";
}

export type ResolveFn = (name: string) => ModuleDef | undefined;

function registerDefinitionProvider(resolve: ResolveFn): void {
  const provider: monaco.languages.DefinitionProvider = {
    provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const def = resolve(word.word);
      if (!def) return null;
      return {
        uri: monaco.Uri.parse(`file:///${def.file}`),
        range: new monaco.Range(def.line, 1, def.line, 1),
      };
    },
  };
  monaco.languages.registerDefinitionProvider("verilog", provider);
  monaco.languages.registerDefinitionProvider("vhdl", provider);
}

let registered = false;

function registerOnce(resolve: ResolveFn): void {
  if (registered) return;
  registered = true;
  registerVerilog();
  registerVhdl();
  registerDefinitionProvider(resolve);
}

/** 新建一个编辑器实例（分屏的第二视图用）；语言与 provider 须已通过 initMonaco 注册。 */
export function createEditor(container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  return monaco.editor.create(container, {
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: "none",
    mouseWheelZoom: true,
    tabSize: 4,
  });
}

export function initMonaco(container: HTMLElement, resolve: ResolveFn): monaco.editor.IStandaloneCodeEditor {
  registerOnce(resolve);
  return createEditor(container);
}

export { monaco };
