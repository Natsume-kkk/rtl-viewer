import { parseFileDetail, type HdlLang, type ModuleInfo, type ParameterInfo, type PortInfo } from "../parser";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import { analyzeExpression, parseVerilogProcess, parseVhdlProcess } from "../parser/procedural";
import { processRanges } from "../model/signal-flow";

export interface CodeStatistics {
  physicalLines: number;
  codeLines: number;
  commentOnlyLines: number;
  inlineCommentLines: number;
  blankLines: number;
  commentRatio: number;
}

export interface LineFacts {
  line: number;
  length: number;
  firstTabColumn?: number;
  trailingWhitespaceColumn?: number;
}

export interface AssignmentFacts {
  target: string;
  targetText: string;
  operator: string;
  line: number;
  processIndex: number;
  conditions: string[];
  reads: string[];
  expression: string;
}

export interface CaseFacts {
  startLine: number;
  hasDefault: boolean;
  controlConstant: boolean;
  nonconstantLabel: boolean;
  emptyDefault: boolean;
  defaultHasX: boolean;
  labels: string[];
}

export interface SourceSignature {
  kind: "delay" | "defparam" | "caseXZ" | "emptyDefault" | "nullOthers" | "bufferPort" | "declarationInit" | "openMapping" | "multiPortMapping" | "zLiteral" | "xzRelation" | "xzArithmetic" | "conditionXZ" | "absoluteInclude" | "fullCase" | "forbiddenType" | "repeatVariable" | "sensitivityPipe" | "posedge" | "negedge" | "missingWidth" | "whileConstant" | "emptyStatement" | "spacing" | "multiStatement" | "enum" | "forNonconstant" | "forOtherArithmetic" | "forReset" | "zeroLoop" | "recursiveFunction" | "taskTiming" | "functionNonblocking" | "functionGlobalAssign" | "arrayExpression";
  line: number;
  column: number;
  text: string;
}

export interface DeclarationFacts {
  name: string;
  kind: "parameter" | "constant" | "other";
  line: number;
}

export interface ProcessFacts {
  kind: "always" | "process";
  startLine: number;
  endLine: number;
  sequential: boolean;
  combinational: boolean;
  explicitSensitivity: boolean;
  sensitivity: string[];
  hasResetBranch: boolean;
  resets: string[];
  incompleteConditionalAssignment: boolean;
  missingElse: boolean;
  clocks: string[];
  eventCount: number;
  caseCount: number;
  localVariables: string[];
  assignments: AssignmentFacts[];
  issues: string[];
}

export interface DefinitionFacts {
  name: string;
  kind: "module" | "entity" | "architecture";
  line: number;
}

export interface FileFacts {
  file: string;
  language: HdlLang;
  statistics: CodeStatistics;
  lines: LineFacts[];
  eofNewline: boolean;
  firstNonEmptyComment: boolean;
  definitions: DefinitionFacts[];
  declarations: DeclarationFacts[];
  ports: PortInfo[];
  parameters: ParameterInfo[];
  processes: ProcessFacts[];
  cases: CaseFacts[];
  signatures: SourceSignature[];
  positionalInstanceLines: number[];
  concurrentAssignments: AssignmentFacts[];
  instanceReads: string[];
  initialCount: number;
  initialLines: number[];
  multiDeclarationLines: number[];
  functionTaskCount: number;
  caseCount: number;
  loopCount: number;
  generateCount: number;
  instanceCount: number;
  issues: string[];
}

