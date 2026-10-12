// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {SignalProject,traceSignal} from '../src/model/signal-flow';
import {SignalFlowPanel} from '../src/ui/signal-flow';
import {ComputationProject} from '../src/analysis/project';
import {localLogic} from '../src/analysis/local';
import {processTargetSource,analyzeProcess} from '../src/analysis/process';

const trace=async(source:string,signal:string,direction:'upstream'|'downstream',file='t.v')=>{const p=new SignalProject(new Map([[file,source]]));return traceSignal(p,p.root('t')!,signal,direction,{stopAtAssignments:true});};
it('正常终点区分无后续引用与无赋值来源，KEEP 不冒充逻辑读取',async()=>{
  expect((await trace('module t; wire q; endmodule','q','downstream')).reason).toBe('无后续引用');
  expect((await trace('module t; wire q; endmodule','q','upstream')).reason).toBe('无赋值来源');
  expect((await trace(`entity t is end t; architecture rtl of t is signal q: bit; attribute KEEP of q: signal is "TRUE"; begin end rtl;`,'q','downstream','t.vhd')).reason).toBe('无后续引用');
});
it('未支持引用与未声明对象不能显示为无后续引用',async()=>{
  const r=await trace(`entity t is end t; architecture rtl of t is signal q: bit; begin assert q='1' report "bad"; end rtl;`,'q','downstream','t.vhd');
  expect(r.reason).toContain('无法继续分析');expect(r.reason).not.toContain('无后续引用');
  expect((await trace('module t; endmodule','missing','downstream')).reason).toContain('未识别信号声明');
});
it('被赋值的内部信号仍能追到控制用途，并发 when 条件也计为引用',async()=>{
  const r=await trace('module t(input clk,a,output reg y); reg q; always @(posedge clk) q<=a; always @* if(q) y=1; else y=0; endmodule','q','downstream');
  expect(r.children).toHaveLength(1);
  expect(r.children[0].note).toBe('条件引用');
  expect(r.children[0].target?.signal).toBe('y');
  expect(r.children[0].statement).toContain('if (q)');
  expect(r.children[0].statement).toContain('y=1;');
  expect(r.children[0].children).toHaveLength(0);
  const v=await trace(`entity t is port(sel:in bit; y:out bit);end t; architecture rtl of t is begin y <= '1' when sel='1' else '0'; end rtl;`,'sel','downstream','t.vhd');
  expect(v.children).toHaveLength(1);expect(v.children[0].statement).toContain('when');
});
it('同进程同目标的复位与数据赋值仅一个节点，条件原文和行号保留',async()=>{
  const source=`entity t is port(clk,rst,d:in bit; q:out bit);end t;
architecture rtl of t is begin
process(clk,rst) begin
if rst='0' then
q <= '0';
elsif rising_edge(clk) then
q <= d;
end if; end process;end rtl;`;
  const up=await trace(source,'q','upstream','t.vhd');expect(up.children).toHaveLength(1);
  expect(up.children[0].statement).toContain("if rst='0' then");expect(up.children[0].statement).toContain('elsif rising_edge(clk) then');
  expect(up.children[0].sourceRows?.filter(r=>r.line).map(r=>r.line)).toEqual([5,7]);
});
it('不同进程与连续赋值仍分开，读取端同进程重复赋值不重复接线',async()=>{
  const source='module t(input a,clk,sel,output reg q); always @(posedge clk) if(sel) q<=a; else q<=0; always @* q=a; assign q=a; endmodule';
  expect((await trace(source,'q','upstream')).children).toHaveLength(3);
  const r=await trace('module t(input a,sel,output reg q); always @* if(sel) q=a; else q=a+1; endmodule','a','downstream');
  expect(r.children).toHaveLength(1);expect(r.children[0].statement).toContain('else');
});
it('当前终点不新增同名节点，赋值组内各条可独立定位',async()=>{
  const root=document.createElement('aside'),navigate=vi.fn(),panel=new SignalFlowPanel(root,{close(){},context(){},navigate});
  panel.result('q',{label:'t.q',reason:'无赋值来源',children:[]},{label:'t.q',reason:'无后续引用',children:[]},'');
  expect(root.querySelectorAll('.port-card')).toHaveLength(1);expect(root.querySelectorAll('.logic-wire')).toHaveLength(0);expect(root.textContent).toContain('无后续引用');expect(root.textContent).toContain('无赋值来源');
  const up=await trace('module t(input a,s,output reg q);\nalways @* if(s) q=a;\nelse q=0;\nendmodule','q','upstream');
  panel.result('q',up,{label:'t.q',children:[]},'');expect(root.querySelectorAll('.logic-wire')).toHaveLength(1);
  root.querySelector<HTMLButtonElement>('.assignment-source[data-line="3"]')!.click();expect(navigate).toHaveBeenCalledWith('t.v',3);
  const block=root.querySelector<HTMLDetailsElement>('.assignment-block')!;block.open=false;
  const state=panel.capture();panel.result('q',up,{label:'t.q',children:[]},'');panel.restore(state);
  expect(root.querySelector<HTMLDetailsElement>('.assignment-block')!.open).toBe(false);
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='全部展开')!.click();
  expect(root.querySelector<HTMLDetailsElement>('.assignment-block')!.open).toBe(true);
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='全部收起')!.click();
  expect(root.querySelector<HTMLDetailsElement>('.assignment-block')!.open).toBe(false);
});
it('仅写入不算后续引用，初始化和局部同名对象不会误导终点',async()=>{
  expect((await trace('module t(input clk); reg q; always @(posedge clk) q<=0; endmodule','q','downstream')).reason).toBe('无后续引用');
  expect((await trace('module t; wire q; wire r=q; endmodule','q','downstream')).children).toHaveLength(1);
  expect((await trace(`entity t is end t; architecture rtl of t is signal q:bit; begin process is variable q:bit; begin q:='1'; assert q='1'; end process; end rtl;`,'q','downstream','t.vhd')).reason).toBe('无后续引用');
});
it('过程摘录保留嵌套 case、顺序赋值和没有目标赋值的优先分支',()=>{
  const source=`process(clk) begin if rising_edge(clk) then case sel is when 0 => other <= '1'; when 1 => if en='1' then q <= '1'; else q <= '0'; end if; when others => q <= '0'; end case; q <= d; end if; end process;`;
  const rows=processTargetSource(source,'vhdl','q')!,text=rows.map(r=>r.text).join('\n');
  expect(text).toContain('case sel is');expect(text).toMatch(/when 0 =>\n\s+null;/);expect(text).not.toContain('other <=');
  expect(text).toContain("if en='1' then");expect(text.indexOf('q <= d;')).toBeGreaterThan(text.indexOf('end case;'));
  expect(analyzeProcess(text,'vhdl').issues).toEqual([]);
  const verilog=processTargetSource('always @(posedge clk) begin if(sel) q<=1; else if(en) q<=2; else q<=3; case(sel) 0:begin q<=4; q<=5; end default:q<=6; endcase end','verilog','q')!.map(r=>r.text).join('\n');
  expect(analyzeProcess(verilog,'verilog').issues).toEqual([]);
});
it('内部声明无驱动时显示无赋值来源，未知对象仍为分析边界',()=>{
  const files=new Map([['t.v','module t; wire q; endmodule']]),p=new SignalProject(files),comp=new ComputationProject(files,p),ctx=p.root('t')!;
  expect(localLogic(comp,p,ctx,'q').nodes[0]).toMatchObject({kind:'signal',detail:expect.stringContaining('无赋值来源')});
  expect(localLogic(comp,p,ctx,'missing').nodes[0]).toMatchObject({kind:'boundary',detail:expect.stringContaining('未识别信号声明')});
});
