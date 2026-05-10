import { useEffect, useState } from 'react';

interface TerminalSizeStream {
  columns?: number;
  rows?: number;
  on?: (event: 'resize', listener: () => void) => void;
  off?: (event: 'resize', listener: () => void) => void;
}

export function useTerminalSize(stdout: TerminalSizeStream = process.stdout): { columns: number; rows: number } {
  const [size, setSize] = useState({
    columns: stdout.columns || 60,
    rows: stdout.rows || 20
  });

  useEffect(() => {
    function updateSize() {
      setSize({
        columns: stdout.columns || 60,
        rows: stdout.rows || 20
      });
    }

    stdout.on?.('resize', updateSize);
    return () => {
      stdout.off?.('resize', updateSize);
    };
  }, [stdout]);

  return size;
}
