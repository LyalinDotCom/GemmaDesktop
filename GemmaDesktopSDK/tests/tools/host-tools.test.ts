import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type { ToolExecutionContext } from "@gemma-desktop/sdk-core";
import { runShellCommand } from "@gemma-desktop/sdk-core";
import { createHostTools, ToolRegistry, ToolRuntime } from "@gemma-desktop/sdk-tools";

describe("host tools", () => {
  const tempDirectories: string[] = [];

  async function createWorkspace(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-host-tools-"));
    tempDirectories.push(directory);
    return directory;
  }

  function createContext(workingDirectory: string): ToolExecutionContext {
    return {
      sessionId: "session-test",
      turnId: "turn-test",
      toolCallId: "tool-call-test",
      workingDirectory,
      mode: "build",
    };
  }

  function getTool(name: string) {
    const tool = createHostTools().find((entry) => entry.name === name);
    if (!tool) {
      throw new Error(`Tool ${name} is not registered.`);
    }
    return tool;
  }

  function createToolRuntime(options?: {
    allowWorkspaceEscape?: boolean;
    onWorkspaceEscape?: (details: unknown) => void;
  }): ToolRuntime {
    const registry = new ToolRegistry();
    registry.registerMany(createHostTools());
    return new ToolRuntime({
      registry,
      policy: {
        async authorize({ permission }) {
          if (permission?.kind === "workspace_escape") {
            options?.onWorkspaceEscape?.(permission.details);
            return {
              allowed: options?.allowWorkspaceEscape === true,
              reason: "workspace escape requires explicit approval",
            };
          }
          return { allowed: true };
        },
      },
    });
  }

  afterEach(async () => {
    while (tempDirectories.length > 0) {
      const directory = tempDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("lists tree entries with hidden and ignored notes plus deeper-directory hints", async () => {
    const workingDirectory = await createWorkspace();
    await writeFile(path.join(workingDirectory, ".gitignore"), "ignored.log\nbuild/\n", "utf8");
    await mkdir(path.join(workingDirectory, ".git"), { recursive: true });
    await mkdir(path.join(workingDirectory, "node_modules", "express", "lib"), { recursive: true });
    await mkdir(path.join(workingDirectory, "src", "nested", "deeper"), { recursive: true });
    await mkdir(path.join(workingDirectory, "apps", "solar-system", "src"), { recursive: true });
    await mkdir(path.join(workingDirectory, "empty"), { recursive: true });
    await mkdir(path.join(workingDirectory, "build"), { recursive: true });
    await writeFile(path.join(workingDirectory, "src", "index.ts"), "export {};\n", "utf8");
    await writeFile(path.join(workingDirectory, "src", "nested", "deep.ts"), "export const deep = true;\n", "utf8");
    await writeFile(path.join(workingDirectory, "apps", "solar-system", "src", "main.ts"), "export const ready = true;\n", "utf8");
    await writeFile(path.join(workingDirectory, ".env"), "SECRET=1\n", "utf8");
    await writeFile(path.join(workingDirectory, "ignored.log"), "ignored\n", "utf8");
    await writeFile(path.join(workingDirectory, "build", "artifact.txt"), "artifact\n", "utf8");
    await writeFile(path.join(workingDirectory, "README.md"), "# workspace\n", "utf8");

    const tool = getTool("list_tree");
    const result = await tool.execute(
      { path: ".", depth: 1 },
      createContext(workingDirectory),
    );
    const structured = result.structuredOutput as {
      entries: string[];
      listedDepth: number;
      collapsedDirectories: Array<{
        path: string;
        visibleEntryCount: number;
        reason: string;
      }>;
      dominantCollapsedDirectory?: string;
      retrySameInputUnlikelyToHelp: boolean;
      hasMoreDescendantDirectories: boolean;
      descendantDirectoryHints: string[];
      hiddenEntriesOmitted?: {
        count: number;
        sample: string[];
      };
      ignoredEntriesOmitted?: {
        count: number;
        sample: string[];
      };
    };

    expect(structured.entries[0]).toBe("apps/");
    expect(structured.entries).toContain("empty/");
    expect(structured.entries).toContain("node_modules/ [collapsed, dependency directory, 1 visible entry]");
    expect(structured.entries).toContain("src/");
    expect(structured.entries).toContain("src/index.ts");
    expect(structured.entries).toContain("src/nested/");
    expect(structured.entries).not.toContain("node_modules/express/");
    expect(structured.entries).not.toContain(".env");
    expect(structured.entries).not.toContain(".git/");
    expect(structured.entries).not.toContain("ignored.log");
    expect(structured.entries).not.toContain("build/");
    expect(structured.entries).not.toContain("src/nested/deep.ts");
    expect(structured.listedDepth).toBe(1);
    expect(structured.collapsedDirectories).toEqual([
      {
        path: "node_modules/",
        visibleEntryCount: 1,
        reason: "dependency",
      },
    ]);
    expect(structured.dominantCollapsedDirectory).toBe("node_modules/");
    expect(structured.retrySameInputUnlikelyToHelp).toBe(true);
    expect(structured.hasMoreDescendantDirectories).toBe(true);
    expect(structured.entries).toContain("apps/solar-system/");
    expect(structured.descendantDirectoryHints).toEqual(expect.arrayContaining([
      "apps/solar-system/src/",
      "src/nested/deeper/",
    ]));
    expect(structured.hiddenEntriesOmitted).toEqual({
      count: 2,
      sample: [".env", ".gitignore"],
    });
    expect(structured.ignoredEntriesOmitted?.count).toBe(3);
    expect(structured.ignoredEntriesOmitted?.sample).toEqual(
      expect.arrayContaining([".git/", "build/", "ignored.log"]),
    );
    expect(result.output).toContain("[list_tree note] Hidden entries at this level are omitted by default.");
    expect(result.output).toContain("[list_tree note] Ignored entries at this level are omitted by default.");
    expect(result.output).toContain("[list_tree note] More directories exist below this level.");
    expect(result.output).toContain("[list_tree note] Large or likely-generated directories were collapsed by default.");
    expect(result.output).toContain("[list_tree note] Repeating the same list_tree call unchanged is unlikely to help.");
    expect(result.output).toContain("use search_paths for recursive discovery");

    const withHidden = await tool.execute(
      { path: ".", depth: 0, includeHidden: true, includeIgnored: true },
      createContext(workingDirectory),
    );
    const withHiddenStructured = withHidden.structuredOutput as {
      entries: string[];
    };
    expect(withHiddenStructured.entries).toContain(".env");
    expect(withHiddenStructured.entries).toContain("ignored.log");
    expect(withHiddenStructured.entries).toContain("build/");
    expect(withHiddenStructured.entries).not.toContain(".git/");
  }, 15_000);

  it("searches paths by ranked query or glob and respects hidden visibility", async () => {
    const workingDirectory = await createWorkspace();
    await mkdir(path.join(workingDirectory, "apps", "solar-system", "src"), { recursive: true });
    await mkdir(path.join(workingDirectory, ".cache", "snapshots"), { recursive: true });
    await writeFile(path.join(workingDirectory, "apps", "solar-system", "src", "main.ts"), "export const orbit = true;\n", "utf8");
    await writeFile(path.join(workingDirectory, "apps", "solar-system", "README.md"), "# solar\n", "utf8");
    await writeFile(path.join(workingDirectory, ".cache", "snapshots", "latest.json"), "{}\n", "utf8");

    const queryResult = await getTool("search_paths").execute(
      { query: "solar-system", type: "directory" },
      createContext(workingDirectory),
    );
    const queryStructured = queryResult.structuredOutput as {
      matches: Array<{ path: string; type: string; score?: number }>;
      type: string;
      mode: string;
    };
    expect(queryStructured.type).toBe("directory");
    expect(queryStructured.mode).toBe("query");
    expect(queryStructured.matches[0]?.path).toBe("apps/solar-system");

    const globResult = await getTool("search_paths").execute(
      { glob: "**/*.md", type: "file" },
      createContext(workingDirectory),
    );
    const globStructured = globResult.structuredOutput as {
      matches: Array<{ path: string; type: string }>;
    };
    expect(globStructured.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "apps/solar-system/README.md",
        type: "file",
      }),
    ]));

    const hiddenResult = await getTool("search_paths").execute(
      { query: "snapshots", type: "directory", includeHidden: true },
      createContext(workingDirectory),
    );
    const hiddenStructured = hiddenResult.structuredOutput as {
      matches: Array<{ path: string; type: string }>;
    };
    expect(hiddenStructured.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ".cache/snapshots",
        type: "directory",
      }),
    ]));

    const withoutHidden = await getTool("search_paths").execute(
      { query: "snapshots", type: "directory" },
      createContext(workingDirectory),
    );
    const withoutHiddenStructured = withoutHidden.structuredOutput as {
      matches: Array<{ path: string; type: string }>;
    };
    expect(withoutHiddenStructured.matches).toHaveLength(0);

    const limitedResult = await getTool("search_paths").execute(
      { glob: "**/*", type: "directory", limit: 1 },
      createContext(workingDirectory),
    );
    expect(limitedResult.metadata).toEqual({ truncated: true });
  }, 10_000);

  it("reports when deeper descendant scanning is capped", async () => {
    const workingDirectory = await createWorkspace();
    await mkdir(path.join(workingDirectory, "projects"), { recursive: true });
    await Promise.all(
      Array.from({ length: 2_100 }, (_, index) =>
        mkdir(path.join(workingDirectory, "projects", `dir-${index.toString().padStart(4, "0")}`), {
          recursive: true,
        })),
    );

    const result = await getTool("list_tree").execute(
      { path: ".", depth: 0 },
      createContext(workingDirectory),
    );

    expect(result.output).toContain("Further descendant scanning was capped after 2000 filesystem entries.");
  }, 15_000);

  it("searches file text with literal defaults, regex opt-in, and glob filters", async () => {
    const workingDirectory = await createWorkspace();
    await mkdir(path.join(workingDirectory, "src"), { recursive: true });
    await writeFile(
      path.join(workingDirectory, "src", "engine.ts"),
      [
        'const literal = "alpha.beta";',
        'const wildcard = "alphaXbeta";',
        'export class SessionEngine {}',
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(path.join(workingDirectory, "src", "notes.txt"), "alpha.beta should stay out of ts-only searches\n", "utf8");
    await writeFile(path.join(workingDirectory, "src", "binary.dat"), Buffer.from([0, 1, 2, 3]));

    const literalResult = await getTool("search_text").execute(
      {
        query: "alpha.beta",
        path: "src",
        include: ["*.ts", "*.dat"],
      },
      createContext(workingDirectory),
    );
    const literalStructured = literalResult.structuredOutput as {
      matches: Array<{ path: string; line: number; text: string }>;
    };

    expect(literalStructured.matches).toEqual([
      {
        path: "src/engine.ts",
        line: 1,
        text: 'const literal = "alpha.beta";',
        submatches: [
          {
            text: "alpha.beta",
            start: 17,
            end: 27,
          },
        ],
      },
    ]);
    expect(literalResult.output).toContain("src/engine.ts:1:");

    const regexResult = await getTool("search_text").execute(
      {
        query: "alpha.beta",
        regex: true,
        path: "src",
        include: "*.ts",
      },
      createContext(workingDirectory),
    );
    const regexStructured = regexResult.structuredOutput as {
      matches: Array<{ path: string; line: number; text: string }>;
    };
    expect(regexStructured.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/engine.ts",
        line: 1,
      }),
      expect.objectContaining({
        path: "src/engine.ts",
        line: 2,
      }),
    ]));
  });

  it("reads paginated file windows, reads multiple files, and allows explicit ignored-file reads", async () => {
    const workingDirectory = await createWorkspace();
    const context = createContext(workingDirectory);
    await writeFile(path.join(workingDirectory, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(
      path.join(workingDirectory, "notes.md"),
      "line one\nline two\nline three\nline four\n",
      "utf8",
    );
    await writeFile(path.join(workingDirectory, "secret.txt"), "classified\n", "utf8");
    await writeFile(path.join(workingDirectory, "extra.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(path.join(workingDirectory, "blob.bin"), Buffer.from([65, 0, 66]));

    const result = await getTool("read_file").execute(
      {
        path: "notes.md",
        offset: 2,
        limit: 2,
      },
      context,
    );
    const structured = result.structuredOutput as {
      offset: number;
      lineEnd: number;
      content: string;
      truncated: boolean;
      nextOffset?: number;
    };

    expect(structured.offset).toBe(2);
    expect(structured.lineEnd).toBe(3);
    expect(structured.content).toBe("line two\nline three");
    expect(structured.truncated).toBe(true);
    expect(structured.nextOffset).toBe(4);
    expect(result.output).toContain("[WARNING] Partial read for notes.md. This is not the full file.");
    expect(result.output).toContain("use search_text first if you only need a specific section from a large text file");
    expect(result.output).toContain("2: line two");
    expect(result.output).toContain("3: line three");
    expect(result.output).toContain("call read_file with offset=4 to continue");

    const multiRead = await getTool("read_files").execute(
      {
        requests: [
          { path: "notes.md", offset: 1, limit: 1 },
          { path: "extra.txt", offset: 2, limit: 1 },
        ],
      },
      context,
    );
    const multiStructured = multiRead.structuredOutput as {
      results: Array<{ path: string; content: string }>;
    };
    expect(multiStructured.results).toHaveLength(2);
    expect(multiStructured.results[0]?.content).toBe("line one");
    expect(multiStructured.results[1]?.content).toBe("beta");
    expect(multiRead.output).toContain("[WARNING] read_files returned an incomplete batch.");
    expect(multiRead.output).toContain("Do not assume you saw every full file.");
    expect(multiRead.output).toContain("<file>notes.md</file>");
    expect(multiRead.output).toContain("<file>extra.txt</file>");

    const ignoredRead = await getTool("read_file").execute(
      { path: "secret.txt" },
      context,
    );
    expect(String(ignoredRead.output)).toContain("[read_file] Full file reached for secret.txt.");
    expect(String(ignoredRead.output)).toContain("classified");

    const suffixRead = await getTool("read_file").execute(
      { path: "notes.md", offset: 3, limit: 10 },
      context,
    );
    expect(String(suffixRead.output)).toContain(
      "this window starts at offset=3. You have lines 3-4, not the earlier part of the file.",
    );

    await expect(
      getTool("read_file").execute(
        { path: "missing.txt" },
        context,
      ),
    ).rejects.toThrow(/Use search_paths if the path may be wrong/i);

    await expect(
      getTool("read_file").execute(
        { path: "blob.bin" },
        context,
      ),
    ).rejects.toThrow(/Use inspect_file first when available, or search for related text files instead/i);
  });

  it("materializes, reads, and searches content artifacts without loading whole files into context", async () => {
    const workingDirectory = await createWorkspace();
    const context = createContext(workingDirectory);
    await writeFile(
      path.join(workingDirectory, "source.md"),
      [
        "# Notes",
        "",
        "Alpha section",
        "Beta section has the important token.",
        "Gamma section",
      ].join("\n"),
      "utf8",
    );

    const materialized = await getTool("materialize_content").execute(
      {
        path: "source.md",
        outputPath: "artifacts/source.md",
        target: "markdown",
        createDirectories: true,
      },
      context,
    );
    const materializedStructured = materialized.structuredOutput as {
      artifactPath: string;
      displayArtifactPath: string;
      strategy: string;
      bytes: number;
      lineCount: number;
    };

    expect(materializedStructured.displayArtifactPath).toBe("artifacts/source.md");
    expect(materializedStructured.strategy).toBe("direct_text");
    expect(materializedStructured.bytes).toBeGreaterThan(0);
    expect(materializedStructured.lineCount).toBe(5);
    expect(String(materialized.output)).toContain(
      'Next: use read_content or search_content with path "artifacts/source.md".',
    );
    await expect(readFile(path.join(workingDirectory, "artifacts", "source.md"), "utf8"))
      .resolves
      .toContain("important token");

    await expect(
      getTool("materialize_content").execute(
        {
          path: "source.md",
          outputPath: "artifacts/source.md",
        },
        context,
      ),
    ).rejects.toThrow(/Refusing to overwrite existing content artifact/);

    const readResult = await getTool("read_content").execute(
      {
        path: "artifacts/source.md",
        offset: 3,
        limit: 2,
      },
      context,
    );
    const readStructured = readResult.structuredOutput as {
      content: string;
      truncated: boolean;
      nextOffset?: number;
    };
    expect(readStructured.content).toBe("Alpha section\nBeta section has the important token.");
    expect(readStructured.truncated).toBe(true);
    expect(readStructured.nextOffset).toBe(5);

    const searchResult = await getTool("search_content").execute(
      {
        path: "artifacts/source.md",
        query: "important token",
        before: 1,
        after: 1,
      },
      context,
    );
    const searchStructured = searchResult.structuredOutput as {
      matches: Array<{ path: string; line: number; text: string }>;
    };
    expect(searchStructured.matches).toHaveLength(1);
    expect(searchStructured.matches[0]).toMatchObject({
      path: "artifacts/source.md",
      line: 4,
      text: "Beta section has the important token.",
    });
    expect(String(searchResult.output)).toContain("artifacts/source.md:4");
  });

  it("writes files, creates directories, and edits repeated text safely", async () => {
    const workingDirectory = await createWorkspace();
    const context = createContext(workingDirectory);
    const writeResult = await getTool("write_file").execute(
      {
        path: "docs/guide.txt",
        content: "alpha\nbeta\nbeta\n",
        createDirectories: true,
      },
      context,
    );
    const writeStructured = writeResult.structuredOutput as {
      path: string;
      bytes: number;
      verified?: boolean;
      edit?: {
        changeType: "created" | "edited";
        addedLines: number;
        removedLines: number;
        diff: string;
      };
    };

    expect(writeStructured).toMatchObject({
      path: path.join(workingDirectory, "docs", "guide.txt"),
      bytes: "alpha\nbeta\nbeta\n".length,
      verified: true,
      edit: {
        changeType: "created",
        addedLines: 3,
        removedLines: 0,
      },
    });
    expect(writeResult.output).toContain("Created and verified");
    expect(writeStructured.edit?.diff).toContain("+++ b/")
    expect(await readFile(path.join(workingDirectory, "docs", "guide.txt"), "utf8")).toBe("alpha\nbeta\nbeta\n");

    await expect(
      getTool("edit_file").execute(
        {
          path: "docs/guide.txt",
          oldText: "beta",
          newText: "gamma",
        },
        context,
      ),
    ).rejects.toThrow(/set replaceAll to true/i);

    const editResult = await getTool("edit_file").execute(
      {
        path: "docs/guide.txt",
        oldText: "beta",
        newText: "gamma",
        replaceAll: true,
      },
      context,
    );
    const editStructured = editResult.structuredOutput as {
      path: string;
      replacements: number;
      bytes: number;
      verified?: boolean;
      edit?: {
        changeType: "created" | "edited";
        addedLines: number;
        removedLines: number;
        diff: string;
      };
    };

    expect(editStructured).toMatchObject({
      path: path.join(workingDirectory, "docs", "guide.txt"),
      replacements: 2,
      bytes: "alpha\ngamma\ngamma\n".length,
      verified: true,
      edit: {
        changeType: "edited",
        addedLines: 2,
        removedLines: 2,
      },
    });
    expect(editResult.output).toContain("Verified update to");
    expect(editStructured.edit?.diff).toContain("@@")
    expect(editResult.output).toContain("Current file snapshot:");
    expect(editResult.output).toContain("1: alpha");
    expect(editResult.output).toContain("2: gamma");
    expect(await readFile(path.join(workingDirectory, "docs", "guide.txt"), "utf8")).toBe("alpha\ngamma\ngamma\n");
  });

  it("reports actionable write failures when the parent directory is missing", async () => {
    const workingDirectory = await createWorkspace();

    await expect(
      getTool("write_file").execute(
        {
          path: "missing/guide.txt",
          content: "alpha\n",
        },
        createContext(workingDirectory),
      ),
    ).rejects.toThrow(/parent directory does not exist/i);
  });

  it("normalizes line endings and treats already-applied edits as a no-op", async () => {
    const workingDirectory = await createWorkspace();
    const context = createContext(workingDirectory);
    const filePath = path.join(workingDirectory, "notes.txt");

    await writeFile(filePath, "alpha\r\nbeta\r\n", "utf8");

    const editResult = await getTool("edit_file").execute(
      {
        path: "notes.txt",
        oldText: "alpha\nbeta\n",
        newText: "alpha\nBETA\n",
      },
      context,
    );
    const editStructured = editResult.structuredOutput as {
      path: string;
      replacements: number;
      bytes: number;
      edit?: {
        changeType: "created" | "edited";
        addedLines: number;
        removedLines: number;
      };
    };

    expect(editStructured).toMatchObject({
      path: filePath,
      replacements: 1,
      bytes: "alpha\r\nBETA\r\n".length,
      edit: {
        changeType: "edited",
        addedLines: 1,
        removedLines: 1,
      },
    });
    expect(await readFile(filePath, "utf8")).toBe("alpha\r\nBETA\r\n");

    const noopResult = await getTool("edit_file").execute(
      {
        path: "notes.txt",
        oldText: "alpha\nbeta\n",
        newText: "alpha\nBETA\n",
      },
      context,
    );

    expect(noopResult.structuredOutput).toEqual({
      path: filePath,
      replacements: 0,
    });
    expect(noopResult.output).toContain("already matches the requested content");
  });

  it("reconciles a stale whole-file edit against the current file state", async () => {
    const workingDirectory = await createWorkspace();
    const context = createContext(workingDirectory);
    const filePath = path.join(workingDirectory, "notes.txt");
    const original = [
      "alpha",
      "beta",
      "gamma",
      "",
    ].join("\n");
    const current = [
      "alpha",
      "BETA",
      "gamma",
      "",
    ].join("\n");
    const desired = [
      "alpha",
      "BETA",
      "gamma",
      "delta",
      "",
    ].join("\n");

    await writeFile(filePath, current, "utf8");

    const result = await getTool("edit_file").execute(
      {
        path: "notes.txt",
        oldText: original,
        newText: desired,
      },
      context,
    );
    const structured = result.structuredOutput as {
      path: string;
      replacements: number;
      bytes: number;
      reconciled: boolean;
      edit?: {
        changeType: "created" | "edited";
        addedLines: number;
        removedLines: number;
      };
    };

    expect(structured).toMatchObject({
      path: filePath,
      replacements: 1,
      bytes: desired.length,
      reconciled: true,
      edit: {
        changeType: "edited",
        addedLines: 1,
        removedLines: 0,
      },
    });
    expect(result.output).toContain("reconciling against the current file state");
    expect(await readFile(filePath, "utf8")).toBe(desired);
  });

  it("returns a refreshed snapshot when the target text is stale", async () => {
    const workingDirectory = await createWorkspace();
    const context = createContext(workingDirectory);
    const filePath = path.join(workingDirectory, "notes.txt");

    await writeFile(filePath, "alpha\ngamma\n", "utf8");

    const result = await getTool("edit_file").execute(
      {
        path: "notes.txt",
        oldText: "alpha\nbeta\n",
        newText: "alpha\ndelta\n",
      },
      context,
    );

    expect(result.structuredOutput).toEqual({
      path: filePath,
      replacements: 0,
      staleTarget: true,
    });
    expect(result.output).toContain("No changes applied; could not find target text");
    expect(result.output).toContain("Retry the edit using the refreshed snapshot below");
    expect(result.output).toContain("Current file snapshot:");
    expect(result.output).toContain("1: alpha");
    expect(result.output).toContain("2: gamma");
    expect(await readFile(filePath, "utf8")).toBe("alpha\ngamma\n");
  });

  it("runs shell commands inside the requested cwd and captures stderr", async () => {
    const workingDirectory = await createWorkspace();
    await mkdir(path.join(workingDirectory, "scripts"), { recursive: true });

    const result = await getTool("exec_command").execute(
      {
        command: "pwd && >&2 echo warning",
        cwd: "scripts",
      },
      createContext(workingDirectory),
    );
    const structured = result.structuredOutput as {
      cwd?: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
    };

    expect(structured.exitCode).toBe(0);
    expect(structured.stdout).toContain(path.join(workingDirectory, "scripts"));
    expect(structured.stderr).toContain("warning");
    expect(result.output).toContain("warning");
  });

  it("marks nonzero shell command exits as failed tool results", async () => {
    const workingDirectory = await createWorkspace();

    const result = await getTool("exec_command").execute(
      {
        command: "node -e 'process.stderr.write(\"boom\\n\"); process.exit(7)'",
      },
      createContext(workingDirectory),
    );
    const structured = result.structuredOutput as {
      ok: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    };

    expect(structured.ok).toBe(false);
    expect(structured.exitCode).toBe(7);
    expect(structured.stderr).toContain("boom");
    expect(structured.timedOut).toBe(false);
    expect(result.metadata).toMatchObject({
      toolError: true,
      errorKind: "nonzero_exit",
      exitCode: 7,
      timedOut: false,
    });
    expect(result.output).toContain("Command failed with exit code 7.");
    expect(result.output).toContain("boom");
  });

  it("requires explicit permission before file and command tools target paths outside the workspace", async () => {
    const workingDirectory = await createWorkspace();
    const outsideDirectory = await createWorkspace();
    const outsideFile = path.join(outsideDirectory, "outside.txt");
    const context = createContext(workingDirectory);
    const permissionDetails: unknown[] = [];
    const deniedRuntime = createToolRuntime({
      onWorkspaceEscape: (details) => permissionDetails.push(details),
    });

    await expect(
      deniedRuntime.execute(
        {
          id: "call-write-outside",
          name: "write_file",
          input: {
            path: outsideFile,
            content: "outside\n",
          },
        },
        context,
      ),
    ).rejects.toThrow(/workspace escape requires explicit approval/i);
    await expect(readFile(outsideFile, "utf8")).rejects.toThrow();
    expect(permissionDetails).toHaveLength(1);
    expect(permissionDetails[0]).toMatchObject({
      workingDirectory,
      requestedPath: outsideFile,
      resolvedPath: outsideFile,
    });

    const approvedRuntime = createToolRuntime({ allowWorkspaceEscape: true });
    await approvedRuntime.execute(
      {
        id: "call-exec-outside",
        name: "exec_command",
        input: {
          command: "pwd",
          cwd: outsideDirectory,
        },
      },
      context,
    );
  });

  it("hard-kills shell commands that ignore SIGTERM after timing out", async () => {
    const workingDirectory = await createWorkspace();
    const startedAt = Date.now();
    const result = await runShellCommand(
      "node -e 'process.on(\"SIGTERM\",()=>{}); setInterval(()=>{}, 1000)'",
      {
        cwd: workingDirectory,
        timeoutMs: 50,
        killGraceMs: 50,
      },
    );

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("runs shell commands without starting a login shell", async () => {
    const workingDirectory = await createWorkspace();
    const result = await runShellCommand(
      "if [[ -o login ]]; then echo login; else echo non-login; fi",
      {
        cwd: workingDirectory,
        timeoutMs: 1_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("non-login");
  });
});
