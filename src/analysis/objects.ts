import { detectLang } from "../parser";
import type { SignalModule } from "../model/signal-flow";
import { sourceEntry } from "./source-cache";

export interface SourceObject {
  name: string;
  kind: "type" | "constant" | "parameter" | "signal" | "variable" | "port";
  type: string;
  source: { file: string; start: number; end: number };
  scope: string;
  initializer?: string;
  array?: { ranges: string[]; elementType: string };
  record?: { fields: { name: string; type: string }[] };
}

/** Resolve only declared aliases and built-in vector types; cyclic/unknown names stay unknown. */
export function sourceTypeShape(type: string, objects: Map<string, SourceObject>, vhdl: boolean, seen = new Set<string>()): Pick<SourceObject, "array" | "record"> {
  const builtin = vhdl ? /^\s*(std_logic_vector|std_ulogic_vector|bit_vector|unsigned|signed)\b\s*(?:\((.*)\))?\s*$/i.exec(type) : undefined;
  if (builtin) return { array: { ranges: builtin[2] ? [builtin[2]] : [], elementType: builtin[1].toLowerCase() === "bit_vector" ? "bit" : "std_logic" } };
  const named = /^\s*(\w+)(?:\s*\((.*)\))?\s*$/.exec(type);
  if (!named) return {};
  const name = vhdl ? named[1].toLowerCase() : named[1];
  if (seen.has(name) || seen.size >= 32) return {};
  const declaration = objects.get(name);
  if (declaration?.kind !== "type") return {};
  const shape = declaration.array || declaration.record ? { array: declaration.array, record: declaration.record }
    : sourceTypeShape(declaration.type, objects, vhdl, new Set(seen).add(name));
  return shape.array && named[2] ? { ...shape, array: { ...shape.array, ranges: [named[2]] } } : shape;
}

/** Declaration facts only; no width evaluation or constant execution. */
function declarations(text: string, file: string, start: number, scope: string, excluded: { start: number; end: number }[] = [], sourceMap?: number[]): Map<string, SourceObject> {
  const lang = detectLang(file), out = new Map<string, SourceObject>();
  const normal = (s: string) => lang === "vhdl" ? s.toLowerCase() : s;
  const types = new Map<string, Pick<SourceObject, "array" | "record">>();
  const recordBodies: { start: number; end: number }[] = [];
  const put = (name: string, kind: SourceObject["kind"], type: string, index: number, length: number, extra: Partial<SourceObject> = {}) => {
    const at = sourceMap?.[index] ?? start + index;
    if (excluded.some(r => at >= r.start && at < r.end)) return;
    if (kind === "signal" && recordBodies.some(r => index >= r.start && index < r.end)) return;
    name = normal(name);
    const inherited = types.get(normal(/^\s*(\w+)/.exec(type)?.[1] ?? ""));
    out.set(name, { name, kind, type: type.trim(), source: { file, start: at, end: sourceMap?.[index + length] ?? at + length }, scope, ...inherited, ...extra });
  };
  if (lang === "vhdl") {
    for (const m of text.matchAll(/\btype\s+(\w+)\s+is\s*\(([^;]+)\)\s*;/gi)) {
      put(m[1], "type", m[0].slice(m[0].indexOf("("), m[0].lastIndexOf(")") + 1), m.index!, m[0].length);
      for (const member of m[2].split(/\s*,\s*/)) if (/^\w+$/.test(member.trim())) put(member.trim(), "constant", m[1], m.index!, m[0].length);
    }
    for (const m of text.matchAll(/\btype\s+(\w+)\s+is\s+(array\s*\([\s\S]*?\)\s+of\s*([^;]+)|record\b([\s\S]*?)\bend\s+record\b)\s*;/gi)) {
      const extra: Pick<SourceObject, "array" | "record"> = {};
      if (m[3]) extra.array = { ranges: [/array\s*\(([\s\S]*?)\)\s+of/i.exec(m[2])![1].trim()], elementType: m[3].trim() };
      else extra.record = { fields: [...m[4].matchAll(/([\w\s,]+)\s*:\s*([^;]+);/g)].flatMap(f => f[1].trim().split(/\s*,\s*/).map(name => ({ name: normal(name), type: f[2].trim() }))) };
      if (!excluded.some(r => (sourceMap?.[m.index!] ?? start + m.index!) >= r.start && (sourceMap?.[m.index!] ?? start + m.index!) < r.end)) types.set(normal(m[1]), extra);
      put(m[1], "type", m[2], m.index!, m[0].length, extra);
    }
    for (const m of text.matchAll(/\bsubtype\s+(\w+)\s+is\s+([^;]+);/gi)) {
      const type = m[2].trim(), inherited = types.get(normal(/^\w+/.exec(type)?.[0] ?? ""));
      if (inherited) types.set(normal(m[1]), inherited);
      put(m[1], "type", type, m.index!, m[0].length);
    }
    for (const m of text.matchAll(/\b(signal|constant|variable)\s+([\w\s,]+)\s*:\s*([^;]+);/gi)) {
      const split = m[3].split(/\s*:=\s*/);
      for (const name of m[2].trim().split(/\s*,\s*/)) put(name, m[1].toLowerCase() as SourceObject["kind"], split[0], m.index!, m[0].length, { initializer: split.slice(1).join(":=") || undefined });
    }
  } else {
    for (const m of text.matchAll(/\btypedef\s+enum\b([^{};]*)\{([^}]+)\}\s*(\w+)\s*;/g)) {
      put(m[3], "type", `enum${m[1]}`, m.index!, m[0].length);
      for (const member of m[2].split(",")) {
        const value = /^\s*(\w+)(?:\s*=\s*(.*))?\s*$/.exec(member);
        if (value) put(value[1], "constant", m[3], m.index!, m[0].length, { initializer: value[2] });
      }
    }
    for (const m of text.matchAll(/\btypedef\s+struct\s*(?:packed\s*)?\{([\s\S]*?)\}\s*(\w+)\s*;/g)) {
      recordBodies.push({ start: m.index!, end: m.index! + m[0].length });
      const record = { fields: [...m[1].matchAll(/\b(\w+(?:\s+(?:signed|unsigned))?(?:\s*\[[^\]]+\])?)\s+(\w+)\s*;/g)].map(f => ({ name: f[2], type: f[1] })) };
      if (!excluded.some(r => start + m.index! >= r.start && start + m.index! < r.end)) types.set(m[2], { record });
      put(m[2], "type", "struct", m.index!, m[0].length, { record });
    }
    for (const m of text.matchAll(/\b(wire|reg|logic|bit|integer|int|parameter|localparam)\s+((?:(?:signed|unsigned)\s+)?(?:\[[^\]]+\]\s*)?)([^;]+);/g)) {
      const kind = /param/.test(m[1]) ? "parameter" : "signal";
      for (const item of m[3].split(/,(?![^{}]*\})/)) {
        const entry = /^\s*(\w+)\s*((?:\[[^\]]+\]\s*)*)(?:=\s*([\s\S]*))?$/.exec(item);
        if (!entry) continue;
        const type = `${m[1]} ${m[2]}`.trim();
        put(entry[1], kind, type, m.index!, m[0].length, { initializer: entry[3], ...(entry[2] ? { array: { ranges: [...entry[2].matchAll(/\[([^\]]+)\]/g)].map(r => r[1]), elementType: type } } : {}) });
      }
    }
    for (const [name, info] of types) for (const m of text.matchAll(new RegExp(`\\b${name}\\s+(\\w+)\\s*;`, "g"))) put(m[1], "signal", name, m.index!, m[0].length, info);
  }
  return out;
}

