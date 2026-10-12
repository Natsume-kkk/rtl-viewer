import type { Expr } from "../analysis/expression";
import type { LogicGraph } from "../analysis/local";
import type { Driver } from "../analysis/project";
import type { TraceNode } from "../model/signal-flow";
import { CardWidths, columnPositions, cardHeader, appendSource, makeWires, drawWires, type CardWidthState, type CardPosition, type CardEdge } from "./signal-canvas";
import { setIcon } from "./icons";

const el = <K extends keyof HTMLElementTagNameMap>(tag:K,cls="",text=""):HTMLElementTagNameMap[K]=>{const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;};
const portEnds=(trace:TraceNode,signal:string):{site:TraceNode;signal:string}[]=>{
  signal=trace.signal?.name??signal;
  return trace.children.length?trace.children.flatMap(child=>portEnds(child,signal)):trace.reason==="模块端口"?[]:[{site:trace,signal}];
};
const code=(e:Expr):string=>{
  if(e.current)return e.value;
  if(e.kind==="cast")return `write<${e.value}>(${code(e.args[0])})`;
  if(e.kind==="select")return `(${code(e.args[0])} ? ${code(e.args[1])} : ${code(e.args[2])})`;
  if(e.kind==="op")return e.args.length===1?`${e.value}(${code(e.args[0])})`:`(${e.args.map(code).join(` ${e.value} `)})`;
  if(e.kind==="concat")return `{${e.args.map(code).join(", ")}}`;
  if(e.kind==="slice")return e.text.includes("(")?e.text:`${code(e.args[0])}[${e.args.slice(1).map(code).join(":")}]`;
  return e.text;
};
// Project a choice inside an operation without dropping the surrounding arithmetic.
const choice=(e:Expr,depth=0):Expr|undefined=>{
  if(e.kind==="select")return e;
  if(depth>24||e.kind==="unknown"||e.kind==="call")return;
  for(let i=0;i<e.args.length;i++){
    const c=choice(e.args[i],depth+1);if(!c)continue;
    const arm=(value:Expr):Expr=>({...e,args:e.args.map((a,j)=>i===j?value:a)});
    return {...c,args:[c.args[0],arm(c.args[1]),arm(c.args[2])]};
  }
};
interface Arm { guard:string; value:Expr; start:number }
interface Branch { id:string; element:HTMLDetailsElement; value:Expr; driver:Driver; target:string; depth:number; nested:boolean; child?:string }
export interface LogicViewState { open:string[]; routes:string[]; sources?:boolean[]; widths?:CardWidthState }

