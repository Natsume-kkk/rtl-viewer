// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { OutlineView } from "../src/ui/outline";

afterEach(() => { localStorage.clear(); document.body.replaceChildren(); });

it("大纲分隔条支持方向键、Home 和分隔条语义", () => {
  const parent = document.createElement("aside"), root = document.createElement("section");
  root.id = "outline-root"; parent.append(root); document.body.append(parent);
  Object.defineProperty(parent, "clientHeight", { get: () => 625 });
  new OutlineView(root, { onJump: () => {} });
  const resizer = root.querySelector<HTMLElement>(".outline-resizer")!;
  expect(resizer.getAttribute("role")).toBe("separator");
  expect(resizer.tabIndex).toBe(0);
  root.style.height = "200px";
  resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  expect(root.style.height).toBe("224px");
  expect(resizer.getAttribute("aria-valuenow")).toBe("224");
  expect(localStorage.getItem("rtl.outlineHeight")).toBe("224");
  resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  expect(root.style.height).toBe("200px");
  resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
  expect(root.style.height).toBe("200px");
  expect(localStorage.getItem("rtl.outlineHeight")).toBe("200");
});

it("大纲折叠不生成行，展开按批加载并复用未变化行", () => {
  localStorage.setItem("rtl.outlineCollapsed", "1");
  const root = document.createElement("section");
  document.body.append(root);
  const view = new OutlineView(root, { onJump: () => {} });
  const items = Array.from({ length: 500 }, (_, index) => ({ name: `signal_${index}`, kind: "signal" as const, line: index + 1 }));
  view.render(items, "large.sv");
  expect(root.querySelectorAll(".outline-row")).toHaveLength(0);
  root.querySelector<HTMLButtonElement>(".outline-toggle")!.click();
  expect(root.querySelectorAll(".outline-row")).toHaveLength(200);
  const first = root.querySelector(".outline-row")!;
  view.render([{ name: "new_signal", kind: "signal", line: 501 }, ...items], "large.sv");
  expect(root.querySelectorAll(".outline-row")).toHaveLength(200);
  expect(root.querySelectorAll(".outline-row")[1]).toBe(first);
  root.querySelector<HTMLButtonElement>(".outline-load-more")!.click();
  expect(root.querySelectorAll(".outline-row")).toHaveLength(400);
  root.querySelector<HTMLButtonElement>(".outline-toggle")!.click();
  expect(root.querySelectorAll(".outline-row")).toHaveLength(0);
});
