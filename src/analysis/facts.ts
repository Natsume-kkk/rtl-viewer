import { parseFileDetail, type HdlLang, type ModuleInfo, type ParameterInfo, type PortConnection, type PortInfo } from "../parser";
import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";
import { analyzeExpression, parseVerilogProcess, parseVhdlProcess, processRanges } from "../parser/procedural";

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
  scope?: string;
}

export interface CaseFacts {
  startLine: number;
  scope?: string;
  control: string;
  hasDefault: boolean;
  fullyCovered: boolean;
  controlConstant: boolean;
  nonconstantLabel: boolean;
  emptyDefault: boolean;
  defaultHasX: boolean;
  labels: string[];
  defaultAssignments: { target: string; expression: string }[];
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
  scope?: string;
  defaultValue?: string;
  width?: string;
}

export interface ProcessFacts {
  kind: "always" | "process";
  startLine: number;
  scope?: string;
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

export interface InstanceFacts {
  module: string;
  scope: string;
  line: number;
  connections: PortConnection[];
}

export interface FileFacts {
  file: string;
  language: HdlLang;
  statistics: CodeStatistics;
  commentLines: number[];
  lines: LineFacts[];
  eofNewline: boolean;
  firstNonEmptyComment: boolean;
  definitions: DefinitionFacts[];
  scopes: { name: string; start: number; end: number }[];
  declarations: DeclarationFacts[];
  ports: (PortInfo & { scope?: string })[];
  parameters: (ParameterInfo & { scope?: string })[];
  instances: InstanceFacts[];
  processes: ProcessFacts[];
  cases: CaseFacts[];
  signatures: SourceSignature[];
  positionalInstanceLines: number[];
  concurrentAssignments: AssignmentFacts[];
  instanceReads: string[];
  instanceReadSites: { name: string; line: number; scope?: string }[];
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
  const codeAnalysis = analyzeCodeLines(content, language);
  const modules = parseFileDetail(content, file);
  const scopes = definitionScopes(clean, language);
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
    const incompleteConditionalAssignment = combinational && hasIncompleteConditionalAssignment(assignments);
    const missingElse = combinational && ifCount > elseCount;
    const resets = resetSignals(text, language);
    const clocks = (language === "vhdl"
      ? [...text.matchAll(/(?:rising_edge|falling_edge)\s*\(\s*([A-Za-z_]\w*)|([A-Za-z_]\w*)\s*'\s*event/gi)].map(match => (match[1] ?? match[2]).toLowerCase())
      : [...head.matchAll(/\b(?:posedge|negedge)\s+([A-Za-z_]\w*)/g)].map(match => match[1])).filter(clock => !resets.includes(clock.toLowerCase()));
    const eventCount = language === "vhdl" ? (text.match(/rising_edge|falling_edge|'\s*event/gi) ?? []).length : clocks.length;
    processes.push({
      kind: language === "vhdl" ? "process" : "always",
      startLine,
      scope: scopeAtOffset(scopes, range.index),
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
  const declarations = declarationFacts(clean, language, starts, scopes);
  const constants = new Set([
    ...declarations.filter(item => item.kind !== "other").map(item => item.name),
    ...modules.flatMap(module => (module.parameters ?? []).map(parameter => parameter.name)),
  ]);
  const multiDeclarationLines = multipleDeclarationLines(clean, language, starts);
  const cases = caseFacts(clean, language, starts, constants, scopes);
  const signatures = [...sourceSignatures(clean, language, starts), ...absoluteIncludeSignatures(language === "verilog" ? stripComments(content, false) : clean, starts), ...advancedSignatures(clean, starts, language, constants)];
  const positionalInstanceLines = positionalInstances(clean, language, starts);
  const concurrentAssignments = continuousAssignments(clean, language, starts, ranges, scopes);
  return {
    file,
    language,
    statistics: codeAnalysis.statistics,
    commentLines: codeAnalysis.commentLines,
    lines: lineFacts(content),
    eofNewline: content.length === 0 || content.endsWith("\n"),
    firstNonEmptyComment: firstNonEmptyIsComment(content, language),
    definitions,
    scopes,
    declarations,
    ports: modules.flatMap(module => module.ports.map(port => ({ ...port, scope: module.name }))),
    parameters: modules.flatMap(module => (module.parameters ?? []).map(parameter => ({ ...parameter, scope: module.name }))),
    instances: modules.flatMap(module => module.instances.map(instance => ({ module: instance.module, scope: module.name, line: instance.line, connections: instance.connections ?? [] }))),
    processes,
    cases,
    signatures,
    positionalInstanceLines,
    concurrentAssignments,
    instanceReads: modules.flatMap(module => module.instances.flatMap(instance => (instance.connections ?? []).flatMap(connection => connection.expr.match(/[A-Za-z_]\w*/g) ?? []))),
    instanceReadSites: modules.flatMap(module => module.instances.flatMap(instance => (instance.connections ?? []).flatMap(connection => (connection.expr.match(/[A-Za-z_]\w*/g) ?? []).map(name => ({ name, line: connection.line, scope: module.name }))))),
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

function hasIncompleteConditionalAssignment(assignments: AssignmentFacts[]): boolean {
  const targets = new Set(assignments.map(assignment => assignment.target));
  for (const target of targets) {
    const paths = assignments.filter(assignment => assignment.target === target).map(assignment => assignment.conditions);
    if (!paths.length || paths.some(path => path.length === 0)) continue;
    if (!conditionsCoverAll(paths)) return true;
  }
  return false;
}

function conditionsCoverAll(paths: string[][]): boolean {
  if (paths.some(path => path.length === 0)) return true;
  const condition = paths[0][0];
  if (!condition || condition.startsWith("case(")) return false;
  const positive = paths.filter(path => path[0] === condition).map(path => path.slice(1));
  const negated = condition.startsWith("!(") && condition.endsWith(")") ? condition.slice(2, -1) : `!(${condition})`;
  const negative = paths.filter(path => path[0] === negated).map(path => path.slice(1));
  return positive.length > 0 && negative.length > 0 && conditionsCoverAll(positive) && conditionsCoverAll(negative);
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

function caseFacts(clean: string, language: HdlLang, starts: number[], constants: Set<string>, scopes: { name: string; start: number; end: number }[]): CaseFacts[] {
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
      : verilogCaseLabels(body);
    const defaultText = language === "vhdl" ? /\bwhen\s+others\b([\s\S]*)/i.exec(body)?.[1] ?? "" : /\bdefault\b([\s\S]*)/.exec(body)?.[1] ?? "";
    const hasDefault = language === "vhdl" ? /\bwhen\s+others\b/i.test(body) : /\bdefault\b/.test(body);
    const defaultAssignments = [...defaultText.matchAll(/\b([A-Za-z_]\w*)\s*(?:<=|:=|=(?!=))\s*([^;]+)/g)].map(assignment => ({ target: assignment[1], expression: assignment[2].trim() }));
    result.push({
      startLine: lineAt(starts, match.index!),
      scope: scopeAtOffset(scopes, match.index!),
      control: control.trim(),
      hasDefault,
      fullyCovered: caseFullyCovered(clean, language, control, labels, hasDefault),
      controlConstant: language === "vhdl" ? /^\s*'/.test(control) : /^\s*(?:\d+'|\d)/.test(control),
      nonconstantLabel: labels.some(label => !constantExpression(label, constantNames, language)),
      emptyDefault: language === "vhdl" ? /\bwhen\s+others\s*=>\s*null\b/i.test(body) : /\bdefault\s*:\s*;/.test(body),
      defaultHasX: /'[hdboHDBO]?[0-9a-fA-FxXzZ_]*[xX]/.test(defaultText),
      labels,
      defaultAssignments,
    });
  }
  return result;
}

function caseFullyCovered(clean: string, language: HdlLang, control: string, labels: string[], hasDefault: boolean): boolean {
  if (hasDefault) return true;
  if (language !== "vhdl" || !/^[A-Za-z_]\w*$/.test(control.trim()) || !labels.length) return false;
  const name = control.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\b(?:[A-Za-z_]\\w*\\s*,\\s*)*${name}(?:\\s*,\\s*[A-Za-z_]\\w*)*\\s*:\\s*(?:(?:in|out|inout|buffer)\\s+)?([A-Za-z_]\\w*)`, "i").exec(clean);
  const type = declaration?.[1].toLowerCase();
  if (!type) return false;
  let expected: string[] = [];
  if (type === "bit") expected = ["'0'", "'1'"];
  else if (type === "boolean") expected = ["false", "true"];
  else if (type === "std_logic" || type === "std_ulogic") expected = ["'u'", "'x'", "'0'", "'1'", "'z'", "'w'", "'l'", "'h'", "'-'"];
  else {
    const enumType = new RegExp(`\\btype\\s+${type}\\s+is\\s*\\(([^)]*)\\)`, "i").exec(clean);
    if (enumType) expected = enumType[1].split(",").map(item => item.trim().toLowerCase());
  }
  const actual = new Set(labels.map(label => label.trim().toLowerCase()));
  return expected.length > 0 && expected.every(label => actual.has(label));
}

function verilogCaseLabels(body: string): string[] {
  const labels: string[] = [];
  const tokens = [...body.matchAll(/\d+\s*'\s*[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_]+|[A-Za-z_]\w*|\d[\d_]*|[():;{}\[\]]|<=|>=|==|!=|&&|\|\||[+\-*/|&^~?,=]/g)].map(match => ({ text: match[0], index: match.index! }));
  let depth = 0, parens = 0, brackets = 0, statementStart = true, labelStart = -1;
  for (const token of tokens) {
    if (token.text === "begin") {
      depth++;
      statementStart = false;
      continue;
    }
    if (token.text === "end") {
      depth = Math.max(0, depth - 1);
      statementStart = depth === 0;
      continue;
    }
    if (token.text === "(") { parens++; continue; }
    if (token.text === ")") { parens = Math.max(0, parens - 1); continue; }
    if (token.text === "[") { brackets++; continue; }
    if (token.text === "]") { brackets = Math.max(0, brackets - 1); continue; }
    if (token.text === ";") {
      if (depth === 0 && parens === 0 && brackets === 0) statementStart = true;
      continue;
    }
    if (token.text === ":") {
      if (statementStart && depth === 0 && parens === 0 && brackets === 0 && labelStart >= 0) {
        const label = body.slice(labelStart, token.index).trim();
        if (label && !/^default\b/i.test(label)) labels.push(label);
      }
      statementStart = false;
      labelStart = -1;
      continue;
    }
    if (statementStart && depth === 0 && parens === 0 && brackets === 0 && labelStart < 0) labelStart = token.index;
    if (!/^(?:if|else|case|casex|casez|endcase|for|while|repeat|forever)$/.test(token.text)) continue;
    statementStart = false;
    labelStart = -1;
  }
  return labels;
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

function continuousAssignments(clean: string, language: HdlLang, starts: number[], ranges: { index: number; text: string }[], scopes: { name: string; start: number; end: number }[]): AssignmentFacts[] {
  const result: AssignmentFacts[] = [];
  const pattern = language === "vhdl" ? /(?:^|;)\s*([A-Za-z_]\w*)\s*<=\s*([^;]+);/gm : /\bassign\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
  for (const match of clean.matchAll(pattern)) {
    const assignmentIndex = match.index! + match[0].indexOf(match[1]);
    if (ranges.some(range => assignmentIndex >= range.index && assignmentIndex < range.index + range.text.length)) continue;
    const expression = analyzeExpression(match[2], language === "vhdl");
    result.push({
      target: match[1], targetText: match[1], operator: language === "vhdl" ? "<=" : "=", line: lineAt(starts, assignmentIndex), processIndex: -1, conditions: [], reads: [...expression.reads, ...expression.blockedReads], expression: match[2], scope: scopeAtOffset(scopes, assignmentIndex),
    });
  }
  return result;
}

function declarationFacts(clean: string, language: HdlLang, starts: number[], scopes: { name: string; start: number; end: number }[]): DeclarationFacts[] {
  const result: DeclarationFacts[] = [];
  if (language === "vhdl") {
    for (const match of clean.matchAll(/\b(?:signal|variable|constant)\s+([^:]+):\s*([^;]+)/gi)) {
      const [type, ...initial] = match[2].split(":=");
      const defaultValue = initial.length ? initial.join(":=").trim() : undefined;
      for (const name of match[1].split(",")) {
        const trimmed = name.trim();
        if (/^[A-Za-z_]\w*$/.test(trimmed)) result.push({ name: trimmed, kind: /^\s*constant\b/i.test(match[0]) ? "constant" : "other", line: lineAt(starts, match.index!), scope: scopeAtOffset(scopes, match.index!), width: type.trim(), defaultValue });
      }
    }
  } else {
    for (const match of clean.matchAll(/\b(?:reg|wire|integer|parameter|localparam|input|output|inout|logic|bit)\b([^;]+);/g)) {
      const kind = /^\s*(?:parameter|localparam)\b/.test(match[0]) ? "parameter" : "other";
      for (const segment of match[1].split(",")) {
        const name = (segment.replace(/\[[^\]]*\]/g, " ").replace(/=.*$/s, "").match(/[A-Za-z_]\w*/g) ?? []).filter(name => !/^(?:reg|wire|integer|parameter|localparam|input|output|inout|signed|unsigned|logic|bit)$/.test(name)).at(-1);
        const defaultValue = segment.includes("=") ? segment.slice(segment.indexOf("=") + 1).trim() : undefined;
        const width = name ? /\[[^\]]+\]/.exec(segment.slice(0, segment.lastIndexOf(name)))?.[0] : undefined;
        if (name) result.push({ name, kind, line: lineAt(starts, match.index!), scope: scopeAtOffset(scopes, match.index!), defaultValue, width });
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

function definitionScopes(clean: string, language: HdlLang): { name: string; start: number; end: number }[] {
  const result: { name: string; start: number; end: number }[] = [];
  const pattern = language === "vhdl" ? /\bentity\s+([A-Za-z_]\w*)\s+is\b/gi : /\b(?:module|macromodule)\s+([A-Za-z_]\w*)/g;
  for (const match of clean.matchAll(pattern)) {
    const start = match.index!;
    const end = language === "vhdl" ? clean.length : /\bendmodule\b/.exec(clean.slice(start))?.index;
    result.push({ name: match[1], start, end: language === "vhdl" ? clean.length : end === undefined ? clean.length : start + end });
  }
  if (language === "vhdl") {
    for (let index = 0; index < result.length - 1; index++) result[index].end = result[index + 1].start;
  }
  return result;
}

function scopeAtOffset(scopes: { name: string; start: number; end: number }[], offset: number): string {
  return scopes.find(scope => offset >= scope.start && offset < scope.end)?.name ?? "";
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
  return analyzeCodeLines(content, language).statistics;
}

function analyzeCodeLines(content: string, language: HdlLang): { statistics: CodeStatistics; commentLines: number[] } {
  if (!content) return { statistics: { physicalLines: 0, codeLines: 0, commentOnlyLines: 0, inlineCommentLines: 0, blankLines: 0, commentRatio: 0 }, commentLines: [] };
  const rawLines = content.split("\n");
  if (content.endsWith("\n")) rawLines.pop();
  let codeLines = 0, commentOnlyLines = 0, inlineCommentLines = 0, blankLines = 0;
  const commentedLines: number[] = [];
  let blockComment = false, string = false;
  for (const [lineIndex, raw] of rawLines.entries()) {
    let code = false, comment = false;
    for (let index = 0; index < raw.length;) {
      if (blockComment) {
        comment = true;
        if (raw[index] === "*" && raw[index + 1] === "/") {
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
      if (raw[index] === "/" && raw[index + 1] === "*") {
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
    if (comment) commentedLines.push(lineIndex + 1);
    if (comment && code) inlineCommentLines++;
    else if (comment) commentOnlyLines++;
    else if (code) codeLines++;
    else blankLines++;
  }
  const commentCount = commentOnlyLines + inlineCommentLines;
  const denominator = codeLines + commentOnlyLines + inlineCommentLines * 2;
  return {
    statistics: {
      physicalLines: rawLines.length,
      codeLines: codeLines + inlineCommentLines,
      commentOnlyLines,
      inlineCommentLines,
      blankLines,
      commentRatio: denominator ? commentCount / denominator : 0,
    },
    commentLines: commentedLines,
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
  return language === "vhdl" ? trimmed.startsWith("--") || trimmed.startsWith("/*") : trimmed.startsWith("//") || trimmed.startsWith("/*");
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

export function moduleScopeAt(facts: FileFacts, line: number, scope?: string): string {
  if (scope !== undefined) return scope;
  let fallback = "";
  for (const definition of facts.definitions) {
    if (definition.kind !== "architecture" && definition.line <= line) fallback = definition.name;
  }
  return fallback;
}

export function assignmentScope(facts: FileFacts, assignment: AssignmentFacts): string {
  const process = assignment.processIndex >= 0 ? facts.processes[assignment.processIndex] : undefined;
  return assignment.scope ?? process?.scope ?? moduleScopeAt(facts, process?.startLine ?? assignment.line);
}
