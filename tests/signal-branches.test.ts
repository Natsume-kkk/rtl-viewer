// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { SignalProject } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import { SignalPortsView } from "../src/ui/signal-ports";

function setup(source: string, file = "t.v", signal = "r") {
  const files = new Map([[file, source]]), p = new SignalProject(files), ctx = p.root("t")!;
  const body = document.createElement("div"), navigate = vi.fn(); document.body.append(body);
  const panel = new SignalFlowPanel(body, { close() {}, context() {}, navigate });
  panel.logicResult(signal, ctx, localLogic(new ComputationProject(files, p), p, ctx, signal), files, "");
  return { body, panel, navigate, card: (id: string) => body.querySelector<HTMLElement>(`[data-node="${id}"]`)! };
}

it("端口汇合仅绘制打开的路线，收起一支保留另一支及共享节点", () => {
  const body = document.createElement("div"), shared = { label: "t.shared", children: [] };
  const view = new SignalPortsView("r", { label: "t.r", children: [] }, { label: "t.r", children: [
    { label: "t.a", children: [shared] }, { label: "t.b", children: [shared] },
  ] }, body);
  const card = (s: string) => body.querySelector<HTMLElement>(`[data-signal="${s}"]`)!;
  const button = (s: string) => card(s).querySelector<HTMLButtonElement>(".path-continue")!;
  const edge = (s: string) => [...body.querySelectorAll<SVGElement>(".logic-wire")].some(e => e.dataset.from === card(s).dataset.node && e.dataset.to === card("shared").dataset.node);
  button("a").click(); expect(edge("a")).toBe(true); expect(edge("b")).toBe(false);
  button("b").click(); button("a").click(); expect(edge("a")).toBe(false); expect(edge("b")).toBe(true);
  expect(card("shared").hidden).toBe(false);
  button("b").click(); expect(card("shared").hidden).toBe(true);
  view.expandAll(); expect(edge("a") && edge("b")).toBe(true);
  view.collapseAll(); expect(card("shared").hidden).toBe(true);
});

it("内部条件可收起后续，另一打开条件仍维持共享输出，赋值不重复", () => {
  const { body, card, panel } = setup(`module t(input a,b,sel,output y); reg r;
always @* if(sel) r=a; else r=b; assign y=r; endmodule`);
  const choices = card("r").querySelectorAll<HTMLElement>("summary");
  choices[0].click(); expect(card("y").hidden).toBe(false);
  expect(card("r").textContent?.match(/r = a;/g)).toHaveLength(1);
  choices[1].click(); choices[0].click(); expect(card("y").hidden).toBe(false);
  choices[1].click(); expect(card("y").hidden).toBe(true);
  [...body.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "全部展开")!.click();
  const saved = panel.capture();
  [...body.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "全部收起")!.click();
  expect(card("y").hidden).toBe(true); panel.restore(saved); expect(card("y").hidden).toBe(false);
});

it("各分支定位自己的赋值行，点击定位不切换展开状态", () => {
  const { card, navigate } = setup(`module t(input a,b,sel,output y);
reg r;
always @* begin
 if(sel) r=a;
 else r=b;
end
assign y=r;
endmodule`);
  const branches = card("r").querySelectorAll<HTMLDetailsElement>("details");
  branches[0].querySelector<HTMLButtonElement>(".branch-source")!.click(); expect(navigate).toHaveBeenLastCalledWith("t.v", 4);
  branches[1].querySelector<HTMLButtonElement>(".branch-source")!.click(); expect(navigate).toHaveBeenLastCalledWith("t.v", 5);
  expect([...branches].every(d => !d.open)).toBe(true);
});

it("嵌套 case 保留源码层级，向右展开，收起父支后重开恢复子支", () => {
  const { body, card } = setup(`entity t is port(clk: in bit; y: out bit); end t;
architecture rtl of t is signal r: bit; signal state,substate: integer; begin
process(clk) begin
if rising_edge(clk) then
case state is
when 0 => r <= '0';
when 1 => case substate is
when 2 => r <= '1';
when others => r <= '0';
end case;
when others => r <= '0';
end case;
end if; end process; y <= r; end rtl;`, "t.vhd");
  const clock = card("r").querySelector<HTMLElement>("summary")!; clock.click();
  const state = [...body.querySelectorAll<HTMLElement>(".logic-card")].find(c => c.querySelector(".branch-heading")?.textContent === "case state is")!;
  expect(state.hidden).toBe(false); expect(state.style.left).not.toBe(card("r").style.left);
  const work = [...state.querySelectorAll<HTMLElement>("summary")].find(s => s.textContent?.includes("when 1 =>"))!; work.click();
  const sub = [...body.querySelectorAll<HTMLElement>(".logic-card")].find(c => c.querySelector(".branch-heading")?.textContent === "case substate is")!;
  expect(sub.hidden).toBe(false); sub.querySelector<HTMLElement>("summary")!.click(); expect(card("y").hidden).toBe(false);
  work.click(); expect(sub.hidden).toBe(true); expect(card("y").hidden).toBe(true); expect(state.hidden).toBe(false);
  work.click(); expect(sub.hidden).toBe(false); expect(card("y").hidden).toBe(false);
});

