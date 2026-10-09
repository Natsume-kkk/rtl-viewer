import type { HdlLang } from "../parser";

export interface Expr {
  kind: "ref" | "literal" | "op" | "select" | "slice" | "concat" | "call" | "unknown" | "cast";
  value: string;
  args: Expr[];
  start: number;
  end: number;
  text: string;
  current?: boolean;
  procedural?: boolean;
  /** 原过程的时钟保护条件；用于代码呈现，不参与求值。 */
  event?: string;
  eventStart?: number;
  assignment?: { start: number; end: number };
  branch?: { kind: "if" | "case"; group: number; header?: string; guard: string; alternate: string; alternateStart: number };
}
export interface Token { text: string; start: number; end: number }
export function tokens(text: string, offset = 0): Token[] {
  const re = /[boxd]"[^"]*"|"(?:""|[^"\n])*"|'[^'\n]'|\d*'[sS]?[bBoOdDhH][\da-fA-F_xXzZ?]+|'[01xXzZ]|\d+#[\da-fA-F_]+#|\d[\d_]*|===|!==|>>>|<<<|\*\*|<=|>=|==|!=|:=|=>|\/=|&&|\|\||<<|>>|~\^|\^~|~&|~\||[a-zA-Z_$][\w$]*|\S/gi;
  return [...text.matchAll(re)].map(m => ({ text: m[0], start: offset + m.index!, end: offset + m.index! + m[0].length }));
}
export const reference = (name: string, start = 0, end = start + name.length): Expr => ({ kind: "ref", value: name, text: name, start, end, args: [] });
export function formatExpr(e: Expr): string {
  if (e.kind === "cast") return `写入 ${e.value}(${formatExpr(e.args[0])})`;
  if (e.kind === "select") return e.procedural
    ? `if ${formatExpr(e.args[0])} then ${formatExpr(e.args[1])} else ${formatExpr(e.args[2])}`
    : `(${formatExpr(e.args[0])} ? ${formatExpr(e.args[1])} : ${formatExpr(e.args[2])})`;
  if (e.kind === "op") return e.args.length === 1 ? `${e.value}(${formatExpr(e.args[0])})` : `(${formatExpr(e.args[0])} ${e.value} ${formatExpr(e.args[1])})`;
  if (e.kind === "concat") return `{${e.args.map(formatExpr).join(", ")}}`;
  if (e.kind === "slice") return `${formatExpr(e.args[0])}[${e.args.slice(1).map(formatExpr).join(":")}]`;
  return e.text;
}
export function choose(cond: Expr, yes: Expr, no: Expr, branch?: Expr["branch"]): Expr {
  if (yes === no || !branch && ["ref", "literal"].includes(yes.kind) && yes.kind === no.kind && yes.value === no.value && yes.current === no.current && yes.event === no.event) return yes;
  return { kind: "select", value: "选择", args: [cond, yes, no], start: cond.start, end: Math.max(yes.end, no.end), text: "", procedural: true, branch };
}
export function substitute(e: Expr, values: Map<string, Expr>): Expr {
  if (e.kind === "ref") return values.get(e.value) ?? e;
  return { ...e, args: e.args.map(a => substitute(a, values)) };
}
export function refs(e: Expr): string[] {
  return [...new Set(e.kind === "ref" ? [e.value] : e.args.flatMap(refs))];
}

