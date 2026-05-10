import type { StyledSegment } from './types.js';
import type { StyleToken } from '../theme.js';

interface Rule {
  pattern: RegExp;
  token: StyleToken;
}

const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'class', 'extends', 'implements', 'new',
  'this', 'super', 'import', 'export', 'from', 'as', 'default', 'async', 'await',
  'yield', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of',
  'void', 'delete', 'true', 'false', 'null', 'undefined', 'interface', 'type', 'enum',
  'public', 'private', 'protected', 'static', 'readonly', 'abstract', 'namespace'
]);

const TS_BUILTINS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'Promise', 'Map', 'Set', 'Date',
  'String', 'Number', 'Boolean', 'Symbol', 'Error', 'RegExp', 'Buffer', 'process',
  'require', 'module', 'exports', '__dirname', '__filename', 'globalThis'
]);

const SH_BUILTINS = new Set([
  'echo', 'cd', 'ls', 'cat', 'grep', 'sed', 'awk', 'curl', 'wget', 'cp', 'mv',
  'rm', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'pwd', 'ps', 'kill', 'find',
  'sort', 'uniq', 'head', 'tail', 'wc', 'tar', 'gzip', 'export', 'source', 'npm',
  'node', 'git', 'docker', 'make'
]);

const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'function', 'return', 'local', 'readonly', 'set', 'unset'
]);

