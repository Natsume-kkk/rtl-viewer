import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { decode, walk } from "./helpers/fs-scan";
import { parseFile, parseXci, scanStructure } from "../src/parser";
import { ModuleIndex } from "../src/model";
import { buildHierarchy } from "../src/model/hierarchy";
import { SignalProject, traceSignal, type TraceNode } from "../src/model/signal-flow";

it("仓库样例覆盖混合语言层级、IP 黑盒、约束与寄存器来源", async () => {
  const root = resolve("tests/samples/basic");
  const files = { hdl: [] as string[], xci: [] as string[], con: [] as string[] };
  walk(root, files);
  const ipDirs = files.xci.map(file => file.slice(0, file.lastIndexOf("/")));
  const sources = files.hdl.filter(file => !ipDirs.some(dir => file.startsWith(dir + "/")));
  const index = new ModuleIndex();
  const structures = new Map<string, ReturnType<typeof scanStructure>>();
  const contents = new Map<string, string>();
  for (const file of sources) {
    const { content } = decode(readFileSync(file));
    const modules = scanStructure(content, file);
    index.addStructure(modules);
    structures.set(file, modules);
    contents.set(file, content);
  }
  for (const file of files.xci) index.addIp(parseXci(readFileSync(file, "utf8"), file).name, file);
  const hierarchy = buildHierarchy(index, structures);
  expect(hierarchy.tops.map(node => node.moduleName)).toEqual(["sample_top"]);
  expect(hierarchy.tops[0].children.map(node => [node.label, node.kind])).toEqual([
    ["u_clock", "ip"], ["u_register", "module"],
  ]);
  expect(sources).toHaveLength(2);
  expect(files.con.map(file => file.split("/").pop())).toEqual(["timing.xdc"]);
  const stub = resolve(root, "ip/sample_clock.v");
  expect(parseFile(readFileSync(stub, "utf8"), stub)[0].ports.map(port => port.name)).toEqual(["clk_in", "clk_out"]);
  const project = new SignalProject(contents, structures);
  const trace = await traceSignal(project, project.root("sample_register")!, "data_out", "upstream");
  const flatten = (node: TraceNode): TraceNode[] => [node, ...node.children.flatMap(flatten)];
  expect(flatten(trace).some(node => node.label.endsWith(".data_in"))).toBe(true);
});
