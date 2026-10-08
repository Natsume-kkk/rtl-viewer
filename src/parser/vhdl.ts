import type { DefinitionRef, InstanceInfo, ModuleInfo, PortInfo } from "./types";
import { parseParameters } from "./parameters";

function computeLineStarts(s: string): number[] {
  const starts = [0];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAt(lineStarts: number[], pos: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function skipBalanced(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 去掉注释与字符串内容，保留长度和换行。跟踪字符串状态（`""` 为转义引号），支持 VHDL-2008 块注释。 */
export function stripVhdlComments(src: string, maskStrings = true): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") {
      let j = i;
      while (j < src.length && src[j] !== "\n") out[j++] = " ";
      i = j;
    } else if (c === "/" && src[i + 1] === "*") {
      let j = i;
      while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) {
        if (src[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < src.length) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      }
      i = j;
    } else if (c === '"') {
      out[i] = " ";
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            out[j] = " ";
            out[j + 1] = " ";
            j += 2;
            continue;
          }
          break;
        }
        if (src[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < src.length) out[j] = " ";
      if (!maskStrings) for (let k = i; k <= j && k < src.length; k++) out[k] = src[k];
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** 第一级扫描：只提取 entity 定义名与行号。 */
export function scanVhdlDefinitions(src: string): DefinitionRef[] {
  const stripped = stripVhdlComments(src);
  const lineStarts = computeLineStarts(stripped);
  const out: DefinitionRef[] = [];
  const re = /\bentity\s+([A-Za-z_]\w*)\s+is\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    out.push({ name: m[1], line: lineAt(lineStarts, m.index) });
  }
  return out;
}

function parseVhdlPorts(portListSrc: string): PortInfo[] {
  const ports: PortInfo[] = [];
  for (const entry of portListSrc.split(";")) {
    const m = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*(in|out|inout|buffer|linkage)\s+([\s\S]+?)\s*$/i.exec(
      entry,
    );
    if (!m) continue;
    const type = m[3].trim();
    const widthMatch = /\([^)]*\)/.exec(type);
    for (const rawName of m[1].split(",")) {
      ports.push({
        name: rawName.trim(),
        direction: m[2].toLowerCase(),
        width: widthMatch ? type : undefined,
      });
    }
  }
  return ports;
}

function findEnd(stripped: string, from: number, name: string, extraTag?: string): number {
  // function/procedure（及 process/block/record）可用裸 end; 或 end <内部名>; 收尾，
  // 需按嵌套深度判断，否则内层块的裸 end; 会被误认为 entity/architecture 终点，
  // 导致其后的例化边静默丢失。已知边界：体内 function 原型声明（无 end 收尾）会使深度
  // 计数偏正，终点退化为文末兜底（多收而非漏收）；原型在 architecture 体内罕见，可接受。
  const re =
    /\b(process|function|procedure|block|record)\b|\bend\s*(?:(entity|architecture)(?:\s+[A-Za-z_]\w*)?|([A-Za-z_]\w*))?\s*;/gi;
  const openers = new Set(["process", "function", "procedure", "block", "record"]);
  // end if;/end loop;/end case;/end generate; 的 opener 未计数，其收尾直接跳过
  const skipTags = new Set(["if", "loop", "case", "generate"]);
  re.lastIndex = from;
  let depth = 0;
  let em: RegExpExecArray | null;
  while ((em = re.exec(stripped))) {
    if (em[1]) {
      depth++;
      continue;
    }
    if (em[2]) {
      // end entity [名]; / end architecture [名];
      if (depth === 0) return em.index + em[0].length;
      depth--;
      continue;
    }
    const tag = (em[3] ?? "").toLowerCase();
    if (openers.has(tag)) {
      // end process; / end function; 等内层收尾
      if (depth > 0) depth--;
      continue;
    }
    if (tag === name.toLowerCase() || (extraTag !== undefined && tag === extraTag.toLowerCase())) {
      // end <entity名>; / end <架构名>;
      if (depth === 0) return em.index + em[0].length;
      depth--;
      continue;
    }
    if (skipTags.has(tag)) continue;
    if (tag !== "") {
      // end component; 等未知 tag：深度 0 跳过；深度 >0 视为内层函数/过程名收尾
      if (depth > 0) depth--;
      continue;
    }
    // 裸 end;
    if (depth === 0) return em.index + em[0].length;
    depth--;
  }
  return stripped.length;
}

