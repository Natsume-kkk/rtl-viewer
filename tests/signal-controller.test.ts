// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { ModuleIndex } from "../src/model";
import { scanStructure } from "../src/parser";

const fake = vi.hoisted(() => ({ panels: [] as any[] }));
vi.mock("../src/editor/monaco", () => ({ monaco: { editor: { tokenize: (source:string) => source.split("\n").map(()=>[{ offset: 0, type: "identifier" }]) } } }));
vi.mock("../src/ui/signal-flow", () => ({
  SignalFlowPanel: class {
    hint = vi.fn(); objectHint = vi.fn(); setContexts = vi.fn(); clearStale = vi.fn(); markStale = vi.fn();
    message = vi.fn(); result = vi.fn(); logicResult = vi.fn();
    constructor(_root: unknown, readonly actions: any) { fake.panels.push(this); }
  },
}));
import { createSignalController } from "../src/app/signal-controller";

beforeEach(() => { fake.panels.length = 0; });

it("生成块同一源码的多个局部对象可区分选择，刷新保留所选身份",async()=>{
  let source="module top(input a,b,output [1:0] y); generate for(genvar i=0;i<2;i++) begin : lanes wire w; assign w=i?a:b; assign y[i]=w; end endgenerate endmodule";
  const file="D:/test/generate.v",files=new Map([[file,source]]),structures=new Map([[file,scanStructure(source,file)]]),index=new ModuleIndex();index.addStructure([...structures.values()].flat());
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word:"w"}),getLanguageId:()=>"verilog",getVersionId:()=>1,getValue:()=>source};
  const controller=createSignalController(document.createElement("div"),{editor:()=>({getModel:()=>model,getPosition:()=>({lineNumber:1,column:source.indexOf("w=i")+1})}) as any,files:()=>files.keys(),structures:()=>structures,index:()=>index,topName:()=>"top",instancePath:()=>"top",fileContent:()=>source,isOpen:()=>true,close:vi.fn(),navigate:vi.fn(),hint:vi.fn()});
  const panel=fake.panels[0];await controller.analyze();
  const labels=panel.setContexts.mock.lastCall[2];
  expect(labels).toEqual(["top/lanes[0].w","top/lanes[1].w"]);
  const first=panel.logicResult.mock.lastCall[2];
  expect(first.nodes.find((n:any)=>n.id===first.root).drivers).not.toHaveLength(0);
  expect(panel.logicResult.mock.lastCall[4]).toContain("当前生成对象：lanes[0].w");
  panel.actions.context(1);await vi.waitFor(()=>expect(panel.logicResult).toHaveBeenCalledTimes(2));
  const second=panel.logicResult.mock.lastCall[2];expect(second.root).not.toBe(first.root);
  expect(panel.logicResult.mock.lastCall[5]).toBe(false);
  panel.actions.refresh();await vi.waitFor(()=>expect(panel.logicResult).toHaveBeenCalledTimes(3));
  expect(panel.logicResult.mock.lastCall[2].root).toBe(second.root);
  expect(panel.logicResult.mock.lastCall[5]).toBe(true);
  source=source.replace("i<2","i<1");controller.invalidate();panel.actions.refresh();
  await vi.waitFor(()=>expect(panel.hint).toHaveBeenLastCalledWith("当前生成对象已不在有效展开范围，请重新右键追踪。"));
  expect(panel.logicResult).toHaveBeenCalledTimes(3);
});

it("同一过程不同块的同名局部对象不能复用前一个追踪结果",async()=>{
  const source="module top(input a,b,output reg y,z); always @* begin begin : left logic tmp; tmp=a; y=tmp; end begin : right logic tmp; tmp=b; z=tmp; end end endmodule";
  const file="D:/test/locals.v",files=new Map([[file,source]]),structures=new Map([[file,scanStructure(source,file)]]),index=new ModuleIndex();index.addStructure([...structures.values()].flat());
  let column=source.indexOf("tmp=a")+1;
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word:"tmp"}),getLanguageId:()=>"verilog",getVersionId:()=>1,getValue:()=>source};
  const controller=createSignalController(document.createElement("div"),{editor:()=>({getModel:()=>model,getPosition:()=>({lineNumber:1,column})}) as any,files:()=>files.keys(),structures:()=>structures,index:()=>index,topName:()=>"top",instancePath:()=>"top",fileContent:()=>source,isOpen:()=>true,close:vi.fn(),navigate:vi.fn(),hint:vi.fn()});
  const panel=fake.panels[0];await controller.analyze();
  expect(panel.result).toHaveBeenCalledTimes(1);
  column=source.indexOf("tmp=b")+1;await controller.analyze();
  expect(panel.result).toHaveBeenCalledTimes(2);
  expect(panel.result.mock.lastCall[5]).toBe(false);
});

