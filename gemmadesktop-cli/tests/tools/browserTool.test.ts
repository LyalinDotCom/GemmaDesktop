import { describe, expect, it } from "vitest";
import { __testing as browserToolTesting } from "../../src/browserTool.js";

describe("CLI browser tool helpers", () => {
  it("invokes model-supplied evaluate functions before passing them to agent-browser", () => {
    expect(
      browserToolTesting.resolveBrowserArgs({
        action: "evaluate",
        function: "(selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.textContent?.trim())",
        args: ["h1"],
      }),
    ).toEqual([
      "eval",
      "((selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.textContent?.trim()))(...[\"h1\"])",
    ]);
  });

  it("passes already-invoked evaluate expressions through unchanged", () => {
    const script = "(() => document.title)()";

    expect(
      browserToolTesting.resolveBrowserArgs({
        action: "evaluate",
        function: script,
      }),
    ).toEqual(["eval", script]);
  });

  it("detects empty snapshots so callers can choose a fallback snapshot mode", () => {
    expect(browserToolTesting.readSnapshotText({
      origin: "https://example.com/",
      refs: {},
      snapshot: "",
    })).toBe("");
    expect(browserToolTesting.readSnapshotText({
      origin: "https://example.com/",
      refs: {},
      snapshot: "- heading \"Static headline\"",
    })).toBe("- heading \"Static headline\"");
  });

  it("requests a readable full-page snapshot by default", () => {
    expect(browserToolTesting.resolveBrowserArgs({
      action: "snapshot",
    })).toEqual(["snapshot"]);
  });

  it("auto-scans long news snapshots when the model asks for a plain snapshot", async () => {
    const longNewsSnapshot = [
      "- generic",
      "  - StaticText \"HEADLINES\"",
      "  - StaticText \"By CNN\"",
      "  - StaticText \"2h ago\"",
      ...Array.from(
        { length: 140 },
        (_, index) =>
          `  - link "CNN fixture supporting story ${index} about public events and policy updates" [ref=e${index}]`,
      ),
    ].join("\n");
    const linksByStep = [
      [
        {
          text: "CNN fixture lead story about global markets and policy shifts",
          href: "https://www.cnn.com/2026/05/01/business/global-markets-policy",
        },
      ],
      [
        {
          text: "CNN fixture analysis of a major election night result",
          href: "https://www.cnn.com/2026/05/01/politics/election-analysis",
        },
      ],
      [
        {
          text: "CNN fixture health story on hospital staffing pressure",
          href: "https://www.cnn.com/2026/05/01/health/hospital-staffing",
        },
      ],
      [
        {
          text: "CNN fixture travel story about airport delays this weekend",
          href: "https://www.cnn.com/2026/05/01/travel/airport-delays",
        },
      ],
    ];
    let stepIndex = 0;
    const calls: string[][] = [];
    const result = await browserToolTesting.runSnapshotWithOptionalScan({
      args: {
        action: "snapshot",
      },
      runCommand(args: string[]) {
        calls.push(args);
        if (args[0] === "snapshot") {
          return Promise.resolve({
            success: true,
            data: {
              origin: "https://www.cnn.com/",
              refs: {},
              snapshot: longNewsSnapshot,
            },
          });
        }

        if (args[0] === "screenshot") {
          return Promise.resolve({
            success: true,
            data: {
              path: `/tmp/cnn-cli-auto-scan-step-${stepIndex}.png`,
            },
          });
        }

        if (args[0] === "eval") {
          return Promise.resolve({
            success: true,
            data: {
              result: {
                scrollY: stepIndex * 900,
                viewportHeight: 720,
                documentHeight: 3600,
                links: linksByStep[stepIndex] ?? [],
              },
            },
          });
        }

        if (args[0] === "scroll") {
          stepIndex += 1;
          return Promise.resolve({ success: true, data: {} });
        }

        if (args[0] === "wait") {
          return Promise.resolve({ success: true, data: {} });
        }

        return Promise.reject(new Error(`unexpected args ${args.join(" ")}`));
      },
    });
    const data = result.data as Record<string, unknown>;

    expect(calls[0]).toEqual(["snapshot"]);
    expect(calls.filter((args) => args[0] === "scroll")).toHaveLength(3);
    expect(data.autoScannedFromSnapshot).toBe(true);
    expect(data.scanText).toContain("automatically scanned it with scrolling and screenshots");
    expect(data.scanText).toContain("scrolling added 3");
    expect(data.scanText).toContain("CNN fixture travel story");
    expect(data).toEqual(expect.objectContaining({
      snapshotOrigin: "https://www.cnn.com/",
      firstViewportStoryCount: 1,
      uniqueStoryCount: 4,
      addedAfterFirstViewport: 3,
    }));
  });

  it("scans a CNN-style page with more stories after the default three scrolls", async () => {
    const linksByStep = [
      [
        {
          text: "CNN fixture lead story about global markets and policy shifts",
          href: "https://www.cnn.com/2026/05/01/business/global-markets-policy",
        },
        {
          text: "CNN fixture live updates on severe weather across the US",
          href: "https://www.cnn.com/2026/05/01/weather/live-updates",
        },
      ],
      [
        {
          text: "CNN fixture live updates on severe weather across the US",
          href: "https://www.cnn.com/2026/05/01/weather/live-updates",
        },
        {
          text: "CNN fixture analysis of a major election night result",
          href: "https://www.cnn.com/2026/05/01/politics/election-analysis",
        },
      ],
      [
        {
          text: "CNN fixture health story on hospital staffing pressure",
          href: "https://www.cnn.com/2026/05/01/health/hospital-staffing",
        },
      ],
      [
        {
          text: "CNN fixture travel story about airport delays this weekend",
          href: "https://www.cnn.com/2026/05/01/travel/airport-delays",
        },
      ],
    ];
    let stepIndex = 0;
    const calls: string[][] = [];
    const result = await browserToolTesting.runBrowserPageScan({
      args: {
        action: "scan_page",
      },
      runCommand(args: string[]) {
        calls.push(args);
        if (args[0] === "screenshot") {
          return Promise.resolve({
            success: true,
            data: {
              path: `/tmp/cnn-cli-scan-step-${stepIndex}.png`,
            },
          });
        }

        if (args[0] === "eval") {
          return Promise.resolve({
            success: true,
            data: {
              result: {
                scrollY: stepIndex * 900,
                viewportHeight: 720,
                documentHeight: 3600,
                links: linksByStep[stepIndex] ?? [],
              },
            },
          });
        }

        if (args[0] === "scroll") {
          stepIndex += 1;
          return Promise.resolve({ success: true, data: {} });
        }

        if (args[0] === "wait") {
          return Promise.resolve({ success: true, data: {} });
        }

        return Promise.reject(new Error(`unexpected args ${args.join(" ")}`));
      },
    });
    const data = result.data as Record<string, unknown>;

    expect(calls.slice(0, 2).map((args) => args[0])).toEqual(["screenshot", "eval"]);
    expect(calls.filter((args) => args[0] === "scroll")).toHaveLength(3);
    expect(data.scanText).toContain("scrolling added 3");
    expect(data.scanText).toContain("CNN fixture travel story");
    expect(data).toEqual(expect.objectContaining({
      scrolls: 3,
      screenshotCount: 4,
      firstViewportStoryCount: 2,
      uniqueStoryCount: 5,
      addedAfterFirstViewport: 3,
    }));
  });

  it("keeps the first scan screenshot and reports later scroll failures without failing", async () => {
    let screenshotCalls = 0;
    const result = await browserToolTesting.runBrowserPageScan({
      args: {
        action: "scan_page",
        scrolls: 1,
      },
      runCommand(args: string[]) {
        if (args[0] === "screenshot") {
          screenshotCalls += 1;
          if (screenshotCalls > 1) {
            return Promise.reject(new Error("page became unstable"));
          }
          return Promise.resolve({
            success: true,
            data: {
              path: "/tmp/first-cli-scan.png",
            },
          });
        }

        if (args[0] === "eval") {
          return Promise.resolve({
            success: true,
            data: {
              result: {
                scrollY: 0,
                viewportHeight: 720,
                documentHeight: 1400,
                links: [
                  {
                    text: "CNN fixture first story remains available after scan errors",
                    href: "https://www.cnn.com/2026/05/01/us/first-story",
                  },
                ],
              },
            },
          });
        }

        if (args[0] === "scroll") {
          return Promise.reject(new Error("scroll target detached"));
        }

        if (args[0] === "wait") {
          return Promise.resolve({ success: true, data: {} });
        }

        return Promise.reject(new Error(`unexpected args ${args.join(" ")}`));
      },
    });
    const data = result.data as Record<string, unknown>;

    expect(data.scanText).toContain("/tmp/first-cli-scan.png");
    expect(data.scanText).toContain("Warnings:");
    expect(data.scanText).toContain("scroll target detached");
    expect(data.scanText).toContain("page became unstable");
    expect(data).toEqual(expect.objectContaining({
      screenshotCount: 1,
      uniqueStoryCount: 1,
    }));
  });
});
