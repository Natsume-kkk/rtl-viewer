// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ModuleIndex } from "../src/model";
import { scanStructure } from "../src/parser";

vi.mock("../src/editor/monaco", () => ({ monaco: { editor: { tokenize: (source:string) => source.split("\n").map(()=>[{offset:0,type:"identifier"}]) } } }));
import { createSignalController } from "../src/app/signal-controller";

afterEach(()=>document.body.replaceChildren());
async function setup(child:string,signal="s_monitor_status",video="module video(output o); wire hidden=1'b1; assign o=hidden; endmodule") {
  let source=`module top(input clk, output y);
wire s_monitor_status;
video u_video(.o(s_monitor_status));
uart u_uart(.i_status({s_monitor_status,1'b0}),.clk(clk),.o(y));
endmodule
${video}
${child}`;
  const file="D:/test/endpoints.v",index=new ModuleIndex(),root=document.createElement("aside");
  const structures=new Map([[file,scanStructure(source,file)]]);index.addStructure([...structures.values()].flat());document.body.append(root);
  const navigate=vi.fn(async()=>{});let word=signal;
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word}),getLanguageId:()=>"verilog",getVersionId:()=>1,getValue:()=>source};
  const controller=createSignalController(root,{
    editor:()=>({getModel:()=>model,getPosition:()=>({lineNumber:2,column:6})}) as any,
    files:()=>new Map([[file,source]]).keys(),structures:()=>structures,index:()=>index,topName:()=>"top",instancePath:()=>"top",
    fileContent:()=>source,isOpen:()=>true,close:vi.fn(),navigate,hint:vi.fn(),
  });
  await controller.analyze();
  return {root,controller,navigate,file,edit:(text:string)=>{source=source.replace("{1'b0,i_status,enable}",text);word="clk";controller.invalidate();}};
}
const uart=`module uart(input [1:0] i_status,input clk,output o);
wire enable=clk;
wire [3:0] status_byte;
assign status_byte={1'b0,i_status,enable};
wire later=status_byte[0];
assign o=later;
endmodule`;

it("内部连线的子端口直接显示第一层驱动与使用，不引入其他操作数和下游依赖",async()=>{
  const {root,navigate,file}=await setup(uart);
  expect(root.querySelector(".flow-selected")?.textContent).toBe("s_monitor_status");
  expect(root.querySelectorAll(".logic-card")).toHaveLength(3);
  const input=root.querySelector<HTMLElement>('[data-node="child:u_uart:i_status"]')!;
  expect(input.textContent).toContain("assign status_byte={1'b0,i_status,enable};");
  expect(input.querySelector(".port-mapping")?.textContent).toContain(".i_status({s_monitor_status,1'b0})");
  expect(root.querySelector('[data-node="child:u_video:o"]')?.textContent).toContain("assign o=hidden;");
  expect(root.querySelectorAll(".logic-enter,.flow-enter")).toHaveLength(0);
  expect(root.querySelector('[data-signal="enable"],[data-signal="later"],[data-signal="hidden"]')).toBeNull();
  const jump=input.querySelector<HTMLButtonElement>(".port-site button[data-file]")!;jump.click();
  expect(navigate).toHaveBeenCalledWith(file,10);
  expect(root.querySelector(".flow-selected")?.textContent).toBe("s_monitor_status");
  for(const title of ["全部展开","全部收起"]) [...root.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===title)!.click();
  expect(root.querySelectorAll(".logic-card")).toHaveLength(3);
  expect(input.textContent).toContain("status_byte");
});

it("多处直接使用分别展示，条件和时钟用途保留源码位置",async()=>{
  const {root}=await setup(`module uart(input i_status,clk,output reg o);
wire a=~i_status;
wire b=i_status&clk;
always @(posedge clk) if(i_status) o<=1; else o<=0;
always @(posedge i_status) begin end
endmodule`);
  const input=root.querySelector('[data-node="child:u_uart:i_status"]')!;
  expect(input.textContent).toContain("a=~i_status");expect(input.textContent).toContain("b=i_status&clk");
  expect(input.textContent).toMatch(/if\s*\(i_status\)/);expect(input.textContent).toContain("posedge i_status");
  expect(input.querySelectorAll(".port-site").length).toBeGreaterThanOrEqual(4);
});

