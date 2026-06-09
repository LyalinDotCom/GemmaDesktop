export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface PatchFile {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDelete: boolean;
  isRename: boolean;
  hunks: PatchHunk[];
}

export interface PatchParseError {
  message: string;
  line?: number;
}

export function parsePatch(text: string): PatchFile[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('--- ')) {
      const oldPath = stripPathPrefix(line.slice(4).trim());
      const next = lines[i + 1] ?? '';
      if (!next.startsWith('+++ ')) {
        throw makeError(`Expected "+++" header after "---" at line ${i + 1}`, i + 1);
      }
      const newPath = stripPathPrefix(next.slice(4).trim());
      const isNew = oldPath === '/dev/null';
      const isDelete = newPath === '/dev/null';
      const file: PatchFile = {
        oldPath: isNew ? newPath : oldPath,
        newPath: isDelete ? oldPath : newPath,
        isNew,
        isDelete,
        isRename: !isNew && !isDelete && oldPath !== newPath,
        hunks: []
      };
      i += 2;
      while (i < lines.length && lines[i]!.startsWith('@@')) {
        const header = lines[i]!;
        const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
        if (!match) throw makeError(`Malformed hunk header at line ${i + 1}: ${header}`, i + 1);
        const hunk: PatchHunk = {
          oldStart: Number(match[1]),
          oldCount: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newCount: match[4] === undefined ? 1 : Number(match[4]),
          lines: []
        };
        i += 1;
        // Track how many old-side (context + deletion) and new-side
        // (context + addition) lines we have consumed so we can tell a blank
        // *context* line inside the hunk from the blank separator that follows
        // it. Transport (LLM output, JSON) frequently strips the leading space
        // off a blank context line, turning " " into "", which previously
        // terminated the hunk body early and silently truncated the rest of the
        // hunk while still reporting success.
        let oldSeen = 0;
        let newSeen = 0;
        while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('--- ')) {
          const body = lines[i]!;
          if (body === '\\ No newline at end of file') {
            i += 1;
            continue;
          }
          if (body === '') {
            if (hunk.lines.length === 0) {
              // A blank line before any hunk content is a formatting artifact.
              i += 1;
              continue;
            }
            if (oldSeen >= hunk.oldCount && newSeen >= hunk.newCount) {
              // The declared counts are satisfied, so this blank line is the
              // separator after the hunk (or trailing patch whitespace), not
              // content. Stop here.
              break;
            }
            // Otherwise this is a blank context line whose leading space was
            // stripped in transit. Treat it as " " instead of truncating.
            hunk.lines.push(' ');
            oldSeen += 1;
            newSeen += 1;
            i += 1;
            continue;
          }
          if (!isHunkBodyLine(body)) {
            break;
          }
          const marker = body[0]!;
          if (marker === ' ') {
            oldSeen += 1;
            newSeen += 1;
          } else if (marker === '-') {
            oldSeen += 1;
          } else if (marker === '+') {
            newSeen += 1;
          }
          hunk.lines.push(body);
          i += 1;
        }
        file.hunks.push(hunk);
      }
      files.push(file);
      continue;
    }
    i += 1;
  }
  if (files.length === 0) {
    throw makeError('Patch contains no file headers (expected "--- path" / "+++ path")');
  }
  return files;
}

function isHunkBodyLine(line: string): boolean {
  if (line.length === 0) return false;
  const c = line[0]!;
  return c === ' ' || c === '+' || c === '-';
}

