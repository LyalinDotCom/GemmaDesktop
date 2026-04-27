export interface FileEditArtifact {
  path: string;
  changeType: "created" | "edited";
  addedLines: number;
  removedLines: number;
  diff: string;
  truncated?: boolean;
}

export interface BuildFileEditArtifactInput {
  path: string;
  beforeText: string | null;
  afterText: string;
  changeType?: FileEditArtifact["changeType"];
  contextLines?: number;
  maxDiffLines?: number;
  maxDiffChars?: number;
}

export type LineDiffChunk =
  | { type: "equal"; lines: string[] }
  | { type: "delete"; lines: string[] }
  | { type: "insert"; lines: string[] };

interface DiffOp {
  type: "equal" | "delete" | "insert";
  line: string;
  oldLine?: number;
  newLine?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_LINES = 300;
const DEFAULT_MAX_DIFF_CHARS = 20_000;
const TRUNCATED_DIFF_MARKER = "... diff truncated ...";

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function splitDiffLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

export function buildLineDiff(before: string[], after: string[]): LineDiffChunk[] {
  const lcs: number[][] = Array.from(
    { length: before.length + 1 },
    () => Array.from({ length: after.length + 1 }, () => 0),
  );

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lcs[left]![right] = before[left] === after[right]
        ? 1 + lcs[left + 1]![right + 1]!
        : Math.max(lcs[left + 1]![right]!, lcs[left]![right + 1]!);
    }
  }

  const chunks: LineDiffChunk[] = [];
  const pushChunk = (type: LineDiffChunk["type"], line: string) => {
    const previous = chunks[chunks.length - 1];
    if (previous?.type === type) {
      previous.lines.push(line);
      return;
    }
    chunks.push({ type, lines: [line] } as LineDiffChunk);
  };

  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      pushChunk("equal", before[left]!);
      left += 1;
      right += 1;
      continue;
    }

    if (lcs[left + 1]![right]! >= lcs[left]![right + 1]!) {
      pushChunk("delete", before[left]!);
      left += 1;
      continue;
    }

    pushChunk("insert", after[right]!);
    right += 1;
  }

  while (left < before.length) {
    pushChunk("delete", before[left]!);
    left += 1;
  }

  while (right < after.length) {
    pushChunk("insert", after[right]!);
    right += 1;
  }

  return chunks;
}

function flattenDiffChunks(chunks: LineDiffChunk[]): DiffOp[] {
  const operations: DiffOp[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      if (chunk.type === "equal") {
        operations.push({
          type: "equal",
          line,
          oldLine,
          newLine,
        });
        oldLine += 1;
        newLine += 1;
        continue;
      }

      if (chunk.type === "delete") {
        operations.push({
          type: "delete",
          line,
          oldLine,
        });
        oldLine += 1;
        continue;
      }

      operations.push({
        type: "insert",
        line,
        newLine,
      });
      newLine += 1;
    }
  }

  return operations;
}

function renderUnifiedDiff(input: {
  path: string;
  changeType: FileEditArtifact["changeType"];
  operations: DiffOp[];
  contextLines: number;
}): string {
  const { path, changeType, operations, contextLines } = input;
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    changeType === "created" ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
  ];

  let cursor = 0;
  while (cursor < operations.length) {
    while (cursor < operations.length && operations[cursor]!.type === "equal") {
      cursor += 1;
    }

    if (cursor >= operations.length) {
      break;
    }

    const start = Math.max(0, cursor - contextLines);
    let end = Math.min(operations.length, cursor + contextLines + 1);
    let scan = cursor + 1;
    while (scan < operations.length) {
      if (operations[scan]!.type !== "equal") {
        end = Math.min(operations.length, scan + contextLines + 1);
      }
      if (scan >= end - 1) {
        break;
      }
      scan += 1;
    }

    const hunkOps = operations.slice(start, end);
    const firstOld = hunkOps.find((operation) => operation.oldLine != null)?.oldLine;
    const firstNew = hunkOps.find((operation) => operation.newLine != null)?.newLine;
    const oldCount = hunkOps.filter((operation) => operation.oldLine != null).length;
    const newCount = hunkOps.filter((operation) => operation.newLine != null).length;
    const oldStart = firstOld ?? Math.max((firstNew ?? 1) - 1, 0);
    const newStart = firstNew ?? Math.max((firstOld ?? 1) - 1, 0);

    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of hunkOps) {
      const prefix = operation.type === "equal"
        ? " "
        : operation.type === "delete"
          ? "-"
          : "+";
      lines.push(`${prefix}${operation.line}`);
    }

    cursor = end;
  }

  return lines.join("\n");
}

function truncateDiff(
  diff: string,
  maxDiffLines: number,
  maxDiffChars: number,
): { diff: string; truncated: boolean } {
  const lines = diff.split("\n");
  const keptLines: string[] = [];
  let charCount = 0;

  for (const line of lines) {
    const nextChars = charCount + line.length + (keptLines.length > 0 ? 1 : 0);
    if (keptLines.length >= maxDiffLines || nextChars > maxDiffChars) {
      return {
        diff: [...keptLines, TRUNCATED_DIFF_MARKER].join("\n"),
        truncated: true,
      };
    }

    keptLines.push(line);
    charCount = nextChars;
  }

  return {
    diff,
    truncated: false,
  };
}

export function buildFileEditArtifact(
  input: BuildFileEditArtifactInput,
): FileEditArtifact | undefined {
  const beforeText = input.beforeText == null ? null : normalizeNewlines(input.beforeText);
  const afterText = normalizeNewlines(input.afterText);

  if (beforeText === afterText) {
    return undefined;
  }

  const beforeLines = beforeText == null ? [] : splitDiffLines(beforeText);
  const afterLines = splitDiffLines(afterText);
  const chunks = buildLineDiff(beforeLines, afterLines);
  const operations = flattenDiffChunks(chunks);
  const addedLines = chunks
    .filter((chunk) => chunk.type === "insert")
    .reduce((sum, chunk) => sum + chunk.lines.length, 0);
  const removedLines = chunks
    .filter((chunk) => chunk.type === "delete")
    .reduce((sum, chunk) => sum + chunk.lines.length, 0);

  const fullDiff = renderUnifiedDiff({
    path: input.path,
    changeType: input.changeType ?? (beforeText == null ? "created" : "edited"),
    operations,
    contextLines: input.contextLines ?? DEFAULT_CONTEXT_LINES,
  });
  const truncated = truncateDiff(
    fullDiff,
    input.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES,
    input.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS,
  );

  return {
    path: input.path,
    changeType: input.changeType ?? (beforeText == null ? "created" : "edited"),
    addedLines,
    removedLines,
    diff: truncated.diff,
    ...(truncated.truncated ? { truncated: true } : {}),
  };
}
