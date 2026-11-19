import { detectLang, parseFile, parseFileDetail, type ModuleInfo } from "../parser";
import { bindModuleParts, moduleIdentity, selectModuleParts } from "../model";
import type { DefinitionCandidate, TreeNode } from "../model/hierarchy";

export function analyzeDefinitionChoices(node: TreeNode, fileContent: (file: string) => string | undefined): DefinitionCandidate[] {
  const candidates = (node.definitionCandidates ?? []).map(candidate => ({ ...candidate }));
  if (candidates.length < 2 || !node.instFile || node.instLine === undefined) return candidates;
  const parentSource = fileContent(node.instFile);
  if (parentSource === undefined) return candidates;
  const vhdl = detectLang(node.instFile) === "vhdl";
  const instance = parseFileDetail(parentSource, node.instFile).flatMap(module => module.instances).find(item =>
    moduleIdentity(item.module, vhdl) === moduleIdentity(node.moduleName, vhdl) && item.inst === node.label && item.line === node.instLine,
  );
  if (!instance) return candidates;
  const ports = instance.connections ?? [];
  const parameters = instance.parameterOverrides ?? [];
  if (ports.some(connection => !connection.port) || parameters.some(parameter => !parameter.name)) return candidates;
  const usedPorts = ports.flatMap(connection => connection.port ? [connection.port] : []);
  const usedParameters = parameters.flatMap(parameter => parameter.name ? [parameter.name] : []);
  if (!usedPorts.length && !usedParameters.length) return candidates;

  const parsed = candidates.map(candidate => ({ candidate, modules: definitionModules(candidate.file, node.moduleName, fileContent) }));
  const evaluated = parsed.map(({ candidate, modules }) => evaluateCandidate(candidate, modules, parsed.flatMap(item => item.modules ?? []), usedPorts, usedParameters));
  const matches = evaluated.filter(candidate => candidate.match === "match");
  if (matches.length === 1 && evaluated.every(candidate => candidate.match !== "unknown")) {
    matches[0].recommended = true;
    matches[0].reason = "例化端口／参数仅与此定义完全匹配";
  }
  return evaluated;
}

function definitionModules(file: string, moduleName: string, fileContent: (file: string) => string | undefined): ModuleInfo[] | undefined {
  const source = fileContent(file);
  if (source === undefined) return undefined;
  const vhdl = detectLang(file) === "vhdl";
  return parseFile(source, file).filter(module => moduleIdentity(module.name, vhdl) === moduleIdentity(moduleName, vhdl));
}

function evaluateCandidate(
  candidate: DefinitionCandidate,
  ownModules: ModuleInfo[] | undefined,
  allModules: ModuleInfo[],
  usedPorts: string[],
  usedParameters: string[],
): DefinitionCandidate {
  if (!ownModules?.length) return { ...candidate, match: "unknown", reason: "无法读取或解析此候选定义" };
  const { definition, implementation, problem } = bindModuleParts(selectModuleParts(allModules, candidate.file));
  const module = definition ?? implementation;
  if (problem || !module) return { ...candidate, match: "unknown", reason: "无法确定此候选的接口定义" };
  const normalize = detectLang(module.file) === "vhdl" ? (name: string) => name.toLowerCase() : (name: string) => name;
  const ports = new Set(module.ports.map(port => normalize(port.name)));
  const parameters = new Set((module.parameters ?? []).map(parameter => normalize(parameter.name)));
  const missingPorts = usedPorts.filter(name => !ports.has(normalize(name)));
  const missingParameters = usedParameters.filter(name => !parameters.has(normalize(name)));
  if (missingPorts.length || missingParameters.length) {
    const reasons = [
      missingPorts.length ? `缺少端口：${missingPorts.join("、")}` : "",
      missingParameters.length ? `缺少参数：${missingParameters.join("、")}` : "",
    ].filter(Boolean);
    return { ...candidate, match: "mismatch", reason: reasons.join("；") };
  }
  return { ...candidate, match: "match", reason: "例化端口／参数匹配" };
}
