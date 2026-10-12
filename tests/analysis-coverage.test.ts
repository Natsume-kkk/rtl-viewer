import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { SignalProject, traceSignal } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic, loadPortSites } from "../src/analysis/local";

const samples = ["analysis_top.vhd", "analysis_leaf.vhd", "parameter_top.v"];
function setup() {
  const files = new Map(samples.map(name => {
    const file=resolve("tests/samples/analysis",name).replace(/\\/g,"/");
    return [file,readFileSync(file,"utf8")];
  }));
  const project=new SignalProject(files),computation=new ComputationProject(files,project);
  return {files,project,computation};
}

it("截图同类代码：位写过程和四个生成实例都能阅读，并定位到原文件",async()=>{
  const {files,project,computation}=setup(),ctx=project.root("analysis_top")!;
  const mod=project.moduleForContext(ctx)!;
  expect(mod.problem).toBeUndefined();
  expect(mod.instances.map(i=>i.inst)).toEqual(["lanes[0].receiver","lanes[1].receiver","lanes[2].receiver","lanes[3].receiver"]);
  const graph=localLogic(computation,project,ctx,"lane_valid");
  const target=graph.nodes.find(n=>n.id===graph.root)!;
  expect(target.drivers.some(d=>d.targetText==="lane_valid(0)")).toBe(true);
  expect(target.drivers.some(d=>d.targetText==="lane_valid(3)")).toBe(true);
  expect(graph.nodes.filter(n=>n.port?.name==="valid")).toHaveLength(4);
  expect(graph.nodes.some(n=>n.detail.includes("generate 需展开"))).toBe(false);
  await loadPortSites(graph,project,()=>false);
  for(const port of graph.nodes.filter(n=>n.port?.name==="valid")) {
    expect(JSON.stringify(port.portSites)).toContain("seen <= valid");
    expect(port.port?.path).toMatch(/lanes\[[0-3]\]\.receiver$/);
  }
  for(const driver of target.drivers)expect(files.get(driver.source.file)?.slice(driver.source.start,driver.source.end)).toContain("lane_valid");
});

it("ROM 初始化、动态地址和嵌套类型转换保留各自含义",()=>{
  const {project,computation}=setup(),ctx=project.root("analysis_top")!;
  const graph=localLogic(computation,project,ctx,"selected_data");
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({from:"rom",to:"selected_data",role:"数据"}),
    expect.objectContaining({from:"address",to:"selected_data",role:"地址"}),
  ]));
  expect(graph.nodes.some(n=>n.signal==="rom_type")).toBe(false);
  const rom=graph.nodes.find(n=>n.signal==="rom")!;
  expect(rom.drivers.some(d=>d.expression.text.includes('x"12"'))).toBe(true);
  const output=graph.nodes.find(n=>n.signal==="data_out")!;
  expect(output.kind).not.toBe("boundary");
  expect(output.drivers[0].expression.text).toContain("std_logic_vector");
});

it("同模块不同参数实例的位写数量与源码位置互不污染",()=>{
  const {project,computation,files}=setup(),root=project.root("parameter_top")!;
  const top=project.moduleForContext(root)!;
  const narrow=project.child(root,top.instances.find(i=>i.inst==="u_narrow")!);
  const wide=project.child(root,top.instances.find(i=>i.inst==="u_wide")!);
  const first=computation.moduleData(narrow)!,second=computation.moduleData(wide)!;
  expect(first.drivers.get("dout")).toHaveLength(4);
  expect(second.drivers.get("dout")).toHaveLength(8);
  expect(computation.moduleData(narrow)?.drivers.get("dout")).toHaveLength(4);
  for(const driver of second.drivers.get("dout")!)expect(files.get(driver.source.file)?.slice(driver.source.start,driver.source.end)).toContain("din[i]");
});

it("端口切片仍展示第一处赋值，动态写下标不成为子模块输出的驱动目标",async()=>{
  const source="module top(input [7:0] a,input [1:0] addr,output [7:0] y); child u(.din(a[3:0]),.dout(y[addr])); endmodule module child(input [3:0] din,output dout); assign dout=din[0]; endmodule";
  const files=new Map([["mapping.v",source]]),project=new SignalProject(files),ctx=project.root("top")!;
  const down=await traceSignal(project,ctx,"a","downstream",{stopAtAssignments:true});
  expect(JSON.stringify(down)).toContain("assign dout=din[0]");
  const graph=localLogic(new ComputationProject(files,project),project,ctx,"addr");
  expect(graph.edges.some(e=>e.to==="addr"&&graph.nodes.find(n=>n.id===e.from)?.port?.name==="dout")).toBe(false);
});
