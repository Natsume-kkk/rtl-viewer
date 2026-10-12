// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import { SignalProject, type TraceNode } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";

const leaf=(label:string,children:TraceNode[]=[]):TraceNode=>({label,children});
function panelSetup(){
 const root=document.createElement("aside"),navigate=vi.fn();document.body.append(root);
 const panel=new SignalFlowPanel(root,{close:vi.fn(),context:vi.fn(),navigate});
 return {root,panel,navigate};
}
function portSetup(){
 const setup=panelSetup(),up=leaf("top.x",[leaf("top.a")]),down=leaf("top.x",[leaf("top.b",[leaf("top.b1")]),leaf("top.c",[leaf("top.c1")])]);
 setup.panel.result("x",up,down,"");return {...setup,up,down};
}
function logicSetup(){
 const setup=panelSetup(),files=new Map([["t.v","module t(input a,b,c,s1,s2,output y); reg r; always @* if(s1) begin if(s2) r=a; else r=b; end else r=c; assign y=r; endmodule"]]);
 const project=new SignalProject(files),context=project.root("t")!,graph=localLogic(new ComputationProject(files,project),project,context,"r");
 setup.panel.logicResult("r",context,graph,files,"");return {...setup,files,context,graph};
}
const node=(root:HTMLElement,id:string)=>[...root.querySelectorAll<HTMLElement>(".logic-card")].find(c=>c.dataset.node===id)!;
const named=(root:HTMLElement,signal:string)=>[...root.querySelectorAll<HTMLElement>(".port-card")].find(c=>c.dataset.signal===signal)!;
const key=(card:HTMLElement,key:string)=>card.querySelector<HTMLElement>(".card-resize")!.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
function pointerHandle(card:HTMLElement){
 const handle=card.querySelector<HTMLElement>(".card-resize")!,captured=new Set<number>();
 handle.setPointerCapture=vi.fn(id=>captured.add(id));handle.hasPointerCapture=vi.fn(id=>captured.has(id));handle.releasePointerCapture=vi.fn(id=>captured.delete(id));
 const fire=(type:string,x:number,id=1,button=0)=>{const event=new MouseEvent(type,{clientX:x,button,bubbles:true,cancelable:true});Object.defineProperty(event,"pointerId",{value:id});handle.dispatchEvent(event);};
 return {handle,fire,captured};
}

it("端口卡片保持默认布局，独立加宽按列推开节点和连线，不将邻列误绕路",()=>{
 const {root,panel}=portSetup(),a=named(root,"a"),focus=node(root,"focus"),b=named(root,"b"),c=named(root,"c");
 expect([a.style.left,focus.style.left,b.style.left]).toEqual(["24px","300px","576px"]);
 expect([...root.querySelectorAll<HTMLElement>(".logic-card")].every(card=>card.style.width==="236px")).toBe(true);
 const body=root.querySelector<HTMLElement>(".flow-body")!;body.scrollLeft=100;body.scrollTop=40;
 const {fire,handle}=pointerHandle(a);fire("pointerdown",100);fire("pointermove",364);fire("pointerup",364);
 expect(a.style.width).toBe("500px");expect(focus.style.width).toBe("236px");expect(focus.style.left).toBe("564px");expect(b.style.left).toBe("840px");
 expect(handle.getAttribute("aria-orientation")).toBe("vertical");expect(handle.getAttribute("aria-valuenow")).toBe("500");
 const wire=root.querySelector<SVGPathElement>(`.logic-wire[data-to="focus"]`)!;
 expect(wire.getAttribute("d")).toBe("M524,82 L564,82");
 expect(body.scrollLeft).toBe(100);expect(body.scrollTop).toBe(40);
 key(b,"ArrowRight");expect(b.style.width).toBe("260px");expect(c.style.width).toBe("236px");
 expect(root.querySelector<HTMLElement>(".logic-canvas")!.style.width).toBe("1124px");
 panel.message("");root.remove();
});

it("端口宽度收起再展开、capture/restore、同目标刷新保留，新目标和模式重置",()=>{
 const {root,panel,up,down}=portSetup(),b=named(root,"b"),next=b.querySelector<HTMLButtonElement>(".path-continue")!;
 const handle=pointerHandle(b);handle.handle.click();expect(named(root,"b1").hidden).toBe(true);
 next.click();const child=named(root,"b1");key(child,"ArrowRight");next.click();expect(child.hidden).toBe(true);next.click();expect(child.style.width).toBe("260px");
 const saved=panel.capture();key(child,"ArrowRight");panel.restore(saved);expect(child.style.width).toBe("260px");
 panel.result("x",up,down,"","端口连接",true);expect(named(root,"b1").style.width).toBe("260px");expect(named(root,"b1").hidden).toBe(true);
 panel.result("q",leaf("top.q"),leaf("top.q"),"");expect(node(root,"focus").style.width).toBe("236px");
 key(node(root,"focus"),"ArrowRight");panel.result("q",leaf("top.q"),leaf("top.q"),"","模块内逻辑 · 过程作用域",true);expect(node(root,"focus").style.width).toBe("236px");
 panel.message("");root.remove();
});