export function collectSourceObjects(files: Map<string, string>, mod: SignalModule): Map<string, SourceObject> {
  const objects = new Map<string, SourceObject>();
  const regions: { file: string; start: number; end: number; text?: string; scope?: string; sourceMap?: number[] }[] = mod.sourceViews ?? mod.regions;
  for (const region of regions) {
    const raw = files.get(region.file); if (raw === undefined) continue;
    const view = region.text === undefined ? undefined : region;
    const text = view ? sourceEntry(region.file, view.text!).text(false) : sourceEntry(region.file, raw).text(false).slice(region.start, region.end);
    const excluded = [...mod.processes.filter(p => p.file === region.file), ...mod.boundaries.filter(b => b.file === region.file && b.start !== undefined && b.end !== undefined).map(b => ({ start: b.start!, end: b.end! }))];
    for (const [key, value] of declarations(text, region.file, region.start, view?.scope || mod.name, excluded, view?.sourceMap)) objects.set(key, value);
  }
  for (const object of objects.values()) {
    const shape = sourceTypeShape(object.type, objects, detectLang(mod.file) === "vhdl");
    if (shape.array) object.array = shape.array;
    if (shape.record) object.record = shape.record;
    const parameter = mod.parameterValues?.get(object.name);
    if (object.kind === "parameter" && parameter !== undefined) object.initializer = String(parameter);
  }
  for (const port of mod.ports) {
    const name = detectLang(mod.file) === "vhdl" ? port.name.toLowerCase() : port.name;
    const start = sourceEntry(mod.file, files.get(mod.file) ?? "").lineOffset(mod.line);
    const type = port.width || "标量";
    objects.set(name, { name, kind: "port", type, ...sourceTypeShape(type, objects, detectLang(mod.file) === "vhdl"), source: { file: mod.file, start, end: start + 1 }, scope: mod.name });
  }
  return objects;
}

/** Module identity is explicit; optional click location includes process-local declaration scope. */
export function lookupSourceObject(files: Map<string, string>, mod: SignalModule, name: string, at?: { file: string; offset: number }): SourceObject | undefined {
  const normal = detectLang(mod.file) === "vhdl" ? name.toLowerCase() : name;
  if (at) {
    if (!mod.regions.some(r => r.file === at.file && at.offset >= r.start && at.offset < r.end)) return;
    const process = mod.processes.find(p => p.file === at.file && at.offset >= p.start && at.offset < p.end);
    if (process) {
      const text = sourceEntry(at.file, files.get(at.file) ?? "").text(false).slice(process.start, process.end);
      const local = declarations(text, at.file, process.start, `${mod.name}:process:${process.start}`).get(normal);
      if (local) return local;
    }
  }
  return collectSourceObjects(files, mod).get(normal);
}
