import { createRuntime, type Runtime } from './runtime.js';
import type { CliOptions } from './args.js';
import { listGeminiModels, listLiteRtLmModels, listLlamaCppModels, listLmStudioModels, listOllamaModels } from '@gemma-sdk/agent';
import { cliVersion } from './version.js';

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class AcpRuntime {
  private runtime?: Runtime;

  constructor(private readonly options: CliOptions) {}

  async handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown>> {
    if (!request.method) {
      return this.error(request.id, -32600, 'Invalid request.');
    }

    try {
      switch (request.method) {
        case 'initialize':
          this.runtime = await createRuntime(this.options);
          return this.result(request.id, {
            name: 'gemma-cli',
            version: cliVersion(),
            capabilities: ['session/new', 'session/prompt', 'models/list', 'skills/list']
          });
        case 'session/new':
          this.runtime = await createRuntime({ ...this.options, model: stringParam(request.params, 'model') ?? this.options.model });
          return this.result(request.id, { sessionId: 'default', model: this.runtime.model });
        case 'session/prompt': {
          const runtime = await this.ensureRuntime();
          const prompt = stringParam(request.params, 'prompt');
          if (!prompt) {
            return this.error(request.id, -32602, 'params.prompt is required.');
          }
          const response = await runtime.run(prompt);
          return this.result(request.id, { answer: response.answer, turns: response.turns, stats: response.stats });
        }
        case 'models/list':
          return this.result(request.id, { models: await listModels(this.options) });
        case 'skills/list': {
          const runtime = await this.ensureRuntime();
          return this.result(request.id, { skills: runtime.skills.map((skill) => ({ name: skill.name, path: skill.path })) });
        }
        default:
          return this.error(request.id, -32601, `Unknown method: ${request.method}`);
      }
    } catch (error) {
      return this.error(request.id, -32000, error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureRuntime(): Promise<Runtime> {
    this.runtime ??= await createRuntime(this.options);
    return this.runtime;
  }

  private result(id: JsonRpcRequest['id'], result: Record<string, unknown>): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  private error(id: JsonRpcRequest['id'], code: number, message: string): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }
}

async function listModels(options: CliOptions): Promise<string[]> {
  if (options.provider === 'lmstudio') {
    return listLmStudioModels(options.lmStudioUrl);
  }
  if (options.provider === 'llamacpp') {
    return listLlamaCppModels(options.llamaCppUrl);
  }
  if (options.provider === 'litertlm') {
    return listLiteRtLmModels(options.liteRtLmUrl);
  }
  if (options.provider === 'gemini') {
    return listGeminiModels(options.geminiApiKey, options.geminiApiBaseUrl);
  }
  return listOllamaModels(options.ollamaUrl);
}

export async function runAcp(options: CliOptions, input = process.stdin, output = process.stdout): Promise<void> {
  const runtime = new AcpRuntime(options);
  input.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const response = await runtime.handleRequest(JSON.parse(line) as JsonRpcRequest);
        output.write(`${JSON.stringify(response)}\n`);
      }
      newline = buffer.indexOf('\n');
    }
  }
}

function stringParam(params: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = params?.[name];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
