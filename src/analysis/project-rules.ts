import { GJB10157_RULES, GJB9765_RULES, type GjbRuleDefinition } from "./gjb-catalog";
import type { FileFacts } from "./facts";
import type { RuleDiagnostic } from "./general-rules";
import { declaredWidth, expressionWidth, signalWidths } from "./width";

export function runProjectRules(files: FileFacts[]): RuleDiagnostic[] {
  const diagnostics: RuleDiagnostic[] = [];
  const parameters = new Map<string, { file: string; scope: string }>();
  for (const facts of files.filter(item => item.language === "verilog")) {
    const declarations = [
      ...facts.declarations.filter(item => item.kind === "parameter").map(item => ({ name: item.name, line: item.line, scope: item.scope })),
      ...facts.parameters.map(item => ({ name: item.name, line: item.line ?? 1, scope: item.scope })),
    ];
    const seen = new Set<string>();
    for (const parameter of declarations) {
      const scope = parameter.scope ?? "";
      if (!seen.add(`${parameter.line}|${scope}|${parameter.name}`)) continue;
      const previous = parameters.get(parameter.name);
      if (previous && previous.file !== facts.file) emit(diagnostics, GJB10157_RULES, facts, "A-2-7", parameter.line, `参数“${parameter.name}”在模块“${previous.scope}”（${previous.file}）和“${scope}”中重复命名。`);
      else parameters.set(parameter.name, { file: facts.file, scope });
    }
  }

  const definitions = new Map<string, { file: string; ports: FileFacts["ports"]; conflict: boolean }>();
  const bindingKey = (facts: FileFacts, name: string) => `${facts.language}:${facts.language === "vhdl" ? name.toLowerCase() : name}`;
  for (const facts of files) {
    for (const port of facts.ports) {
      if (!port.scope) continue;
      const key = bindingKey(facts, port.scope);
      const definition = definitions.get(key) ?? { file: facts.file, ports: [], conflict: false };
      if (definition.file !== facts.file) definition.conflict = true;
      definition.ports.push(port);
      definitions.set(key, definition);
    }
  }
  const seenDefinitions = new Set<string>();
  for (const facts of files) {
    for (const definition of facts.definitions.filter(item => item.kind !== "architecture")) {
      const key = bindingKey(facts, definition.name);
      if (seenDefinitions.has(key) && definitions.has(key)) definitions.get(key)!.conflict = true;
      seenDefinitions.add(key);
    }
  }
  for (const facts of files) {
    for (const instance of facts.instances) {
      const key = bindingKey(facts, instance.module);
      const definition = definitions.get(key) ?? (facts.language === "verilog" && !seenDefinitions.has(key)
        ? definitions.get(`vhdl:${instance.module.toLowerCase()}`) : undefined);
      if (!definition || definition.conflict) continue;
      const childPorts = definition.ports;
      if (!childPorts.length) continue;
      const parentWidths = signalWidths(facts, instance.scope);
      const named = instance.connections.some(connection => connection.port);
      for (const connection of instance.connections) {
        if (facts.language === "verilog" && connection.expr.trim() && !/^[A-Za-z_]\w*$/.test(connection.expr.trim())) {
          emit(diagnostics, GJB10157_RULES, facts, "R-3-1", connection.line, `端口连接“${connection.expr.trim()}”使用了表达式，建议改为独立信号。`);
        }
      }
      childPorts.forEach((port, index) => {
        const connection = named
          ? (facts.language === "vhdl" && !instance.connections[index]?.port ? instance.connections[index] : undefined)
            ?? instance.connections.find(item => item.port && bindingKey(facts, item.port) === bindingKey(facts, port.name))
          : instance.connections[index];
        const direction = port.direction?.toLowerCase();
        if (facts.language === "vhdl") {
          if ((direction === "in" || direction === "input") && !port.hasDefault && (!connection || !connection.expr.trim() || connection.expr.trim().toLowerCase() === "open")) {
            emit(diagnostics, GJB9765_RULES, facts, "4.1-b", connection?.line ?? instance.line, `输入端口“${port.name}”悬空。`);
          }
          if ((direction === "out" || direction === "output" || direction === "buffer") && (!connection || !connection.expr.trim())) {
            emit(diagnostics, GJB9765_RULES, facts, "4.1-c", connection?.line ?? instance.line, `未使用输出端口“${port.name}”宜显式写为 open。`);
          }
          return;
        }
        if (!connection) return;
        const parentWidth = expressionWidth(connection.expr, parentWidths);
        const childWidth = declaredWidth(port.width);
        if (parentWidth !== undefined && childWidth !== undefined && parentWidth !== childWidth) {
          emit(diagnostics, GJB10157_RULES, facts, "R-10-1", connection.line, `端口“${port.name}”位宽为 ${childWidth}，连接信号位宽为 ${parentWidth}。`);
        }
        if (direction === "inout" && /^[A-Za-z_]\w*$/.test(connection.expr.trim())) {
          const parentPort = facts.ports.find(candidate => candidate.scope === instance.scope && candidate.name === connection.expr.trim());
          if (parentPort && parentPort.direction && parentPort.direction !== "inout") emit(diagnostics, GJB10157_RULES, facts, "A-8-1", connection.line, `双向端口“${port.name}”直接连接父模块${parentPort.direction}端口“${parentPort.name}”。`);
        }
      });
    }
  }
  return diagnostics;
}

function emit(diagnostics: RuleDiagnostic[], definitions: GjbRuleDefinition[], facts: FileFacts, id: string, line: number, message: string): void {
  const gjb10157 = definitions === GJB10157_RULES;
  diagnostics.push({
    file: facts.file,
    line,
    column: 1,
    severity: definitions.find(rule => rule.id === id)?.severity ?? "warning",
    ruleId: `${gjb10157 ? "10157" : "9765"}-${id}`,
    source: "builtin",
    category: gjb10157 ? "gjb10157" : "gjb9765",
    message,
  });
}
