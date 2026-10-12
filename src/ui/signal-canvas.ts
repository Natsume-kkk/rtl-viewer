import { setIcon } from "./icons";

export const CARD_WIDTH = 236, CARD_STEP = 276, CANVAS_PAD = 24;
const MAX_CARD_WIDTH = 1200;
export type CardWidthState = Record<string, number>;
/** Widths belong to a single trace; hidden and lazily created cards retain their entries. */
export class CardWidths {
  private widths = new Map<string, number>();
  private cards = new Map<string, HTMLElement>();
  private cleanups: (() => void)[] = [];
  constructor(private redraw: () => void) {}
  get(id: string): number { return this.widths.get(id) ?? CARD_WIDTH; }
  capture(): CardWidthState { return Object.fromEntries(this.widths); }
  restore(state: CardWidthState = {}): void {
    this.widths.clear();
    for (const [id, width] of Object.entries(state)) if (Number.isFinite(width)) this.widths.set(id, Math.max(CARD_WIDTH, Math.min(MAX_CARD_WIDTH, Math.round(width))));
    for (const [id, card] of this.cards) this.apply(id, card);
  }
  private apply(id: string, card: HTMLElement): void {
    const width = this.get(id); card.style.width = `${width}px`;
    const handle = card.querySelector<HTMLElement>(":scope > .card-resize");
    handle?.setAttribute("aria-valuenow", String(width)); handle?.setAttribute("aria-valuetext", `${width} 像素`);
  }
  private set(id: string, width: number): void {
    width = Math.max(CARD_WIDTH, Math.min(MAX_CARD_WIDTH, Math.round(width)));
    if (width === this.get(id)) return;
    if (width === CARD_WIDTH) this.widths.delete(id); else this.widths.set(id, width);
    this.apply(id, this.cards.get(id)!); this.redraw();
  }
  add(id: string, card: HTMLElement, label = card.dataset.signal ?? id): void {
    this.cards.set(id, card);
    const handle = element("div", "card-resize"); handle.tabIndex = 0;
    handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `调整 ${label} 卡片宽度`);
    handle.setAttribute("aria-valuemin", String(CARD_WIDTH)); handle.setAttribute("aria-valuemax", String(MAX_CARD_WIDTH));
    handle.title = "拖动调整宽度，双击恢复默认；方向键调整，Home 复位";
    let drag: {pointer: number; x: number; width: number} | undefined;
    const end = () => {
      const pointer = drag?.pointer; drag = undefined; card.classList.remove("card-resizing");
      if (pointer !== undefined && handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    };
    handle.onpointerdown = event => {
      if (event.button !== 0 || drag) return;
      event.preventDefault(); event.stopPropagation(); handle.focus({preventScroll: true});
      drag = {pointer: event.pointerId, x: event.clientX, width: this.get(id)};
      handle.setPointerCapture(event.pointerId); card.classList.add("card-resizing");
    };
    handle.onpointermove = event => { if (drag?.pointer === event.pointerId) this.set(id, drag.width + event.clientX - drag.x); };
    const finish = (event: PointerEvent) => { if (drag?.pointer === event.pointerId) end(); };
    handle.onpointerup = finish; handle.onpointercancel = finish; handle.onlostpointercapture = finish;
    handle.onclick = event => event.stopPropagation();
    handle.ondblclick = event => { event.preventDefault(); event.stopPropagation(); end(); this.set(id, CARD_WIDTH); };
    handle.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); end();
      this.set(id, event.key === "Home" ? CARD_WIDTH : this.get(id) + (event.key === "ArrowRight" ? 24 : -24));
    };
    card.append(handle); this.apply(id, card);
    this.cleanups.push(() => { end(); handle.onpointerdown = handle.onpointermove = handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = null; handle.onclick = handle.ondblclick = handle.onkeydown = null; });
  }
  dispose(): void { for (const cleanup of this.cleanups) cleanup(); this.cleanups = []; }
}
export function columnPositions(widths: Map<number, number>): Map<number, number> {
  const positions = new Map<number, number>();
  const min = Math.min(0, ...widths.keys()), max = Math.max(0, ...widths.keys());
  let x = CANVAS_PAD;
  for (let column = min; column <= max; column++) { positions.set(column, x); x += (widths.get(column) ?? CARD_WIDTH) + CARD_STEP - CARD_WIDTH; }
  return positions;
}
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
export function appendSource(parent: HTMLElement, source: {file?: string; statement?: string; sourceRows?: {text: string; line?: number}[]}, signal: string, redraw: () => void): void {
  const rows = source.sourceRows, vhdl = /\.vhdl?$/i.test(source.file ?? "");
  if (!rows?.length) { if (source.statement) parent.append(signalCode(source.statement, signal, vhdl)); return; }
  const block = element("details", "assignment-block"); block.open = true;
  const summary = element("summary", "assignment-header", rows[0].text);
  const content = element("div", "assignment-body"); block.append(summary, content);
  for (const row of rows.slice(1)) {
    const line = element("div", "assignment-row"); line.append(signalCode(row.text, signal, vhdl));
    if (row.line && source.file) {
      const jump = element("button", "source-jump assignment-source"); jump.type = "button";
      jump.dataset.file = source.file; jump.dataset.line = String(row.line);
      jump.title = `定位赋值：第 ${row.line} 行`; jump.setAttribute("aria-label", jump.title);
      setIcon(jump, "jump-inst"); line.append(jump);
    }
    content.append(line);
  }
  block.addEventListener("toggle", redraw); parent.append(block);
}
export interface CardPosition { x: number; y: number; h: number; w?: number; column?: number }
export interface CardEdge { from: string; to: string; control?: boolean; current?: boolean; vertical?: boolean; both?: boolean; unknown?: boolean; role?: string }
let canvasSerial = 0;
export function makeWires(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("logic-wires"); svg.setAttribute("aria-hidden", "true"); svg.dataset.marker = `signal-arrow-${++canvasSerial}`; return svg;
}
export function drawWires(canvas: HTMLElement, svg: SVGSVGElement, positions: Map<string, CardPosition>, edges: CardEdge[]): void {
  const width = Math.max(100, ...[...positions.values()].map(p => p.x + (p.w ?? CARD_WIDTH) + CANVAS_PAD));
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
      const down = b.y > a.y, x = a.x + (a.w ?? CARD_WIDTH) / 2;
      path.setAttribute("d", `M${x},${down ? a.y + a.h : a.y} L${b.x + (b.w ?? CARD_WIDTH) / 2},${down ? b.y : b.y + b.h}`);
    } else {
      const sx = a.x + (a.w ?? CARD_WIDTH), sy = sourceY.get(edge)!, ex = b.x, ey = targetY.get(edge)!;
      const skips = a.column !== undefined && b.column !== undefined ? b.column > a.column + 1 : b.x - a.x > (a.w ?? CARD_WIDTH) + CARD_STEP - CARD_WIDTH + 1;
      if (skips || b.x <= a.x) {
        // Skip-column and return paths use separate lanes below all visible cards.
        const lane = height - 14 + bypassCount++ * 12;
        path.setAttribute("d", `M${sx},${sy} L${sx + 14},${sy} L${sx + 14},${lane} L${ex - 14},${lane} L${ex - 14},${ey} L${ex},${ey}`);
      } else path.setAttribute("d", sy === ey ? `M${sx},${sy} L${ex},${ey}` : `M${sx},${sy} C${sx + 20},${sy} ${ex - 20},${ey} ${ex},${ey}`);
    }
    if (!edge.unknown) path.setAttribute("marker-end", `url(#${marker.id})`);
    if (edge.both) path.setAttribute("marker-start", `url(#${marker.id})`);
    const title = document.createElementNS(ns, "title"); title.textContent = edge.unknown ? edge.role==="调用参数"?"调用参数，内部语义未展开":"方向待确认" : edge.current ? "读取当前 Q" : edge.role??(edge.control ? "条件引用" : "信号连接"); path.append(title); svg.append(path);
  }
  if (bypassCount) { const routedHeight=height+bypassCount*12;canvas.style.height=`${routedHeight}px`;svg.setAttribute('height',String(routedHeight)); }
}