export function analyzeFileFacts(file: string, content: string): FileFacts {
  const language = languageForFile(file);
  const clean = language === "vhdl" ? stripVhdlComments(content) : stripComments(content);
  const starts = lineStarts(content);
  const modules = parseFileDetail(content, file);
  const definitions = modules.flatMap(module => definitionFacts(module));
  const processes: ProcessFacts[] = [];
  const issues: string[] = [];
  let initialCount = 0;
  let functionTaskCount = 0;
  const initialLines: number[] = [];
  const ranges = processRanges(clean, language === "vhdl");
  for (const range of ranges) {
    const text = clean.slice(range.index, range.index + range.text.length);
    const head = text.trimStart();
    if (/^initial\b/.test(head)) {
      initialCount++;
      initialLines.push(lineAt(starts, range.index));
    }
    if (/^(?:function|task|procedure)\b/i.test(head)) functionTaskCount++;
    if (language === "vhdl" ? !/^process\b/i.test(head) : !/^always(?:_ff|_comb|_latch)?\b/.test(head)) continue;
    const parsed = language === "vhdl" ? parseVhdlProcess(text) : parseVerilogProcess(text);
    const startLine = lineAt(starts, range.index);
    const processIndex = processes.length;
    const assignments = parsed.assignments.map(assignment => ({
      target: assignment.target,
      targetText: assignment.targetText ?? assignment.target,
      operator: assignment.operator,
      line: lineAt(starts, range.index + assignment.index),
      processIndex,
      conditions: assignment.conditions,
      reads: [...assignment.reads, ...assignment.blockedReads, ...assignment.selectorReads ?? []],
      expression: assignment.expression,
    }));
    const sensitivity = language === "vhdl"
      ? /^process\s*\(([^)]*)\)/i.exec(head)?.[1].split(",").map(item => item.trim().toLowerCase()).filter(Boolean) ?? []
      : /always[^@]*@\s*\(([^)]*)\)/.exec(head)?.[1].split(/,|\bor\b/).map(item => item.trim()).filter(Boolean) ?? [];
    const sequential = language === "vhdl" ? /rising_edge|falling_edge|'\s*event/i.test(text) : /\b(?:posedge|negedge)\b/.test(head);
    const combinational = !sequential;
    const hasResetBranch = resetBranch(text, language);
    const ifCount = (text.match(/\bif\b/gi) ?? []).length;
    const elseCount = (text.match(/\belse\b/gi) ?? []).length;
    const incompleteConditionalAssignment = combinational && ifCount > elseCount && !assignments.some(assignment => assignment.conditions.length === 0);
    const missingElse = ifCount > elseCount;
    const resets = resetSignals(text, language);
    const clocks = (language === "vhdl"
      ? [...text.matchAll(/(?:rising_edge|falling_edge)\s*\(\s*([A-Za-z_]\w*)|([A-Za-z_]\w*)\s*'\s*event/gi)].map(match => (match[1] ?? match[2]).toLowerCase())
      : [...head.matchAll(/\b(?:posedge|negedge)\s+([A-Za-z_]\w*)/g)].map(match => match[1])).filter(clock => !resets.includes(clock.toLowerCase()));
    const eventCount = language === "vhdl" ? (text.match(/rising_edge|falling_edge|'\s*event/gi) ?? []).length : clocks.length;
    processes.push({
      kind: language === "vhdl" ? "process" : "always",
      startLine,
      endLine: lineAt(starts, range.index + range.text.length),
      sequential,
      combinational,
      explicitSensitivity: language === "vhdl" ? /^process\s*\(/i.test(head) : /@\s*\(/.test(head),
      sensitivity,
      hasResetBranch,
      resets,
      incompleteConditionalAssignment,
      missingElse,
      clocks,
      eventCount,
      caseCount: (text.match(language === "vhdl" ? /\bcase\b[^;]*\bis\b/gi : /\b(?:case|casex|casez)\s*\(/g) ?? []).length,
      localVariables: parsed.locals ?? [],
      assignments,
      issues: parsed.boundaries.map(boundary => boundary.reason),
    });
    issues.push(...parsed.boundaries.map(boundary => `${startLine}: ${boundary.reason}`));
  }
  const caseCount = (clean.match(language === "vhdl" ? /\bcase\b[^;]*\bis\b/gi : /\b(?:case|casex|casez)\s*\(/g) ?? []).length;
  const loopCount = (clean.match(/\b(?:for|foreach|while|repeat|forever)\b/g) ?? []).length;
  const generateCount = (clean.match(/\bgenerate\b/gi) ?? []).length;
  const instanceCount = modules.reduce((count, module) => count + module.instances.length, 0);
  const declarations = declarationFacts(clean, language, starts);
  const constants = new Set([
    ...declarations.filter(item => item.kind !== "other").map(item => item.name),
    ...modules.flatMap(module => (module.parameters ?? []).map(parameter => parameter.name)),
  ]);
  const multiDeclarationLines = multipleDeclarationLines(clean, language, starts);
  const cases = caseFacts(clean, language, starts, constants);
  const signatures = [...sourceSignatures(clean, language, starts), ...absoluteIncludeSignatures(language === "verilog" ? stripComments(content, false) : clean, starts), ...advancedSignatures(clean, starts, language, constants)];
  const positionalInstanceLines = positionalInstances(clean, language, starts);
  const concurrentAssignments = continuousAssignments(clean, language, starts, ranges);
  return {
    file,
    language,
    statistics: codeStatistics(content, language),
    lines: lineFacts(content),
    eofNewline: content.length === 0 || content.endsWith("\n"),
    firstNonEmptyComment: firstNonEmptyIsComment(content, language),
    definitions,
    declarations,
    ports: modules.flatMap(module => module.ports),
    parameters: modules.flatMap(module => module.parameters ?? []),
    processes,
    cases,
    signatures,
    positionalInstanceLines,
    concurrentAssignments,
    instanceReads: modules.flatMap(module => module.instances.flatMap(instance => (instance.connections ?? []).flatMap(connection => connection.expr.match(/[A-Za-z_]\w*/g) ?? []))),
    initialCount,
    initialLines,
    multiDeclarationLines,
    functionTaskCount,
    caseCount,
    loopCount,
    generateCount,
    instanceCount,
    issues,
  };
}

function advancedSignatures(clean: string, starts: number[], language: HdlLang, constants: Set<string>): SourceSignature[] {
  const result: SourceSignature[] = [];
  const add = (kind: SourceSignature["kind"], index: number, text: string) => result.push({ kind, line: lineAt(starts, index), column: 1, text: text.slice(0, 200) });
  for (const match of clean.matchAll(/\bfor\s*\(([^)]*)\)([\s\S]*?)(?=\bfor\b|\bfunction\b|\btask\b|\balways|\binitial|\bendmodule\b|$)/g)) {
    const header = match[1], body = match[2];
    const [initial = "", condition = ""] = header.split(";");
    const loopVariable = /^\s*([A-Za-z_]\w*)\s*=.*/.exec(initial)?.[1];
    if (!constantExpression(initial, constants, language, loopVariable) || !constantExpression(condition, constants, language, loopVariable)) add("forNonconstant", match.index!, header);
    for (const assignment of body.matchAll(/\b([A-Za-z_]\w*)\s*(?:\+\+|--|=(?!=)|\+=|-=|\*=|\/=)/g)) {
      if (assignment[1] === loopVariable) add("forNonconstant", match.index!, assignment[0]);
      else add("forOtherArithmetic", match.index!, assignment[0]);
    }
    if (/rst|reset/i.test(body)) add("forReset", match.index!, body);
    if (/\b\w+\s*=\s*0\s*;\s*\w+\s*<\s*0\b/.test(header)) add("zeroLoop", match.index!, header);
  }
  if (language === "vhdl") {
    for (const match of clean.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;]+?)\s+loop\b([\s\S]*?)\bend\s+loop\b/gi)) {
      if (!constantExpression(match[2], constants, language)) add("forNonconstant", match.index!, match[2]);
      if (new RegExp(`\\b${match[1]}\\s*:=`, "i").test(match[3])) add("forOtherArithmetic", match.index!, match[3]);
      if (/rst|reset/i.test(match[3])) add("forReset", match.index!, match[3]);
    }
  }
  for (const match of clean.matchAll(/\b(function|task)\b([\s\S]*?)\bend\1\b/g)) {
    const kind = match[1], body = match[2], name = /\b([A-Za-z_]\w*)\s*(?:\(|;)/.exec(body)?.[1];
    const locals = new Set(name ? [name] : []);
    for (const declaration of body.matchAll(/\b(?:input|output|inout|reg|integer|logic|bit)\b([^;]+);/g)) {
      for (const segment of declaration[1].split(",")) {
        const local = (segment.replace(/\[[^\]]*\]/g, " ").match(/[A-Za-z_]\w*/g) ?? []).filter(name => !/^(?:input|output|inout|reg|integer|logic|bit|signed|unsigned)$/.test(name)).at(-1);
        if (local) locals.add(local);
      }
    }
    if (kind === "task" && /#\s*\d|@\s*\(/.test(body)) add("taskTiming", match.index!, body);
    if (kind === "function") {
      for (const assignment of body.matchAll(/(?:^|[;)]|\bbegin\b)\s*([A-Za-z_]\w*)(?:\s*\[[^\]]*\])?\s*(<=|=(?!=))/g)) {
        if (assignment[2] === "<=") add("functionNonblocking", match.index!, assignment[0]);
        if (!locals.has(assignment[1])) add("functionGlobalAssign", match.index!, assignment[0]);
      }
      const implementation = body.includes(";") ? body.slice(body.indexOf(";") + 1) : body;
      if (name && new RegExp(`\\b${name}\\s*\\(`).test(implementation)) add("recursiveFunction", match.index!, name);
    }
  }
  for (const match of clean.matchAll(/\b[A-Za-z_]\w*\[[^\]]*[+*/-][^\]]*\]/g)) {
    if (!match[0].includes(":") && !/^(?:wire|reg|logic|bit|signal|variable|input|output|inout|parameter|localparam)\b/.test(match[0])) add("arrayExpression", match.index!, match[0]);
  }
  return result;
}

