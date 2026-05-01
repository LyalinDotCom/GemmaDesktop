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
});
