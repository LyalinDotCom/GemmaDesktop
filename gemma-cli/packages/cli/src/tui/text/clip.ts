export function clip(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (width <= 3) {
    return text.slice(0, width);
  }
  return text.length <= width ? text : `${text.slice(0, Math.max(width - 3, 0))}...`;
}

export function clipStart(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return text.slice(-width);
  }
  return `…${text.slice(-(width - 1))}`;
}
