import { setIcon } from "./icons";
import type { TraceNode, SignalContext } from "../model/signal-flow";
import type { LogicGraph } from "../analysis/local";
import { SignalLogicView, type LogicViewState } from "./signal-logic";
import { SignalPortsView, type PortViewState } from "./signal-ports";

export interface FlowViewState { open: boolean[]; left: number; top: number; logic?: LogicViewState; ports?: PortViewState }

export class SignalFlowPanel {
  private body: HTMLElement;
  private logic?: SignalLogicView;
  private ports?: SignalPortsView;
  private identity: HTMLElement;
  private mode: HTMLElement;
  private back: HTMLButtonElement;
  private contexts: HTMLSelectElement;
  private status: HTMLElement;
  private stale: HTMLButtonElement;
  private following: HTMLElement;
  constructor(root: HTMLElement, private actions: { close(): void; refresh?(): void; context(index: number): void; navigate(file: string, line: number): void; enter?(context: SignalContext, signal: string, source?: {file:string;line:number}): void; back?(): void }) {
    const head = document.createElement("div"); head.className = "panel-head"; head.textContent = "信号链";
    this.identity = document.createElement("span"); this.identity.className="flow-identity"; head.append(this.identity);
    this.mode = document.createElement("span"); this.mode.className = "flow-mode"; head.append(this.mode);
    this.back = document.createElement("button"); this.back.className="text-button"; this.back.textContent="返回"; this.back.disabled=true; this.back.onclick=()=>actions.back?.(); head.append(this.back);
    const all = document.createElement("button"); all.className="text-button"; all.textContent="全部展开";
    all.onclick=()=>{ if(this.logic)this.logic.expandAll();else this.ports?.expandAll(); };head.append(all);
    const collapse = document.createElement("button");collapse.className="text-button";collapse.textContent="全部收起";
    collapse.onclick=()=>{if(this.logic)this.logic.collapseAll();else this.ports?.collapseAll();};head.append(collapse);
    const close = document.createElement("button"); close.className = "icon-button"; close.setAttribute("aria-label", "收起信号链分析");
    setIcon(close, "close"); close.onclick = actions.close; head.append(close);
    const tools = document.createElement("div"); tools.className = "flow-tools";
    this.following = document.createElement("p"); this.following.className = "flow-following";
    this.following.setAttribute("role", "status");
    this.contexts = document.createElement("select"); this.contexts.setAttribute("aria-label", "信号所在实例路径"); this.contexts.hidden = true;
    this.contexts.onchange = () => actions.context(this.contexts.selectedIndex);
    this.status = document.createElement("p"); this.status.className = "flow-status";
    tools.append(this.following, this.contexts);
    this.body = document.createElement("div"); this.body.className = "flow-body";
    this.stale = document.createElement("button"); this.stale.className = "text-button result-stale";
    this.stale.textContent = "源码已变化，刷新当前信号链"; this.stale.hidden = true; this.stale.onclick = () => actions.refresh?.();
    const resize=document.createElement("div");resize.className="search-resize";resize.tabIndex=0;resize.setAttribute("role","separator");resize.setAttribute("aria-label","调整信号链高度");resize.setAttribute("aria-orientation","horizontal");
    const height=(h:number)=>{const parent=root.parentElement;const other=parent?.querySelector<HTMLElement>("#search-root:not([hidden])")?.clientHeight??0;const maximum=Math.max(150,(parent?.clientHeight??600)-other-140);const next=Math.max(150,Math.min(h,maximum));root.style.height=`${next}px`;resize.setAttribute("aria-valuenow",String(Math.round(next)));};
    resize.onkeydown=e=>{if(e.key==="ArrowUp"||e.key==="ArrowDown"){e.preventDefault();height(root.clientHeight+(e.key==="ArrowUp"?24:-24));}};
    resize.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();resize.setPointerCapture(e.pointerId);const y=e.clientY,start=root.clientHeight;const move=(m:PointerEvent)=>height(start+y-m.clientY);const end=()=>{resize.removeEventListener("pointermove",move);resize.removeEventListener("pointerup",end);resize.removeEventListener("pointercancel",end);resize.removeEventListener("lostpointercapture",end);};resize.addEventListener("pointermove",move);resize.addEventListener("pointerup",end);resize.addEventListener("pointercancel",end);resize.addEventListener("lostpointercapture",end);};
    root.append(resize, head, tools, this.stale, this.status, this.body);
    root.addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-file]");
      if (button?.dataset.file) {
        event.preventDefault();
        actions.navigate(button.dataset.file, Number(button.dataset.line));
      }
    });
    this.hint("在源码信号上右键，选择“追踪此信号”。");
  }
  hint(text: string): void { this.following.textContent = text; this.following.hidden=!text; }
  message(text: string): void { this.logic?.dispose(); this.logic=undefined; this.ports?.dispose(); this.ports=undefined; this.body.classList.remove("logic-body"); this.status.textContent = text; this.status.hidden=!text; this.identity.replaceChildren(); this.body.replaceChildren(); this.body.scrollLeft=0; this.body.scrollTop=0; }
  setBack(enabled:boolean):void { this.back.disabled=!enabled; }
  capture():FlowViewState { return {open:[...this.body.querySelectorAll<HTMLDetailsElement>("details")].map(d=>d.open),left:this.body.scrollLeft,top:this.body.scrollTop,logic:this.logic?.capture(),ports:this.ports?.capture()}; }
  restore(s:FlowViewState):void { if(this.logic&&s.logic)this.logic.restore(s.logic);else if(this.ports&&s.ports)this.ports.restore(s.ports);else [...this.body.querySelectorAll<HTMLDetailsElement>("details")].forEach((d,i)=>d.open=s.open[i]??false);this.body.scrollLeft=s.left;this.body.scrollTop=s.top; }
  private identify(signal:string,path:string):void {
    const selected=document.createElement("strong");selected.className="flow-selected";selected.textContent=signal;
    const context=document.createElement("span");context.className="flow-path";context.textContent=path;
    this.identity.replaceChildren(context,selected);this.identity.title=`${path}.${signal}`;
  }
  logicResult(signal:string,ctx:SignalContext,graph:LogicGraph,files:ReadonlyMap<string,string>,note:string):void {
    this.message(note);this.mode.textContent="模块内逻辑";this.identify(signal,ctx.path);
    if(graph.truncated){this.status.append("达到分析预算，部分路径未展开");this.status.hidden=false;}
    this.logic=new SignalLogicView(graph,this.body,this.actions,files);
  }
  markStale(): void { this.stale.hidden = false; }
  clearStale(): void { this.stale.hidden = true; }
  setContexts(items: SignalContext[], selected: number): void {
    this.contexts.replaceChildren(...items.map(item => { const option = document.createElement("option"); option.textContent = item.path; option.title = item.path; return option; }));
    this.contexts.selectedIndex = selected;
    this.contexts.hidden = items.length < 2;
  }
  result(signal: string, upstream: TraceNode, downstream: TraceNode, note: string, mode = "端口连接"): void {
    this.message(note);this.mode.textContent=mode;
    this.identify(signal,upstream.label.slice(0,upstream.label.lastIndexOf(".")));
    this.ports=new SignalPortsView(signal,upstream,downstream,this.body,this.actions.enter);
  }
}
