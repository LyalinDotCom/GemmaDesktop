import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { ParallelHostExecutor } from "@gemma-desktop/sdk-tools";
import { setSearchProviderForTests } from "../../packages/sdk-tools/src/web.js";
import { createMockServer } from "../helpers/mock-server.js";

describe("parallel host executor", () => {
  const cleanup: Array<() => Promise<void>> = [];
  const tempDirectories: string[] = [];

  async function createWorkspace(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-batch-executor-"));
    tempDirectories.push(directory);
    return directory;
  }

  afterEach(async () => {
    delete process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT;
    setSearchProviderForTests(null);
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
    while (tempDirectories.length > 0) {
      const directory = tempDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("dedupes repeated URL fetches inside one batch run", async () => {
    const hits = new Map<string, number>();
    const server = await createMockServer((request) => {
      hits.set(request.path, (hits.get(request.path) ?? 0) + 1);
      if (request.path === "/article-a" || request.path === "/article-b") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head><title>${request.path.slice(1)}</title></head>
              <body>
                <main>
                  <article>
                    <p>Important facts for ${request.path}.</p>
                  </article>
                </main>
              </body>
            </html>
          `,
        };
      }
      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const executor = new ParallelHostExecutor();
    const results = await executor.fetchUrlBatch([
      { url: `${server.url}/article-a` },
      { url: `${server.url}/article-a` },
      { url: `${server.url}/article-b` },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("fulfilled");
    expect(results[1]?.dedupedFrom).toBe(`${server.url}/article-a`);
    expect(results[2]?.status).toBe("fulfilled");
    expect(hits.get("/article-a")).toBe(1);
    expect(hits.get("/article-b")).toBe(1);
  });

  it("dedupes repeated web searches inside one batch run", async () => {
    let providerCalls = 0;
    setSearchProviderForTests(async () => {
      providerCalls += 1;
      return {
        summary: "Repeated searches should fan in to one upstream request.",
        sources: [
          {
            title: "Batch search guide",
            url: "https://docs.example.com/batch-search-guide",
            snippet: "Repeated searches should fan in to one upstream request.",
          },
        ],
        model: "gemini-3-flash-preview",
        durationMs: 200,
        webSearchQueries: ["batch search coverage"],
      };
    });

    const executor = new ParallelHostExecutor({ geminiApiKey: "test-key" });
    const results = await executor.searchWebBatch([
      { query: "batch search coverage", depth: "quick" },
      { query: "batch search coverage", depth: "quick" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[0]?.result?.structuredOutput).toMatchObject({
      provider: "gemini-api",
      pageCount: 0,
    });
    expect(results[1]?.status).toBe("fulfilled");
    expect(results[1]?.dedupedFrom).toBe(results[0]?.key);
    expect(providerCalls).toBe(1);
  });

  it("runs workspace read and search batches through the shared backend", async () => {
    const workingDirectory = await createWorkspace();
    await writeFile(path.join(workingDirectory, "a.ts"), "export const alpha = true;\n", "utf8");
    await writeFile(path.join(workingDirectory, "b.ts"), "export const beta = alpha;\n", "utf8");

    const executor = new ParallelHostExecutor({
      workingDirectory,
    });
    const reads = await executor.readFileBatch([
      { path: "a.ts" },
      { path: "b.ts", offset: 1, limit: 1 },
    ]);
    const pathSearch = await executor.searchPathsBatch([
      { query: "a.ts", type: "file" },
    ]);
    const textSearch = await executor.searchTextBatch([
      { query: "alpha", include: ["*.ts"] },
    ]);

    expect(reads[0]?.status).toBe("fulfilled");
    expect(reads[1]?.status).toBe("fulfilled");
    expect(reads[0]?.result?.content).toContain("alpha = true");
    expect(reads[1]?.result?.content).toContain("beta = alpha");
    expect(pathSearch[0]?.status).toBe("fulfilled");
    expect(pathSearch[0]?.result?.matches[0]?.path).toBe("a.ts");
    expect(textSearch[0]?.status).toBe("fulfilled");
    expect(textSearch[0]?.result?.matches).toEqual([
      {
        path: "a.ts",
        line: 1,
        text: "export const alpha = true;",
        submatches: [
          {
            text: "alpha",
            start: 13,
            end: 18,
          },
        ],
      },
      {
        path: "b.ts",
        line: 1,
        text: "export const beta = alpha;",
        submatches: [
          {
            text: "alpha",
            start: 20,
            end: 25,
          },
        ],
      },
    ]);
  }, 15_000);
});
