/**
 * 补全项纯数据构建（不依赖 Monaco，可单测）：
 * 例化骨架 snippet 与当前文件符号项。provider 在 completion.ts。
 */
import { extractOutline } from "../model/outline";
import { parseFile, detectLang } from "../parser";
import type { PortInfo, ParameterInfo } from "../parser";

/** snippet 特殊字符转义（$ \ } 在占位符文本中是语法字符） */
function snipEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/}/g, "\\}");
}

/**
 * 双语言例化骨架：参数默认值、实例名、连接信号均可 Tab 逐项改。
 * 已输入的 VHDL 标签和库名保持不变，无接口信息时仍生成合法的空接口形式。
 */
export function moduleInstSnippet(name: string, ports: PortInfo[], lang: "verilog" | "vhdl" = "verilog", label?: string, library = "work", parameters: ParameterInfo[] = []): string {
  const n = snipEscape(name);
  let slot = label ? 1 : 2;
  const parameterLines = parameters.map((p, i) => {
    const value = `\${${slot++}:${snipEscape(p.defaultValue ?? p.name)}}`;
    return `\t\t${lang === "vhdl" ? `${snipEscape(p.name)} => ${value}` : `.${snipEscape(p.name)}(${value})`}${i < parameters.length - 1 ? "," : ""}`;
  });
  if (lang === "vhdl") {
    const instance = label ? snipEscape(label) : `\${1:u_${n}}`;
    const header = `${instance} : entity ${snipEscape(library)}.${n}`;
    const lines = [header];
    if (parameters.length) lines.push("\tgeneric map (", ...parameterLines, "\t)");
    if (ports.length) lines.push("\tport map (", ...ports.map((p, i) => `\t\t${snipEscape(p.name)} => \${${slot++}:${snipEscape(p.name)}}${i < ports.length - 1 ? "," : ""}`), "\t)");
    return lines.join("\n") + (ports.length || parameters.length ? ";" : ";$0");
  }
  if (ports.length === 0 && !parameters.length) {
    return `${n} \${1:u_${n}} ($0);`;
  }
  const lines = parameters.length ? [`${n} #(`, ...parameterLines, `) \${1:u_${n}} (`] : [`${n} \${1:u_${n}} (`];
  ports.forEach((p, i) => {
    const pn = snipEscape(p.name);
    const comma = i < ports.length - 1 ? "," : "";
    lines.push(`\t.${pn}(\${${slot++}:${pn}})${comma}`);
  });
  lines.push(");");
  return lines.join("\n");
}

/** 当前文件信号/例化名补全项（信号去重，例化名 detail 带模块名）。 */
export function fileSymbolItems(content: string, file: string): { label: string; detail: string }[] {
  const items: { label: string; detail: string }[] = [];
  const seen = new Set<string>();
  const key = (name: string) => detectLang(file) === "vhdl" ? name.toLowerCase() : name;
  for (const module of parseFile(content, file)) {
    for (const symbol of [...module.ports, ...module.parameters ?? []]) {
      if (!seen.has(key(symbol.name))) {
        seen.add(key(symbol.name));
        items.push({ label: symbol.name, detail: "信号" });
      }
    }
  }
  for (const it of extractOutline(content, file)) {
    if (it.kind === "signal") {
      if (seen.has(key(it.name))) continue;
      seen.add(key(it.name));
      items.push({ label: it.name, detail: "信号" });
    } else if (it.kind === "instance") {
      const inst = it.name.split(" : ")[0];
      if (seen.has(key(inst))) continue;
      seen.add(key(inst));
      items.push({ label: inst, detail: it.name });
    }
  }
  return items;
}
