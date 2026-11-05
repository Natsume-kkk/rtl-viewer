import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { BackendSummary, SourceSnapshot, SyntaxCheckOptions, SyntaxCheckResult, SyntaxDiagnostic, SyntaxStub } from "../ipc";

interface NodeCheckRequest {
  requestId: number;
  root: string;
  files: string[];
  top?: string;
  stubs: SyntaxStub[];
  options: SyntaxCheckOptions;
  snapshots?: SourceSnapshot[];
}

export function runNodeSyntaxCheck(request: NodeCheckRequest): SyntaxCheckResult {
  const root = path.resolve(request.root);
  const packagedTools = path.join(path.dirname(fileURLToPath(import.meta.url)), "tools/windows-x64");
  const tools = process.env.RTL_VIEWER_TOOLS ?? (fs.existsSync(packagedTools) ? packagedTools : path.resolve("tools/windows-x64"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-lint-"));
  try {
    const snapshots = prepareSnapshots(request.snapshots ?? [], root, work);
    const files = request.files.map(file => {
      const actual = path.resolve(file);
      if (!actual.startsWith(root + path.sep) || !fs.statSync(actual).isFile()) throw new Error(`文件不在当前工程内：${file}`);
      const kind = /\.(?:v|sv)$/i.test(actual) ? "verilog" : /\.(?:vhd|vhdl)$/i.test(actual) ? "vhdl" : "header";
      return { actual, display: snapshots.overlays.get(actual) ?? actual, kind, library: request.options.vhdlLibraries.find(mapping => path.resolve(mapping.file) === actual)?.library ?? "work" };
    }).filter(file => file.kind !== "header" || /\.(?:vh|svh)$/i.test(file.actual));
    const verilog = files.filter(file => file.kind === "verilog");
    const vhdl = files.filter(file => file.kind === "vhdl");
    const diagnostics: SyntaxDiagnostic[] = [];
    const backends: BackendSummary[] = [];
    const includeDirs = new Set([...files.filter(file => file.kind !== "vhdl").map(file => path.dirname(file.actual)), ...request.options.includeDirs.map(dir => path.resolve(dir))]);
    let checkedFiles = 0;
    if (verilog.length) {
      const version = toolVersion(tools, "verilator");
      const outcome = runVerilator(tools, root, work, verilog, includeDirs, request.stubs, request.options, request.top);
      parseVerilator(outcome.output, root, diagnostics, snapshots.originals);
      backends.push({ name: "verilator", version, files: verilog.length, status: outcome.timedOut ? "timed_out" : "completed" });
      if (!outcome.timedOut) checkedFiles += verilog.length;
      if (outcome.timedOut) diagnostics.push(systemDiagnostic("", "Verilator 检查超过 120 秒，已停止"));
    }
    if (vhdl.length) {
      const version = toolVersion(tools, "ghdl");
      const outcome = runGhdl(tools, root, work, vhdl, request.options);
      parseGhdl(outcome.output, root, diagnostics, snapshots.originals);
      backends.push({ name: "ghdl", version, files: vhdl.length, status: outcome.timedOut ? "timed_out" : "completed" });
      if (!outcome.timedOut) checkedFiles += vhdl.length;
      if (outcome.timedOut) diagnostics.push(systemDiagnostic("", "GHDL 单文件分析超过 60 秒，已停止"));
    }
    diagnostics.sort((a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    if (diagnostics.length > 5000) {
      diagnostics.length = 4999;
      diagnostics.push(systemDiagnostic("", "诊断数量超过 5000，其余结果已省略"));
    }
    return { requestId: request.requestId, diagnostics, checkedFiles, backends, cancelled: false };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function prepareSnapshots(snapshots: SourceSnapshot[], root: string, work: string) {
  const overlays = new Map<string, string>(), originals = new Map<string, string>();
  for (const snapshot of snapshots) {
    const original = path.resolve(snapshot.file);
    if (!original.startsWith(root + path.sep)) throw new Error(`快照文件不在当前工程内：${snapshot.file}`);
    const overlay = path.join(work, "snapshot", path.relative(root, original));
    fs.mkdirSync(path.dirname(overlay), { recursive: true });
    fs.writeFileSync(overlay, snapshot.content, snapshot.encoding === "utf16le" ? "utf16le" : "utf8");
    overlays.set(original, overlay);
    originals.set(overlay, original);
  }
  return { overlays, originals };
}

function runVerilator(tools: string, root: string, work: string, files: { actual: string; display: string }[], includeDirs: Set<string>, stubs: SyntaxStub[], options: SyntaxCheckOptions, top?: string) {
  const directory = path.join(work, "verilator");
  fs.mkdirSync(directory, { recursive: true });
  const response = path.join(directory, "sources.f");
  let content = "--lint-only\n-Wall\n--timing\n--Wno-fatal\n--error-limit 200\n--default-language 1800-2017\n";
  content += `--Mdir "${normalize(path.join(directory, "obj_dir"))}"\n`;
  for (const dir of includeDirs) content += `-I"${normalize(dir)}"\n`;
  for (const define of options.defines) content += `+define+${define}\n`;
  for (const argument of options.verilatorArgs) content += `${argument}\n`;
  if (top) content += `--top-module "${top}"\n`;
  for (const stub of stubs) {
    const target = path.join(directory, "stubs", `${stub.name}.sv`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, stub.source);
    content += `"${normalize(target)}"\n`;
  }
  for (const file of files) content += `"${normalize(file.display)}"\n`;
  fs.writeFileSync(response, content);
  const program = path.join(tools, "verilator", "bin", "verilator_bin.exe");
  return run(program, ["-f", response], root, tools, 120_000);
}

function runGhdl(tools: string, root: string, work: string, files: { actual: string; display: string; library: string }[], options: SyntaxCheckOptions) {
  const ghdlWork = path.join(work, "ghdl");
  fs.mkdirSync(ghdlWork, { recursive: true });
  const ordered = orderVhdl(files);
  const output: string[] = [];
  let timedOut = false;
  for (const file of ordered) {
    const libraryWork = path.join(ghdlWork, file.library);
    fs.mkdirSync(libraryWork, { recursive: true });
    const args = ["-a", "--std=08", "-fsynopsys", `--work=${file.library}`, `--workdir=${normalize(libraryWork)}`];
    for (const library of new Set(ordered.map(item => item.library))) args.push(`-P${normalize(path.join(ghdlWork, library))}`);
    args.push(...options.ghdlArgs, file.display);
    const result = run(path.join(tools, "ghdl", "bin", "ghdl.exe"), args, root, tools, 60_000);
    output.push(result.output);
    if (result.timedOut) {
      timedOut = true;
      break;
    }
  }
  return { output: output.join("\n"), timedOut };
}

function orderVhdl<T extends { actual: string; library: string }>(files: T[]): T[] {
  const definitions = new Map<string, number>();
  const bodies = new Map<string, number>();
  const texts = files.map(file => fs.readFileSync(file.actual, "utf8").toLowerCase());
  texts.forEach((text, index) => {
    for (const match of text.matchAll(/\bpackage\s+(?!body\b)([a-z_]\w*)\s+is\b/g)) definitions.set(`${files[index].library}.${match[1]}`, index);
    for (const match of text.matchAll(/\bpackage\s+body\s+([a-z_]\w*)\s+is\b/g)) bodies.set(`${files[index].library}.${match[1]}`, index);
  });
  const dependencies = files.map(() => new Set<number>());
  for (const [key, body] of bodies) if (definitions.has(key)) dependencies[body].add(definitions.get(key)!);
  texts.forEach((text, index) => {
    for (const [key, provider] of definitions) if (provider !== index && text.includes(key)) dependencies[index].add(provider);
  });
  const emitted = new Set<number>(), ordered: T[] = [];
  while (ordered.length < files.length) {
    let progress = false;
    for (let index = 0; index < files.length; index++) {
      if (emitted.has(index) || [...dependencies[index]].some(dependency => !emitted.has(dependency))) continue;
      emitted.add(index);
      ordered.push(files[index]);
      progress = true;
    }
    if (!progress) for (let index = 0; index < files.length; index++) if (emitted.add(index)) ordered.push(files[index]);
  }
  return ordered;
}

function run(program: string, args: string[], cwd: string, tools: string, timeout: number) {
  const result = spawnSync(program, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: toolEnvironment(tools), encoding: "utf8" });
  return { output: `${result.stderr ?? ""}\n${result.stdout ?? ""}`, timedOut: !!result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" };
}

function toolEnvironment(tools: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.join(tools, "verilator", "bin")};${path.join(tools, "ghdl", "bin")};${process.env.PATH ?? ""}`,
    VERILATOR_ROOT: path.join(tools, "verilator", "share", "verilator"),
    GHDL_PREFIX: path.join(tools, "ghdl", "lib", "ghdl"),
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

function toolVersion(tools: string, tool: "verilator" | "ghdl"): string {
  const program = tool === "verilator" ? path.join(tools, "verilator", "bin", "verilator_bin.exe") : path.join(tools, "ghdl", "bin", "ghdl.exe");
  const result = spawnSync(program, ["--version"], { env: toolEnvironment(tools), encoding: "utf8", timeout: 10_000 });
  return (result.stdout ?? result.stderr ?? "未知版本").split(/\r?\n/)[0].trim() || "未知版本";
}

function parseVerilator(output: string, root: string, diagnostics: SyntaxDiagnostic[], originals: Map<string, string>): void {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const severity = line.startsWith("%Error") ? "error" : line.startsWith("%Warning") ? "warning" : line.startsWith("%Note") ? "info" : "";
    if (!severity) continue;
    const headerEnd = line.indexOf(":");
    if (headerEnd < 0) continue;
    const rule = line.slice(1, headerEnd).split("-")[1] ?? "GENERAL";
    const body = line.slice(headerEnd + 1).trim();
    const location = splitLocation(body);
    diagnostics.push({
      file: location ? originals.get(location.file) ?? reportedPath(root, location.file) : "",
      line: location?.line ?? 1,
      column: location?.column ?? 1,
      severity,
      ruleId: `VERILATOR-${rule}`,
      source: "verilator",
      message: location?.message ?? body,
    });
  }
}

function parseGhdl(output: string, root: string, diagnostics: SyntaxDiagnostic[], originals: Map<string, string>): void {
  for (const raw of output.split(/\r?\n/)) {
    const location = splitLocation(raw.trim());
    if (!location) continue;
    const lower = location.message.toLowerCase();
    diagnostics.push({
      file: originals.get(location.file) ?? reportedPath(root, location.file),
      line: location.line,
      column: location.column,
      severity: lower.startsWith("error") || lower.startsWith("fatal") ? "error" : lower.startsWith("warning") ? "warning" : "info",
      ruleId: "GHDL",
      source: "ghdl",
      message: location.message,
    });
  }
}

function splitLocation(text: string): { file: string; line: number; column: number; message: string } | undefined {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== ":") continue;
    const lineStart = index + 1, lineEnd = text.indexOf(":", lineStart);
    if (lineEnd < 0 || !/^\d+$/.test(text.slice(lineStart, lineEnd))) continue;
    const columnStart = lineEnd + 1, columnEnd = text.indexOf(":", columnStart);
    if (columnEnd < 0 || !/^\d+$/.test(text.slice(columnStart, columnEnd))) continue;
    return { file: text.slice(0, index).trim(), line: Number(text.slice(lineStart, lineEnd)), column: Number(text.slice(columnStart, columnEnd)), message: text.slice(columnEnd + 1).trim() };
  }
}

function reportedPath(root: string, file: string): string {
  return normalize(path.isAbsolute(file) ? file : path.resolve(root, file));
}

function systemDiagnostic(file: string, message: string): SyntaxDiagnostic {
  return { file, line: 1, column: 1, severity: "error", ruleId: "SYNTAX", source: "system", message };
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/");
}

function rank(severity: string): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}
