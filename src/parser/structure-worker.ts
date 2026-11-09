import { scanStructure } from "./index";

self.onmessage = (event: MessageEvent<{ id: number; file: string; content: string }>) => {
  const { id, file, content } = event.data;
  try {
    self.postMessage({ id, modules: scanStructure(content, file) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
