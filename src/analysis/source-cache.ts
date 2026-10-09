import { detectLang, type HdlLang } from "../parser";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";

const MAX_ENTRIES = 32;
const MAX_CACHED_SIZE = 4 * 1024 * 1024;

export interface ScopeStart { index: number; name: string }

/** 单文件按需缓存：行首偏移表、去注释文本（遮蔽/保留字符串两种）与作用域起点。 */
class SourceEntry {
  private starts?: number[];
  private maskedText?: string;
  private plainText?: string;
  private scopeLists = new Map<string, ScopeStart[]>();
  constructor(readonly file: string, readonly raw: string, readonly lang: HdlLang) {}

  get lineStarts(): number[] {
    if (!this.starts) {
      const starts = [0];
      for (let i = this.raw.indexOf("\n"); i >= 0; i = this.raw.indexOf("\n", i + 1)) starts.push(i + 1);
      this.starts = starts;
    }
    return this.starts;
  }

  /** 1 起始行号的行首偏移；超出末行与逐行累加结果一致。 */
  lineOffset(line: number): number {
    return this.lineStarts[line - 1] ?? this.raw.length + 1;
  }

  /** 偏移所在的 1 起始行号。 */
  lineAt(offset: number): number {
    const starts = this.lineStarts, pos = Math.min(offset, this.raw.length);
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** 去注释文本；maskStrings 为 true 时同时遮蔽字符串。 */
  text(maskStrings: boolean): string {
    return maskStrings ? (this.maskedText ??= this.strip(true)) : (this.plainText ??= this.strip(false));
  }

  /** 模块/架构作用域起点；strict 对应绑定用正则（VHDL 双捕获组、is 词边界）。 */
  scopes(maskStrings: boolean, strict: boolean): ScopeStart[] {
    const key = `${maskStrings}:${strict}`;
    let list = this.scopeLists.get(key);
    if (!list) {
      const re = this.lang === "vhdl"
        ? strict ? /\barchitecture\s+(\w+)\s+of\s+(\w+)\s+is\b/gi : /\barchitecture\s+\w+\s+of\s+(\w+)\s+is/gi
        : strict ? /\bmodule\s+(\w+)\b/g : /\bmodule\s+(\w+)/g;
      list = [...this.text(maskStrings).matchAll(re)].map(m => ({ index: m.index!, name: this.lang === "vhdl" && strict ? m[2] : m[1] }));
      this.scopeLists.set(key, list);
    }
    return list;
  }

  private strip(maskStrings: boolean): string {
    return this.lang === "vhdl" ? stripVhdlComments(this.raw, maskStrings) : stripComments(this.raw, maskStrings);
  }
}

const entries = new Map<string, SourceEntry>();

/** 按文件取共享缓存；内容引用变化即失效重建，超过 4 MB 的文件不缓存直接算。 */
export function sourceEntry(file: string, raw: string): SourceEntry {
  if (raw.length > MAX_CACHED_SIZE) return new SourceEntry(file, raw, detectLang(file) ?? "verilog");
  const hit = entries.get(file);
  if (hit && hit.raw === raw) {
    entries.delete(file);
    entries.set(file, hit);
    return hit;
  }
  const entry = new SourceEntry(file, raw, detectLang(file) ?? "verilog");
  entries.set(file, entry);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return entry;
}
