const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerFrame(index: number): string {
  return FRAMES[((index % FRAMES.length) + FRAMES.length) % FRAMES.length] ?? FRAMES[0]!;
}
