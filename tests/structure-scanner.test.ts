import { afterEach, expect, it, vi } from "vitest";
import { createStructureScanner } from "../src/app/structure-scanner";

afterEach(() => vi.unstubAllGlobals());

it("结构解析在 Worker 完成，销毁时终止并取消等待任务", async () => {
  const terminate = vi.fn();
  const postMessage = vi.fn();
  let listener: (event: MessageEvent) => void = () => undefined;
  vi.stubGlobal("Worker", class {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    constructor() {
      listener = event => this.onmessage?.(event);
    }
    postMessage = postMessage;
    terminate = terminate;
  });
  const scanner = createStructureScanner();
  const result = scanner.scan("a.sv", "module a; endmodule");
  const request = postMessage.mock.calls[0][0];
  listener({ data: { id: request.id, modules: [{ name: "a" }] } } as MessageEvent);
  await expect(result).resolves.toEqual([{ name: "a" }]);
  const cancelled = scanner.scan("b.sv", "module b; endmodule");
  scanner.dispose();
  await expect(cancelled).rejects.toThrow("结构解析已取消");
  expect(terminate).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
