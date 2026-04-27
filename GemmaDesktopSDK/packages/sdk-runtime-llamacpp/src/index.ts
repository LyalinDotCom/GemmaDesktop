import type {
  CapabilityRecord,
  ChatRequest,
  EmbeddingRequest,
  EmbeddingResult,
  LoadedModelInstance,
  ModelRecord,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeInspectionResult} from "@gemma-desktop/sdk-core";
import {
  detectCommandVersion,
} from "@gemma-desktop/sdk-core";
import {
  fetchJson,
  generateOpenAICompatibleResponse,
  postJson,
  streamOpenAICompatibleResponse,
} from "@gemma-desktop/sdk-core";

export interface LlamaCppAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
}

function createCapabilities(routerEnabled: boolean): CapabilityRecord[] {
  return [
    { id: "inference.chat", scope: "request", status: "supported", source: "runtime-probe" },
    { id: "inference.streaming", scope: "request", status: "supported", source: "runtime-probe" },
    { id: "inference.embeddings", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "request.tool-calling", scope: "request", status: "conditional", source: "runtime-docs" },
    { id: "request.structured-output", scope: "request", status: "conditional", source: "runtime-docs" },
    {
      id: "runtime.router-mode",
      scope: "runtime",
      status: routerEnabled ? "supported" : "unsupported",
      source: "runtime-probe",
    },
    {
      id: "runtime.load-unload",
      scope: "runtime",
      status: routerEnabled ? "supported" : "unsupported",
      source: "runtime-probe",
      notes: routerEnabled ? undefined : ["Explicit load and unload require llama.cpp router mode."],
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractModelList(response: unknown): Array<Record<string, unknown>> {
  const record = asRecord(response);
  const data = record?.data;
  if (Array.isArray(data)) {
    return data as Array<Record<string, unknown>>;
  }

  const models = record?.models;
  if (Array.isArray(models)) {
    return models as Array<Record<string, unknown>>;
  }

  return Array.isArray(response)
    ? response as Array<Record<string, unknown>>
    : [];
}

function statusValue(model: Record<string, unknown>): string | undefined {
  if (typeof model.status === "string") {
    return model.status;
  }

  const status = asRecord(model.status);
  return typeof status?.value === "string" ? status.value : undefined;
}

function isRouterModel(model: Record<string, unknown>): boolean {
  return Boolean(statusValue(model) || model.path || model.in_cache);
}

function normalizeV1Models(raw: Array<Record<string, unknown>>): ModelRecord[] {
  return raw.map((model) => ({
    id: String(model.id ?? "unknown"),
    runtimeId: "llamacpp-server",
    kind: "llm",
    availability: "loaded-only-view",
    metadata: {
      object: model.object,
      ownedBy: model.owned_by,
      meta: model.meta,
    },
    capabilities: [],
    raw: model,
  }));
}

function normalizeRouterModels(raw: Array<Record<string, unknown>>): { models: ModelRecord[]; instances: LoadedModelInstance[] } {
  const models: ModelRecord[] = [];
  const instances: LoadedModelInstance[] = [];

  for (const model of raw) {
    const modelId = String(model.id ?? model.model ?? "unknown");
    models.push({
      id: modelId,
      runtimeId: "llamacpp-server",
      kind: "llm",
      availability: "available",
      metadata: {
        status: model.status,
        path: model.path,
      },
      capabilities: [],
      raw: model,
    });

    const status = statusValue(model);
    if (status && ["loaded", "loading", "sleeping"].includes(status)) {
      instances.push({
        id: modelId,
        modelId,
        runtimeId: "llamacpp-server",
        status:
          status === "loaded" || status === "loading" || status === "sleeping"
            ? status
            : "unknown",
        config: typeof model.config === "object" ? (model.config as Record<string, unknown>) : {},
        capabilities: [],
        raw: model,
      });
    }
  }

  return { models, instances };
}

export function createLlamaCppServerAdapter(options: LlamaCppAdapterOptions = {}): RuntimeAdapter {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:8080";
  const apiBase = `${baseUrl}/v1`;
  const identity: RuntimeIdentity = {
    id: "llamacpp-server",
    family: "llamacpp",
    kind: "server",
    displayName: "llama.cpp Server",
    endpoint: baseUrl,
  };

  return {
    identity,
    async inspect(): Promise<RuntimeInspectionResult> {
      const commandVersion = await detectCommandVersion("llama-server");
      const health = await fetch(`${baseUrl}/health`).catch(() => undefined);
      const v1ModelsResponse = await fetchJson<Record<string, unknown>>(`${apiBase}/models`).catch(() => undefined);
      const routerModelsResponse = await fetchJson<Record<string, unknown>>(`${baseUrl}/models`).catch(() => undefined);
      const propsResponse = await fetchJson<Record<string, unknown>>(`${baseUrl}/props`).catch(() => undefined);

      const v1Models = extractModelList(v1ModelsResponse);
      const routerModels = extractModelList(routerModelsResponse);

      const routerEnabled = propsResponse?.role === "router" || routerModels.some(isRouterModel);
      const normalizedV1 = normalizeV1Models(v1Models);
      const normalizedRouter = normalizeRouterModels(routerModels);
      const models = routerEnabled ? normalizedRouter.models : normalizedV1;
      const loadedInstances = routerEnabled
        ? normalizedRouter.instances
        : normalizedV1.map((model) => ({
            id: model.id,
            modelId: model.id,
            runtimeId: "llamacpp-server",
            status: "loaded" as const,
            config: {},
            capabilities: [],
            raw: model.raw,
          }));
      const reachable = Boolean(health) || Boolean(v1ModelsResponse) || Boolean(routerModelsResponse) || Boolean(propsResponse);

      const warnings: string[] = [];
      const diagnosis: string[] = [];
      if (reachable && !routerEnabled && models.length > 0) {
        diagnosis.push("llama.cpp server is reachable in single-model mode; model load and unload controls require llama.cpp router mode.");
      }
      if (models.length === 0 && reachable) {
        warnings.push("llama.cpp is reachable, but it did not report any models.");
      }

      return {
        runtime: identity,
        installed: Boolean(commandVersion) || reachable,
        reachable,
        healthy: health?.status === 200 || health?.status === 503,
        version: commandVersion,
        capabilities: createCapabilities(routerEnabled),
        models,
        loadedInstances,
        warnings,
        diagnosis,
        raw: {
          healthStatus: health?.status,
          v1ModelsResponse,
          routerModelsResponse,
          propsResponse,
        },
      };
    },
    async generate(request: ChatRequest) {
      return await generateOpenAICompatibleResponse(apiBase, request, options.apiKey ?? "llama.cpp");
    },
    async *stream(request: ChatRequest) {
      yield* streamOpenAICompatibleResponse(apiBase, request, options.apiKey ?? "llama.cpp");
    },
    async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
      const response = await postJson<Record<string, unknown>>(`${apiBase}/embeddings`, {
        model: request.model,
        input: request.input,
      }, {
        signal: request.signal,
        headers: {
          authorization: `Bearer ${options.apiKey ?? "llama.cpp"}`,
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
    lifecycle: {
      async loadModel(modelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/models/load`, {
          model: modelId,
        });
      },
      async unloadModel(modelId: string): Promise<Record<string, unknown>> {
        return await postJson<Record<string, unknown>>(`${baseUrl}/models/unload`, {
          model: modelId,
        });
      },
    },
  };
}
