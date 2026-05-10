export function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(width, 1);
  if (text.length <= safeWidth) {
    return [text];
  }
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!word) continue;
    if (!current) {
      current = word.trimStart();
    } else if (`${current}${word}`.length <= safeWidth) {
      current = `${current}${word}`;
    } else {
      lines.push(current.trimEnd());
      current = word.trimStart();
    }
    while (current.length > safeWidth) {
      lines.push(current.slice(0, safeWidth));
      current = current.slice(safeWidth);
    }
  }
  if (current) {
    lines.push(current.trimEnd());
  }
  return lines.length > 0 ? lines : [''];
}

export function wrapMultiline(text: string, width: number): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').flatMap((line) => wrapPlain(line, width));
}
