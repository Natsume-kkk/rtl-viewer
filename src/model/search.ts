export interface SearchMatch {
  line: number;
  /** 首个命中起始列（1 起始） */
  column: number;
  /** 命中长度（正则模式下与查询串长度无关） */
  length: number;
  /** 该行文本（去首尾空白） */
  text: string;
}

export interface FileMatches {
  file: string;
  matches: SearchMatch[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  /** 整词匹配：命中两侧不得紧邻标识符字符 */
  wholeWord?: boolean;
  /** 查询串按正则表达式解释；无效正则返回空结果 */
  useRegex?: boolean;
  /** 命中行数上限，超出截断，默认 500 */
  maxMatches?: number;
}

export interface MatchHit {
  index: number;
  length: number;
}

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * 构建行内匹配器（返回首个命中）；查询为空或正则无效时返回 null。
 * 结果列表高亮与逐行扫描共用同一套语义。
 */
export function buildMatcher(
  query: string,
  options: SearchOptions = {},
): ((line: string) => MatchHit | null) | null {
  if (!query) return null;
  if (options.useRegex) {
    let re: RegExp;
    try {
      const src = options.wholeWord ? `\\b(?:${query})\\b` : query;
      re = new RegExp(src, options.caseSensitive ? "" : "i");
    } catch {
      return null;
    }
    return (line) => {
      const m = re.exec(line);
      return m && m[0].length > 0 ? { index: m.index, length: m[0].length } : null;
    };
  }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return (line) => {
    const hay = options.caseSensitive ? line : line.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx >= 0) {
      if (options.wholeWord) {
        const before = idx > 0 ? hay[idx - 1] : "";
        const after = hay[idx + needle.length] ?? "";
        if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) {
          idx = hay.indexOf(needle, idx + 1);
          continue;
        }
      }
      return { index: idx, length: needle.length };
    }
    return null;
  };
}

/** 构建行内全部命中（结果高亮用）。 */
export function buildAllMatcher(
  query: string,
  options: SearchOptions = {},
): (line: string) => MatchHit[] {
  const first = buildMatcher(query, options);
  if (!first) return () => [];
  if (options.useRegex) {
    let re: RegExp;
    try {
      const src = options.wholeWord ? `\\b(?:${query})\\b` : query;
      re = new RegExp(src, options.caseSensitive ? "g" : "gi");
    } catch {
      return () => [];
    }
    return (line) => {
      const hits: MatchHit[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null && m[0].length > 0) {
        hits.push({ index: m.index, length: m[0].length });
      }
      return hits;
    };
  }
  // 纯文本：直接在原行上循环，保证整词边界检查拿到完整上下文
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return (line) => {
    const hits: MatchHit[] = [];
    const hay = options.caseSensitive ? line : line.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx >= 0) {
      if (options.wholeWord) {
        const before = idx > 0 ? hay[idx - 1] : "";
        const after = hay[idx + needle.length] ?? "";
        if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) {
          idx = hay.indexOf(needle, idx + 1);
          continue;
        }
      }
      hits.push({ index: idx, length: needle.length });
      idx = hay.indexOf(needle, idx + needle.length);
    }
    return hits;
  };
}

/**
 * 跨文件纯文本/正则搜索（按行扫描，每行记录首个命中位置）。
 * 输入为扫描阶段已解码的文件内容缓存，不做磁盘 IO。
 */
export function searchContents(
  contents: Map<string, { content: string }>,
  query: string,
  options: SearchOptions = {},
): FileMatches[] {
  const matcher = buildMatcher(query, options);
  if (!matcher) return [];
  const max = options.maxMatches ?? 500;
  const results: FileMatches[] = [];
  let total = 0;
  for (const [file, { content }] of contents) {
    const lines = content.split("\n");
    const matches: SearchMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const hit = matcher(lines[i]);
      if (hit) {
        matches.push({ line: i + 1, column: hit.index + 1, length: hit.length, text: lines[i].trim() });
        total += 1;
        if (total >= max) {
          if (matches.length > 0) results.push({ file, matches });
          return results;
        }
      }
    }
    if (matches.length > 0) results.push({ file, matches });
  }
  return results;
}

export function countMatches(results: FileMatches[]): number {
  return results.reduce((n, r) => n + r.matches.length, 0);
}
