import { describe, expect, it } from "vitest";
import { analyzeProcess, processTargetSource } from "../src/analysis/process";
import { parseVerilogProcess, parseVhdlProcess } from "../src/parser/procedural";
import { SignalProject } from "../src/model/signal-flow";
import { ComputationProject } from "../src/analysis/project";
import { localLogic } from "../src/analysis/local";

describe("过程逐语句源码关系", () => {
  it("部分目标保留下标、控制与原文，独立目标继续推导", () => {
    const source = "always @* begin if(en) q[addr] = a; y = b; end";
    const p = analyzeProcess(source, "verilog");
    expect(p.assignments?.map(a => a.target)).toEqual(["q", "y"]);
    expect(p.assignments?.[0].targetText).toBe("q[addr]");
    expect(p.assignments?.[0].selectors[0].value).toBe("addr");
    expect(p.assignments?.[0].conditions[0].value).toBe("en");
    expect(p.updates.has("q")).toBe(false);
    expect(p.updates.get("y")?.args[0].value).toBe("b");
    expect(processTargetSource(source, "verilog", "q")?.map(r => r.text).join("\n")).toContain("q[addr] = a;");
  });
  it("VHDL 索引写入不会清除其他更新", () => {
    const p = analyzeProcess("process(all) begin q(0) <= a; y <= b; end process;", "vhdl");
    expect(p.assignments?.map(a => a.targetText)).toEqual(["q(0)", "y"]);
    expect(p.updates.has("q")).toBe(false);
    expect(p.updates.get("y")?.value).toBe("b");
  });
  it("循环保留源码与内部赋值关系，范围以外的独立赋值继续", () => {
    const source = "always @* begin for(i=0;i<8;i=i+1) begin q[i] = a; end y=b; end";
    const p = analyzeProcess(source, "verilog");
    expect(p.assignments?.find(a => a.target === "q")?.reason).toContain("循环");
    expect(p.assignments?.[0].contexts).toEqual(["for(i=0;i<8;i=i+1)"]);
    expect(p.updates.get("y")?.args[0].value).toBe("b");
    expect(processTargetSource(source, "verilog", "q")?.map(r => r.text).join("\n")).toContain("for(i=0;i<8;i=i+1)");
  });
  it("未知任务调用不猜副作用，调用之后明确重写才恢复", () => {
    const p = analyzeProcess("always @* begin q=a; mutate(q); y=q; z=1; end", "verilog");
    expect(p.assignments?.map(a => a.target)).toEqual(["q", "y", "z"]);
    expect(p.updates.has("q")).toBe(false);
    expect(p.updates.has("y")).toBe(false);
    expect(p.boundaries?.[0].text).toBe("mutate(q);");
    expect(p.updates.get("z")?.args[0].value).toBe("1");
  });
  it("局部子程序声明不混入外层过程，也不清除外层关系", () => {
    const source = "process(all) function helper(x: bit) return bit is begin return x; end function; variable tmp: bit; begin tmp:=a; y<=tmp; end process;";
    const p = analyzeProcess(source, "vhdl");
    expect(p.assignments?.map(a => a.target)).toEqual(["tmp", "y"]);
    expect(p.locals).toContain("tmp");
    expect(p.updates.get("y")?.args[0].value).toBe("a");
  });
  it("旧赋值池保留部分目标与动态地址，同时保留范围边界", () => {
    for (const [text, parse] of [["always @* begin q[addr] <= a; y=b; end", parseVerilogProcess], ["process(all) begin q(addr)<=a; y<=b; end process;", parseVhdlProcess]] as const) {
      const p = parse(text);
      expect(p.assignments.map(a => a.target)).toEqual(["q", "y"]);
      expect(p.assignments[0].selectors).toEqual(["addr"]);
      expect(p.dataSignals).toContain("addr");
      expect(p.boundaries.some(b => b.reason.includes("范围转换"))).toBe(true);
    }
  });
  it("命名块局部变量身份与块外同名模块对象分离", () => {
    const source="always @* begin begin : inner logic tmp; tmp=a; y=tmp; end tmp=b; z=tmp; end";
    const p=analyzeProcess(source,"verilog");
    const local=p.locals[0];
    expect(local).toMatch(/^@local:\d+:tmp$/);
    expect(p.assignments?.map(a=>a.target)).toEqual([local,"y","tmp","z"]);
    expect(p.assignments?.[1].expression.value).toBe(local);
    expect(p.assignments?.[3].expression.value).toBe("tmp");
    expect(p.updates.has("tmp")).toBe(true);
    expect(p.updates.get("z")?.args[0].args[0].value).toBe("b");
    const pool=parseVerilogProcess(source),poolLocal=pool.locals?.[0];
    expect(poolLocal).toMatch(/^@local:\d+:tmp$/);
    expect(pool.assignments.map(a=>a.target)).toEqual([poolLocal,"y","tmp","z"]);
    expect(pool.assignments[1].reads).toEqual([poolLocal]);
    expect(pool.assignments[3].reads).toEqual(["tmp"]);
  });
  it("索引部分切片保留原文限制与地址，不伪造确定范围", () => {
    const p=analyzeProcess("always @* begin q[i +: 8]=a; y=b; end","verilog");
    expect(p.assignments?.[0].targetText).toBe("q[i +: 8]");
    expect(p.assignments?.[0].reason).toContain("部分写入");
    expect(p.updates.has("q")).toBe(false);
    expect(p.updates.has("y")).toBe(true);
  });
  it("条件任务与未知 RHS 调用的副作用不能在分支汇合时丢失", () => {
    for(const body of ["if(en) mutate(q); y=b; z=1;", "q=mutate(a); y=b; z=1;"]) {
      const p=analyzeProcess(`always @* begin ${body} end`,"verilog");
      expect(p.updates.has("y")).toBe(false);
      expect(p.updates.has("z")).toBe(true);
      expect(p.assignments?.find(a=>a.target==="y")?.reason).toContain("未确定");
    }
  });
  it("部分立即写影响后续读取，部分延迟写仍读取旧值，全目标后写可以覆盖", () => {
    const blocking=analyzeProcess("always @* begin q[0]=a; y=q; end","verilog");
    const deferred=analyzeProcess("always @(posedge clk) begin q[0]<=a; y<=q; end","verilog");
    expect(blocking.updates.has("y")).toBe(false);
    expect(deferred.updates.get("y")?.value).toBe("q");
    const overwritten=analyzeProcess("always @(posedge clk) begin q[0]<=a; q<=b; end","verilog");
    expect(overwritten.updates.get("q")?.value).toBe("b");
  });
  it("VHDL 未展开循环保留内层关系与完整原文，独立目标继续", () => {
    const source="process(all) begin for i in 0 to 7 loop q(i)<=a; end loop; y<=b; end process;";
    const p=analyzeProcess(source,"vhdl");
    expect(p.assignments?.map(a=>a.target)).toEqual(["q","y"]);
    expect(p.assignments?.[0].reason).toContain("循环");
    expect(p.assignments?.[0].contexts).toEqual(["for i in 0 to 7 loop"]);
    expect(p.updates.get("y")?.value).toBe("b");
    expect(processTargetSource(source,"vhdl","q")?.map(r=>r.text).join("\n")).toContain("for i in 0 to 7 loop q(i)<=a; end loop;");
  });
  it("旧赋值池的部分局部写入边界提供原名到身份绑定", () => {
    const p=parseVerilogProcess("always @* begin begin : inner logic tmp; tmp[0]=a; end tmp=b; end");
    expect(p.boundaries[0].bindings?.tmp).toBe(p.locals?.[0]);
    expect(p.assignments.map(a=>a.target)).toEqual([p.locals?.[0],"tmp"]);
  });
  it("块局部声明的可见范围只覆盖所属块，嵌套同名声明分开", () => {
    const source="always @* begin begin : outer logic tmp; tmp=a; begin : inner logic tmp; tmp=b; end y=tmp; end tmp=c; end";
    const p=parseVerilogProcess(source),bindings=p.localBindings!;
    expect(bindings).toHaveLength(2);
    const outer=bindings[0],inner=bindings[1];
    expect(outer.name).toBe("tmp");expect(inner.name).toBe("tmp");
    expect(outer.identity).not.toBe(inner.identity);
    const lookup=(at:number)=>bindings.filter(b=>b.name==="tmp"&&at>=b.start&&at<b.end).sort((a,b)=>b.start-a.start)[0]?.identity;
    expect(lookup(source.indexOf("tmp=a"))).toBe(outer.identity);
    expect(lookup(source.indexOf("tmp=b"))).toBe(inner.identity);
    expect(lookup(source.indexOf("y=tmp")+2)).toBe(outer.identity);
    expect(lookup(source.indexOf("tmp=c"))).toBeUndefined();
    expect(source.slice(inner.end,inner.end+3)).toBe("end");
  });
  it("SV for 声明变量不连接同名模块地址，退出循环恢复模块身份", () => {
    const body="always @* begin for(int i=0;i<4;i++) q[i]=a; z=i; end";
    const process=analyzeProcess(body,"verilog"),local=process.locals[0];
    expect(local).toMatch(/^@local:\d+:i$/);
    expect(process.assignments?.[0].selectors[0].value).toBe(local);
    expect(process.assignments?.[1].expression.value).toBe("i");
    const source=`module top(input a,input [3:0] i,output reg [3:0] q,z); ${body} endmodule`;
    const files=new Map([["loop.v",source]]),project=new SignalProject(files),ctx=project.root("top")!,comp=new ComputationProject(files,project);
    expect(localLogic(comp,project,ctx,"q").edges.some(e=>e.from==="i"&&e.to==="q")).toBe(false);
    const pool=parseVerilogProcess(body),binding=pool.localBindings![0];
    expect(pool.assignments[0].selectors).toEqual(["i"]);
    expect(pool.assignments[0].reason).toContain("循环");
    expect(binding.end).toBe(body.indexOf("z=i"));
  });
  it("VHDL for 隐式变量遮蔽过程变量，退出循环恢复原变量", () => {
    const body="process(all) variable i:integer; begin i:=a; for i in 0 to 3 loop q(i)<=b; end loop; z<=i; end process;";
    const process=analyzeProcess(body,"vhdl"),local=process.locals.find(n=>n.startsWith("@local:"))!;
    expect(local).toMatch(/^@local:\d+:i$/);
    expect(process.assignments?.[1].selectors[0].value).toBe(local);
    expect(process.assignments?.[2].expression.value).toBe("i");
    expect(process.updates.get("z")?.args[0].value).toBe("a");
    const pool=parseVhdlProcess(body);
    expect(pool.localBindings?.[0].identity).toBe(local);
    expect(pool.assignments.map(a=>a.target)).toEqual(["i","q","z"]);
  });
  it("foreach 隐式多维变量保留内层关系与范围，块外同名不被遮蔽", () => {
    const body="always @* begin foreach(mem[row,col]) q[row][col]=a; z=row; end";
    const process=analyzeProcess(body,"verilog");
    expect(process.locals).toHaveLength(2);
    expect(process.assignments?.[0].selectors.map(s=>s.value)).toEqual(process.locals);
    expect(process.assignments?.[0].contexts).toEqual(["foreach(mem[row,col])"]);
    expect(process.assignments?.[1].expression.value).toBe("row");
    const pool=parseVerilogProcess(body);
    expect(pool.localBindings).toHaveLength(2);
    expect(pool.assignments.map(a=>a.target)).toEqual(["q","z"]);
    expect(body.slice(pool.boundaries[0].index,pool.boundaries[0].endIndex)).toBe("foreach(mem[row,col]) q[row][col]=a;");
  });
  it("使用已声明模块变量的 for 不新建局部身份", () => {
    const p=analyzeProcess("always @* begin for(i=0;i<4;i++) q[i]=a; end","verilog");
    expect(p.locals).toEqual([]);
    expect(p.assignments?.[0].selectors[0].value).toBe("i");
    const after=analyzeProcess("always @* begin for(i=0;i<4;i++) q[i]=a; z=i; end","verilog");
    expect(after.updates.has("z")).toBe(false);
  });
  it("typedef 型 for 声明变量同样保持局部身份而非连接同名模块信号", () => {
    const body="always @* begin for(index_t i=0;i<4;i++) q[i]=a; z=i; end";
    const process=analyzeProcess(body,"verilog");
    expect(process.locals[0]).toMatch(/^@local:\d+:i$/);
    expect(process.assignments?.[0].selectors[0].value).toBe(process.locals[0]);
    expect(process.assignments?.[1].expression.value).toBe("i");
    const pool=parseVerilogProcess(body);
    expect(pool.localBindings?.[0].name).toBe("i");
    expect(pool.assignments[0].selectorReads).toEqual([pool.localBindings?.[0].identity]);
  });
  it("嵌套循环同名变量和循环内未知调用保持隔离与副作用边界", () => {
    const body="always @* begin for(int i=0;i<2;i++) begin foreach(mem[i]) q[i]=a; y[i]=b; mutate(q); end z=i; end";
    const p=analyzeProcess(body,"verilog"),outer=p.locals[0],inner=p.locals[1];
    expect(outer).not.toBe(inner);
    expect(p.assignments?.[0].selectors[0].value).toBe(inner);
    expect(p.assignments?.[1].selectors[0].value).toBe(outer);
    expect(p.assignments?.[2].expression.value).toBe("i");
    expect(p.updates.has("z")).toBe(false);
    const pool=parseVerilogProcess(body);
    expect(pool.assignments[0].selectorReads).toEqual([pool.localBindings?.[1].identity]);
    expect(pool.assignments[1].selectorReads).toEqual([pool.localBindings?.[0].identity]);
    expect(pool.boundaries.some(b=>b.reason.includes("调用"))).toBe(true);
  });
  it("循环头未知调用的副作用不让随后外部读取冒充可靠更新", () => {
    const p=analyzeProcess("always @* begin for(int i=init();i<4;i++) q[i]=a; z=b; end","verilog");
    expect(p.updates.has("z")).toBe(false);
    expect(p.assignments?.find(a=>a.target==="z")?.reason).toContain("未确定");
  });
});
