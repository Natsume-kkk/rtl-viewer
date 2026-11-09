import { scanFolder, readFile, type ScanIssue } from "../ipc";
import { parseXci, type ModuleInfo, type IpInfo } from "../parser";
import type { CachedFile } from "./watcher";
import { projectFiles, isGeneratedNetlist } from "./project-files";
import { createStructureScanner } from "./structure-scanner";

export interface ProjectScanContext {
  contents: Map<string, CachedFile>;
  structures: Map<string, ModuleInfo[]>;
  setIps(ips: IpInfo[]): void;
  setConstraints(files: string[]): void;
  progress(message: string): void;
  complete(issues: ScanIssue[]): void;
  failed(error: unknown): Promise<void>;
}

/** 结构级扫描；读取后再次核对代际，旧工程的异步结果不得写入新工程。 */
export function createProjectScanner(ctx: ProjectScanContext) {
  let generation = 0;
  const structureScanner = createStructureScanner();

  async function scan(folder: string): Promise<void> {
    const request = ++generation;
    structureScanner.dispose();
    const current = () => request === generation;
    ctx.progress("扫描文件…");
    let files;
    try { files = await scanFolder(folder); }
    catch (error) { if (current()) await ctx.failed(error); return; }
    if (!current()) return;
    const issues = [...(files.issues ?? [])];
    const { hdl, con: constraints } = projectFiles(files);
    ctx.setConstraints(constraints);
    let done = 0;
    for (const file of hdl) {
      if (!current()) return;
      try {
        const content = await readFile(file);
        if (!current()) return;
        if (!isGeneratedNetlist(file, content.content)) {
          const modules = await structureScanner.scan(file, content.content);
          if (!current()) return;
          ctx.contents.set(file, content);
          ctx.structures.set(file, modules);
        }
      } catch (error) { if (!current()) return; issues.push({ file, reason: String(error) }); }
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
      } catch (error) { if (!current()) return; issues.push({ file, reason: String(error) }); }
    }
    if (!current()) return;
    ctx.setIps(ips);
    for (const file of constraints) {
      if (!current()) return;
      try {
        const content = await readFile(file);
        if (!current()) return;
        ctx.contents.set(file, content);
      } catch (error) { if (!current()) return; issues.push({ file, reason: String(error) }); }
    }
    if (current()) {
      structureScanner.dispose();
      ctx.complete(issues);
    }
  }

  return { scan, cancel: () => { ++generation; structureScanner.dispose(); } };
}
