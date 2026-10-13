import type { ModuleIndex } from "../model";
import { buildHierarchy } from "../model/hierarchy";
import { scanStructure, type ModuleInfo } from "../parser";
import { findSignalDeclLine } from "../model/signals";
import { monaco } from "../editor/monaco";
import { pathFromUri } from "../editor/file-path";
import { SignalProject, traceSignal, type SignalContext } from "../model/signal-flow";
import { SignalFlowPanel } from "../ui/signal-flow";
import { ComputationProject } from "../analysis/project";
import { localLogic, loadPortSites, signalMode } from "../analysis/local";
import { sourceEntry } from "../analysis/source-cache";
import { lookupSourceObject } from "../analysis/objects";
import { sameFilePath } from "../file-path";

const IDENT_RE = /^[A-Za-z_]\w*$/;

export interface SignalControllerContext {
  editor(): monaco.editor.IStandaloneCodeEditor;
  files(): IterableIterator<string>;
  structures(): Map<string, ModuleInfo[]>;
  index(): ModuleIndex;
  topName(): string | undefined;
  instancePath(): string | undefined;
  fileContent(file: string): string | undefined;
  isOpen(file: string): boolean;
  close(): void;
  navigate(file: string, line?: number): Promise<void>;
  hint(message: string): void;
}

