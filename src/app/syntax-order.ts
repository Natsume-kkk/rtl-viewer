import { stripComments } from "../parser/verilog";
import { stripVhdlComments } from "../parser/vhdl";

interface OrderedFile {
  actual: string;
  library: string;
}

export function orderVerilogFiles<T extends OrderedFile>(files: T[], read: (file: T) => string): T[] {
  const texts = files.map(file => stripComments(read(file)));
  const definitions = new Map<string, number>();
  texts.forEach((text, index) => {
    for (const match of windows(words(text), 2)) {
      if (match[0] === "package" && !definitions.has(match[1])) definitions.set(match[1], index);
    }
  });
  const dependencies = files.map(() => new Set<number>());
  texts.forEach((text, index) => {
    for (const [name, provider] of definitions) {
      if (provider !== index && text.includes(`${name}::`)) dependencies[index].add(provider);
    }
  });
  return stableOrder(files, dependencies);
}

export function orderVhdlFiles<T extends OrderedFile>(files: T[], read: (file: T) => string): T[] {
  const texts = files.map(file => stripVhdlComments(read(file)).toLowerCase());
  const specifications = new Map<string, number>();
  const bodies = new Map<string, number>();
  const entities = new Map<string, number>();
  texts.forEach((text, index) => {
    for (const window of windows(words(text), 3)) {
      if (window[0] === "package" && window[1] !== "is") {
        const target = window[1] === "body" ? bodies : specifications;
        const key = `${files[index].library}.${window[2]}`;
        if (!target.has(key)) target.set(key, index);
      }
      if (window[0] === "entity" && window[2] === "is") {
        const key = `${files[index].library}.${window[1]}`;
        if (!entities.has(key)) entities.set(key, index);
      }
    }
  });
  const dependencies = files.map(() => new Set<number>());
  for (const [key, body] of bodies) {
    const specification = specifications.get(key);
    if (specification !== undefined) dependencies[body].add(specification);
  }
  texts.forEach((text, index) => {
    const tokens = words(text);
    for (const pair of windows(tokens, 2)) {
      const packageProvider = specifications.get(`${pair[0]}.${pair[1]}`);
      if (packageProvider !== undefined && packageProvider !== index) dependencies[index].add(packageProvider);
      if (pair[0] === "component") {
        const provider = entities.get(`${files[index].library}.${pair[1]}`);
        if (provider !== undefined && provider !== index) dependencies[index].add(provider);
      }
    }
    for (const window of windows(tokens, 3)) {
      if (window[0] === "entity") {
        const provider = entities.get(`${window[1]}.${window[2]}`);
        if (provider !== undefined && provider !== index) dependencies[index].add(provider);
      }
    }
    for (let token = 0; token + 3 < tokens.length; token++) {
      if (tokens[token] !== "architecture" || tokens[token + 2] !== "of") continue;
      const provider = entities.get(`${files[index].library}.${tokens[token + 3]}`);
      if (provider !== undefined && provider !== index) dependencies[index].add(provider);
    }
  });
  return stableOrder(files, dependencies);
}

function stableOrder<T>(files: T[], dependencies: Set<number>[]): T[] {
  const emitted = new Set<number>();
  const ordered: T[] = [];
  while (ordered.length < files.length) {
    let progressed = false;
    for (let index = 0; index < files.length; index++) {
      if (emitted.has(index) || [...dependencies[index]].some(dependency => !emitted.has(dependency))) continue;
      emitted.add(index);
      ordered.push(files[index]);
      progressed = true;
    }
    if (!progressed) {
      for (let index = 0; index < files.length; index++) {
        if (!emitted.has(index)) {
          emitted.add(index);
          ordered.push(files[index]);
        }
      }
    }
  }
  return ordered;
}

function words(text: string): string[] {
  return text.split(/[^a-zA-Z0-9_$]+/).filter(Boolean);
}

function windows(tokens: string[], size: number): string[][] {
  return Array.from({ length: Math.max(0, tokens.length - size + 1) }, (_, index) => tokens.slice(index, index + size));
}
