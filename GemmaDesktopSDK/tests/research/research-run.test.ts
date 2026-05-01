import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createGemmaDesktop, type ResearchRunStatus } from "@gemma-desktop/sdk-node";
import { createLlamaCppServerAdapter } from "@gemma-desktop/sdk-runtime-llamacpp";
import { setSearchProviderForTests } from "../../packages/sdk-tools/src/web.js";
import { __testOnly, createResearchSubsessionBudgetGuard } from "../../packages/sdk-node/src/research.js";
import { createMockServer } from "../helpers/mock-server.js";

function sseJsonResponse(id: string, payload: unknown): string[] {
  return [
    `data: ${JSON.stringify({
      id,
      choices: [
        {
          index: 0,
          delta: {
            content: JSON.stringify(payload),
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function sseTextResponse(id: string, text: string): string[] {
  return [
    `data: ${JSON.stringify({
      id,
      choices: [
        {
          index: 0,
          delta: {
            content: text,
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function getLastUserPrompt(request: Record<string, unknown>): string {
  const messages = Array.isArray(request.messages)
    ? request.messages as Array<Record<string, unknown>>
    : [];
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return typeof lastUserMessage?.content === "string"
    ? lastUserMessage.content
    : "";
}

function getSystemPrompt(request: Record<string, unknown>): string {
  const messages = Array.isArray(request.messages)
    ? request.messages as Array<Record<string, unknown>>
    : [];
  const systemMessage = messages.find((message) => message.role === "system");
  return typeof systemMessage?.content === "string"
    ? systemMessage.content
    : "";
}

function configureMockSearchEndpoints(serverUrl: string, path = "/html"): void {
  const endpoint = `${serverUrl}${path}`;
  process.env.GEMMA_DESKTOP_GOOGLE_SEARCH_ENDPOINT = endpoint;
  process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT = endpoint;
  setSearchProviderForTests(async (input) => {
    const searchUrl = new URL(path, serverUrl);
    searchUrl.searchParams.set("q", input.query);
    searchUrl.searchParams.set("num", String(input.maxResults));
    const response = await fetch(searchUrl);
    const html = await response.text();
    const sources = Array.from(html.matchAll(/<h2>\s*<a\s+href="([^"]+)">([^<]+)<\/a>\s*<\/h2>[\s\S]*?<p>([^<]*)<\/p>/gi))
      .slice(0, input.maxResults)
      .map((match) => ({
        title: match[2]?.trim() ?? "",
        url: new URL(match[1] ?? "", searchUrl).toString(),
        snippet: match[3]?.trim() ?? "",
      }))
      .filter((source) => source.title.length > 0 && source.url.length > 0);

    return {
      summary: `Mock search returned ${sources.length} source(s).`,
      sources,
      model: "mock-search-provider",
      durationMs: 0,
      webSearchQueries: [input.query],
    };
  });
}

describe("research runs", { timeout: 120000 }, () => {
  const cleanup: Array<() => Promise<void>> = [];
  const tempDirectories: string[] = [];

  async function createWorkspace(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-research-run-"));
    tempDirectories.push(directory);
    return directory;
  }

  afterEach(async () => {
    delete process.env.GEMMA_DESKTOP_GOOGLE_SEARCH_ENDPOINT;
    delete process.env.GEMMA_DESKTOP_BING_SEARCH_ENDPOINT;
    delete process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS;
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

  it("plans, discovers, runs topic workers, and writes research artifacts", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const hits = new Map<string, number>();
    const statusSnapshots: ResearchRunStatus[] = [];

    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">Runtime article</a></h2>
                  <div class="b_caption"><p>Current notes on runtime differences.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-b">Tooling article</a></h2>
                  <div class="b_caption"><p>Current notes on tooling tradeoffs.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a" || url.pathname === "/article-b") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>${url.pathname === "/article-a" ? "Runtime article" : "Tooling article"}</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>${url.pathname === "/article-a"
                      ? "Runtimes differ in lifecycle behavior, protocols, and template handling."
                      : "Tooling differs in observability, batching ergonomics, and system awareness."}</p>
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
    configureMockSearchEndpoints(server.url);

    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Compare local open-model tooling coverage.",
        scopeSummary: "Focus on runtimes and developer tooling.",
        topics: [
          {
            title: "Runtime landscape",
            goal: "Summarize runtime differences for local open models.",
            priority: 1,
            searchQueries: ["local open model runtime differences"],
          },
          {
            title: "Tooling tradeoffs",
            goal: "Summarize tooling tradeoffs for developer workflows.",
            priority: 2,
            searchQueries: ["developer tooling tradeoffs open models"],
          },
        ],
        risks: ["Search results may overlap heavily."],
        stopConditions: ["Enough sources gathered for both topics."],
      }),
      sseJsonResponse("worker-1", {
        summary: "Runtimes differ mainly in protocol support, template handling, and lifecycle tooling.",
        findings: ["Protocol compatibility differs across runtimes."],
        ["sourceRefs Provide the exact URLs used for research"]: [`${server.url}/article-a`],
        confidence: 0.72,
      }),
      sseJsonResponse("worker-2", {
        summary: "Tooling differs in inspectability, batching ergonomics, and how much system truth is surfaced.",
        findings: ["Developer tooling quality is shaped by observability and batching support."],
        sourceRefs: [`${server.url}/article-b`],
        confidence: 0.77,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Local open-model stacks vary most in runtime truthfulness and tooling depth.",
        reportMarkdown: [
          "# Research Report",
          "",
          "## Runtime Landscape",
          "",
          "Runtimes differ in protocol support, template handling, and lifecycle operations.",
          "",
          "## Tooling Tradeoffs",
          "",
          "Tooling quality depends on observability, safe batching, and how honestly limits are surfaced.",
        ].join("\n"),
        sourceIds: ["source-1", "source-2"],
        confidence: 0.84,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch(
      "Research local open-model runtime and tooling differences.",
      {
        onStatus: async (status) => {
          statusSnapshots.push(status);
        },
      },
    );

    expect(result.summary).toContain("Local open-model stacks vary");
    expect(result.plan.topics).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
    expect(result.finalReport).toContain("# Research Report");
    expect(requests).toHaveLength(4);
    expect(getLastUserPrompt(requests[1]!)).toContain(
      "{\"summary\":\"...\",\"findings\":[\"...\"],\"contradictions\":[\"...\"],\"openQuestions\":[\"...\"],\"sourceRefs\":[\"source-1\"],\"confidence\":0.0}",
    );
    expect(getLastUserPrompt(requests[1]!)).toContain(
      "Do not return topic, status, mission_overview, timeline, milestones, or sources objects.",
    );
    expect(getLastUserPrompt(requests[3]!)).toContain(
      "{\"summary\":\"...\",\"reportMarkdown\":\"# Topic\\n*Location · Date · Scope of report*\\n\\n> ...\",\"openQuestions\":[\"...\"],\"sourceIds\":[\"source-1\"],\"confidence\":0.0}",
    );
    expect(getSystemPrompt(requests[3]!)).toContain("# Research Report Formatting Rules");
    expect(getSystemPrompt(requests[3]!)).toContain("Sources list at end is the only place full titles + URLs appear.");
    expect(hits.get("/html") ?? 0).toBeGreaterThanOrEqual(2);
    expect(hits.get("/article-a") ?? 0).toBeGreaterThanOrEqual(1);
    expect(hits.get("/article-b") ?? 0).toBeGreaterThanOrEqual(1);
    expect(statusSnapshots.some((status) =>
      status.activities?.some((activity) => typeof activity.currentAction === "string"),
    )).toBe(true);
    const finalStatus = statusSnapshots[statusSnapshots.length - 1];
    expect(finalStatus?.stages.planning.worker?.label).toBe("Research coordinator");
    expect(finalStatus?.stages.planning.worker?.childSessionId).toEqual(expect.any(String));
    expect(finalStatus?.stages.planning.worker?.traceText).toEqual(expect.any(String));
    expect(finalStatus?.stages.synthesis.worker?.label).toBe("Research coordinator");
    expect(finalStatus?.stages.synthesis.worker?.childSessionId).toEqual(expect.any(String));
    expect(finalStatus?.stages.synthesis.worker?.traceText).toEqual(expect.any(String));
    expect(finalStatus?.topicStatuses[0]?.worker?.label).toBe("Topic worker");
    expect(finalStatus?.topicStatuses[0]?.worker?.childSessionId).toEqual(expect.any(String));
    expect(finalStatus?.topicStatuses[0]?.worker?.traceText).toEqual(expect.any(String));

    const planText = await readFile(path.join(result.artifactDirectory, "plan.json"), "utf8");
    expect(planText).toContain("Runtime landscape");

    const sourceIndexText = await readFile(path.join(result.artifactDirectory, "sources", "index.json"), "utf8");
    expect(sourceIndexText).toContain("source-1");
    expect(sourceIndexText).toContain("source-2");

    const dossierText = await readFile(
      path.join(result.artifactDirectory, "dossiers", `${result.plan.topics[0]!.id}.json`),
      "utf8",
    );
    expect(dossierText).toContain("Protocol compatibility differs");
    expect(dossierText).toContain("source-1");

    const finalReportText = await readFile(path.join(result.artifactDirectory, "final", "report.md"), "utf8");
    expect(finalReportText).toContain("Tooling quality depends on observability");
  });

  it("runs a source-depth scout before topic workers and records one-hop provenance", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const hits = new Map<string, number>();
    const statusSnapshots: ResearchRunStatus[] = [];

    let chatRequestCount = 0;

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        chatRequestCount += 1;
        const prompt = getLastUserPrompt(request.bodyJson as Record<string, unknown>);
        if (chatRequestCount === 1) {
          return {
            sse: sseJsonResponse("plan-1", {
              objective: "Research Gemma 4 versions and availability.",
              scopeSummary: "Use first-party and runtime catalog sources.",
              topics: [
                {
                  title: "Gemma 4 versions",
                  goal: "Find official Gemma 4 model versions and sizes.",
                  priority: 1,
                  searchQueries: ["Gemma 4 model card"],
                },
              ],
              risks: [],
              stopConditions: [],
            }),
          };
        }
        if (prompt.includes("source-depth scout")) {
          return {
            sse: sseJsonResponse("depth-1", {
              selectedUrls: [`${server.url}/model-card`],
              rationale: "The model-card page is the concrete detail page behind the hub.",
              openQuestions: [],
              confidence: 0.82,
            }),
          };
        }
        if (prompt.includes("Analyze the gathered evidence for this topic")) {
          return {
            sse: sseJsonResponse("worker-1", {
              summary: "The detail page provides the concrete Gemma 4 model-card evidence.",
              findings: ["Gemma 4 model-card details are available from the second-level source."],
              contradictions: [],
              openQuestions: [],
              sourceRefs: ["source-1"],
              confidence: 0.76,
            }),
          };
        }
        return {
          sse: sseJsonResponse("synthesis-1", {
            summary: "Gemma 4 availability was grounded in hub and second-level model-card evidence.",
            reportMarkdown: "# Report\n\nGemma 4 model-card details were confirmed from the one-hop detail page [source-2].",
            openQuestions: [],
            sourceIds: ["source-1", "source-2"],
            confidence: 0.8,
          }),
        };
      }

      if (url.pathname === "/html") {
        return {
          headers: { "content-type": "text/html; charset=utf-8" },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/hub">Gemma 4 model hub</a></h2>
                  <div class="b_caption"><p>Official Gemma 4 model hub with model-card links.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/hub") {
        return {
          headers: { "content-type": "text/html; charset=utf-8" },
          text: `
            <html>
              <head>
                <title>Gemma 4 model hub</title>
                <meta name="description" content="Gemma 4 official model hub with links to concrete model card data." />
              </head>
              <body>
                <main>
                  <h1>Gemma 4 model hub</h1>
                  <p>
                    Gemma 4 model hub with concrete detail links for Gemma 4 availability, versions,
                    model card evidence, runtime packaging, and release notes. Fetch the detail page
                    at ${server.url}/model-card for model card data and ${server.url}/release-notes
                    for release information.
                  </p>
                  <a href="${server.url}/model-card">Gemma 4 model card</a>
                  <a href="${server.url}/release-notes">Gemma 4 release notes</a>
                  <a href="${server.url}/runtime-catalog">Gemma 4 runtime catalog</a>
                  <a href="${server.url}/size-table">Gemma 4 size table</a>
                  <a href="${server.url}/license">Gemma 4 license terms</a>
                  <a href="${server.url}/downloads">Gemma 4 downloads</a>
                  <a href="${server.url}/quantization">Gemma 4 quantization notes</a>
                  <a href="${server.url}/api">Gemma 4 API availability</a>
                </main>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/model-card") {
        return {
          headers: { "content-type": "text/html; charset=utf-8" },
          text: `
            <html>
              <head><title>Gemma 4 model card</title></head>
              <body>
                <main>
                  <article>
                    <p>Gemma 4 model card lists version, size, runtime availability, and deployment notes for Gemma 4 models.</p>
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
    configureMockSearchEndpoints(server.url);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch(
      "Research Gemma 4 versions and availability from official Google and runtime catalog sources.",
      {
        onStatus: async (status) => {
          statusSnapshots.push(status);
        },
      },
    );

    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect(requests.some((request) =>
      getLastUserPrompt(request).includes("source-depth scout"),
    )).toBe(true);
    expect(hits.get("/hub") ?? 0).toBeGreaterThanOrEqual(1);
    expect(hits.get("/model-card") ?? 0).toBeGreaterThanOrEqual(1);
    const oneHopSource = result.sources.find((source) => source.resolvedUrl === `${server.url}/model-card`);
    expect(oneHopSource).toMatchObject({
      sourceDepth: 1,
      discoveryMethod: "one_hop",
      parentSourceId: "source-1",
      parentResolvedUrl: `${server.url}/hub`,
    });
    const finalStatus = statusSnapshots[statusSnapshots.length - 1];
    expect(finalStatus?.stages.depth.worker?.label).toBe("Source-depth scout");
    expect(finalStatus?.stages.depth.worker?.childSessionId).toEqual(expect.any(String));
    expect(result.finalReport).toContain("one-hop detail page");
    const evidenceCards = JSON.parse(
      await readFile(path.join(result.artifactDirectory, "evidence-cards", "index.json"), "utf8"),
    ) as {
      topics: Array<{ topicId: string; sourceCount: number; cardCount: number; cards: Array<{ sourceId: string; excerpt: string }> }>;
    };
    expect(evidenceCards.topics[0]?.sourceCount).toBeGreaterThan(0);
    expect(evidenceCards.topics[0]?.cardCount).toBeGreaterThan(0);
    const firstEvidenceCard = evidenceCards.topics[0]?.cards[0];
    expect(firstEvidenceCard?.sourceId).toMatch(/^source-\d+$/);
    expect(typeof firstEvidenceCard?.excerpt).toBe("string");
  });

  it("marks runaway topic-worker assistant output as a budget failure", () => {
    const guard = createResearchSubsessionBudgetGuard("topic", {
      topicTitle: "Oversized Topic",
    });

    try {
      guard.onEvent({
        type: "content.delta",
        payload: {
          channel: "assistant",
          delta: "x".repeat(16_001),
        },
      });

      expect(guard.signal.aborted).toBe(true);
      const wrapped = guard.wrapError(new Error("aborted"));
      expect(wrapped).toBeInstanceOf(Error);
      expect((wrapped as Error).message).toBe(
        "Topic worker \"Oversized Topic\" exceeded the 16,000 character structured-output budget and looks runaway.",
      );
    } finally {
      guard.cleanup();
    }
  });

  it("keeps synthesis running while structured output is still making progress", () => {
    vi.useFakeTimers();
    const guard = createResearchSubsessionBudgetGuard("synthesis", {});

    try {
      vi.advanceTimersByTime(2 * 60_000);
      expect(guard.signal.aborted).toBe(false);

      guard.onEvent({
        type: "content.delta",
        payload: {
          channel: "reasoning",
          delta: "still organizing the report",
        },
      });
      vi.advanceTimersByTime(2 * 60_000);
      expect(guard.signal.aborted).toBe(false);

      guard.onEvent({
        type: "content.delta",
        payload: {
          channel: "assistant",
          delta: "{\"summary\":\"working\"",
        },
      });
      vi.advanceTimersByTime((3 * 60_000) - 1);
      expect(guard.signal.aborted).toBe(false);

      vi.advanceTimersByTime(1);
      expect(guard.signal.aborted).toBe(true);
      const wrapped = guard.wrapError(new Error("aborted"));
      expect(wrapped).toBeInstanceOf(Error);
      expect((wrapped as Error).message).toContain("Research synthesis made no structured-output progress");
    } finally {
      guard.cleanup();
      vi.useRealTimers();
    }
  });

  it("extracts a tight focus query from outlet-heavy news requests", () => {
    const focus = __testOnly.inferResearchFocusQuery(
      "Please go look at the top news websites like Fox, CNN, BBC, AP, Reuters, and a few others. See what news on there is about Iran, read the latest stories and what is on the front page, and give me a report with concrete dates plus where the outlets agree or differ.",
    );

    expect(focus).toBe("Iran");
  });

  it("extracts a tight focus query from simple latest-news-from requests", () => {
    const focus = __testOnly.inferResearchFocusQuery(
      "Latest news from Kyiv, ukraine capital",
    );

    expect(focus).toBe("Kyiv");
  });

  it("prefers known model-family subjects over generic research verbs", () => {
    expect(__testOnly.inferResearchSubject(
      "Run a deep research pass for the latest Gemma 4 model availability details.",
    )).toBe("Gemma 4");
  });

  it("builds an ambitious source plan for simple latest-news requests", () => {
    const request = "Latest news from Kyiv, ukraine capital";
    const plan = {
      objective: request,
      scopeSummary: "Gather the latest Kyiv updates.",
      topics: [
        {
          id: "kyiv-news-1",
          title: "Kyiv news",
          goal: "Find the latest Kyiv updates.",
          priority: 1,
          searchQueries: ["Kyiv latest news"],
        },
      ],
      risks: [],
      stopConditions: [],
    };

    const brief = __testOnly.buildResearchBrief(request, plan);
    const { coveragePlan } = __testOnly.buildCoveragePlan(plan, brief, "deep");
    const sourceFamilies = coveragePlan.queryGroups.map((group) => group.sourceFamily);

    expect(brief.taskType).toBe("news-sweep");
    expect(brief.focusQuery).toBe("Kyiv");
    expect(coveragePlan.maxPasses).toBe(3);
    expect(coveragePlan.targetSources).toBeGreaterThanOrEqual(18);
    expect(sourceFamilies).toEqual(expect.arrayContaining([
      "mainstream_front_page",
      "mainstream_article",
      "wire",
      "local_news",
      "blogs_analysis",
    ]));
    expect(sourceFamilies).not.toContain("community");
  });

  it("builds a deterministic fallback plan for latest-news requests when model planning fails", () => {
    const request = "Latest news from Kyiv, ukraine capital";
    const plan = __testOnly.buildDeterministicResearchPlan(
      request,
      "deep",
      "Research planner exceeded the 2 minute time budget while generating structured output.",
    );
    const brief = __testOnly.buildResearchBrief(request, plan);
    const { coveragePlan } = __testOnly.buildCoveragePlan(plan, brief, "deep");

    expect(plan.topics.map((topic) => topic.title)).toEqual([
      "Front Page Emphasis",
      "Latest Story Coverage",
      "Local and Specialized Sources",
      "Analysis and Situation Reports",
    ]);
    expect(plan.risks.join("\n")).toContain("Model planner fallback used");
    expect(brief.taskType).toBe("news-sweep");
    expect(coveragePlan.targetSources).toBeGreaterThanOrEqual(18);
    expect(coveragePlan.queryGroups.map((group) => group.sourceFamily)).toEqual(expect.arrayContaining([
      "mainstream_front_page",
      "mainstream_article",
      "wire",
      "local_news",
      "blogs_analysis",
    ]));
  });

  it("fails clearly when web search is not configured and source coverage remains insufficient", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const previousGeminiApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    setSearchProviderForTests(null);

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        return {
          sse: sseJsonResponse("plan-1", {
            objective: "Research current Zorblatt framework adoption.",
            scopeSummary: "Find current source coverage.",
            topics: [
              {
                title: "Current adoption",
                goal: "Find current adoption evidence.",
                priority: 1,
                searchQueries: ["Zorblatt framework adoption"],
              },
            ],
            risks: [],
            stopConditions: [],
          }),
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);

    try {
      const gemmaDesktop = await createGemmaDesktop({
        workingDirectory,
        adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
      });
      const session = await gemmaDesktop.sessions.create({
        runtime: "llamacpp-server",
        model: "mock-model",
        mode: "cowork",
        workingDirectory,
      });

      await expect(
        session.runResearch("Research current Zorblatt framework adoption.", {
          profile: "quick",
        }),
      ).rejects.toThrow(/Web search is unavailable because no Gemini API key is configured/);
    } finally {
      if (previousGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = previousGeminiApiKey;
      }
    }
  });

  it("uses small source-bundle analyst calls for news sweeps before synthesis", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];

    let chatRequestCount = 0;

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        chatRequestCount += 1;
        const prompt = getLastUserPrompt(request.bodyJson as Record<string, unknown>);
        if (chatRequestCount === 1) {
          return {
            sse: sseJsonResponse("plan-1", {
              objective: "News from Kyiv, Ukraine",
              scopeSummary: "Find current Kyiv coverage.",
              topics: [
                {
                  title: "Kyiv updates",
                  goal: "Summarize current Kyiv reporting.",
                  priority: 1,
                  searchQueries: ["Kyiv Ukraine news"],
                },
              ],
              risks: [],
              stopConditions: [],
            }),
          };
        }
        if (prompt.includes("Analyze the gathered evidence for this topic")) {
          return {
            sse: sseJsonResponse(`bundle-${chatRequestCount}`, {
              summary: "This source bundle reports April 30, 2026 Kyiv updates.",
              findings: ["April 30, 2026 Kyiv coverage described air-defense activity and city services."],
              contradictions: [],
              openQuestions: [],
              sourceRefs: ["source-1"],
              confidence: 0.7,
            }),
          };
        }
        return {
          sse: sseJsonResponse("synthesis-1", {
            summary: "Kyiv coverage was summarized from source-bundle analyst notes.",
            reportMarkdown: [
              "# Report",
              "",
              "## Front Page Emphasis",
              "",
              "Front page emphasis was thin in the local fixture set.",
              "",
              "## Latest Story Coverage",
              "",
              "The latest story coverage from April 30, 2026 described Kyiv air-defense activity and city-service updates [source-1].",
              "",
              "## Consensus and Divergence",
              "",
              "The available fixtures agree on Kyiv being the focus; the limited outlet set leaves divergence unresolved [source-1].",
            ].join("\n"),
            openQuestions: [],
            sourceIds: ["source-1"],
            confidence: 0.72,
          }),
        };
      }

      if (url.pathname === "/kyiv-a" || url.pathname === "/kyiv-b") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>${url.pathname === "/kyiv-a" ? "Kyiv latest update" : "Kyiv city report"}</title>
              </head>
              <body>
                <main>
                  <p>${url.pathname === "/kyiv-a"
                    ? "April 30, 2026 Kyiv latest coverage with links to deeper story pages."
                    : "April 30, 2026 reporting from Kyiv described municipal updates and resident impacts."}</p>
                  ${url.pathname === "/kyiv-a"
                    ? [
                        `<h2><a href="${server.url}/2026/04/30/kyiv-linked-report">Kyiv air defense report expands chronology</a></h2>`,
                        `<h2><a href="${server.url}/2026/04/30/kyiv-services">Kyiv city services update</a></h2>`,
                        `<h2><a href="${server.url}/weather">Weather outside Kyiv</a></h2>`,
                      ].join("\n")
                    : ""}
                </main>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/2026/04/30/kyiv-linked-report" || url.pathname === "/2026/04/30/kyiv-services") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head><title>${url.pathname.endsWith("kyiv-services") ? "Kyiv city services update" : "Kyiv air defense report expands chronology"}</title></head>
              <body>
                <article>
                  <p>Linked April 30, 2026 reporting added a second-level Kyiv chronology from the first source page.</p>
                </article>
              </body>
            </html>
          `,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    setSearchProviderForTests(async () => ({
      summary: "Mock search returned Kyiv fixtures.",
      sources: [
        {
          title: "Kyiv latest update",
          url: `${server.url}/kyiv-a`,
          snippet: "April 30, 2026 coverage from Kyiv.",
        },
        {
          title: "Kyiv city report",
          url: `${server.url}/kyiv-b`,
          snippet: "April 30, 2026 municipal report from Kyiv.",
        },
      ],
      model: "mock-search-provider",
      durationMs: 0,
      webSearchQueries: ["Kyiv Ukraine news"],
    }));

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("News from Kyiv, Ukraine", {
      profile: "deep",
    });

    expect(result.taskType).toBe("news-sweep");
    expect(result.summary).toContain("Kyiv coverage");
    expect(requests.length).toBeGreaterThan(2);
    expect(result.sources.some((source) => source.resolvedUrl.endsWith("/2026/04/30/kyiv-linked-report"))).toBe(true);
    expect(requests.some((request) =>
      getLastUserPrompt(request).includes("Analyze the gathered evidence for this topic"),
    )).toBe(true);
    expect(getLastUserPrompt(requests[requests.length - 1]!)).toContain("Topic dossiers:");
  });

  it("builds bounded deep news coverage plans without site-colon article queries", () => {
    const request = "Research Iran news across major outlets and compare the latest front-page coverage.";
    const plan = {
      objective: "Compare Iran coverage across major outlets.",
      scopeSummary: "Track front-page emphasis, latest stories, and points of agreement.",
      topics: [
        {
          id: "iran-coverage-1",
          title: "Iran coverage",
          goal: "Compare current Iran coverage across major outlets.",
          priority: 1,
          searchQueries: ["Iran coverage"],
        },
      ],
      risks: [],
      stopConditions: [],
    };

    const brief = __testOnly.buildResearchBrief(request, plan);
    const { coveragePlan } = __testOnly.buildCoveragePlan(plan, brief, "deep");
    const articleGroup = coveragePlan.queryGroups.find((group) => group.sourceFamily === "mainstream_article");

    expect(brief.taskType).toBe("news-sweep");
    expect(brief.focusQuery).toBe("Iran");
    expect(coveragePlan.maxPasses).toBe(3);
    expect(coveragePlan.targetSources).toBeGreaterThanOrEqual(14);
    expect(coveragePlan.requiredSourceFamilies).toEqual(
      expect.arrayContaining(["mainstream_front_page", "mainstream_article"]),
    );
    expect(articleGroup?.searchQueries.some((query) => query.includes("site:"))).toBe(false);
  });

  it("adds wire, official, and community news coverage groups when the request asks for them", () => {
    const request =
      "Research Artemis news across major outlets. Compare front-page coverage, include Reuters and AP wire reporting, official NASA statements, and Reddit or Hacker News reaction.";
    const plan = {
      objective: "Compare current Artemis coverage across news, official, and community sources.",
      scopeSummary: "Track front-page emphasis, latest wire updates, NASA statements, and community reaction.",
      topics: [
        {
          id: "artemis-coverage-1",
          title: "Artemis coverage",
          goal: "Compare current Artemis coverage across requested source families.",
          priority: 1,
          searchQueries: ["Artemis coverage"],
        },
      ],
      risks: [],
      stopConditions: [],
    };

    const brief = __testOnly.buildResearchBrief(request, plan);
    const { coveragePlan } = __testOnly.buildCoveragePlan(plan, brief, "deep");
    const wireGroup = coveragePlan.queryGroups.find((group) => group.sourceFamily === "wire");
    const officialGroup = coveragePlan.queryGroups.find((group) => group.sourceFamily === "official");
    const communityGroup = coveragePlan.queryGroups.find((group) => group.sourceFamily === "community");

    expect(brief.taskType).toBe("news-sweep");
    expect(wireGroup?.seedUrls).toEqual(
      expect.arrayContaining([
        "https://www.reuters.com/",
        "https://apnews.com/",
      ]),
    );
    expect(officialGroup?.seedUrls).toEqual(
      expect.arrayContaining([
        "https://www.nasa.gov/news/",
        "https://www.nasa.gov/mission/artemis/",
      ]),
    );
    expect(communityGroup?.seedUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("hn.algolia.com"),
        expect.stringContaining("reddit.com/search"),
      ]),
    );
  });

  it("seeds official and ecosystem reference coverage for React-style adoption research", () => {
    const request =
      "Research current React 19 adoption and ecosystem updates. Check official React docs, major framework or tooling posts, GitHub or release notes, and Reddit or HN community reaction.";
    const plan = {
      objective: "Assess the current state of React 19 adoption and ecosystem ecosystem impact.",
      scopeSummary:
        "Investigation of React 19 release status, official documentation, framework integration, and community sentiment across developer platforms.",
      topics: [
        {
          id: "react-19-official-status-and-documentation-1",
          title: "React 19 Official Status and Documentation",
          goal: "Identify the current stable release version and key new features via official sources.",
          priority: 1,
          searchQueries: [
            "React 19 official release notes",
            "React 19 documentation new features",
            "React 19 stable release date",
          ],
        },
        {
          id: "framework-and-tooling-integration-2",
          title: "Framework and Tooling Integration",
          goal: "Determine how major frameworks like Next.js and Remix are adopting React 19.",
          priority: 2,
          searchQueries: [
            "Next.js React 19 support",
            "React 19 compatibility with Vite",
            "React 19 ecosystem updates libraries",
          ],
        },
        {
          id: "github-and-developer-ecosystem-updates-3",
          title: "GitHub and Developer Ecosystem Updates",
          goal: "Track technical changes and breaking changes through repository activity and changelogs.",
          priority: 3,
          searchQueries: [
            "React GitHub repository recent releases",
            "React 19 breaking changes changelog",
          ],
        },
        {
          id: "community-sentiment-and-adoption-trends-4",
          title: "Community Sentiment and Adoption Trends",
          goal: "Gauge developer reception and common pain points via social discussions.",
          priority: 4,
          searchQueries: [
            "React 19 Reddit discussion",
            "React 19 Hacker News reviews",
          ],
        },
      ],
      risks: [],
      stopConditions: [],
    };

    const brief = __testOnly.buildResearchBrief(request, plan);
    const { coveragePlan } = __testOnly.buildCoveragePlan(plan, brief, "deep");
    const officialGroup = coveragePlan.queryGroups.find((group) => group.topicId === "react-19-official-status-and-documentation-1");
    const frameworkGroup = coveragePlan.queryGroups.find((group) => group.topicId === "framework-and-tooling-integration-2");
    const githubGroup = coveragePlan.queryGroups.find((group) => group.topicId === "github-and-developer-ecosystem-updates-3");

    expect(officialGroup?.sourceFamily).toBe("official");
    expect(officialGroup?.seedUrls).toEqual(
      expect.arrayContaining([
        "https://react.dev/",
        "https://react.dev/blog",
      ]),
    );
    expect(frameworkGroup?.sourceFamily).toBe("reference_github_docs");
    expect(frameworkGroup?.seedUrls).toEqual(
      expect.arrayContaining([
        "https://nextjs.org/blog",
        "https://vite.dev/guide/",
        "https://remix.run/docs",
      ]),
    );
    expect(githubGroup?.sourceFamily).toBe("reference_github_docs");
    expect(githubGroup?.seedUrls).toEqual(
      expect.arrayContaining([
        "https://github.com/facebook/react/releases",
        "https://raw.githubusercontent.com/facebook/react/main/CHANGELOG.md",
      ]),
    );
  });

  it("schedules follow-up article seeds from focused front-page links when article coverage is thin", () => {
    const request = "Research Iran news across major outlets and compare the latest front-page coverage.";
    const plan = {
      objective: "Compare Iran coverage across major outlets.",
      scopeSummary: "Track front-page emphasis, latest stories, and points of agreement.",
      topics: [
        {
          id: "iran-coverage-1",
          title: "Iran coverage",
          goal: "Compare current Iran coverage across major outlets.",
          priority: 1,
          searchQueries: ["Iran coverage"],
        },
      ],
      risks: [],
      stopConditions: [],
    };

    const brief = __testOnly.buildResearchBrief(request, plan);
    const { coveragePlan } = __testOnly.buildCoveragePlan(plan, brief, "deep");
    const articleGroup = coveragePlan.queryGroups.find((group) => group.sourceFamily === "mainstream_article");
    const assessment = __testOnly.buildCoverageAssessment(
      brief,
      coveragePlan,
      [
        {
          id: "source-1",
          requestedUrl: "https://abcnews.go.com/",
          resolvedUrl: "https://abcnews.com/",
          title: "ABC News - Breaking News, Latest News and Videos",
          description: "ABC front page",
          kind: "html",
          extractedWith: "headline-fallback",
          blockedLikely: true,
          fetchedAt: new Date().toISOString(),
          topicIds: ["mainstream-front-pages-1"],
          domain: "abcnews.com",
          sourceFamily: "mainstream_front_page",
          pageRole: "front_page",
          contentPreview: [
            "Top headlines / links:",
            "1. Iran live updates",
            "   https://abcnews.com/International/live-updates/iran-live-updates-casualties-reported-missile-strikes-israel/?id=131757074",
            "2. Disney+ promo",
            "   https://www.disneyplus.com/browse/entity-c99a2244-2ec4-449a-9dde-8b09a408f923",
          ].join("\n"),
        },
      ],
      1,
    );

    expect(assessment.missingSourceFamilies).toContain("mainstream_article");
    expect(articleGroup).toBeDefined();
    expect(assessment.followUpSeedUrlsByTopic.get(articleGroup!.topicId)).toEqual(
      expect.arrayContaining([
        "https://abcnews.com/International/live-updates/iran-live-updates-casualties-reported-missile-strikes-israel/?id=131757074",
      ]),
    );
  });

  it("extracts one-hop detail URLs from generic reference pages", () => {
    const request = "Research Gemma 4 versions and availability from official Google and Ollama sources.";
    const plan = {
      objective: request,
      scopeSummary: "Map Gemma 4 model versions and runtime availability.",
      topics: [
        {
          id: "gemma-4-versions-1",
          title: "Gemma 4 versions",
          goal: "Find Gemma 4 model cards and reference pages.",
          priority: 1,
          searchQueries: ["Gemma 4 versions"],
        },
      ],
      risks: [],
      stopConditions: [],
    };
    const brief = __testOnly.buildResearchBrief(request, plan);
    const source = {
      id: "source-1",
      requestedUrl: "https://deepmind.google/models/",
      resolvedUrl: "https://deepmind.google/models/",
      title: "Google DeepMind models",
      description: "Gemma 4 model hub",
      kind: "html",
      extractedWith: "headline-fallback",
      blockedLikely: false,
      fetchedAt: new Date().toISOString(),
      topicIds: ["gemma-4-versions-1"],
      domain: "deepmind.google",
      sourceFamily: "official" as const,
      pageRole: "reference" as const,
      sourceDepth: 0,
      discoveryMethod: "search" as const,
      contentPreview: [
        "Top headlines / links:",
        "1. Gemma 4",
        "   https://deepmind.google/models/gemma/gemma-4/",
        "2. Gemma 4 model card",
        "   https://deepmind.google/models/gemma/gemma-4/model-card/",
        "3. Decorative image",
        "   https://deepmind.google/static/gemma4.png",
        "4. About Google DeepMind",
        "   https://deepmind.google/about/",
      ].join("\n"),
    };

    expect(__testOnly.extractOneHopResearchUrlsFromSource(source, brief)).toEqual([
      "https://deepmind.google/models/gemma/gemma-4/",
      "https://deepmind.google/models/gemma/gemma-4/model-card/",
    ]);
  });

  it("normalizes depth-scout selections to candidate URLs only", () => {
    const candidates = [
      {
        id: "depth-1",
        url: "https://deepmind.google/models/gemma/gemma-4/model-card",
        parentSourceId: "source-1",
        parentTitle: "Gemma 4",
        parentResolvedUrl: "https://deepmind.google/models/gemma/gemma-4/",
        topicIds: ["topic-1"],
        sourceFamily: "official" as const,
        reason: "Model-card link from hub.",
      },
      {
        id: "depth-2",
        url: "https://ollama.com/library/gemma4/tags",
        parentSourceId: "source-2",
        parentResolvedUrl: "https://ollama.com/library/gemma4",
        topicIds: ["topic-1"],
        sourceFamily: "reference_github_docs" as const,
        reason: "Tags link from catalog.",
      },
    ];

    expect(__testOnly.normalizeDepthScoutRecord(
      {
        selectedUrls: [
          "https://deepmind.google/models/gemma/gemma-4/model-card/",
          "https://example.com/invented",
        ],
        rationale: "Select concrete model-card data.",
        openQuestions: ["Check quantization details."],
        confidence: 0.91,
      },
      candidates,
    )).toEqual({
      selectedUrls: ["https://deepmind.google/models/gemma/gemma-4/model-card"],
      rationale: "Select concrete model-card data.",
      openQuestions: ["Check quantization details."],
      confidence: 0.91,
    });

    expect(__testOnly.normalizeDepthScoutRecord(
      {
        selectedUrls: ["https://example.com/invented"],
        rationale: "Invented URL.",
      },
      candidates,
    )).toBeUndefined();
  });

  it("recovers depth-scout URL selections from malformed structured output", () => {
    const candidates = [
      {
        id: "depth-1",
        url: "https://ollama.com/library/gemma4:26b-mxfp8",
        parentSourceId: "source-1",
        parentResolvedUrl: "https://ollama.com/library/gemma4/tags",
        topicIds: ["topic-1"],
        sourceFamily: "reference_github_docs" as const,
        reason: "Tags page linked the concrete runtime variant.",
      },
      {
        id: "depth-2",
        url: "https://ollama.com/library/gemma4:31b-mxfp8",
        parentSourceId: "source-1",
        parentResolvedUrl: "https://ollama.com/library/gemma4/tags",
        topicIds: ["topic-1"],
        sourceFamily: "reference_github_docs" as const,
        reason: "Tags page linked the concrete runtime variant.",
      },
    ];

    const recovered = __testOnly.recoverDepthScoutRecord(
      {
        sessionId: "session-1",
        turnId: "turn-1",
        events: [],
        outputText: [
          "Useful notes before JSON.",
          "{\"selectedUrls\":[\"https://ollama.com/library/gemma4:26b-mxfp8\",\"https://example.com/not-a-candidate\"],",
          "\"rationale\":\"truncated",
        ].join("\n"),
      },
      candidates,
    );

    expect(recovered).toMatchObject({
      selectedUrls: ["https://ollama.com/library/gemma4:26b-mxfp8"],
      confidence: 0.55,
    });
  });

  it("classifies first-party doc domains like react.dev as official coverage", () => {
    expect(__testOnly.classifySourceFamily("https://react.dev/blog")).toBe("official");
    expect(__testOnly.classifySourceFamily("https://nextjs.org/blog")).toBe("official");
    expect(__testOnly.classifySourceFamily("https://github.com/facebook/react/releases")).toBe("reference_github_docs");
  });

  it("prefers article-like mainstream candidates and avoids misclassifying ranking pages as wire", () => {
    const topic = {
      id: "mainstream-article-coverage-2",
      title: "Mainstream article coverage",
      goal: "Read recent mainstream reporting on Iran across multiple outlets.",
      priority: 2,
      searchQueries: ["Iran latest story"],
    };
    const articleCandidate = {
      topicId: topic.id,
      query: "Iran latest story",
      title: "Iran live updates: Vance heads to Islamabad for Iran talks",
      url: "https://abcnews.com/International/live-updates/iran-live-updates-casualties-reported-missile-strikes-israel/?id=131757074",
      snippet: "April 10, 2026 latest article from ABC News.",
      siteName: "abcnews.com",
      sourceFamily: "mainstream_article" as const,
      passNumber: 1,
    };
    const homepageCandidate = {
      topicId: topic.id,
      query: "Iran latest story",
      title: "Breaking News, Latest News and Videos | CNN",
      url: "https://www.cnn.com/",
      snippet: "Latest headlines from CNN.",
      siteName: "cnn.com",
      sourceFamily: "mainstream_article" as const,
      passNumber: 1,
    };
    const metaCandidate = {
      topicId: topic.id,
      query: "Iran latest story",
      title: "Top 10 Best News Sites & Sources In 2026",
      url: "https://www.top10.com/news-websites",
      snippet: "The best news websites and rankings.",
      siteName: "top10.com",
      sourceFamily: "wire" as const,
      passNumber: 1,
    };

    expect(
      __testOnly.prioritizeSearchCandidate(topic, "mainstream_article", articleCandidate, []),
    ).toBeGreaterThan(
      __testOnly.prioritizeSearchCandidate(topic, "mainstream_article", homepageCandidate, []),
    );
    expect(
      __testOnly.classifySourceFamily(metaCandidate.url, "wire", {
        title: metaCandidate.title,
        description: metaCandidate.snippet,
      }),
    ).not.toBe("wire");
  });

  it("flags shallow news syntheses that omit front-page framing, dates, and divergence", () => {
    const request = "Research Iran news across major outlets and compare the latest front-page coverage.";
    const plan = {
      objective: "Compare Iran coverage across major outlets.",
      scopeSummary: "Track front-page emphasis, latest stories, and points of agreement.",
      topics: [
        {
          id: "iran-coverage-1",
          title: "Iran coverage",
          goal: "Compare current Iran coverage across major outlets.",
          priority: 1,
          searchQueries: ["Iran coverage"],
        },
      ],
      risks: [],
      stopConditions: [],
    };
    const brief = __testOnly.buildResearchBrief(request, plan);
    const selfCheck = __testOnly.buildHeuristicSynthesisSelfCheckRecord(
      brief,
      {
        summary: "Outlets covered Iran.",
        reportMarkdown: "# Report\n\nSeveral outlets covered Iran.",
        openQuestions: [],
        sourceIds: ["source-1", "source-2"],
        confidence: 0.58,
      },
      [
        {
          id: "source-1",
          requestedUrl: "https://www.cnn.com/",
          resolvedUrl: "https://www.cnn.com/",
          title: "CNN homepage",
          description: "Front page snapshot",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["mainstream-front-pages-1"],
          domain: "cnn.com",
          sourceFamily: "mainstream_front_page",
          pageRole: "front_page",
          contentPreview: "A deal or a mirage? Iran ceasefire collides with chaos on the ground. 6 hours ago.",
        },
        {
          id: "source-2",
          requestedUrl: "https://abcnews.com/International/live-updates/iran-live-updates-casualties-reported-missile-strikes-israel/?id=131757074",
          resolvedUrl: "https://abcnews.com/International/live-updates/iran-live-updates-casualties-reported-missile-strikes-israel/?id=131757074",
          title: "Iran live updates: Vance heads to Islamabad for Iran talks",
          description: "ABC Iran live updates",
          kind: "html",
          extractedWith: "headline-fallback",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["mainstream-article-coverage-2"],
          domain: "abcnews.com",
          sourceFamily: "mainstream_article",
          pageRole: "article",
          contentPreview: "April 10, 2026: Iran live updates from ABC News.",
        },
      ],
    );

    expect(selfCheck.needsRetry).toBe(true);
    expect(selfCheck.issues.join(" ")).toMatch(/front-page|front page/i);
    expect(selfCheck.issues.join(" ")).toMatch(/concrete dates/i);
    expect(selfCheck.issues.join(" ")).toMatch(/agree|diverge/i);
  });

  it("preserves blocked Reddit discovery results as snippet sources for community topics", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://www.reddit.com/r/ArtemisProgram/">Artemis Program - Reddit</a></h2>
                  <div class="b_caption"><p>Community discussion about NASA's Artemis program.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/official-update">Official update</a></h2>
                  <div class="b_caption"><p>NASA mission update article.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/official-update") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>Official update</title>
              </head>
              <body>
                <article>
                  <p>NASA mission update article.</p>
                </article>
              </body>
            </html>
          `,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    configureMockSearchEndpoints(server.url);

    queuedChatResponses.push(
      sseJsonResponse("plan-community", {
        objective: "Research Artemis community discussion.",
        topics: [
          {
            title: "Community discussion",
            goal: "Summarize Reddit and community discussion about Artemis updates.",
            priority: 1,
            searchQueries: ["Artemis Reddit community updates"],
          },
        ],
        risks: [],
        stopConditions: [],
      }),
      sseJsonResponse("worker-community", {
        summary: "Reddit discussion exists but direct page access was blocked during this run.",
        findings: ["The discovered Reddit result points to an Artemis community hub."],
        sourceRefs: ["source-1"],
        confidence: 0.61,
      }),
      sseJsonResponse("synthesis-community", {
        summary: "Community coverage required a preserved search snippet because Reddit was blocked.",
        reportMarkdown: "# Report\n\nCommunity coverage relied on a preserved Reddit search snippet.",
        sourceIds: ["source-1"],
        confidence: 0.66,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Check Reddit community discussion for Artemis.");
    const sourceIndexText = await readFile(path.join(result.artifactDirectory, "sources", "index.json"), "utf8");

    expect(result.sources).toHaveLength(2);
    expect(sourceIndexText).toContain("Search snippet preserved because the fetched page body was not extractable");
    expect(sourceIndexText).toContain("\"snippetMerged\": true");
    expect(sourceIndexText).toContain("https://www.reddit.com/r/ArtemisProgram/");
    expect(result.dossiers[0]?.sourceIds).toContain("source-1");
  });

  it("preserves blocked official discovery results as snippet sources for official topics", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="https://support.apple.com/en-us/126319">MacBook Pro tech specs - Apple Support</a></h2>
                  <div class="b_caption"><p>Apple Support page with official M5 MacBook Pro specifications.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/secondary-official">Secondary official source</a></h2>
                  <div class="b_caption"><p>Backup official material.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/secondary-official") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <article>
                  <p>Backup official material.</p>
                </article>
              </body>
            </html>
          `,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    configureMockSearchEndpoints(server.url);

    queuedChatResponses.push(
      sseJsonResponse("plan-official", {
        objective: "Research Apple official specs.",
        topics: [
          {
            title: "Official specifications",
            goal: "Summarize official Apple specs and feature confirmations.",
            priority: 1,
            searchQueries: ["Apple M5 Pro official specs"],
          },
        ],
        risks: [],
        stopConditions: [],
      }),
      sseJsonResponse("worker-official", {
        summary: "Official Apple specs required preserving a blocked Apple Support snippet.",
        findings: ["The Apple Support result still provided official metadata even though the page fetch failed."],
        sourceRefs: ["source-1"],
        confidence: 0.64,
      }),
      sseJsonResponse("synthesis-official", {
        summary: "Official coverage was preserved through a blocked first-party search snippet.",
        reportMarkdown: "# Report\n\nOfficial coverage relied on a preserved Apple Support search snippet.",
        sourceIds: ["source-1"],
        confidence: 0.68,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Check Apple official specs for the M5 Pro.");
    const sourceIndexText = await readFile(path.join(result.artifactDirectory, "sources", "index.json"), "utf8");

    expect(sourceIndexText).toContain("https://support.apple.com/en-us/126319");
    expect(
      sourceIndexText.includes("\"kind\": \"search-result\"")
      || sourceIndexText.includes("\"domain\": \"support.apple.com\""),
    ).toBe(true);
    expect(result.dossiers[0]?.sourceIds).toContain("source-1");
  });

  it("prioritizes lower-ranked community search results into discovery fetches", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/blog-a">Blog A</a></h2>
                  <div class="b_caption"><p>Developer blog coverage.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/blog-b">Blog B</a></h2>
                  <div class="b_caption"><p>Another developer blog.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/blog-c">Blog C</a></h2>
                  <div class="b_caption"><p>More blog coverage.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="https://www.redditmedia.com/r/macbookpro/comments/1jsx075/which_macbook_should_i_choose_for_my_developer/">Reddit thread</a></h2>
                  <div class="b_caption"><p>Developer discussion on Reddit about choosing an M5 MacBook Pro.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/blog-a" || url.pathname === "/blog-b" || url.pathname === "/blog-c") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <article>
                  <p>General blog coverage.</p>
                </article>
              </body>
            </html>
          `,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    configureMockSearchEndpoints(server.url);

    queuedChatResponses.push(
      sseJsonResponse("plan-community-priority", {
        objective: "Research developer community discussion.",
        topics: [
          {
            title: "Community discussion",
            goal: "Capture Reddit and community discussion about developer workflows.",
            priority: 1,
            searchQueries: ["MacBook Pro M5 developer workflow reddit"],
          },
        ],
        risks: [],
        stopConditions: [],
      }),
      sseJsonResponse("worker-community-priority", {
        summary: "Community coverage prioritized the Reddit result even though it was ranked fourth in raw search output.",
        findings: ["The discovery ranker surfaced the Reddit result into the fetch set for a community topic."],
        sourceRefs: ["source-1"],
        confidence: 0.66,
      }),
      sseJsonResponse("synthesis-community-priority", {
        summary: "Community ranking recovered the relevant Reddit result.",
        reportMarkdown: "# Report\n\nThe Reddit result was pulled into the discovery set despite being fourth in the raw search list.",
        sourceIds: ["source-1"],
        confidence: 0.69,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Check Reddit discussion for MacBook Pro M5 developer workflows.");
    const sourceIndexText = await readFile(path.join(result.artifactDirectory, "sources", "index.json"), "utf8");

    expect(sourceIndexText).toContain("redditmedia.com/r/macbookpro/comments/1jsx075");
    expect(sourceIndexText).toContain("Search snippet preserved because the fetched page body was not extractable");
    expect(sourceIndexText).toContain("\"snippetMerged\": true");
    expect(result.dossiers[0]?.sourceIds).toContain("source-1");
  });

  it("keeps on-topic ecosystem plans instead of rewriting them into model catalog fallbacks", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/official-rust">Rust 2024 official update</a></h2>
                  <div class="b_caption"><p>Official Rust 2024 edition update and release notes.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/tooling-rust">Rust tooling update</a></h2>
                  <div class="b_caption"><p>Tooling and ecosystem notes for Rust 2024.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/community-rust">Rust 2024 discussion</a></h2>
                  <div class="b_caption"><p>Community discussion about adopting Rust 2024.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/official-rust" || url.pathname === "/tooling-rust" || url.pathname === "/community-rust") {
        const articleByPath: Record<string, { title: string; body: string }> = {
          "/official-rust": {
            title: "Rust 2024 official update",
            body: "Official Rust 2024 edition notes cover language changes and rollout guidance.",
          },
          "/tooling-rust": {
            title: "Rust tooling update",
            body: "Cargo, rustc, and ecosystem crates are documenting Rust 2024 tooling updates.",
          },
          "/community-rust": {
            title: "Rust 2024 discussion",
            body: "Community discussion highlights migration questions and early adoption feedback.",
          },
        };
        const article = articleByPath[url.pathname];
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>${article.title}</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>${article.body}</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-rust-1", {
        objective: "Assess the adoption and tooling impact of the Rust 2024 edition.",
        scopeSummary: "Investigate Rust 2024 adoption, official rollout material, tooling updates, and community response.",
        topics: [
          {
            title: "Rust 2024 Edition Features",
            goal: "Identify key language changes and breaking changes in the 2024 edition.",
            priority: 1,
            searchQueries: [
              "Rust 2024 edition release notes",
              "Rust 2024 edition breaking changes",
              "Rust 2024 edition new features summary",
            ],
          },
          {
            title: "Tooling and Ecosystem Updates",
            goal: "Track updates to cargo, rustc, and essential ecosystem crates.",
            priority: 2,
            searchQueries: [
              "Rust 2024 edition cargo updates",
              "Rust 2024 edition rustc changes",
              "Rust ecosystem tooling updates 2024",
            ],
          },
          {
            title: "Adoption and Community Sentiment",
            goal: "Evaluate how the community is reacting to and implementing the new edition.",
            priority: 3,
            searchQueries: [
              "Rust 2024 edition community discussion reddit",
              "Rust 2024 edition adoption challenges",
              "Rust 2024 edition blog posts",
            ],
          },
        ],
        risks: [
          "Information may be fragmented between official docs and community discussions.",
        ],
        stopConditions: [
          "Stop once official, ecosystem, and community surfaces each have at least one cited source.",
        ],
      }),
      sseJsonResponse("worker-rust-1", {
        summary: "Official Rust 2024 notes cover the language changes and rollout guidance.",
        findings: ["Rust 2024 feature guidance is anchored in official release notes and edition material."],
        sourceRefs: [`${server.url}/official-rust`],
        confidence: 0.74,
      }),
      sseJsonResponse("worker-rust-2", {
        summary: "Tooling updates center on cargo, rustc, and major ecosystem crate readiness.",
        findings: ["Tooling readiness is spread across compiler updates and ecosystem project notes."],
        sourceRefs: [`${server.url}/tooling-rust`],
        confidence: 0.77,
      }),
      sseJsonResponse("worker-rust-3", {
        summary: "Community discussion is focused on migration effort and adoption timing.",
        findings: ["Community feedback highlights migration questions and rollout pacing."],
        sourceRefs: [`${server.url}/community-rust`],
        confidence: 0.7,
      }),
      sseJsonResponse("synthesis-rust-1", {
        summary: "Rust 2024 research stayed on-topic across official, tooling, and community coverage.",
        reportMarkdown: [
          "# Rust 2024",
          "",
          "Official release notes explain the edition changes and rollout guidance.",
          "",
          "Tooling updates span cargo, rustc, and ecosystem crate readiness.",
          "",
          "Community discussion is focused on migration effort and adoption timing.",
        ].join("\n"),
        sourceIds: ["source-1", "source-2", "source-3"],
        confidence: 0.82,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch(
      "Research Rust 2024 edition adoption and the most important current tooling updates. Include official Rust sources, ecosystem blog posts or release notes, and community discussion.",
    );

    expect(result.plan.topics.map((topic) => topic.title)).toEqual([
      "Rust 2024 Edition Features",
      "Tooling and Ecosystem Updates",
      "Adoption and Community Sentiment",
    ]);
    expect(JSON.stringify(result.plan)).not.toContain("Requested Model");
    expect(result.finalReport).toContain("Rust 2024");
    expect(result.sources).toHaveLength(3);
    expect(requests).toHaveLength(5);
  });

  it("repairs nearly valid planner JSON when a stray token appears before closing brackets", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/apple-official">Apple official</a></h2>
                  <div class="b_caption"><p>Apple specification page.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/apple-reviews">Apple review</a></h2>
                  <div class="b_caption"><p>Professional benchmark coverage.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/apple-community">Apple community</a></h2>
                  <div class="b_caption"><p>Community owner impressions.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/apple-official" || url.pathname === "/apple-reviews" || url.pathname === "/apple-community") {
        const bodyByPath: Record<string, string> = {
          "/apple-official": "Apple pages define the official specs and battery claims.",
          "/apple-reviews": "Review sites compare performance and battery results.",
          "/apple-community": "Community threads focus on owner impressions and developer relevance.",
        };
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <article>
                  <p>${bodyByPath[url.pathname]}</p>
                </article>
              </body>
            </html>
          `,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    configureMockSearchEndpoints(server.url);

    const malformedPlannerJson = [
      "{",
      "\"objective\":\"Assess Apple M5 Pro and M5 Max MacBook Pro coverage.\",",
      "\"scopeSummary\":\"Cover official pages, professional reviews, and community owner impressions.\",",
      "\"topics\":[",
      "{\"title\":\"Official Apple Pages\",\"goal\":\"Identify Apple specs and battery claims.\",\"priority\":1,\"searchQueries\":[\"Apple M5 Pro official specs\"]},",
      "{\"title\":\"Review Coverage\",\"goal\":\"Summarize professional benchmark coverage.\",\"priority\":2,\"searchQueries\":[\"Apple M5 Max review benchmarks\"]},",
      "{\"title\":\"Community Feedback\",\"goal\":\"Capture Reddit owner impressions and developer relevance.\",\"priority\":3,\"searchQueries\":[\"Apple M5 Pro Reddit owner impressions\"] ways]}],",
      "\"risks\":[],",
      "\"stopConditions\":[]",
      "}",
    ].join("");

    queuedChatResponses.push(
      sseTextResponse("plan-malformed-1", malformedPlannerJson),
      sseJsonResponse("worker-apple-1", {
        summary: "Apple pages define the official specs and battery claims.",
        findings: ["Official specification pages anchor the hardware baseline."],
        sourceRefs: [`${server.url}/apple-official`],
        confidence: 0.72,
      }),
      sseJsonResponse("worker-apple-2", {
        summary: "Review coverage compares performance and battery outcomes.",
        findings: ["Professional review sites add benchmark context beyond Apple marketing."],
        sourceRefs: [`${server.url}/apple-reviews`],
        confidence: 0.75,
      }),
      sseJsonResponse("worker-apple-3", {
        summary: "Community feedback focuses on owner impressions and developer relevance.",
        findings: ["Owner impressions add experiential signals that specs alone miss."],
        sourceRefs: [`${server.url}/apple-community`],
        confidence: 0.69,
      }),
      sseJsonResponse("synthesis-apple-1", {
        summary: "Apple M5 coverage was recovered from a nearly valid planner JSON response.",
        reportMarkdown: [
          "# Apple M5",
          "",
          "Official pages define the hardware baseline.",
          "",
          "Professional reviews add benchmark context.",
          "",
          "Community feedback adds owner and developer perspective.",
        ].join("\n"),
        sourceIds: ["source-1", "source-2", "source-3"],
        confidence: 0.81,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch(
      "Research Apple M5 Pro and M5 Max MacBook Pro coverage. Check Apple official pages, major review sites, and Reddit owner impressions. Focus on performance, battery, and developer relevance.",
    );

    expect(result.plan.topics.map((topic) => topic.title)).toEqual([
      "Official Apple Pages",
      "Review Coverage",
      "Community Feedback",
    ]);
    expect(result.summary).toContain("recovered from a nearly valid planner JSON response");
    expect(result.sources.length).toBeGreaterThanOrEqual(3);
    expect(result.sources.map((source) => source.resolvedUrl)).toEqual(expect.arrayContaining([
      `${server.url}/apple-official`,
      `${server.url}/apple-reviews`,
      `${server.url}/apple-community`,
    ]));
  });

  it("drops placeholder topic shells that survive planner recovery", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">LM Studio docs</a></h2>
                  <div class="b_caption"><p>LM Studio developer docs.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <article>
                  <p>LM Studio developer docs.</p>
                </article>
              </body>
            </html>
          `,
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    configureMockSearchEndpoints(server.url);

    queuedChatResponses.push(
      sseJsonResponse("plan-placeholder", {
        objective: "Research LM Studio developer docs.",
        topics: [
          {
            title: "LM Studio docs",
            goal: "Summarize LM Studio developer docs.",
            priority: 1,
            searchQueries: ["LM Studio developer docs"],
          },
          {
            title: "Topic 4",
            goal: "Topic 4",
            priority: 4,
            searchQueries: ["Topic 4"],
          },
        ],
        risks: [],
        stopConditions: [],
      }),
      sseJsonResponse("worker-placeholder", {
        summary: "LM Studio docs provide the developer-facing guidance.",
        findings: ["LM Studio documentation is the core developer reference."],
        sourceRefs: [`${server.url}/article-a`],
        confidence: 0.74,
      }),
      sseJsonResponse("synthesis-placeholder", {
        summary: "Placeholder planner topics were dropped before execution.",
        reportMarkdown: "# Report\n\nThe placeholder topic did not survive into execution.",
        sourceIds: ["source-1"],
        confidence: 0.8,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Research LM Studio developer docs.");

    expect(result.plan.topics.map((topic) => topic.title)).toEqual(["LM Studio docs"]);
    expect(requests).toHaveLength(3);
    expect(result.summary).toContain("Placeholder planner topics were dropped");
  });

  it("backfills final report source ids from dossiers when synthesis omits them", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">Gemma article</a></h2>
                  <div class="b_caption"><p>Gemma source coverage.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>Gemma article</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>Gemma source coverage for a single topic.</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Check Gemma coverage.",
        topics: [
          {
            title: "Gemma coverage",
            goal: "Summarize Gemma coverage.",
            priority: 1,
            searchQueries: ["gemma coverage"],
          },
        ],
      }),
      sseJsonResponse("worker-1", {
        summary: "Gemma coverage is grounded in the fetched article.",
        findings: ["The fetched article contains the needed coverage."],
        sourceRefs: [`${server.url}/article-a`],
        confidence: 0.71,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Gemma coverage can still resolve final source ids.",
        reportMarkdown: "# Gemma Coverage\n\nSingle-source summary.",
        sourceIds: [],
        confidence: 0.8,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Check Gemma coverage.");

    expect(result.sourceIds).toEqual(["source-1"]);

    const finalReportJsonText = await readFile(
      path.join(result.artifactDirectory, "final", "report.json"),
      "utf8",
    );
    expect(finalReportJsonText).toContain("\"source-1\"");
  });

  it("salvages plain-text planning output and retries invalid synthesis once", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];

    const plannerNarrative = [
      "Topic 1: Official Gemma releases",
      "Goal: Catalog official Gemma generations and sizes.",
      "Priority: 1.",
      "Queries: \"official gemma releases\", \"google gemma model family\".",
      "",
      "Topic 2: Ollama and LM Studio packaging",
      "Goal: Find how Gemma appears in Ollama and LM Studio.",
      "Priority: 2.",
      "Queries: \"ollama gemma library\", \"lm studio gemma gguf\".",
    ].join("\n");

    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">Official Gemma article</a></h2>
                  <div class="b_caption"><p>Release and sizing notes.</p></div>
                </li>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-b">Local packaging article</a></h2>
                  <div class="b_caption"><p>Packaging notes for Ollama and LM Studio.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a" || url.pathname === "/article-b") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>${url.pathname === "/article-a" ? "Official Gemma article" : "Local packaging article"}</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>${url.pathname === "/article-a"
                      ? "Official pages define canonical Gemma generations and size labels."
                      : "Ollama and LM Studio surface packaged Gemma distributions and GGUF formats."}</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseTextResponse("plan-text-1", plannerNarrative),
      sseJsonResponse("worker-1", {
        summary: "Official releases define the canonical Gemma generations and sizes.",
        findings: ["Official release pages are the source of truth for generations and size labels."],
        sourceRefs: [`${server.url}/article-a`],
        confidence: 0.71,
      }),
      sseJsonResponse("worker-2", {
        summary: "Ollama primarily surfaces packaged Gemma distributions.",
        findings: ["Ollama exposes Gemma through ready-to-run packaging."],
        sourceRefs: [`${server.url}/article-b`],
        confidence: 0.73,
      }),
      sseJsonResponse("worker-3", {
        summary: "Ollama and LM Studio primarily surface packaged Gemma distributions.",
        findings: ["LM Studio surfaces Gemma through packaged downloads and GGUF formats."],
        sourceRefs: [`${server.url}/article-b`],
        confidence: 0.74,
      }),
      sseTextResponse("synthesis-invalid-1", "# Report\n\nThis is markdown, not the required JSON object."),
      sseJsonResponse("synthesis-valid-2", {
        summary: "Gemma research recovered after a synthesis retry.",
        reportMarkdown: [
          "# Gemma Research",
          "",
          "Official release pages define the canonical Gemma generations and sizes.",
          "",
          "Ollama and LM Studio mostly surface packaged Gemma distributions and GGUF formats.",
        ].join("\n"),
        sourceIds: ["source-1", "source-2"],
        confidence: 0.81,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Map Gemma releases plus how they show up in Ollama and LM Studio.");

    expect(result.plan.topics).toHaveLength(3);
    expect(result.plan.topics.map((topic) => topic.title)).toEqual([
      "Official Gemma Models",
      "Gemma on Ollama",
      "Gemma on LM Studio",
    ]);
    expect(result.summary).toContain("recovered after a synthesis retry");
    expect(requests).toHaveLength(6);

    const retryArtifactText = await readFile(
      path.join(result.artifactDirectory, "workers", "coordinator-synthesis-attempt-1", "result.json"),
      "utf8",
    );
    expect(retryArtifactText).toContain("not the required JSON object");
  });

  it("retries malformed worker output and recovers nested source refs", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">Ollama Gemma page</a></h2>
                  <div class="b_caption"><p>Gemma library entries in Ollama.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>Ollama Gemma page</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>Ollama surfaces Gemma through library entries such as gemma, gemma3, and gemma4.</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Inspect Ollama Gemma coverage.",
        topics: [
          {
            title: "Ollama Gemma coverage",
            goal: "Summarize how Gemma appears in Ollama.",
            priority: 1,
            searchQueries: ["ollama gemma library"],
          },
        ],
      }),
      sseJsonResponse("worker-invalid-1", {
        summary: "Ollama lists several Gemma entries. thought: leaked reasoning should trigger a retry.<channel|>```jsonset{",
        confidence: 0.41,
      }),
      sseJsonResponse("worker-valid-2", {
        summary: "Ollama exposes Gemma through named library entries and parameter-size tags.",
        findings: ["Gemma appears in Ollama as packaged entries like gemma, gemma3, and gemma4."],
        models: [
          {
            name: "gemma4:31b",
            sourceRefs: [`${server.url}/article-a`],
          },
        ],
        confidence: 0.79,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Ollama packages Gemma variants as runnable library entries.",
        reportMarkdown: [
          "# Ollama Gemma",
          "",
          "Ollama exposes Gemma through named library entries and size tags.",
        ].join("\n"),
        sourceIds: ["source-1"],
        confidence: 0.82,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Inspect Ollama Gemma coverage.");

    expect(requests).toHaveLength(4);
    expect(result.dossiers[0]?.summary).not.toContain("<channel|>");
    expect(result.dossiers[0]?.summary).not.toContain("thought:");
    expect(result.dossiers[0]?.sourceIds[0]).toMatch(/^source-\d+$/);

    const firstAttemptText = await readFile(
      path.join(result.artifactDirectory, "workers", `${result.plan.topics[0]!.id}-attempt-1`, "result.json"),
      "utf8",
    );
    expect(firstAttemptText).toContain("<channel|>");

    const dossierText = await readFile(
      path.join(result.artifactDirectory, "dossiers", `${result.plan.topics[0]!.id}.json`),
      "utf8",
    );
    expect(dossierText).toMatch(/source-\d+/);
  });

  it("salvages source refs embedded in malformed worker keys without a retry", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">Gemma type source</a></h2>
                  <div class="b_caption"><p>Gemma type coverage.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>Gemma type source</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>Gemma 4 includes dense and MoE variants across multiple size classes.</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Check Gemma type coverage.",
        topics: [
          {
            title: "Gemma Types",
            goal: "Summarize Gemma model types.",
            priority: 1,
            searchQueries: ["gemma model types"],
          },
        ],
      }),
      sseJsonResponse("worker-1", {
        summary: "Gemma spans dense and MoE variants across several size classes.",
        variants: [
          {
            name: "Gemma 4 31B",
            architecture: "Dense",
          },
        ],
        ["sourceRefs: [\"source-1\"]"]: "sourceRefs",
        confidence: 0.78,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Gemma type coverage can recover citations from malformed keys.",
        reportMarkdown: "# Gemma Types\n\nDense and MoE variants are grounded in the fetched source.",
        sourceIds: ["source-1"],
        confidence: 0.82,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Check Gemma type coverage.");

    expect(requests).toHaveLength(3);
    expect(result.dossiers[0]?.sourceIds).toEqual(["source-1"]);
  });

  it("accepts fetched source citations from worker sources arrays", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">Gemma sources page</a></h2>
                  <div class="b_caption"><p>Gemma distribution channels.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>Gemma sources page</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>Gemma is distributed through official documentation, code repositories, and runtime catalogs.</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Map Gemma model sources.",
        topics: [
          {
            title: "Gemma Sources",
            goal: "Summarize where Gemma models are available.",
            priority: 1,
            searchQueries: ["where to download gemma models"],
          },
        ],
      }),
      sseJsonResponse("worker-1", {
        summary: "Gemma is available through official docs, code repositories, and compatible runtimes.",
        sources: [
          {
            id: "source-1",
            url: `${server.url}/article-a`,
            title: "Gemma sources page",
          },
        ],
        confidence: 0.74,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Gemma source coverage accepts source arrays from workers.",
        reportMarkdown: "# Gemma Sources\n\nOfficial and downstream distribution paths are grounded in the fetched source.",
        sourceIds: ["source-1"],
        confidence: 0.8,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Map Gemma model sources.");

    expect(requests).toHaveLength(3);
    expect(result.dossiers[0]?.sourceIds).toEqual(["source-1"]);
  });

  it("salvages nested supporting_sources citations without a retry", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">Gemma type source</a></h2>
                  <div class="b_caption"><p>Gemma model type coverage.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>Gemma type source</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>Gemma 4 spans edge, dense, and mixture-of-experts deployment types.</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Summarize Gemma model types.",
        topics: [
          {
            title: "Gemma Model Types",
            goal: "Summarize Gemma model types and sizes.",
            priority: 1,
            searchQueries: ["gemma model types"],
          },
        ],
      }),
      sseJsonResponse("worker-1", {
        summary: "Gemma spans edge, dense, and MoE deployment types.",
        model_types: [
          {
            name: "Gemma 4 E2B",
            supporting_sources: ["source-1"],
          },
        ],
        confidence: 0.76,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Gemma model type coverage salvages nested supporting source refs.",
        reportMarkdown: "# Gemma Model Types\n\nNested supporting source refs are preserved.",
        sourceIds: ["source-1"],
        confidence: 0.8,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Summarize Gemma model types.");

    expect(requests).toHaveLength(3);
    expect(result.dossiers[0]?.sourceIds).toEqual(["source-1"]);
  });

  it("strips leaked field prefixes from planner topic titles and goals", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${server.url}/article-a">LM Studio Gemma page</a></h2>
                  <div class="b_caption"><p>LM Studio Gemma packaging.</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-a") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>LM Studio Gemma page</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>LM Studio hosts Gemma model pages for local download and inspection.</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "objective: map Gemma packaging surfaces",
        topics: [
          {
            title: "title: LM Studio's Model Search results for Gemma",
            goal: "goal: Catalog LM Studio Gemma model pages.",
            priority: 1,
            searchQueries: ["LM Studio Gemma models"],
          },
        ],
      }),
      sseJsonResponse("worker-1", {
        summary: "LM Studio surfaces Gemma through model detail pages and downloadable artifacts.",
        findings: ["LM Studio model pages help identify Gemma family packaging for local use."],
        sourceRefs: [`${server.url}/article-a`],
        confidence: 0.76,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Planner cleanup keeps LM Studio topic labels readable.",
        reportMarkdown: [
          "# LM Studio Gemma",
          "",
          "LM Studio model pages make Gemma packaging easier to inspect.",
        ].join("\n"),
        sourceIds: ["source-1"],
        confidence: 0.8,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch("Map Gemma packaging surfaces.");

    expect(result.plan.objective).toBe("map Gemma packaging surfaces");
    expect(result.plan.topics[0]?.title).toBe("LM Studio's Model Search results for Gemma");
    expect(result.plan.topics[0]?.goal).toBe("Catalog LM Studio Gemma model pages.");
  });

  it("expands under-scoped multi-provider plans and keeps topic workers off search_web", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        const resultUrl =
          query.includes("ollama")
            ? `${server.url}/article-ollama`
            : query.includes("lm studio")
              ? `${server.url}/article-lmstudio`
              : query.includes("hugging face")
                ? `${server.url}/article-huggingface`
                : `${server.url}/article-official`;
        const resultTitle =
          query.includes("ollama")
            ? "Ollama Gemma tags"
            : query.includes("lm studio")
              ? "LM Studio Gemma models"
              : query.includes("hugging face")
                ? "Hugging Face Gemma checkpoints"
                : "Official Gemma models";
        const resultSnippet =
          query.includes("ollama")
            ? "Ollama library coverage."
            : query.includes("lm studio")
              ? "LM Studio packaging coverage."
              : query.includes("hugging face")
                ? "Hugging Face checkpoint coverage."
                : "Official family coverage.";

        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${resultUrl}">${resultTitle}</a></h2>
                  <div class="b_caption"><p>${resultSnippet}</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname.startsWith("/article-")) {
        const articleByPath: Record<string, { title: string; body: string }> = {
          "/article-official": {
            title: "Official Gemma models",
            body: "Google publishes the canonical Gemma family and model naming.",
          },
          "/article-ollama": {
            title: "Ollama Gemma tags",
            body: "Ollama exposes Gemma through named library entries and parameter-size tags.",
          },
          "/article-lmstudio": {
            title: "LM Studio Gemma models",
            body: "LM Studio surfaces Gemma through model pages and GGUF-oriented downloads.",
          },
          "/article-huggingface": {
            title: "Hugging Face Gemma checkpoints",
            body: "Hugging Face hosts Gemma checkpoints, variants, and documentation references.",
          },
        };
        const article = articleByPath[url.pathname];
        if (!article) {
          throw new Error(`Unhandled article route: ${request.path}`);
        }
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>${article.title}</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>${article.body}</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Research Gemma variations across local runtimes.",
        topics: [
          {
            title: "Official Gemma variations",
            goal: "Summarize official Gemma versions.",
            priority: 1,
            searchQueries: ["official gemma models"],
          },
        ],
      }),
      sseJsonResponse("worker-official-1", {
        summary: "Official Gemma pages define the canonical family and naming.",
        findings: ["Official sources define the model family baseline."],
        sourceRefs: [`${server.url}/article-official`],
        confidence: 0.71,
      }),
      sseJsonResponse("worker-ollama-1", {
        summary: "Ollama packages Gemma as runnable library variants.",
        findings: ["Ollama uses library tags to expose Gemma variants."],
        sourceRefs: [`${server.url}/article-ollama`],
        confidence: 0.74,
      }),
      sseJsonResponse("worker-lmstudio-1", {
        summary: "LM Studio surfaces Gemma through downloadable model pages.",
        findings: ["LM Studio coverage is tied to model-page packaging and GGUF downloads."],
        sourceRefs: [`${server.url}/article-lmstudio`],
        confidence: 0.75,
      }),
      sseJsonResponse("worker-hf-1", {
        summary: "Hugging Face hosts Gemma checkpoints and ecosystem variants.",
        findings: ["Hugging Face is the broadest checkpoint distribution surface in this run."],
        sourceRefs: [`${server.url}/article-huggingface`],
        confidence: 0.78,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Gemma coverage now spans official, Ollama, LM Studio, and Hugging Face sources.",
        reportMarkdown: [
          "# Gemma Coverage",
          "",
          "Official sources define the canonical model family.",
          "",
          "Ollama, LM Studio, and Hugging Face expose distinct packaging and distribution surfaces.",
        ].join("\n"),
        sourceIds: ["source-1", "source-2", "source-3", "source-4"],
        confidence: 0.83,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch(
      "I need to understand all the variations of Gemma on Ollama, LM Studio, and Hugging Face.",
    );

    expect(result.plan.topics.map((topic) => topic.title)).toEqual([
      "Official Gemma Models",
      "Gemma on Ollama",
      "Gemma on LM Studio",
      "Gemma on Hugging Face",
    ]);
    expect(result.sources).toHaveLength(4);
    expect(requests).toHaveLength(6);
    for (const request of requests.slice(1, 5)) {
      expect(JSON.stringify(request)).not.toContain("search_web");
      expect(JSON.stringify(request)).toContain("Do not call tools.");
    }
  });

  it("expands catalog-style requests into release, type, and source topics", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const requests: Array<Record<string, unknown>> = [];
    const queuedChatResponses: string[][] = [];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        requests.push(request.bodyJson as Record<string, unknown>);
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        const resultUrl =
          query.includes("official") || query.includes("release")
            ? `${server.url}/article-releases`
            : query.includes("ollama") || query.includes("hugging face") || query.includes("source")
              ? `${server.url}/article-sources`
              : `${server.url}/article-types`;
        const resultTitle =
          query.includes("official") || query.includes("release")
            ? "Gemma releases"
            : query.includes("ollama") || query.includes("hugging face") || query.includes("source")
              ? "Gemma sources"
              : "Gemma types";
        const resultSnippet =
          query.includes("official") || query.includes("release")
            ? "Release lineage coverage."
            : query.includes("ollama") || query.includes("hugging face") || query.includes("source")
              ? "Source surface coverage."
              : "Variant and size coverage.";

        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <body>
                <li class="b_algo">
                  <h2><a href="${resultUrl}">${resultTitle}</a></h2>
                  <div class="b_caption"><p>${resultSnippet}</p></div>
                </li>
              </body>
            </html>
          `,
        };
      }

      if (url.pathname === "/article-releases" || url.pathname === "/article-types" || url.pathname === "/article-sources") {
        const articleByPath: Record<string, { title: string; body: string }> = {
          "/article-releases": {
            title: "Gemma releases",
            body: "Official sources outline Gemma 1, Gemma 2, Gemma 3, and Gemma 4 release lineage.",
          },
          "/article-types": {
            title: "Gemma types",
            body: "Gemma spans base, instruction-tuned, code, multimodal, and size-specific variants.",
          },
          "/article-sources": {
            title: "Gemma sources",
            body: "Gemma appears across official docs, Hugging Face checkpoints, and Ollama packaging surfaces.",
          },
        };
        const article = articleByPath[url.pathname];
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: `
            <html>
              <head>
                <title>${article.title}</title>
              </head>
              <body>
                <main>
                  <article>
                    <p>${article.body}</p>
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
    configureMockSearchEndpoints(server.url);
    queuedChatResponses.push(
      sseJsonResponse("plan-1", {
        objective: "Research and summarize all available versions of Gemma models, including their types and sources.",
        topics: [
          {
            title: "Gemma Model Family Overview",
            goal: "Identify all versions and iterations of Gemma models available.",
            priority: 1,
            searchQueries: [
              "all versions of Google Gemma models",
              "Gemma model family architecture and variants",
              "Gemma 2 versions and sizes",
              "Gemma official sources",
            ],
          },
        ],
      }),
      sseJsonResponse("worker-releases-1", {
        summary: "Official Gemma sources define the release lineage from Gemma 1 through Gemma 4.",
        findings: ["Release notes and official family pages establish the generation sequence."],
        sourceRefs: [`${server.url}/article-releases`],
        confidence: 0.73,
      }),
      sseJsonResponse("worker-types-1", {
        summary: "Gemma types span base, instruction-tuned, code, multimodal, and size-specific variants.",
        findings: ["Variant coverage depends on both modality and packaging form."],
        sourceRefs: [`${server.url}/article-types`],
        confidence: 0.76,
      }),
      sseJsonResponse("worker-sources-1", {
        summary: "Gemma sources span official docs plus packaging surfaces like Hugging Face and Ollama.",
        findings: ["Distribution sources matter because they surface different packaging and metadata."],
        sourceRefs: [`${server.url}/article-sources`],
        confidence: 0.79,
      }),
      sseJsonResponse("synthesis-1", {
        summary: "Gemma research now separates release lineage, model types, and source surfaces.",
        reportMarkdown: [
          "# Gemma Catalog",
          "",
          "Official releases define the Gemma generation lineage.",
          "",
          "Model types cover variants, modalities, and size classes.",
          "",
          "Source surfaces span official docs, Hugging Face, and Ollama.",
        ].join("\n"),
        sourceIds: ["source-1", "source-2", "source-3"],
        confidence: 0.84,
      }),
    );

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    const result = await session.runResearch(
      "I'd like you to research all the versions of Gemma models available and report back a summary of the models, types, sources.",
    );

    expect(result.plan.topics.map((topic) => topic.title)).toEqual([
      "Gemma Release Lineage",
      "Gemma Types",
      "Gemma Sources",
    ]);
    expect(result.sources).toHaveLength(3);
    expect(requests).toHaveLength(5);
    expect(result.finalReport).toContain("generation lineage");
    expect(result.finalReport).toContain("Source surfaces");
  });

  it("fails the run when a worker cites unfetched URLs", async () => {
    const workingDirectory = await createWorkspace();
    process.env.GEMMA_DESKTOP_DISABLE_RESEARCH_FALLBACK_URLS = "1";
    const queuedChatResponses = [
      sseJsonResponse("plan-1", {
        objective: "Check Gemma coverage.",
        topics: [
          {
            title: "Coverage",
            goal: "Summarize Gemma coverage.",
            priority: 1,
            searchQueries: ["gemma coverage"],
          },
        ],
      }),
      sseJsonResponse("worker-1", {
        summary: "Coverage summary.",
        findings: ["This worker only searched and never fetched sources."],
        ["sourceRefs Provide the exact URLs used for research"]: ["https://example.com/unfetched"],
        confidence: 0.55,
      }),
      sseJsonResponse("worker-2", {
        summary: "Coverage summary.",
        findings: ["This worker only searched and never fetched sources."],
        ["sourceRefs Provide the exact URLs used for research"]: ["https://example.com/unfetched"],
        confidence: 0.55,
      }),
    ];

    const server = await createMockServer((request) => {
      const url = new URL(request.path, "http://127.0.0.1");

      if (url.pathname === "/health") {
        return { status: 200, text: "ok" };
      }

      if (url.pathname === "/v1/models") {
        return { json: { data: [{ id: "mock-model" }] } };
      }

      if (url.pathname === "/v1/chat/completions") {
        const next = queuedChatResponses.shift();
        if (!next) {
          throw new Error("Unexpected extra chat request.");
        }
        return { sse: next };
      }

      if (url.pathname === "/html") {
        return {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
          text: "<html><body><p>No results</p></body></html>",
        };
      }

      throw new Error(`Unhandled route: ${request.path}`);
    });
    cleanup.push(server.close);
    configureMockSearchEndpoints(server.url);

    const gemmaDesktop = await createGemmaDesktop({
      workingDirectory,
      adapters: [createLlamaCppServerAdapter({ baseUrl: server.url })],
    });
    const session = await gemmaDesktop.sessions.create({
      runtime: "llamacpp-server",
      model: "mock-model",
      mode: "cowork",
      workingDirectory,
    });

    await expect(
      session.runResearch("Check Gemma coverage."),
    ).rejects.toThrow(/cited URLs without fetching them/i);
  });
});
