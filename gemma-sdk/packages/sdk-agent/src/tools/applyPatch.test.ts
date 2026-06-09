import { describe, expect, it } from 'vitest';
import { parsePatch, applyHunks, applyPatch, normalizePatchText } from './applyPatch.js';

describe('parsePatch', () => {
  it('parses a single-file unified diff with one hunk', () => {
    const patch = `--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 line one
-line two
+line two changed
 line three
`;
    const files = parsePatch(patch);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ oldPath: 'foo.ts', newPath: 'foo.ts', isNew: false, isDelete: false });
    expect(files[0]?.hunks[0]?.lines).toEqual([
      ' line one',
      '-line two',
      '+line two changed',
      ' line three'
    ]);
  });

  it('parses a new-file patch (oldPath = /dev/null)', () => {
    const patch = `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;
    const files = parsePatch(patch);
    expect(files[0]?.isNew).toBe(true);
    expect(files[0]?.oldPath).toBe('new.txt');
  });

  it('parses a delete-file patch (newPath = /dev/null)', () => {
    const patch = `--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-world
`;
    const files = parsePatch(patch);
    expect(files[0]?.isDelete).toBe(true);
    expect(files[0]?.oldPath).toBe('old.txt');
  });

  it('parses a multi-file patch', () => {
    const patch = `--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-c
+d
`;
    const files = parsePatch(patch);
    expect(files).toHaveLength(2);
    expect(files[0]?.newPath).toBe('one.ts');
    expect(files[1]?.newPath).toBe('two.ts');
  });

  it('keeps a blank context line whose leading space was stripped in transit', () => {
    // A blank context line inside the hunk arrives as "" instead of " " because
    // transport stripped the trailing space. The hunk must not terminate early.
    const patch = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,6 +1,6 @@',
      ' line1',
      '-line2',
      '+LINE2',
      ' line3',
      '',
      '-line5',
      '+LINE5',
      ' line6',
      ''
    ].join('\n');
    const files = parsePatch(patch);
    expect(files[0]?.hunks).toHaveLength(1);
    expect(files[0]?.hunks[0]?.lines).toEqual([
      ' line1',
      '-line2',
      '+LINE2',
      ' line3',
      ' ',
      '-line5',
      '+LINE5',
      ' line6'
    ]);
  });

  it('does not consume the trailing blank line after a complete hunk', () => {
    const patch = ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '+B', ''].join('\n');
    const files = parsePatch(patch);
    expect(files[0]?.hunks[0]?.lines).toEqual([' a', '-b', '+B']);
  });

  it('throws on missing +++ header', () => {
    expect(() => parsePatch('--- a/foo.ts\nrest')).toThrow(/Expected "\+\+\+"/);
  });

  it('throws on patch with no file headers', () => {
    expect(() => parsePatch('hello world')).toThrow(/no file headers/);
  });

  it('throws on malformed hunk header', () => {
    expect(() => parsePatch('--- a/x\n+++ b/x\n@@ malformed @@\n')).toThrow(/Malformed hunk header/);
  });

  it('normalizes double-escaped hunk bodies when hunk counts prove the format drift', () => {
    const patch = [
      '--- a/index.html',
      '+++ b/index.html',
      '@@ -1,3 +1,4 @@',
      ' <div id=\\"app\\">\\n-  <button id=\\"old\\">Preview</button>\\n+  <button id=\\"edit\\">Edit</button>\\n+  <button id=\\"save\\" class=\\"primary\\">Save</button>\\n </div>',
      ''
    ].join('\n');

    expect(normalizePatchText(patch)).toEqual({
      normalized: true,
      text: [
        '--- a/index.html',
        '+++ b/index.html',
        '@@ -1,3 +1,4 @@',
        ' <div id="app">',
        '-  <button id="old">Preview</button>',
        '+  <button id="edit">Edit</button>',
        '+  <button id="save" class="primary">Save</button>',
        ' </div>',
        ''
      ].join('\n')
    });
  });

  it('does not normalize legitimate backslash-n text when hunk counts already match', () => {
    const patch = [
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1 +1 @@',
      '-const value = "\\n+not a patch line";',
      '+const value = "\\n+still not a patch line";',
      ''
    ].join('\n');

    expect(normalizePatchText(patch)).toEqual({ text: patch, normalized: false });
  });
});

describe('applyHunks', () => {
  it('replaces a removed line with an added line at the matching context', () => {
    const file = parsePatch(`--- a/x
+++ b/x
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`)[0]!;
    expect(applyHunks(file, 'a\nb\nc\n')).toBe('a\nB\nc\n');
  });

  it('handles a hunk where the actual line drifted from the @@ header', () => {
    const file = parsePatch(`--- a/x
+++ b/x
@@ -3,3 +3,3 @@
 b
-c
+C
 d
`)[0]!;
    expect(applyHunks(file, 'a\nb\nc\nd\n')).toBe('a\nb\nC\nd\n');
  });

  it('applies insertion-only hunks when a trailing context line has whitespace drift', () => {
    const file = parsePatch(`--- a/game.js
+++ b/game.js
@@ -160,6 +160,7 @@ const driftComboEl = document.getElementById('drift-combo-display');
 const driftComboEl = document.getElementById('drift-combo-display');
 const distanceEl = document.getElementById('distance-display');
 const rpmEl = document.getElementById('rpm-display');
+const tireEl = document.getElementById('tire-wear-display');
 const tachometerBarEl = document.getElementById('tachometer-bar');
 const inputTelemetryIndicators = [
      { label: 'throttle', el: document.getElementById('telem-throttle') },
`)[0]!;

    expect(applyHunks(file, [
      "const rainEl = document.getElementById('rain-display');",
      "const driftScoreEl = document.getElementById('drift-score-display');",
      "const driftComboEl = document.getElementById('drift-combo-display');",
      "const distanceEl = document.getElementById('distance-display');",
      "const rpmEl = document.getElementById('rpm-display');",
      "const tachometerBarEl = document.getElementById('tachometer-bar');",
      'const inputTelemetryIndicators = [',
      "    { label: 'throttle', el: document.getElementById('telem-throttle') },",
      ''
    ].join('\n'))).toBe([
      "const rainEl = document.getElementById('rain-display');",
      "const driftScoreEl = document.getElementById('drift-score-display');",
      "const driftComboEl = document.getElementById('drift-combo-display');",
      "const distanceEl = document.getElementById('distance-display');",
      "const rpmEl = document.getElementById('rpm-display');",
      "const tireEl = document.getElementById('tire-wear-display');",
      "const tachometerBarEl = document.getElementById('tachometer-bar');",
      'const inputTelemetryIndicators = [',
      "    { label: 'throttle', el: document.getElementById('telem-throttle') },",
      ''
    ].join('\n'));
  });

  it('does not apply insertion-only hunks without a strong context anchor', () => {
    const file = parsePatch(`--- a/x
+++ b/x
@@ -50,2 +50,3 @@
 b
+B2
      c
`)[0]!;

    expect(() => applyHunks(file, 'a\nb\nc\n')).toThrow(/did not match/);
  });

  it('applies edits on both sides of a stripped blank context line', () => {
    const file = parsePatch([
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,6 +1,6 @@',
      ' line1',
      '-line2',
      '+LINE2',
      ' line3',
      '',
      '-line5',
      '+LINE5',
      ' line6',
      ''
    ].join('\n'))[0]!;
    expect(applyHunks(file, 'line1\nline2\nline3\n\nline5\nline6\n')).toBe(
      'line1\nLINE2\nline3\n\nLINE5\nline6\n'
    );
  });

  it('creates a new file from a /dev/null patch', () => {
    const file = parsePatch(`--- /dev/null
+++ b/new
@@ -0,0 +1,2 @@
+one
+two
`)[0]!;
    expect(applyHunks(file, '')).toBe('one\ntwo');
  });

  it('throws when context does not match', () => {
    const file = parsePatch(`--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 banana
-c
+C
`)[0]!;
    expect(() => applyHunks(file, 'a\nb\nc')).toThrow(/did not match/);
  });

  it('preserves trailing newline when original had one', () => {
    const file = parsePatch(`--- a/x
+++ b/x
@@ -1 +1 @@
-a
+A
`)[0]!;
    expect(applyHunks(file, 'a\n')).toBe('A\n');
  });

  it('omits trailing newline when original had none', () => {
    const file = parsePatch(`--- a/x
+++ b/x
@@ -1 +1 @@
-a
+A
`)[0]!;
    expect(applyHunks(file, 'a')).toBe('A');
  });
});

describe('applyPatch', () => {
  it('writes updated content via the provided writer', async () => {
    const files = new Map<string, string>([['foo.ts', 'hello\n']]);
    const results = await applyPatch(`--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
-hello
+world
`, {
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => { files.set(path, contents); }
    });
    expect(results).toEqual([
      expect.objectContaining({ path: 'foo.ts', status: 'updated', hunksApplied: 1 })
    ]);
    expect(files.get('foo.ts')).toBe('world\n');
  });

  it('creates new files', async () => {
    const files = new Map<string, string>();
    await applyPatch(`--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hi
`, {
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => { files.set(path, contents); }
    });
    expect(files.get('new.txt')).toBe('hi');
  });

  it('deletes files when newPath is /dev/null and a deleter is provided', async () => {
    const files = new Map<string, string>([['old.txt', 'bye\n']]);
    await applyPatch(`--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`, {
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => { files.set(path, contents); },
      deleteFile: async (path) => { files.delete(path); }
    });
    expect(files.has('old.txt')).toBe(false);
  });

  it('rejects accidental renames from mismatched update headers before writing any file', async () => {
    const files = new Map<string, string>([
      ['package.json', '{\n  "scripts": {\n    "test": "node --test"\n  }\n}\n'],
      ['src/main.js', 'export const value = 1;\n']
    ]);

    await expect(applyPatch(`--- a/package.json
+++ b/package.json
@@ -2,3 +2,4 @@
   "scripts": {
-    "test": "node --test"
+    "test": "node --test",
+    "dev": "node src/main.js"
   }
--- a/src/main.js
+++ b/n/src/main.js
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`, {
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => { files.set(path, contents); }
    })).rejects.toThrow(/refusing implicit rename from src\/main\.js to n\/src\/main\.js/);

    expect(files.get('package.json')).toBe('{\n  "scripts": {\n    "test": "node --test"\n  }\n}\n');
    expect(files.has('n/src/main.js')).toBe(false);
  });

  it('does not write earlier file edits when a later file hunk fails', async () => {
    const files = new Map<string, string>([
      ['one.ts', 'a\n'],
      ['two.ts', 'c\n']
    ]);
    const writes: string[] = [];

    await expect(applyPatch(`--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-missing
+d
`, {
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => {
        writes.push(path);
        files.set(path, contents);
      }
    })).rejects.toThrow(/did not match in two\.ts/);

    expect(writes).toEqual([]);
    expect(files.get('one.ts')).toBe('a\n');
    expect(files.get('two.ts')).toBe('c\n');
  });

  it('supports explicit renames only when delete support is available', async () => {
    const files = new Map<string, string>([['old.js', 'export const value = 1;\n']]);
    const results = await applyPatch(`--- a/old.js
+++ b/new.js
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`, {
      allowRenames: true,
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => { files.set(path, contents); },
      deleteFile: async (path) => { files.delete(path); }
    });

    expect(results).toEqual([
      expect.objectContaining({ path: 'new.js', oldPath: 'old.js', status: 'renamed' })
    ]);
    expect(files.has('old.js')).toBe(false);
    expect(files.get('new.js')).toBe('export const value = 2;\n');
  });

  it('throws when the target file does not exist for an update patch', async () => {
    await expect(applyPatch(`--- a/missing.ts
+++ b/missing.ts
@@ -1 +1 @@
-x
+y
`, {
      readFile: async () => undefined,
      writeFile: async () => {}
    })).rejects.toThrow(/file not found/);
  });

  it('applies model patches that double-escape hunk newlines and quotes', async () => {
    const files = new Map<string, string>([[
      'index.html',
      [
        '<div id="app">',
        '  <button id="old">Preview</button>',
        '</div>'
      ].join('\n')
    ]]);
    await applyPatch([
      '--- a/index.html',
      '+++ b/index.html',
      '@@ -1,3 +1,4 @@',
      ' <div id=\\"app\\">\\n-  <button id=\\"old\\">Preview</button>\\n+  <button id=\\"edit\\">Edit</button>\\n+  <button id=\\"save\\" class=\\"primary\\">Save</button>\\n </div>',
      ''
    ].join('\n'), {
      readFile: async (path) => files.get(path),
      writeFile: async (path, contents) => { files.set(path, contents); }
    });

    expect(files.get('index.html')).toBe([
      '<div id="app">',
      '  <button id="edit">Edit</button>',
      '  <button id="save" class="primary">Save</button>',
      '</div>'
    ].join('\n'));
  });
});
