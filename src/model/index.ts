import type { HdlLang, ModuleInfo } from "../parser";
import { filePathKey } from "../file-path";

export interface ModuleDef {
  name: string;
  file: string;
  line: number;
  isIp: boolean;
  vhdl?: ModuleInfo["vhdl"];
}

export function moduleIdentity(name: string, vhdl: boolean): string {
  return vhdl ? `vhdl:${name.toLowerCase()}` : name;
}

/** 结构与详细解析共享绑定规则；只有 VHDL 声明及唯一实现允许跨文件组合。 */
export function bindModuleParts<T extends { vhdl?: ModuleInfo["vhdl"] }>(parts: readonly T[]): {
  definition?: T; implementation?: T; problem?: string;
} {
  if (!parts.length) return {};
  if (!parts.every(part => part.vhdl)) {
    return parts.length === 1 ? { definition: parts[0], implementation: parts[0] }
      : { problem: "存在多个同名 module／定义，尚未确定绑定" };
  }
  const entities = parts.filter(part => part.vhdl!.entity);
  if (entities.length > 1) return { problem: "存在多个同名 entity，尚未确定绑定" };
  const definition = entities[0] ?? parts[0];
  const architectures = parts.reduce((count, part) => count + part.vhdl!.architectures.length, 0);
  if (architectures > 1) return { definition, problem: "存在多个 architecture，尚未确定绑定" };
  return { definition, implementation: parts.find(part => part.vhdl!.architectures.length) ?? definition };
}

export function selectModuleParts<T extends { file: string; vhdl?: ModuleInfo["vhdl"] }>(parts: readonly T[], preferredFile?: string): readonly T[] {
  if (!preferredFile) return parts;
  const preferred = parts.find(part => filePathKey(part.file) === preferredFile);
  if (!preferred) return parts;
  if (preferred.vhdl && !preferred.vhdl.entity) return [...parts.filter(part => part.vhdl?.entity), preferred];
  return [preferred];
}

/** 模块名索引；歧义定义不作为跳转或补全目标。 */
export class ModuleIndex {
  private byName = new Map<string, ModuleDef[]>();
  private ipNames = new Map<string, Set<string>>();
  private preferred = new Map<string, string>();

  addModule(def: ModuleDef): void {
    const key = moduleIdentity(def.name, !!def.vhdl);
    const list = this.byName.get(key) ?? [];
    list.push(def);
    this.byName.set(key, list);
    if (def.isIp) {
      const lower = def.name.toLowerCase();
      const names = this.ipNames.get(lower) ?? new Set<string>();
      names.add(def.name);
      this.ipNames.set(lower, names);
    }
  }

  addStructure(modules: ModuleInfo[]): void {
    for (const m of modules) {
      this.addModule({ name: m.name, file: m.file, line: m.line, isIp: false, ...(m.vhdl ? { vhdl: m.vhdl } : {}) });
    }
  }

  addIp(name: string, file: string): void {
    this.addModule({ name, file, line: 1, isIp: true });
  }

  identity(name: string, language?: HdlLang): string {
    const vhdl = moduleIdentity(name, true);
    if (language === "vhdl" && this.byName.has(vhdl)) return vhdl;
    if (this.byName.has(name)) return name;
    const ips = this.ipNames.get(name.toLowerCase());
    if (language === "vhdl" && ips?.size === 1) return [...ips][0];
    return this.byName.has(vhdl) || language === "vhdl" ? vhdl : name;
  }

  resolve(name: string, language?: HdlLang): ModuleDef | undefined {
    const key = this.identity(name, language);
    return bindModuleParts(selectModuleParts(this.byName.get(key) ?? [], this.preferred.get(key))).definition;
  }

  bindingFiles(name: string, language?: HdlLang): ModuleDef[] {
    const key = this.identity(name, language);
    const parts = selectModuleParts(this.byName.get(key) ?? [], this.preferred.get(key));
    const { definition, implementation, problem } = bindModuleParts(parts);
    if (problem) return [...parts];
    return [...new Map([definition, implementation].filter((part): part is ModuleDef => !!part && !part.isIp).map(part => [filePathKey(part.file), part])).values()];
  }

  setPreferred(name: string, file: string): void {
    const path = filePathKey(file);
    const includesFile = (parts: ModuleDef[]) => parts.some(part => filePathKey(part.file) === path);
    const exact = this.identity(name);
    const parts = this.byName.get(exact);
    if (parts && includesFile(parts)) {
      this.preferred.set(exact, path);
      return;
    }
    // Older preferences stored the lowercase name. The chosen file identifies the original definition.
    const matches = [...this.byName].filter(([, definitions]) => definitions[0].name.toLowerCase() === name.toLowerCase() && includesFile(definitions));
    if (matches.length === 1) this.preferred.set(matches[0][0], path);
  }

  preferredFile(name: string, language?: HdlLang): string | undefined {
    return this.preferred.get(this.identity(name, language));
  }

  candidates(name: string, language?: HdlLang): ModuleDef[] {
    return [...this.byName.get(this.identity(name, language)) ?? []];
  }

  allDefs(): ModuleDef[] {
    return [...this.byName].flatMap(([key, parts]) => bindModuleParts(selectModuleParts(parts, this.preferred.get(key))).definition ?? []);
  }

  allNames(): string[] {
    return [...new Set([...this.byName.values()].map(parts => parts[0].name))];
  }

  problem(name: string, language?: HdlLang): string | undefined {
    const key = this.identity(name, language);
    const parts = this.byName.get(key) ?? [];
    const problem = bindModuleParts(selectModuleParts(parts, this.preferred.get(key))).problem;
    return problem ? `${problem}\n${parts.map(part => `${part.file}:${part.line}`).join("\n")}` : undefined;
  }
}
