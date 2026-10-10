// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFile, ExternalWatchContext } from "../src/app/watcher";
import type { TabManager } from "../src/editor/tabs";
import type { IpInfo } from "../src/parser";

vi.mock("../src/ipc", () => ({
  scanFolder: vi.fn(),
  readFile: vi.fn(),
  fileStates: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTabManager(open: Record<string, { dirty: boolean }> = {}) {
  return {
    findTab: (path: string) => open[path],
    reloadFromDisk: vi.fn(),
    markExternalChanged: vi.fn(),
  } as unknown as TabManager & { markExternalChanged: ReturnType<typeof vi.fn> };
}

interface Ctx extends ExternalWatchContext {
  ipsList: IpInfo[];
  constraintsList: string[];
}

function makeCtx(overrides: Partial<ExternalWatchContext> = {}): Ctx {
  const ctx: Ctx = {
    folder: () => "D:/proj",
    contents: new Map<string, CachedFile>(),
    structures: new Map(),
    ipsList: [],
    constraintsList: [],
    ips() {
      return ctx.ipsList;
    },
    setIps(ips) {
      ctx.ipsList = ips;
    },
    constraints() {
      return ctx.constraintsList;
    },
    setConstraints(constraints) {
      ctx.constraintsList = constraints;
    },
    tabs: [],
    hint: vi.fn(),
    markResultsStale: vi.fn(),
    updateStructure: vi.fn(),
    rebuildIndex: vi.fn(),
    renderTree: vi.fn(),
    ...overrides,
  };
  return ctx;
}

const XCI_CONTENT =
  "<spirit:vendor>xilinx.com</spirit:vendor><spirit:library>ip</spirit:library>" +
  "<spirit:name>clk_wiz</spirit:name><spirit:version>6.0</spirit:version>";

async function setup() {
  vi.clearAllMocks();
  vi.resetModules();
  vi.useFakeTimers();
  const ipc = await import("../src/ipc");
  const { createExternalWatcher } = await import("../src/app/watcher");
  const mocks = {
    scanFolder: vi.mocked(ipc.scanFolder),
    readFile: vi.mocked(ipc.readFile),
    fileStates: vi.mocked(ipc.fileStates),
  };
  mocks.scanFolder.mockResolvedValue({ hdl: [], xci: [], con: [] });
  return { createExternalWatcher, mocks };
}

describe("createExternalWatcher", () => {
  it("换工程后旧文件读取失败也不能继续过滤新工程的 IP", async () => {
    const { createExternalWatcher, mocks } = await setup();
    let folder = "D:/old";
    const ctx = makeCtx({ folder: () => folder });
    const gate = deferred<{ content: string; encoding: string; mtime: number }>();
    mocks.scanFolder.mockResolvedValueOnce({ hdl: ["D:/old/a.v"], xci: [], con: [] });
    mocks.readFile.mockReturnValueOnce(gate.promise);
    const watcher = createExternalWatcher(ctx); watcher.start();
    await vi.advanceTimersByTimeAsync(4000);
    watcher.stop(); folder = "D:/new";
    ctx.ipsList = [{ file: "D:/new/ip.xci" } as IpInfo];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      gate.reject(new Error("old read failed")); await vi.advanceTimersByTimeAsync(0);
      expect(ctx.ipsList.map(ip => ip.file)).toEqual(["D:/new/ip.xci"]);
      expect(ctx.renderTree).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });
  it("停止及换工程使在飞目录扫描失效，恢复后新轮次正常运行", async () => {
    const { createExternalWatcher, mocks } = await setup();
    let folder = "D:/old";
    const ctx = makeCtx({ folder: () => folder });
    const gate = deferred<{ hdl: string[]; xci: string[]; con: string[] }>();
    mocks.scanFolder.mockReturnValueOnce(gate.promise);
    const watcher = createExternalWatcher(ctx); watcher.start();
    await vi.advanceTimersByTimeAsync(4000);
    watcher.stop(); folder = "D:/new"; watcher.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.scanFolder).toHaveBeenCalledTimes(2);
    gate.resolve({ hdl: ["D:/old/old.v"], xci: [], con: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.readFile).not.toHaveBeenCalled(); expect(ctx.contents.size).toBe(0);
    watcher.stop(); await vi.advanceTimersByTimeAsync(16000);
    expect(mocks.scanFolder).toHaveBeenCalledTimes(2);
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("单轮 poll 未完成时后续轮次直接跳过，完成后恢复轮询", async () => {
    const { createExternalWatcher, mocks } = await setup();
    const ctx = makeCtx();
    ctx.contents.set("D:/proj/a.v", { content: "module a; endmodule", encoding: "utf8", mtime: 1 });
    const gate = deferred<(number | null)[]>();
    mocks.fileStates.mockReturnValue(gate.promise);
    createExternalWatcher(ctx).start();

    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.fileStates).toHaveBeenCalledTimes(1);
    // 第一轮仍挂在 fileStates 上，后续两轮被守卫跳过
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.fileStates).toHaveBeenCalledTimes(1);

    // mtime 未变，第一轮完成；下一轮正常发起
    gate.resolve([1]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.fileStates).toHaveBeenCalledTimes(2);
  });

  it("目录 diff 在飞时后续轮次被跳过，新 xci 不会被重复 push", async () => {
    const { createExternalWatcher, mocks } = await setup();
    const ctx = makeCtx();
    const gate = deferred<{ hdl: string[]; xci: string[]; con: string[] }>();
    mocks.scanFolder.mockReturnValue(gate.promise);
    mocks.readFile.mockResolvedValue({ content: XCI_CONTENT, encoding: "utf8", mtime: 5 });
    createExternalWatcher(ctx).start();

    // 第 1 轮进入 rescanFolderDiff 并挂在 scanFolder 上；之后 4 轮全部触发但被守卫跳过，
    // 其中第 5 轮（watchPollCount 语义上）若无守卫会发起第二个并发 rescan
    await vi.advanceTimersByTimeAsync(4000 * 5);
    expect(mocks.scanFolder).toHaveBeenCalledTimes(1);

    gate.resolve({ hdl: [], xci: ["D:/proj/ip/clk_wiz.xci"], con: [] });
    await vi.advanceTimersByTimeAsync(4000);
    expect(ctx.ips().map((i) => i.file)).toEqual(["D:/proj/ip/clk_wiz.xci"]);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(mocks.readFile).toHaveBeenCalledWith("D:/proj/ip/clk_wiz.xci");

    // 下一轮目录 diff 看到同一 xci，已在 knownXci 中，不再读取也不重复 push
    mocks.scanFolder.mockResolvedValue({ hdl: [], xci: ["D:/proj/ip/clk_wiz.xci"], con: [] });
    await vi.advanceTimersByTimeAsync(4000 * 4);
    expect(ctx.ips()).toHaveLength(1);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
  });

  it("已打开文件被外部删除：保留缓冲区并打警示徽章，不重建索引", async () => {
    const { createExternalWatcher, mocks } = await setup();
    const tabs = makeTabManager({ "D:/proj/a.v": { dirty: true } });
    const ctx = makeCtx({ tabs: [tabs] });
    ctx.contents.set("D:/proj/a.v", { content: "module a; endmodule", encoding: "utf8", mtime: 1 });
    ctx.structures.set("D:/proj/a.v", []);
    mocks.fileStates.mockResolvedValue([null]);
    createExternalWatcher(ctx).start();

    await vi.advanceTimersByTimeAsync(4000);
    expect(tabs.markExternalChanged).toHaveBeenCalledWith("D:/proj/a.v", true);
    expect(ctx.contents.has("D:/proj/a.v")).toBe(true);
    expect(ctx.structures.has("D:/proj/a.v")).toBe(true);
    expect(vi.mocked(ctx.rebuildIndex)).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.renderTree)).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.markResultsStale)).toHaveBeenCalled();
  });

  it("未打开文件被外部删除：从缓存与索引移除并重建", async () => {
    const { createExternalWatcher, mocks } = await setup();
    const ctx = makeCtx();
    ctx.contents.set("D:/proj/a.v", { content: "module a; endmodule", encoding: "utf8", mtime: 1 });
    ctx.structures.set("D:/proj/a.v", []);
    mocks.fileStates.mockResolvedValue([null]);
    createExternalWatcher(ctx).start();

    await vi.advanceTimersByTimeAsync(4000);
    expect(ctx.contents.has("D:/proj/a.v")).toBe(false);
    expect(ctx.structures.has("D:/proj/a.v")).toBe(false);
    expect(vi.mocked(ctx.rebuildIndex)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.renderTree)).toHaveBeenCalledTimes(1);
  });
});
