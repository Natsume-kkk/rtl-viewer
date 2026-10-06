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

// 色值照录设计令牌 sources/tokens.css（design-agent/outputs/rtl-viewer-meridian），
// defineTheme 需要字面 hex，不能引用 CSS 变量
const MERIDIAN_DARK: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6a9955" },
    { token: "keyword", foreground: "569cd6" },
    { token: "keyword.operator", foreground: "569cd6" },
    { token: "keyword.directive", foreground: "c586c0" },
    { token: "string", foreground: "ce9178" },
    { token: "string.escape", foreground: "ce9178" },
    { token: "number", foreground: "b5cea8" },
    { token: "number.hex", foreground: "b5cea8" },
    { token: "identifier", foreground: "d6d9dd" },
    { token: "delimiter", foreground: "d6d9dd" },
    { token: "operator", foreground: "d6d9dd" },
    { token: "type", foreground: "4ec9b0" },
    { token: "variable", foreground: "4ec9b0" },
  ],
  colors: {
    "editor.background": "#16191d",
    "editor.foreground": "#d6d9dd",
    "editorLineNumber.foreground": "#5b636c",
    "editorLineNumber.activeForeground": "#969da5",
    "editor.lineHighlightBackground": "#ffffff0b",
    "editor.selectionBackground": "#264f7899",
    "editorCursor.foreground": "#d6d9dd",
    "editorWhitespace.foreground": "#2d333a",
    "editorIndentGuide.background1": "#2d333a",
    "editorBracketMatch.border": "#3d454e",
    "editorWidget.background": "#282e35",
    "editorHoverWidget.background": "#282e35",
    "editorWidget.border": "#3d454e",
    "editorHoverWidget.border": "#3d454e",
    "minimap.background": "#16191d",
    "editorOverviewRuler.border": "#00000000",
    "scrollbarSlider.background": "#ffffff24",
    "scrollbarSlider.hoverBackground": "#ffffff3d",
    "scrollbarSlider.activeBackground": "#ffffff3d",
  },
};

const MERIDIAN_LIGHT: monaco.editor.IStandaloneThemeData = {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "3a7a30" },
    { token: "keyword", foreground: "0451a5" },
    { token: "keyword.operator", foreground: "0451a5" },
    { token: "keyword.directive", foreground: "8734b0" },
    { token: "string", foreground: "a31515" },
    { token: "string.escape", foreground: "a31515" },
    { token: "number", foreground: "098658" },
    { token: "number.hex", foreground: "098658" },
    { token: "identifier", foreground: "24292f" },
    { token: "delimiter", foreground: "24292f" },
    { token: "operator", foreground: "24292f" },
    { token: "type", foreground: "267f99" },
    { token: "variable", foreground: "267f99" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#24292f",
    "editorLineNumber.foreground": "#9aa1a9",
    "editorLineNumber.activeForeground": "#5b636c",
    "editor.lineHighlightBackground": "#0000000a",
    "editor.selectionBackground": "#add6ff",
    "editorCursor.foreground": "#24292f",
    "editorWhitespace.foreground": "#dde0e5",
    "editorIndentGuide.background1": "#dde0e5",
    "editorBracketMatch.border": "#c3c9d1",
    "editorWidget.background": "#ffffff",
    "editorHoverWidget.background": "#ffffff",
    "editorWidget.border": "#c3c9d1",
    "editorHoverWidget.border": "#c3c9d1",
    "minimap.background": "#ffffff",
    "editorOverviewRuler.border": "#00000000",
    "scrollbarSlider.background": "#0000002e",
    "scrollbarSlider.hoverBackground": "#0000004d",
    "scrollbarSlider.activeBackground": "#0000004d",
  },
};

export function setEditorTheme(theme: "dark" | "light"): void {
  monaco.editor.setTheme(theme === "light" ? "meridian-light" : "meridian-dark");
}

monaco.editor.defineTheme("meridian-dark", MERIDIAN_DARK);
monaco.editor.defineTheme("meridian-light", MERIDIAN_LIGHT);

function editorThemeName(): string {
  return document.documentElement.dataset.theme === "light" ? "meridian-light" : "meridian-dark";
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
    theme: editorThemeName(),
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