it("逻辑图和动态分支卡片可以独立改宽，隐藏恢复及同目标刷新保留",()=>{
 const {root,panel,files,context,graph}=logicSetup(),r=node(root,"r"),branch=r.querySelector<HTMLElement>("summary")!;
 const original=parseFloat(r.style.left);key(r,"ArrowRight");expect(r.style.width).toBe("260px");
 branch.click();const child=root.querySelector<HTMLElement>(".branch-card")!;
 expect(parseFloat(child.style.left)).toBe(original+300);key(child,"ArrowRight");expect(child.style.width).toBe("260px");
 child.querySelector<HTMLElement>("summary")!.click();const y=node(root,"y"),wire=[...root.querySelectorAll<SVGPathElement>(".logic-wire")].find(p=>p.dataset.from===child.dataset.node&&p.dataset.to==="y")!;
 expect(wire.getAttribute("d")).toContain(`M${parseFloat(child.style.left)+260},`);expect(parseFloat(y.style.left)).toBe(parseFloat(child.style.left)+300);
 const saved=panel.capture();branch.click();expect(child.hidden).toBe(true);branch.click();expect(child.style.width).toBe("260px");
 key(child,"ArrowRight");panel.restore(saved);expect(child.style.width).toBe("260px");
 panel.logicResult("r",context,graph,files,"",true);expect(node(root,"r").style.width).toBe("260px");expect(root.querySelector(".branch-card")).toBeNull();
 node(root,"r").querySelector<HTMLElement>("summary")!.click();expect(root.querySelector<HTMLElement>(".branch-card")!.style.width).toBe("260px");
 panel.logicResult("r",context,graph,files,"");expect(node(root,"r").style.width).toBe("236px");panel.message("");root.remove();
});

for(const mode of ["ports","logic"] as const)it(`${mode} 卡片支持宽度边界、双击与键盘复位，取消／释放／销毁后停止拖动`,()=>{
 const setup=mode==="ports"?portSetup():logicSetup(),{root,panel,navigate}=setup,card=node(root,mode==="ports"?"focus":"r"),{fire,handle,captured}=pointerHandle(card);
 const state=panel.capture();fire("pointerdown",100,1,2);fire("pointermove",400);expect(card.style.width).toBe("236px");
 fire("pointerdown",100);fire("pointermove",400,2);expect(card.style.width).toBe("236px");
 fire("pointermove",5000);expect(card.style.width).toBe("1200px");fire("pointermove",0);expect(card.style.width).toBe("236px");fire("pointermove",364);expect(card.style.width).toBe("500px");
 fire("pointercancel",364);expect(captured.size).toBe(0);fire("pointermove",600);expect(card.style.width).toBe("500px");
 handle.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true}));expect(card.style.width).toBe("236px");
 key(card,"ArrowRight");expect(card.style.width).toBe("260px");key(card,"ArrowLeft");expect(card.style.width).toBe("236px");key(card,"ArrowLeft");expect(card.style.width).toBe("236px");key(card,"ArrowRight");key(card,"Home");expect(card.style.width).toBe("236px");
 fire("pointerdown",100);fire("pointermove",300);fire("pointerup",300);fire("pointermove",500);expect(card.style.width).toBe("436px");
 fire("pointerdown",100);fire("lostpointercapture",100);fire("pointermove",400);expect(card.style.width).toBe("436px");
 expect(navigate).not.toHaveBeenCalled();expect(panel.capture().open).toEqual(state.open);
 fire("pointerdown",100);panel.message("");expect(captured.size).toBe(0);fire("pointermove",500);key(card,"ArrowRight");expect(card.style.width).toBe("436px");root.remove();
});

it("宽度相同列取最大值，垂直未知边连接各卡片实际中心",()=>{
 const {root,panel}=panelSetup(),trace=leaf("top.x",[leaf("top/ip.i")]);trace.children[0].reason="黑盒或缺失定义";panel.result("x",trace,trace,"");
 const focus=node(root,"focus"),unknown=[...root.querySelectorAll<HTMLElement>(".port-card")].find(c=>c!==focus)!;
 key(focus,"ArrowRight");const wire=root.querySelector<SVGPathElement>(".logic-wire")!;
 expect(wire.getAttribute("d")).toBe("M142,174 L154,134");
 expect(unknown.style.width).toBe("236px");expect(root.querySelector<HTMLElement>(".logic-canvas")!.style.width).toBe("308px");panel.message("");root.remove();
});
