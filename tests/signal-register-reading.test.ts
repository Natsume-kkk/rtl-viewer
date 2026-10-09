// @vitest-environment jsdom
import { expect, it } from "vitest";
import { choose, parseExpression, reference } from "../src/analysis/expression";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";
import { SignalProject } from "../src/model/signal-flow";
import { SignalLogicView } from "../src/ui/signal-logic";
import { drawWires, makeWires } from "../src/ui/signal-canvas";

const source=`entity top is port(i_clk,i_rst_n,i_pps_ext: in bit; y: out bit); end top;
architecture rtl of top is signal s_ext_pps: bit_vector(3 downto 0); begin
process(i_rst_n,i_clk) begin
if i_rst_n = '0' then s_ext_pps <= (others => '0');
elsif rising_edge(i_clk) then s_ext_pps <= s_ext_pps(2 downto 0) & i_pps_ext;
end if; end process;
y <= s_ext_pps(3);
end rtl;`;
it("others 常量聚合保持原文，不误判为未知表达式",()=>{
  for(const text of ["(others => '0')","(OTHERS => '1')","(others => 'Z')"]){const e=parseExpression(text,"vhdl");expect(e.kind).toBe("literal");expect(e.text).toBe(text);}
  expect(parseExpression("(others => data)","vhdl").kind).toBe("unknown");
  expect(parseExpression("(others => '0', 1 => '1')","vhdl").kind).toBe("unknown");
  expect(choose(reference("reset"),parseExpression("(others => '0')","vhdl"),parseExpression("(others => '1')","vhdl")).kind).toBe("select");
});
it("复位移位寄存器区分当前值与更新，完整赋值可见且允许后续追踪",()=>{
  const files=new Map([["top.vhd",source]]),p=new SignalProject(files),ctx=p.root("top")!,g=localLogic(new ComputationProject(files,p),p,ctx,"s_ext_pps"),body=document.createElement("div");
  new SignalLogicView(g,body,{navigate(){}},files);
  expect(g.nodes.find(n=>n.id===g.root)?.kind).toBe("register");
  const root=body.querySelector('[data-node="s_ext_pps"]')!;
  expect(root.textContent).not.toContain("分析边界");
  expect(body.querySelector('[data-node="current:s_ext_pps"]')?.textContent).toContain("当前值 Q");
  expect(root.querySelectorAll(".branch-preview")[0].textContent).toBe("s_ext_pps <= (others => '0');");
  expect(root.querySelectorAll(".branch-preview")[1].textContent).toContain("s_ext_pps <=");
  expect(root.querySelectorAll(".branch-guard")[1].textContent).toBe("elsif rising_edge(i_clk) then");
  expect(g.edges.find(e=>e.from==="current:s_ext_pps"&&e.to===g.root)?.current).toBe(true);
  root.querySelectorAll<HTMLElement>("summary")[1].click();expect(body.querySelector<HTMLElement>('[data-node="y"]')!.hidden).toBe(false);
});
it("时钟分支内部的条件保持嵌套，不把时钟条件丢掉",()=>{
  const nested=source.replace("s_ext_pps <= s_ext_pps(2 downto 0) & i_pps_ext;","if i_pps_ext = '1' then s_ext_pps <= s_ext_pps(2 downto 0) & i_pps_ext; end if;");
  const files=new Map([["top.vhd",nested]]),p=new SignalProject(files),ctx=p.root("top")!,body=document.createElement("div");
  new SignalLogicView(localLogic(new ComputationProject(files,p),p,ctx,"s_ext_pps"),body,{navigate(){}},files);
  const guards=[...body.querySelectorAll('[data-node="s_ext_pps"] .branch-guard')].map(e=>e.textContent);
  expect(guards).toContain("elsif rising_edge(i_clk) then");expect(body.querySelector('.branch-card')).toBeNull();
  body.querySelectorAll<HTMLElement>('[data-node="s_ext_pps"] summary')[1].click();
  const child=body.querySelector<HTMLElement>('.branch-card')!;expect(child.hidden).toBe(false);expect(child.querySelector('.branch-guard')?.textContent).toContain("i_pps_ext");
});
it("真正未知的表达式显示具体原因，不把位宽和时钟当停止原因",()=>{
  const files=new Map([["top.vhd",source.replace("(others => '0')","mystery(i_pps_ext)")]]),p=new SignalProject(files),ctx=p.root("top")!,g=localLogic(new ComputationProject(files,p),p,ctx,"s_ext_pps"),body=document.createElement("div");
  new SignalLogicView(g,body,{navigate(){}},files);
  expect(body.querySelector('[data-node="s_ext_pps"] .flow-reason')?.textContent).toContain("mystery(i_pps_ext)");
});
it("多入和多出分别使用独立接点，连接不在同一个箭头处重叠",()=>{
  const canvas=document.createElement("div"),svg=makeWires();canvas.append(svg);
  const positions=new Map([['a',{x:24,y:28,h:88}],['b',{x:24,y:152,h:88}],['q',{x:300,y:28,h:260}],['y',{x:576,y:28,h:88}],['z',{x:576,y:152,h:88}]]);
  drawWires(canvas,svg,positions,[{from:'a',to:'q',current:true},{from:'b',to:'q'},{from:'q',to:'y'},{from:'q',to:'z'}]);
  const paths=[...svg.querySelectorAll<SVGPathElement>('.logic-wire')].map(e=>e.getAttribute('d')!);
  const endpoint=(d:string)=>d.trim().split(/\s+/).at(-1);
  expect(endpoint(paths[0])).not.toBe(endpoint(paths[1]));
  expect(paths[2].split(' ')[0]).not.toBe(paths[3].split(' ')[0]);
  expect(svg.querySelector('[data-from="a"]')?.classList.contains('control')).toBe(true);
});

