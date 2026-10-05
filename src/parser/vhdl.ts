import type { DefinitionRef, ModuleInfo, PortInfo } from "./types";

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

/** 去掉行注释，保留长度和换行。 */
export function stripVhdlComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    if (src[i] === "-" && src[i + 1] === "-") {
      let j = i;
      while (j < src.length && src[j] !== "\n") out[j++] = " ";
      i = j;
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
        width: widthMatch ? `${type} ` : undefined,
      });
    }
  }
  return ports;
}

function findEnd(stripped: string, from: number, name: string, extraTag?: string): number {
  const endRe = /\bend\s*(?:(entity|architecture)(?:\s+[A-Za-z_]\w*)?|([A-Za-z_]\w*))?\s*;/gi;
  endRe.lastIndex = from;
  let em: RegExpExecArray | null;
  while ((em = endRe.exec(stripped))) {
    if (em[1]) return em.index + em[0].length;
    const tag = (em[2] ?? "").toLowerCase();
    if (tag === "" || tag === name.toLowerCase() || tag === extraTag?.toLowerCase()) {
      return em.index + em[0].length;
    }
  }
  return stripped.length;
}

/** 完整解析：entity 定义、端口、例化（component / direct entity，按 architecture 归属）。withPorts=false 时跳过端口提取（第一级结构扫描用）。 */
export function parseVhdl(src: string, file: string, withPorts = true): ModuleInfo[] {
  const stripped = stripVhdlComments(src);
  const lineStarts = computeLineStarts(stripped);
  const byName = new Map<string, ModuleInfo>();

  const entRe = /\bentity\s+([A-Za-z_]\w*)\s+is\b/gi;
  let m: RegExpExecArray | null;
  while ((m = entRe.exec(stripped))) {
    const name = m[1];
    const bodyEnd = findEnd(stripped, entRe.lastIndex, name);
    const body = stripped.slice(entRe.lastIndex, bodyEnd);

    let ports: PortInfo[] = [];
    if (withPorts) {
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
      instances: [],
    });
    entRe.lastIndex = bodyEnd;
  }

  const instRe =
    /([A-Za-z_]\w*)\s*:\s*(?:entity\s+(?:(\w+)\s*\.\s*)?(\w+)(?:\s*\(\s*\w+\s*\))?|component\s+(\w+)|(\w+))\s+(?:generic\s+map|port\s+map)/gi;
  const archRe = /\barchitecture\s+(\w+)\s+of\s+([A-Za-z_]\w*)\s+is\b/gi;
  while ((m = archRe.exec(stripped))) {
    const owner = byName.get(m[2].toLowerCase());
    const archEnd = findEnd(stripped, archRe.lastIndex, "architecture", m[1]);
    const body = stripped.slice(archRe.lastIndex, archEnd);
    archRe.lastIndex = archEnd;
    if (!owner) continue;
    let im: RegExpExecArray | null;
    instRe.lastIndex = 0;
    while ((im = instRe.exec(body))) {
      const module = im[3] ?? im[4] ?? im[5];
      if (!module) continue;
      owner.instances.push({
        module,
        inst: im[1],
        line: lineAt(lineStarts, archRe.lastIndex - body.length + im.index),
      });
    }
  }
  return [...byName.values()];
}
