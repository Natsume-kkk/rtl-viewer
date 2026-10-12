// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import { SignalProject } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";

const setup=()=>{
 const files=new Map([["t.v","module t(input a,b,sel,clk,output y); wire x=a+b; reg r; always @(posedge clk) if(sel) r<=x; else r<=0; assign y=r+1; child u(.i(r)); endmodule module child(input i); wire q=~i; endmodule"]]);
 const p=new SignalProject(files),c=new ComputationProject(files,p),ctx=p.root("t")!,g=localLogic(c,p,ctx,"r");
 const root=document.createElement("aside"),navigate=vi.fn();document.body.append(root);
 const panel=new SignalFlowPanel(root,{close:vi.fn(),context:vi.fn(),navigate});panel.logicResult("r",ctx,g,files,"");return{root,panel,navigate};
};
it("条件全列出，多支共享一个输出，收起一支保留另一支",()=>{
 const{root}=setup();const card=root.querySelector<HTMLElement>('[data-node="r"]')!;
 const branches=card.querySelectorAll<HTMLDetailsElement>("details");expect(branches.length).toBe(2);expect([...branches].every(d=>!d.open)).toBe(true);
 expect(root.querySelector<HTMLElement>('[data-node="y"]')!.hidden).toBe(true);
 branches[0].querySelector("summary")!.click();
 expect(root.querySelector<HTMLElement>('[data-node="y"]')!.hidden).toBe(false);
 branches[1].querySelector("summary")!.click();expect(branches[0].open).toBe(true);
 expect(root.querySelectorAll('[data-node="y"]')).toHaveLength(1);
 branches[0].querySelector("summary")!.click();expect(branches[0].open).toBe(false);expect(branches[1].open).toBe(true);expect(root.querySelector<HTMLElement>('[data-node="x"]')!.hidden).toBe(false);expect(root.querySelector<HTMLElement>('[data-node="y"]')!.hidden).toBe(false);
 root.remove();
});
it("全部展开和返回恢复保留分支状态，定位不更换追踪目标",()=>{
 const{root,panel,navigate}=setup();
 [...root.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="全部展开")!.click();
 expect([...root.querySelectorAll<HTMLDetailsElement>("details")].every(d=>d.open)).toBe(true);
 const saved=panel.capture();[...root.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="全部收起")!.click();expect(root.querySelector<HTMLElement>('[data-node="y"]')!.hidden).toBe(true);panel.restore(saved);
 expect([...root.querySelectorAll<HTMLDetailsElement>("details")].every(d=>d.open)).toBe(true);
 root.querySelector<HTMLButtonElement>('[data-node="r"] button[data-file]')!.click();expect(navigate).toHaveBeenCalled();expect(root.querySelector(".flow-selected")!.textContent).toBe("r");
 expect(root.querySelector(".logic-enter")).toBeNull();root.remove();
});

it("分支后的运算保留在每支赋值中，不误显示为多次独立赋值",()=>{
 const files=new Map([["t.v","module t(input a,b,sel,output reg y); reg x; always @* begin if(sel) x=a; else x=b; y=x+1; end endmodule"]]);const p=new SignalProject(files),ctx=p.root("t")!,c=new ComputationProject(files,p);
 const root=document.createElement("aside");document.body.append(root);new SignalFlowPanel(root,{close:vi.fn(),context:vi.fn(),navigate:vi.fn()}).logicResult("y",ctx,localLogic(c,p,ctx,"y"),files,"");
 const branches=root.querySelectorAll('[data-node="y"] details');expect(branches).toHaveLength(2);expect(branches[0].textContent).toContain("+ 1");expect(branches[1].textContent).toContain("+ 1");expect(root.querySelectorAll('[data-node="y"] .branch-preview')).toHaveLength(2);expect(root.querySelectorAll('[data-node="y"] .logic-expression')).toHaveLength(0);root.remove();
});

it("嵌套条件按代码逐级选择，不提前接出后续",()=>{
 const files=new Map([["t.v","module t(input a,b,c,s1,s2,output y); reg r; always @* if(s1) begin if(s2) r=a; else r=b; end else r=c; assign y=r; endmodule"]]);const p=new SignalProject(files),ctx=p.root("t")!,c=new ComputationProject(files,p);const root=document.createElement("aside");document.body.append(root);const panel=new SignalFlowPanel(root,{close:vi.fn(),context:vi.fn(),navigate:vi.fn()});panel.logicResult('r',ctx,localLogic(c,p,ctx,'r'),files,'');
 const branches=root.querySelectorAll<HTMLDetailsElement>('[data-node="r"] > .logic-driver > .logic-branches > details');expect(branches).toHaveLength(2);const output=root.querySelector<HTMLElement>('[data-node="y"]')!;expect(output.hidden).toBe(true);
 branches[0].querySelector('summary')!.click();expect(output.hidden).toBe(true);const child=root.querySelector<HTMLElement>('.branch-card')!;expect(child.hidden).toBe(false);child.querySelector('summary')!.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));expect(output.hidden).toBe(false);branches[0].querySelector('summary')!.click();expect(child.hidden).toBe(true);expect(output.hidden).toBe(true);root.remove();
});
it("内部信号多去向独立继续，保留原路径和返回状态",()=>{
 const files=new Map([["t.v","module t(input a,output y,z); wire r=a; wire b=r+1; wire c=r+2; assign y=b; assign z=c; endmodule"]]);const p=new SignalProject(files),ctx=p.root("t")!,c=new ComputationProject(files,p),root=document.createElement('aside');document.body.append(root);const panel=new SignalFlowPanel(root,{close:vi.fn(),context:vi.fn(),navigate:vi.fn()});panel.logicResult('r',ctx,localLogic(c,p,ctx,'r'),files,'');
 const card=(id:string)=>root.querySelector<HTMLElement>(`[data-node="${id}"]`)!;
 expect(card('b').hidden).toBe(false);expect(card('c').hidden).toBe(false);expect(card('y').hidden).toBe(true);expect(card('z').hidden).toBe(true);
 card('b').querySelector<HTMLButtonElement>('.path-continue')!.click();expect(card('y').hidden).toBe(false);expect(card('z').hidden).toBe(true);const saved=panel.capture();
 card('c').querySelector<HTMLButtonElement>('.path-continue')!.click();expect(card('y').hidden).toBe(false);expect(card('z').hidden).toBe(false);panel.restore(saved);expect(card('y').hidden).toBe(false);expect(card('z').hidden).toBe(true);expect(card('r').classList.contains('selected')).toBe(true);root.remove();
});
