// 按需引入：不走 monaco-editor 整包入口（editor.main 会带上全部语言定义、
// css/html/json/ts 语言服务和 LSP 客户端，约 11 MB 永不加载的 chunk 进 exe）。
// 下面清单 = editor.main.js 的编辑器贡献部分（版本升级 monaco 时需同步核对）。
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget";
import "monaco-editor/editor/contrib/codelens/browser/codelensController";
import "monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution";
import "monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution";
import "monaco-editor/editor/contrib/dnd/browser/dnd";
import "monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution";
import "monaco-editor/features/find/register";
import "monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom";
import "monaco-editor/editor/contrib/format/browser/formatActions";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition";
import "monaco-editor/editor/contrib/gpu/browser/gpuActions";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/indentation/browser/indentation";
import "monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution";
import "monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution";
import "monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress";
import "monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace";
import "monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine";
import "monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens";
import "monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing";
import "monaco-editor/editor/contrib/links/browser/links";
import "monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper";
import "monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch";
import "monaco-editor/editor/contrib/rename/browser/rename";
import "monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders";
import "monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution";
import "monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions";
import "monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization";
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/common/standaloneStrings";
// 约束文件（xdc/sdc）高亮复用 tcl 语言定义；其余语言定义一律不打进包里
import "monaco-editor/languages/definitions/tcl/register";
// codicon 图标字体的 CSS；exports 映射（./* → ./esm/vs/*.js）无法指向 .css，走相对路径
import "../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";
// monaco-editor 0.57 的 exports 映射未开放深层 esm 路径，改用直接文件路径引入 worker
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import type { ModuleDef } from "../model";
import { installAltColumnDrag, registerNotepadKeymap } from "./notepad-keymap";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// 关键字清单与分组对齐 Notepad++ 官方 langs.xml 的 Verilog/VHDL 段
// （剔除原文中 case?、converse、privat 等明显拼写错误的条目）：
// 浅色主题为 Notepad++ 默认配色，深色主题为 VSCode Dark+ 配色。
// 导出的 VERILOG_KEYWORDS / VHDL_KEYWORDS 是全量并集，供 completion.ts 补全使用。

// Verilog instre1：全部关键字（Notepad++ 中染蓝加粗；and/or/nand 等也在其中）
export const VERILOG_KEYWORDS = [
  "accept_on", "alias", "always", "always_comb", "always_ff", "always_latch",
  "and", "assert", "assign", "assume", "attribute", "automatic", "before",
  "begin", "bind", "bins", "binsof", "bit", "break", "buf", "bufif0", "bufif1",
  "byte", "case", "casex", "casez", "cell", "chandle", "checker", "class",
  "clocking", "cmos", "config", "const", "constraint", "context", "continue",
  "cover", "covergroup", "coverpoint", "cross", "deassign", "default",
  "defparam", "design", "disable", "dist", "do", "edge", "else", "end",
  "endattribute", "endcase", "endchecker", "endclass", "endclocking",
  "endconfig", "endfunction", "endgenerate", "endgroup", "endinterface",
  "endmodule", "endpackage", "endprimitive", "endprogram", "endproperty",
  "endsequence", "endspecify", "endtable", "endtask", "enum", "event",
  "eventually", "expect", "export", "extends", "extern", "final", "first_match",
  "for", "force", "foreach", "forever", "fork", "forkjoin", "function",
  "generate", "genvar", "global", "highz0", "highz1", "if", "iff", "ifnone",
  "ignore_bins", "illegal_bins", "implements", "implies", "import", "incdir",
  "include", "initial", "inout", "input", "inside", "instance", "int",
  "integer", "interconnect", "interface", "intersect", "join", "join_any",
  "join_none", "large", "let", "liblist", "library", "local", "localparam",
  "logic", "longint", "macromodule", "matches", "medium", "modport", "module",
  "nand", "negedge", "nettype", "new", "nexttime", "nmos", "nor",
  "noshowcancelled", "not", "notif0", "notif1", "null", "or", "output",
  "package", "packed", "parameter", "pmos", "posedge", "primitive", "priority",
  "program", "property", "protected", "pull0", "pull1", "pulldown", "pullup",
  "pulsestyle_ondetect", "pulsestyle_onevent", "pure", "rand", "randc",
  "randcase", "randsequence", "rcmos", "real", "realtime", "ref", "reg",
  "reject_on", "release", "repeat", "restrict", "return", "rnmos", "rpmos",
  "rtran", "rtranif0", "rtranif1", "scalared", "sequence", "shortint",
  "shortreal", "showcancelled", "signed", "small", "soft", "solve", "specify",
  "specparam", "static", "string", "strong", "strong0", "strong1", "struct",
  "super", "supply0", "supply1", "sync_accept_on", "sync_reject_on", "s_always",
  "s_eventually", "s_nexttime", "s_until", "s_until_with", "table", "tagged",
  "task", "this", "throughout", "time", "timeprecision", "timeunit", "tran",
  "tranif0", "tranif1", "tri", "tri0", "tri1", "triand", "trior", "trireg",
  "type", "typedef", "union", "unique", "unique0", "unsigned", "until",
  "until_with", "untyped", "use", "var", "vectored", "virtual", "void", "wait",
  "wait_order", "wand", "weak", "weak0", "weak1", "while", "wildcard", "wire",
  "with", "within", "wor", "xnor", "xor",
];

