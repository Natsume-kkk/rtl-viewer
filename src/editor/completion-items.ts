/**
 * 补全项纯数据构建（不依赖 Monaco，可单测）：
 * 例化骨架 snippet 与当前文件符号项。provider 在 completion.ts。
 */
import { extractOutline } from "../model/outline";
import type { PortInfo } from "../parser";

/** snippet 特殊字符转义（$ \ } 在占位符文本中是语法字符） */
function snipEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/}/g, "\\}");
}

/**
 * Verilog 例化骨架 snippet：端口名为固定文本，连接信号默认同名、可 Tab 逐项改。
 * 无端口信息时退化为 `name u_name ($0);`。
 */
export function moduleInstSnippet(name: string, ports: PortInfo[]): string {
  const n = snipEscape(name);
  if (ports.length === 0) {
    return `${n} \${1:u_${n}} ($0);`;
  }
  const lines = [`${n} \${1:u_${n}} (`];
  ports.forEach((p, i) => {
    const pn = snipEscape(p.name);
    const comma = i < ports.length - 1 ? "," : "";
    lines.push(`\t.${pn}(\${${i + 2}:${pn}})${comma}`);
  });
  lines.push(");");
  return lines.join("\n");
}

/** 当前文件信号/例化名补全项（信号去重，例化名 detail 带模块名）。 */
export function fileSymbolItems(content: string, file: string): { label: string; detail: string }[] {
  const items: { label: string; detail: string }[] = [];
  const seen = new Set<string>();
  for (const it of extractOutline(content, file)) {
    if (it.kind === "signal") {
      if (seen.has(it.name)) continue;
      seen.add(it.name);
      items.push({ label: it.name, detail: "信号" });
    } else if (it.kind === "instance") {
      const inst = it.name.split(" : ")[0];
      if (seen.has(inst)) continue;
      seen.add(inst);
      items.push({ label: inst, detail: it.name });
    }
  }
  return items;
}
