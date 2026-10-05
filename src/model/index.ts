import type { ModuleInfo } from "../parser";

export interface ModuleDef {
  name: string;
  file: string;
  line: number;
  isIp: boolean;
}

/** 模块名 → 定义位置（哈希索引）。同名多定义时首个生效，其余记录备查。 */
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
      this.addModule({ name: m.name, file: m.file, line: m.line, isIp: false });
    }
  }

  addIp(name: string, file: string): void {
    this.addModule({ name, file, line: 1, isIp: true });
  }

  resolve(name: string): ModuleDef | undefined {
    return this.byName.get(name.toLowerCase())?.[0];
  }

  allDefs(): ModuleDef[] {
    return [...this.byName.values()].map((l) => l[0]);
  }
}
