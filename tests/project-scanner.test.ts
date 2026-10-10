import { expect, it, vi } from "vitest";
import { createProjectScanner } from "../src/app/project-scanner";
import { readFile, scanFolder } from "../src/ipc";
vi.mock("../src/ipc", () => ({ scanFolder: vi.fn(), readFile: vi.fn() }));

it.each(["hdl", "xci", "con"] as const)("%s 读盘期间换工程丢弃旧结果，新工程独立完成", async kind => {
  let finish!: (file: { content: string; encoding: string; mtime: number }) => void;
  const gate = new Promise<{ content: string; encoding: string; mtime: number }>(resolve => { finish = resolve; });
  const complete = vi.fn(), failed = vi.fn();
  const ips = vi.fn(), constraints = vi.fn();
  const contents = new Map(), structures = new Map();
  const scanner = createProjectScanner({ contents, structures, setIps: ips, setConstraints: constraints, progress: vi.fn(), complete, failed });
  vi.mocked(scanFolder).mockResolvedValueOnce({ hdl: [], xci: [], con: [], [kind]: ["old.v"] }).mockResolvedValueOnce({ hdl: [], xci: [], con: [] });
  vi.mocked(readFile).mockReturnValue(gate);
  const old = scanner.scan("old");
  await vi.waitFor(() => expect(readFile).toHaveBeenCalledWith("old.v"));
  contents.clear(); structures.clear(); ips.mockClear(); complete.mockClear();
  await scanner.scan("new");
  finish({ content: "module old; endmodule", encoding: "utf8", mtime: 1 }); await old;
  expect(contents.size).toBe(0); expect(structures.size).toBe(0);
  expect(ips).toHaveBeenCalledExactlyOnceWith([]); expect(complete).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

it("扫描失败清理状态回调只属于当前请求，取消后不再更新", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(scanFolder).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const failed = vi.fn(), complete = vi.fn();
  const scanner = createProjectScanner({ contents: new Map(), structures: new Map(), setIps: vi.fn(), setConstraints: vi.fn(), progress: vi.fn(), complete, failed });
  const pending = scanner.scan("old"); scanner.cancel(); reject(new Error("gone")); await pending;
  expect(failed).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  vi.mocked(scanFolder).mockRejectedValueOnce(new Error("denied")); await scanner.scan("current");
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
});
