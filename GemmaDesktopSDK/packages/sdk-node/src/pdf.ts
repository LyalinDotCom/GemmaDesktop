import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pdf } from "pdf-to-img";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const pdfToImgEntryPath = require.resolve("pdf-to-img");
const pdfToImgPackageJsonPath = path.join(
  path.dirname(pdfToImgEntryPath),
  "..",
  "package.json",
);
const pdfjsPackageJsonPath = require.resolve("pdfjs-dist/package.json");
const pdfjsPath = path.dirname(pdfjsPackageJsonPath);
const pdfToImgPackageJson = JSON.parse(
  readFileSync(pdfToImgPackageJsonPath, "utf8"),
) as {
  version?: string;
};

export const PDF_RENDERER_INFO = {
  name: "pdf-to-img",
  version: pdfToImgPackageJson.version ?? "unknown",
} as const;

export interface PdfDocumentInfo {
  pageCount: number;
}

export interface ExtractPdfTextOptions {
  path: string;
  startPage?: number;
  endPage?: number;
}

export interface ExtractedPdfTextPage {
  pageNumber: number;
  text: string;
  charCount: number;
}

export interface PdfTextExtractionResult {
  pageCount: number;
  pages: ExtractedPdfTextPage[];
  text: string;
  extractedCharCount: number;
}

export interface RenderPdfPagesOptions {
  path: string;
  startPage: number;
  endPage: number;
  scale: number;
  outputDir: string;
  filenamePrefix?: string;
}

export interface RenderedPdfPage {
  pageNumber: number;
  path: string;
  bytes: number;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertPositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
}

function pageFilename(prefix: string, pageNumber: number): string {
  return `${prefix}-${String(pageNumber).padStart(4, "0")}.png`;
}

async function loadPdfDocument(filePath: string) {
  const data = new Uint8Array(await readFile(filePath));
  return pdfjs.getDocument({
    standardFontDataUrl: path.join(pdfjsPath, `standard_fonts${path.sep}`),
    cMapUrl: path.join(pdfjsPath, `cmaps${path.sep}`),
    cMapPacked: true,
    isEvalSupported: false,
    data,
  }).promise;
}

function normalizePdfTextItems(
  items: Array<{ str?: unknown; hasEOL?: unknown }>,
): { text: string; charCount: number } {
  const lines: string[] = [];
  let currentLine: string[] = [];

  const flushLine = () => {
    if (currentLine.length === 0) {
      return;
    }

    lines.push(currentLine.join(" ").replace(/\s+/g, " ").trim());
    currentLine = [];
  };

  for (const item of items) {
    const value = typeof item.str === "string"
      ? item.str.replace(/\s+/g, " ").trim()
      : "";

    if (value.length > 0) {
      currentLine.push(value);
    }

    if (item.hasEOL === true) {
      flushLine();
    }
  }

  flushLine();

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    text,
    charCount: text.replace(/\s+/g, "").length,
  };
}

export async function inspectPdfDocument(filePath: string): Promise<PdfDocumentInfo> {
  const document = await loadPdfDocument(filePath);

  try {
    return {
      pageCount: document.numPages,
    };
  } finally {
    await document.destroy();
  }
}

export async function extractPdfText(
  options: ExtractPdfTextOptions,
): Promise<PdfTextExtractionResult> {
  const document = await loadPdfDocument(options.path);

  try {
    const pageCount = document.numPages;
    const startPage = options.startPage ?? 1;
    const endPage = options.endPage ?? pageCount;

    assertPositiveInteger(startPage, "startPage");
    assertPositiveInteger(endPage, "endPage");

    if (endPage < startPage) {
      throw new Error("endPage must be greater than or equal to startPage.");
    }

    if (startPage > pageCount || endPage > pageCount) {
      throw new Error(
        `Requested pages ${startPage}-${endPage} are outside the document range 1-${pageCount}.`,
      );
    }

    const pages: ExtractedPdfTextPage[] = [];

    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const normalized = normalizePdfTextItems(
        content.items as Array<{ str?: unknown; hasEOL?: unknown }>,
      );
      pages.push({
        pageNumber,
        text: normalized.text,
        charCount: normalized.charCount,
      });
    }

    return {
      pageCount,
      pages,
      text: pages
        .map((page) => page.text)
        .filter((text) => text.length > 0)
        .join("\n\n"),
      extractedCharCount: pages.reduce((sum, page) => sum + page.charCount, 0),
    };
  } finally {
    await document.destroy();
  }
}

export async function renderPdfPages(
  options: RenderPdfPagesOptions,
): Promise<RenderedPdfPage[]> {
  assertPositiveInteger(options.startPage, "startPage");
  assertPositiveInteger(options.endPage, "endPage");
  assertPositiveNumber(options.scale, "scale");

  if (options.endPage < options.startPage) {
    throw new Error("endPage must be greater than or equal to startPage.");
  }

  const document = await pdf(options.path, { scale: options.scale });
  const pageCount = document.length;

  if (options.startPage > pageCount || options.endPage > pageCount) {
    throw new Error(
      `Requested pages ${options.startPage}-${options.endPage} are outside the document range 1-${pageCount}.`,
    );
  }

  await mkdir(options.outputDir, { recursive: true });
  const filenamePrefix = options.filenamePrefix?.trim() || "page";
  const rendered: RenderedPdfPage[] = [];

  for (let pageNumber = options.startPage; pageNumber <= options.endPage; pageNumber += 1) {
    const image = await document.getPage(pageNumber);
    const bytes = Buffer.from(image);
    const outputPath = path.join(
      options.outputDir,
      pageFilename(filenamePrefix, pageNumber),
    );
    await writeFile(outputPath, bytes);
    rendered.push({
      pageNumber,
      path: outputPath,
      bytes: bytes.byteLength,
    });
  }

  return rendered;
}
