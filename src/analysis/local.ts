import { detectLang } from "../parser";
import { traceSignal, type SignalProject, type SignalContext, type TraceNode } from "../model/signal-flow";
import { type ComputationProject, type Driver, type SourceSpan, driverCount } from "./project";
import { type Expr, parseExpression, expressionArgumentRole } from "./expression";
import { findSignalDeclLine } from "../model/signals";
import { sourceEntry } from "./source-cache";

export interface LogicNode {
  id: string; label: string; signal?: string; path: string;
  kind: "signal"|"register"|"port"|"current"|"control"|"boundary"|"resolved";
  detail: string; source?: SourceSpan; drivers: Driver[];
  reason?: string;
  port?: {path:string;name:string;direction?:string};
  mapping?: string;
  portContext?: SignalContext;
  portSites?: { direction: "upstream"|"downstream"; trace: TraceNode }[];
}
export interface LogicGraph { root: string; nodes: LogicNode[]; edges: {from:string;to:string;control?:boolean;current?:boolean;unknown?:boolean;role?:"数据"|"地址"|"条件"|"调用参数"}[]; truncated: boolean }

/** Endpoint source previews only: never merge a child's dependency graph into this module. */
export async function loadPortSites(graph: LogicGraph, project: SignalProject, cancelled: () => boolean): Promise<void> {
  for (const node of graph.nodes) {
    if (!node.portContext || !node.port) continue;
    node.portSites = [];
    for (const direction of ["upstream", "downstream"] as const) {
      if (!(direction === "upstream" ? /^(output|out|buffer|inout)$/ : /^(input|in|inout)$/).test(node.port.direction ?? "")) continue;
      const trace = await traceSignal(project, node.portContext, node.port.name, direction, { stopAtAssignments: true, descendOnly: true, maxNodes: 120, cancelled });
      node.portSites.push({ direction, trace });
    }
  }
}
export function signalMode(project: SignalProject, ctx: SignalContext, signal: string, scope = -1): "port"|"logic" {
  const mod=project.moduleForContext(ctx), norm=(s:string)=>detectLang(mod?.file??"")==="vhdl"?s.toLowerCase():s;
  return scope<0 && mod?.ports.some(p=>norm(p.name)===norm(signal)) ? "port" : "logic";
}

