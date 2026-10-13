/** 双视图只管理几何与可见性，文档归属由工作区决定。 */
export function createEditorLayout() {
  const area = document.getElementById("main-area")!;
  const panes = [1, 2].map(n => document.getElementById(`group-${n}`)!);
  const divider = document.getElementById("group-splitter")!;
  let single: number | null = 0;
  let vertical = false, reversed = false, splitFlex = "";
  let stopDrag = () => {};
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-label", "调整双视图大小");

  function render() {
    area.classList.toggle("stacked", vertical);
    area.classList.toggle("dual-view", single === null);
    panes.forEach((pane, i) => {
      pane.hidden = single !== null && single !== i;
      pane.style.order = String((i === 0) !== reversed ? 0 : 2);
    });
    divider.style.order = "1";
    divider.hidden = single !== null;
    panes[0].style.flex = single === null ? splitFlex : "";
    divider.setAttribute("aria-orientation", vertical ? "horizontal" : "vertical");
  }
  function resize(size: number) {
    const rect = area.getBoundingClientRect();
    const total = vertical ? rect.height : rect.width;
    const min = Math.min(vertical ? 100 : 200, total / 2);
    panes[0].style.flex = `0 0 ${Math.max(min, Math.min(size, total - min))}px`;
    splitFlex = panes[0].style.flex;
  }
  function startDrag(e: MouseEvent) {
    if (single !== null || e.button !== 0) return;
    e.preventDefault(); stopDrag();
    const rect = panes[0].getBoundingClientRect();
    const start = vertical ? e.clientY : e.clientX, size = vertical ? rect.height : rect.width;
    const move = (event: MouseEvent) => resize(size + ((vertical ? event.clientY : event.clientX) - start) * (reversed ? -1 : 1));
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") stopDrag(); };
    document.body.classList.add("resizing");
    stopDrag = () => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stopDrag);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", stopDrag);
      stopDrag = () => {};
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stopDrag);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", stopDrag);
  }
  function keyResize(e: KeyboardEvent) {
    if (single !== null) return;
    if (e.key === "Home") { e.preventDefault(); splitFlex = ""; render(); return; }
    const delta = e.key === (vertical ? "ArrowDown" : "ArrowRight") ? 24 : e.key === (vertical ? "ArrowUp" : "ArrowLeft") ? -24 : 0;
    if (!delta) return;
    e.preventDefault();
    const rect = panes[0].getBoundingClientRect();
    resize((vertical ? rect.height : rect.width) + delta * (reversed ? -1 : 1));
  }
  divider.addEventListener("mousedown", startDrag);
  divider.addEventListener("keydown", keyResize);
  render();
  return {
    get splitVisible() { return single === null; },
    get stacked() { return vertical; },
    show(index: number | null) {
      stopDrag();
      if (single === null) splitFlex = panes[0].style.flex;
      single = index; render();
    },
    orient(stacked: boolean) { stopDrag(); vertical = stacked; splitFlex = ""; render(); },
    swap() { stopDrag(); reversed = !reversed; render(); },
    dispose() { stopDrag(); divider.removeEventListener("mousedown", startDrag); divider.removeEventListener("keydown", keyResize); },
  };
}
