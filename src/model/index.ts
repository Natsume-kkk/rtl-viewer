import type { ModuleInfo } from "../parser";
import { filePathKey } from "../file-path";

export interface ModuleDef {
  name: string;
  file: string;
  line: number;
  isIp: boolean;
  vhdl?: ModuleInfo["vhdl"];
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
  private preferred = new Map<string, string>();

  addModule(def: ModuleDef): void {
    const key = def.name.toLowerCase();
    const list = this.byName.get(key) ?? [];
    list.push(def);
    this.byName.set(key, list);
  }

  addStructure(modules: ModuleInfo[]): void {
    for (const m of modules) {
      this.addModule({ name: m.name, file: m.file, line: m.line, isIp: false, ...(m.vhdl ? { vhdl: m.vhdl } : {}) });
    }
  }

  addIp(name: string, file: string): void {
    this.addModule({ name, file, line: 1, isIp: true });
  }

  resolve(name: string): ModuleDef | undefined {
    const key = name.toLowerCase();
    return bindModuleParts(selectModuleParts(this.byName.get(key) ?? [], this.preferred.get(key))).definition;
  }

  setPreferred(name: string, file: string): void {
    const key = name.toLowerCase();
    if ((this.byName.get(key) ?? []).some(part => filePathKey(part.file) === filePathKey(file))) this.preferred.set(key, filePathKey(file));
  }

  preferredFile(name: string): string | undefined {
    return this.preferred.get(name.toLowerCase());
  }

  candidates(name: string): ModuleDef[] {
    return [...this.byName.get(name.toLowerCase()) ?? []];
  }

  allDefs(): ModuleDef[] {
    return [...this.byName.keys()].flatMap(name => this.resolve(name) ?? []);
  }

  allNames(): string[] {
    return [...this.byName.values()].map(parts => parts[0].name);
  }

  problem(name: string): string | undefined {
    if (this.preferredFile(name) && this.resolve(name)) return undefined;
    const parts = this.byName.get(name.toLowerCase()) ?? [];
    const problem = bindModuleParts(parts).problem;
    return problem ? `${problem}\n${parts.map(part => `${part.file}:${part.line}`).join("\n")}` : undefined;
  }
}
