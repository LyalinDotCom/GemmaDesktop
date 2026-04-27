import { describe, expect, it } from "vitest";
import { __testOnly } from "../packages/sdk-node/src/research.js";

// Scenario regression tests pinned to a canonical user query:
//   "What are all the announcements from Google DeepMind in March & April 2026?"
//
// This query exercises the news-sweep classification path that brings in
// mainstream-outlet seeding (Reuters, BBC, AP, etc.) without which the
// research pipeline starves on Bing-redirect shells (the f356e4f regression).
//
// Each describe block below encodes a winning criterion. If a future change
// disturbs any of these assertions, it's a real behavioral shift that should
// either be defended in the test (update the assertion intentionally) or
// fixed in the code.

// Fixture mirrors the "good run" at
// .gemma/research/b20686ef-0560-4e57-98f0-c94176427b35 (45 sources, correct
// synthesis) — request from run.json, plan from coordinator-plan/result.json.
const CANONICAL_REQUEST =
  "What are all the announcements from Google DeepMind in March & April 2026? Include products announcements, models, etc";

const CANONICAL_PLAN = {
  objective: "Identify all product and model announcements from Google DeepMind during March and April 2026.",
  scopeSummary:
    "The research focuses on official Google DeepMind communications, including blog posts, research papers, and news releases released specifically in March and April 2026.",
  topics: [
    {
      id: "official-deepmind-announcements-1",
      title: "Official Google DeepMind Announcements",
      goal: "Find all official news and product releases from DeepMind during the target period.",
      priority: 1,
      searchQueries: [
        "site:deepmind.google/blog March April 2026",
        "Google DeepMind announcements March 2026",
        "Google DeepMind announcements April 2026",
      ],
    },
    {
      id: "deepmind-models-research-2",
      title: "DeepMind Models and Research",
      goal: "Identify specific new models or research breakthroughs announced in the target window.",
      priority: 2,
      searchQueries: [
        "site:deepmind.google/research March April 2026",
        "new DeepMind models released March April 2026",
        "Google DeepMind machine learning papers March April 2026",
      ],
    },
  ],
  risks: [],
  stopConditions: [],
};

