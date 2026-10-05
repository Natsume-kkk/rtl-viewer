export interface SearchMatch {
  line: number;
  /** 首个命中起始列（1 起始） */
  column: number;
  /** 该行文本（去首尾空白） */
  text: string;
}

export interface FileMatches {
  file: string;
  matches: SearchMatch[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  /** 命中行数上限，超出截断，默认 500 */
  maxMatches?: number;
}

/**
 * 跨文件纯文本搜索（按行扫描，每行记录首个命中位置）。
 * 输入为扫描阶段已解码的文件内容缓存，不做磁盘 IO。
 */
export function searchContents(
  contents: Map<string, { content: string }>,
  query: string,
  options: SearchOptions = {},
): FileMatches[] {
  const q = options.caseSensitive ? query : query.toLowerCase();
  if (!q) return [];
  const max = options.maxMatches ?? 500;
  const results: FileMatches[] = [];
  let total = 0;
  for (const [file, { content }] of contents) {
    const lines = content.split("\n");
    const matches: SearchMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const hay = options.caseSensitive ? lines[i] : lines[i].toLowerCase();
      const col = hay.indexOf(q);
      if (col >= 0) {
        matches.push({ line: i + 1, column: col + 1, text: lines[i].trim() });
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
