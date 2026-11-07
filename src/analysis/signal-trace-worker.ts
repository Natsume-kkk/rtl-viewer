import { analyzeSignalTrace, type SignalTraceInput } from "./signal-trace";

self.onmessage = async event => {
  const { id, input } = event.data as { id: number; input: SignalTraceInput };
  try {
    const result = await analyzeSignalTrace(input);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