describe("research scenario: Google DeepMind announcements", () => {
  describe("brief construction", () => {
    const brief = __testOnly.buildResearchBrief(CANONICAL_REQUEST, CANONICAL_PLAN);

    it("routes org-announcement catalog queries through news-sweep, not catalog-status", () => {
      // f356e4f regression: classifying this as "catalog-status" strips the
      // mainstream outlet seeding and the final report ends up empty.
      expect(brief.taskType).toBe("news-sweep");
    });

    it("marks mainstream front pages and articles as required source families", () => {
      expect(brief.requiredSourceFamilies).toContain("mainstream_front_page");
      expect(brief.requiredSourceFamilies).toContain("mainstream_article");
    });

    it("asks synthesis to summarize outlet agreement and disagreement", () => {
      expect(
        brief.reportRequirements.some((requirement) =>
          /consensus|disagree|diverge|agree/i.test(requirement),
        ),
      ).toBe(true);
    });
  });

  describe("coverage plan expansion (deep profile)", () => {
    const brief = __testOnly.buildResearchBrief(CANONICAL_REQUEST, CANONICAL_PLAN);
    const { coveragePlan } = __testOnly.buildCoveragePlan(
      CANONICAL_REQUEST,
      CANONICAL_PLAN,
      brief,
      "deep",
    );

    it("expands into at least front-page + article coverage topics", () => {
      const titles = coveragePlan.queryGroups.map((group) => group.title);
      expect(titles).toContain("Mainstream front pages");
      expect(titles).toContain("Mainstream article coverage");
    });

    it("marks front-page and article groups as required", () => {
      const frontPage = coveragePlan.queryGroups.find(
        (group) => group.sourceFamily === "mainstream_front_page",
      );
      const article = coveragePlan.queryGroups.find(
        (group) => group.sourceFamily === "mainstream_article",
      );
      expect(frontPage?.required).toBe(true);
      expect(article?.required).toBe(true);
    });

    it("seeds mainstream-outlet home pages so discovery doesn't depend on search alone", () => {
      const allSeedUrls = coveragePlan.queryGroups.flatMap((group) => group.seedUrls);
      const hasMainstreamSeed = (domain: string): boolean =>
        allSeedUrls.some((url) => url.includes(domain));
      // These were the seeded outlets in the good 45-source run. If this
      // assertion fails, someone removed the outlet seeding — which is
      // exactly what silently happened in f356e4f.
      expect(hasMainstreamSeed("reuters.com")).toBe(true);
      expect(hasMainstreamSeed("bbc.com")).toBe(true);
      expect(hasMainstreamSeed("apnews.com")).toBe(true);
    });

    it("issues enough queries across groups for a deep run", () => {
      const totalQueries = coveragePlan.queryGroups.reduce(
        (sum, group) => sum + group.searchQueries.length,
        0,
      );
      // Good run had ~20+ queries across 4 topic groups. Anything well below
      // that means the plan collapsed (as it did in f356e4f).
      expect(totalQueries).toBeGreaterThanOrEqual(8);
    });

    it("caps queries per group so we don't explode into hundreds", () => {
      for (const group of coveragePlan.queryGroups) {
        expect(group.searchQueries.length).toBeLessThanOrEqual(12);
      }
    });
  });

  describe("task-type classification across canonical phrasings (request-only)", () => {
    // NOTE: classification runs against request + plan.objective + scope +
    // topic titles/goals. With only a request (empty plan), the classifier
    // depends purely on the request text. The "org-announcement sweep"
    // phrasing ("all the announcements from X") does NOT contain any
    // news-sweep trigger words on its own — in production it's saved by the
    // planner usually emitting "news releases" in the scope summary.
    // These cases document the standalone behavior so drift is visible.
    const cases: Array<{ label: string; request: string; expected: string }> = [
      {
        label: "front-page check",
        request: "What's on the front page of the New York Times today?",
        expected: "news-sweep",
      },
      {
        label: "latest-news request",
        request: "Give me the latest news on the Fed rate decision",
        expected: "news-sweep",
      },
      {
        label: "explicit comparison",
        request: "Compare React 19 vs React 18 server components",
        expected: "comparison",
      },
      {
        label: "generic explainer",
        request: "How does retrieval-augmented generation actually work?",
        expected: "validation-explainer",
      },
      {
        label: "org-announcement sweep without planner help",
        request:
          "What are all the announcements from Google DeepMind in March & April 2026?",
        expected: "validation-explainer",
      },
    ];

    for (const testCase of cases) {
      it(`classifies ${testCase.label} as ${testCase.expected}`, () => {
        const plan = {
          objective: testCase.request,
          scopeSummary: "",
          topics: [],
          risks: [],
          stopConditions: [],
        };
        const brief = __testOnly.buildResearchBrief(testCase.request, plan);
        expect(brief.taskType).toBe(testCase.expected);
      });
    }
  });

  describe("coverage assessment against canonical hub pages", () => {
    // Replays the shape of the good 45-source run: when DeepMind's root page
    // is fetched but no blog subpages yet exist, the assessment should
    // schedule a site:deepmind.google follow-up.
    const brief = __testOnly.buildResearchBrief(CANONICAL_REQUEST, CANONICAL_PLAN);
    const { coveragePlan } = __testOnly.buildCoveragePlan(
      CANONICAL_REQUEST,
      CANONICAL_PLAN,
      brief,
      "deep",
    );
    const topicId = coveragePlan.queryGroups[0]!.topicId;

    it("schedules hub-page follow-up when deepmind.google root is fetched alone", () => {
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
          contentPreview:
            "Google DeepMind research team ... Gemini models ... research publications ...",
        },
      ];
      const assessment = __testOnly.buildCoverageAssessment(
        brief,
        coveragePlan,
        sources,
        1,
      );
      const followUps = assessment.followUpQueriesByTopic.get(topicId) ?? [];
      expect(followUps.some((query) => /^site:deepmind\.google/.test(query))).toBe(true);
    });
  });
});