it("跨列长连线避开中间卡片，箭头仍落在真实目标",()=>{
  const canvas=document.createElement('div'),svg=makeWires();canvas.append(svg);
  drawWires(canvas,svg,new Map([['a',{x:24,y:28,h:88}],['middle',{x:300,y:28,h:160}],['z',{x:576,y:28,h:88}]]),[{from:'a',to:'z'}]);
  const path=svg.querySelector('.logic-wire')!,d=path.getAttribute('d')!,n=d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const points:Array<[number,number]>=[];
  if(d.includes('C'))for(let i=0;i<=40;i++){const t=i/40,u=1-t;points.push([u**3*n[0]+3*u*u*t*n[2]+3*u*t*t*n[4]+t**3*n[6],u**3*n[1]+3*u*u*t*n[3]+3*u*t*t*n[5]+t**3*n[7]]);}
  else for(let k=0;k<n.length-2;k+=2)for(let i=0;i<=40;i++){const t=i/40;points.push([n[k]*(1-t)+n[k+2]*t,n[k+1]*(1-t)+n[k+3]*t]);}
  expect(points.some(([x,y])=>x>300&&x<536&&y>28&&y<188)).toBe(false);
  expect(n.slice(-2)).toEqual([576,72]);expect(path.hasAttribute('marker-end')).toBe(true);
});

it("高赋值卡片与矮端口在同一行时水平连接，折叠代码不移动接点",()=>{
  const canvas=document.createElement('div'),svg=makeWires();canvas.append(svg);
  const positions=new Map([['driver',{x:24,y:28,h:430}],['port',{x:300,y:28,h:88}]]);
  const draw=()=>{drawWires(canvas,svg,positions,[{from:'driver',to:'port'}]);return svg.querySelector('.logic-wire')!.getAttribute('d')!;};
  const expanded=draw(),points=expanded.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(points[1]).toBe(points.at(-1));expect(points[1]).toBeLessThan(100);
  positions.get('driver')!.h=100;
  expect(draw()).toBe(expanded);
});

it("多路接点不跟随代码高度漂移，仍然分开且位于卡片边界内",()=>{
  const canvas=document.createElement('div'),svg=makeWires();canvas.append(svg);
  const positions=new Map([['a',{x:24,y:28,h:88}],['b',{x:24,y:160,h:300}],['q',{x:300,y:28,h:430}]]);
  const draw=()=>{drawWires(canvas,svg,positions,[{from:'a',to:'q'},{from:'b',to:'q'}]);return [...svg.querySelectorAll('.logic-wire')].map(e=>e.getAttribute('d')!);};
  const expanded=draw(),ends=expanded.map(d=>d.match(/-?\d+(?:\.\d+)?/g)!.map(Number).at(-1)!);
  expect(new Set(ends).size).toBe(2);expect(ends.every(y=>y>28&&y<116)).toBe(true);
  positions.get('q')!.h=88;positions.get('b')!.h=88;
  expect(draw()).toEqual(expanded);
});
