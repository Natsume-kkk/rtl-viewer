import { describe, it, expect } from "vitest";
import { SignalProject, traceSignal } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic, loadPortSites, signalMode } from "../src/analysis/local";

const source = `module top(input a,b,sel,clk, output reg y); wire x,z; reg r;
assign x=a+b;
always @(posedge clk) if(sel) r<=x; else r<=0;
assign z=r+1; always @* y=z;
child u1(.i(x),.o()); child u2(.i(x),.o()); endmodule
module child(input i,output o); wire inner; assign inner=~i; assign o=inner; endmodule`;
const setup = (text=source) => { const files=new Map([["t.v",text]]),p=new SignalProject(files);return {p,c:new ComputationProject(files,p),ctx:p.root("top")!}; };
const flatten=(n: Awaited<ReturnType<typeof traceSignal>>):string[]=>[n.label,...n.children.flatMap(flatten)];
describe("正式信号链两种模式",()=>{
 it("端口追踪识别 wire 声明赋值，reg 初始化不冒充连续驱动",async()=>{const{p,c,ctx}=setup("module top(input a,b); wire [7:0] x=a+b; reg q=a; endmodule");const d=await traceSignal(p,ctx,"a","downstream",{stopAtAssignments:true});expect(flatten(d)).toContain("x ← a+b");expect(flatten(d).some(n=>n.startsWith("q ←"))).toBe(false);expect(c.moduleData(ctx)!.drivers.get("x")).toHaveLength(1);});
 it("output reg 按端口身份分类，内部 reg/wire 按逻辑分类",()=>{const{p,ctx}=setup();expect(signalMode(p,ctx,"y")).toBe("port");expect(signalMode(p,ctx,"r")).toBe("logic");expect(signalMode(p,ctx,"x")).toBe("logic");});
 it("端口连接两侧在第一处赋值或顶层接口停止",async()=>{const{p,ctx}=setup();const up=await traceSignal(p,ctx,"a","upstream",{stopAtAssignments:true});expect(JSON.stringify(up)).toContain("顶层输入");const down=await traceSignal(p,ctx,"a","downstream",{stopAtAssignments:true});expect(flatten(down)).toContain("x ← a+b");expect(flatten(down).some(s=>s==="top.r")).toBe(false);});
 it("同一个端口扇出到多个模块，独立保留各路赋值终点",async()=>{const{p,ctx}=setup("module top(input a); child u1(.i(a)); child u2(.i(a)); endmodule module child(input i); wire x; assign x=~i; endmodule");const d=await traceSignal(p,ctx,"a","downstream",{stopAtAssignments:true});expect(d.children.map(n=>n.label)).toEqual(["top/u1.i","top/u2.i"]);expect(d.children.every(n=>n.children[0]?.reason==="赋值位置")).toBe(true);});
 it("内部信号包含相关输入及后续输出，子模块仅保留端口边界",()=>{const{p,c,ctx}=setup();const g=localLogic(c,p,ctx,"x");const labels=g.nodes.map(n=>n.label);expect(labels).toEqual(expect.arrayContaining(["a","b","x","r","z","y","u1.i","u2.i"]));expect(labels).not.toContain("inner");expect(g.nodes.filter(n=>n.portContext).map(n=>n.portContext!.path)).toEqual(["top/u1","top/u2"]);});
 it("右键追踪子模块内部信号的图不跨回父模块，不展开无关逻辑",()=>{const{p,c,ctx}=setup();const child=p.child(ctx,p.module("top")!.instances[0]);const g=localLogic(c,p,child,"inner");expect(g.nodes.every(n=>!n.portContext&&n.path===child.path)).toBe(true);expect(g.nodes.map(n=>n.label)).toEqual(expect.arrayContaining(["i","inner","o"]));expect(g.nodes.some(n=>n.label==="x")).toBe(false);});
 it("上游子模块输出不能反推出其输入，多个驱动全部保留",()=>{const{p,c,ctx}=setup("module top(input a,output y); wire x; child u(.i(a),.o(x)); assign x=1'b0; assign y=x; endmodule module child(input i,output o); assign o=~i; endmodule");const g=localLogic(c,p,ctx,"x");expect(g.nodes.some(n=>n.label==="u.o")).toBe(true);expect(g.nodes.some(n=>n.label==="a")).toBe(false);expect(g.nodes.find(n=>n.label==="x")!.kind).toBe("resolved");});
 it("组合反馈与未知运算不会无限展开",()=>{const{p,c,ctx}=setup("module top(input a,output y); wire x; assign x=x+a; assign y=func(x); endmodule");const g=localLogic(c,p,ctx,"x");expect(g.nodes.length).toBeLessThan(12);expect(g.nodes.some(n=>n.detail.includes("反馈"))).toBe(true);expect(g.nodes.find(n=>n.label==="y")!.kind).toBe("boundary");});
 it("同过程非阻塞赋值保留寄存器后续连接并标明读取 Q",()=>{const{p,c,ctx}=setup("module top(input clk,a,output y); reg r,q; always @(posedge clk) begin r<=a; q<=r; end assign y=q; endmodule");const g=localLogic(c,p,ctx,"r");expect(g.edges).toContainEqual(expect.objectContaining({from:"r",to:"q",current:true}));expect(g.edges).toContainEqual(expect.objectContaining({from:"q",to:"y"}));});
 it("自保持与互相读取寄存器均以时序边界结束递归",()=>{const{p,c,ctx}=setup("module top(input clk,en,a,output y); reg r,q; always @(posedge clk) begin if(en) r<=q; q<=r; end assign y=q; endmodule");const g=localLogic(c,p,ctx,"r");expect(g.nodes.length).toBeLessThan(15);expect(g.nodes.some(n=>n.label==="r (Q)")).toBe(true);expect(g.nodes.some(n=>n.detail.includes("组合反馈"))).toBe(false);});

 it("预算终点不允许进入未分析的赋值",async()=>{const{p,ctx}=setup();const g=await traceSignal(p,ctx,"a","downstream",{stopAtAssignments:true,maxNodes:1});expect(g.children[0].reason).toContain("预算");expect(g.children[0].target).toBeUndefined();});
 it("VHDL 内部 signal 在本模块端口结束并保留 elsif 分支",()=>{
  const files=new Map([["t.vhd",`entity vtop is port(a,b,sel,clk: in bit; y: out bit); end;
  architecture rtl of vtop is signal r: bit; begin
  process(clk) begin if rising_edge(clk) then if sel='1' then r<=a; elsif a='0' then r<=b; else r<='0'; end if; end if; end process;
  y<=r; end;`]]);const p=new SignalProject(files),c=new ComputationProject(files,p),ctx=p.root("vtop")!;
  expect(signalMode(p,ctx,"Y")).toBe("port");const g=localLogic(c,p,ctx,"R");expect(g.nodes.map(n=>n.label)).toEqual(expect.arrayContaining(["r","a","b","y"]));expect(g.nodes.find(n=>n.label==="r")!.drivers[0].expression.kind).toBe("select");expect(g.nodes.every(n=>n.path==="vtop")).toBe(true);
 });

 it("下游到无法推导的过程即停止，不穿透不确定关系",()=>{const{p,c,ctx}=setup("module top(input a,output y); wire x=a; reg r; always @* r=func(x); assign y=r; endmodule");const g=localLogic(c,p,ctx,"x");expect(g.nodes.find(n=>n.label==="r")!.kind).toBe("boundary");expect(g.nodes.some(n=>n.label==="y")).toBe(false);});
 it("下游信号用作判断条件时以条件连线连接",()=>{const{p,c,ctx}=setup("module top(input a,output y); wire x=a; wire en=x; assign y=en?1'b1:1'b0; endmodule");const g=localLogic(c,p,ctx,"x");expect(g.edges).toContainEqual(expect.objectContaining({from:"en",to:"y",control:true}));});

});

