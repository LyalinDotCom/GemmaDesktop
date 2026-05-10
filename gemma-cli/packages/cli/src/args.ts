import type { ChatMessage } from '@gemma-sdk/agent';

export interface CliOptions {
  provider: 'ollama' | 'lmstudio';
  model?: string;
  ollamaUrl?: string;
  lmStudioUrl?: string;
  prompt?: string;
  scenario?: string;
  skills: string[];
  cwd: string;
  maxTurns?: number;
  maxTokens?: number;
  contextTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  reasoningMode: 'auto' | 'on' | 'off';
  shellIdleTimeoutMs?: number;
  ollamaAutoStart: boolean;
  yolo: boolean;
  tui: boolean;
  acp: boolean;
  json: boolean;
  jsonStream: boolean;
  resume?: string;
  listSessions?: boolean;
  listModels?: boolean;
  history?: ChatMessage[];
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    provider: env.GEMMA_PROVIDER === 'lmstudio' ? 'lmstudio' : 'ollama',
    model: env.GEMMA_MODEL,
    ollamaUrl: env.OLLAMA_URL,
    lmStudioUrl: env.LMSTUDIO_URL ?? env.LM_STUDIO_URL,
    skills: [],
    cwd: env.GEMMA_CWD ?? env.INIT_CWD ?? process.cwd(),
    contextTokens: 262_144,
    temperature: 1,
    topP: 0.95,
    topK: 64,
    reasoningMode: 'auto',
    shellIdleTimeoutMs: readOptionalPositiveInteger(env.GEMMA_CLI_SHELL_IDLE_TIMEOUT_MS ?? env.GEMMA_SHELL_IDLE_TIMEOUT_MS, 'GEMMA_CLI_SHELL_IDLE_TIMEOUT_MS'),
    ollamaAutoStart: true,
    yolo: false,
    tui: false,
    acp: false,
    json: false,
    jsonStream: false,
    listSessions: false,
    listModels: false,
    help: false,
    version: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--provider':
        options.provider = readProvider(readValue(argv, ++i, arg));
        break;
      case '--model':
        options.model = readValue(argv, ++i, arg);
        break;
      case '--ollama-url':
        options.ollamaUrl = readValue(argv, ++i, arg);
        break;
      case '--lmstudio-url':
      case '--lm-studio-url':
        options.lmStudioUrl = readValue(argv, ++i, arg);
        break;
      case '--prompt':
      case '-p':
        options.prompt = readValue(argv, ++i, arg);
        break;
      case '--scenario':
      case '-s':
        options.scenario = readValue(argv, ++i, arg);
        break;
      case '--skill':
        options.skills.push(readValue(argv, ++i, arg));
        break;
      case '--cwd':
        options.cwd = readValue(argv, ++i, arg);
        break;
      case '--max-turns':
        options.maxTurns = readPositiveInteger(readValue(argv, ++i, arg), arg);
        break;
      case '--max-tokens':
        options.maxTokens = readPositiveInteger(readValue(argv, ++i, arg), arg);
        break;
      case '--context-tokens':
        options.contextTokens = readPositiveInteger(readValue(argv, ++i, arg), arg);
        break;
      case '--temperature':
        options.temperature = readNumber(readValue(argv, ++i, arg), arg, 0, 5);
        break;
      case '--top-p':
        options.topP = readNumber(readValue(argv, ++i, arg), arg, 0, 1);
        break;
      case '--top-k':
        options.topK = readPositiveInteger(readValue(argv, ++i, arg), arg);
        break;
      case '--think':
        options.reasoningMode = readReasoningMode(readValue(argv, ++i, arg), arg);
        break;
      case '--shell-idle-timeout-ms':
        options.shellIdleTimeoutMs = readPositiveInteger(readValue(argv, ++i, arg), arg);
        break;
      case '--no-ollama-autostart':
        options.ollamaAutoStart = false;
        break;
      case '--yolo':
        options.yolo = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--json-stream':
        options.jsonStream = true;
        break;
      case '--resume':
        options.resume = readOptionalValue(argv, i + 1) ?? 'latest';
        if (options.resume !== 'latest') {
          i += 1;
        }
        break;
      case '--list-sessions':
        options.listSessions = true;
        break;
      case '--list-models':
        options.listModels = true;
        break;
      case '--tui':
      case '-i':
        options.tui = true;
        break;
      case '--acp':
        options.acp = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-v':
        options.version = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.prompt = [options.prompt, arg].filter(Boolean).join(' ');
    }
  }

  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readOptionalValue(argv: string[], index: number): string | undefined {
  const value = argv[index];
  return value && !value.startsWith('-') ? value : undefined;
}

function readProvider(value: string): CliOptions['provider'] {
  if (value === 'ollama' || value === 'lmstudio') {
    return value;
  }
  throw new Error('--provider must be ollama or lmstudio.');
}

function readReasoningMode(value: string, flag: string): CliOptions['reasoningMode'] {
  if (value === 'auto' || value === 'on' || value === 'off') {
    return value;
  }
  throw new Error(`${flag} must be auto, on, or off.`);
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function readOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  return readPositiveInteger(value, name);
}

function readNumber(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}