it("输入端口经转接追到第一处使用赋值，不继续追赋值目标",async()=>{
  const {root}=await setup(`module uart(input i_status,clk,output o); leaf u(.i(i_status),.o(o)); endmodule
module leaf(input i,output o); wire used=~i; assign o=used; endmodule`);
  const input=root.querySelector('[data-node="child:u_uart:i_status"]')!;
  expect(input.textContent).toContain("u.used");
  expect(input.textContent).toContain("wire used=~i;");
  expect(input.textContent).not.toContain("assign o=used;");
  expect(input.querySelector(".signal-match")?.textContent).toBe("i");
  expect(root.querySelectorAll(".logic-card")).toHaveLength(3);
});

it("输出端口连续转接到真实驱动赋值，保留实例路径与源码定位",async()=>{
  const {root,navigate,file}=await setup(uart,"s_monitor_status",`module video(output o); bridge u_monitor(.status(o)); endmodule
module bridge(output status); source u_core(.q(status)); endmodule
module source(output q); wire hidden=1'b1; assign q=hidden; endmodule`);
  const output=root.querySelector('[data-node="child:u_video:o"]')!;
  expect(output.textContent).toContain("u_monitor/u_core.q");
  expect(output.textContent).toContain("assign q=hidden;");
  expect(output.textContent).not.toContain("wire hidden=1'b1;");
  output.querySelector<HTMLButtonElement>(".port-site button[data-file]")!.click();
  expect(navigate).toHaveBeenCalledWith(file,8);
  expect(root.querySelectorAll(".logic-card")).toHaveLength(3);
  expect(root.querySelector(".flow-selected")?.textContent).toBe("s_monitor_status");
});

it("转接后扇出分别保留各实例的第一处使用和未知分支",async()=>{
  const {root}=await setup(`module uart(input i_status,clk,output o);
leaf u1(.i(i_status)); leaf u2(.i(i_status)); missing u3(.i(i_status));
endmodule
module leaf(input i); wire used=~i; wire later=used; endmodule`);
  const input=root.querySelector('[data-node="child:u_uart:i_status"]')!;
  expect(input.textContent).toContain("u1.used");expect(input.textContent).toContain("u2.used");
  expect(input.textContent).toContain("黑盒或缺失定义");
  expect(input.textContent).not.toContain("wire later=used");
  expect(input.querySelectorAll(".port-site")).toHaveLength(3);
});

it("递归例化明确停止，不生成无限转接预览",async()=>{
  const {root}=await setup(`module uart(input i_status,clk,output o); relay u(.i(i_status)); endmodule
module relay(input i); uart u(.i_status(i)); endmodule`);
  const input=root.querySelector('[data-node="child:u_uart:i_status"]')!;
  expect(input.textContent).toContain("循环例化，停止重复展开");
  expect(input.querySelectorAll(".port-site")).toHaveLength(1);
  expect(root.querySelectorAll(".logic-card")).toHaveLength(3);
});

it("同一过程同时读取数据和用作条件时，两处直接赋值都可见",async()=>{
  const {root}=await setup(`module uart(input i_status,clk,output reg o);
reg r;
always @(posedge clk) begin
r<=i_status;
if(i_status) o<=1; else o<=0;
end
endmodule`);
  const input=root.querySelector('[data-node="child:u_uart:i_status"]')!;
  expect([...input.querySelectorAll(".port-site .operation-name")].map(n=>n.textContent)).toEqual(["r","o"]);
  expect(input.textContent).toMatch(/if\s*\(i_status\)/);
  expect(root.querySelector('[data-node="r"],[data-node="o"]')).toBeNull();
});

it("缺失定义不会伪造使用位置",async()=>{
  const {root}=await setup("");
  const input=root.querySelector('[data-node="child:u_uart:i_status"]')!;
  expect(input.textContent).toContain("黑盒或缺失定义");expect(input.querySelector(".port-site")).toBeNull();
});

it("刷新仍保留内部信号目标，并更新端口第一层源码",async()=>{
  const {root,edit}=await setup(uart);edit("i_status");
  root.querySelector<HTMLButtonElement>(".result-stale")!.click();
  await vi.waitFor(()=>expect(root.querySelector('[data-node="child:u_uart:i_status"]')?.textContent).toContain("assign status_byte=i_status;"));
  expect(root.querySelector(".flow-selected")?.textContent).toBe("s_monitor_status");
  expect(root.querySelectorAll(".logic-card")).toHaveLength(3);
});
