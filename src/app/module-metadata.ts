import { parseFile } from "../parser";
import type { ModuleInfo, IpInfo, PortInfo, ParameterInfo } from "../parser";
import { readFile } from "../ipc";
import type { ModuleDef } from "../model";

export interface FileVersion { identity: unknown; version: unknown }

export interface ModuleMetadataContext {
  ips(): IpInfo[];
  resolveModule(name: string): ModuleDef | undefined;
  /** 打开中的标签页用当前缓冲区（含未保存修改），否则用扫描缓存。 */
  fileContent(file: string): string | undefined;
  /** 与 fileContent 同源：标签页使用 model 身份与版本，否则使用索引路径与缓存内容。 */
  fileToken(file: string): FileVersion;
}

export function createModuleMetadataLoader(ctx: ModuleMetadataContext): {
  modulePorts(moduleName: string): Promise<PortInfo[]>;
  moduleParameters(moduleName: string): ParameterInfo[];
  reset(): void;
} {
  const ipPortsCache = new Map<string, { ports: PortInfo[]; source: string }>();
  /** 工程内模块文件解析缓存（按 fileToken 失效），modulePorts 与 moduleParameters 共享。 */
  const moduleFileCache = new Map<string, { token: FileVersion; modules: ModuleInfo[] }>();
  let generation = 0;

  /** 从 IP stub（同名 .v / synth / sim 子目录）提取端口，.veo 兜底；结果缓存。 */
  async function loadIpPorts(name: string): Promise<{ ports: PortInfo[]; source: string }> {
    const request = generation;
    const key = name.toLowerCase();
    const hit = ipPortsCache.get(key);
    if (hit) return hit;
    const empty = { ports: [] as PortInfo[], source: "" };
    const ip = ctx.ips().find((i) => i.name.toLowerCase() === key);
    if (!ip) return empty;
    const base = ip.file.replace(/\.xci$/i, "");
    const dir = ip.file.slice(0, ip.file.lastIndexOf("/"));
    const candidates = [
      `${base}.v`,
      `${dir}/synth/${ip.name}.v`,
      `${dir}/sim/${ip.name}.v`,
      `${base}.veo`,
    ];
    for (const candidate of candidates) {
      if (request !== generation) return empty;
      try {
        const { content } = await readFile(candidate);
        if (request !== generation) return empty;
        const modules = parseFile(content, candidate);
        const mod = modules.find((m) => m.name.toLowerCase() === key) ?? modules[0];
        if (mod && mod.ports.length > 0) {
          const result = { ports: mod.ports, source: candidate };
          ipPortsCache.set(key, result);
          return result;
        }
      } catch {
        // 候选文件不存在或解析失败，尝试下一个
      }
    }
    if (request === generation) ipPortsCache.set(key, empty);
    return empty;
  }

  function moduleFileModules(def: ModuleDef): ModuleInfo[] | undefined {
    const content = ctx.fileContent(def.file);
    if (content === undefined) return undefined;
    const token = ctx.fileToken(def.file);
    const hit = moduleFileCache.get(def.file);
    if (hit && hit.token.identity === token.identity && hit.token.version === token.version) return hit.modules;
    const modules = parseFile(content, def.file);
    moduleFileCache.set(def.file, { token, modules });
    return modules;
  }

  /** 子模块端口元数据：工程内模块取解析结果，IP 取 stub。 */
  async function modulePorts(moduleName: string): Promise<PortInfo[]> {
    const def = ctx.resolveModule(moduleName);
    const key = moduleName.toLowerCase();
    if (def && !def.isIp) {
      const mod = moduleFileModules(def)?.find((m) => m.name.toLowerCase() === key);
      if (mod) return mod.ports;
    }
    return (await loadIpPorts(moduleName)).ports;
  }

  function moduleParameters(moduleName: string): ParameterInfo[] {
    const def = ctx.resolveModule(moduleName);
    if (!def || def.isIp) return [];
    const key = moduleName.toLowerCase();
    return moduleFileModules(def)?.find((m) => m.name.toLowerCase() === key)?.parameters ?? [];
  }

  /** 端口与解析缓存按工程失效：换工程后同名 IP（clk_wiz_0 等）不得沿用旧定义。 */
  function reset(): void {
    generation++;
    ipPortsCache.clear();
    moduleFileCache.clear();
  }

  return { modulePorts, moduleParameters, reset };
}