it("生成过程的同名局部变量刷新保留所选过程",async()=>{
  const source="module top(input a,output reg [1:0] y); for(genvar i=0;i<2;i++) begin:lanes always @* begin logic tmp; tmp=a; y[i]=tmp; end end endmodule";
  const file="D:/test/generated_process.v",files=new Map([[file,source]]),structures=new Map([[file,scanStructure(source,file)]]),index=new ModuleIndex();index.addStructure([...structures.values()].flat());
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word:"tmp"}),getLanguageId:()=>"verilog",getVersionId:()=>1,getValue:()=>source};
  const controller=createSignalController(document.createElement("div"),{editor:()=>({getModel:()=>model,getPosition:()=>({lineNumber:1,column:source.indexOf("tmp=a")+1})}) as any,files:()=>files.keys(),structures:()=>structures,index:()=>index,topName:()=>"top",instancePath:()=>"top",fileContent:()=>source,isOpen:()=>true,close:vi.fn(),navigate:vi.fn(),hint:vi.fn()});
  const panel=fake.panels[0];await controller.analyze();
  expect(panel.setContexts.mock.lastCall[2]).toEqual(["top/lanes[0].tmp","top/lanes[1].tmp"]);
  panel.actions.context(1);await vi.waitFor(()=>expect(panel.result).toHaveBeenCalledTimes(2));
  expect(panel.result.mock.lastCall[1].scope).toBe(1);
  panel.actions.refresh();await vi.waitFor(()=>expect(panel.result).toHaveBeenCalledTimes(3));
  expect(panel.result.mock.lastCall[1].scope).toBe(1);expect(panel.result.mock.lastCall[5]).toBe(true);
});

it("自定义数组类型提供定义提示，追踪实际 ROM 仍进入信号分析",async()=>{
  const source=`entity t is end t;
architecture rtl of t is
type rom_type is array (0 to 1) of bit;
signal ROM: rom_type := ('0', '1');
signal q:bit;
begin q <= ROM(0); end rtl;`;
  const file="D:/test/rom.vhd",files=new Map([[file,source]]),structures=new Map([[file,scanStructure(source,file)]]),index=new ModuleIndex();index.addStructure([...structures.values()].flat());
  let word="rom_type";
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word}),getLanguageId:()=>"vhdl",getVersionId:()=>1,getValue:()=>source};
  const controller=createSignalController(document.createElement("div"),{editor:()=>({getModel:()=>model,getPosition:()=>({lineNumber:4,column:source.split("\n")[3].indexOf(word)+1})}) as any,files:()=>files.keys(),structures:()=>structures,index:()=>index,topName:()=>"t",instancePath:()=>"t",fileContent:()=>source,isOpen:()=>true,close:vi.fn(),navigate:vi.fn(),hint:vi.fn()});
  const panel=fake.panels[0];await controller.analyze();
  expect(panel.objectHint).toHaveBeenCalledWith("rom_type","数组类型",{file,line:3});
  expect(panel.logicResult).not.toHaveBeenCalled();
  word="ROM";await controller.analyze();expect(panel.logicResult).toHaveBeenCalledTimes(1);
});

function setup(scanned = true) {
  let source = "module top(input a, output q); wire mid; assign mid = a; assign q = mid; endmodule";
  let word = "mid", version = 1;
  const file = "D:/test/100%.v", contents = new Map([[file, source]]), structures = new Map([[file, scanStructure(source, file)]]);
  const index = new ModuleIndex(); index.addStructure([...structures.values()].flat());
  const model = { uri: { path: `/${file}`, authority: "" }, getWordAtPosition: () => ({ word }), getLanguageId: () => "verilog", getVersionId: () => version, getValue: () => source };
  const editor = { getModel: () => model, getPosition: () => ({ lineNumber: 1, column: source.indexOf(`assign ${word}`) + 8 }) };
  const controller = createSignalController(document.createElement("div"), {
    editor: () => editor as any, files: () => (scanned ? contents : new Map<string, string>()).keys(), structures: () => structures, index: () => index,
    topName: () => "top", instancePath: () => undefined, fileContent: () => source, isOpen: () => true,
    close: vi.fn(), navigate: vi.fn(), hint: vi.fn(),
  });
  return { controller, panel: fake.panels[0], setWord: (s: string) => { word = s; }, edit: () => { version++; source = source.replace("mid = a", "mid = ~a"); } };
}

