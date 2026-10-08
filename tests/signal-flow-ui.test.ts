// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { SignalFlowPanel } from "../src/ui/signal-flow";
import type { TraceNode } from "../src/model/signal-flow";

it("信号链以短实例名归组，过程位置默认折叠且保留完整路径和源码导航", () => {
  const root = document.createElement("aside"), navigate = vi.fn();
  const panel = new SignalFlowPanel(root, { close: vi.fn(), analyze: vi.fn(), context: vi.fn(), navigate });
  const data: TraceNode = { label: "top.clk", children: [{ label: "top/u_rst.i_clk", file: "rst.vhd", line: 1, children: [10, 20, 30].map(line => ({ label: `i_clk · rst.vhd:${line}`, file: "rst.vhd", line, reason: "过程逻辑（不继续推导）", children: [] })) }] };
  panel.result("clk", { label: "top.clk", reason: "顶层输入", children: [] }, data, "");
  const details = root.querySelector("details")!;
  expect(details.open).toBe(false); expect(details.querySelector("summary")?.textContent).toBe("u_rst.i_clk3 处使用");
  expect(root.querySelector(".flow-branch-name")?.getAttribute("title")).toBe("top/u_rst.i_clk");
  expect(root.textContent).not.toContain("过程逻辑（不继续推导）");
  details.open = true;
  root.querySelector<HTMLButtonElement>('button[data-line="20"]')!.click(); expect(navigate).toHaveBeenCalledWith("rst.vhd", 20);
});
