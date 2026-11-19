import type { IpInfo, ModuleInfo } from "../parser";
import { ModuleIndex } from "../model";
import { buildHierarchy, type TreeNode } from "../model/hierarchy";
import { filePathKey } from "../file-path";

/** 结构快照只用于本次分析，不覆盖磁盘索引或用户的定义选择。 */
export function syntaxScope(structures: Map<string, ModuleInfo[]>, ips: IpInfo[], preferences: Map<string, string>, top?: string) {
  const index = new ModuleIndex();
  for (const modules of structures.values()) index.addStructure(modules);
  for (const ip of ips) index.addIp(ip.name, ip.file);
  for (const [name, file] of preferences) index.setPreferred(name, file);
  const topology = buildHierarchy(index, structures, top).tops;
  return { index, topology, ...topologyScope(index, topology) };
}

export function topologyScope(index: ModuleIndex, topology: TreeNode[]) {
  const modules = new Set<string>();
  const files = new Set<string>();
  const ipFiles = new Set<string>();
  const pending = [...topology];
  while (pending.length) {
    const node = pending.pop()!;
    const identity = index.identity(node.moduleName, node.referenceLanguage);
    if (modules.has(identity)) continue;
    modules.add(identity);
    if (node.kind === "ip" && node.file) ipFiles.add(filePathKey(node.file));
    for (const definition of index.bindingFiles(node.moduleName, node.referenceLanguage)) files.add(filePathKey(definition.file));
    pending.push(...node.children);
  }
  return { files, ipFiles };
}
