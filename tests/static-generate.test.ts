import { describe, expect, it } from "vitest";
import { SignalProject, traceSignal } from "../src/model/signal-flow";
import { parseFileDetail } from "../src/parser";
import { evaluateConstant } from "../src/parser/static-generate";

describe("按实例静态 generate", () => {
  it("安全常量求值，未知、溢出和副作用表达式保持未知", () => {
    expect(evaluateConstant("(N + 1) * 2 == 8", new Map([["N", 3]]))).toBe(1);
    expect(evaluateConstant("8'hff >> 4", new Map())).toBe(15);
    expect(evaluateConstant("true and (N = 3)", new Map([["n", 3]]), true)).toBe(1);
    for (const text of ["missing + 1", "1 / 0", "f(3)", "8'bx", "9007199254740992", "1 << 100"]) expect(evaluateConstant(text, new Map())).toBeUndefined();
    expect(evaluateConstant("4'hf + 4'h1 == 0",new Map())).toBeUndefined();
    expect(evaluateConstant("~4'hf == 0",new Map())).toBeUndefined();
    expect(evaluateConstant("2#102#",new Map(),true)).toBeUndefined();
    expect(evaluateConstant("true",new Map([["true",4]]))).toBe(4);
    expect(evaluateConstant("2147483647 + 1 > 0",new Map())).toBeUndefined();
  });
  it("保存命名与位置参数，两个实例选择不同互斥分支", async () => {
    const source = `module leaf #(parameter N=1)(input a,b, output y);
      generate if (N == 1) begin : first assign y=a; end
      else begin : second assign y=b; end endgenerate endmodule
      module top(input a,b, output y,z); leaf #(.N(1)) u(.a(a),.b(b),.y(y)); leaf #(2) v(.a(a),.b(b),.y(z)); endmodule`;
    const parsed = parseFileDetail(source, "p.v");
    expect(parsed[1].instances[0].parameterOverrides).toEqual([{ name: "N", expression: "1" }]);
    const project = new SignalProject(new Map([["p.v", source]]));
    const root = project.root("top")!;
    const mod = project.moduleForContext(root)!;
    const u = project.moduleForContext(project.child(root,mod.instances[0]))!;
    const v = project.moduleForContext(project.child(root,mod.instances[1]))!;
    expect(u.assignments.map(a=>a.expression)).toEqual(["a"]);
    expect(v.assignments.map(a=>a.expression)).toEqual(["b"]);
    expect((await traceSignal(project,root,"z","upstream")).children[0].children[0].signal?.name).toBe("b");
  });
  it("嵌套循环有唯一实例身份、常量下标和原源码行号", () => {
    const source = `module leaf(input a, output y); assign y=a; endmodule
      module top(input [3:0] a, output [3:0] y);
      generate for(genvar i=0;i<2;i=i+1) begin : rows
        for(genvar j=0;j<2;j++) begin : cols leaf u(.a(a[i*2+j]),.y(y[i*2+j])); end
      end endgenerate endmodule`;
    const project = new SignalProject(new Map([["p.v",source]]));
    const mod = project.moduleForContext(project.root("top")!)!;
    expect(mod.instances.map(i=>i.inst)).toEqual(["rows[0].cols[0].u","rows[0].cols[1].u","rows[1].cols[0].u","rows[1].cols[1].u"]);
    expect(mod.instances[3].connections?.[0].expr).toBe("a[1*2+1]");
    expect(mod.instances.every(i=>i.line === 4)).toBe(true);
  });
  it("未知区域只留下局部边界，块外赋值仍可追", async () => {
    const source = `module top(input a,b, output y,z); generate if(UNKNOWN) begin : maybe assign z=b; end endgenerate assign y=a; endmodule`;
    const project = new SignalProject(new Map([["p.v",source]]));
    const mod = project.moduleForContext(project.root("top")!)!;
    expect(mod.problem).toBeUndefined();
    expect(mod.assignments.map(a=>a.target)).toEqual(["y"]);
    expect(mod.boundaries.some(b=>b.reason.includes("generate"))).toBe(true);
    expect((await traceSignal(project,project.root("top")!,"y","upstream")).children[0].signal?.name).toBe("a");
  });
  it("不终止或超预算循环不伪造完整结果", () => {
    const source = `module top(input a,output y); generate for(genvar i=0;i<100000;i++) begin : many assign y=a; end endgenerate endmodule`;
    const mod = new SignalProject(new Map([["p.v",source]])).moduleForContext({module:"top",path:"top"})!;
    expect(mod.assignments).toHaveLength(0);
    expect(mod.boundaries.some(b=>b.reason.includes("预算"))).toBe(true);
  });
  it("VHDL generic 与降序 for/if generate", () => {
    const source = `entity leaf is generic(N: integer:=1); port(a,b:in bit;y:out bit);end entity;
      architecture rtl of leaf is begin first: if N = 1 generate y<=a; else generate y<=b; end generate; end architecture;
      entity top is port(a,b:in bit;y:out bit);end entity;
      architecture rtl of top is begin rows: for i in 1 downto 0 generate u: entity work.leaf generic map(N=>i) port map(a=>a,b=>b,y=>y); end generate; end architecture;`;
    const project = new SignalProject(new Map([["p.vhd",source]]));
    const root = project.root("top")!, mod = project.moduleForContext(root)!;
    expect(mod.instances.map(i=>i.inst)).toEqual(["rows[1].u","rows[0].u"]);
    expect(project.moduleForContext(project.child(root,mod.instances[0]))!.assignments.map(a=>a.expression)).toEqual(["a"]);
    expect(project.moduleForContext(project.child(root,mod.instances[1]))!.assignments.map(a=>a.expression)).toEqual(["b"]);
  });
  it("sized 参数的算术保守未知，不能因数值化选择错误分支", () => {
    const source=`module top(input a,b,output y); parameter P=4'hf; generate if(P+4'h1==0) begin : yes assign y=a; end else begin : no assign y=b; end endgenerate endmodule`;
    const mod=new SignalProject(new Map([["p.v",source]])).moduleForContext({module:"top",path:"top"})!;
    expect(mod.assignments).toHaveLength(0);
    expect(mod.boundaries[0].reason).toContain("无法静态确定");
  });
  it("结构先筛除无关子树，寻找上下文不会详细解析无关模块", () => {
    const source=`module top(); target u(); unrelated big(); endmodule module target(); endmodule module unrelated(); other x(); endmodule module other(); endmodule`;
    const project=new SignalProject(new Map([["p.v",source]]));
    const visited:string[]=[];const original=project.module.bind(project);
    project.module=(name)=>{visited.push(name);return original(name);};
    expect(project.contexts("top","target").items.map(c=>c.path)).toEqual(["top/u"]);
    expect(visited).not.toContain("unrelated");expect(visited).not.toContain("other");
  });
  it("生成局部对象各迭代独立，长度变化可以回指原始表达式和过程", () => {
    const source=`module top(input a,output y);generate for(genvar i=10;i<12;i++) begin : loop wire w; assign w=a; always @* y=w; end endgenerate endmodule`;
    const mod=new SignalProject(new Map([["p.v",source]])).moduleForContext({module:"top",path:"top"})!;
    const names=mod.assignments.filter(a=>a.proc===-1).map(a=>a.target);
    expect(new Set(names).size).toBe(2);
    expect(mod.processes[0].text).toContain(names[0]);
    const p=mod.processes[0],at=p.text!.indexOf(names[0]);
    expect(source.slice(p.sourceMap![at],p.sourceMap![at+names[0].length])).toBe("w");
    expect(mod.sourceViews!.filter(v=>v.scope).some(v=>v.text.includes(`wire ${names[0]}`))).toBe(true);
  });
  it("复杂端口映射能追第一处赋值，输出地址不会冒充输出驱动", async () => {
    const source=`module top(input [3:0] a,input idx,output [3:0] y); leaf u(.i({a[1:0],a[3:2]}),.o(y[idx])); endmodule module leaf(input [3:0] i,output o); assign o=i[0]; endmodule`;
    const project=new SignalProject(new Map([["p.v",source]])),root=project.root("top")!;
    const down=await traceSignal(project,root,"a","downstream",{stopAtAssignments:true});
    expect(down.children[0].mapping).toContain("{a[1:0],a[3:2]}");
    expect(down.children[0].children[0].reason).toBe("赋值位置");
    const index=await traceSignal(project,root,"idx","upstream",{stopAtAssignments:true});
    expect(index.children.some(c=>c.port?.path==="top/u")).toBe(false);
    const output=await traceSignal(project,root,"y","upstream",{stopAtAssignments:true});
    expect(output.children[0].children[0].reason).toBe("赋值位置");
  });
  it("generate 内常量、隐式分支与非支持选择不伪造并行赋值", () => {
    const source=`module top(input a,b,output y);for(genvar i=0;i<2;i+=1) begin : rows localparam K=i*2; if(K==0) begin : yes assign y=a; end else if(K==2) begin : no assign y=b; end end endmodule`;
    const mod=new SignalProject(new Map([["p.v",source]])).moduleForContext({module:"top",path:"top"})!;
    expect(mod.assignments.map(a=>a.expression)).toEqual(["a","b"]);
    const vhdl=`entity top is port(a,b:in bit;y,z:out bit);end; architecture rtl of top is begin bad:if UNKNOWN generate y<=a; elsif true generate y<=b; end generate; z<=a;end;`;
    const limited=new SignalProject(new Map([["p.vhd",vhdl]])).moduleForContext({module:"top",path:"top"})!;
    expect(limited.assignments.map(a=>a.target)).toEqual(["z"]);
    expect(limited.boundaries[0].reason).toContain("elsif");
    const cases=`module top(input a,b,output y,z);generate case(1) 1:begin case(2) 2:assign y=a; endcase assign y=b;end endcase endgenerate assign z=a;endmodule`;
    const caseMod=new SignalProject(new Map([["p.v",cases]])).moduleForContext({module:"top",path:"top"})!;
    expect(caseMod.assignments.map(a=>a.target)).toEqual(["z"]);
  });
  it("VHDL 嵌套 else generate 只归属于所在层", () => {
    const source=`entity top is port(a,b,c:in bit;y,z:out bit);end; architecture rtl of top is begin
      outer:if true generate inner:if false generate y<=a; else generate y<=b; end generate; z<=c;
      else generate y<=c; z<=b; end generate;end;`;
    const mod=new SignalProject(new Map([["p.vhd",source]])).moduleForContext({module:"top",path:"top"})!;
    expect(mod.assignments.map(a=>`${a.target}=${a.expression}`)).toEqual(["y=b","z=c"]);
  });
  it("未闭合 generate 不将候选赋值纳入确定结果", () => {
    for(const source of [
      "module top(input a,output y); generate if(1) begin : missing assign y=a; endmodule",
      "entity top is port(a:in bit;y:out bit);end;architecture rtl of top is begin missing:if true generate y<=a;end;",
    ]) {
      const file=source.startsWith("module")?"p.v":"p.vhd";
      const mod=new SignalProject(new Map([[file,source]])).moduleForContext({module:"top",path:"top"})!;
      expect(mod.assignments).toHaveLength(0);expect(mod.boundaries[0].reason).toContain("未闭合");
    }
  });
  it("隐式 if 的 localparam 不泄漏至模块或兄弟生成块", () => {
    const source=`module top(input a,b,output y,z,w); localparam K=0;
      if(1) begin : branch localparam PRIVATE=1; localparam K=1; assign z=a; end
      if(PRIVATE) begin : sibling assign y=b; end
      if(K==0) begin : stable assign w=a; end endmodule`;
    const mod=new SignalProject(new Map([["p.v",source]])).moduleForContext({module:"top",path:"top"})!;
    expect(mod.parameterValues?.has("PRIVATE")).toBe(false);
    expect(mod.parameterValues?.get("K")).toBe(0);
    expect(mod.assignments.map(a=>a.target)).toEqual(["z","w"]);
    expect(mod.boundaries.some(b=>b.reason.includes("PRIVATE"))).toBe(true);
  });
  it("过程嵌套局部同名目标不与模块目标合并", async () => {
    const source="module top(input a,b, output reg tmp,y,z); always @* begin begin : inner logic tmp; tmp=a; y=tmp; end tmp=b; z=tmp; end endmodule";
    const p=new SignalProject(new Map([["p.v",source]])),root=p.root("top")!;
    const trace=await traceSignal(p,root,"tmp","upstream");
    expect(JSON.stringify(trace)).not.toContain('"name":"a"');
    expect(JSON.stringify(trace)).toContain('"name":"b"');
    const a=await traceSignal(p,root,"a","downstream");
    expect(a.children[0].scope).toBe(0);
    expect(a.children[0].signal?.identity).toMatch(/^@local:/);
    expect(a.children[0].signal?.name).toBe("tmp");
    const position={file:"p.v",line:1,column:source.indexOf("tmp=a")+1};
    expect(p.signalScope("top","tmp",position)).toBe(0);
    const local=await traceSignal(p,root,"tmp","upstream",{source:position,stopAtAssignments:true});
    expect(local.signal?.name).toBe("tmp");
    expect(local.children[0].statement).toContain("tmp=a;");
    expect(local.children[0].statement).not.toContain("tmp=b;");
    expect(local.children[0].label).not.toContain("@local");
    const modulePosition={file:"p.v",line:1,column:source.indexOf("tmp=b")+1};
    expect(p.signalIdentity("top","tmp",modulePosition)).toEqual({name:"tmp",scope:-1});
  });
});
