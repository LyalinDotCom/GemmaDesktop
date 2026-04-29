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
} from "@gemma-desktop/sdk-core";
import {
  fetchJson,
  generateOpenAICompatibleResponse,
  isGemma4ModelId,
  postJson,
  streamOpenAICompatibleResponse,
  withInferredModelFamilyCapabilities,
} from "@gemma-desktop/sdk-core";

export interface OmlxAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
}

const DEFAULT_OMLX_GEMMA4_THINKING_BUDGET = 4096;

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

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function asMutableOpenAIOptions(settings: ChatRequest["settings"]): Record<string, unknown> {
  const value = settings?.openAICompatibleOptions;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function asMutableChatTemplateKwargs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function normalizeFiniteNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) =>
    typeof entry === "number" && Number.isFinite(entry)
  );

  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, number> : undefined;
}

const OMLX_OPENAI_COMPATIBLE_OPTION_KEY_MAP: Record<string, string> = {
  temperature: "temperature",
  top_p: "top_p",
  min_p: "min_p",
  presence_penalty: "presence_penalty",
  frequency_penalty: "frequency_penalty",
  xtc_probability: "xtc_probability",
  xtc_threshold: "xtc_threshold",
  max_tokens: "max_tokens",
  max_output_tokens: "max_tokens",
  seed: "seed",
  thinking_budget: "thinking_budget",
};