/** 有界表达式解析；无法完整消费时返回原文边界，不以部分树冒充完整表达式。 */
export function parseExpression(text: string, lang: HdlLang, offset = 0, vectors = new Set<string>()): Expr {
  const ts = tokens(text, offset);
  let pos = 0, depth = 0;
  const norm = (s: string) => lang === "vhdl" ? s.toLowerCase() : s;
  const peek = () => norm(ts[pos]?.text ?? "");
  const take = () => ts[pos++];
  const expect = (s: string) => { if (peek() !== s) throw Error("不完整表达式"); return take(); };
  const precedence: Record<string, number> = lang === "vhdl"
    ? { or: 2, xor: 2, xnor: 2, nor: 2, and: 2, nand: 2, "=": 3, "/=": 3, "<": 3, ">": 3, "<=": 3, ">=": 3, sll: 4, srl: 4, sla: 4, sra: 4, rol: 4, ror: 4, "+": 5, "-": 5, "&": 5, "*": 6, "/": 6, mod: 6, rem: 6, "**": 7 }
    : { "||": 2, "&&": 3, "|": 4, "^": 5, "~^": 5, "^~": 5, "&": 6, "==": 7, "!=": 7, "===": 7, "!==": 7, "<": 8, ">": 8, "<=": 8, ">=": 8, "<<": 9, ">>": 9, ">>>": 9, "<<<": 9, "+": 10, "-": 10, "*": 11, "/": 11, "%": 11, "**": 12 };
  const make = (kind: Expr["kind"], value: string, args: Expr[], start: number, end: number): Expr =>
    ({ kind, value, args, start, end, text: text.slice(start - offset, end - offset) });
  function parse(min = 0): Expr {
    if (++depth > 100) throw Error("表达式过深");
    const t = take();
    if (!t) throw Error("空表达式");
    let e: Expr;
    const word = norm(t.text);
    const unary = lang === "vhdl" ? ["not", "abs", "+", "-"] : ["!", "~", "+", "-", "&", "|", "^", "~&", "~|", "~^"];
    if (unary.includes(word)) {
      const a = parse(13); e = make("op", word, [a], t.start, a.end);
    } else if (word === "(") {
      if (lang === "vhdl" && peek() === "others") {
        take(); expect("=>"); const value = parse();
        if (value.kind !== "literal" || !/^'[^']'$/.test(value.text)) throw Error("未支持的聚合");
        e = make("literal", "others", [], t.start, expect(")").end);
        e.value = e.text;
      } else { e = parse(); expect(")"); }
    } else if (word === "{" && lang === "verilog") {
      const args = [parse()];
      while (peek() === ",") { take(); args.push(parse()); }
      e = make("concat", "拼接", args, t.start, expect("}").end);
    } else if (/^(?:\d|'|"|[boxd]")/i.test(word)) e = make("literal", t.text, [], t.start, t.end);
    else if (/^[a-zA-Z_$][\w$]*$/.test(word)) e = { ...reference(word, t.start, t.end), text: t.text };
    else throw Error("不支持的操作数");
    if (e.kind === "ref" && peek() === "(") {
      take(); const args: Expr[] = [];
      if (peek() !== ")") args.push(parse());
      let range = false;
      if (peek() === "downto" || peek() === "to") { take(); range = true; args.push(parse()); }
      while (peek() === ",") { take(); args.push(parse()); }
      const end = expect(")").end;
      const slice = lang === "vhdl" && vectors.has(e.value) && args.length > 0 && (range || args.length === 1);
      e = make(slice ? (args.every(a => a.kind === "literal") ? "slice" : "unknown") : "call", e.value, slice ? [e, ...args] : args, e.start, end);
    }
    if (peek() === "[" && lang === "verilog") {
      take(); const args = [e, parse()];
      if (peek() === ":") { take(); args.push(parse()); }
      const end = expect("]").end;
      e = make(args.slice(1).every(a => a.kind === "literal") ? "slice" : "unknown", "切片", args, e.start, end);
    }
    while (precedence[peek()] !== undefined && precedence[peek()] >= min) {
      const op = norm(take().text), p = precedence[op];
      const right = parse(op === "**" ? p : p + 1);
      e = make("op", op, [e, right], e.start, right.end);
    }
    if (min === 0 && peek() === "?" && lang === "verilog") {
      take(); const yes = parse(); expect(":"); const no = parse(); e = make("select", "选择", [e, yes, no], e.start, no.end);
    } else if (min === 0 && peek() === "when" && lang === "vhdl") {
      take(); const cond = parse(); expect("else"); const no = parse(); e = make("select", "选择", [cond, e, no], e.start, no.end);
    }
    depth--; return e;
  }
  try {
    const result = parse();
    if (pos !== ts.length) throw Error("未解析部分");
    return result;
  } catch {
    return { kind: "unknown", value: "未支持的表达式", text, start: offset, end: offset + text.length, args: [] };
  }
}