it("未确定实现时不混合驱动，按源码位置只分析所选副本", () => {
  const files = new Map([['a.vhd', `entity t is end t; architecture rtl of t is signal r: bit; begin r <= '0'; end rtl;`],
    ['copy.vhd', `entity t is end t; architecture rtl of t is signal r: bit; begin r <= '1'; end rtl;`]]);
  const p = new SignalProject(files), ctx = p.root("t")!;
  expect(localLogic(new ComputationProject(files,p),p,ctx,"r").nodes[0].drivers).toHaveLength(0);
  const bound = p.forSource("t", {file:"copy.vhd",line:1});
  const graph = localLogic(new ComputationProject(files,bound),bound,ctx,"r");
  expect(graph.nodes[0].drivers).toHaveLength(1);
  expect(graph.nodes[0].drivers[0].expression.text).toBe("'1'");
  expect(graph.nodes[0].kind).not.toBe("boundary");
});

it("同文件多 architecture 按所在行绑定，声明与赋值不串入另一实现", () => {
  const files=new Map([['t.vhd',`entity t is end t;
architecture first of t is signal r: bit; begin r <= '0'; end first;
architecture second of t is signal r: bit_vector(1 downto 0); begin r <= "11"; end second;`]]);
  const p=new SignalProject(files),ctx=p.root('t')!;
  for(const [line,value,width]of [[2,"'0'","bit"],[3,'"11"',"bit_vector(1 downto 0)"]] as const){
    const bound=p.forSource('t',{file:'t.vhd',line}),data=new ComputationProject(files,bound).moduleData(ctx)!;
    expect(data.mod.problem).toBeUndefined();expect(data.drivers.get('r')).toHaveLength(1);
    expect(data.drivers.get('r')![0].expression.text).toBe(value);expect(data.widths.get('r')).toBe(width);
  }
  expect(p.forSource('t',{file:'t.vhd',line:1}).module('t')!.problem).toContain('多个 architecture');
});

it("Verilog 同名模块也停止推导，显式源码选择只取选定文件", () => {
  const files=new Map([['a.v','module t; wire r=0; endmodule'],['b.v','module t; wire r=1; endmodule']]);
  const p=new SignalProject(files),ctx=p.root('t')!;
  expect(p.module('t')!.problem).toContain('同名 module');expect(new ComputationProject(files,p).moduleData(ctx)!.drivers.size).toBe(0);
  const selected=p.forSource('t',{file:'b.v',line:1});expect(new ComputationProject(files,selected).moduleData(ctx)!.drivers.get('r')![0].expression.text).toBe('1');
});

it("内部扇出汇合仅连接展开的路线，关闭全部后保持根信号", () => {
  const {card,body}=setup('module t(input a,output y); wire r=a; wire b=r; wire c=r; assign y=b+c; endmodule');
  const click=(id:string)=>card(id).querySelector<HTMLButtonElement>('.path-continue')!.click();
  const edge=(id:string)=>!!body.querySelector(`.logic-wire[data-from="${id}"][data-to="y"]`);
  click('b');expect(edge('b')).toBe(true);expect(edge('c')).toBe(false);
  click('c');click('b');expect(edge('b')).toBe(false);expect(edge('c')).toBe(true);expect(card('y').hidden).toBe(false);
  click('c');expect(card('y').hidden).toBe(true);expect(card('r').hidden).toBe(false);
});

it("字符串中的结构关键字不误报分析边界，保留完整赋值常量", () => {
  const files=new Map([['t.v','module t; wire [127:0] r="generate process"; endmodule']]),p=new SignalProject(files);
  const data=new ComputationProject(files,p).moduleData(p.root('t')!)!;
  expect(data.mod.problem).toBeUndefined();expect(data.drivers.get('r')![0].expression.text).toBe('"generate process"');
});

it("重建视图后恢复嵌套分支身份，不依赖 DOM 创建顺序", () => {
  const source='module t(input a,b,c,s1,s2,output y); reg r; always @* if(s1) begin if(s2) r=a; else r=b; end else r=c; assign y=r; endmodule';
  const first=setup(source);first.card('r').querySelector<HTMLElement>('summary')!.click();
  first.body.querySelectorAll<HTMLElement>('.branch-card summary')[1].click();const saved=first.panel.capture();
  const second=setup(source);second.panel.restore(saved);
  expect(second.body.querySelector<HTMLElement>('.branch-card')!.hidden).toBe(false);
  expect(second.body.querySelectorAll<HTMLDetailsElement>('.branch-card details')[1].open).toBe(true);
  expect(second.body.querySelectorAll<HTMLDetailsElement>('.branch-card details')[0].open).toBe(false);
  expect(second.card('y').hidden).toBe(false);
});

it("连续赋值三态选择的否则臂显示 else，不使用裸冒号", () => {
  const { card } = setup(`module t(input en, inout dq); wire dq_out; assign dq = en ? dq_out : 1'bz; endmodule`, "t.v", "dq_out");
  const guards = [...card("dq").querySelectorAll<HTMLElement>(".branch-guard")].map(e => e.textContent);
  expect(guards).toEqual(["en ?", "else"]);
  const previews = [...card("dq").querySelectorAll<HTMLElement>(".branch-preview")].map(e => e.textContent);
  expect(previews).toEqual(["dq = dq_out;", "dq = 1'bz;"]);
});
