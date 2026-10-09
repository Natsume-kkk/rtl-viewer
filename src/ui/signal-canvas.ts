import { setIcon } from "./icons";

export const CARD_WIDTH = 236, CARD_STEP = 276, CANVAS_PAD = 24;
export const element = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
};
export function cardHeader(card: HTMLElement, label: string, location?: {file: string; line: number}, tip = ""): void {
  if (card.classList.contains("selected")) {
    card.append(element("span", "signal-current", "当前信号"));
    card.setAttribute("aria-label", `当前信号 ${label}`);
  }
  const head = element("div", "logic-card-head"), name = element("span", "operation-name", label);
  head.append(name); card.append(head); head.title = tip;
  if (location) {
    const jump = element("button", "source-jump"); jump.type = "button";
    jump.dataset.file = location.file; jump.dataset.line = String(location.line);
    jump.setAttribute("aria-label", `定位 ${label} 源码`); jump.title = tip || `定位 ${label} 源码`;
    setIcon(jump, "jump-inst"); head.append(jump);
    head.onclick = event => { if (!(event.target as HTMLElement).closest("button")) jump.click(); };
  }
}
export function signalCode(text: string, signal: string, insensitive = false): HTMLElement {
  const code = element("pre", "logic-expression");
  for (const part of text.split(/([a-zA-Z_$][\w$]*)/)) {
    const match = insensitive ? part.toLowerCase() === signal.toLowerCase() : part === signal;
    code.append(match ? element("mark", "signal-match", part) : document.createTextNode(part));
  }
  return code;
}
export interface CardPosition { x: number; y: number; h: number }
export interface CardEdge { from: string; to: string; control?: boolean; current?: boolean; vertical?: boolean; both?: boolean; unknown?: boolean }
let canvasSerial = 0;
export function makeWires(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("logic-wires"); svg.setAttribute("aria-hidden", "true"); svg.dataset.marker = `signal-arrow-${++canvasSerial}`; return svg;
}
export function drawWires(canvas: HTMLElement, svg: SVGSVGElement, positions: Map<string, CardPosition>, edges: CardEdge[]): void {
  const width = Math.max(100, ...[...positions.values()].map(p => p.x + CARD_WIDTH + CANVAS_PAD));
  const height = Math.max(180, ...[...positions.values()].map(p => p.y + p.h + 28));
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height)); svg.replaceChildren();
  const ns = "http://www.w3.org/2000/svg", defs = document.createElementNS(ns, "defs"), marker = document.createElementNS(ns, "marker");
  marker.id = svg.dataset.marker!; marker.setAttribute("viewBox", "0 0 10 10"); marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6"); marker.setAttribute("markerHeight", "6"); marker.setAttribute("orient", "auto-start-reverse");
  const tip = document.createElementNS(ns, "path"); tip.setAttribute("d", "M0 0 L10 5 L0 10 z"); marker.append(tip); defs.append(marker); svg.append(defs);
  const visible=edges.filter(e=>positions.has(e.from)&&positions.has(e.to));
  const sourceY=new Map<CardEdge,number>(),targetY=new Map<CardEdge,number>();
  // 接点属于信号卡片的上部，不跟随可展开代码区的高度移动。
  const anchor = (p: CardPosition) => Math.min(44, p.h / 2);
  for(const side of ["from","to"] as const){
    const groups=new Map<string,CardEdge[]>(),other=side==="from"?"to":"from";
    for(const e of visible){if(e.vertical)continue;const list=groups.get(e[side])??[];list.push(e);groups.set(e[side],list);}
    for(const[id,list]of groups){
      const p=positions.get(id)!;
      list.sort((a,b)=>{const x=positions.get(a[other])!,y=positions.get(b[other])!;return x.y+anchor(x)-y.y-anchor(y);});
      const center=anchor(p),span=Math.max(0,Math.min(48,p.h-32,2*(center-16)));
      const step=list.length>1?Math.min(24,span/(list.length-1)):0;
      list.forEach((e,i)=>(side==="from"?sourceY:targetY).set(e,p.y+center+(i-(list.length-1)/2)*step));
    }
  }
  let bypassCount = 0;
  for (const edge of visible) {
    const a = positions.get(edge.from), b = positions.get(edge.to); if (!a || !b) continue;
    const path = document.createElementNS(ns, "path");
    path.dataset.from = edge.from; path.dataset.to = edge.to;
    path.setAttribute("class", edge.control || edge.current || edge.unknown ? "logic-wire control" : "logic-wire");
    if (edge.vertical) {
      const down = b.y > a.y, x = a.x + CARD_WIDTH / 2;
      path.setAttribute("d", `M${x},${down ? a.y + a.h : a.y} L${b.x + CARD_WIDTH / 2},${down ? b.y : b.y + b.h}`);
    } else {
      const sx = a.x + CARD_WIDTH, sy = sourceY.get(edge)!, ex = b.x, ey = targetY.get(edge)!;
      if (b.x - a.x > CARD_STEP + 1 || b.x <= a.x) {
        // Skip-column and return paths use separate lanes below all visible cards.
        const lane = height - 14 + bypassCount++ * 12;
        path.setAttribute("d", `M${sx},${sy} L${sx + 14},${sy} L${sx + 14},${lane} L${ex - 14},${lane} L${ex - 14},${ey} L${ex},${ey}`);
      } else path.setAttribute("d", sy === ey ? `M${sx},${sy} L${ex},${ey}` : `M${sx},${sy} C${sx + 20},${sy} ${ex - 20},${ey} ${ex},${ey}`);
    }
    if (!edge.unknown) path.setAttribute("marker-end", `url(#${marker.id})`);
    if (edge.both) path.setAttribute("marker-start", `url(#${marker.id})`);
    const title = document.createElementNS(ns, "title"); title.textContent = edge.unknown ? "方向待确认" : edge.current ? "读取当前 Q" : edge.control ? "条件引用" : "信号连接"; path.append(title); svg.append(path);
  }
  if (bypassCount) { const routedHeight=height+bypassCount*12;canvas.style.height=`${routedHeight}px`;svg.setAttribute('height',String(routedHeight)); }
}
