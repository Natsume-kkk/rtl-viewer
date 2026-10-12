import {expect,it} from "vitest";
import {SignalProject,traceSignal} from "../src/model/signal-flow";
import {evaluateConstant} from "../src/parser/static-generate";

const view=(source:string)=>new SignalProject(new Map([["p.v",source]])).moduleForContext({module:"top",path:"top"})!;
it("参数类型按位宽截断并保留 signed，未知自定义类型不选择确定分支",()=>{
  expect(view("module top #(parameter bit ENABLE=2)(input a,b,output y); if(ENABLE) begin:g assign y=a;end else begin:h assign y=b;end endmodule").assignments.map(a=>a.expression)).toEqual(["b"]);
  expect(view("module top #(parameter signed [3:0] VALUE=15)(input a,b,output y); if(VALUE<0) begin:g assign y=a;end else begin:h assign y=b;end endmodule").assignments.map(a=>a.expression)).toEqual(["a"]);
  const unknown=view("module top #(parameter custom_t VALUE=1)(input a,b,output y); if(VALUE) begin:g assign y=a;end else begin:h assign y=b;end endmodule");
  expect(unknown.assignments).toHaveLength(0);expect(unknown.boundaries[0].reason).toContain("无法静态确定");
  const multidimensional=view("module top #(parameter logic [1:0][1:0] VALUE=4)(input a,b,output y); if(VALUE)begin:g assign y=a;end else begin:h assign y=b;end endmodule");
  expect(multidimensional.assignments).toHaveLength(0);
  expect(view("module top #(parameter logic [3:0] VALUE='1)(input a,b,output y);if(VALUE==15)begin:g assign y=a;end else begin:h assign y=b;end endmodule").assignments.map(a=>a.expression)).toEqual(["a"]);
});
it("局部 typed 与 untyped 常量传给子实例时使用各自生成词法环境",()=>{
  for(const declaration of ["localparam K=1","localparam integer K=1"]){
    const source=`module child #(parameter N=0)(input a,b,output y); if(N) begin:g assign y=a;end else begin:h assign y=b;end endmodule module top(input a,b,output [1:0] y);localparam K=0; for(genvar i=0;i<2;i++)begin:lanes ${declaration}; child #(.N(K+i)) u(.a(a),.b(b),.y(y[i]));end endmodule`;
    const p=new SignalProject(new Map([["p.v",source]])),root=p.root("top")!,mod=p.moduleForContext(root)!;
    expect(mod.instances.map(inst=>p.moduleForContext(p.child(root,inst))!.parameterValues?.get("N"))).toEqual([1,2]);
    expect(mod.instances.map(inst=>p.moduleForContext(p.child(root,inst))!.assignments[0].expression)).toEqual(["a","a"]);
  }
});
it("右移与 clog2 使用精确整数规则",()=>{
  expect(evaluateConstant("-1 >> 1",new Map())).toBe(2147483647);
  expect(evaluateConstant("$clog2(4503599627370497)",new Map())).toBe(53);
  expect(evaluateConstant("4'h100000000000001",new Map())).toBe(1);
  expect(evaluateConstant("4'h___",new Map())).toBeUndefined();
  expect(view("module top(input a,b,output y);if((-1>>1)<0)begin:g assign y=a;end else begin:h assign y=b;end endmodule").assignments.map(a=>a.expression)).toEqual(["b"]);
});
it("生成局部入口保留所有有效候选，内部身份直达而未选择身份明确限制",async()=>{
  const source="module top(input a,output [1:0] y);generate for(genvar i=0;i<2;i++)begin:lanes wire w;assign w=a;assign y[i]=w;end endgenerate endmodule";
  const p=new SignalProject(new Map([["p.v",source]])),ctx=p.root("top")!,position={file:"p.v",line:1,column:source.indexOf("w=a")+1};
  const candidates=p.signalCandidates(ctx,"w",position);
  expect(candidates.map(c=>c.label)).toEqual(["lanes[0].w","lanes[1].w"]);
  expect(new Set(candidates.map(c=>c.name)).size).toBe(2);
  const ambiguous=await traceSignal(p,ctx,"w","upstream",{source:position});expect(ambiguous.reason).toContain("多个");
  const selected=await traceSignal(p,ctx,candidates[1].name,"upstream",{source:position});expect(selected.children[0].signal?.name).toBe("a");
  const singleSource=source.replace("i<2","i<1"),single=new SignalProject(new Map([["p.v",singleSource]]));
  expect(single.signalIdentity("top","w",position).name).toContain("__gen_lanes_0_");
});
it("生成过程局部同源码身份由 process scope 选择，不与模块局部串线",async()=>{
  const source="module top(input a,b,output reg [1:0] y);generate for(genvar i=0;i<2;i++)begin:lanes always @* begin logic tmp; tmp=a; y[i]=tmp;end end endgenerate endmodule";
  const p=new SignalProject(new Map([["p.v",source]])),ctx=p.root("top")!,position={file:"p.v",line:1,column:source.indexOf("tmp=a")+1};
  const candidates=p.signalCandidates(ctx,"tmp",position);
  expect(candidates.map(c=>c.scope)).toEqual([0,1]);
  const chosen=await traceSignal(p,ctx,candidates[1].name,"upstream",{source:position,scope:1});
  expect(chosen.reason).toBeUndefined();expect(chosen.scope).toBe(1);expect(chosen.children[0].signal?.name).toBe("a");
});
it("record 字段端口写入基对象能到达第一处赋值",async()=>{
  const source="package types is type pair_t is record data: bit; end record; end;use work.types.all;entity top is port(a:in bit;q:out pair_t);end;architecture rtl of top is begin process(all)begin q.data<=a;end process;end;";
  const p=new SignalProject(new Map([["p.vhd",source]])),trace=await traceSignal(p,p.root("top")!,"q","upstream",{stopAtAssignments:true});
  expect(trace.children.some(c=>c.reason==="赋值位置"&&c.statement?.includes("q.data<=a"))).toBe(true);
});
it("循环局部地址和边界不绑定同名模块端口",async()=>{
  const source="module top(input a,input [3:0] i,output reg [3:0] q);always @* begin for(int i=0;i<4;i++)q[i]=a;end endmodule";
  const p=new SignalProject(new Map([["p.v",source]])),trace=await traceSignal(p,p.root("top")!,"i","downstream",{stopAtAssignments:true});
  expect(trace.children).toHaveLength(0);
});
