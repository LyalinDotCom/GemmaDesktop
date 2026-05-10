export type StyleToken =
  | 'default'
  | 'muted'
  | 'roleUser'
  | 'roleAssistant'
  | 'roleThinking'
  | 'roleTool'
  | 'roleCommand'
  | 'roleSettings'
  | 'roleStatus'
  | 'roleError'
  | 'roleHeader'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'accent'
  | 'codeText'
  | 'codeBar'
  | 'inlineCode'
  | 'link'
  | 'syntaxKeyword'
  | 'syntaxString'
  | 'syntaxNumber'
  | 'syntaxComment'
  | 'syntaxTag'
  | 'syntaxAttr'
  | 'syntaxPunct'
  | 'syntaxBuiltin'
  | 'diffAdd'
  | 'diffDel'
  | 'diffMeta';

export interface Style {
  token?: StyleToken;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dim?: boolean;
}

export interface InkStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dimColor?: boolean;
}

const TOKEN_INK: Record<StyleToken, { color?: string; dimColor?: boolean }> = {
  default: {},
  muted: { dimColor: true },
  roleUser: { color: 'magentaBright' },
  roleAssistant: { color: 'cyanBright' },
  roleThinking: { color: '#a8a8a8' },
  roleTool: { color: 'cyan' },
  roleCommand: { color: 'gray' },
  roleSettings: { color: 'yellow' },
  roleStatus: { color: 'green' },
  roleError: { color: 'red' },
  roleHeader: { color: 'whiteBright' },
  success: { color: 'green' },
  warning: { color: 'yellow' },
  danger: { color: 'red' },
  info: { color: 'cyan' },
  accent: { color: 'magenta' },
  codeText: { color: 'whiteBright' },
  codeBar: { color: 'gray', dimColor: true },
  inlineCode: { color: 'yellowBright' },
  link: { color: 'blueBright' },
  syntaxKeyword: { color: 'magentaBright' },
  syntaxString: { color: 'greenBright' },
  syntaxNumber: { color: 'yellow' },
  syntaxComment: { color: 'gray', dimColor: true },
  syntaxTag: { color: 'blueBright' },
  syntaxAttr: { color: 'cyan' },
  syntaxPunct: { color: 'gray' },
  syntaxBuiltin: { color: 'yellowBright' },
  diffAdd: { color: 'green' },
  diffDel: { color: 'red' },
  diffMeta: { color: 'cyan', dimColor: true }
};

const TOKEN_ANSI: Record<StyleToken, string | undefined> = {
  default: undefined,
  muted: '90',
  roleUser: '95',
  roleAssistant: '96',
  roleThinking: '38;5;248',
  roleTool: '36',
  roleCommand: '90',
  roleSettings: '33',
  roleStatus: '32',
  roleError: '31',
  roleHeader: '97',
  success: '32',
  warning: '33',
  danger: '31',
  info: '36',
  accent: '35',
  codeText: '97',
  codeBar: '90',
  inlineCode: '93',
  link: '94',
  syntaxKeyword: '95',
  syntaxString: '92',
  syntaxNumber: '33',
  syntaxComment: '90',
  syntaxTag: '94',
  syntaxAttr: '36',
  syntaxPunct: '90',
  syntaxBuiltin: '93',
  diffAdd: '32',
  diffDel: '31',
  diffMeta: '36'
};

export function styleToInk(style: Style | undefined): InkStyle {
  if (!style) {
    return {};
  }
  const out: InkStyle = {};
  if (style.token && style.token !== 'default') {
    const mapped = TOKEN_INK[style.token];
    if (mapped.color) {
      out.color = mapped.color;
    }
    if (mapped.dimColor) {
      out.dimColor = true;
    }
  }
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.inverse) out.inverse = true;
  if (style.dim) out.dimColor = true;
  return out;
}

export function styleToAnsi(text: string, style: Style | undefined, color: boolean): string {
  if (!color || !style) {
    return text;
  }
  const codes: string[] = [];
  if (style.token && style.token !== 'default') {
    const code = TOKEN_ANSI[style.token];
    if (code) {
      codes.push(code);
    }
  }
  if (style.bold) codes.push('1');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.inverse) codes.push('7');
  if (style.dim) codes.push('2');
  if (codes.length === 0) {
    return text;
  }
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

export function withStyle(base: Style | undefined, extra: Partial<Style>): Style {
  return { ...(base ?? {}), ...extra };
}