function stripPathPrefix(path: string): string {
  if (path === '/dev/null') return path;
  return path.replace(/^[ab]\//, '');
}

export interface ApplyResult {
  path: string;
  status: 'updated' | 'created' | 'deleted' | 'renamed';
  oldPath?: string;
  contents: string | undefined;
  hunksApplied: number;
}

export interface ApplyPatchOptions {
  readFile: (path: string) => Promise<string | undefined>;
  writeFile: (path: string, contents: string) => Promise<void>;
  deleteFile?: (path: string) => Promise<void>;
  allowRenames?: boolean;
}

export interface NormalizedPatchText {
  text: string;
  normalized: boolean;
}

export function normalizePatchText(text: string): NormalizedPatchText {
  if (!looksLikeDoubleEscapedPatch(text)) {
    return { text, normalized: false };
  }
  const normalizedLines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => line.replace(/\\n/g, '\n').split('\n'))
    .map((line) => isPatchSyntaxOrBodyLine(line) ? line.replace(/\\"/g, '"') : line);
  return { text: normalizedLines.join('\n'), normalized: true };
}

export async function applyPatch(text: string, options: ApplyPatchOptions): Promise<ApplyResult[]> {
  const files = parsePatch(normalizePatchText(text).text);
  for (const rename of files.filter((file) => file.isRename)) {
    validateRename(rename, options);
  }

  const staged = new Map<string, string | undefined>();
  const results: ApplyResult[] = [];
  const operations: Array<
    | { kind: 'write'; path: string; contents: string }
    | { kind: 'delete'; path: string }
  > = [];

  for (const file of files) {
    if (file.isDelete) {
      staged.set(file.oldPath, undefined);
      operations.push({ kind: 'delete', path: file.oldPath });
      results.push({ path: file.oldPath, status: 'deleted', contents: undefined, hunksApplied: file.hunks.length });
      continue;
    }
    const original = file.isNew ? '' : await readStagedFile(file.oldPath, staged, options);
    if (original === undefined && !file.isNew) {
      throw makeError(`apply_patch: file not found for hunk: ${file.oldPath}`);
    }
    const next = applyHunks(file, original ?? '');
    staged.set(file.newPath, next);
    operations.push({ kind: 'write', path: file.newPath, contents: next });
    if (file.isRename) {
      staged.set(file.oldPath, undefined);
      operations.push({ kind: 'delete', path: file.oldPath });
    }
    results.push({
      path: file.newPath,
      oldPath: file.isRename ? file.oldPath : undefined,
      status: file.isNew ? 'created' : file.isRename ? 'renamed' : 'updated',
      contents: next,
      hunksApplied: file.hunks.length
    });
  }

  for (const operation of operations) {
    if (operation.kind === 'write') {
      await options.writeFile(operation.path, operation.contents);
    } else {
      await options.deleteFile?.(operation.path);
    }
  }

  return results;
}

function validateRename(file: PatchFile, options: ApplyPatchOptions): void {
  if (!options.allowRenames) {
    throw makeError([
      `apply_patch: refusing implicit rename from ${file.oldPath} to ${file.newPath}.`,
      'For normal edits, the "---" and "+++" paths must match exactly.',
      'Re-read the target file and resend the patch with matching file headers. Use explicit file creation/deletion only if a rename was intentional.'
    ].join('\n'));
  }
  if (!options.deleteFile) {
    throw makeError(`apply_patch: cannot rename ${file.oldPath} to ${file.newPath} without delete support.`);
  }
}

async function readStagedFile(
  path: string,
  staged: Map<string, string | undefined>,
  options: ApplyPatchOptions
): Promise<string | undefined> {
  if (staged.has(path)) {
    return staged.get(path);
  }
  return await options.readFile(path);
}

export function applyHunks(file: PatchFile, original: string): string {
  if (file.isNew) {
    return file.hunks
      .flatMap((hunk) => hunk.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)))
      .join('\n');
  }
  let lines = original.split('\n');
  const trailingNewline = original.endsWith('\n');
  if (trailingNewline) lines = lines.slice(0, -1);
  let cursor = 0;
  for (const hunk of file.hunks) {
    const before = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1));
    const after = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('+'))
      .map((line) => line.slice(1));
    const found = locateHunk(lines, before, hunk.oldStart - 1, cursor);
    if (found === -1) {
      const inserted = applyContextAnchoredInsertion(lines, hunk, hunk.oldStart - 1, cursor);
      if (inserted !== undefined) {
        lines = inserted.lines;
        cursor = inserted.cursor;
        continue;
      }
      throw makeError(`apply_patch: hunk @@ -${hunk.oldStart} did not match in ${file.oldPath}.`);
    }
    lines.splice(found, before.length, ...after);
    cursor = found + after.length;
  }
  return trailingNewline ? `${lines.join('\n')}\n` : lines.join('\n');
}

function applyContextAnchoredInsertion(
  lines: string[],
  hunk: PatchHunk,
  hint: number,
  minStart: number
): { lines: string[]; cursor: number } | undefined {
  if (hunk.lines.some((line) => line.startsWith('-'))) {
    return undefined;
  }
  const firstAddition = hunk.lines.findIndex((line) => line.startsWith('+'));
  if (firstAddition === -1) {
    return undefined;
  }
  const lastAddition = findLastIndex(hunk.lines, (line) => line.startsWith('+'));
  if (hunk.lines.slice(firstAddition, lastAddition + 1).some((line) => !line.startsWith('+'))) {
    return undefined;
  }

  const prefix = hunk.lines.slice(0, firstAddition)
    .filter((line) => line.startsWith(' '))
    .map((line) => line.slice(1));
  const suffix = hunk.lines.slice(lastAddition + 1)
    .filter((line) => line.startsWith(' '))
    .map((line) => line.slice(1));
  const added = hunk.lines.slice(firstAddition, lastAddition + 1).map((line) => line.slice(1));
  if (added.length === 0) {
    return undefined;
  }

  const prefixInsertion = insertionPointAfterAnchor(lines, prefix, hint, minStart);
  if (prefixInsertion !== undefined && suffixMatchesNear(lines, suffix, prefixInsertion)) {
    return insertLines(lines, prefixInsertion, added);
  }

  const suffixInsertion = insertionPointBeforeAnchor(lines, suffix, hint, minStart);
  if (suffixInsertion !== undefined && prefixMatchesNear(lines, prefix, suffixInsertion)) {
    return insertLines(lines, suffixInsertion, added);
  }

  return undefined;
}