it("修改源码只标旧结果，刷新仍分析原目标，切换工程清理分析状态", async () => {
  const { controller, panel, setWord, edit } = setup();
  await controller.analyze(); expect(panel.logicResult).toHaveBeenCalledWith("mid", expect.anything(), expect.anything(), expect.anything(), "", false);
  setWord("a"); edit(); controller.invalidate();
  expect(panel.markStale).toHaveBeenCalledTimes(1); expect(panel.logicResult).toHaveBeenCalledTimes(1);
  panel.actions.refresh(); await vi.waitFor(() => expect(panel.logicResult).toHaveBeenCalledTimes(2));
  expect(panel.logicResult.mock.lastCall[0]).toBe("mid");
  expect(panel.logicResult.mock.lastCall[5]).toBe(true);
  controller.reset(); panel.actions.refresh();
  expect(panel.logicResult).toHaveBeenCalledTimes(2); expect(panel.setContexts).toHaveBeenLastCalledWith([], 0);
});

it("同目标刷新保留卡片宽度，换信号或工程恢复默认", async () => {
  const {controller,panel,setWord}=setup();await controller.analyze();
  expect(panel.logicResult.mock.lastCall[5]).toBe(false);
  panel.actions.refresh();await vi.waitFor(()=>expect(panel.logicResult).toHaveBeenCalledTimes(2));
  expect(panel.logicResult.mock.lastCall[5]).toBe(true);
  setWord("q");await controller.analyze();expect(panel.result.mock.lastCall[5]).toBe(false);
  panel.actions.refresh();await vi.waitFor(()=>expect(panel.result).toHaveBeenCalledTimes(2));
  expect(panel.result.mock.lastCall[5]).toBe(true);
  controller.reset();await controller.analyze();expect(panel.result.mock.lastCall[5]).toBe(false);
});

it("异步端口追踪在换工程后不提交旧结果，控制器仍能再次使用", async () => {
  const { controller, panel, setWord } = setup(); setWord("q");
  const pending = controller.analyze(); controller.reset(); await pending;
  expect(panel.result).not.toHaveBeenCalled();
  await controller.analyze(); expect(panel.result).toHaveBeenCalledTimes(1);
});

it("单独打开的工程外文件刷新也使用原目标缓冲区", async () => {
  const { controller, panel, edit, setWord } = setup(false);
  await controller.analyze();
  edit(); setWord("a"); controller.invalidate();
  panel.actions.refresh(); await vi.waitFor(() => expect(panel.logicResult).toHaveBeenCalledTimes(2));
  expect(panel.logicResult.mock.lastCall[0]).toBe("mid");
});

function hierarchySetup() {
  const source = `module top(input a,output z); leaf u(.i(a),.o(z)); endmodule
module leaf(input i,output o); wire inner=~i; assign o=inner; endmodule`;
  const file="D:/test/hierarchy.v",contents=new Map([[file,source]]),structures=new Map([[file,scanStructure(source,file)]]);
  const index=new ModuleIndex();index.addStructure([...structures.values()].flat());
  let word="inner";
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word}),getLanguageId:()=>"verilog",getVersionId:()=>1,getValue:()=>source};
  const editor={getModel:()=>model,getPosition:()=>({lineNumber:2,column:source.split("\n")[1].search(new RegExp(`\\b${word}\\b`))+1})};
  const controller=createSignalController(document.createElement("div"),{
    editor:()=>editor as any,files:()=>contents.keys(),structures:()=>structures,index:()=>index,
    topName:()=>"top",instancePath:()=>"top/u",fileContent:()=>source,isOpen:()=>true,
    close:vi.fn(),navigate:vi.fn(),hint:vi.fn(),
  });
  return {controller,panel:fake.panels[0],setWord:(s:string)=>{word=s;}};
}

it("内部信号只分析所在模块，端口才跨到父模块接口",async()=>{
  const {controller,panel,setWord}=hierarchySetup();
  await controller.analyze();
  const graph=panel.logicResult.mock.lastCall[2];
  expect(graph.nodes.every((n:any)=>n.path==="top/u")).toBe(true);
  expect(graph.nodes.map((n:any)=>n.label)).toEqual(expect.arrayContaining(["i","inner","o"]));
  expect(graph.nodes.some((n:any)=>n.label==="a"||n.label==="z")).toBe(false);
  setWord("o");await controller.analyze();
  expect(panel.result).toHaveBeenCalledTimes(1);expect(panel.logicResult).toHaveBeenCalledTimes(1);
  expect(panel.result.mock.lastCall[4]).toBe("端口连接");
  expect(JSON.stringify(panel.result.mock.lastCall[2])).toContain("top.z");
});

