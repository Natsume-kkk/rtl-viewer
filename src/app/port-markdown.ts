import type { monaco } from "../editor/monaco";
import type { PortMapRow } from "../ui/portmap";

/** 将源码作为文字显示，只有应用生成的两个定位命令可以执行。 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+.!|<>]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function commandLink(label: string, command: string, args: unknown[]): string {
  return `[${escapeMarkdown(label)}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

export function portMapMarkdown(instName: string, moduleName: string, rows: PortMapRow[], file: string): monaco.IMarkdownString {
  const lines = [`**${escapeMarkdown(instName)}** : ${escapeMarkdown(moduleName)}`, "", "| 方向 | 端口 | 连接 |", "|---|---|---|"];
  for (const row of rows) {
    const port = row.port ?? "?";
    const portCell = commandLink(port, "rtl.gotoPort", [moduleName, port]);
    const exprCell = !row.expr ? "*（未连接）*" : /^[A-Za-z_]\w*$/.test(row.expr)
      ? commandLink(row.expr, "rtl.gotoSignal", [file, row.expr]) : escapeMarkdown(row.expr);
    lines.push(`| ${escapeMarkdown(row.direction)} | ${portCell} | ${exprCell} |`);
  }
  return { value: lines.join("\n"), isTrusted: { enabledCommands: ["rtl.gotoPort", "rtl.gotoSignal"] } };
}
