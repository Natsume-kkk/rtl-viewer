import { parseFile, parseFileDetail } from "../parser";
import type { ModuleInfo, IpInfo, PortInfo, PortConnection } from "../parser";
import { readFile } from "../ipc";
import type { ModuleDef } from "../model";
import type { monaco } from "../editor/monaco";
import type { PortMapRow } from "../ui/portmap";

type InstanceInfo = ModuleInfo["instances"][number];

export interface PortMapContext {
  ips(): IpInfo[];
  resolveModule(name: string): ModuleDef | undefined;
  /** 打开中的标签页用当前缓冲区（含未保存修改），否则用扫描缓存。 */
  fileContent(file: string): string | undefined;
}

/** 光标位于例化语句任意一行即可命中；instance 指定时收窄到该实例，唯一候选兜底。 */
export function resolveInstanceAt(modules: ModuleInfo[], line: number, instance?: string): InstanceInfo | undefined {
  const candidates = modules.flatMap(m => m.instances).filter(i => !instance || i.inst === instance);
  return candidates.find(i => line >= i.line && line <= (i.endLine ?? i.line)) ?? (instance && candidates.length === 1 ? candidates[0] : undefined);
}

export function findInstanceAt(
  modules: ModuleInfo[],
  word: string,
  line: number,
): { owner: ModuleInfo; inst: InstanceInfo } | undefined {
  for (const owner of modules) {
    for (const inst of owner.instances) {
      if (inst.inst !== word || !inst.connections) continue;
      if (line >= inst.line && line <= (inst.endLine ?? inst.line)) return { owner, inst };
    }
  }
  return undefined;
}

export function createPortMapLoader(ctx: PortMapContext): {
  detailForModel(model: monaco.editor.ITextModel): ModuleInfo[];
  modulePorts(moduleName: string): Promise<PortInfo[]>;
  buildPortMapRows(moduleName: string, connections: PortConnection[]): Promise<PortMapRow[]>;
  reset(): void;
} {
  /** 当前编辑内容的第三级解析缓存（按 model 版本失效），悬停高频触发不能每次重解析。 */
  const detailCache = new Map<string, { version: number; modules: ModuleInfo[] }>();
  const ipPortsCache = new Map<string, { ports: PortInfo[]; source: string }>();

  function detailForModel(model: monaco.editor.ITextModel): ModuleInfo[] {
    const key = model.uri.toString();
    const version = model.getVersionId();
    const hit = detailCache.get(key);
    if (hit?.version === version) return hit.modules;
    const modules = parseFileDetail(model.getValue(), model.uri.path);
    detailCache.set(key, { version, modules });
    return modules;
  }

  /** 从 IP stub（同名 .v / synth / sim 子目录）提取端口，.veo 兜底；结果缓存。 */
  async function loadIpPorts(name: string): Promise<{ ports: PortInfo[]; source: string }> {
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
      try {
        const { content } = await readFile(candidate);
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
    ipPortsCache.set(key, empty);
    return empty;
  }

  /** 子模块端口元数据：工程内模块取解析结果，IP 取 stub。 */
  async function modulePorts(moduleName: string): Promise<PortInfo[]> {
    const def = ctx.resolveModule(moduleName);
    const key = moduleName.toLowerCase();
    if (def && !def.isIp) {
      const content = ctx.fileContent(def.file);
      if (content !== undefined) {
        const mod = parseFile(content, def.file).find((m) => m.name.toLowerCase() === key);
        if (mod) return mod.ports;
      }
    }
    return (await loadIpPorts(moduleName)).ports;
  }

  /** 连接表对齐端口元数据：命名按名（大小写不敏感），位置按序；未连接的端口补空行。 */
  async function buildPortMapRows(
    moduleName: string,
    connections: PortConnection[],
  ): Promise<PortMapRow[]> {
    const ports = await modulePorts(moduleName);
    const byName = new Map(ports.map((p) => [p.name.toLowerCase(), p]));
    const rows: PortMapRow[] = [];
    const used = new Set<string>();
    let posIdx = 0;
    for (const conn of connections) {
      let meta: PortInfo | undefined;
      if (conn.port) {
        meta = byName.get(conn.port.toLowerCase());
      } else {
        while (posIdx < ports.length && used.has(ports[posIdx].name.toLowerCase())) posIdx++;
        meta = ports[posIdx];
        posIdx++;
      }
      if (meta) used.add(meta.name.toLowerCase());
      rows.push({
        direction: meta?.direction ?? "",
        width: meta?.width ?? "",
        port: conn.port ?? meta?.name,
        expr: conn.expr,
      });
    }
    for (const p of ports) {
      if (!used.has(p.name.toLowerCase())) {
        rows.push({ direction: p.direction ?? "", width: p.width ?? "", port: p.name, expr: "" });
      }
    }
    return rows;
  }

  /** 端口与 detail 缓存按工程失效：换工程后同名 IP（clk_wiz_0 等）不得沿用旧定义。 */
  function reset(): void {
    ipPortsCache.clear();
    detailCache.clear();
  }

  return { detailForModel, modulePorts, buildPortMapRows, reset };
}