// VHDL instre1：语句关键字（Notepad++ 中染蓝加粗）
const VHDL_INSTRUCTIONS = [
  "access", "after", "alias", "all", "architecture", "array", "assert",
  "attribute", "begin", "block", "body", "buffer", "bus", "case", "component",
  "configuration", "constant", "disconnect", "downto", "else", "elsif", "end",
  "entity", "exit", "file", "for", "force", "function", "generate", "generic",
  "group", "guarded", "if", "impure", "in", "index", "inertial", "inout", "is",
  "label", "library", "linkage", "literal", "loop", "map", "new", "next",
  "null", "of", "on", "open", "others", "out", "package", "port", "postponed",
  "procedure", "process", "pure", "range", "record", "register", "reject",
  "report", "return", "select", "severity", "shared", "signal", "subtype",
  "then", "to", "transport", "type", "unaffected", "units", "until", "use",
  "variable", "wait", "when", "while", "with", "assume", "assume_guarantee",
  "context", "cover", "default", "fairness", "parameter", "property",
  "protect", "protected", "reflect", "release", "restrict", "restrict_guarantee",
  "sequence", "strong", "value", "view", "vmode", "vprop", "vunit",
];

// VHDL instre2：标准操作符（Notepad++ 中染青蓝加粗）
const VHDL_STD_OPERATORS = [
  "abs", "and", "mod", "nand", "nor", "not", "or", "rem", "rol", "ror", "sla",
  "sll", "sra", "srl", "xnor", "xor",
];

// VHDL type1：属性（Notepad++ 中染紫蓝加粗、米色底）；range/value 在 instre1 优先，不重复收录
const VHDL_ATTRIBUTES = [
  "left", "right", "low", "high", "ascending", "image", "pos", "val", "succ",
  "pred", "leftof", "rightof", "base", "reverse_range", "length", "delayed",
  "stable", "quiet", "transaction", "event", "active", "last_event",
  "last_active", "last_value", "driving", "driving_value", "simple_name",
  "path_name", "instance_name", "minimum", "maximum",
];

// VHDL type2：标准函数（Notepad++ 中染亮蓝加粗）
const VHDL_STD_FUNCTIONS = [
  "now", "readline", "read", "writeline", "write", "endfile", "resolved",
  "to_bit", "to_bitvector", "to_stdulogic", "to_stdlogicvector",
  "to_stdulogicvector", "to_x01", "to_x01z", "to_ux01", "rising_edge",
  "falling_edge", "is_x", "shift_left", "shift_right", "rotate_left",
  "rotate_right", "resize", "to_integer", "to_unsigned", "to_signed",
  "to_string", "to_bstring", "to_binarystring", "to_ostring", "to_octalstring",
  "to_hstring", "to_hexstring", "std_match", "to_01",
];

// VHDL type3：标准包（Notepad++ 中染棕红）
const VHDL_STD_PACKAGES = [
  "std", "ieee", "work", "standard", "textio", "std_logic_1164",
  "std_logic_arith", "std_logic_misc", "std_logic_signed", "std_logic_textio",
  "std_logic_unsigned", "numeric_bit", "numeric_std", "math_complex",
  "math_real", "vital_primitives", "vital_timing",
];

// VHDL type4：标准类型（Notepad++ 中染紫）
const VHDL_STD_TYPES = [
  "boolean", "boolean_vector", "bit", "character", "severity_level", "integer",
  "integer_vector", "real", "real_vector", "time", "time_vector",
  "delay_length", "natural", "positive", "string", "bit_vector",
  "file_open_kind", "file_open_status", "line", "text", "side", "width",
  "std_ulogic", "std_ulogic_vector", "std_logic", "std_logic_vector", "x01",
  "x01z", "ux01", "ux01z", "unsigned", "signed", "unresolved_unsigned",
  "unresolved_signed", "u_unsigned", "u_signed",
];

export const VHDL_KEYWORDS = [
  ...VHDL_INSTRUCTIONS, ...VHDL_STD_OPERATORS, ...VHDL_ATTRIBUTES,
  ...VHDL_STD_FUNCTIONS, ...VHDL_STD_PACKAGES, ...VHDL_STD_TYPES,
];

