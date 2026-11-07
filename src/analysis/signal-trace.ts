import type { ModuleInfo } from "../parser";
import { SignalProject, traceSignal, type SignalContext, type TraceNode } from "./signal-flow";
import { ComputationProject } from "./project";
import { loadPortSites, localLogic, type LogicGraph } from "./local";
import { sourceEntry } from "./source-cache";

export interface SignalTraceInput {
  sources: [string, string][];
  structures: [string, ModuleInfo[]][];
  context: SignalContext;
  signal: string;
  scope: number;
  mode: "port" | "logic";
  source: { file: string; line: number; column: number };
}

export interface SignalTraceResult {
  graph?: LogicGraph;
  up?: TraceNode;
  down?: TraceNode;
}

export async function analyzeSignalTrace(input: SignalTraceInput, cancelled: () => boolean = () => false): Promise<SignalTraceResult> {
  const sources = new Map(input.sources);
  const project = new SignalProject(sources, new Map(input.structures));
  const localProject = input.mode === "logic" ? project.forSource(input.context.module, input.source) : project;
  const graph = input.mode === "logic" && input.scope < 0
    ? localLogic(new ComputationProject(sources, localProject), localProject, input.context, input.signal)
    : undefined;
  if (graph) {
    await loadPortSites(graph, localProject, cancelled);
    const root = graph.nodes.find(node => node.id === graph.root);
    if (root) {
      const start = sourceEntry(input.source.file, sources.get(input.source.file) ?? "").lineOffset(input.source.line);
      root.source = { file: input.source.file, start, end: start + 1 };
    }
  }
  const options = { cancelled, source: input.source, scope: input.scope, stopAtAssignments: input.mode === "port", localOnly: input.mode === "logic" };
  const up = graph ? undefined : await traceSignal(project, input.context, input.signal, "upstream", options);
  if (cancelled()) throw new Error("cancelled");
  const down = graph ? undefined : await traceSignal(project, input.context, input.signal, "downstream", options);
  if (cancelled()) throw new Error("cancelled");
  return { graph, up, down };
}
