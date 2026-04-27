import { describe, expect, it } from "vitest";
import { __testOnly } from "../packages/sdk-node/src/research.js";

describe("research content-quality hardening", () => {
  describe("assessContentQuality", () => {
    it("flags short bodies as low-quality", () => {
      const result = __testOnly.assessContentQuality("short body", 25);
      expect(result.lowQuality).toBe(true);
      expect(result.reason).toBe("too-short");
    });

    it("flags JWT-heavy extractions even when length passes", () => {
      const jwt = "eyJ" + "A".repeat(800);
      const result = __testOnly.assessContentQuality(jwt, jwt.length);
      expect(result.lowQuality).toBe(true);
    });

    it("flags bodies with too few words", () => {
      const padded = "token".repeat(200);
      const result = __testOnly.assessContentQuality(padded, padded.length);
      expect(result.lowQuality).toBe(true);
    });

    it("accepts a normal English article body as high-quality", () => {
      const prose =
        "Google unveiled three Gemini CLI sessions at Cloud Next 2026 this week. " +
        "The programming highlights how the tool evolves from a basic command-line helper " +
        "into an enterprise-grade developer agent, with modular extensions, persistent policies, " +
        "and a showcase booth running daily demonstrations throughout the conference in Las Vegas.";
      const result = __testOnly.assessContentQuality(prose, prose.length);
      expect(result.lowQuality).toBe(false);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("extractRelevanceKeywords", () => {
    it("returns meaningful keywords while dropping stopwords", () => {
      const keywords = __testOnly.extractRelevanceKeywords([
        "List of Gemini CLI sessions at Cloud Next 2026",
        "Catalog all the sessions",
      ]);
      expect(keywords).toContain("gemini");
      expect(keywords).toContain("cloud");
      expect(keywords).toContain("2026");
      expect(keywords).not.toContain("list");
      expect(keywords).not.toContain("the");
      expect(keywords).not.toContain("sessions");
    });

    it("dedupes across inputs and respects the limit", () => {
      const keywords = __testOnly.extractRelevanceKeywords(
        ["gemini cloud next", "gemini cli cloud next 2026", undefined],
        3,
      );
      expect(keywords.length).toBeLessThanOrEqual(3);
      expect(new Set(keywords).size).toBe(keywords.length);
    });
  });

  describe("sourceMatchesKeywords", () => {
    it("returns true only when keyword hits are present", () => {
      const source = {
        title: "Deploy and Govern Gemini CLI at Scale",
        description: "Session 3911930 focuses on enterprise rollout",
        contentPreview: "Cloud Next 2026 session for Gemini CLI governance",
      };
      expect(
        __testOnly.sourceMatchesKeywords(source, ["gemini", "cloud", "next"]),
      ).toBe(true);
    });

    it("returns false when the source is off-topic", () => {
      const astrology = {
        title: "Gemini Horoscope Today",
        description: "Daily zodiac predictions",
        contentPreview: "Your astrology reading for Gemini today mentions love and luck.",
      };
      expect(
        __testOnly.sourceMatchesKeywords(astrology, ["googlecloudevents", "cli", "session"]),
      ).toBe(false);
    });

    it("passes when no keywords are configured", () => {
      expect(
        __testOnly.sourceMatchesKeywords(
          { title: "", description: "", contentPreview: "" },
          [],
        ),
      ).toBe(true);
    });
  });

  describe("isCatalogStyleRequest", () => {
    it("detects catalog-style requests across common phrasings", () => {
      expect(__testOnly.isCatalogStyleRequest("List of sessions at WWDC")).toBe(true);
      expect(__testOnly.isCatalogStyleRequest("Give me the full agenda")).toBe(true);
      expect(__testOnly.isCatalogStyleRequest("Show the schedule for Cloud Next 2026")).toBe(true);
      expect(__testOnly.isCatalogStyleRequest("All the sessions about Gemini CLI")).toBe(true);
    });

    it("treats org-announcement sweeps as catalog requests", () => {
      expect(
        __testOnly.isCatalogStyleRequest(
          "What are all the announcements from Google DeepMind in March & April",
        ),
      ).toBe(true);
      expect(
        __testOnly.isCatalogStyleRequest("All the releases from Anthropic this quarter"),
      ).toBe(true);
      expect(__testOnly.isCatalogStyleRequest("list of models from Mistral")).toBe(true);
      expect(__testOnly.isCatalogStyleRequest("every announcement OpenAI made in Q2")).toBe(true);
    });

    it("ignores requests that are not asking for enumeration", () => {
      expect(__testOnly.isCatalogStyleRequest("Explain how the Gemini CLI works")).toBe(false);
      expect(__testOnly.isCatalogStyleRequest("Compare Gemini and GPT")).toBe(false);
    });
  });

  describe("extractCatalogDomainHints", () => {
    it("pulls likely host hints when the request mentions a domain", () => {
      const hints = __testOnly.extractCatalogDomainHints(
        "List all sessions on googlecloudevents.com for Cloud Next 2026",
      );
      expect(hints).toContain("googlecloudevents.com");
    });

    it("returns an empty list when no domains appear", () => {
      const hints = __testOnly.extractCatalogDomainHints("List sessions about Gemini CLI");
      expect(hints).toEqual([]);
    });
  });

  describe("buildPlanningPrompt catalog rule", () => {
    it("injects a site: enumeration hint for catalog-style requests", () => {
      const prompt = __testOnly.buildPlanningPrompt(
        "List every Gemini CLI session on googlecloudevents.com at Cloud Next 2026",
        "deep",
      );
      expect(prompt).toMatch(/site:<domain>/);
      expect(prompt).toMatch(/googlecloudevents\.com/);
    });

    it("does not inject the catalog rule for non-catalog requests", () => {
      const prompt = __testOnly.buildPlanningPrompt(
        "Explain how React 19 server components work",
        "deep",
      );
      expect(prompt).not.toMatch(/site:<domain>/);
    });
  });

  describe("buildCoverageAssessment with quality signals", () => {
    function buildBrief() {
      return {
        objective: "List Gemini CLI sessions at Cloud Next 2026",
        scopeSummary: "Find the complete catalog on googlecloudevents.com.",
        taskType: "validation-explainer" as const,
        focusQuery: "Gemini CLI sessions Cloud Next 2026 googlecloudevents.com",
        subject: "Gemini CLI Cloud Next 2026",
        requiredSourceFamilies: ["reference_github_docs" as const],
        optionalSourceFamilies: [],
        reportRequirements: [],
      };
    }

    it("flags pools dominated by low-quality content", () => {
      const brief = buildBrief();
      const request = brief.objective;
      const plan = {
        objective: brief.objective,
        scopeSummary: brief.scopeSummary,
        topics: [
          {
            id: "sessions-1",
            title: "Gemini CLI sessions",
            goal: "Enumerate the CLI sessions at Cloud Next 2026",
            priority: 1,
            searchQueries: ["Gemini CLI Cloud Next 2026 sessions"],
          },
        ],
        risks: [],
        stopConditions: [],
      };
      const { coveragePlan } = __testOnly.buildCoveragePlan(request, plan, brief, "deep");
      const topicId = coveragePlan.queryGroups[0]!.topicId;
      const sources = Array.from({ length: 5 }, (_, idx) => ({
        id: `source-${idx + 1}`,
        requestedUrl: `https://example.com/${idx}`,
        resolvedUrl: `https://example.com/${idx}`,
        title: `Session ${idx}`,
        description: "JWT-only body",
        kind: "html",
        extractedWith: "readability",
        blockedLikely: true,
        fetchedAt: new Date().toISOString(),
        topicIds: [topicId],
        domain: "example.com",
        sourceFamily: "reference_github_docs" as const,
        pageRole: "other" as const,
        contentPreview: "eyJ" + "A".repeat(400),
        contentLength: 420,
        lowQualityContent: true,
      }));

      const assessment = __testOnly.buildCoverageAssessment(brief, coveragePlan, sources, 1);
      expect(assessment.sufficient).toBe(false);
      const lowQualityGap = assessment.gaps.find((gap) =>
        /low-quality/i.test(gap),
      );
      expect(lowQualityGap).toBeDefined();
      expect(assessment.missingTopicIds).toContain(topicId);
    });

    it("does not mark exhausted low-quality coverage as sufficient just because passes ran out", () => {
      const brief = buildBrief();
      const request = brief.objective;
      const plan = {
        objective: brief.objective,
        scopeSummary: brief.scopeSummary,
        topics: [
          {
            id: "sessions-1",
            title: "Gemini CLI sessions",
            goal: "Enumerate the CLI sessions at Cloud Next 2026",
            priority: 1,
            searchQueries: ["Gemini CLI Cloud Next 2026 sessions"],
          },
        ],
        risks: [],
        stopConditions: [],
      };
      const { coveragePlan } = __testOnly.buildCoveragePlan(request, plan, brief, "deep");
      const topicId = coveragePlan.queryGroups[0]!.topicId;
      const sources = Array.from({ length: 5 }, (_, idx) => ({
        id: `source-${idx + 1}`,
        requestedUrl: `https://example.com/${idx}`,
        resolvedUrl: `https://example.com/${idx}`,
        title: `Session ${idx}`,
        description: "JWT-only body",
        kind: "html",
        extractedWith: "readability",
        blockedLikely: true,
        fetchedAt: new Date().toISOString(),
        topicIds: [topicId],
        domain: "example.com",
        sourceFamily: "reference_github_docs" as const,
        pageRole: "other" as const,
        contentPreview: "eyJ" + "A".repeat(400),
        contentLength: 420,
        lowQualityContent: true,
      }));

      const assessment = __testOnly.buildCoverageAssessment(
        brief,
        coveragePlan,
        sources,
        coveragePlan.maxPasses,
      );
      expect(assessment.sufficient).toBe(false);
      expect(assessment.missingSourceFamilies).toContain("reference_github_docs");
    });

    it("rewrites [source-N] markers as titled inline markdown links and does not append a Sources section", () => {
      const sources = [
        {
          id: "source-1",
          requestedUrl: "https://deepmind.google/blog/genie-3/",
          resolvedUrl: "https://deepmind.google/blog/genie-3/",
          title: "Genie 3: A new frontier for world models",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["topic-1"],
          domain: "deepmind.google",
          sourceFamily: "official" as const,
          pageRole: "article" as const,
          contentPreview: "body",
        },
        {
          id: "source-2",
          requestedUrl: "https://reuters.com/article",
          resolvedUrl: "https://reuters.com/article",
          title: "",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["topic-1"],
          domain: "reuters.com",
          sourceFamily: "mainstream_article" as const,
          pageRole: "article" as const,
          contentPreview: "body",
        },
      ];
      const enhanced = __testOnly.enhanceReportWithSourceLinks(
        "# Report\n\nGenie 3 announced [source-1]. Reuters covered the merger [source-2].",
        sources,
        ["source-1", "source-2"],
      );
      expect(enhanced).toContain(
        "[Genie 3: A new frontier for world models](https://deepmind.google/blog/genie-3/)",
      );
      expect(enhanced).toContain("[https://reuters.com/article](https://reuters.com/article)");
      expect(enhanced).not.toMatch(/\[source-\d+\]/);
      expect(enhanced).not.toMatch(/^##\s+Sources/im);
    });

    it("expands grouped [source-N, source-M, ...] brackets into multiple titled inline links", () => {
      const sources = [
        {
          id: "source-2",
          requestedUrl: "https://foxnews.com/",
          resolvedUrl: "https://foxnews.com/",
          title: "Fox News",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["topic-1"],
          domain: "foxnews.com",
          sourceFamily: "mainstream_front_page" as const,
          pageRole: "front_page" as const,
          contentPreview: "body",
        },
        {
          id: "source-14",
          requestedUrl: "https://deepmind.google/blog/",
          resolvedUrl: "https://deepmind.google/blog/",
          title: "DeepMind News",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["topic-1"],
          domain: "deepmind.google",
          sourceFamily: "official" as const,
          pageRole: "article" as const,
          contentPreview: "body",
        },
        {
          id: "source-23",
          requestedUrl: "https://cloud.google.com/blog",
          resolvedUrl: "https://cloud.google.com/blog",
          title: "Google Cloud blog",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["topic-1"],
          domain: "cloud.google.com",
          sourceFamily: "official" as const,
          pageRole: "article" as const,
          contentPreview: "body",
        },
      ];
      const enhanced = __testOnly.enhanceReportWithSourceLinks(
        "The Gemma 4 release was covered [source-2, source-14, source-23].",
        sources,
        ["source-2", "source-14", "source-23"],
      );
      expect(enhanced).toContain("[Fox News](https://foxnews.com/)");
      expect(enhanced).toContain("[DeepMind News](https://deepmind.google/blog/)");
      expect(enhanced).toContain("[Google Cloud blog](https://cloud.google.com/blog)");
      expect(enhanced).not.toMatch(/\[source-\d+/);
    });

    it("replaces [source-N](url) with [Title](registry-url) so link text is never just 'source-N'", () => {
      const sources = [
        {
          id: "source-25",
          requestedUrl: "https://techcrunch.com/2026/03/24/agile-robots/",
          resolvedUrl: "https://techcrunch.com/2026/03/24/agile-robots/",
          title: "Agile Robots partners with Google DeepMind",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["topic-1"],
          domain: "techcrunch.com",
          sourceFamily: "mainstream_article" as const,
          pageRole: "article" as const,
          contentPreview: "body",
        },
      ];
      const enhanced = __testOnly.enhanceReportWithSourceLinks(
        "Agile Robots partnership [source-25](https://techcrunch.com/2026/03/24/agile-robots/).",
        sources,
        ["source-25"],
      );
      expect(enhanced).toContain(
        "[Agile Robots partners with Google DeepMind](https://techcrunch.com/2026/03/24/agile-robots/)",
      );
      expect(enhanced).not.toContain("[source-25]");
    });

    it("preserves natural inline markdown links without appending a Sources section", () => {
      const sources = [
        {
          id: "source-1",
          requestedUrl: "https://example.com/",
          resolvedUrl: "https://example.com/",
          title: "Example",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: ["topic-1"],
          domain: "example.com",
          sourceFamily: "official" as const,
          pageRole: "article" as const,
          contentPreview: "body",
        },
      ];
      const report = "# Report\n\nThe [Example announcement](https://example.com/) explained the update.";
      const enhanced = __testOnly.enhanceReportWithSourceLinks(report, sources, ["source-1"]);
      expect(enhanced).toBe(report);
      expect(enhanced).not.toMatch(/^##\s+Sources/im);
    });

    it("schedules hub-page follow-up queries when an official reference is fetched without subpages", () => {
      const brief = {
        objective: "List all Google DeepMind announcements from March and April 2026.",
        scopeSummary: "Identify every model, product, and research release from DeepMind in that window.",
        taskType: "validation-explainer" as const,
        focusQuery: "All Google DeepMind announcements March and April 2026",
        subject: "Google DeepMind announcements March April 2026",
        requiredSourceFamilies: ["reference_github_docs" as const],
        optionalSourceFamilies: ["official" as const],
        reportRequirements: [],
      };
      const request = "What are all the announcements from Google DeepMind in March & April 2026";
      const plan = {
        objective: brief.objective,
        scopeSummary: brief.scopeSummary,
        topics: [
          {
            id: "deepmind-announcements",
            title: "DeepMind announcements",
            goal: "List every release.",
            priority: 1,
            searchQueries: ["Google DeepMind announcements March 2026"],
          },
        ],
        risks: [],
        stopConditions: [],
      };
      const { coveragePlan } = __testOnly.buildCoveragePlan(request, plan, brief, "deep");
      const topicId = coveragePlan.queryGroups[0]!.topicId;
      const sources = [
        {
          id: "source-1",
          requestedUrl: "https://deepmind.google/",
          resolvedUrl: "https://deepmind.google/",
          title: "Google DeepMind",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: [topicId],
          domain: "deepmind.google",
          sourceFamily: "official" as const,
          pageRole: "reference" as const,
          contentPreview: "Slide 1 of 6 ... Gemini Audio Advanced real-time audio models ...",
        },
        {
          id: "source-2",
          requestedUrl: "https://deepmind.google/models/",
          resolvedUrl: "https://deepmind.google/models/",
          title: "Models",
          description: "",
          kind: "html",
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: [topicId],
          domain: "deepmind.google",
          sourceFamily: "official" as const,
          pageRole: "reference" as const,
          contentPreview: "Gemma 4 ... Lyria 3 ... Gemini Audio ...",
        },
      ];

      const assessment = __testOnly.buildCoverageAssessment(brief, coveragePlan, sources, 1);
      const hubGap = assessment.gaps.find((gap) => /subpages not yet enumerated/i.test(gap));
      expect(hubGap).toBeDefined();
      const followUpQueries = assessment.followUpQueriesByTopic.get(topicId) ?? [];
      expect(followUpQueries.some((query) => /^site:deepmind\.google/.test(query))).toBe(true);
      const followUpSeeds = assessment.followUpSeedUrlsByTopic.get(topicId) ?? [];
      expect(followUpSeeds.some((seed) => /deepmind\.google\/blog\//.test(seed))).toBe(true);
    });

    it("flags pools dominated by off-topic sources", () => {
      const brief = buildBrief();
      const request = brief.objective;
      const plan = {
        objective: brief.objective,
        scopeSummary: brief.scopeSummary,
        topics: [
          {
            id: "sessions-1",
            title: "Gemini CLI sessions",
            goal: "Enumerate the CLI sessions at Cloud Next 2026",
            priority: 1,
            searchQueries: ["Gemini CLI Cloud Next 2026 sessions"],
          },
        ],
        risks: [],
        stopConditions: [],
      };
      const { coveragePlan } = __testOnly.buildCoveragePlan(request, plan, brief, "deep");
      const topicId = coveragePlan.queryGroups[0]!.topicId;
      const offTopicBody =
        "Your Gemini horoscope predicts a calm day ahead. The zodiac sign of Gemini " +
        "loves reading daily astrology forecasts and relying on love predictions.";
      const sources = Array.from({ length: 6 }, (_, idx) => ({
        id: `source-${idx + 1}`,
        requestedUrl: `https://astro-site-${idx}.com/`,
        resolvedUrl: `https://astro-site-${idx}.com/`,
        title: "Gemini Horoscope Today",
        description: "Daily zodiac",
        kind: "html",
        extractedWith: "readability",
        blockedLikely: false,
        fetchedAt: new Date().toISOString(),
        topicIds: [topicId],
        domain: `astro-site-${idx}.com`,
        sourceFamily: "mainstream_article" as const,
        pageRole: "article" as const,
        contentPreview: offTopicBody,
        contentLength: offTopicBody.length,
        offTopic: true,
      }));

      const assessment = __testOnly.buildCoverageAssessment(brief, coveragePlan, sources, 1);
      const offTopicGap = assessment.gaps.find((gap) => /off-topic/i.test(gap));
      expect(offTopicGap).toBeDefined();
    });
  });

  describe("citationless absence recovery helpers", () => {
    it("recognizes dossiers that explicitly state the evidence is absent or insufficient", () => {
      expect(
        __testOnly.dossierStatesEvidenceIsAbsent({
          summary: "The provided evidence contains no information about the requested announcements.",
          findings: [],
          openQuestions: ["No relevant coverage was found in the available sources."],
        }),
      ).toBe(true);

      expect(
        __testOnly.dossierStatesEvidenceIsAbsent({
          summary: "DeepMind announced two new products in April 2026.",
          findings: ["One post introduced a new robotics model."],
          openQuestions: [],
        }),
      ).toBe(false);
    });

    it("prefers front-page evidence when recovering citations for front-page topics", () => {
      const topic = {
        id: "mainstream-front-pages-1",
        title: "Mainstream front pages",
        goal: "Capture what outlets put prominently on their front pages.",
        priority: 1,
        searchQueries: ["deepmind front page coverage"],
      };
      const sources = [
        {
          id: "source-3",
          requestedUrl: "https://example.com/article",
          resolvedUrl: "https://example.com/article",
          title: "Article",
          description: "",
          kind: "html" as const,
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: [topic.id],
          domain: "example.com",
          sourceFamily: "mainstream_article" as const,
          pageRole: "article" as const,
          contentPreview: "body",
        },
        {
          id: "source-1",
          requestedUrl: "https://foxnews.com/",
          resolvedUrl: "https://foxnews.com/",
          title: "Fox News",
          description: "",
          kind: "html" as const,
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: [topic.id],
          domain: "foxnews.com",
          sourceFamily: "mainstream_front_page" as const,
          pageRole: "front_page" as const,
          contentPreview: "body",
        },
        {
          id: "source-2",
          requestedUrl: "https://reuters.com/",
          resolvedUrl: "https://reuters.com/",
          title: "Reuters",
          description: "",
          kind: "html" as const,
          extractedWith: "readability",
          blockedLikely: false,
          fetchedAt: new Date().toISOString(),
          topicIds: [topic.id],
          domain: "reuters.com",
          sourceFamily: "wire" as const,
          pageRole: "front_page" as const,
          contentPreview: "body",
        },
      ];

      expect(__testOnly.selectFallbackCitationSourceIds(topic, sources)).toEqual([
        "source-2",
        "source-1",
        "source-3",
      ]);
    });
  });
});