/** One module's cone only. Child ports, old state and unknown syntax are explicit boundaries. */
export function localLogic(comp: ComputationProject, project: SignalProject, ctx: SignalContext, signal: string, limit=120): LogicGraph {
  const data=comp.moduleData(ctx), nodes:LogicNode[]=[],edges:LogicGraph["edges"]=[];
  const graph:LogicGraph={root:"",nodes,edges,truncated:false};
  const norm=(s:string)=>data?.lang==="vhdl"?s.toLowerCase():s;
  const labels=new Map<string,string>();
  for(const view of data?.mod.sourceViews??[])for(const[raw,identity]of view.names??[]){
    const label=view.scope?`${view.scope}.${raw}`:raw, old=labels.get(norm(identity));
    if(!old||label.length<old.length)labels.set(norm(identity),label);
  }
  const display=(name:string)=>labels.get(norm(name))??name;
  const byKey=new Map<string,LogicNode>(), visiting=new Set<string>(),stateSources=new Set<string>();
  const span=(file:string,line:number):SourceSpan=>{const start=sourceEntry(file,comp.files.get(file)??"").lineOffset(line);return {file,start,end:start+1};};
  const add=(key:string,n:Omit<LogicNode,"id">):LogicNode|undefined=>{
    const old=byKey.get(key);if(old)return old;
    if(nodes.length>=limit){graph.truncated=true;return;}
    const node={...n,id:key};nodes.push(node);byKey.set(key,node);return node;
  };
  const edge=(a:LogicNode|undefined,b:LogicNode,control=false,current=false,role:LogicGraph["edges"][number]["role"]="数据", uncertain=false)=>{
    if(!a)return;
    const unknown=uncertain||!!(a.port&&!a.port.direction||b.port&&!b.port.direction);
    if(!edges.some(e=>e.from===a.id&&e.to===b.id&&e.control===control&&e.current===current&&e.role===role&&e.unknown===unknown||unknown&&e.unknown&&e.from===b.id&&e.to===a.id))edges.push({from:a.id,to:b.id,control,current,unknown,role:control?"条件":role});
  };
  const childPorts=(name:string,up:boolean)=>{
    const found:{key:string;node:Omit<LogicNode,"id">;role?:LogicGraph["edges"][number]["role"];unknown?:boolean}[]=[];
    for(const inst of data?.mod.instances??[]){const child=project.module(inst.module);
      for(const[i,c]of(inst.connections??[]).entries()){
        const port=c.port?child?.ports.find(p=>norm(p.name)===norm(c.port!)):child?.ports[i];
        const direction=port?.direction??"";
        if(direction && !(up?/^(output|out|buffer|inout)$/:/^(input|in|inout)$/).test(direction))continue;
        const mapped=parseExpression(c.expr,data!.lang,0,data!.vectors);
        const relation=references(mapped).find(r=>r.name===name&&(!up||r.role==="数据"));
        if(!relation)continue;
        const context=project.child(ctx,inst),known=!!port&&!!direction&&!!child&&!child.problem;
        const pin={path:context.path,name:port?.name??c.port??String(i+1),direction:direction||undefined};
        const mapping=norm(c.expr.trim())===name?undefined:detectLang(inst.file)==="vhdl"?`${c.port??pin.name} => ${c.expr}`:c.port?`.${c.port}(${c.expr})`:c.expr;
        found.push({key:`child:${inst.inst}:${port?.name??c.port??i}`,role:relation.role,unknown:relation.unknown,node:{label:`${inst.inst}.${pin.name}`,signal:port?.name,path:context.path,port:pin,mapping,kind:"boundary",drivers:[],source:span(inst.file,c.line),detail:known?"子模块端口":child?.problem??(!child?"黑盒或缺失定义，无法展开内部实现":"端口方向未知，停止追踪"),portContext:known?context:undefined}});
      }
    }return found;
  };
  type Relation = {name:string;current?:boolean;control?:boolean;unknown?:boolean;role?:LogicGraph["edges"][number]["role"]};
  const references=(e:Expr, role:Relation["role"]="数据", uncertain=false):Relation[]=>{
    if(e.kind==="ref")return[{name:norm(e.value),current:e.current,role,unknown:uncertain,control:role==="条件"}];
    if(e.kind==="unknown")return[];
    if(e.kind==="select")return[...references(e.args[0],"条件",uncertain),...e.args.slice(1).flatMap(a=>references(a,role,uncertain))];
    const clockCondition=role==="条件"&&data?.lang==="vhdl"&&e.kind==="call"&&/^(rising_edge|falling_edge)$/.test(e.value)&&e.args.length===1&&e.args[0].kind==="ref";
    if(clockCondition)return references(e.args[0],"条件",uncertain);
    return e.args.flatMap((a,i)=>references(a,expressionArgumentRole(e,i,role??"数据"),uncertain||e.kind==="call"&&!e.conversion));
  };
  const driverReferences=(d:Driver):Relation[]=>[...references(d.expression),...(d.selectors??[]).flatMap(e=>references(e,"地址")),...(d.conditions??[]).flatMap(e=>references(e,"条件"))];
  const unsupported=(e:Expr):boolean=>e.kind==="unknown"||e.kind==="call"&&!e.conversion||e.kind!=="select"&&e.args.some(unsupported)||e.kind==="select"&&e.args.slice(1).some(unsupported);
  const reasons=(e:Expr):string[]=>e.kind==="call"&&!e.conversion?[`调用内部语义未展开：${e.text}`]:e.kind==="unknown"?[`未支持的表达式：${e.text}`]:(e.kind==="select"?e.args.slice(1):e.args).flatMap(reasons);
  const registers=new Map<string,boolean>();
  const isRegister=(name:string):boolean=>{
    if(registers.has(name))return registers.get(name)!;
    const ds=(data?.drivers.get(name)??[]).filter(d=>!d.initialization),port=data?.mod.ports.find(p=>norm(p.name)===name);
    const result=driverCount(ds)===1&&!!ds[0].process?.clock&&ds.every(d=>!unsupported(d.expression))&&!childPorts(name,true).length&&!/^(input|in|inout)$/.test(port?.direction??"");
    registers.set(name,result);return result;
  };
  function visit(name:string):LogicNode|undefined{
    name=norm(name);
    if(visiting.has(name))return add(`feedback:${name}`,{label:`${display(name)} (feedback)`,signal:name,path:ctx.path,kind:"boundary",detail:"组合反馈，停止重复展开",drivers:[]});
    const existing=byKey.get(name);if(existing)return existing;
    const ds=data?.drivers.get(name)??[],port=data?.mod.ports.find(p=>norm(p.name)===name);
    const child=childPorts(name,true);
    const object=data?.objects.get(name);
    const n=add(name,{label:display(name),signal:name,path:ctx.path,kind:driverCount(ds)+child.filter(c=>c.node.port?.direction).length>1||port?.direction==="inout"?"resolved":ds.some(d=>unsupported(d.expression))||ds.length>0&&ds.every(d=>d.relation)?"boundary":port?"port":ds.some(d=>d.process?.clock)?"register":"signal",detail:[data?.widths.get(name),object?.initializer?`声明初值：${object.initializer}；未模拟初始化或后续更新`:"",port?.direction,[...new Set(ds.map(d=>d.process?.clock?`@ ${d.process.clock}`:"").filter(Boolean))].join(" / ")].filter(Boolean).join(" · "),drivers:ds,source:ds[0]?.source??object?.source??(port?span(data!.mod.file,findSignalDeclLine(comp.files.get(data!.mod.file)??"",data!.mod.file,name)??data!.mod.line):undefined)});
    if(!n)return;
    if(ds.some(d=>unsupported(d.expression)||d.reason))n.reason=[...new Set(ds.flatMap(d=>[...reasons(d.expression),...(d.reason?[d.reason]:[])]))].join("；");
    if(!data||data.mod.problem){n.kind="boundary";n.detail=data?.mod.problem??"黑盒或缺失定义";return n;}
    if(!port&&!ds.length&&!child.length&&object?.kind!=="constant"&&object?.kind!=="parameter"&& !object?.initializer){const reason=project.terminalReason(data.mod,name,"upstream");n.kind=reason==="无赋值来源"?"signal":"boundary";n.reason=reason;n.detail=[n.detail,reason].filter(Boolean).join(" · ");}
    visiting.add(name);
    // Inputs are module boundaries; never cross into the parent's binding.
    if(!port||!/^(input|in)$/.test(port.direction??""))for(const d of ds)for(const r of driverReferences(d)){
      if(d.relation&&d.process?.locals.includes(r.name)){
        edge(add(`local:${d.source.start}:${r.name}`,{label:`${r.name.replace(/^@local:\d+:/,"")}（过程局部）`,path:ctx.path,kind:"boundary",detail:"过程局部对象的源码引用；不连接同名模块信号",drivers:[],source:d.source}),n,!!r.control,false,r.role,!!r.unknown);continue;
      }
      // 外部表达式没有过程内的 current 标记；确定的寄存器读取也必须停在 Q。
      // 更新来源另行展开，不能沿 Q→组合逻辑→更新值把时序回路当作组合反馈。
      if(isRegister(r.name)){
        if(byKey.has(r.name)&&!visiting.has(r.name))edge(byKey.get(r.name),n,!!r.control,true,r.role,!!r.unknown);
        else{
          edge(add(`current:${r.name}`,{label:`${display(r.name)} (Q)`,signal:r.name,path:ctx.path,kind:"current",detail:"读取当前状态；不代表同周期更新值",drivers:[],source:d.source}),n,!!r.control,true,r.role,!!r.unknown);
          stateSources.add(r.name);
        }
      }
      else if(r.control&&byKey.has(r.name)&&r.name!==name)edge(byKey.get(r.name),n,true,false,r.role,!!r.unknown);
      else if(r.current&&!visiting.has(r.name))edge(visit(r.name),n,false,true,r.role,!!r.unknown);
      else if(r.current||r.control){const key=`${r.current?"current":"control"}:${r.name}`;edge(add(key,{label:r.current?`${display(r.name)} (Q)`:display(r.name),signal:r.name,path:ctx.path,kind:r.current?"current":"control",detail:r.current?"读取当前状态；不代表同周期更新值":"条件引用",drivers:[],source:d.source}),n,!!r.control,!!r.current,r.role,!!r.unknown);}
      else edge(visit(r.name),n,false,false,r.role,!!r.unknown);
    }
    for(const c of child)edge(add(c.key,c.node),n,false,false,c.role,!!c.unknown);
    if(port?.direction==="inout")edge(add(`external:${name}`,{label:`${name} · 模块外部`,path:ctx.path,kind:"boundary",drivers:[],detail:"双向端口外部来源，值未求解"}),n);
    visiting.delete(name);return n;
  }
  const expandStateSources=()=>{
    while(stateSources.size&&nodes.length<limit){const name=stateSources.values().next().value!;stateSources.delete(name);visit(name);}
    if(stateSources.size)graph.truncated=true;
  };
  const root=visit(signal);graph.root=root?.id??"";expandStateSources();
  // Forward walk uses module-local assignments only; unrelated fanout of an ancestor is excluded.
  const queue=[norm(signal)],seen=new Set<string>();
  while(queue.length&&nodes.length<limit){const name=queue.shift()!;if(seen.has(name))continue;seen.add(name);const n=visit(name);if(!n)break;
    const port=data?.mod.ports.find(p=>norm(p.name)===name);
    if(name!==norm(signal)&&n.kind==="boundary")continue;
    if(name!==norm(signal)&&/^(output|out|buffer|inout)$/.test(port?.direction??""))continue;
    for(const[target,ds]of data?.drivers??[]){if(target===name)continue;
      if(ds.some(d=>driverReferences(d).some(r=>r.name===name&&!(d.relation&&d.process?.locals.includes(r.name))))){visit(target);queue.push(target);}
    }
    for(const c of childPorts(name,false)){const leaf=add(c.key,c.node);if(leaf)edge(n,leaf,false,false,c.role,!!c.unknown);}
    expandStateSources();
  }
  if(queue.length)graph.truncated=true;
  return graph;
}
