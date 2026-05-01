import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractPdfText,
  inspectPdfDocument,
  renderPdfPages,
} from "@gemma-desktop/sdk-node";

function escapePdfString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");
}

function createPortablePdfFixture(pages: string[]): Buffer {
  const objects: string[] = [];
  const addObject = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObject("");
  const pagesId = addObject("");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const text of pages) {
    const content = [
      "BT",
      "/F1 18 Tf",
      "72 720 Td",
      `(${escapePdfString(text)}) Tj`,
      "ET",
      "",
    ].join("\n");
    const contentId = addObject(
      [
        `<< /Length ${Buffer.byteLength(content, "latin1")} >>`,
        "stream",
        content,
        "endstream",
      ].join("\n"),
    );
    const pageId = addObject(
      [
        "<< /Type /Page",
        `/Parent ${pagesId} 0 R`,
        "/MediaBox [0 0 612 792]",
        `/Resources << /Font << /F1 ${fontId} 0 R >> >>`,
        `/Contents ${contentId} 0 R >>`,
      ].join(" "),
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdfText = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets[index + 1] = Buffer.byteLength(pdfText, "latin1");
    pdfText += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdfText, "latin1");
  pdfText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdfText += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdfText += [
    "trailer",
    `<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");

  return Buffer.from(pdfText, "latin1");
}

describe("pdf input helpers", () => {
  const cleanup: string[] = [];

  async function writePdfFixture(): Promise<string> {
    const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-pdf-fixture-"));
    cleanup.push(fixtureDirectory);
    const fixturePath = path.join(fixtureDirectory, "fixture.pdf");
    await writeFile(
      fixturePath,
      createPortablePdfFixture([
        "Gemma Desktop PDF fixture page one with extractable text",
        "Gemma Desktop PDF fixture page two rendering target",
        "Gemma Desktop PDF fixture page three rendering target",
      ]),
    );
    return fixturePath;
  }

  afterEach(async () => {
    while (cleanup.length > 0) {
      const directory = cleanup.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("inspects document page counts from a local PDF", async () => {
    const fixturePath = await writePdfFixture();

    await expect(inspectPdfDocument(fixturePath)).resolves.toEqual({
      pageCount: 3,
    });
  });

  it("renders a selected page range to ordered PNG files", async () => {
    const fixturePath = await writePdfFixture();
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "gemma-desktop-sdk-pdf-"));
    cleanup.push(outputDirectory);

    const rendered = await renderPdfPages({
      path: fixturePath,
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

  it("extracts embedded PDF text without rendering page images", async () => {
    const fixturePath = await writePdfFixture();

    const extracted = await extractPdfText({
      path: fixturePath,
      startPage: 1,
      endPage: 2,
    });

    expect(extracted.pageCount).toBe(3);
    expect(extracted.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(extracted.extractedCharCount).toBeGreaterThan(70);
    expect(extracted.pages[0]?.text).toContain("Gemma Desktop PDF fixture page one");
    expect(extracted.text).toContain("extractable text");
    expect(extracted.text).toContain("page two rendering target");
  });
});