export class SignalLogicView {
  private cards=new Map<string,HTMLElement>();
  private sections=new Map<string,Branch[][]>();
  private open=new Set<string>();
  private routes=new Set<string>();
  private continuations=new Map<string,HTMLButtonElement>();
  private canvas=el("div","logic-canvas");
  private svg=makeWires();
  private active=true;
  private widths=new CardWidths(()=>this.reveal());
  constructor(private graph:LogicGraph, body:HTMLElement, private files:ReadonlyMap<string,string>){
    body.classList.add("logic-body");body.append(this.canvas);this.canvas.append(this.svg);
    const base=graph.nodes.find(n=>n.id===graph.root)?.path??"";
    for(const node of graph.nodes){
      const card=el("article",`logic-card ${node.kind}${node.id===graph.root?" selected":""}`);card.dataset.signal=node.signal??node.label;card.dataset.node=node.id;card.title=`${node.path}\n${node.detail}`;
      const instance=node.port?(node.port.path.startsWith(base+"/")?node.port.path.slice(base.length+1):node.port.path):undefined;
      cardHeader(card,instance??(node.kind==="current"?node.signal??node.label:node.label),node.source?this.location(node.source.file,node.source.start):undefined,`${node.path}\n${node.detail}`);
      if(node.kind==="current")card.append(el("code","logic-detail","当前值 Q"));
      if(node.port)card.append(el("code","logic-detail port-pin",`${node.port.direction??"方向待确认"} ${node.port.name}`));
      if(node.mapping)card.append(el("pre","logic-expression port-mapping",node.mapping));
      const clocks=[...new Set(node.drivers.map(d=>d.process?.clock).filter(Boolean))];
      if(clocks.length){card.append(el("span","logic-detail","寄存器更新"));card.append(el("code","logic-clock",`@ ${clocks.join(" / ")}`));}
      if(node.kind==="port")card.append(el("code","logic-detail",node.detail.split(" · ").find(s=>/^(input|output|inout|in|out|buffer)$/.test(s))??"端口"));
      if(node.kind==="resolved")card.append(el("span","logic-tag","多驱动"));
      if(node.kind!=="boundary"&&node.reason)card.append(el("p","flow-reason",node.reason));
      if(node.kind==="boundary"){
        if(!node.portContext){card.append(el("span","logic-tag","分析边界"));if(node.reason||node.detail)card.append(el("p","flow-reason",node.reason??node.detail));}
      }
      for(const role of ["地址","条件","调用参数"] as const){
        const names=[...new Set(graph.edges.filter(e=>e.to===node.id&&e.role===role).map(e=>graph.nodes.find(n=>n.id===e.from)?.signal??e.from))];
        if(names.length)card.append(el("code","logic-detail",`${role}：${names.join("、")}${role==="调用参数"?"（调用内部未展开）":""}`));
      }
      this.cards.set(node.id,card);this.canvas.append(card);this.widths.add(node.id,card,node.label);
      const relations=new Map<object,Driver[]>();
      for(const driver of node.drivers)if(driver.relation){const key=driver.process??driver;const items=relations.get(key)??[];items.push(driver);relations.set(key,items);}
      for(const drivers of relations.values())this.sourceRelations(card,drivers,node.signal??node.label);
      const expressions=node.drivers.filter(driver=>!driver.relation);
      for(const [i,driver]of expressions.entries()){
        const section=el("div","logic-driver");if(expressions.length>1)section.append(el("span","logic-tag",`驱动 ${i+1}`));
        card.append(section);this.expression(node.id,section,driver.expression,node.label,driver,`${node.id}/d${i}`,0);
      }
      for(const {direction,trace} of node.portSites??[]){
        card.classList.add("port-endpoint");
        card.append(el("span","logic-detail",direction==="upstream"?"驱动赋值":"使用位置"));
        const sites=trace.children.flatMap(child=>portEnds(child,node.port!.name));
        if(!sites.length)card.append(el("p","flow-reason",trace.reason??(direction==="upstream"?"无赋值来源":"无后续引用")));
        for(const {site,signal} of sites){
          const section=el("section","port-site");card.append(section);
          const path=site.owner?.startsWith(node.path+"/")?site.owner.slice(node.path.length+1)+".":"";
          const title=site.reason==="赋值位置"?path+(site.target?.signal??site.label):site.reason?.startsWith("控制/时钟")?path+"条件／时钟使用":site.label;
          cardHeader(section,title,site.file?{file:site.file,line:site.line??1}:undefined);
          const statement=site.statement??site.mapping??(site.file&&site.line?(this.files.get(site.file)??"").split("\n")[site.line-1]?.trim():undefined);
          appendSource(section,{...site,statement},signal,()=>this.reveal());
          if(site.note)section.append(el("code","flow-note",site.note));
          if(site.reason&&site.reason!=="赋值位置")section.append(el("p","flow-reason",site.reason));
        }
      }
      if(node.kind==="boundary"&&!node.drivers.length&&!node.portContext&&!node.detail)card.append(el("span","logic-tag","无法继续分析：缺少分析信息"));
      if(graph.edges.some(e=>e.from===node.id)&&!card.querySelector("details")){
        const next=el("button","text-button path-continue","继续追踪");next.type="button";
        next.onclick=()=>{this.routes.has(node.id)?this.routes.delete(node.id):this.routes.add(node.id);this.reveal();};
        card.querySelector<HTMLElement>(".logic-card-head")!.onclick=null;
        card.onclick=event=>{if(!(event.target as HTMLElement).closest("button,summary")&&!next.hidden)next.click();};
        card.append(next);this.continuations.set(node.id,next);
      }
    }
    this.reveal();
    const focus=this.cards.get(graph.root);if(focus&&body.clientWidth>0&&focus.offsetLeft>body.clientWidth-236)body.scrollLeft=Math.max(0,focus.offsetLeft-body.clientWidth/2+118);
  }
  dispose():void{this.active=false;this.widths.dispose();}
  capture():LogicViewState{return {open:[...this.open],routes:[...this.routes],sources:[...this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block")].map(d=>d.open),widths:this.widths.capture()};}
  restore(s:LogicViewState):void{this.open=new Set(s.open);this.routes=new Set(s.routes);this.widths.restore(s.widths);if(s.sources)[...this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block")].forEach((d,i)=>d.open=s.sources![i]??true);this.reveal();}
  expandAll():void{this.routes=new Set(this.cards.keys());for(const d of this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block"))d.open=true;this.reveal(true);}
  collapseAll():void{this.open.clear();this.routes.clear();for(const d of this.canvas.querySelectorAll<HTMLDetailsElement>(".assignment-block"))d.open=false;this.reveal();}
  private location(file:string,start:number){return {file,line:(this.files.get(file)??"").slice(0,start).split("\n").length};}
  private sourceRelations(card:HTMLElement,drivers:Driver[],target:string):void{
    const section=el("div","logic-driver"),rows:{text:string;line?:number}[]=[{text:drivers[0].initialization?"声明初值 · 源码关系":drivers[0].process?"过程内赋值 · 源码关系":"赋值 · 源码关系"}];
    card.append(section);
    const boundaries=(drivers[0].process?.boundaries??[]).filter(b=>!drivers.some(d=>d.source.start>=b.start&&d.source.end<=b.end));
    const entries=[...drivers.map(driver=>({start:driver.source.start,driver,boundary:undefined})),...boundaries.map(boundary=>({start:boundary.start,driver:undefined,boundary}))].sort((a,b)=>a.start-b.start);
    for(const {driver,boundary} of entries){
      if(boundary){
        const file=drivers[0].source.file,first=this.location(file,boundary.start).line;
        const text=(this.files.get(file)??"").slice(boundary.start,boundary.end).trim()||boundary.text;
        text.split("\n").forEach((text,i)=>rows.push({text,line:first+i}));
        rows.push({text:boundary.reason});continue;
      }
      if(!driver)continue;
      for(const context of driver.contexts??[])rows.push({text:context});
      if(driver.conditions?.length)rows.push({text:`条件：${driver.conditions.map(code).join("；")}`});
      const source=this.files.get(driver.source.file)??"",raw=source.slice(driver.source.start,driver.source.end).trim();
      const statement=(driver.initialization&&raw)||/(?:<=|:=|=(?!=))[\s\S]*;\s*$/.test(raw)?raw:`${driver.targetText??target} ${driver.operator??"←"} ${code(driver.expression)};`;
      const first=this.location(driver.source.file,driver.source.start).line;
      statement.split("\n").forEach((text,i)=>rows.push({text,line:first+i}));
      if(driver.reason)rows.push({text:driver.reason});
    }
    appendSource(section,{file:drivers[0].source.file,sourceRows:rows},target,()=>this.reveal());
  }
  private unwrap(e:Expr,target:string):Expr{return e.kind==="cast"&&e.value===target&&!e.event?e.args[0]:e;}
  private group(e:Expr,target:string,vhdl:boolean):{header?:string;arms:Arm[]}|undefined{
    e=this.unwrap(e,target);
    if(e.event&&vhdl)return {arms:[{guard:`if ${e.event} then`,value:{...e,event:undefined},start:e.eventStart??e.start}]};
    const selected=choice(e);if(!selected)return;
    const arms:Arm[]=[];let current=selected,index=0;
    const compatible=(n:Expr)=>n.kind==="select"&&n.procedural===selected.procedural&&!n.event&&(selected.branch?.kind==="case"?n.branch?.group===selected.branch.group:n.branch?.kind!=="case");
    while(compatible(current)&&index<256){
      const cond=code(current.args[0]);
      let guard=current.branch?.guard??(selected.procedural?(vhdl?`if ${cond} then`:`if (${cond})`):(vhdl?`when ${cond}`:`${cond} ?`));
      if(index&&current.branch?.kind!=="case"&&selected.procedural)guard=guard.replace(/^if\b/,vhdl?"elsif":"else if");
      arms.push({guard,value:current.args[1],start:current.args[0].start});current=current.args[2];index++;
    }
    let guard=selected.branch?.alternate??"else";
    const start=selected.branch?.alternateStart??current.start;
    if(vhdl&&current.event){guard=`elsif ${current.event} then`;arms.push({guard,value:{...current,event:undefined},start:current.eventStart??start});}
    else arms.push({guard,value:current,start});
    return {header:selected.branch?.header,arms};
  }
  private expression(cardId:string,parent:HTMLElement,e:Expr,target:string,driver:Driver,key:string,depth:number):void{
    const vhdl=/\.vhdl?$/i.test(driver.source.file),group=this.group(e,target,vhdl),sections=this.sections.get(cardId)??[];
    this.sections.set(cardId,sections);
    if(!group){
      e=this.unwrap(e,target);parent.append(el("pre","logic-expression",this.assignment(e,target,driver,vhdl)));sections.push([]);
      if(e.kind==="unknown"||e.kind==="call"&&!e.conversion)parent.append(el("span","logic-tag","分析边界"));
      if(e.conversion)parent.append(el("span","logic-detail",e.conversion.description));return;
    }
    if(group.header&&!parent.querySelector('.branch-heading'))parent.append(el("code","branch-heading",group.header));
    const list=el("div","logic-branches");parent.append(list);const branches:Branch[]=[];sections.push(branches);
    group.arms.forEach((arm,i)=>{
      const id=`${key}/b${i}`,d=el("details","logic-branch"),summary=el("summary"),indicator=el("span","branch-toggle");
      const value=this.unwrap(arm.value,target),nested=!!this.group(value,target,vhdl);
      summary.append(indicator,el("code","branch-guard",arm.guard));
      if(!nested)summary.append(el("code","branch-preview",this.assignment(value,target,driver,vhdl)));
      const jump=el("button","source-jump branch-source");jump.type="button";const location=this.location(driver.source.file,nested?arm.start:value.assignment?.start??arm.start);
      jump.dataset.file=location.file;jump.dataset.line=String(location.line);jump.title=`定位 ${arm.guard} 源码`;jump.setAttribute("aria-label",jump.title);setIcon(jump,"jump-inst");summary.append(jump);
      summary.onclick=event=>{event.preventDefault();if((event.target as HTMLElement).closest("button"))return;this.open.has(id)?this.open.delete(id):this.open.add(id);this.reveal();};
      d.append(summary);list.append(d);branches.push({id,element:d,value,driver,target,depth,nested});
    });
  }
  private assignment(e:Expr,target:string,driver:Driver,vhdl:boolean):string{return `${target} ${driver.operator??"←"} ${code(e)};${e.current&&e.value===target?(vhdl?" -- hold":" // hold"):""}`;}
  private reveal(all=false):void{
    if(!this.active)return;
    const visible=new Set<string>(),edges:CardEdge[]=[],choices=new Set<string>(),visited=new Set<string>();
    const addEdge=(edge:CardEdge)=>{if(!edges.some(e=>e.from===edge.from&&e.to===edge.to&&e.control===edge.control&&e.role===edge.role&&e.unknown===edge.unknown))edges.push(edge);};
    // Every redraw derives reachability again; remembered selections are not visibility.
    const branchEnds=(id:string):string[]=>{
      visible.add(id);const sections=this.sections.get(id);if(!sections?.length)return[id];
      const ends=new Set<string>();
      for(const section of sections){if(!section.length)ends.add(id);
        for(const b of section){
          if(all)this.open.add(b.id);const open=this.open.has(b.id);b.element.open=open;
          const summary=b.element.querySelector("summary")!;summary.title=open?"收起此分支":"展开此分支";summary.setAttribute("aria-expanded",String(open));
          setIcon(summary.querySelector<HTMLElement>(".branch-toggle")!,open?"chevron-down":"chevron-right");
          if(!open)continue;
          if(!b.nested){ends.add(id);continue;}
          if(!b.child){
            if(b.depth>=24||this.cards.size>=360){if(!b.element.querySelector(".logic-tag"))b.element.append(el("span","logic-tag","达到展开上限，请定位源码"));continue;}
            b.child=`branch:${b.id}`;const card=el("article","logic-card branch-card");card.dataset.node=b.child;card.dataset.signal=b.target;
            const header=this.group(b.value,b.target,/\.vhdl?$/i.test(b.driver.source.file))?.header;
            cardHeader(card,header??b.target,this.location(b.driver.source.file,b.value.eventStart??b.value.start));
            if(header)card.querySelector('.operation-name')!.classList.add('branch-heading');
            this.cards.set(b.child,card);this.canvas.append(card);this.widths.add(b.child,card);this.expression(b.child,card,b.value,b.target,b.driver,b.id,b.depth+1);
          }
          addEdge({from:id,to:b.child});branchEnds(b.child).forEach(end=>ends.add(end));
        }
      }return [...ends];
    };
    const forward=new Set<string>(),cone=(id:string)=>{if(forward.has(id))return;forward.add(id);this.graph.edges.filter(e=>e.from===id).forEach(e=>cone(e.to));};cone(this.graph.root);
    const upstream=new Set<string>();
    const ancestors=(id:string)=>{if(upstream.has(id))return;upstream.add(id);visible.add(id);branchEnds(id);for(const e of this.graph.edges.filter(e=>e.to===id&&!e.control)){addEdge(e);ancestors(e.from);}};
    ancestors(this.graph.root);
    const walk=(id:string,choice=false)=>{
      visible.add(id);if(choice&&this.continuations.has(id))choices.add(id);
      if(visited.has(id))return;
      if(choice&&this.continuations.has(id)&&!this.routes.has(id))return;
      visited.add(id);const ends=branchEnds(id);if(!ends.length)return;
      for(const e of this.graph.edges.filter(e=>e.to===id&&!e.control&&!forward.has(e.from))){ancestors(e.from);addEdge(e);}
      const outgoing=this.graph.edges.filter(e=>e.from===id),targets=[...new Set(outgoing.map(e=>e.to))];
      for(const e of outgoing){ends.forEach(from=>addEdge({...e,from}));walk(e.to,targets.length>1);}
    };walk(this.graph.root);
    for(const[id,button]of this.continuations){const open=this.routes.has(id);button.hidden=!choices.has(id);button.textContent=open?"收起此路":"继续追踪";button.setAttribute("aria-expanded",String(open));button.setAttribute("aria-label",`${open?"收起":"继续追踪"} ${this.cards.get(id)!.dataset.signal}`);this.cards.get(id)!.classList.toggle("route-pending",choices.has(id)&&!open);}
    for(const[id,card]of this.cards)card.hidden=!visible.has(id);
    this.widths.fit();
    const ranks=new Map<string,number>(),rank=(id:string,seen=new Set<string>()):number=>{if(ranks.has(id))return ranks.get(id)!;if(seen.has(id))return 0;const incoming=edges.filter(e=>e.to===id&&!e.control);const n=incoming.length?1+Math.max(...incoming.map(e=>rank(e.from,new Set(seen).add(id)))):0;ranks.set(id,n);return n;};
    const widths=new Map<number,number>();
    for(const[id,card]of this.cards)if(!card.hidden){const column=rank(id);widths.set(column,Math.max(widths.get(column)??0,this.widths.get(id)));}
    const offsets=columnPositions(widths),columns=new Map<number,number>(),positions=new Map<string,CardPosition>();
    for(const[id,card]of this.cards){if(card.hidden)continue;const column=rank(id),x=offsets.get(column)!,y=columns.get(column)??28,h=card.offsetHeight||96,w=this.widths.get(id);card.style.left=`${x}px`;card.style.top=`${y}px`;positions.set(id,{x,y,h,w,column});columns.set(column,y+h+24);}
    drawWires(this.canvas,this.svg,positions,edges);
  }
}