function constantExpression(text: string, constants: Set<string>, language: HdlLang, loopVariable?: string): boolean {
  const withoutLiterals = text.replace(/\d+\s*'\s*[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_]+/g, " ");
  return (withoutLiterals.match(/[A-Za-z_]\w*/g) ?? []).every(name => {
    if (name === loopVariable || /^(?:clog2|bits|size|len|ceil|floor|pow|min|max|abs|integer|int|to|downto)$/i.test(name)) return true;
    if (language === "vhdl") return [...constants].some(constant => constant.toLowerCase() === name.toLowerCase());
    return constants.has(name);
  });
}

function absoluteIncludeSignatures(content: string, starts: number[]): SourceSignature[] {
  const result: SourceSignature[] = [];
  for (const match of content.matchAll(/\binclude\s+"(?:\/|[A-Za-z]:)[^"]*"/g)) {
    result.push({ kind: "absoluteInclude", line: lineAt(starts, match.index!), column: 1, text: match[0].slice(0, 200) });
  }
  return result;
}

function caseFacts(clean: string, language: HdlLang, starts: number[], constants: Set<string>): CaseFacts[] {
  const result: CaseFacts[] = [];
  const constantNames = new Set(constants);
  if (language === "vhdl") {
    for (const match of clean.matchAll(/\btype\s+[A-Za-z_]\w*\s+is\s*\(([^)]*)\)/gi)) {
      for (const name of match[1].split(",")) constantNames.add(name.trim());
    }
  }
  const pattern = language === "vhdl" ? /\bcase\s+([\s\S]*?)\s+is\b([\s\S]*?)\bend\s+case\b/gi : /\b(?:case|casex|casez)\s*\(([^)]*)\)([\s\S]*?)\bendcase\b/g;
  for (const match of clean.matchAll(pattern)) {
    const control = match[1], body = match[2];
    const labels = language === "vhdl"
      ? [...body.matchAll(/\bwhen\s+([\s\S]*?)=>/gi)].map(label => label[1].trim()).filter(label => !/^others\b/i.test(label)).flatMap(label => label.split("|").map(item => item.trim()))
      : [...body.matchAll(/(?:^|[;\n])\s*([^:;]+?)\s*:/g)].map(label => label[1].trim()).filter(label => !/^default\b/i.test(label) && !/[?<=]/.test(label));
    const defaultText = language === "vhdl" ? /\bwhen\s+others\b([\s\S]*)/i.exec(body)?.[1] ?? "" : /\bdefault\b([\s\S]*)/.exec(body)?.[1] ?? "";
    result.push({
      startLine: lineAt(starts, match.index!),
      hasDefault: language === "vhdl" ? /\bwhen\s+others\b/i.test(body) : /\bdefault\b/.test(body),
      controlConstant: language === "vhdl" ? /^\s*'/.test(control) : /^\s*(?:\d+'|\d)/.test(control),
      nonconstantLabel: labels.some(label => !constantExpression(label, constantNames, language)),
      emptyDefault: language === "vhdl" ? /\bwhen\s+others\s*=>\s*null\b/i.test(body) : /\bdefault\s*:\s*;/.test(body),
      defaultHasX: /'[hdboHDBO]?[0-9a-fA-FxXzZ_]*[xX]/.test(defaultText),
      labels,
    });
  }
  return result;
}

