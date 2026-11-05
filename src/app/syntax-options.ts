import { emptySyntaxCheckOptions, normalizePath, type SyntaxCheckOptions } from "../ipc";

export function loadSyntaxOptions(folder: string): SyntaxCheckOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(folder)) ?? "null");
    return sanitize(saved);
  } catch {
    return { ...emptySyntaxCheckOptions, top: "" };
  }
}

export function saveSyntaxOptions(folder: string, options: SyntaxCheckOptions): void {
  localStorage.setItem(storageKey(folder), JSON.stringify(sanitize(options)));
}

export function configuredPath(folder: string, path: string): string {
  const normalized = normalizePath(path.trim());
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized : normalizePath(`${folder}/${normalized}`);
}

export function validateSyntaxOptions(options: SyntaxCheckOptions): string[] {
  const errors: string[] = [];
  if (options.top && !validIdentifier(options.top)) errors.push(`顶层名称无效：${options.top}`);
  for (const define of options.defines) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*(?:=[^\s]+)?$/.test(define)) errors.push(`宏定义无效：${define}`);
  }
  for (const mapping of options.vhdlLibraries) {
    if (!validIdentifier(mapping.library)) errors.push(`VHDL library 名称无效：${mapping.library}`);
    if (!mapping.file) errors.push(`VHDL library ${mapping.library} 未指定文件`);
  }
  return errors;
}

function sanitize(value: unknown): SyntaxCheckOptions {
  const input = value && typeof value === "object" ? value as Partial<SyntaxCheckOptions> : {};
  const strings = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && !!item.trim()).map(item => item.trim()) : [];
  return {
    top: typeof input.top === "string" ? input.top.trim() : "",
    defines: strings(input.defines),
    includeDirs: strings(input.includeDirs),
    vhdlLibraries: Array.isArray(input.vhdlLibraries) ? input.vhdlLibraries.filter((item): item is { library: string; file: string } => !!item && typeof item.library === "string" && typeof item.file === "string").map(item => ({ library: item.library.trim(), file: item.file.trim() })) : [],
    verilatorArgs: strings(input.verilatorArgs),
    ghdlArgs: strings(input.ghdlArgs),
  };
}

function validIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
}

function storageKey(folder: string): string {
  return `rtl-viewer.syntaxOptions.${folder.toLowerCase()}`;
}
