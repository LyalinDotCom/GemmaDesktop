import { existsSync } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractPdfText,
  inspectPdfDocument,
  renderPdfPages,
} from "@gemma-desktop/sdk-node";

const REFERENCE_FIXTURE_PATH =
  "/Users/dmitrylyalin/Source/Reference_Projects/llama.cpp/tools/server/webui/tests/stories/fixtures/assets/example.pdf";
const ATTENTION_FIXTURE_PATH =
  "/Users/dmitrylyalin/Source/Testing/AI-Legacy/Attention_Is_All_You_Need.pdf";
const itWithFixture = existsSync(REFERENCE_FIXTURE_PATH) ? it : it.skip;
const itWithAttentionFixture = existsSync(ATTENTION_FIXTURE_PATH) ? it : it.skip;

describe("pdf input helpers", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const directory = cleanup.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  itWithFixture("inspects document page counts from a local PDF", async () => {
    await expect(inspectPdfDocument(REFERENCE_FIXTURE_PATH)).resolves.toEqual({
      pageCount: 3,
    });
  });

  itWithFixture("renders a selected page range to ordered PNG files", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-pdf-"));
    cleanup.push(outputDirectory);

    const rendered = await renderPdfPages({
      path: REFERENCE_FIXTURE_PATH,
      startPage: 2,
      endPage: 3,
      scale: 2,
      outputDir: outputDirectory,
    });

    expect(rendered.map((page) => page.pageNumber)).toEqual([2, 3]);
    expect(rendered).toHaveLength(2);

    for (const page of rendered) {
      await expect(access(page.path)).resolves.toBeUndefined();
      const fileStats = await stat(page.path);
      expect(fileStats.isFile()).toBe(true);
      expect(fileStats.size).toBeGreaterThan(0);
      expect(page.bytes).toBe(fileStats.size);
    }
  });

  itWithAttentionFixture("extracts embedded PDF text without rendering page images", async () => {
    const extracted = await extractPdfText({
      path: ATTENTION_FIXTURE_PATH,
      startPage: 1,
      endPage: 2,
    });

    expect(extracted.pageCount).toBe(15);
    expect(extracted.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(extracted.extractedCharCount).toBeGreaterThan(500);
    expect(extracted.pages[0]?.text).toContain("Attention Is All You Need");
    expect(extracted.text).toContain("Ashish Vaswani");
    expect(extracted.text).toContain("Noam Shazeer");
  });
});
