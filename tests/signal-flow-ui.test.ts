// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import { SignalProject, traceSignal, type TraceNode } from "../src/model/signal-flow";
const leaf=(label:string,line:number,reason?:string):TraceNode=>({label,file:"t.v",line,reason,children:[]});
const setup=()=>{const root=document.createElement("aside");document.body.append(root);const navigate=vi.fn(),enter=vi.fn();const panel=new SignalFlowPanel(root,{close:vi.fn(),context:vi.fn(),navigate,enter});return{root,panel,navigate,enter};};
const card=(root:HTMLElement,name:string)=>[...root.querySelectorAll<HTMLElement>(".port-card")].find(c=>c.dataset.signal===name)!;
it("空面板提示右键追踪，不要求移动光标",()=>{
 const{root}=setup();const hint=root.querySelector<HTMLElement>(".flow-following")!;expect(hint.hidden).toBe(false);expect(hint.textContent).toContain("追踪此信号");expect(root.querySelector(".flow-selected")).toBeNull();root.remove();
});
it("当前信号明确标记，赋值按方向命名且只突出完整标识符",()=>{
 const{root,panel}=setup();panel.result("dq",{label:"top.dq",children:[{...leaf("dq ← dq_en ? dq_out : 1'bz",4,"赋值位置"),statement:"assign dq = dq_en ? dq_out : 1'bz;"}]},{label:"top.dq",children:[{...leaf("sample ← dq",5,"赋值位置"),statement:"assign sample = dq;"}]},"");
 const focus=root.querySelector<HTMLElement>('.selected')!;expect(root.querySelectorAll('.signal-current')).toHaveLength(1);expect(focus.getAttribute('aria-label')).toBe('当前信号 dq');expect(focus.querySelector('.signal-current')?.textContent).toBe('当前信号');expect(focus.querySelector('.port-direction-toggle')).toBeNull();
 expect([...root.querySelectorAll('.operation-name')].map(n=>n.textContent)).toEqual(['dq','驱动赋值','读取赋值']);expect([...root.querySelectorAll('mark')].map(n=>n.textContent)).toEqual(['dq','dq']);expect(root.querySelector('.logic-expression')?.textContent).toBe("assign dq = dq_en ? dq_out : 1'bz;");root.remove();
});
it("端口来源、当前信号、去向用有向横向卡片连接",()=>{
 const{root,panel}=setup();panel.result("x",{label:"top.x",children:[leaf("top.a",1)]},{label:"top.x",children:[leaf("top.y",2)]},"");
 const a=card(root,"a"),x=card(root,"x"),y=card(root,"y");expect(parseFloat(a.style.left)).toBeLessThan(parseFloat(x.style.left));expect(parseFloat(x.style.left)).toBeLessThan(parseFloat(y.style.left));
 const edges=[...root.querySelectorAll<SVGPathElement>(".logic-wire")];expect(edges.some(e=>e.dataset.from===a.dataset.node&&e.dataset.to==="focus")).toBe(true);expect(edges.some(e=>e.dataset.from==="focus"&&e.dataset.to===y.dataset.node)).toBe(true);expect(edges.every(e=>e.hasAttribute("marker-end"))).toBe(true);expect(root.querySelector(".flow-body > section")).toBeNull();root.remove();
});
it("inout 外部边界并入端口本身，不重复同名节点或虚构连线",()=>{
 const{root,panel}=setup();panel.result("dq",{label:"top.dq",children:[leaf("dq ← en ? value : 1'bz",4,"赋值位置"),leaf("dq",1,"顶层输入")]},{label:"top.dq",children:[leaf("sample ← dq",5,"赋值位置"),leaf("dq",1,"顶层输出")]},"");
 expect(root.querySelectorAll(".port-card")).toHaveLength(3);expect(root.querySelectorAll(".logic-wire")).toHaveLength(2);expect(root.querySelectorAll(".port-boundary")).toHaveLength(1);expect(card(root,"dq").textContent).toContain("与外部双向连接");expect([...root.querySelectorAll('.operation-name')].filter(n=>n.textContent==='dq')).toHaveLength(1);root.remove();
});
it("每层实例路径和端口分行显示，保留两级真实连接",()=>{
 const{root,panel}=setup();panel.result("rx",{label:"top.rx",children:[leaf("rx",3,"顶层输入")]},{label:"top.rx",children:[{label:"top/u.i",port:{path:"top/u",name:"i",direction:"in"},children:[{...leaf("top/u/v.d",8),port:{path:"top/u/v",name:"d",direction:"in"}}]}]},"");
 expect(root.querySelectorAll('.port-card')).toHaveLength(3);expect(root.querySelectorAll('.logic-wire')).toHaveLength(2);
 const a=card(root,"u.i"),b=card(root,"u/v.d");expect(a.querySelector('.operation-name')?.textContent).toBe('u');expect(a.querySelector('.port-pin')?.textContent).toBe('in i');expect(b.querySelector('.operation-name')?.textContent).toBe('u/v');expect(b.querySelector('.port-pin')?.textContent).toBe('in d');expect(card(root,'rx').querySelector('.port-boundary')?.textContent).toContain('外部输入');root.remove();
});
it("条件及寄存器提示保留，源码图标点击不更换目标",()=>{
 const{root,panel,navigate}=setup();panel.result("y",{label:"top.y",children:[]},{label:"top.y",children:[{...leaf("top.a",3),note:"条件: sel",tip:"寄存器级：clk"}]},"");const jump=root.querySelector<HTMLButtonElement>('button[data-line="3"]')!;expect(jump.title).toContain("寄存器级：clk");expect(card(root,"a").textContent).toContain("条件: sel");jump.click();expect(navigate).toHaveBeenCalledWith("t.v",3);expect(root.querySelector(".flow-selected")?.textContent).toBe("y");root.remove();
});
it("单分支长链默认可读，全部直接扇出都列出",()=>{
 const{root,panel}=setup();const chain={label:"top.a",children:[{...leaf("top.b",2),children:[{...leaf("top.c",3),children:[leaf("top.d",4)]}]}]};panel.result("a",chain,{label:"top.a",children:Array.from({length:12},(_,i)=>leaf(`top/u${i}.i`,i+10))},"");expect([...root.querySelectorAll<HTMLElement>(".port-card")].filter(n=>!n.hidden)).toHaveLength(16);expect(card(root,"c").hidden).toBe(false);root.remove();
});
it("多路先列直接去向，单路收起不影响其他路线，返回恢复选择",()=>{
 const{root,panel,navigate}=setup();const branch=(name:string,line:number)=>({...leaf(name,line),children:[{...leaf(name+"1",line+1),children:[leaf(name+"2",line+2)]}]});
 panel.result("x",{label:"top.x",children:[branch("top.a",10)]},{label:"top.x",children:[branch("top/u.i",2),branch("top/v.i",5)]},"");
 expect(card(root,"a2").hidden).toBe(false);expect(card(root,"u.i").hidden).toBe(false);expect(card(root,"v.i").hidden).toBe(false);expect(card(root,"u.i1").hidden).toBe(true);expect(card(root,"v.i1").hidden).toBe(true);
 card(root,"u.i").querySelector<HTMLButtonElement>(".source-jump")!.click();expect(navigate).toHaveBeenCalled();expect(card(root,"u.i1").hidden).toBe(true);
 card(root,"u.i").querySelector<HTMLElement>(".operation-name")!.click();expect(card(root,"u.i2").hidden).toBe(false);expect(card(root,"v.i1").hidden).toBe(true);
 const state=panel.capture();card(root,"v.i").querySelector<HTMLButtonElement>(".path-continue")!.click();expect(card(root,"v.i2").hidden).toBe(false);expect(card(root,"u.i2").hidden).toBe(false);
 card(root,"u.i").click();expect(card(root,"u.i2").hidden).toBe(true);expect(card(root,"v.i2").hidden).toBe(false);expect(root.querySelector('.flow-selected')?.textContent).toBe('x');
 panel.restore(state);expect(card(root,"u.i2").hidden).toBe(false);expect(card(root,"v.i1").hidden).toBe(true);expect(card(root,"a2").hidden).toBe(false);
 expect(root.querySelector('.port-expand,.port-direction-toggle')).toBeNull();root.remove();
});
it("单路直接延伸，到下一个扇出列候选，再按路继续",()=>{
 const{root,panel}=setup();panel.result('x',{label:'top.x',children:[]},{label:'top.x',children:[{...leaf('top.a',2),children:[{...leaf('top.b',3),children:[leaf('top.b1',4)]},{...leaf('top.c',5),children:[leaf('top.c1',6)]}]}]},'');
 expect(card(root,'a').hidden).toBe(false);expect(card(root,'a').querySelector<HTMLButtonElement>('.path-continue')!.hidden).toBe(true);expect(card(root,'b').hidden).toBe(false);expect(card(root,'b1').hidden).toBe(true);expect(card(root,'c1').hidden).toBe(true);
 [...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='全部展开')!.click();expect(card(root,'b1').hidden).toBe(false);expect(card(root,'c1').hidden).toBe(false);root.remove();
});
it("未知方向只显示一次，用无方向虚线连接，不冒充双向",()=>{
 const{root,panel}=setup();const trace={label:"top.a",children:[leaf("top/ip.clk",3,"黑盒或缺失定义")]};panel.result("a",trace,trace,"");expect(root.querySelectorAll('[data-line="3"]')).toHaveLength(1);expect(root.textContent).toContain("方向待确认");const path=root.querySelector(".logic-wire")!;expect(path.hasAttribute("marker-end")).toBe(false);expect(path.hasAttribute("marker-start")).toBe(false);root.remove();
});
it("赋值卡片保留代码与进入模块入口，停止原因不隐藏",()=>{
 const{root,panel,enter}=setup();const target={context:{module:"top",path:"top"},signal:"q"};panel.result("a",{label:"top.a",children:[]},{label:"top.a",children:[{...leaf("q ← a + b",3,"赋值位置"),statement:"q = a + b;",target},leaf("unsupported",7,"未知语法边界")]},"");expect(root.querySelector(".logic-expression")?.textContent).toBe("q = a + b;");root.querySelector<HTMLButtonElement>(".flow-enter")!.click();expect(enter).toHaveBeenCalledWith(target.context,"q",{file:"t.v",line:3});expect(root.textContent).toContain("未知语法边界");root.remove();
});
it("时钟使用终点保留用途及源码位置",()=>{
 const{root,panel,navigate}=setup();panel.result("clk",{label:"top.clk",children:[]},{label:"top.clk",children:[{...leaf("top/u.clk",2),children:[leaf("clk · t.v",4,"控制/时钟信号，不作为数据链展开")]}]},"");root.querySelector<HTMLButtonElement>('[data-line="4"]')!.click();expect(navigate).toHaveBeenCalledWith("t.v",4);expect(root.textContent).toContain("控制/时钟信号");root.remove();
});

it("赋值卡片保留实际阻塞与非阻塞运算符，不能从时钟猜测",async()=>{
 const p=new SignalProject(new Map([["t.v","module t(input a,output reg q,r); always @* begin q<=a; r=a; end endmodule"]])),ctx=p.root("t")!;
 const up=await traceSignal(p,ctx,"q","upstream",{stopAtAssignments:true});const down=await traceSignal(p,ctx,"a","downstream",{stopAtAssignments:true});
 const{root,panel}=setup();panel.result("a",up,down,"");const text=[...root.querySelectorAll(".logic-expression")].map(n=>n.textContent).join("\n");expect(text).toMatch(/q\s*<=\s*a;/);expect(text).toMatch(/r\s*=\s*a;/);root.remove();
});