it("重复追踪同一端口保持端口模式，不切换到完整模块内分析",async()=>{
  const {controller,panel,setWord}=hierarchySetup();setWord("o");await controller.analyze();
  const assignment=panel.result.mock.lastCall[1].children.find((n:any)=>n.reason==="赋值位置");
  expect(assignment.statement).toBe("assign o=inner;");
  expect(assignment.children).toHaveLength(0);
  expect(panel.actions.enter).toBeUndefined();
  await controller.analyze();
  expect(panel.result).toHaveBeenCalledTimes(1);
  expect(panel.logicResult).not.toHaveBeenCalled();
});

it("同名信号换实例路径时清空宽度，当前实例刷新保留",async()=>{
  const source="module top(input a); leaf u1(.i(a)); leaf u2(.i(a)); endmodule\nmodule leaf(input i); wire inner=~i; endmodule";
  const file="D:/test/instances.v",contents=new Map([[file,source]]),structures=new Map([[file,scanStructure(source,file)]]),index=new ModuleIndex();index.addStructure([...structures.values()].flat());
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word:"inner"}),getLanguageId:()=>"verilog",getVersionId:()=>1,getValue:()=>source};
  const editor={getModel:()=>model,getPosition:()=>({lineNumber:2,column:source.split("\n")[1].indexOf("inner")+1})};
  const controller=createSignalController(document.createElement("div"),{editor:()=>editor as any,files:()=>contents.keys(),structures:()=>structures,index:()=>index,topName:()=>"top",instancePath:()=>"top/u1",fileContent:()=>source,isOpen:()=>true,close:vi.fn(),navigate:vi.fn(),hint:vi.fn()});
  const panel=fake.panels[0];await controller.analyze();expect(panel.logicResult.mock.lastCall[1].path).toBe("top/u1");
  panel.actions.context(1);await vi.waitFor(()=>expect(panel.logicResult).toHaveBeenCalledTimes(2));expect(panel.logicResult.mock.lastCall[1].path).toBe("top/u2");expect(panel.logicResult.mock.lastCall[5]).toBe(false);
  panel.actions.refresh();await vi.waitFor(()=>expect(panel.logicResult).toHaveBeenCalledTimes(3));expect(panel.logicResult.mock.lastCall[5]).toBe(true);
});

it("同名 VHDL 局部对象换过程重置宽度，同一作用域刷新保留",async()=>{
  const source="entity top is port(a,b: in bit; y,z: out bit); end top;\narchitecture rtl of top is begin\np1: process(a) variable tmp: bit; begin tmp := a; y <= tmp; end process;\np2: process(b) variable tmp: bit; begin tmp := b; z <= tmp; end process;\nend rtl;";
  const file="D:/test/scoped.vhd",contents=new Map([[file,source]]),structures=new Map([[file,scanStructure(source,file)]]),index=new ModuleIndex();index.addStructure([...structures.values()].flat());
  let line=3;
  const model={uri:{path:`/${file}`,authority:""},getWordAtPosition:()=>({word:"TMP"}),getLanguageId:()=>"vhdl",getVersionId:()=>1,getValue:()=>source};
  const editor={getModel:()=>model,getPosition:()=>({lineNumber:line,column:source.split("\n")[line-1].indexOf("tmp :=")+1})};
  const controller=createSignalController(document.createElement("div"),{editor:()=>editor as any,files:()=>contents.keys(),structures:()=>structures,index:()=>index,topName:()=>"top",instancePath:()=>undefined,fileContent:()=>source,isOpen:()=>true,close:vi.fn(),navigate:vi.fn(),hint:vi.fn()});
  const panel=fake.panels[0];await controller.analyze();expect(panel.result).toHaveBeenCalledTimes(1);expect(panel.result.mock.lastCall[5]).toBe(false);
  panel.actions.refresh();await vi.waitFor(()=>expect(panel.result).toHaveBeenCalledTimes(2));expect(panel.result.mock.lastCall[5]).toBe(true);
  line=4;await controller.analyze();expect(panel.result).toHaveBeenCalledTimes(3);expect(panel.result.mock.lastCall[5]).toBe(false);
});
