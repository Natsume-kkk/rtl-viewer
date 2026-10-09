import { scanFolder, readFile, fileStates } from "../ipc";
import { scanStructure, parseXci } from "../parser";
import type { ModuleInfo, IpInfo } from "../parser";
import type { TabManager } from "../editor/tabs";

export interface CachedFile {
  content: string;
  encoding: string;
  /** 读取时的磁盘 mtime，外部变更检测基准 */
  mtime: number;
}

export interface ExternalWatchContext {
  folder(): string;
  contents: Map<string, CachedFile>;
  structures: Map<string, ModuleInfo[]>;
  ips(): IpInfo[];
  setIps(ips: IpInfo[]): void;
  constraints(): string[];
  setConstraints(constraints: string[]): void;
  /** 两组编辑器的标签管理器：判断文件是否打开、脏标签与警示徽章 */
  tabs: TabManager[];
  hint(message: string): void;
  markResultsStale(): void;
  updateStructure(path: string, content: string): void;
  rebuildIndex(): void;
  renderTree(): void;
}

export function createExternalWatcher(ctx: ExternalWatchContext): { start(): void } {
  let watchTimer: number | undefined;
  let watchPollCount = 0;

  function start(): void {
    window.clearInterval(watchTimer);
    watchTimer = window.setInterval(() => void pollExternalChanges(), 4000);
  }

  /** 轮询已索引文件的 mtime：干净标签静默重载，脏标签打警示徽章，未打开的增量重扫；每 4 轮 diff 一次目录增删。 */
  async function pollExternalChanges(): Promise<void> {
    if (!ctx.folder() || document.hidden) return;
    const files = [...ctx.contents.keys()];
    if (files.length > 0) {
      let states: (number | null)[];
      try {
        states = await fileStates(files);
      } catch {
        return;
      }
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const cached = ctx.contents.get(file);
        if (!cached) continue;
        const mtime = states[i];
        if (mtime === cached.mtime) continue;
        if (mtime === null) {
          handleExternalDelete(file);
          continue;
        }
        try {
          const fresh = await readFile(file);
          if (fresh.content !== cached.content) ctx.markResultsStale();
          const openTabs = ctx.tabs.filter((t) => t.findTab(file));
          const anyDirty = openTabs.some((t) => t.findTab(file)!.dirty);
          if (openTabs.length > 0 && !anyDirty) {
            // 静默重载：onFileReloaded 事件会同步缓存与结构；共享 model 的组逐个刷新标签状态
            for (const t of openTabs) {
              t.reloadFromDisk(file, fresh.content, fresh.encoding, fresh.mtime);
            }
            ctx.hint(`${file.split("/").pop() ?? file} 已被外部修改，已重新加载`);
          } else {
            cached.content = fresh.content;
            cached.encoding = fresh.encoding;
            cached.mtime = fresh.mtime;
            for (const t of openTabs) t.markExternalChanged(file, true);
            ctx.updateStructure(file, fresh.content);
          }
        } catch (e) {
          console.error("reload failed:", file, e);
        }
      }
    }
    watchPollCount += 1;
    if (watchPollCount % 4 === 1) await rescanFolderDiff();
  }

  /** 文件在磁盘被删除：打开中的标签保留缓冲区并打警示徽章，未打开的从索引移除。 */
  function handleExternalDelete(file: string): void {
    ctx.markResultsStale();
    const openTabs = ctx.tabs.filter((t) => t.findTab(file));
    if (openTabs.length > 0) {
      for (const t of openTabs) t.markExternalChanged(file, true);
      return;
    }
    ctx.contents.delete(file);
    ctx.structures.delete(file);
    ctx.rebuildIndex();
    ctx.renderTree();
  }

  /** 目录级 diff：新增 HDL/xci 纳入索引，删除的 xci 移除。 */
  async function rescanFolderDiff(): Promise<void> {
    let scan;
    try {
      scan = await scanFolder(ctx.folder());
    } catch {
      return;
    }
    const xciDirs = scan.xci.map((f) => f.slice(0, f.lastIndexOf("/")));
    const isIpGenerated = (file: string) => xciDirs.some((dir) => file.startsWith(dir + "/"));
    let changed = false;
    for (const file of scan.hdl) {
      if (isIpGenerated(file) || ctx.structures.has(file)) continue;
      try {
        const { content, encoding, mtime } = await readFile(file);
        ctx.contents.set(file, { content, encoding, mtime });
        ctx.structures.set(file, scanStructure(content, file));
        changed = true;
      } catch (e) {
        console.error("read failed:", file, e);
      }
    }
    const knownXci = new Set(ctx.ips().map((i) => i.file));
    for (const file of scan.xci) {
      if (knownXci.has(file)) continue;
      try {
        const { content } = await readFile(file);
        ctx.ips().push(parseXci(content, file));
        changed = true;
      } catch (e) {
        console.error("xci parse failed:", file, e);
      }
    }
    const xciSet = new Set(scan.xci);
    const before = ctx.ips().length;
    ctx.setIps(ctx.ips().filter((i) => xciSet.has(i.file)));
    if (ctx.ips().length !== before) changed = true;
    // 约束文件增删：新增的读入缓存，删除的从缓存移除（IP 生成目录的约束不纳入）
    const userCon = scan.con.filter((f) => !isIpGenerated(f));
    for (const file of userCon) {
      if (ctx.contents.has(file)) continue;
      try {
        const { content, encoding, mtime } = await readFile(file);
        ctx.contents.set(file, { content, encoding, mtime });
      } catch (e) {
        console.error("read failed:", file, e);
      }
    }
    const conSet = new Set(userCon);
    for (const file of ctx.constraints()) {
      if (!conSet.has(file) && !ctx.tabs.some((t) => t.findTab(file))) ctx.contents.delete(file);
    }
    if (
      userCon.length !== ctx.constraints().length ||
      userCon.some((f, i) => ctx.constraints()[i] !== f)
    ) {
      ctx.setConstraints(userCon);
      changed = true;
    }
    if (changed) {
      ctx.markResultsStale();
      ctx.rebuildIndex();
      ctx.renderTree();
    }
  }

  return { start };
}
