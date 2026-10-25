import { expect, it, vi } from "vitest";
import { createProjectScanner } from "../src/app/project-scanner";
import { readFile, scanFolder } from "../src/ipc";
import { isGeneratedNetlist } from "../src/app/project-files";
vi.mock("../src/ipc", () => ({ scanFolder: vi.fn(), readFile: vi.fn() }));

it("网表识别只使用明确名称或文件头，普通文件和正文中的说明不误排除", () => {
  expect(isGeneratedNetlist("D:\\rtl\\CORE_SIM_NETLIST.VHD")).toBe(true);
  expect(isGeneratedNetlist("custom.vhd","-- Command : write_vhdl -mode funcsim custom.vhd\nentity custom is end;")).toBe(true);
  expect(isGeneratedNetlist("rtl.v","module rtl;\n// Command : write_verilog example\nendmodule")).toBe(false);
  expect(isGeneratedNetlist("my_netlist_reader.v","module my_netlist_reader; LUT5 u(); endmodule")).toBe(false);
});

it("逐文件失败汇总给界面，成功文件仍载入，目录错误也保留", async () => {
  vi.clearAllMocks();
  vi.mocked(scanFolder).mockResolvedValue({hdl:["ok.v","bad.v"],xci:["bad.xci"],con:["bad.xdc"],issues:[{file:"denied",reason:"access denied"}]});
  vi.mocked(readFile).mockImplementation(async file => {
    if(file!=="ok.v") throw new Error("读取失败");
    return {content:"module ok; endmodule",encoding:"utf8",mtime:1};
  });
  const contents=new Map(),structures=new Map(),complete=vi.fn(),failed=vi.fn();
  await createProjectScanner({contents,structures,setIps:vi.fn(),setConstraints:vi.fn(),progress:vi.fn(),complete,failed}).scan("project");
  expect([...structures.keys()]).toEqual(["ok.v"]);
  expect(complete.mock.lastCall?.[0].map((issue:{file:string})=>issue.file)).toEqual(["denied","bad.v","bad.xci","bad.xdc"]);
  expect(failed).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

it("普通目录中的明确生成网表不进入冷扫描索引，手写原语源码仍保留", async () => {
  vi.clearAllMocks();
  vi.mocked(scanFolder).mockResolvedValue({hdl:["rtl/top.v","results/post_synth_funcsim.v","results/custom.v"],xci:[],con:[]});
  vi.mocked(readFile).mockImplementation(async file => ({content:file==="results/custom.v"
    ? "// Command : write_verilog -mode funcsim custom.v\nmodule top; endmodule"
    : "module top; LUT5 u(); endmodule",encoding:"utf8",mtime:1}));
  const contents=new Map(),structures=new Map();
  await createProjectScanner({contents,structures,setIps:vi.fn(),setConstraints:vi.fn(),progress:vi.fn(),complete:vi.fn(),failed:vi.fn()}).scan("project");
  expect([...structures.keys()]).toEqual(["rtl/top.v"]);
  expect(readFile).not.toHaveBeenCalledWith("results/post_synth_funcsim.v");
  vi.clearAllMocks();
});

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
