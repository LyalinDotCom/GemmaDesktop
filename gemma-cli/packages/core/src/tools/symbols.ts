export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method' | 'struct';

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  exported?: boolean;
}

export type SourceLanguage = 'ts' | 'js' | 'tsx' | 'jsx' | 'py' | 'go' | 'rs' | 'unknown';

export function detectLanguage(path: string): SourceLanguage {
  if (/\.tsx$/i.test(path)) return 'tsx';
  if (/\.jsx$/i.test(path)) return 'jsx';
  if (/\.(ts|mts|cts)$/i.test(path)) return 'ts';
  if (/\.(js|mjs|cjs)$/i.test(path)) return 'js';
  if (/\.py$/i.test(path)) return 'py';
  if (/\.go$/i.test(path)) return 'go';
  if (/\.rs$/i.test(path)) return 'rs';
  return 'unknown';
}

export function listSymbols(source: string, language: SourceLanguage): SymbolDef[] {
  const lines = source.split('\n');
  const out: SymbolDef[] = [];
  if (language === 'ts' || language === 'tsx' || language === 'js' || language === 'jsx') {
    out.push(...scanTs(lines));
  } else if (language === 'py') {
    out.push(...scanPython(lines));
  } else if (language === 'go') {
    out.push(...scanGo(lines));
  } else if (language === 'rs') {
    out.push(...scanRust(lines));
  }
  return out;
}

export function findDefinitions(name: string, source: string, language: SourceLanguage): SymbolDef[] {
  return listSymbols(source, language).filter((symbol) => symbol.name === name);
}

function scanTs(lines: string[]): SymbolDef[] {
  const out: SymbolDef[] = [];
  const patterns: Array<{ kind: SymbolKind; re: RegExp }> = [
    { kind: 'function', re: /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'class', re: /^\s*(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', re: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', re: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: 'enum', re: /^\s*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/ }
  ];
  const methodRe = /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\(/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const { kind, re } of patterns) {
      const match = line.match(re);
      if (match) {
        out.push({
          name: match[2]!,
          kind,
          line: index + 1,
          column: line.indexOf(match[2]!) + 1,
          exported: Boolean(match[1])
        });
        break;
      }
    }
    if (!out.some((symbol) => symbol.line === index + 1)) {
      const method = line.match(methodRe);
      if (method && !/^(if|for|while|switch|return|catch|function|class)\b/.test(method[1]!)) {
        out.push({ name: method[1]!, kind: 'method', line: index + 1, column: line.indexOf(method[1]!) + 1 });
      }
    }
  }
  return out;
}

function scanPython(lines: string[]): SymbolDef[] {
  const out: SymbolDef[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const def = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (def) {
      out.push({ name: def[2]!, kind: def[1] ? 'method' : 'function', line: index + 1, column: line.indexOf(def[2]!) + 1 });
      continue;
    }
    const cls = line.match(/^class\s+([A-Za-z_][\w]*)/);
    if (cls) out.push({ name: cls[1]!, kind: 'class', line: index + 1, column: line.indexOf(cls[1]!) + 1 });
  }
  return out;
}

function scanGo(lines: string[]): SymbolDef[] {
  const out: SymbolDef[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fn = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Z][\w]*|[a-z][\w]*)\s*\(/);
    if (fn) out.push({ name: fn[1]!, kind: 'function', line: index + 1, column: line.indexOf(fn[1]!) + 1, exported: /^[A-Z]/.test(fn[1]!) });
    const ty = line.match(/^type\s+([A-Z][\w]*|[a-z][\w]*)\s+(struct|interface|=|\w)/);
    if (ty) out.push({ name: ty[1]!, kind: ty[2] === 'struct' ? 'struct' : ty[2] === 'interface' ? 'interface' : 'type', line: index + 1, column: line.indexOf(ty[1]!) + 1, exported: /^[A-Z]/.test(ty[1]!) });
  }
  return out;
}

function scanRust(lines: string[]): SymbolDef[] {
  const out: SymbolDef[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fn = line.match(/^\s*(pub\s+(?:\([^)]*\)\s+)?)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/);
    if (fn) out.push({ name: fn[2]!, kind: 'function', line: index + 1, column: line.indexOf(fn[2]!) + 1, exported: Boolean(fn[1]) });
    const struct = line.match(/^\s*(pub\s+)?struct\s+([A-Za-z_][\w]*)/);
    if (struct) out.push({ name: struct[2]!, kind: 'struct', line: index + 1, column: line.indexOf(struct[2]!) + 1, exported: Boolean(struct[1]) });
    const enumDecl = line.match(/^\s*(pub\s+)?enum\s+([A-Za-z_][\w]*)/);
    if (enumDecl) out.push({ name: enumDecl[2]!, kind: 'enum', line: index + 1, column: line.indexOf(enumDecl[2]!) + 1, exported: Boolean(enumDecl[1]) });
    const trait = line.match(/^\s*(pub\s+)?trait\s+([A-Za-z_][\w]*)/);
    if (trait) out.push({ name: trait[2]!, kind: 'interface', line: index + 1, column: line.indexOf(trait[2]!) + 1, exported: Boolean(trait[1]) });
  }
  return out;
}
