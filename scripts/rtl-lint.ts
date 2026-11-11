#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNodeSyntaxCheck } from "../src/app/node-syntax";
import { analyzeFileFacts } from "../src/analysis/facts";
import { runGeneralRules } from "../src/analysis/general-rules";
import { runGjb10157Rules, runGjb9765Rules } from "../src/analysis/gjb-rules";
import { runProjectRules } from "../src/analysis/project-rules";
import { ALL_RULE_PREFERENCES, applyRulePreferences } from "../src/analysis/rule-preferences";
import { emptySyntaxCheckOptions, type SyntaxCheckResult, type SyntaxStub } from "../src/ipc";
import { parseFile, parseXci } from "../src/parser";
import { verilogStub, vhdlStub } from "../src/app/syntax-stubs";
import { syntaxReportCsv, syntaxReportHtml } from "../src/app/syntax-report";
import { projectFiles } from "../src/app/project-files";
import { readNodeSource } from "../src/app/node-source";

interface CliOptions {
  root: string;
  paths: string[];
  top?: string;
  defines: string[];
  includeDirs: string[];
  libraries: { library: string; file: string }[];
  verilatorArgs: string[];
  ghdlArgs: string[];
  external: boolean;
  html?: string;
  csv?: string;
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }
  const options = parseArgs(argv);
  const scanned = options.paths.flatMap(collect).sort();
  const files = projectFiles({ hdl: scanned, xci: scanned.filter(file => file.endsWith(".xci")), con: [] }).hdl;
  if (!files.length) {
    console.error("没有找到 HDL 源码文件。");
    return 2;
  }
  const root = path.resolve(options.root);
  const resolvedOptions = syntaxOptions(options);
  const external = options.external ? runNodeSyntaxCheck({
    requestId: 1,
    root,
    files: [...new Set([...files, ...resolvedOptions.vhdlLibraries.map(mapping => mapping.file)])],
    top: options.top,
    ...buildStubs(scanned),
    options: resolvedOptions,
  }) : { requestId: 1, diagnostics: [], checkedFiles: 0, backends: [], cancelled: false };
  const facts = files.map(file => analyzeFileFacts(file, readNodeSource(file)));
  const builtin = facts.flatMap(fact => runGeneralRules(fact, true));
  for (const fact of facts) {
    const diagnostics = fact.language === "verilog" ? runGjb10157Rules(fact) : runGjb9765Rules(fact);
    for (const diagnostic of diagnostics) builtin.push(diagnostic);
  }
  for (const diagnostic of runProjectRules(facts)) builtin.push(diagnostic);
  const diagnostics = applyRulePreferences([...external.diagnostics, ...builtin], ALL_RULE_PREFERENCES);
  const result: SyntaxCheckResult = { ...external, diagnostics };
  for (const diagnostic of diagnostics) {
    console.log(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: [${diagnostic.severity}] ${diagnostic.source} ${diagnostic.ruleId}: ${diagnostic.message}`);
  }
  const codeLines = facts.reduce((sum, fact) => sum + fact.statistics.codeLines, 0);
  const commentNumerator = facts.reduce((sum, fact) => sum + fact.statistics.commentOnlyLines + fact.statistics.inlineCommentLines, 0);
  const commentDenominator = facts.reduce((sum, fact) => sum + fact.statistics.codeLines + fact.statistics.commentOnlyLines + fact.statistics.inlineCommentLines, 0);
  const ratio = commentDenominator ? Math.round(commentNumerator / commentDenominator * 100) : 0;
  console.log(`Summary: ${diagnostics.filter(item => item.severity === "error").length} errors, ${diagnostics.filter(item => item.severity === "warning").length} warnings, ${diagnostics.filter(item => item.severity === "info").length} info across ${files.length} file(s); ${codeLines} code lines; comment ratio ${ratio}%.`);
  if (options.html) {
    fs.mkdirSync(path.dirname(path.resolve(options.html)), { recursive: true });
    fs.writeFileSync(options.html, syntaxReportHtml(root, result, new Date(), { options: resolvedOptions, facts }));
    console.log(`HTML report: ${options.html}`);
  }
  if (options.csv) {
    fs.mkdirSync(path.dirname(path.resolve(options.csv)), { recursive: true });
    fs.writeFileSync(options.csv, syntaxReportCsv(result, { options: resolvedOptions, facts, stale: false }));
    console.log(`CSV report: ${options.csv}`);
  }
  return diagnostics.some(item => item.severity === "error") ? 1 : 0;
}

export function syntaxOptions(options: CliOptions) {
  return {
    ...emptySyntaxCheckOptions,
    top: options.top ?? "",
    defines: options.defines,
    includeDirs: options.includeDirs.map(directory => path.resolve(options.root, directory)),
    vhdlLibraries: options.libraries.map(mapping => ({ ...mapping, file: path.resolve(options.root, mapping.file) })),
    verilatorArgs: options.verilatorArgs,
    ghdlArgs: options.ghdlArgs,
  };
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { root: process.cwd(), paths: [], defines: [], includeDirs: [], libraries: [], verilatorArgs: [], ghdlArgs: [], external: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`${argument} 缺少参数`);
      return argv[++index];
    };
    if (argument === "--root") options.root = next();
    else if (argument === "--top") options.top = next();
    else if (argument === "--define") options.defines.push(next());
    else if (argument === "--include") options.includeDirs.push(next());
    else if (argument === "--library") {
      const [library, ...file] = next().split("=");
      options.libraries.push({ library, file: file.join("=") });
    } else if (argument === "--verilator-arg") options.verilatorArgs.push(next());
    else if (argument === "--ghdl-arg") options.ghdlArgs.push(next());
    else if (argument === "--no-external") options.external = false;
    else if (argument === "--html") options.html = next();
    else if (argument === "--csv") options.csv = next();
    else if (argument.startsWith("-")) throw new Error(`未知参数：${argument}`);
    else options.paths.push(argument);
  }
  if (!options.paths.length) options.paths.push(options.root);
  return options;
}

const GENERATED_DIR_SUFFIXES = [".runs", ".sim", ".cache", ".hw", ".gen", ".ip_user_files"];

export function collect(target: string, depth = 0): string[] {
  if (depth >= 64) throw new Error(`目录超过扫描深度上限：${target}`);
  const absolute = path.resolve(target);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return /\.(?:v|sv|vh|svh|vhd|vhdl|xci)$/i.test(absolute) ? [absolute] : [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "target", "dist", "release"].includes(entry.name) || GENERATED_DIR_SUFFIXES.some(suffix => entry.name.endsWith(suffix)) || entry.isSymbolicLink()) continue;
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...collect(child, depth + 1));
    else if (entry.isFile() && /\.(?:v|sv|vh|svh|vhd|vhdl|xci)$/i.test(entry.name)) files.push(child);
  }
  return files;
}

function buildStubs(files: string[]): { stubs: SyntaxStub[]; vhdlStubs: SyntaxStub[] } {
  const stubs: SyntaxStub[] = [], vhdlStubs: SyntaxStub[] = [];
  for (const file of files.filter(file => file.endsWith(".xci"))) {
    const ip = parseXci(readNodeSource(file), file);
    const base = file.replace(/\.xci$/i, "");
    const dir = path.dirname(file);
    for (const candidate of [`${base}.v`, `${dir}/synth/${ip.name}.v`, `${dir}/sim/${ip.name}.v`, `${base}.veo`]) {
      if (!fs.existsSync(candidate)) continue;
      const modules = parseFile(readNodeSource(candidate), candidate);
      const module = modules.find(item => item.name.toLowerCase() === ip.name.toLowerCase()) ?? modules[0];
      if (module?.ports.length) {
        stubs.push({ name: ip.name, source: verilogStub(ip.name, module.ports, module.parameters ?? []) });
        vhdlStubs.push({ name: ip.name, source: vhdlStub(ip.name, module.ports, module.parameters ?? []) });
      }
      break;
    }
  }
  for (const file of files.filter(file => /\.(?:vhd|vhdl)$/i.test(file))) {
    for (const module of parseFile(readNodeSource(file), file)) {
      stubs.push({ name: module.name, source: verilogStub(module.name, module.ports, module.parameters ?? []) });
    }
  }
  return { stubs, vhdlStubs };
}

function printHelp(): void {
  console.log(`Usage: rtl-lint [options] <file-or-directory> [...]\n\n  --root DIR          工程根目录，默认当前目录\n  --top NAME         顶层模块\n  --define NAME[=V]  添加 Verilog 宏\n  --include DIR      添加 include 目录\n  --library LIB=FILE 添加 VHDL library 映射\n  --verilator-arg X  添加 Verilator 参数\n  --ghdl-arg X       添加 GHDL 参数\n  --no-external      仅运行内置规则\n  --html FILE        导出 HTML 报告\n  --csv FILE         导出 CSV 报告\n\n默认执行全部已实现的自动规则。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