/** 按需快照、异步追踪与阅读状态；主入口只负责界面装配。 */
export function createSignalController(root: HTMLElement, ctx: SignalControllerContext) {
  let flowRequest = 0;
  let flowReady = false;
  let flowProject: { project: SignalProject; computation: ComputationProject; sources: Map<string,string>; top: string | undefined; files: Set<string> } | undefined;
  const flowTokens = new WeakMap<monaco.editor.ITextModel, { version: number; lines: monaco.Token[][] }>();
  interface FlowSelection { project: SignalProject; computation: ComputationProject; sources: Map<string,string>; signal: string; identity: string; contexts: SignalContext[]; targets: {name:string;scope:number;label:string}[]; note: string; file: string; line: number; column: number; scope: number }
  let flowSelection: FlowSelection | undefined;
  let flowContextPath: string | undefined;
  const flowPanel = new SignalFlowPanel(root, {
    close: () => ctx.close(),
    refresh: () => { if (flowSelection) void analyzeCurrentSignal(flowSelection); },
    context: index => { void runSignalTrace(index); },
    navigate: (file, line) => {
      void ctx.navigate(file, line).catch(error => ctx.hint(`定位失败：${String(error)}`));
    },
  });

  function cancelSignalAnalysis(): void {
    ++flowRequest;
  }

  async function analyzeCurrentSignal(previous?: FlowSelection): Promise<void> {
    cancelSignalAnalysis();
    const ed = ctx.editor(), model = ed.getModel(), position = ed.getPosition();
    let word = previous?.signal ?? (model && position ? model.getWordAtPosition(position)?.word : undefined);
    if (!previous && model && position && word) {
      const language = model.getLanguageId();
      if (language !== "verilog" && language !== "vhdl") word = undefined;
      else {
        let tokens = flowTokens.get(model);
        if (tokens?.version !== model.getVersionId()) {
          tokens = { version: model.getVersionId(), lines: monaco.editor.tokenize(model.getValue(), language) };
          flowTokens.set(model, tokens);
        }
        const token = tokens.lines[position.lineNumber - 1]?.filter(t => t.offset <= position.column - 1).at(-1);
        if (!token || /comment|string|keyword|number|type/.test(token.type)) word = undefined;
      }
    }
    if ((!previous && (!model || !position)) || !word || !IDENT_RE.test(word)) {
      flowPanel.hint(flowSelection ? "光标未落在信号上，保留当前链路。" : "在源码信号上右键，选择“追踪此信号”。");
      return;
    }
    const requestedFile = previous?.file ?? pathFromUri(model!.uri);
    const file = [...ctx.files()].find(path => sameFilePath(path, requestedFile)) ?? requestedFile;
    const line = previous
      ? (previous.scope >= 0 || previous.identity !== previous.signal ? previous.line : findSignalDeclLine(ctx.fileContent(file) ?? "", file, word) ?? previous.line)
      : position!.lineNumber;
    const column = previous?.column ?? position!.column;
    if (!flowProject || !flowProject.files.has(file)) {
      const files = new Map([...ctx.files()].map(path => [path, ctx.fileContent(path) ?? ""]));
      const structures = new Map(ctx.structures());
      for (const [path, source] of files) {
        if (ctx.isOpen(path)) structures.set(path, scanStructure(source, path));
      }
      if (!previous && model) {
        files.set(file, model.getValue());
        structures.set(file, scanStructure(model.getValue(), file));
      }
      if (!files.has(file)) {
        const source = ctx.fileContent(file);
        if (source !== undefined) {
          files.set(file, source);
          structures.set(file, scanStructure(source, file));
        }
      }
      const project = new SignalProject(files, structures);
      flowProject = { project, computation: new ComputationProject(files,project), sources:files, top: buildHierarchy(ctx.index(), structures, ctx.topName()).tops[0]?.moduleName, files: new Set(files.keys()) };
    }
    const { project } = flowProject;
    const owner = project.owner(file, line, column);
    if (!owner) { flowPanel.hint("当前位置不在可识别的 HDL 模块内。"); return; }
    const mod = project.module(owner);
    if (!mod) { flowPanel.hint("在源码信号上右键，选择“追踪此信号”。"); return; }
    if(!previous){
      const entry=sourceEntry(file,flowProject.sources.get(file)??"");
      const object=lookupSourceObject(flowProject.sources,mod,word,{file,offset:entry.lineOffset(line)+column-1});
      if(object?.kind==="type"){
        const declaration=sourceEntry(object.source.file,flowProject.sources.get(object.source.file)??"");
        flowPanel.objectHint(word,object.array?"数组类型":object.record?"记录类型":"类型",{file:object.source.file,line:declaration.lineAt(object.source.start)});
        return;
      }
    }
    const {name:identity,scope} = project.signalIdentity(owner, word, { file, line, column });
    if (!previous && (word === owner || mod?.instances.some(inst => inst.inst === word || inst.module === word))) {
      flowPanel.hint("在源码信号上右键，选择“追踪此信号”。"); return;
    }
    const preferredPath = previous ? flowContextPath : ctx.instancePath();
    const sameSignal = model?.getLanguageId() === "vhdl" ? word.toLowerCase() === flowSelection?.signal.toLowerCase() : word === flowSelection?.signal;
    const top = flowProject.top ?? owner;
    const found = project.contexts(top, owner);
    const moduleContexts = found.items.length ? found.items : [project.root(owner)!].filter(Boolean);
    const choices=moduleContexts.flatMap(context=>project.signalCandidates(context,word,{file,line,column}).map(target=>({context,target})));
    const contexts = choices.map(choice=>choice.context), targets=choices.map(choice=>choice.target);
    if (!contexts.length) { flowPanel.hint("未找到当前模块定义，保留原链路。"); return; }
    const note = found.truncated ? "实例路径列表已截断。" : found.items.length ? "" : "未定位到当前顶层内的实例，仅分析本模块范围。";
    const selection:FlowSelection = { project, computation:flowProject.computation, sources:flowProject.sources, signal: word, identity, contexts, targets, note, file, line, column, scope };
    const matching = contexts.findIndex((c,i) => c.path === preferredPath && (!previous || targets[i].name===previous.identity && (previous.scope<0 || targets[i].scope===previous.scope)));
    if(previous && previous.scope>=0 && (matching<0 || targets[matching].scope!==previous.scope)){
      flowPanel.hint("局部对象所在过程已变化，请重新右键追踪。");return;
    }
    if(previous?.identity.startsWith("__gen_") && matching<0){
      flowPanel.hint("当前生成对象已不在有效展开范围，请重新右键追踪。");return;
    }
    const selected = Math.max(0, matching);
    if (!previous && flowReady && flowSelection?.project === project && sameSignal && targets.some((target,i)=>target.name===flowSelection!.identity&&contexts[i].path===flowContextPath) && flowSelection.file === file && flowSelection.line===line && flowSelection.column===column && (!preferredPath || preferredPath === flowContextPath)) {
      flowPanel.hint(""); return;
    }
    await runSignalTrace(selected, selection);
  }

  async function runSignalTrace(index: number, selection = flowSelection): Promise<void> {
    if (!selection?.contexts[index]) return;
    const request = ++flowRequest;
    flowReady = false;
    flowPanel.hint(`正在分析 ${selection.signal}…`);
    try {
      const context=selection.contexts[index];
      const target=selection.targets[index];
      const active={...selection,identity:target.name,scope:target.scope};
      selection=active;
      const options = { cancelled: () => request !== flowRequest, source: selection, scope: selection.scope };
      const mode=signalMode(selection.project,context,target.name,selection.scope);
      const localProject=mode==="logic"?selection.project.forSource(context.module,selection):selection.project;
      const localComputation=localProject===selection.project?selection.computation:new ComputationProject(selection.sources,localProject);
      const graph=mode==="logic" && selection.scope<0 ? localLogic(localComputation,localProject,context,target.name) : undefined;
      if(graph)await loadPortSites(graph,localProject,options.cancelled);
      if(graph){const root=graph.nodes.find(n=>n.id===graph.root);if(root){const start=sourceEntry(selection.file,selection.sources.get(selection.file)??"").lineOffset(selection.line);root.source={file:selection.file,start,end:start+1};}}
      const up=graph?undefined:await traceSignal(selection.project,context,target.name,"upstream",{...options,stopAtAssignments:mode==="port",localOnly:mode==="logic"});
      if(request!==flowRequest)return;
      const down=graph?undefined:await traceSignal(selection.project,context,target.name,"downstream",{...options,stopAtAssignments:mode==="port",localOnly:mode==="logic"});
      if(request===flowRequest){
        const previousContext=flowSelection?.contexts.find(c=>c.path===flowContextPath);
        const sameName=/\.vhdl?$/i.test(selection.file)?flowSelection?.signal.toLowerCase()===selection.signal.toLowerCase():flowSelection?.signal===selection.signal;
        const preserveWidths=!!flowSelection&&sameName&&flowSelection.identity===selection.identity&&flowSelection.file===selection.file&&flowSelection.scope===selection.scope&&previousContext?.module===context.module&&previousContext.path===context.path;
        flowSelection=selection;flowContextPath=context.path;
        flowPanel.setContexts(selection.contexts,index,selection.targets.map((t,i)=>t.label.includes(".")?`${active.contexts[i].path}/${t.label}`:active.contexts[i].path));
        if(selection.project===flowProject?.project)flowPanel.clearStale();else flowPanel.markStale();
        const note=[selection.note,target.label.includes(".")?`当前生成对象：${target.label}。${selection.targets.filter((_,i)=>active.contexts[i].path===context.path).length>1?"可从实例路径列表切换其他生成对象。":""}`:""].filter(Boolean).join(" ");
        if(graph)flowPanel.logicResult(selection.signal,context,graph,selection.sources,note,preserveWidths);
        else flowPanel.result(selection.signal,up!,down!,note,mode==="port"?"端口连接":"模块内逻辑 · 过程作用域",preserveWidths);
        flowPanel.hint("");flowReady=true;
      }
    } catch (error) {
      if (request === flowRequest) flowPanel.hint(`分析未完成：${String(error)}`);
    }
  }

  function invalidate(): void {
    flowProject = undefined;
    cancelSignalAnalysis();
    flowReady = false;
    if (flowSelection) flowPanel.markStale();
  }

  function reset(): void {
    invalidate();
    flowSelection = undefined;
    flowContextPath = undefined;
    flowPanel.clearStale();
    flowPanel.setContexts([], 0);
    flowPanel.message("");
    flowPanel.hint("在源码信号上右键，选择“追踪此信号”。");
  }

  return { analyze: () => analyzeCurrentSignal(), invalidate, reset };
}