function registerVerilog(): void {
  monaco.languages.register({ id: "verilog", extensions: [".v", ".sv", ".vh", ".svh"] });
  monaco.languages.setLanguageConfiguration("verilog", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["(", ")"], ["[", "]"], ["begin", "end"]],
    autoClosingPairs: [
      { open: "(", close: ")" }, { open: "[", close: "]" },
      { open: '"', close: '"' },
      // `'` 不配对：Verilog 里是 4'hF 这类数字字面量的分隔符，自动补全会干扰输入
    ],
  });
  monaco.languages.setMonarchTokensProvider("verilog", {
    defaultToken: "",
    keywords: VERILOG_KEYWORDS,
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/`\w+/, "keyword.directive"],
        [/"/, "string", "@string"],
        [/\d*'s?[bodhBODH][0-9a-fA-FxzXZ_?]+/, "number.hex"],
        [/'[01xXzZ](?![\w$])/, "number.hex"], // SV 无基数字面量 '0/'1/'x/'z
        [/\d[\d_]*\.?\d*([eE][+-]?\d+)?/, "number"],
        // 系统任务 $display/$finish 等：Notepad++ 默认未配置样式（黑色），深色下按 VSCode 函数色
        [/\$[a-zA-Z_]\w*/, "systemtask"],
        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            "@keywords": "keyword",
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
    instructions: VHDL_INSTRUCTIONS,
    stdOperators: VHDL_STD_OPERATORS,
    attributes: VHDL_ATTRIBUTES,
    stdFunctions: VHDL_STD_FUNCTIONS,
    stdPackages: VHDL_STD_PACKAGES,
    stdTypes: VHDL_STD_TYPES,
    tokenizer: {
      root: [
        [/--.*$/, "comment"],
        [/"/, "string", "@string"],
        [/'[a-zA-Z0-9_']'/, "string"],
        [/\d[\d_]*#\w[\w_]*#/, "number.hex"],
        [/\d[\d_]*\.?\d*([eE][+-]?\d+)?/, "number"],
        [/[a-zA-Z_]\w*/, {
          cases: {
            "@instructions": "keyword",
            "@stdOperators": "keyword.operator",
            "@attributes": "attribute",
            "@stdFunctions": "stdfunction",
            "@stdPackages": "stdpackage",
            "@stdTypes": "type",
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

// defineTheme 需要字面 hex，不能引用 CSS 变量。
// meridian-dark 沿用 VSCode Dark+ 色板；meridian-light 按需求采用
// Notepad++ 默认配色（官方 stylers.xml），与 meridian 设计令牌脱钩
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
    { token: "attribute", foreground: "4ec9b0" },
    { token: "stdpackage", foreground: "4ec9b0" },
    { token: "stdfunction", foreground: "dcdcaa" },
    { token: "systemtask", foreground: "dcdcaa" },
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
  // Notepad++ 默认配色（官方 stylers.xml 的 VHDL/Verilog 段）
  rules: [
    { token: "", foreground: "000000" },
    { token: "comment", foreground: "008000" },
    { token: "keyword", foreground: "0000FF", fontStyle: "bold" },
    { token: "keyword.operator", foreground: "0080C0", fontStyle: "bold" },
    { token: "keyword.directive", foreground: "804000" },
    { token: "attribute", foreground: "8080FF", background: "FFFFCC", fontStyle: "bold" },
    { token: "stdfunction", foreground: "0080FF", fontStyle: "bold" },
    { token: "stdpackage", foreground: "800000" },
    { token: "type", foreground: "8000FF" },
    { token: "variable", foreground: "8000FF" },
    { token: "string", foreground: "808080" },
    { token: "string.escape", foreground: "808080" },
    { token: "number", foreground: "FF8000" },
    { token: "number.hex", foreground: "FF8000" },
    { token: "identifier", foreground: "000000" },
    { token: "systemtask", foreground: "000000" },
    { token: "delimiter", foreground: "000080", fontStyle: "bold" },
    { token: "operator", foreground: "000080", fontStyle: "bold" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#000000",
    "editorLineNumber.foreground": "#808080",
    "editorLineNumber.activeForeground": "#000000",
    "editor.lineHighlightBackground": "#e8e8ff66",
    "editor.selectionBackground": "#c0c0c0",
    "editorCursor.foreground": "#000000",
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
  registerNotepadKeymap();
}

/** 新建一个编辑器实例（分屏的第二视图用）；语言与 provider 须已通过 initMonaco 注册。 */
export function createEditor(container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  const editor = monaco.editor.create(container, {
    theme: editorThemeName(),
    automaticLayout: true,
    fontSize: window.innerWidth <= 1320 ? 13 : 14,
    lineHeight: 24,
    padding: { top: 14, bottom: 30 },
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: "none",
    mouseWheelZoom: true,
    tabSize: 4,
  });
  installAltColumnDrag(editor);
  return editor;
}

export function initMonaco(container: HTMLElement, resolve: ResolveFn): monaco.editor.IStandaloneCodeEditor {
  registerOnce(resolve);
  return createEditor(container);
}

export { monaco };
