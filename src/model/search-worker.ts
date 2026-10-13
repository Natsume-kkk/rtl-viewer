import { searchContents, type SearchOptions } from "./search";

export interface SearchRequest {
  files: [string, { content: string }][];
  query: string;
  options: SearchOptions;
}

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  try {
    const { files, query, options } = event.data;
    if (options.useRegex) {
      try { new RegExp(query); }
      catch { throw new Error("正则表达式无效"); }
    }
    self.postMessage({ results: searchContents(new Map(files), query, options) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
