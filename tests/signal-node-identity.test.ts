// @vitest-environment jsdom
import { expect, it } from "vitest";
import { SignalProject, traceSignal } from "../src/model/signal-flow";
import { SignalPortsView } from "../src/ui/signal-ports";
import { SignalLogicView } from "../src/ui/signal-logic";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";

async function ports(source:string, signal="a", path="top") {
  const files=new Map([["t.v",source]]), p=new SignalProject(files), comp=new ComputationProject(files,p), ctx=comp.context(path)!;
  const up=await traceSignal(p,ctx,signal,"upstream",{stopAtAssignments:true}),down=await traceSignal(p,ctx,signal,"downstream",{stopAtAssignments:true});
  const body=document.createElement("div"),entered:string[]=[];
  const view=new SignalPortsView(signal,up,down,body,c=>entered.push(c.path));view.expandAll();
  return {body,entered};
}
function logic(source:string,signal="q") {
  const files=new Map([["t.v",source]]),p=new SignalProject(files),ctx=p.root("top")!,comp=new ComputationProject(files,p),body=document.createElement("div");
  new SignalLogicView(localLogic(comp,p,ctx,signal),body,{navigate(){}},files);
  return body;
}
it("复用模块赋值按实例隔离，分别进入正确实例",async()=>{
  const {body,entered}=await ports("module top(input a); child u1(.i(a)); child u2(.i(a)); endmodule module child(input i); wire q=~i; endmodule");
  const cards=[...body.querySelectorAll<HTMLElement>(".port-card")].filter(c=>c.querySelector(".logic-expression"));
  expect(cards).toHaveLength(2);
  expect(cards.map(c=>c.querySelector(".assignment-context")?.textContent)).toEqual(["top/u1","top/u2"]);
  cards.forEach(c=>c.querySelector<HTMLButtonElement>(".flow-enter")!.click());expect(entered).toEqual(["top/u1","top/u2"]);
});
it("真实汇合的同一实例赋值仍只显示一次",async()=>{
  const {body}=await ports("module top(input a); child u(.i(a),.j(a)); endmodule module child(input i,j); wire q=i|j; endmodule");
  expect(body.querySelectorAll(".logic-expression")).toHaveLength(1);
  const id=body.querySelector(".logic-expression")!.closest<HTMLElement>(".port-card")!.dataset.node;
  expect([...body.querySelectorAll<SVGElement>(".logic-wire")].filter(e=>e.dataset.to===id)).toHaveLength(2);
});
it("黑盒与方向未知在卡片内显示停止原因",async()=>{
  const {body}=await ports("module top(input a); missing u(.i(a)); endmodule");
  const card=[...body.querySelectorAll(".port-card")].find(c=>c.textContent?.includes("缺失定义"));
  expect(card).toBeDefined();expect(card!.querySelector(".operation-name")?.textContent).toBe("u");
  expect(card!.querySelector(".port-pin")?.textContent).toContain("i");
  expect(card!.querySelector(".flow-reason")?.textContent).toContain("缺失定义");
});
it("父模块内部信号的所属路径与名称分行",async()=>{
  const {body}=await ports("module top(output y); wire net; child u(.o(net)); assign y=net; endmodule module child(output o); assign o=1'b0; endmodule","o","top/u");
  const card=[...body.querySelectorAll(".port-card")].find(c=>c.querySelector(".signal-pin")?.textContent==="内部信号 net");
  expect(card?.querySelector(".operation-name")?.textContent).toBe("top");
});
it("切片端口映射显示原绑定语法，不冒充赋值",async()=>{
  const {body}=await ports("module top(input [7:0] a); child u(.i(a[3:0])); endmodule module child(input [3:0] i); endmodule");
  const card=[...body.querySelectorAll(".port-card")].find(c=>c.querySelector(".port-mapping"));
  expect(card?.querySelector(".operation-name")?.textContent).toBe("u");expect(card?.textContent).toContain("input i");
  expect(card?.querySelector(".port-mapping")?.textContent).toBe(".i(a[3:0])");
  expect(card?.textContent).not.toMatch(/读取赋值|驱动赋值/);
});
it("模块内运算符来自每个目标的实际赋值类型",()=>{
  const body=logic("module top(input a,clk,output y); reg q,r; always @* q<=a; always @(posedge clk) r=a; assign y=q|r; endmodule");
  expect(body.querySelector('[data-node="q"] .logic-expression')?.textContent).toBe("q <= a;");
  expect(body.querySelector('[data-node="r"] .logic-expression')?.textContent).toBe("r = a;");
});
it("模块内子端口分行显示实例与方向，切片绑定可见",()=>{
  const body=logic("module top(input [7:0] a); wire [7:0] q=a; child u(.i(q[3:0])); endmodule module child(input [3:0] i); endmodule");
  const card=body.querySelector('[data-node="child:u:i"]');
  expect(card?.querySelector(".operation-name")?.textContent).toBe("u");expect(card?.querySelector(".port-pin")?.textContent).toBe("input i");expect(card?.querySelector(".port-mapping")?.textContent).toBe(".i(q[3:0])");
});
it("模块内停止原因直接可见，不能只留在 title",()=>{
  const body=logic("module top(output y); wire q; assign y=q; endmodule");
  expect(body.querySelector('[data-node="q"] .flow-reason')?.textContent).toBe("无赋值来源");
  expect(body.querySelector('[data-node="q"]')?.textContent).not.toContain("分析边界");
});
it("未知方向不提供穿透入口，两个视图都显示原因",async()=>{
  const source="module top(input a); wire q=a; child u(.i(q)); endmodule module child(i); input i; endmodule";
  const body=logic(source);
  const card=body.querySelector('[data-node="child:u:i"]');
  expect(card?.querySelector(".flow-reason")?.textContent).toContain("端口方向未知");expect(card?.querySelector(".logic-enter")).toBeNull();
  const edges=[...body.querySelectorAll<SVGElement>(".logic-wire")].filter(e=>e.dataset.from==="child:u:i"||e.dataset.to==="child:u:i");
  expect(edges).toHaveLength(1);expect(edges[0].hasAttribute("marker-end")).toBe(false);
  expect(body.querySelector('[data-node="q"]')?.classList.contains("resolved")).toBe(false);
  const traced=await ports(source,"q");
  expect([...traced.body.querySelectorAll(".flow-reason")].some(c=>c.textContent?.includes("端口方向未知"))).toBe(true);
});
it("VHDL 端口映射保留命名关联语法，过程信号保留 <=",async()=>{
  const files=new Map([["t.vhd",`entity top is port(a: in bit_vector(7 downto 0)); end top;
architecture rtl of top is signal q: bit_vector(7 downto 0); begin
process(a) begin q <= a; end process;
u: entity work.child port map(i => q(3 downto 0)); end rtl;
entity child is port(i: in bit_vector(3 downto 0)); end child;
architecture rtl of child is begin end rtl;`]]);
  const p=new SignalProject(files),ctx=p.root("top")!,comp=new ComputationProject(files,p),body=document.createElement("div");
  new SignalLogicView(localLogic(comp,p,ctx,"q"),body,{navigate(){}},files);
  expect(body.querySelector('[data-node="q"] .logic-expression')?.textContent).toBe("q <= a;");
  expect(body.querySelector(".port-mapping")?.textContent).toBe("i => q(3 downto 0)");
});
