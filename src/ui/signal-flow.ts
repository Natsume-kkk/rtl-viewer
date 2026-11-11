import { setIcon } from "./icons";
import type { TraceNode, SignalContext } from "../analysis/signal-flow";
import type { LogicGraph } from "../analysis/local";
import { SignalLogicView, type LogicViewState } from "./signal-logic";
import { SignalPortsView, type PortViewState } from "./signal-ports";
import { showCtxMenu } from "./menu";

export interface FlowViewState { open: boolean[]; left: number; top: number; logic?: LogicViewState; ports?: PortViewState }

export class SignalFlowPanel {
  private body: HTMLElement;
  private logic?: SignalLogicView;
  private ports?: SignalPortsView;
  private identity: HTMLElement;
  private mode: HTMLElement;
  private contexts: HTMLSelectElement;
  private status: HTMLElement;
  private stale: HTMLButtonElement;
  private following: HTMLElement;
  private expand: HTMLButtonElement;
  private more: HTMLButtonElement;
  constructor(root: HTMLElement, actions: { close(): void; refresh?(): void; context(index: number): void; navigate(file: string, line: number): void }) {
    const head = document.createElement("div"); head.className = "panel-head flow-head";
    const title = document.createElement("span"); title.className = "flow-title"; title.textContent = "信号链"; head.append(title);
    this.identity = document.createElement("button"); this.identity.className="flow-identity"; (this.identity as HTMLButtonElement).type="button";
    this.identity.onclick=()=>{this.ports?.returnToSignal();this.logic?.returnToSignal();};head.append(this.identity);
    this.mode = document.createElement("span"); this.mode.className = "flow-mode"; head.append(this.mode);
    const all = document.createElement("button"); all.className="text-button"; all.textContent="全部展开";
    all.onclick=()=>{ if(this.logic)this.logic.expandAll();else this.ports?.expandLayer(); };head.append(all);this.expand=all;
    const collapse = document.createElement("button");collapse.className="text-button";collapse.textContent="全部收起";
    collapse.onclick=()=>{if(this.logic)this.logic.collapseAll();else this.ports?.collapseAll();};head.append(collapse);
    this.more=document.createElement("button");this.more.type="button";this.more.className="btn-ghost port-view-more";this.more.hidden=true;
    this.more.title="更多视图操作";this.more.setAttribute("aria-label",this.more.title);this.more.setAttribute("aria-haspopup","menu");setIcon(this.more,"more");
    this.more.onclick=event=>{event.stopPropagation();const box=this.more.getBoundingClientRect();showCtxMenu(box.left,box.bottom,[{label:"展开全部层级",action:()=>this.ports?.expandAll()}],this.more);};head.append(this.more);
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
    root.append(head, tools, this.stale, this.status, this.body);
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
  objectHint(name:string,kind:string,source:{file:string;line:number}):void {
    this.hint(`${name} 是${kind}，请选择使用它的信号进行追踪。`);
    const jump=document.createElement("button");jump.type="button";jump.className="text-button";jump.textContent="查看定义";
    jump.dataset.file=source.file;jump.dataset.line=String(source.line);jump.setAttribute("aria-label",`查看 ${name} 定义`);
    this.following.append(" ",jump);
  }
  message(text: string): void { this.logic?.dispose(); this.logic=undefined; this.ports?.dispose(); this.ports=undefined; this.more.hidden=true; this.expand.disabled=false; this.body.classList.remove("logic-body"); this.status.textContent = text; this.status.hidden=!text; this.identity.replaceChildren(); this.body.replaceChildren(); this.body.scrollLeft=0; this.body.scrollTop=0; }
  capture():FlowViewState { return {open:[...this.body.querySelectorAll<HTMLDetailsElement>("details")].map(d=>d.open),left:this.body.scrollLeft,top:this.body.scrollTop,logic:this.logic?.capture(),ports:this.ports?.capture()}; }
  restore(s:FlowViewState):void { if(this.logic&&s.logic)this.logic.restore(s.logic);else if(this.ports&&s.ports)this.ports.restore(s.ports);else [...this.body.querySelectorAll<HTMLDetailsElement>("details")].forEach((d,i)=>d.open=s.open[i]??false);this.body.scrollLeft=s.left;this.body.scrollTop=s.top; }
  private identify(signal:string,path:string):void {
    const selected=document.createElement("strong");selected.className="flow-selected";selected.textContent=signal;
    const context=document.createElement("span");context.className="flow-path";context.textContent=path;
    this.identity.replaceChildren(context,selected);this.identity.title=`回到当前信号，保留展开状态\n${path}.${signal}`;
    this.identity.setAttribute("aria-label",`回到当前信号 ${path}.${signal}`);
  }
  logicResult(signal:string,ctx:SignalContext,graph:LogicGraph,files:ReadonlyMap<string,string>,note:string,preserveWidths=false):void {
    const widths=preserveWidths?this.logic?.capture().widths:undefined;
    this.message(note);this.mode.textContent="模块内逻辑";this.identify(signal,ctx.path);
    this.expand.textContent="全部展开";this.expand.title="展开全部逻辑分支";
    if(graph.truncated){this.status.append("达到分析预算，部分路径未展开");this.status.hidden=false;}
    this.logic=new SignalLogicView(graph,this.body,files);
    if(widths)this.logic.restore({...this.logic.capture(),widths});
  }
  markStale(): void { this.stale.hidden = false; }
  clearStale(): void { this.stale.hidden = true; }
  setContexts(items: SignalContext[], selected: number, labels?: string[]): void {
    this.contexts.replaceChildren(...items.map((item,index) => { const option = document.createElement("option"); option.textContent = labels?.[index] ?? item.path; option.title = option.textContent; return option; }));
    this.contexts.selectedIndex = selected;
    this.contexts.hidden = items.length < 2;
  }
  result(signal: string, upstream: TraceNode, downstream: TraceNode, note: string, mode = "端口连接", preserveWidths=false): void {
    const widths=preserveWidths&&this.mode.textContent===mode?this.ports?.capture().widths:undefined;
    this.message(note);this.mode.textContent=mode;
    this.expand.textContent="展开本层";this.expand.title="仅展开当前可见模块的一层";this.more.hidden=false;
    this.identify(signal,upstream.label.slice(0,upstream.label.lastIndexOf(".")));
    this.ports=new SignalPortsView(signal,upstream,downstream,this.body,canExpand=>{this.expand.disabled=!canExpand;});
    if(widths)this.ports.restore({...this.ports.capture(),widths});
  }
}