it("端口预览区分复用实例，双向端口仅显示本模块的直接读写",async()=>{
 const {p,c,ctx}=setup("module top; wire x; child u1(.io(x)); child u2(.io(x)); endmodule module child(inout io); wire next=~io; assign io=next; endmodule");
 const g=localLogic(c,p,ctx,"x");await loadPortSites(g,p,()=>false);
 const endpoints=g.nodes.filter(n=>n.portSites);expect(endpoints.map(n=>n.path)).toEqual(["top/u1","top/u2"]);
 for(const node of endpoints){
  expect(node.portSites!.map(s=>s.direction)).toEqual(["upstream","downstream"]);
  expect(node.portSites![0].trace.children.find(s=>s.reason==="赋值位置")?.statement).toBe("assign io=next;");
  expect(node.portSites![1].trace.children.find(s=>s.reason==="赋值位置")?.statement).toBe("wire next=~io;");
  expect(node.portSites!.every(s=>s.trace.owner===node.path&&s.trace.children.every(c=>!c.children.length))).toBe(true);
 }
 expect(g.nodes.filter(n=>!n.portSites).every(n=>n.path==="top")).toBe(true);
});

it("子端口预览可取消，不把部分结果交给渲染",async()=>{
 const {p,c,ctx}=setup();const g=localLogic(c,p,ctx,"x");
 await expect(loadPortSites(g,p,()=>true)).rejects.toThrow("cancelled");
});

it("双向端口转接仅向子模块找直接读写，不回溯父模块的其他驱动",async()=>{
 const {p,c,ctx}=setup("module top; wire x; assign x=1'b0; child u(.io(x)); endmodule module child(inout io); leaf sub(.io(io)); endmodule module leaf(inout io); wire used=io; assign io=1'b1; endmodule");
 const g=localLogic(c,p,ctx,"x");await loadPortSites(g,p,()=>false);
 const node=g.nodes.find(n=>n.portContext)!;
 const text=JSON.stringify(node.portSites);
 expect(text).toContain("assign io=1'b1;");expect(text).toContain("wire used=io;");
 expect(text).not.toContain("assign x=1'b0;");
});

it("多层端口预览保持原有预算截断提示",async()=>{
 const {p,c,ctx}=setup(`module top; wire x; child u(.i(x)); endmodule module child(input i); ${Array.from({length:130},(_,i)=>`leaf u${i}(.i(i));`).join(" ")} endmodule module leaf(input i); wire q=~i; endmodule`);
 const g=localLogic(c,p,ctx,"x");await loadPortSites(g,p,()=>false);
 const trace=g.nodes.find(n=>n.portSites)?.portSites?.[0].trace;
 expect(JSON.stringify(trace)).toContain("达到分析预算");
 const count=(n:any):number=>1+n.children.reduce((sum:number,c:any)=>sum+count(c),0);
 expect(count(trace)).toBeLessThanOrEqual(122);
});