function insertionPointAfterAnchor(lines: string[], anchor: string[], hint: number, minStart: number): number | undefined {
  if (!isStrongInsertionAnchor(anchor)) {
    return undefined;
  }
  const found = locateHunk(lines, anchor, hint, minStart);
  return found === -1 ? undefined : found + anchor.length;
}

function insertionPointBeforeAnchor(lines: string[], anchor: string[], hint: number, minStart: number): number | undefined {
  if (!isStrongInsertionAnchor(anchor)) {
    return undefined;
  }
  const found = locateHunk(lines, anchor, hint, minStart);
  return found === -1 ? undefined : found;
}

function isStrongInsertionAnchor(anchor: string[]): boolean {
  const meaningful = anchor.filter((line) => line.trim().length > 0);
  return meaningful.length >= 2;
}

function suffixMatchesNear(lines: string[], suffix: string[], insertionPoint: number): boolean {
  if (suffix.length === 0) {
    return true;
  }
  const exactSuffix = suffix.slice(0, Math.min(suffix.length, 2));
  if (matches(lines, exactSuffix, insertionPoint)) {
    return true;
  }
  return exactSuffix.length > 0 && normalizedMatches(lines, exactSuffix, insertionPoint);
}

function prefixMatchesNear(lines: string[], prefix: string[], insertionPoint: number): boolean {
  if (prefix.length === 0) {
    return true;
  }
  const exactPrefix = prefix.slice(Math.max(0, prefix.length - 2));
  const start = insertionPoint - exactPrefix.length;
  if (matches(lines, exactPrefix, start)) {
    return true;
  }
  return exactPrefix.length > 0 && normalizedMatches(lines, exactPrefix, start);
}

function normalizedMatches(lines: string[], needle: string[], at: number): boolean {
  if (at < 0 || at + needle.length > lines.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (normalizeContextLine(lines[at + i] ?? '') !== normalizeContextLine(needle[i] ?? '')) {
      return false;
    }
  }
  return true;
}

function normalizeContextLine(line: string): string {
  return line.trim();
}

function insertLines(lines: string[], insertionPoint: number, added: string[]): { lines: string[]; cursor: number } {
  const next = [...lines];
  if (matches(next, added, insertionPoint)) {
    return { lines: next, cursor: insertionPoint + added.length };
  }
  next.splice(insertionPoint, 0, ...added);
  return { lines: next, cursor: insertionPoint + added.length };
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return index;
    }
  }
  return -1;
}

function looksLikeDoubleEscapedPatch(text: string): boolean {
  if (!text.includes('\\n')) {
    return false;
  }
  let files: PatchFile[];
  try {
    files = parsePatch(text);
  } catch {
    return /(?:^|\n)(?:--- |\+\+\+ |@@ )/.test(text) && /\\n(?=(?:--- |\+\+\+ |@@ |[ +-]))/.test(text);
  }
  return files.some((file) => file.hunks.some((hunk) => {
    if (!hunk.lines.some((line) => line.includes('\\n'))) {
      return false;
    }
    const oldLines = hunk.lines.filter((line) => line.startsWith(' ') || line.startsWith('-')).length;
    const newLines = hunk.lines.filter((line) => line.startsWith(' ') || line.startsWith('+')).length;
    return oldLines !== hunk.oldCount || newLines !== hunk.newCount;
  }));
}

function isPatchSyntaxOrBodyLine(line: string): boolean {
  return line.startsWith('--- ')
    || line.startsWith('+++ ')
    || line.startsWith('@@ ')
    || isHunkBodyLine(line);
}

function locateHunk(lines: string[], needle: string[], hint: number, minStart: number): number {
  if (needle.length === 0) return Math.max(hint, minStart);
  const maxStart = Math.max(0, lines.length - needle.length);
  const normalizedHint = Math.min(Math.max(hint, minStart), Math.max(maxStart, minStart));
  if (matches(lines, needle, normalizedHint) && normalizedHint >= minStart) return normalizedHint;
  for (let drift = 1; drift < lines.length; drift += 1) {
    const forward = normalizedHint + drift;
    if (forward >= minStart && matches(lines, needle, forward)) return forward;
    const back = normalizedHint - drift;
    if (back >= minStart && matches(lines, needle, back)) return back;
    if (forward >= lines.length && back < minStart) break;
  }
  return -1;
}

function matches(lines: string[], needle: string[], at: number): boolean {
  if (at < 0 || at + needle.length > lines.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    if (lines[at + i] !== needle[i]) return false;
  }
  return true;
}

function makeError(message: string, line?: number): Error & PatchParseError {
  const err = new Error(message) as Error & PatchParseError;
  err.message = message;
  if (line !== undefined) err.line = line;
  return err;
}