/** 完整解析：entity 定义、端口、例化（component / direct entity，按 architecture 归属）。withPorts=false 时跳过端口提取（第一级结构扫描用）；withConn=true 时额外提取 port map 连接（悬停端口映射用）。 */
export function parseVhdl(src: string, file: string, withPorts = true, withConn = false): ModuleInfo[] {
  const stripped = stripVhdlComments(src);
  const expressions = withPorts || withConn ? stripVhdlComments(src, false) : "";
  const lineStarts = computeLineStarts(stripped);
  const byName = new Map<string, ModuleInfo>();

  const entRe = /\bentity\s+([A-Za-z_]\w*)\s+is\b/gi;
  let m: RegExpExecArray | null;
  while ((m = entRe.exec(stripped))) {
    const name = m[1];
    const bodyEnd = findEnd(stripped, entRe.lastIndex, name);
    const body = stripped.slice(entRe.lastIndex, bodyEnd);

    let ports: PortInfo[] = [];
    let parameters: ModuleInfo["parameters"];
    if (withPorts) {
      const generic = /\bgeneric\s*\(/i.exec(body);
      if (generic) {
        const open = generic.index + generic[0].length - 1, close = skipBalanced(body, open);
        if (close > 0) parameters = parseParameters(body.slice(open + 1, close - 1), expressions.slice(entRe.lastIndex + open + 1, entRe.lastIndex + close - 1), true);
      }
      const portKw = /\bport\s*\(/i.exec(body);
      if (portKw) {
        const open = portKw.index + portKw[0].length - 1;
        const close = skipBalanced(body, open);
        if (close > 0) ports = parseVhdlPorts(body.slice(open + 1, close - 1));
      }
    }

    byName.set(name.toLowerCase(), {
      name,
      file,
      line: lineAt(lineStarts, m.index),
      ports,
      ...(parameters ? { parameters } : {}),
      instances: [],
    });
    entRe.lastIndex = bodyEnd;
  }

  const instRe =
    /([A-Za-z_]\w*)\s*:\s*(?:entity\s+(?:(\w+)\s*\.\s*)?(\w+)(?:\s*\(\s*\w+\s*\))?|component\s+(\w+)|(\w+))\s+(?:generic\s+map|port\s+map)/gi;
  const archRe = /\barchitecture\s+(\w+)\s+of\s+([A-Za-z_]\w*)\s+is\b/gi;
  while ((m = archRe.exec(stripped))) {
    const archEnd = findEnd(stripped, archRe.lastIndex, "architecture", m[1]);
    const body = stripped.slice(archRe.lastIndex, archEnd);
    const bodyStart = archRe.lastIndex;
    archRe.lastIndex = archEnd;
    // architecture 与 entity 分文件时本文件找不到 entity：保留例化，归属 architecture
    // 语句中的 entity 名，由 model 层按名归并到对应模块定义
    let owner = byName.get(m[2].toLowerCase());
    if (!owner) {
      owner = {
        name: m[2],
        file,
        line: lineAt(lineStarts, m.index),
        ports: [],
        instances: [],
      };
      byName.set(m[2].toLowerCase(), owner);
    }
    let im: RegExpExecArray | null;
    instRe.lastIndex = 0;
    while ((im = instRe.exec(body))) {
      const module = im[3] ?? im[4] ?? im[5];
      if (!module) continue;
      const info: InstanceInfo = {
        module,
        inst: im[1],
        line: lineAt(lineStarts, bodyStart + im.index),
      };
      if (withConn) {
        // port map 可能跟在 generic map 之后，但搜索不得越过本例化语句终点
        // （balanced 括号扫描后深度 0 的 ';'），否则会错抓下一个例化的 port map
        let stmtEnd = body.length;
        let depth = 0;
        for (let k = im.index; k < body.length; k++) {
          const ch = body[k];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          else if (ch === ";" && depth === 0) {
            stmtEnd = k;
            break;
          }
        }
        const pm = /\bport\s+map\s*\(/i.exec(body.slice(im.index, stmtEnd));
        if (pm) {
          const open = im.index + pm.index + pm[0].length - 1;
          const close = skipBalanced(body, open);
          if (close > 0) {
            info.connections = parseVhdlConnections(body.slice(open + 1, close - 1), bodyStart + open + 1, lineStarts, expressions);
            info.endLine = lineAt(lineStarts, bodyStart + close - 1);
          }
        }
      }
      owner.instances.push(info);
    }
  }
  return [...byName.values()];
}

/** 解析 VHDL port map 连接表：`port => expr` 命名连接或位置连接，按顶层逗号切分。 */
function parseVhdlConnections(
  src: string,
  baseOffset: number,
  lineStarts: number[],
  expressions: string,
): InstanceInfo["connections"] {
  const entries: { text: string; start: number }[] = [];
  let depth = 0, cur = "", curStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      entries.push({ text: cur, start: curStart });
      cur = "";
      curStart = i + 1;
    } else {
      cur += ch;
    }
  }
  entries.push({ text: cur, start: curStart });
  const out: NonNullable<InstanceInfo["connections"]> = [];
  for (const { text: masked, start } of entries) {
    const text = expressions.slice(baseOffset + start, baseOffset + start + masked.length);
    const expr = text.trim();
    if (!expr) continue;
    // 行号取条目内首个非空白字符（条目可能以换行开头）
    const lead = /^\s*/.exec(text)![0].length;
    const line = lineAt(lineStarts, baseOffset + start + lead);
    const named = /^([A-Za-z_]\w*)\s*=>\s*([\s\S]*?)$/.exec(expr);
    if (named) {
      out.push({ port: named[1], expr: named[2].trim(), line });
    } else {
      out.push({ expr, line });
    }
  }
  return out;
}
