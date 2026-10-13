import type { FileMatches, SearchOptions } from "../model/search";
import type { SearchRequest } from "../model/search-worker";

type SearchWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;

/** 每次查询拥有独立 Worker；超时、替换和销毁均可停止一次正在执行的正则。 */
export function createProjectSearch(makeWorker: () => SearchWorker = () =>
  new Worker(new URL("../model/search-worker.ts", import.meta.url), { type: "module" })) {
  let stop: (() => void) | undefined;

  function cancel(): void { stop?.(); }

  function search(files: SearchRequest["files"], query: string, options: SearchOptions): Promise<FileMatches[]> {
    cancel();
    return new Promise((resolve, reject) => {
      const worker = makeWorker();
      const finish = (results?: FileMatches[], error?: Error) => {
        clearTimeout(timer);
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
        if (stop === abort) stop = undefined;
        if (error) reject(error); else resolve(results ?? []);
      };
      const abort = () => finish(undefined, new Error("搜索已取消"));
      const timer = setTimeout(() => finish(undefined, new Error("搜索超过 2 秒，已停止；请缩小查询范围或简化正则表达式。")), 2000);
      stop = abort;
      worker.onmessage = event => {
        const reply = event.data as { results?: FileMatches[]; error?: string };
        finish(reply.results, reply.error ? new Error(reply.error) : undefined);
      };
      worker.onerror = event => { event.preventDefault(); finish(undefined, new Error("搜索执行失败，请重试。")); };
      worker.onmessageerror = () => finish(undefined, new Error("搜索结果读取失败，请重试。"));
      try { worker.postMessage({ files, query, options } satisfies SearchRequest); }
      catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
    });
  }

  return { search, cancel };
}
