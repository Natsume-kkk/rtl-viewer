import type { ModuleInfo } from "../parser";

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

/** 模块名索引；歧义定义不作为跳转或补全目标。 */
export class ModuleIndex {
  private byName = new Map<string, ModuleDef[]>();

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
    return bindModuleParts(this.byName.get(name.toLowerCase()) ?? []).definition;
  }

  allDefs(): ModuleDef[] {
    return [...this.byName.keys()].flatMap(name => this.resolve(name) ?? []);
  }

  allNames(): string[] {
    return [...this.byName.values()].map(parts => parts[0].name);
  }

  problem(name: string): string | undefined {
    const parts = this.byName.get(name.toLowerCase()) ?? [];
    const problem = bindModuleParts(parts).problem;
    return problem ? `${problem}\n${parts.map(part => `${part.file}:${part.line}`).join("\n")}` : undefined;
  }
}
