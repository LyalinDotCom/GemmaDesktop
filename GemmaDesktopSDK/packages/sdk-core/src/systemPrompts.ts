import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SystemPromptSectionSource =
  | "fallback"
  | "model"
  | "environment"
  | "tool_context"
  | "mode"
  | "exact_paths"
  | "capabilities"
  | "custom"
  | "continuation";

export interface ResolvedSystemInstructionSection {
  source: SystemPromptSectionSource;
  text: string;
  id?: string;
}

export interface SystemPromptProfileEntry {
  kind: "fallback" | "model";
  id: string;
  text: string;
}

export interface SystemPromptCatalog {
  fallback: SystemPromptProfileEntry;
  models: SystemPromptProfileEntry[];
}

export const SYSTEM_PROMPT_ROOT_TAG = "gemma_desktop_system_prompt";
export const SYSTEM_PROMPT_SECTION_TAG = "system_prompt_section";

let cachedCatalog: SystemPromptCatalog | undefined;

function escapePromptAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderSystemPromptSection(
  section: ResolvedSystemInstructionSection,
): string {
  const attributes = [
    `source="${escapePromptAttribute(section.source)}"`,
    section.id ? `id="${escapePromptAttribute(section.id)}"` : undefined,
  ].filter((attribute): attribute is string => Boolean(attribute));

  return [
    `<${SYSTEM_PROMPT_SECTION_TAG} ${attributes.join(" ")}>`,
    section.text.trim(),
    `</${SYSTEM_PROMPT_SECTION_TAG}>`,
  ].join("\n");
}

function resolvePromptsRoot(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(directory, "../prompts");
}

function normalizePromptKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readPromptMarkdown(filePath: string): string {
  const text = readFileSync(filePath, "utf8").trim();
  if (text.length === 0) {
    throw new Error(`System prompt file is empty: ${filePath}`);
  }
  return text;
}

function loadPromptEntry(
  kind: SystemPromptProfileEntry["kind"],
  filePath: string,
): SystemPromptProfileEntry {
  return {
    kind,
    id: path.basename(filePath, path.extname(filePath)),
    text: readPromptMarkdown(filePath),
  };
}

function loadPromptEntries(
  kind: "model",
  directoryPath: string,
): SystemPromptProfileEntry[] {
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => loadPromptEntry(kind, path.join(directoryPath, entry.name)))
    .sort((left, right) =>
      left.id.localeCompare(right.id, "en", { sensitivity: "base" }),
    );
}

export function loadSystemPromptCatalog(): SystemPromptCatalog {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const promptsRoot = resolvePromptsRoot();
  const fallbackPath = path.join(promptsRoot, "fallback.md");
  if (!existsSync(fallbackPath)) {
    throw new Error(`Missing fallback system prompt markdown: ${fallbackPath}`);
  }

  cachedCatalog = {
    fallback: loadPromptEntry("fallback", fallbackPath),
    models: loadPromptEntries("model", path.join(promptsRoot, "models")),
  };
  return cachedCatalog;
}

export function resolvePromptProfileSections(
  modelId: string,
  catalog: SystemPromptCatalog = loadSystemPromptCatalog(),
): ResolvedSystemInstructionSection[] {
  const normalizedModelId = normalizePromptKey(modelId);
  const sections: ResolvedSystemInstructionSection[] = [{
    source: "fallback",
    id: catalog.fallback.id,
    text: catalog.fallback.text,
  }];

  const matchedModel = catalog.models.find(
    (entry) => normalizePromptKey(entry.id) === normalizedModelId,
  );
  if (matchedModel) {
    sections.push({
      source: "model",
      id: matchedModel.id,
      text: matchedModel.text,
    });
  }

  return sections;
}