export function highlight(language: string | undefined, text: string): StyledSegment[] {
  const lang = (language ?? '').toLowerCase();
  if (!text) {
    return [{ text: '', style: { token: 'codeText' } }];
  }
  if (lang === 'json') return tokenizeJson(text);
  if (lang === 'html' || lang === 'xml' || lang === 'svg' || lang === 'jsx' || lang === 'tsx') {
    return tokenizeMarkup(text);
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less') return tokenizeCss(text);
  if (lang === 'sh' || lang === 'bash' || lang === 'shell' || lang === 'zsh') return tokenizeShell(text);
  if (lang === 'diff' || lang === 'patch') return tokenizeDiff(text);
  if (lang === 'ts' || lang === 'js' || lang === 'typescript' || lang === 'javascript' || lang === 'mjs' || lang === 'cjs') {
    return tokenizeJs(text);
  }
  return [{ text, style: { token: 'codeText' } }];
}

function tokenizeJs(text: string): StyledSegment[] {
  const rules: Rule[] = [
    { pattern: /\/\/[^\n]*/y, token: 'syntaxComment' },
    { pattern: /\/\*[\s\S]*?\*\//y, token: 'syntaxComment' },
    { pattern: /(['"])(?:\\.|(?!\1).)*\1/y, token: 'syntaxString' },
    { pattern: /`(?:\\.|[^`\\])*`/y, token: 'syntaxString' },
    { pattern: /\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b/iy, token: 'syntaxNumber' }
  ];
  return tokenizeWith(text, rules, (word) => {
    if (TS_KEYWORDS.has(word)) return 'syntaxKeyword';
    if (TS_BUILTINS.has(word)) return 'syntaxBuiltin';
    return undefined;
  });
}

function tokenizeJson(text: string): StyledSegment[] {
  const rules: Rule[] = [
    { pattern: /"(?:\\.|[^"\\])*"(?=\s*:)/y, token: 'syntaxAttr' },
    { pattern: /"(?:\\.|[^"\\])*"/y, token: 'syntaxString' },
    { pattern: /\b(?:true|false|null)\b/y, token: 'syntaxKeyword' },
    { pattern: /-?\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b/iy, token: 'syntaxNumber' },
    { pattern: /[{}\[\],:]/y, token: 'syntaxPunct' }
  ];
  return tokenizeWith(text, rules);
}

function tokenizeMarkup(text: string): StyledSegment[] {
  const rules: Rule[] = [
    { pattern: /<!--[\s\S]*?-->/y, token: 'syntaxComment' },
    { pattern: /<\/?[A-Za-z][A-Za-z0-9-]*/y, token: 'syntaxTag' },
    { pattern: /\b[A-Za-z_:][A-Za-z0-9_.:-]*(?==)/y, token: 'syntaxAttr' },
    { pattern: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y, token: 'syntaxString' },
    { pattern: /\/?>/y, token: 'syntaxTag' }
  ];
  return tokenizeWith(text, rules);
}

function tokenizeCss(text: string): StyledSegment[] {
  const rules: Rule[] = [
    { pattern: /\/\*[\s\S]*?\*\//y, token: 'syntaxComment' },
    { pattern: /[#.][\w-]+/y, token: 'syntaxTag' },
    { pattern: /[\w-]+(?=\s*:)/y, token: 'syntaxAttr' },
    { pattern: /(['"])(?:\\.|(?!\1).)*\1/y, token: 'syntaxString' },
    { pattern: /-?\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|vh|vw|deg)?/y, token: 'syntaxNumber' },
    { pattern: /[{};:]/y, token: 'syntaxPunct' }
  ];
  return tokenizeWith(text, rules);
}

function tokenizeShell(text: string): StyledSegment[] {
  const rules: Rule[] = [
    { pattern: /#[^\n]*/y, token: 'syntaxComment' },
    { pattern: /(['"])(?:\\.|(?!\1).)*\1/y, token: 'syntaxString' },
    { pattern: /\$\{[^}]*\}/y, token: 'syntaxAttr' },
    { pattern: /\$[A-Za-z_][\w]*/y, token: 'syntaxAttr' },
    { pattern: /-{1,2}[A-Za-z][\w-]*/y, token: 'syntaxNumber' }
  ];
  return tokenizeWith(text, rules, (word) => {
    if (SH_KEYWORDS.has(word)) return 'syntaxKeyword';
    if (SH_BUILTINS.has(word)) return 'syntaxBuiltin';
    return undefined;
  });
}

function tokenizeDiff(text: string): StyledSegment[] {
  const lines = text.split(/(\n)/);
  const out: StyledSegment[] = [];
  for (const piece of lines) {
    if (piece === '\n') {
      out.push({ text: piece, style: { token: 'codeText' } });
      continue;
    }
    const token: StyleToken = piece.startsWith('+++') || piece.startsWith('---') || piece.startsWith('@@') || piece.startsWith('diff ')
      ? 'diffMeta'
      : piece.startsWith('+') ? 'diffAdd'
      : piece.startsWith('-') ? 'diffDel'
      : 'codeText';
    out.push({ text: piece, style: { token } });
  }
  return out;
}

function tokenizeWith(text: string, rules: Rule[], wordToken?: (word: string) => StyleToken | undefined): StyledSegment[] {
  const out: StyledSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let matched = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = cursor;
      const result = rule.pattern.exec(text);
      if (result && result.index === cursor) {
        out.push({ text: result[0], style: { token: rule.token } });
        cursor += result[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (wordToken) {
      const wordPattern = /[A-Za-z_][A-Za-z0-9_]*/y;
      wordPattern.lastIndex = cursor;
      const word = wordPattern.exec(text);
      if (word && word.index === cursor) {
        const token = wordToken(word[0]);
        out.push({ text: word[0], style: { token: token ?? 'codeText' } });
        cursor += word[0].length;
        continue;
      }
    }
    out.push({ text: text[cursor]!, style: { token: 'codeText' } });
    cursor += 1;
  }
  return mergeSegments(out);
}

function mergeSegments(segments: StyledSegment[]): StyledSegment[] {
  const out: StyledSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = out[out.length - 1];
    if (last && last.style?.token === segment.style?.token) {
      last.text += segment.text;
    } else {
      out.push({ ...segment });
    }
  }
  return out.length > 0 ? out : [{ text: '', style: { token: 'codeText' } }];
}
