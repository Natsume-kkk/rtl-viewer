import { ComputationProject, type ComputationGraph, type SourceSpan } from "../../src/analysis/project";
import { SignalProject, type SignalContext } from "../../src/model/signal-flow";
import { setIcon, type IconName } from "../../src/ui/icons";
import { readingSteps, selectBranch, keepReadingPrefix, type ReadingStep } from "./reading";

interface Preset { title: string; path: string; signal: string; files: [string, string][] }
declare const PRESETS: Preset[];
const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag); el.className = cls; el.textContent = text; return el;
};
const button = (label: string, action: () => void, cls = "") => { const b = $("button", cls, label); b.type = "button"; b.onclick = action; return b; };
const icon = (name: IconName) => { const el = $("span", "icon"); setIcon(el, name); return el; };
const option = (label: string, value = label) => { const el = $("option", "", label); el.value = value; return el; };
const base = (file: string) => file.split(/[\\/]/).at(-1)!;
const app = document.getElementById("app")!;
const titlebar = $("header", "titlebar"); titlebar.append(icon("ports"), $("strong", "", "RTL Viewer"), $("span", "muted", "源码工程查看器"), $("span", "preview-label", "嵌入效果预览"));
const toolbar = $("nav", "toolbar"), preset = $("select"); preset.setAttribute("aria-label", "选择样例");
PRESETS.forEach((p, i) => preset.append(option(p.title, String(i))));
const theme = button("切换主题", () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; });
const flowToggle = button("信号链", () => { analysis.hidden = !analysis.hidden; workspace.classList.toggle("flow-closed", analysis.hidden); flowToggle.setAttribute("aria-pressed", String(!analysis.hidden)); });
flowToggle.prepend(icon("ports")); flowToggle.setAttribute("aria-pressed", "true");
toolbar.append(icon("folder"), preset, $("span", "toolbar-spacer"), theme, flowToggle);
const shell = $("main", "shell"), sidebar = $("aside", "sidebar"), hierarchy = $("div", "hierarchy"), outline = $("div", "outline");
sidebar.append($("div", "panel-caption", "工程层级"), hierarchy, $("div", "panel-caption", "当前模块信号"), outline);
const workspace = $("div", "workspace"), sourcePanel = $("section", "source-panel"), tabs = $("div", "file-tabs"), location = $("div", "source-location");
const sourceCode = $("div", "source-code"), editor = $("textarea"); editor.hidden = true; editor.spellcheck = false; editor.setAttribute("aria-label", "编辑当前源码");
const edit = button("编辑", () => { editing = true; editor.value = files.get(currentFile) ?? ""; editor.hidden = false; sourceCode.hidden = true; edit.hidden = true; apply.hidden = false; editor.focus(); });
const apply = button("重新解析", () => { files.set(currentFile, editor.value); editing = false; editor.hidden = true; sourceCode.hidden = false; edit.hidden = false; apply.hidden = true; rebuild(); choices.clear(); history = []; render(); }); apply.hidden = true;
location.append($("span", "file-location"), edit, apply); sourcePanel.append(tabs, location, sourceCode, editor);
const analysis = $("section", "analysis"), separator = $("div", "resize-handle"); separator.tabIndex = 0; separator.setAttribute("role", "separator"); separator.setAttribute("aria-label", "调整信号链高度"); separator.setAttribute("aria-orientation", "horizontal");
const flowHead = $("div", "flow-head"), target = $("code", "target"), back = button("返回", goBack), reset = button("重选路径", () => { choices.clear(); steps = readingSteps(graph, choices); draw(); });
const settings = $("details", "settings"), pathInput = $("input"), signalSelect = $("select"), depth = $("select");
pathInput.setAttribute("aria-label", "实例路径"); signalSelect.setAttribute("aria-label", "目标信号"); depth.setAttribute("aria-label", "展开层数");
[0,1,2,3,5].forEach(n => depth.append(option(`${n + 1} 层`, String(n)))); depth.value = "3";
settings.append($("summary", "", "追踪设置"), pathInput, signalSelect, depth);
flowHead.append($("strong", "", "信号链"), target, back, reset, settings);
const viewport = $("div", "path-viewport"), canvas = $("div", "path-canvas"), flowFoot = $("div", "flow-foot"), downstream = $("div", "downstream"); viewport.append(canvas);
flowFoot.append($("span", "legend", "实线：数据依赖　虚线：已读路径"), downstream);
analysis.append(separator, flowHead, viewport, flowFoot); workspace.append(sourcePanel, analysis); shell.append(sidebar, workspace);
const status = $("footer", "status", "静态路径 · 非仿真"); app.append(titlebar, toolbar, shell, status);
let files: Map<string,string>, project: ComputationProject, index: SignalProject, graph: ComputationGraph;
let path = "", signal = "", currentFile = "", editing = false;
let choices = new Map<string,number>(), steps: ReadingStep[] = [];
let history: {path:string;signal:string;choices:Map<string,number>;steps:ReadingStep[];depth:string}[] = [];
const expanded = new Set<string>();
const signalNames = (p: string) => project.signals(p).filter(n => !/^(input|output|inout|wire|reg|logic|signal|begin|end)$/i.test(n));
function rebuild() { project = new ComputationProject(files); index = new SignalProject(files); }
function start() {
  const p = PRESETS[Number(preset.value)]; files = new Map(p.files); rebuild();
  path = p.path; signal = p.signal; currentFile = p.files[0][0]; choices.clear(); history = []; expanded.clear(); expanded.add(path.split("/")[0]);
  editing = false; editor.hidden = true; sourceCode.hidden = false; edit.hidden = false; apply.hidden = true; analysis.hidden = false; workspace.classList.remove("flow-closed"); flowToggle.setAttribute("aria-pressed", "true"); render();
}
function navigate(p: string, s: string, retain = false) {
  if (editing) { status.textContent = "请先重新解析当前编辑内容。"; return; }
  history.push({path,signal,choices:new Map(choices),steps,depth:depth.value});
  path = p; signal = s; if (!retain) choices.clear(); render();
}
function goBack() {
  if (editing) return;
  const old = history.pop(); if (!old) return;
  path = old.path; signal = old.signal; choices = old.choices; depth.value = old.depth; render(old.steps);
}
function render(restored?: ReadingStep[]) {
  try {
    const names = signalNames(path); if (!names.includes(signal)) signal = names[0] ?? signal;
    graph = project.trace(path,signal,Number(depth.value)); steps = restored ?? readingSteps(graph,choices);
    signalSelect.replaceChildren(...names.map(n => option(n))); signalSelect.value = signal; pathInput.value = path;
    back.disabled = !history.length; status.textContent = "静态路径 · 非仿真";
    draw(); renderTree();
    const root = graph.nodes.find(n => n.id === graph.root);
    showSource(root?.source, true);
  } catch (e) { status.textContent = `分析未完成：${(e as Error).message}`; }
}
function renderTree() {
  hierarchy.replaceChildren();
  const root = index.root(path.split("/")[0]);
  function row(ctx: SignalContext, level: number) {
    const mod = index.module(ctx.module), holder = $("div", "tree-row"); holder.style.paddingLeft = `${10 + level * 14}px`;
    const toggle = button("", () => { expanded.has(ctx.path) ? expanded.delete(ctx.path) : expanded.add(ctx.path); renderTree(); }, "tree-toggle"); toggle.append(icon(expanded.has(ctx.path) ? "chevron-down" : "chevron-right")); toggle.setAttribute("aria-label", `展开 ${ctx.path}`); toggle.disabled = !mod?.instances.length;
    const name = button(ctx.path.split("/").at(-1)!, () => navigate(ctx.path, signal), "tree-name"); name.prepend(icon("module")); name.title = `${ctx.path} · ${ctx.module}`; name.setAttribute("aria-current", String(ctx.path === path)); holder.append(toggle,name); hierarchy.append(holder);
    if (expanded.has(ctx.path) && level < 16) for (const inst of mod?.instances ?? []) row(index.child(ctx,inst),level+1);
  }
  if(root) row(root,0);
  outline.replaceChildren(...signalNames(path).map(name => { const b=button(name,()=>navigate(path,name),"outline-row"); b.prepend(icon("ports")); b.setAttribute("aria-current",String(name===signal)); return b; }));
}
function showSource(span?: SourceSpan, focus = false, sourcePath = path) {
  if (editing) return;
  if (span && files.has(span.file)) currentFile = span.file;
  tabs.replaceChildren(...[...files.keys()].map(file => { const b = button(base(file), () => {
    if (editing) { status.textContent = "请先重新解析当前编辑内容。"; return; }
    currentFile = file;
    const ctx = project.context(sourcePath);
    const nextPath = ctx && index.module(ctx.module)?.file === file ? sourcePath : project.tops.find(name => index.module(name)?.file === file) ?? sourcePath;
    showSource(undefined,false,nextPath);
  }, "file-tab"); b.prepend(icon("module")); b.setAttribute("aria-selected", String(file === currentFile)); return b; }));
  location.querySelector(".file-location")!.textContent = currentFile;
  const text = files.get(currentFile) ?? ""; sourceCode.replaceChildren();
  const names = new Set(signalNames(sourcePath)); let offset = 0, first: HTMLElement | undefined;
  const vhdl = /\.vhdl?$/i.test(currentFile), keywords = /^(module|endmodule|input|output|inout|wire|reg|logic|assign|always|begin|end|if|else|posedge|negedge|entity|is|port|architecture|of|signal|process|then|elsif|when|library|use|downto|to|and|or|not)$/i;
  text.split("\n").forEach((line, i) => {
    const row = $("div", "code-row"), code = $("code"); row.append($("span", "line-number", String(i+1)),code);
    const comment = vhdl ? line.indexOf("--") : line.indexOf("//");
    const tokens = line.match(/\d*'[sS]?[bBoOdDhH][\da-fA-F_xXzZ?]+|'[^']*'|"[^"]*"|[a-zA-Z_$][\w$]*|\d+|[^\w]/g) ?? [];
    let column = 0;
    for (const token of tokens) {
      const commentToken = comment >= 0 && column >= comment, name = vhdl ? token.toLowerCase() : token;
      if (!commentToken && names.has(name)) {
        const link = button(token, () => navigate(sourcePath,name), `source-signal${sourcePath===path && name===signal ? " target-signal" : ""}`); link.setAttribute("aria-label", `追踪 ${name}，第 ${i+1} 行`); code.append(link);
      } else code.append($("span", commentToken ? "syntax-comment" : keywords.test(token) ? "syntax-keyword" : /^(\d|')/.test(token) ? "syntax-number" : "", token));
      column += token.length;
    }
    if (span && span.file === currentFile && offset < span.end && offset + line.length >= span.start) { row.classList.add("highlight"); first ??= row; }
    sourceCode.append(row); offset += line.length + 1;
  });
  if(first && focus) sourceCode.scrollTop = Math.max(0, first.offsetTop - sourceCode.offsetTop - sourceCode.clientHeight/3);
}
function focusStep(step: ReadingStep) {
  if(step.node.source) showSource(step.node.source,true,step.node.path);
  canvas.querySelectorAll<HTMLElement>(".operation").forEach(el=>el.classList.toggle("focused",el.dataset.node===step.node.id));
}
function choose(key: string, value: number) {
  selectBranch(choices,key,value);
  steps = keepReadingPrefix(steps,readingSteps(graph,choices),key);
  const scroll = viewport.scrollLeft; draw(); viewport.scrollLeft = scroll;
  const step = steps.find(s=>s.branches.some(b=>b.key===key)); if(step) focusStep(step);
  const summary = [...canvas.querySelectorAll<HTMLElement>("summary")].find(el=>el.dataset.key===key); summary?.focus({preventScroll:true});
}
function draw() {
  target.textContent = `${path}.${signal}`; target.title = target.textContent; reset.disabled = !choices.size;
  canvas.replaceChildren();
  const width = 236, gap = 40, left = 24, y = 28;
  canvas.style.width = `${left*2 + steps.length*(width+gap)-gap}px`;
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns,"svg"); svg.setAttribute("class","path-wires"); svg.setAttribute("aria-hidden","true");
  const defs = document.createElementNS(ns,"defs"), marker = document.createElementNS(ns,"marker"); marker.id="data-arrow"; marker.setAttribute("viewBox","0 0 10 10"); marker.setAttribute("refX","9"); marker.setAttribute("refY","5"); marker.setAttribute("markerWidth","6"); marker.setAttribute("markerHeight","6"); marker.setAttribute("orient","auto");
  const tip=document.createElementNS(ns,"path"); tip.setAttribute("d","M0 0 L10 5 L0 10 z"); marker.append(tip); defs.append(marker); svg.append(defs); canvas.append(svg);
  const positions=new Map(steps.map((s,i)=>[s.node.id,left+i*(width+gap)]));
  steps.forEach((step,i)=>{
    const x=positions.get(step.node.id)!;
    for(const [ids,context] of [[step.dependencies,!!step.contextOnly],[step.contextDependencies??[],true]] as const) for(const id of ids) {
      const start=positions.get(id); if(start===undefined)continue;
      const wire=document.createElementNS(ns,"path"), sx=start+width, sy=y+48, ex=x;
      wire.setAttribute("d", x-start>width+gap ? `M${sx},${sy} C${sx+18},${sy} ${sx+18},12 ${sx+32},12 L${ex-25},12 Q${ex-12},12 ${ex-12},${sy-12} L${ex-12},${sy} L${ex},${sy}` : `M${sx},${sy} L${ex},${sy}`);
      wire.setAttribute("class",context?"wire context-wire":"wire"); wire.setAttribute("marker-end","url(#data-arrow)"); wire.dataset.from=id; wire.dataset.to=step.node.id;
      const title=document.createElementNS(ns,"title"); title.textContent=context?"已读路径；当前分支不取用此输入":"数据依赖"; wire.append(title);svg.append(wire);
    }
    const card=$("article",`operation ${step.node.kind}${step.pending?" pending":""}`); card.dataset.node=step.node.id; card.dataset.signal=step.node.signal??step.node.label; card.style.left=`${x}px`; card.style.top=`${y}px`; card.style.width=`${width}px`;
    const head=$("div","operation-head"), name=button(step.node.label,()=>focusStep(step),"operation-name"); name.title=step.node.path; head.append(name);
    if(step.node.source) { const jump=button("",()=>focusStep(step),"source-jump"); jump.append(icon("jump-inst")); jump.setAttribute("aria-label",`定位 ${step.node.label} 源码`); head.append(jump); }
    card.append(head);
    const clock=/时钟：([^；]+)/.exec(step.node.detail)?.[1]; if(clock)card.append($("code","clock",`@ ${clock}`));
    if(step.node.kind==="resolved")card.append($("span","boundary-tag","多驱动"));
    if(step.hold)card.append($("code","clock","Q → Q"));
    for(const branch of step.branches) {
      const picker=$("details","branch-picker"); picker.open=branch.selected===undefined;
      const summary=$("summary"); summary.dataset.key=branch.key;
      summary.append($("code","",branch.selected===undefined?"选择分支":branch.options[branch.selected].context),icon("chevron-down")); picker.append(summary);
      branch.options.forEach((o,j)=>{const b=button("",()=>choose(branch.key,j),"branch-option"); b.setAttribute("aria-pressed",String(j===branch.selected)); b.append($("code","guard",o.guard),$("code","value",o.value));picker.append(b);});card.append(picker);
      if(branch.selected===undefined)break;
    }
    if(!step.pending && step.code!==step.node.label)card.append($("pre","expression",step.code));
    if(step.node.kind==="boundary") {card.append($("span","boundary-tag","分析边界"));card.title=step.node.detail;}
    if(step.node.detail.includes("可继续聚焦展开")&&step.node.signal)card.append(button("继续展开",()=>navigate(step.node.path,step.node.signal!,true),"expand-source"));
    card.onkeydown=e=>{if(e.key==="Escape"){const picker=card.querySelector<HTMLDetailsElement>("details[open]"); if(picker){picker.open=false;picker.querySelector("summary")?.focus();}}};
    card.onclick=e=>{if(!(e.target as HTMLElement).closest("button,summary"))focusStep(step);};
    canvas.append(card);
    if(i===steps.length-1&&step.pending)card.classList.add("frontier");
  });
  downstream.replaceChildren();
  if(!steps.some(s=>s.pending))for(const use of project.loads(path,signal))downstream.append(button(`继续：${use.path===path?use.signal:use.path.split("/").at(-1)+"."+use.signal}`,()=>navigate(use.path,use.signal,true)));
  measure();
}
function measure(){const height=Math.max(210,...[...canvas.querySelectorAll<HTMLElement>(".operation")].map(el=>el.offsetTop+el.offsetHeight+28));canvas.style.height=`${height}px`;const svg=canvas.querySelector("svg");svg?.setAttribute("width",String(canvas.scrollWidth));svg?.setAttribute("height",String(height));}
canvas.addEventListener("toggle",()=>requestAnimationFrame(measure),true);
const clampHeight=(h:number)=>Math.max(200,Math.min(h,workspace.clientHeight-180));
separator.onpointerdown=e=>{separator.setPointerCapture(e.pointerId);const start=e.clientY,height=analysis.clientHeight;separator.onpointermove=move=>workspace.style.setProperty("--flow-height",`${clampHeight(height+start-move.clientY)}px`);};
separator.onpointerup=separator.onpointercancel=()=>{separator.onpointermove=null;};
separator.onkeydown=e=>{if(e.key==="ArrowUp"||e.key==="ArrowDown"){e.preventDefault();workspace.style.setProperty("--flow-height",`${clampHeight(analysis.clientHeight+(e.key==="ArrowUp"?20:-20))}px`);}};
preset.onchange=start; signalSelect.onchange=()=>navigate(path,signalSelect.value); depth.onchange=()=>render();
pathInput.onchange=()=>{if(project.context(pathInput.value.trim()))navigate(pathInput.value.trim(),signal);else{pathInput.value=path;status.textContent="实例路径不存在。";}};
start();
