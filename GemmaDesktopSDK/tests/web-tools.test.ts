import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GemmaDesktopError, type ToolExecutionContext } from "@gemma-desktop/sdk-core";
import { createHostTools } from "@gemma-desktop/sdk-tools";
import {
  __testing as webTesting,
  setSearchProviderForTests,
  type SearchProviderOverride,
} from "../packages/sdk-tools/src/web.js";
import { __testing as geminiApiSearchTesting } from "../packages/sdk-tools/src/geminiApiSearch.js";
import { createMockServer } from "./helpers/mock-server.js";

describe("web host tools", () => {
  const cleanup: Array<() => Promise<void>> = [];
  let workingDirectoryPromise: Promise<string> | undefined;

  function getWorkingDirectory(): Promise<string> {
    if (!workingDirectoryPromise) {
      workingDirectoryPromise = mkdtemp(path.join(os.tmpdir(), "gemma-desktop-web-tools-"));
    }
    return workingDirectoryPromise;
  }

  async function createContext(
    overrides: Partial<ToolExecutionContext> = {},
  ): Promise<ToolExecutionContext> {
    return {
      sessionId: "session-test",
      turnId: "turn-test",
      toolCallId: "tool-call-test",
      mode: "build",
      workingDirectory: await getWorkingDirectory(),
      ...overrides,
    };
  }

  function getTool(name: string) {
    const tool = createHostTools().find((entry) => entry.name === name);
    if (!tool) {
      throw new Error(`Tool ${name} is not registered.`);
    }
    return tool;
  }

  function installSearchProvider(override: SearchProviderOverride): void {
    setSearchProviderForTests(override);
    cleanup.push(async () => {
      setSearchProviderForTests(null);
    });
  }

  afterEach(async () => {
    delete process.env.GEMMA_DESKTOP_GOOGLE_SEARCH_ENDPOINT;
    delete process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT;
    setSearchProviderForTests(null);
    webTesting.setGeminiSearchRetryDelaysForTests(null);
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("runs quick Gemini API searches with domain filters and without fetching pages", async () => {
    const progressLabels: string[] = [];
    const providerCalls: Array<{ query: string; includeDomains: string[]; excludeDomains: string[] }> = [];

    installSearchProvider(async (input) => {
      providerCalls.push({
        query: input.query,
        includeDomains: input.includeDomains,
        excludeDomains: input.excludeDomains,
      });
      return {
        summary: "Quick mode should stay snippet-only.",
        sources: [
          {
            title: "Quick search guide",
            url: "https://docs.example.com/quick",
            snippet: "Quick mode should stay snippet-only.",
          },
        ],
        model: "gemini-3-flash-preview",
        durationMs: 123,
        webSearchQueries: ["gemma desktop quick search"],
      };
    });

    const tool = getTool("search_web");
    const result = await tool.execute(
      {
        query: "gemma desktop quick search",
        depth: "quick",
        includeDomains: ["docs.example.com"],
        excludeDomains: ["reddit.com"],
      },
      await createContext({
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.query).toBe("gemma desktop quick search");
    expect(providerCalls[0]?.includeDomains).toEqual(["docs.example.com"]);
    expect(providerCalls[0]?.excludeDomains).toEqual(["reddit.com"]);
    expect(result.output).toContain("Quick search guide");
    expect(result.output).not.toContain("Fetched pages:");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Preparing search query",
      "Running Gemini google_search grounding",
      "Found 1 result",
      "Search complete",
    ]));
    expect(progressLabels).not.toContain("Fetching top pages");
    const structured = result.structuredOutput as {
      provider: string;
      engine: string;
      pageCount: number;
      attemptedEngines: string[];
      summary: string;
      results: Array<{ url: string; siteName?: string }>;
    };
    expect(structured.provider).toBe("gemini-api");
    expect(structured.engine).toBe("gemini-api");
    expect(structured.pageCount).toBe(0);
    expect(structured.attemptedEngines).toEqual(["gemini-api"]);
    expect(structured.summary).toBe("Quick mode should stay snippet-only.");
    expect(structured.results[0]?.url).toBe("https://docs.example.com/quick");
    expect(structured.results[0]?.siteName).toBe("docs.example.com");
  });

  it("fetches top pages for standard depth using Gemini API results", async () => {
    const progressLabels: string[] = [];
    const server = await createMockServer((request) => {
      if (request.path === "/docs") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>Gemma Desktop Search Docs</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>Search starts with snippets, then escalates into page fetches only when the agent needs grounded source text.</p>
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

    installSearchProvider(async () => ({
      summary: "The docs explain snippet-first behavior with optional page fetches.",
      sources: [
        {
          title: "Gemma Desktop docs search",
          url: `${server.url}/docs`,
          snippet: "The official docs page for the search tool.",
        },
      ],
      model: "gemini-3-flash-preview",
      durationMs: 450,
      webSearchQueries: ["gemma desktop search docs"],
    }));

    const tool = getTool("search_web");
    const result = await tool.execute(
      {
        query: "gemma desktop search docs",
        depth: "standard",
        maxPages: 1,
      },
      await createContext({
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(result.output).toContain("Gemma Desktop docs search");
    expect(result.output).toContain("Search starts with snippets");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Preparing search query",
      "Running Gemini google_search grounding",
      "Found 1 result",
      "Fetching top pages",
      "Fetched 1 page",
      "Search complete",
    ]));
    const structured = result.structuredOutput as {
      provider: string;
      attemptedEngines: string[];
      pageCount: number;
      summary: string;
      pages: Array<{ title?: string; content: string }>;
    };
    expect(structured.provider).toBe("gemini-api");
    expect(structured.attemptedEngines).toEqual(["gemini-api"]);
    expect(structured.pageCount).toBe(1);
    expect(structured.summary).toBe(
      "The docs explain snippet-first behavior with optional page fetches.",
    );
    expect(structured.pages[0]?.title).toBe("Gemma Desktop Search Docs");
    expect(structured.pages[0]?.content).toContain("grounded source text");
  });

  it("retries transient fetch_url failures and reports recovery in progress metadata", async () => {
    const progressLabels: string[] = [];
    let hitCount = 0;
    const server = await createMockServer((request) => {
      if (request.path !== "/flaky-news") {
        throw new Error(`Unhandled route: ${request.path}`);
      }

      hitCount += 1;
      if (hitCount < 3) {
        return {
          status: 503,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: "<html><body>Temporary outage</body></html>",
        };
      }

      return {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
        text: `
          <html>
            <head><title>Flaky News</title></head>
            <body>
              <main>
                <article>
                  <p>The third attempt succeeded and returned readable content.</p>
                </article>
              </main>
            </body>
          </html>
        `,
      };
    });
    cleanup.push(server.close);

    const tool = getTool("fetch_url");
    const result = await tool.execute(
      {
        url: `${server.url}/flaky-news`,
      },
      await createContext({
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(hitCount).toBe(3);
    expect(result.output).toContain("The third attempt succeeded");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Requesting page",
      "Retrying request after HTTP 503 (attempt 2 of 3)",
      "Retrying request after HTTP 503 (attempt 3 of 3)",
      "Recovered after 2 retries",
      "Fetched page",
    ]));
    expect(result.metadata).toMatchObject({
      retryCount: 2,
      recoveredAfterRetry: true,
      transientRecovery: true,
    });
  });

  it("propagates Gemini API failures as GemmaDesktopError the session engine can surface to the agent", async () => {
    installSearchProvider(async () => {
      throw new GemmaDesktopError(
        "tool_execution_failed",
        "The Gemini API key was rejected. Tell the user to open Gemma Desktop -> Settings -> Integrations and paste a working Gemini API key from https://aistudio.google.com/app/apikey. Web search will stay broken until the key is fixed.",
        {
          details: {
            provider: "gemini-api",
            errorKind: "auth_invalid",
          },
        },
      );
    });

    const tool = getTool("search_web");
    let raised: unknown;
    try {
      await tool.execute(
        {
          query: "anything",
          depth: "quick",
        },
        await createContext(),
      );
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(GemmaDesktopError);
    const failure = raised as GemmaDesktopError;
    expect(failure.kind).toBe("tool_execution_failed");
    expect(failure.message).toMatch(/Gemini API key was rejected/i);
    expect(failure.message).toMatch(/tell the user/i);
    const details = failure.details as { provider?: string; errorKind?: string };
    expect(details.provider).toBe("gemini-api");
    expect(details.errorKind).toBe("auth_invalid");
  });

  it("retries transient Gemini API capacity failures before returning search results", async () => {
    webTesting.setGeminiSearchRetryDelaysForTests([0, 0, 0, 0, 0]);
    const progressLabels: string[] = [];
    let callCount = 0;

    installSearchProvider(async () => {
      callCount += 1;
      if (callCount < 3) {
        throw new GemmaDesktopError(
          "tool_execution_failed",
          "The Gemini API rejected the search with a 429 resource-exhausted response.",
          {
            details: {
              provider: "gemini-api",
              errorKind: "quota_exhausted",
              status: 429,
              providerStatus: "RESOURCE_EXHAUSTED",
              errorMessage: "Resource has been exhausted (e.g. check quota).",
            },
          },
        );
      }

      return {
        summary: "Gemini recovered after temporary capacity pressure.",
        sources: [
          {
            title: "Recovered result",
            url: "https://example.com/recovered",
            snippet: "Recovered after retries.",
          },
        ],
        model: "gemini-3-flash-preview",
        durationMs: 321,
        webSearchQueries: ["recovered search"],
      };
    });

    const tool = getTool("search_web");
    const result = await tool.execute(
      {
        query: "recovered search",
        depth: "quick",
      },
      await createContext({
        geminiApiKey: "AIzaSy-test",
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(callCount).toBe(3);
    expect(result.output).toContain("Recovered result");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Retrying Gemini search after HTTP 429 (attempt 2 of 5)",
      "Retrying Gemini search after HTTP 429 (attempt 3 of 5)",
      "Search complete",
    ]));
    expect(result.metadata).toMatchObject({
      retryCount: 2,
      recoveredAfterRetry: true,
      transientRecovery: true,
    });
  });

  it("gives up after five transient Gemini API capacity failures", async () => {
    webTesting.setGeminiSearchRetryDelaysForTests([0, 0, 0, 0, 0]);
    const progressLabels: string[] = [];
    let callCount = 0;

    installSearchProvider(async () => {
      callCount += 1;
      throw new GemmaDesktopError(
        "tool_execution_failed",
        "The Gemini API search backend is temporarily out of capacity.",
        {
          details: {
            provider: "gemini-api",
            errorKind: "capacity_exhausted",
            status: 503,
            providerStatus: "UNAVAILABLE",
            errorMessage: "This model is currently experiencing high demand.",
          },
        },
      );
    });

    const tool = getTool("search_web");
    let raised: unknown;
    try {
      await tool.execute(
        {
          query: "capacity failure",
          depth: "quick",
        },
        await createContext({
          geminiApiKey: "AIzaSy-test",
          emitProgress: (progress) => {
            progressLabels.push(progress.label);
          },
        }),
      );
    } catch (error) {
      raised = error;
    }

    expect(callCount).toBe(5);
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Retrying Gemini search after HTTP 503 (attempt 2 of 5)",
      "Retrying Gemini search after HTTP 503 (attempt 5 of 5)",
      "Search failed",
    ]));
    expect(raised).toBeInstanceOf(GemmaDesktopError);
    const failure = raised as GemmaDesktopError;
    expect(failure.message).toContain("Gemini search seems down or out of capacity");
    expect(failure.message).toContain("after 5 attempts");
    expect(failure.message).toContain("not a bad API key");
    expect(failure.details).toMatchObject({
      errorKind: "capacity_exhausted",
      retryCount: 4,
    });
  });

  it("explains exhausted Gemini project quota separately from provider capacity", async () => {
    webTesting.setGeminiSearchRetryDelaysForTests([0, 0, 0, 0, 0]);
    let callCount = 0;

    installSearchProvider(async () => {
      callCount += 1;
      throw new GemmaDesktopError(
        "tool_execution_failed",
        "The Gemini API rejected the search because the configured project's quota or rate limit appears to be exhausted.",
        {
          details: {
            provider: "gemini-api",
            errorKind: "quota_exhausted",
            status: 429,
            errorMessage: "Quota exceeded for quota metric GenerateRequestsPerMinutePerProjectPerModel.",
          },
        },
      );
    });

    const tool = getTool("search_web");
    let raised: unknown;
    try {
      await tool.execute(
        {
          query: "quota failure",
          depth: "quick",
        },
        await createContext({
          geminiApiKey: "AIzaSy-test",
        }),
      );
    } catch (error) {
      raised = error;
    }

    expect(callCount).toBe(5);
    expect(raised).toBeInstanceOf(GemmaDesktopError);
    const failure = raised as GemmaDesktopError;
    expect(failure.message).toContain("Gemini API quota or rate limit is exhausted");
    expect(failure.message).toContain("AI Studio usage/billing");
    expect(failure.details).toMatchObject({
      errorKind: "quota_exhausted",
      retryCount: 4,
    });
  });

  it("classifies generic Gemini RESOURCE_EXHAUSTED as provider capacity rather than project quota", () => {
    const failure = geminiApiSearchTesting.classifyApiSearchFailure(
      Object.assign(
        new Error(
          JSON.stringify({
            error: {
              code: 429,
              message: "Resource has been exhausted (e.g. check quota).",
              status: "RESOURCE_EXHAUSTED",
            },
          }),
        ),
        { status: 429 },
      ),
      { durationMs: 123, model: "gemini-3-flash-preview" },
    );

    expect(failure.details).toMatchObject({
      errorKind: "capacity_exhausted",
      providerStatus: "RESOURCE_EXHAUSTED",
      status: 429,
    });
    expect(failure.message).toContain("Gemini search appears to be down or out of capacity");
  });

  it("classifies explicit Gemini quota metric failures as quota exhaustion", () => {
    const failure = geminiApiSearchTesting.classifyApiSearchFailure(
      Object.assign(
        new Error(
          JSON.stringify({
            error: {
              code: 429,
              message: "Quota exceeded for quota metric GenerateRequestsPerMinutePerProjectPerModel.",
              status: "RESOURCE_EXHAUSTED",
            },
          }),
        ),
        { status: 429 },
      ),
      { durationMs: 123, model: "gemini-3-flash-preview" },
    );

    expect(failure.details).toMatchObject({
      errorKind: "quota_exhausted",
      providerStatus: "RESOURCE_EXHAUSTED",
      status: 429,
    });
    expect(failure.message).toContain("quota or rate limit appears to be exhausted");
  });

  it("fails with missing_key when no API key is configured and no override is installed", async () => {
    const tool = getTool("search_web");
    let raised: unknown;
    try {
      await tool.execute(
        {
          query: "anything",
          depth: "quick",
        },
        await createContext(),
      );
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(GemmaDesktopError);
    const failure = raised as GemmaDesktopError;
    expect(failure.kind).toBe("tool_execution_failed");
    expect(failure.message).toMatch(/Gemini API key/i);
    expect(failure.message).toMatch(/settings/i);
    const details = failure.details as { provider?: string; errorKind?: string };
    expect(details.provider).toBe("gemini-api");
    expect(details.errorKind).toBe("missing_key");
  });

  it("fetches grounded Gemini sources in deep mode", async () => {
    const progressLabels: string[] = [];
    const server = await createMockServer((request) => {
      if (request.path === "/guide") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head><title>Gemma Desktop Guide</title></head>
              <body>
                <main>
                  <article>
                    <p>This guide shows how deep search can merge repeated hits across engines and variant queries.</p>
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

    installSearchProvider(async () => ({
      summary: "Gemini found one grounded guide for the deep search pipeline.",
      sources: [
        {
          title: "Gemma Desktop guide",
          url: `${server.url}/guide`,
          snippet: "Gemini says this guide explains the search pipeline.",
        },
      ],
      model: "gemini-3-flash-preview",
      durationMs: 600,
      webSearchQueries: ["deep search pipeline official documentation"],
    }));

    const tool = getTool("search_web");
    const result = await tool.execute(
      {
        query: "deep search pipeline",
        depth: "deep",
        maxPages: 1,
      },
      await createContext({
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(result.output).toContain("Summary: Gemini found one grounded guide");
    expect(result.output).toContain("deep search can merge repeated hits");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Preparing search query",
      "Running Gemini google_search grounding",
      "Found 1 result",
      "Fetching top pages",
      "Fetched 1 page",
      "Search complete",
    ]));
    const structured = result.structuredOutput as {
      provider: string;
      queriesRun: string[];
      results: Array<{ url: string }>;
      pages: Array<{ title?: string; content: string }>;
    };
    expect(structured.provider).toBe("gemini-api");
    expect(structured.queriesRun).toEqual(["deep search pipeline official documentation"]);
    expect(structured.results).toHaveLength(1);
    expect(structured.results[0]?.url).toBe(`${server.url}/guide`);
    expect(structured.pages[0]?.title).toBe("Gemma Desktop Guide");
  });

  it("extracts homepage-style headlines from HTML pages instead of dumping boilerplate", async () => {
    const progressLabels: string[] = [];
    const server = await createMockServer((request) => {
      if (request.path !== "/news") {
        throw new Error(`Unhandled route: ${request.path}`);
      }

      return {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
        text: `
          <html>
            <head>
              <title>CNN Mock</title>
              <meta name="description" content="Latest headlines from the mock newsroom." />
            </head>
            <body>
              <nav>
                <a href="/watch-live">Watch Live</a>
                <a href="/privacy">Privacy</a>
              </nav>
              <main>
                <section>
                  <h2><a href="/2026/04/05/top-story">Pelican masters the unicycle</a></h2>
                  <p>A quick summary that should help the page feel readable.</p>
                </section>
                <section>
                  <h2><a href="/2026/04/05/another-story">Local engineers build a solar simulator</a></h2>
                </section>
                <section>
                  <h3><a href="/2026/04/05/third-story">Developers benchmark open models on laptops</a></h3>
                </section>
              </main>
            </body>
          </html>
        `,
      };
    });
    cleanup.push(server.close);

    const tool = getTool("fetch_url");
    const result = await tool.execute(
      {
        url: `${server.url}/news`,
      },
      await createContext({
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(result.output).toContain("Top headlines / links:");
    expect(result.output).toContain("Pelican masters the unicycle");
    expect(result.output).toContain("Local engineers build a solar simulator");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Resolving URL",
      "Requesting page",
      "Parsing HTML",
      "Extracting readable content",
      "Fetched page",
    ]));
    const structured = result.structuredOutput as {
      extractedWith: string;
      headlines?: Array<{ title: string; url: string }>;
    };
    expect(structured.extractedWith).toBe("headline-fallback");
    expect(structured.headlines?.[0]?.url).toContain("/2026/04/05/top-story");
  });

  it("formats RSS and Atom style feeds into readable entries", async () => {
    const server = await createMockServer((request) => {
      if (request.path !== "/feed.xml") {
        throw new Error(`Unhandled route: ${request.path}`);
      }

      return {
        headers: {
          "content-type": "application/rss+xml; charset=utf-8",
        },
        text: `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>Gemma Desktop News</title>
              <description>Local-first AI updates</description>
              <item>
                <title>Pelican benchmark released</title>
                <link>https://example.com/pelican-benchmark</link>
                <pubDate>Sun, 05 Apr 2026 19:00:00 GMT</pubDate>
                <description>Benchmarking local models just got better.</description>
              </item>
            </channel>
          </rss>`,
      };
    });
    cleanup.push(server.close);

    const tool = getTool("fetch_url");
    const result = await tool.execute(
      {
        url: `${server.url}/feed.xml`,
      },
      await createContext(),
    );

    expect(result.output).toContain("Feed: Gemma Desktop News");
    expect(result.output).toContain("Pelican benchmark released");
    expect(result.output).toContain("Benchmarking local models just got better.");
    const structured = result.structuredOutput as {
      kind: string;
      extractedWith: string;
    };
    expect(structured.kind).toBe("feed");
    expect(structured.extractedWith).toBe("feed-parser");
  });

  it("returns structured failures for fetch_url_safe instead of throwing", async () => {
    const progressLabels: string[] = [];
    const server = await createMockServer((request) => {
      if (request.path === "/loop-a") {
        return {
          status: 302,
          headers: {
            location: `${server.url}/loop-b`,
          },
          text: "",
        };
      }

      if (request.path === "/loop-b") {
        return {
          status: 302,
          headers: {
            location: `${server.url}/loop-a`,
          },
          text: "",
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    const tool = getTool("fetch_url_safe");
    const result = await tool.execute(
      {
        url: `${server.url}/loop-a`,
      },
      await createContext({
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(result.output).toContain("Failed to fetch");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Resolving URL",
      "Requesting page",
    ]));
    expect(result.metadata).toMatchObject({
      toolError: true,
    });
    expect(result.structuredOutput).toMatchObject({
      ok: false,
      requestedUrl: `${server.url}/loop-a`,
    });
  });

  it("surfaces transient failure details after fetch_url_safe exhausts retries", async () => {
    const progressLabels: string[] = [];
    let hitCount = 0;
    const server = await createMockServer((request) => {
      if (request.path !== "/always-bad") {
        throw new Error(`Unhandled route: ${request.path}`);
      }

      hitCount += 1;
      return {
        status: 503,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
        text: "<html><body>Still unavailable</body></html>",
      };
    });
    cleanup.push(server.close);

    const tool = getTool("fetch_url_safe");
    const result = await tool.execute(
      {
        url: `${server.url}/always-bad`,
      },
      await createContext({
        emitProgress: (progress) => {
          progressLabels.push(progress.label);
        },
      }),
    );

    expect(hitCount).toBe(3);
    expect(result.output).toContain("after 3 attempts");
    expect(result.output).toContain("transient network or remote-site failure");
    expect(progressLabels).toEqual(expect.arrayContaining([
      "Retrying request after HTTP 503 (attempt 2 of 3)",
      "Retrying request after HTTP 503 (attempt 3 of 3)",
    ]));
    expect(result.structuredOutput).toMatchObject({
      ok: false,
      requestedUrl: `${server.url}/always-bad`,
    });
  });

  it("does not misclassify redirect-loop errors as aborts", () => {
    expect(webTesting.isAbortError(new Error("Request aborted."))).toBe(true);
    expect(
      webTesting.isAbortError(new Error("Redirected 20 times. Aborting.")),
    ).toBe(false);
    expect(
      webTesting.shouldFallbackToNativeFetch(
        Object.assign(new Error("Redirected 20 times. Aborting."), { code: "ERR_TOO_MANY_REDIRECTS" }),
      ),
    ).toBe(true);
    expect(
      webTesting.isLikelyTransientNetworkError(
        Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
      ),
    ).toBe(true);
  });

  it("converts GitHub blob URLs to raw URLs before fetching", () => {
    expect(
      webTesting.convertGithubBlobUrlToRaw("https://github.com/openai/openai-node/blob/main/README.md"),
    ).toBe("https://raw.githubusercontent.com/openai/openai-node/main/README.md");
  });
});