function resolveOmlxOpenAICompatibleOptions(
  settings: ChatRequest["settings"],
): Record<string, number> | undefined {
  const source = normalizeFiniteNumberRecord(settings?.omlxOptions);
  if (!source) {
    return undefined;
  }

  const entries = Object.entries(source).flatMap(([key, value]) => {
    const mappedKey = OMLX_OPENAI_COMPATIBLE_OPTION_KEY_MAP[key];
    return mappedKey ? [[mappedKey, value] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, number> : undefined;
}

function shouldEnableOmlxReasoning(modelId: string, settings: ChatRequest["settings"]): boolean {
  return isGemma4ModelId(modelId)
    || settings?.reasoningMode === "on"
    || settings?.reasoningMode === "auto";
}

function withOmlxOpenAICompatibleSettings(request: ChatRequest): ChatRequest {
  const omlxOptions = resolveOmlxOpenAICompatibleOptions(request.settings);
  const existingOpenAIOptions = asMutableOpenAIOptions(request.settings);
  const openAICompatibleOptions = omlxOptions
    ? { ...omlxOptions, ...existingOpenAIOptions }
    : existingOpenAIOptions;
  const baseRequest = omlxOptions
    ? {
        ...request,
        settings: {
          ...(request.settings ?? {}),
          openAICompatibleOptions,
        },
      }
    : request;

  if (!shouldEnableOmlxReasoning(request.model, request.settings)) {
    return baseRequest;
  }

  const chatTemplateKwargs = asMutableChatTemplateKwargs(openAICompatibleOptions.chat_template_kwargs);
  chatTemplateKwargs.enable_thinking = true;

  return {
    ...baseRequest,
    settings: {
      ...(baseRequest.settings ?? {}),
      openAICompatibleOptions: {
        ...openAICompatibleOptions,
        chat_template_kwargs: chatTemplateKwargs,
        thinking_budget:
          typeof openAICompatibleOptions.thinking_budget === "number"
          && Number.isFinite(openAICompatibleOptions.thinking_budget)
            ? openAICompatibleOptions.thinking_budget
            : DEFAULT_OMLX_GEMMA4_THINKING_BUDGET,
      },
    },
  };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function extractOpenAIModelEntries(response: unknown): Array<Record<string, unknown>> {
  const record = asRecord(response);
  return asRecordArray(record?.data);
}

function extractStatusModelEntries(response: unknown): Array<Record<string, unknown>> {
  const record = asRecord(response);
  return asRecordArray(record?.models);
}

function createCapabilities(): CapabilityRecord[] {
  return [
    { id: "inference.chat", scope: "request", status: "supported", source: "runtime-docs" },
    { id: "inference.streaming", scope: "request", status: "supported", source: "runtime-docs" },
    { id: "inference.embeddings", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "inference.rerank", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "runtime.list-available-models", scope: "runtime", status: "supported", source: "runtime-probe" },
    { id: "runtime.list-loaded-models", scope: "runtime", status: "supported", source: "runtime-probe" },
    { id: "runtime.load", scope: "runtime", status: "unsupported", source: "runtime-docs", notes: ["oMLX loads models on demand when a request targets them."] },
    { id: "runtime.unload", scope: "runtime", status: "supported", source: "runtime-docs" },
    { id: "request.tool-calling", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "request.structured-output", scope: "request", status: "conditional", source: "runtime-docs" },
  ];
}

function createModelCapabilities(modelId: string, detail: Record<string, unknown> | undefined): CapabilityRecord[] {
  const modelType = pickString(detail?.model_type, detail?.modelType)?.toLowerCase();
  const engineType = pickString(detail?.engine_type, detail?.engineType)?.toLowerCase();
  const configModelType = pickString(detail?.config_model_type, detail?.configModelType)?.toLowerCase();
  const capabilities: CapabilityRecord[] = [];

  if (modelType === "vlm" || engineType === "vlm") {
    capabilities.push(
      { id: "model.vision", scope: "model", status: "supported", source: "runtime-probe" },
      { id: "model.input.image", scope: "model", status: "supported", source: "runtime-probe" },
      { id: "model.multimodal", scope: "model", status: "supported", source: "runtime-probe" },
    );
  }

  if (modelType === "embedding" || engineType === "embedding") {
    capabilities.push({ id: "model.embedding", scope: "model", status: "supported", source: "runtime-probe" });
  }

  if (modelType === "reranker" || engineType === "reranker") {
    capabilities.push({ id: "model.rerank", scope: "model", status: "supported", source: "runtime-probe" });
  }

  if (configModelType?.includes("ocr")) {
    capabilities.push({ id: "model.ocr", scope: "model", status: "supported", source: "runtime-probe" });
  }

  return withInferredModelFamilyCapabilities(modelId, capabilities, {
    displayName: pickString(detail?.id, detail?.model_path, detail?.modelPath),
  });
}

function modelKind(detail: Record<string, unknown> | undefined): ModelRecord["kind"] {
  const type = pickString(detail?.model_type, detail?.engine_type, detail?.modelType, detail?.engineType)?.toLowerCase();
  return type === "embedding" ? "embedding" : "llm";
}

function normalizeModel(
  modelId: string,
  openAIModel: Record<string, unknown> | undefined,
  detail: Record<string, unknown> | undefined,
): ModelRecord {
  const maxContextWindow = pickNumber(detail?.max_context_window, detail?.maxContextWindow);
  const maxTokens = pickNumber(detail?.max_tokens, detail?.maxTokens);

  return {
    id: modelId,
    runtimeId: "omlx-openai",
    kind: modelKind(detail),
    availability: "visible",
    metadata: {
      ownedBy: openAIModel?.owned_by ?? "omlx",
      sourceId: pickString(detail?.id),
      modelPath: detail?.model_path,
      modelType: detail?.model_type,
      engineType: detail?.engine_type,
      configModelType: detail?.config_model_type,
      estimatedSizeBytes: pickNumber(detail?.estimated_size, detail?.estimatedSize),
      maxContextWindow,
      maxTokens,
      pinned: detail?.pinned,
      loaded: detail?.loaded,
      thinkingDefault: detail?.thinking_default,
      preserveThinkingDefault: detail?.preserve_thinking_default,
    },
    capabilities: createModelCapabilities(modelId, detail),
    raw: {
      openai: openAIModel,
      status: detail,
    },
  };
}

function loadedStatus(detail: Record<string, unknown>): LoadedModelInstance["status"] | undefined {
  if (detail.is_loading === true) {
    return "loading";
  }
  if (detail.loaded === true) {
    return "loaded";
  }
  return undefined;
}

function normalizeLoadedInstances(statusModels: Array<Record<string, unknown>>): LoadedModelInstance[] {
  return statusModels.flatMap((detail) => {
    const status = loadedStatus(detail);
    const modelId = pickString(detail.id);
    if (!status || !modelId) {
      return [];
    }

    return [{
      id: modelId,
      modelId,
      runtimeId: "omlx-openai",
      status,
      config: {
        maxContextWindow: pickNumber(detail.max_context_window, detail.maxContextWindow),
        maxTokens: pickNumber(detail.max_tokens, detail.maxTokens),
        pinned: detail.pinned,
        modelType: detail.model_type,
        engineType: detail.engine_type,
      },
      capabilities: createModelCapabilities(modelId, detail),
      raw: detail,
    }];
  });
}

function normalizeModels(
  openAIModels: Array<Record<string, unknown>>,
  statusModels: Array<Record<string, unknown>>,
): ModelRecord[] {
  const detailsById = new Map(
    statusModels.flatMap((detail) => {
      const id = pickString(detail.id);
      return id ? [[id, detail] as const] : [];
    }),
  );
  const models = openAIModels.flatMap((model) => {
    const modelId = pickString(model.id);
    if (!modelId) {
      return [];
    }
    return [normalizeModel(modelId, model, detailsById.get(modelId))];
  });
  const knownModelIds = new Set(models.map((model) => model.id));

  for (const detail of statusModels) {
    const modelId = pickString(detail.id);
    if (modelId && !knownModelIds.has(modelId)) {
      models.push(normalizeModel(modelId, undefined, detail));
    }
  }

  return models;
}

export function createOmlxOpenAICompatibleAdapter(options: OmlxAdapterOptions = {}): RuntimeAdapter {
  const nativeBaseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:8000");
  const baseUrl = `${nativeBaseUrl}/v1`;
  const identity: RuntimeIdentity = {
    id: "omlx-openai",
    family: "omlx",
    kind: "openai-compatible",
    displayName: "oMLX OpenAI-Compatible",
    endpoint: baseUrl,
  };

  return {
    identity,
    async inspect(): Promise<RuntimeInspectionResult> {
      const headers = authHeaders(options.apiKey);
      const health = await fetchJson<Record<string, unknown>>(`${nativeBaseUrl}/health`).catch(() => undefined);
      const modelList = await fetchJson<Record<string, unknown>>(`${baseUrl}/models`, { headers }).catch(() => undefined);
      const modelStatus = await fetchJson<Record<string, unknown>>(`${baseUrl}/models/status`, { headers }).catch(() => undefined);
      const apiStatus = await fetchJson<Record<string, unknown>>(`${nativeBaseUrl}/api/status`, { headers }).catch(() => undefined);

      const openAIModels = extractOpenAIModelEntries(modelList);
      const statusModels = extractStatusModelEntries(modelStatus);
      const models = normalizeModels(openAIModels, statusModels);
      const reachable = Boolean(health) || Boolean(modelList) || Boolean(modelStatus) || Boolean(apiStatus);
      const diagnosis = reachable && models.length === 0
        ? ["oMLX is reachable, but it did not report any models."]
        : [];

      return {
        runtime: identity,
        installed: reachable,
        reachable,
        healthy: Boolean(modelList) || health?.status === "healthy" || apiStatus?.status === "ok",
        version: pickString(apiStatus?.version),
        capabilities: createCapabilities(),
        models,
        loadedInstances: normalizeLoadedInstances(statusModels),
        warnings: [],
        diagnosis,
        raw: {
          health,
          modelList,
          modelStatus,
          apiStatus,
        },
      };
    },
    async generate(request: ChatRequest) {
      return await generateOpenAICompatibleResponse(
        baseUrl,
        withOmlxOpenAICompatibleSettings(request),
        options.apiKey ?? "omlx",
      );
    },
    async *stream(request: ChatRequest) {
      yield* streamOpenAICompatibleResponse(
        baseUrl,
        withOmlxOpenAICompatibleSettings(request),
        options.apiKey ?? "omlx",
      );
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      const response = await postJson<Record<string, unknown>>(`${baseUrl}/embeddings`, {
        model: request.model,
        input: request.input,
      }, {
        signal: request.signal,
        headers: authHeaders(options.apiKey),
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
    lifecycle: {
      async unloadModel(modelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(
          `${baseUrl}/models/${encodeURIComponent(modelId)}/unload`,
          {},
          { headers: authHeaders(options.apiKey) },
        );
      },
    },
  };
}
