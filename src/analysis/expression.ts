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
  access?: { kind: "index" | "range" | "field"; dynamic?: boolean; field?: string };
  conversion?: { name: string; signed?: boolean; width?: string; description: string };
  roles?: ("数据" | "地址" | "条件" | "调用参数")[];
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
  if (e.access?.kind === "field") return `${formatExpr(e.args[0])}.${e.access.field}`;
  if (e.kind === "slice") return `${formatExpr(e.args[0])}[${e.args.slice(1).map(formatExpr).join(e.access?.kind === "index" ? "," : ":")}]`;
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
export interface ExpressionRelation { name: string; role: "数据" | "地址" | "条件" | "调用参数"; current?: boolean; unknown?: boolean }
export function expressionArgumentRole(e: Expr, index: number, role: ExpressionRelation["role"]): ExpressionRelation["role"] {
  if (e.conversion || e.kind === "slice" && index === 0) return role;
  return e.roles?.[index] ?? (e.kind === "select" && index === 0 ? "条件" : e.kind === "call" ? "调用参数" : role);
}
export function expressionRelations(e: Expr, role: ExpressionRelation["role"] = "数据", unknown = false): ExpressionRelation[] {
  if (e.kind === "ref") return [{ name: e.value, role, current: e.current, unknown }];
  if (e.kind === "unknown") return [];
  return e.args.flatMap((arg, i) => expressionRelations(arg, expressionArgumentRole(e, i, role), unknown || e.kind === "call" && !e.conversion));
}
function accessPath(e: Expr): string | undefined {
  if (e.kind === "ref") return e.value;
  if (e.kind !== "slice") return;
  const base = accessPath(e.args[0]); if (!base) return;
  return e.access?.kind === "field" ? `${base}.${e.access.field}` : e.access?.kind === "range" ? base : `${base}[]`;
}

/** 有界表达式解析；无法完整消费时返回原文边界，不以部分树冒充完整表达式。 */
export function parseExpression(text: string, lang: HdlLang, offset = 0, vectors = new Set<string>()): Expr {
  if (lang === "vhdl") {
    const literal = '(?:[boxd]"[^"\\n]*"|\'[^\'\\n]\'|\\d[\\d_]*)';
    const entry = `(?:(?:\\d+|others)\\s*=>\\s*)?${literal}`;
    if (!/\bothers\s*=>[^,]*,/i.test(text) && new RegExp(`^\\s*\\(\\s*${entry}(?:\\s*,\\s*${entry})+\\s*\\)\\s*$`, "i").test(text)) return { kind: "literal", value: text, text, start: offset, end: offset + text.length, args: [] };
  }
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
    while (peek() === "." || peek() === "[" && lang === "verilog" || peek() === "(" && (e.kind === "ref" || e.kind === "slice")) {
    if (peek() === ".") {
      take(); const field = take();
      if (!field || !/^[a-zA-Z_]\w*$/.test(field.text)) throw Error("不完整字段访问");
      e = { ...make("slice", "字段访问", [e], e.start, field.end), access: { kind: "field", field: norm(field.text) }, roles: ["数据"] };
    } else if (peek() === "(") {
      take(); const args: Expr[] = [];
      if (peek() !== ")") args.push(parse());
      let range = false;
      if (peek() === "downto" || peek() === "to") { take(); range = true; args.push(parse()); }
      while (peek() === ",") { take(); args.push(parse()); }
      const end = expect(")").end;
      const base = accessPath(e);
      const slice = lang === "vhdl" && base !== undefined && vectors.has(base) && args.length > 0;
      e = { ...make(slice ? "slice" : "call", e.value, slice ? [e, ...args] : args, e.start, end),
        ...(slice ? { access: { kind: range ? "range" as const : "index" as const, dynamic: args.some(a => a.kind !== "literal") }, roles: ["数据" as const, ...args.map(() => "地址" as const)] } : {}) };
      if (!slice) {
        const name = norm(e.value);
        const one = (lang === "vhdl" ? /^(?:std_logic_vector|bit_vector|unsigned|signed|integer|natural|positive|to_integer)$/ : /^\$(?:signed|unsigned)$/).test(name) && args.length === 1;
        const two = lang === "vhdl" && /^(?:to_unsigned|to_signed|resize)$/.test(name) && args.length === 2;
        if (one || two) {
          const signed = /^(?:signed|to_signed|\$signed)$/.test(name) ? true : /^(?:unsigned|to_unsigned|\$unsigned)$/.test(name) ? false : undefined;
          e.conversion = { name, signed, width: two ? args[1].text : undefined, description: `${name} 类型转换${two ? `，结果宽度 ${args[1].text}` : ""}${signed === undefined ? "" : signed ? "，有符号" : "，无符号"}；未计算转换后的值` };
          e.roles = args.map(() => "数据");
        } else e.roles = args.map(() => "调用参数");
      }
    } else {
      take(); const args = [e, parse()];
      let range = false;
      if (peek() === ":") { take(); range = true; args.push(parse()); }
      const end = expect("]").end;
      e = { ...make("slice", "切片", args, e.start, end), access: { kind: range ? "range" : "index", dynamic: args.slice(1).some(a => a.kind !== "literal") }, roles: ["数据", ...args.slice(1).map(() => "地址" as const)] };
    }
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