function sourceSignatures(clean: string, language: HdlLang, starts: number[]): SourceSignature[] {
  const result: SourceSignature[] = [];
  let offset = 0;
  for (const line of clean.split("\n")) {
    const lineNumber = lineAt(starts, offset);
    const text = line.trim().slice(0, 200);
    const add = (kind: SourceSignature["kind"], column = 1) => result.push({ kind, line: lineNumber, column, text });
    if (/#\s*\d/.test(line)) add("delay");
    if (/\bdefparam\b/.test(line)) add("defparam");
    if (/\b(?:casex|casez)\b/.test(line)) add("caseXZ");
    if (/\bdefault\s*:\s*;/.test(line)) add("emptyDefault");
    if (/when\s+others\s*=>\s*null\b/i.test(line)) add("nullOthers");
    if (/:\s*buffer\b/i.test(line)) add("bufferPort");
    if (/\b(?:signal|variable)\b[^:]*:[^;]*:=/i.test(line)) add("declarationInit");
    if (/=>\s*open\b/i.test(line)) add("openMapping");
    if ((line.match(/=>/g) ?? []).length >= 2) add("multiPortMapping");
    const xz = language === "vhdl" ? /'\s*[xz?]/i.test(line) : /\b\d*'[hdboHDBO]?[0-9a-fA-FxXzZ_]*[xXzZ]/.test(line);
    if (language === "vhdl" ? /'\s*z/i.test(line) : /\b\d*'[hdboHDBO]?[0-9a-fA-FxXzZ_]*[zZ]/.test(line)) add("zLiteral");
    if (xz && /==|!=/.test(line)) add("xzRelation");
    if (xz && /\b(?:if|elsif|case|casex|casez|when)\b/i.test(line)) add("conditionXZ");
    if (xz && /[+*/-]/.test(line)) add("xzArithmetic");
    if (/\binclude\s+"(?:\/|[A-Za-z]:)/.test(line)) add("absoluteInclude");
    if (/full_case/i.test(line)) add("fullCase");
    if (/\benum\b/i.test(line) || language === "vhdl" && /\btype\s+[A-Za-z_]\w*\s+is\s*\(/i.test(line)) add("enum");
    if (/\b(?:logic|bit|byte|shortint|longint|real|realtime|time|typedef|struct|enum|interface|class)\b/.test(line)) add("forbiddenType");
    if (/\brepeat\s*\(\s*[A-Za-z_]\w*\s*\)/.test(line)) add("repeatVariable");
    if (/\b(?:signal|variable)\b[^:]*:\s*(?:std_logic_vector|std_ulogic_vector)\s*(?:;|:=)/i.test(line)) add("missingWidth");
    if (/\bwhile\s+(?:true|false|\d+)\b/i.test(line)) add("whileConstant");
    if (/\bnull\s*;|\bbegin\s+end\b/i.test(line)) add("emptyStatement");
    if (/\S(?:<=|:=)\S|\s(?:<=|:=)\S|\S(?:<=|:=)\s/.test(line)) add("spacing");
    if ((line.match(/;/g) ?? []).length >= 2 && /<=|:=|=(?!=)/.test(line) && !/\bfor\s*\(/.test(line)) add("multiStatement");
    if (/\balways\b/.test(line) && line.includes("|")) add("sensitivityPipe");
    if (/\bposedge\b|\brising_edge\b/i.test(line)) add("posedge");
    if (/\bnegedge\b|\bfalling_edge\b/i.test(line)) add("negedge");
    offset += line.length + 1;
  }
  return result;
}

function positionalInstances(clean: string, language: HdlLang, starts: number[]): number[] {
  const result: number[] = [];
  const lines = clean.split("\n");
  let offset = 0, block = "", blockLine = 0;
  for (const line of lines) {
    if (!block) {
      const start = language === "vhdl" ? /\bport\s+map\s*\(/i.exec(line) : /^\s*([A-Za-z_]\w*)\s+(?:#\s*\([^;]*?\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(line);
      const excluded = language === "verilog" && /\b(?:module|always|if|case|casex|casez|assign|for|while|function|task|initial|and|or|not|nand|nor|xor|xnor|buf|bufif|notif|pullup|pulldown)\b/.test(line);
      if (start && !excluded) {
        block = line.slice(start.index);
        blockLine = lineAt(starts, offset);
      }
    } else block += line;
    if (block && line.includes(");")) {
      if (language === "vhdl" ? !block.includes("=>") : !/\.\s*[A-Za-z_]\w*\s*\(/.test(block)) result.push(blockLine);
      block = "";
    }
    offset += line.length + 1;
  }
  return result;
}

function continuousAssignments(clean: string, language: HdlLang, starts: number[], ranges: { index: number; text: string }[]): AssignmentFacts[] {
  const result: AssignmentFacts[] = [];
  const pattern = language === "vhdl" ? /^\s*([A-Za-z_]\w*)\s*<=\s*([^;]+);/gm : /\bassign\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
  for (const match of clean.matchAll(pattern)) {
    if (ranges.some(range => match.index! >= range.index && match.index! < range.index + range.text.length)) continue;
    const expression = analyzeExpression(match[2], language === "vhdl");
    result.push({
      target: match[1], targetText: match[1], operator: language === "vhdl" ? "<=" : "=", line: lineAt(starts, match.index!), processIndex: -1, conditions: [], reads: [...expression.reads, ...expression.blockedReads], expression: match[2],
    });
  }
  return result;
}

function declarationFacts(clean: string, language: HdlLang, starts: number[]): DeclarationFacts[] {
  const result: DeclarationFacts[] = [];
  if (language === "vhdl") {
    for (const match of clean.matchAll(/\b(?:signal|variable|constant)\s+([^:]+):/gi)) {
      for (const name of match[1].split(",")) {
        const trimmed = name.trim();
        if (/^[A-Za-z_]\w*$/.test(trimmed)) result.push({ name: trimmed, kind: /^\s*constant\b/i.test(match[0]) ? "constant" : "other", line: lineAt(starts, match.index!) });
      }
    }
  } else {
    for (const match of clean.matchAll(/\b(?:reg|wire|integer|parameter|localparam|input|output|inout|logic|bit)\b([^;]+);/g)) {
      const kind = /^\s*(?:parameter|localparam)\b/.test(match[0]) ? "parameter" : "other";
      for (const segment of match[1].split(",")) {
        const name = (segment.replace(/\[[^\]]*\]/g, " ").replace(/=.*$/s, "").match(/[A-Za-z_]\w*/g) ?? []).filter(name => !/^(?:reg|wire|integer|parameter|localparam|input|output|inout|signed|unsigned|logic|bit)$/.test(name)).at(-1);
        if (name) result.push({ name, kind, line: lineAt(starts, match.index!) });
      }
    }
  }
  return result;
}

function multipleDeclarationLines(clean: string, language: HdlLang, starts: number[]): number[] {
  const lines = clean.split("\n");
  const result: number[] = [];
  let inPort = false;
  let offset = 0;
  for (const line of lines) {
    if (language === "verilog") {
      if (/\b(?:input|output|inout|wire|reg)\b/.test(line) && line.includes(",") && line.includes(";")) result.push(lineAt(starts, offset));
    } else {
      if (!inPort && /\bport\s*\(/i.test(line)) inPort = true;
      if (inPort && (line.match(/;/g) ?? []).length >= 2) result.push(lineAt(starts, offset));
      if (inPort && line.includes(");")) inPort = false;
    }
    offset += line.length + 1;
  }
  return result;
}

function resetSignals(text: string, language: HdlLang): string[] {
  const conditions = resetConditions(text, language);
  return [...new Set(conditions.flatMap(condition => condition.match(/[A-Za-z_]\w*/g) ?? []).filter(isResetIdentifier).map(name => name.toLowerCase()))];
}

function resetBranch(text: string, language: HdlLang): boolean {
  const conditions = language === "vhdl"
    ? [...text.matchAll(/\b(?:if|elsif)\s+([\s\S]*?)\bthen\b/gi)].map(match => match[1])
    : [...text.matchAll(/\bif\s*\(([^)]*)\)/g)].map(match => match[1]);
  return conditions.some(condition => !/rising_edge|falling_edge|'\s*event/i.test(condition) && (condition.match(/[A-Za-z_]\w*/g) ?? []).some(isResetIdentifier));
}

function resetConditions(text: string, language: HdlLang): string[] {
  const conditions = language === "vhdl"
    ? [...text.matchAll(/\b(?:if|elsif)\s+([\s\S]*?)\bthen\b/gi)].map(match => match[1])
    : [...text.matchAll(/\bif\s*\(([^)]*)\)/g)].map(match => match[1]);
  const sensitivity = language === "vhdl" ? /^process\s*\(([^)]*)\)/i.exec(text.trimStart())?.[1] : /always[^@]*@\s*\(([^)]*)\)/.exec(text.trimStart())?.[1];
  if (sensitivity) conditions.push(sensitivity);
  return conditions;
}

function isResetIdentifier(name: string): boolean {
  const lower = name.toLowerCase();
  return /^(?:rst|reset)(?:n|p)?(?:_|$)/.test(lower) || /_(?:rst|reset)(?:n|p)?(?:_|$)/.test(lower) || /^(?:clear|preset)(?:n|p)?$/.test(lower);
}

function definitionFacts(module: ModuleInfo): DefinitionFacts[] {
  const result: DefinitionFacts[] = [];
  if (module.vhdl) {
    if (module.vhdl.entity) result.push({ name: module.name, kind: "entity", line: module.line });
    for (const architecture of module.vhdl.architectures) result.push({ name: architecture, kind: "architecture", line: module.line });
  } else {
    result.push({ name: module.name, kind: "module", line: module.line });
  }
  return result;
}

export function codeStatistics(content: string, language: HdlLang): CodeStatistics {
  if (!content) return { physicalLines: 0, codeLines: 0, commentOnlyLines: 0, inlineCommentLines: 0, blankLines: 0, commentRatio: 0 };
  const rawLines = content.split("\n");
  if (content.endsWith("\n")) rawLines.pop();
  let codeLines = 0, commentOnlyLines = 0, inlineCommentLines = 0, blankLines = 0;
  let blockComment = false, string = false;
  for (const raw of rawLines) {
    let code = false, comment = false;
    for (let index = 0; index < raw.length;) {
      if (blockComment) {
        comment = true;
        if (language === "verilog" && raw[index] === "*" && raw[index + 1] === "/") {
          blockComment = false;
          index += 2;
        } else index++;
        continue;
      }
      if (string) {
        code = true;
        const char = raw[index++];
        if (language === "verilog" && char === "\\") index++;
        else if (char === '"') {
          if (language === "vhdl" && raw[index] === '"') index++;
          else string = false;
        }
        continue;
      }
      if (language === "verilog" && raw[index] === "/" && raw[index + 1] === "/") {
        comment = true;
        break;
      }
      if (language === "vhdl" && raw[index] === "-" && raw[index + 1] === "-") {
        comment = true;
        break;
      }
      if (language === "verilog" && raw[index] === "/" && raw[index + 1] === "*") {
        comment = true;
        blockComment = true;
        index += 2;
        continue;
      }
      if (raw[index] === '"') {
        code = true;
        string = true;
        index++;
        continue;
      }
      if (!/\s/.test(raw[index])) code = true;
      index++;
    }
    if (comment && code) inlineCommentLines++;
    else if (comment) commentOnlyLines++;
    else if (code) codeLines++;
    else blankLines++;
  }
  const commentLines = commentOnlyLines + inlineCommentLines;
  const denominator = codeLines + commentOnlyLines + inlineCommentLines * 2;
  return {
    physicalLines: rawLines.length,
    codeLines: codeLines + inlineCommentLines,
    commentOnlyLines,
    inlineCommentLines,
    blankLines,
    commentRatio: denominator ? commentLines / denominator : 0,
  };
}

function lineFacts(content: string): LineFacts[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.map((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const tab = line.indexOf("\t");
    const trailing = /\s+$/.exec(line);
    return {
      line: index + 1,
      length: line.length,
      firstTabColumn: tab < 0 ? undefined : tab + 1,
      trailingWhitespaceColumn: trailing ? trailing.index + 1 : undefined,
    };
  });
}

function firstNonEmptyIsComment(content: string, language: HdlLang): boolean {
  const first = content.split("\n").find(line => line.trim());
  if (!first) return true;
  const trimmed = first.trim();
  return language === "vhdl" ? trimmed.startsWith("--") : trimmed.startsWith("//") || trimmed.startsWith("/*");
}

function languageForFile(file: string): HdlLang {
  return /\.(?:vhd|vhdl)$/i.test(file) ? "vhdl" : "verilog";
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) if (content[index] === "\n") starts.push(index + 1);
  return starts;
}

function lineAt(starts: number[], position: number): number {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}
