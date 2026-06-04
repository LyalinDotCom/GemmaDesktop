import type {
  CapabilityRecord,
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResult,
  LoadedModelInstance,
  ModelRecord,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeInspectionResult,
} from "@gemma-sdk/core";
import {
  detectCommandVersion,
  fetchJson,
  generateOpenAICompatibleResponse,
  postJson,
  streamOpenAICompatibleResponse,
  withInferredModelFamilyCapabilities,
} from "@gemma-sdk/core";

export interface LiteRtLmAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function extractModelList(response: unknown): Array<Record<string, unknown>> {
  const record = asRecord(response);
  return asRecordArray(record?.data);
}

function createCapabilities(): CapabilityRecord[] {
  return [
    { id: "inference.chat", scope: "request", status: "supported", source: "runtime-docs" },
    { id: "inference.streaming", scope: "request", status: "supported", source: "runtime-docs" },
    { id: "inference.embeddings", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "runtime.list-available-models", scope: "runtime", status: "supported", source: "runtime-probe" },
    {
      id: "runtime.load-unload",
      scope: "runtime",
      status: "unsupported",
      source: "runtime-docs",
      notes: ["Gemma products do not import, delete, start, or stop LiteRT-LM models in this endpoint-first integration."],
    },
    { id: "request.tool-calling", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "request.structured-output", scope: "request", status: "conditional", source: "runtime-docs" },
  ];
}

function normalizeModel(model: Record<string, unknown>): ModelRecord {
  const modelId = String(model.id ?? "unknown");
  return {
    id: modelId,
    runtimeId: "litertlm-openai",
    kind: "llm",
    availability: "visible",
    metadata: {
      object: model.object,
      ownedBy: model.owned_by ?? "litertlm",
      displayName: pickString(model.id),
    },
    capabilities: withInferredModelFamilyCapabilities(modelId, [], {
      displayName: pickString(model.id),
    }),
    raw: model,
  };
}

export function createLiteRtLmOpenAICompatibleAdapter(options: LiteRtLmAdapterOptions = {}): RuntimeAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:9379");
  const apiBase = `${baseUrl}/v1`;
  const identity: RuntimeIdentity = {
    id: "litertlm-openai",
    family: "litertlm",
    kind: "openai-compatible",
    displayName: "LiteRT-LM OpenAI-Compatible",
    endpoint: baseUrl,
  };

  return {
    identity,
    async inspect(): Promise<RuntimeInspectionResult> {
      const commandVersion = await detectCommandVersion("litert-lm");
      const health = await fetch(`${baseUrl}/health`).catch(() => undefined);
      const modelsResponse = await fetchJson<Record<string, unknown>>(`${apiBase}/models`).catch(() => undefined);
      const rawModels = extractModelList(modelsResponse);
      const models = rawModels.map(normalizeModel);
      const reachable = Boolean(health) || Boolean(modelsResponse);
      const loadedInstances: LoadedModelInstance[] = [];
      const warnings: string[] = [];
      const diagnosis: string[] = [];

      if (reachable && models.length === 0) {
        warnings.push("LiteRT-LM is reachable, but it did not report any imported models.");
      }
      if (reachable) {
        diagnosis.push("LiteRT-LM is endpoint-first here; start it with `litert-lm serve` before using Gemma Desktop or Gemma CLI.");
      }

      return {
        runtime: identity,
        installed: Boolean(commandVersion) || reachable,
        reachable,
        healthy: health?.status === 200 || Boolean(modelsResponse),
        version: commandVersion,
        capabilities: createCapabilities(),
        models,
        loadedInstances,
        warnings,
        diagnosis,
        raw: {
          healthStatus: health?.status,
          modelsResponse,
        },
      };
    },
    async generate(request: ChatRequest) {
      return await generateOpenAICompatibleResponse(apiBase, request, options.apiKey ?? "litert-lm");
    },
    async *stream(request: ChatRequest) {
      yield* streamOpenAICompatibleResponse(apiBase, request, options.apiKey ?? "litert-lm");
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      const response = await postJson<Record<string, unknown>>(`${apiBase}/embeddings`, {
        model: request.model,
        input: request.input,
      }, {
        signal: request.signal,
        headers: {
          authorization: `Bearer ${options.apiKey ?? "litert-lm"}`,
        },
      });
      return {
        model: request.model,
        embeddings: Array.isArray(response.data)
          ? (response.data as Array<Record<string, unknown>>).map((item) =>
              Array.isArray(item.embedding) ? (item.embedding as number[]) : [],
            )
          : [],
        raw: response,
      };
    },
  };
}
