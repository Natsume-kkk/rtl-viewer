import { scanFolder, readFile } from "../ipc";
import { scanStructure, parseXci, type ModuleInfo, type IpInfo } from "../parser";
import type { CachedFile } from "./watcher";

export interface ProjectScanContext {
  contents: Map<string, CachedFile>;
  structures: Map<string, ModuleInfo[]>;
  setIps(ips: IpInfo[]): void;
  setConstraints(files: string[]): void;
  progress(message: string): void;
  complete(): void;
  failed(error: unknown): Promise<void>;
}

/** 结构级扫描；读取后再次核对代际，旧工程的异步结果不得写入新工程。 */
export function createProjectScanner(ctx: ProjectScanContext) {
  let generation = 0;

  async function scan(folder: string): Promise<void> {
    const request = ++generation;
    const current = () => request === generation;
    ctx.progress("扫描文件…");
    let files;
    try { files = await scanFolder(folder); }
    catch (error) { if (current()) await ctx.failed(error); return; }
    if (!current()) return;
    const ipDirs = files.xci.map(f => f.slice(0, f.lastIndexOf("/")));
    const userFile = (file: string) => !ipDirs.some(dir => file.startsWith(dir + "/"));
    const constraints = files.con.filter(userFile);
    ctx.setConstraints(constraints);
    const hdl = files.hdl.filter(userFile);
    let done = 0;
    for (const file of hdl) {
      if (!current()) return;
      try {
        const content = await readFile(file);
        if (!current()) return;
        ctx.contents.set(file, content);
        ctx.structures.set(file, scanStructure(content.content, file));
      } catch (error) { if (!current()) return; console.error("read failed:", file, error); }
      if (++done % 8 === 0 || done === hdl.length) {
        ctx.progress(`解析结构 ${done}/${hdl.length}`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    const ips: IpInfo[] = [];
    for (const file of files.xci) {
      if (!current()) return;
      try {
        const { content } = await readFile(file);
        if (!current()) return;
        ips.push(parseXci(content, file));
      } catch (error) { if (!current()) return; console.error("xci parse failed:", file, error); }
    }
    if (!current()) return;
    ctx.setIps(ips);
    for (const file of constraints) {
      if (!current()) return;
      try {
        const content = await readFile(file);
        if (!current()) return;
        ctx.contents.set(file, content);
      } catch (error) { if (!current()) return; console.error("read failed:", file, error); }
    }
    if (current()) ctx.complete();
  }

  return { scan, cancel: () => { ++generation; } };
}
