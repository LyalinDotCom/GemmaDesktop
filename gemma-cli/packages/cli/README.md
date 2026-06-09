# gemma-cli

`gemma-cli` is the terminal coding agent from the Open Gemma Project. It is optimized for Gemma models, built on the shared Gemma SDK, and designed for local-first development against open model runtimes.

The default path runs against a local runtime such as Ollama, LM Studio, llama.cpp, or LiteRT-LM. A Gemini API provider is also available when you explicitly choose `--provider gemini`.

> **Status: alpha.** Independent fan project; not affiliated with Google, the Gemma team, Ollama, LM Studio, llama.cpp, LiteRT-LM, or Google Gemini. Model output can be wrong or unsafe. Use version control, inspect diffs, and validate generated code before trusting it.

## Install

```bash
npm install -g gemma-cli
```

Or run without installing:

```bash
npx gemma-cli --prompt "Summarize this repo"
```

Requirements:

- Node.js 20 or newer
- At least one supported model runtime or API provider
- A downloaded or loaded model in that runtime
- `ffmpeg` and `ffprobe` only when asking the CLI to sample video files

The npm package bundles the SDK code it needs. You do not need to install `@gemma-sdk/*` packages separately.

## Quick Start With Ollama

Install Ollama, pull the default model, then run `gemma` from a project directory:

```bash
ollama pull gemma4:26b
cd /path/to/project
gemma
```

With no prompt, scenario, or ACP flag, `gemma` starts the interactive terminal UI by default.

Run a one-shot prompt instead:

```bash
gemma --prompt "Inspect this repo and summarize the architecture."
```

Use a different model:

```bash
gemma --provider ollama --model gemma4:31b
```

List models visible to the selected provider:

```bash
gemma --provider ollama --list-models
```

## Supported Runtimes

`--provider` selects the inference adapter. Local providers use OpenAI-compatible inference endpoints where possible. Discovery may use provider-native APIs for richer model inventory, capability, and context metadata.

| Provider | `--provider` value | Default endpoint | Environment variables | Notes |
| --- | --- | --- | --- | --- |
| Ollama | `ollama` | `http://127.0.0.1:11434` | `OLLAMA_URL` | Default provider. Uses OpenAI-compatible inference and Ollama model metadata. Can auto-start local Ollama when using the default local endpoint. |
| LM Studio | `lmstudio` | `http://127.0.0.1:1234` | `LMSTUDIO_URL`, `LM_STUDIO_URL` | Requires the LM Studio local server. Uses `/v1/models` plus LM Studio native metadata when available. |
| llama.cpp server | `llamacpp` | `http://127.0.0.1:8080` | `LLAMACPP_URL`, `LLAMA_CPP_URL` | Requires a running llama.cpp OpenAI-compatible server. |
| LiteRT-LM | `litertlm` | `http://127.0.0.1:9379` | `LITERTLM_URL`, `LITERT_LM_URL` | Requires a running LiteRT-LM OpenAI-compatible server. |
| Gemini API | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY`, `GEMINI_API_BASE_URL` | Remote API provider. Only used when explicitly selected. |

Provider aliases accepted by the CLI:

- `llama.cpp`, `llama-cpp`, and `llama_cpp` map to `llamacpp`
- `litert-lm`, `litert_lm`, and `litert` map to `litertlm`

## Runtime Setup

### Ollama

Install Ollama and pull the model you want:

```bash
ollama pull gemma4:26b
gemma --provider ollama --model gemma4:26b
```

The Ollama default model is `gemma4:26b`. If the local default Ollama endpoint is not reachable, the CLI tries to start `ollama serve` unless `--no-ollama-autostart` is set.

For remote Ollama:

```bash
gemma --provider ollama --endpoint http://host:11434 --list-models
```

Ollama context must be configured in Ollama or in the model/runtime setup. `--context-tokens` is the CLI's target context budget for reporting and provider options; it does not download models or rewrite an Ollama model configuration.

### LM Studio

In LM Studio, install or load the model, start the local server, and then select the model name exactly as LM Studio exposes it:

```bash
gemma --provider lmstudio --list-models
gemma --provider lmstudio --model google/gemma-4-26b-a4b
```

For a non-default LM Studio server:

```bash
gemma --provider lmstudio --endpoint http://host:1234/v1 --model google/gemma-4-26b-a4b
```

LM Studio model context length is controlled by LM Studio. Set it there when you need large-context runs.

### llama.cpp

Start a llama.cpp server with the OpenAI-compatible API enabled, then list or select its model id:

```bash
gemma --provider llamacpp --endpoint http://127.0.0.1:8080 --list-models
gemma --provider llamacpp --endpoint http://127.0.0.1:8080 --model gemma-4-12b-it
```

### LiteRT-LM

Start LiteRT-LM's OpenAI-compatible server, then select the exposed model id:

```bash
gemma --provider litertlm --endpoint http://127.0.0.1:9379 --list-models
gemma --provider litertlm --endpoint http://127.0.0.1:9379 --model gemma4-12b,gpu,32768
```

### Gemini API

Gemini is opt-in and remote. Configure an API key first:

```bash
export GEMINI_API_KEY=...
gemma --provider gemini --list-models
gemma --provider gemini --model gemini-3.5-flash --prompt "Summarize this repository."
```

The Gemini default model is `gemini-3.5-flash`.

## Models

Use `--model` for exact model selection:

```bash
gemma --provider ollama --model gemma4:31b
gemma --provider lmstudio --model google/gemma-4-31b
gemma --provider llamacpp --model gemma-4-12b-it
gemma --provider litertlm --model gemma4-12b,gpu,32768
gemma --provider gemini --model gemini-3.5-flash
```

Defaults:

| Provider | Default model |
| --- | --- |
| Ollama | `gemma4:26b` |
| Gemini | `gemini-3.5-flash` |
| LM Studio, llama.cpp, LiteRT-LM | `gemma-3-27b-it` fallback; pass `--model` or select one in the TUI for real work |

Recommended Gemma local models:

| Model | Typical use |
| --- | --- |
| `gemma4:26b` | Primary local coding model when hardware allows |
| `gemma4:31b` | Larger local model when you have more memory and time |
| `gemma4:12b` | Medium local model for lighter coding and analysis |
| `gemma4:e2b`, `gemma4:e4b` | Helper-scoped or lightweight tasks |

The CLI does not download models for you. It detects and reports missing models, but runtime setup stays explicit.

## Endpoint Selection

Use `--endpoint` as the generic endpoint flag for the selected provider:

```bash
gemma --provider ollama --endpoint 100.104.166.87:11434 --list-models
gemma --provider lmstudio --endpoint http://host:1234/v1 --list-models
gemma --provider llamacpp --endpoint http://127.0.0.1:8080 --list-models
gemma --provider litertlm --endpoint http://127.0.0.1:9379 --list-models
gemma --provider gemini --endpoint https://generativelanguage.googleapis.com/v1beta --list-models
```

The CLI accepts common pasted endpoint shapes:

- `host:port`
- runtime root URLs
- `/v1` URLs
- `/v1/models`
- `/v1/chat/completions`
- Ollama native paths such as `/api/tags`
- Gemini `/models` and `:streamGenerateContent` URL shapes

Provider-specific endpoint flags are also available:

```bash
gemma --ollama-url http://host:11434
gemma --lmstudio-url http://host:1234
gemma --llamacpp-url http://host:8080
gemma --litertlm-url http://host:9379
gemma --gemini-api-base-url https://generativelanguage.googleapis.com/v1beta
```

## Interactive TUI

Start the TUI:

```bash
gemma
```

Useful TUI commands:

| Command | What it does |
| --- | --- |
| `/help` | Show compact TUI help |
| `/commands` | Show the command palette |
| `/model` | Open the model picker across available providers |
| `/model <provider> <model>` | Switch provider and model |
| `/endpoint` | Show endpoint examples |
| `/endpoint <url>` | Set the current provider endpoint |
| `/endpoint <provider> <url>` | Set a provider endpoint without switching models |
| `/think auto\|on\|off` | Show or change reasoning mode |
| `/settings` | Show runtime and TUI settings |
| `/settings maxTurns <n\|unlimited>` | Change the agent turn limit |
| `/status` | Show current provider, model, generation settings, and context estimates |
| `/stats` | Show stats from the last model run |
| `/sessions` | List resumable sessions for the workspace |
| `/resume <number\|session-id>` | Resume a previous session |
| `/skills` | Show loaded local skills |
| `/run <command>` | Run one shell command through the CLI tool surface |
| `! <command>` | Shortcut for `/run <command>` |
| `! -i <command>` | Attach your terminal to an interactive command |
| `!!` | Repeat the last shell command interactively |
| `/scroll up`, `/scroll down` | Move the history viewport |
| `/scroll top`, `/scroll bottom` | Jump to the oldest or newest retained history |
| `/history` | Show history count and scroll offset |
| `/clear` | Clear visible TUI history |
| `/clear-input` | Clear the current input buffer |
| `/debug:prompt` | Show the full composed system prompt in the TUI history |
| `/quit` | Exit |

The TUI can switch between Ollama, LM Studio, llama.cpp, LiteRT-LM, and Gemini models when those providers are reachable.

## Headless Runs

One-shot prompt:

```bash
gemma --prompt "Find the main entry point and explain how startup works."
```

The CLI also accepts positional prompt text:

```bash
gemma "Summarize package.json"
```

Run in another directory:

```bash
gemma --cwd /path/to/project --prompt "Inspect this project."
```

Limit model/tool turns:

```bash
gemma --max-turns 8 --prompt "Make a small, focused change and run the relevant test."
```

Run a built-in scenario:

```bash
gemma --scenario file-analysis
```

Available scenarios:

| Scenario | Description |
| --- | --- |
| `script-generation` | Generate a small shell script without executing it |
| `file-analysis` | Read a small project file and summarize its purpose |
| `code-generation` | Create a small JavaScript utility module |
| `workspace-search` | Use a read-only command to locate TypeScript source files |

## JSON And Automation

Print a structured final result:

```bash
gemma --json --prompt "Summarize this repo"
```

Stream JSONL progress events:

```bash
gemma --json-stream --prompt "Inspect the tests and summarize failures"
```

`--json-stream` emits events such as `run_started`, `model_start`, `model_activity`, `tool_start`, `tool_result`, `final_turn`, `run_completed`, `run_failed`, and `cli_error`.

Headless results include provider/model information, resolved settings, context metadata, turns, completion status, and model-run metrics. Metrics include wall duration, model-call duration, first output latency when available, content/thinking character counts, estimated or provider output tokens, and tokens per second.

## Sessions And Diagnostics

Gemma CLI stores workspace-local session and diagnostic data in `.gemmacli` by default:

- `.gemmacli/sessions/*.json` stores resumable conversation/session state
- `.gemmacli/logs/*.jsonl` stores diagnostic events and model/tool evidence

List sessions:

```bash
gemma --list-sessions
```

Resume the latest session:

```bash
gemma --resume
```

Resume by id or id prefix:

```bash
gemma --resume 018f
```

Override the diagnostics root:

```bash
GEMMA_CLI_DIAGNOSTICS_DIR=/tmp/gemma-cli-runs gemma --prompt "Run a quick check"
```

## Skills

Skills are local Markdown or text instruction files loaded into the agent context.

Workspace skills live in:

```text
.gemma/skills
```

User skills live in:

```text
~/.gemmacli/skills
```

Each skill can be a `.md` or `.txt` file, or a directory containing `SKILL.md`. Optional frontmatter supports `name:` and `description:`.

Load a skill explicitly:

```bash
gemma --skill "React App Builder" --prompt "Build a small React dashboard"
```

Repeat `--skill` to load more than one. Workspace skills are loaded by default; user skills are loaded when selected or when auto-detected for supported prompts.

## Media Inputs

The CLI can attach local media files when you mention them in the prompt. Use `@path` or a quoted/relative/absolute path:

```bash
gemma --provider ollama --model gemma4:e4b --prompt "Transcribe @samples/audio.wav"
gemma --provider lmstudio --model google/gemma-4-12b --prompt "Describe @images/scene.jpg"
gemma --provider gemini --prompt "Summarize @docs/spec.pdf"
```

Supported file extensions:

| Type | Extensions | Notes |
| --- | --- | --- |
| Images | `.png`, `.webp`, `.gif`, `.jpg`, `.jpeg` | Large local images are downsampled on macOS before request upload. |
| Audio | `.wav`, `.mp3`, `.m4a`, `.aac`, `.flac` | Requires a selected provider/model with audio enabled. |
| Video | `.mp4`, `.mov`, `.m4v`, `.webm` | The CLI samples frames with `ffmpeg`; the model receives images, not the raw video stream. |
| PDF | `.pdf` | Currently available through Gemini provider capability metadata. |

Current capability gates:

- Ollama supports image/audio attachments when the selected model metadata or Gemma model-family inference indicates support.
- LM Studio supports image/video-frame attachments when LM Studio metadata or Gemma model-family inference indicates image support.
- llama.cpp and LiteRT-LM are currently treated as text-only by the CLI.
- Gemini supports image, audio, and PDF attachments when the Gemini model list reports compatible capabilities.

For direct media questions such as describe, transcribe, identify, classify, or summarize, the CLI sends the media directly to the model and disables workspace tools for that turn so the model does not claim it needs filesystem tools to inspect the attachment.

## Command-Line Reference

| Flag | Default | Description |
| --- | --- | --- |
| `--prompt <text>`, `-p <text>` | None | Run a one-shot prompt and exit |
| `--scenario <id>`, `-s <id>` | None | Run a built-in scenario |
| `--skill <name>` | Workspace skills | Load a named skill from `~/.gemmacli/skills` or `.gemma/skills`; repeatable |
| `--provider <name>` | `ollama` | `ollama`, `lmstudio`, `llamacpp`, `litertlm`, or `gemini` |
| `--model <name>` | Provider-specific | Exact model id to request |
| `--endpoint <url>` | Provider-specific | Generic endpoint alias for the selected provider |
| `--ollama-url <url>` | `http://127.0.0.1:11434` | Ollama endpoint |
| `--lmstudio-url <url>`, `--lm-studio-url <url>` | `http://127.0.0.1:1234` | LM Studio endpoint |
| `--llamacpp-url <url>`, `--llama-cpp-url <url>` | `http://127.0.0.1:8080` | llama.cpp endpoint |
| `--litertlm-url <url>`, `--litert-lm-url <url>` | `http://127.0.0.1:9379` | LiteRT-LM endpoint |
| `--gemini-api-key <key>` | `GEMINI_API_KEY` | Gemini API key |
| `--gemini-api-base-url <url>` | `https://generativelanguage.googleapis.com/v1beta` | Gemini API base URL |
| `--cwd <path>` | Current directory | Workspace root for file and shell tools |
| `--max-turns <n>` | Unlimited | Maximum model/tool turns in an agent run |
| `--max-tokens <n>` | Provider settings | Maximum output tokens per model call |
| `--context-tokens <n>` | `262144` | Target context budget for reporting and provider options |
| `--temperature <n>` | `1` | Sampling temperature |
| `--top-p <n>` | `0.95` | Nucleus sampling value |
| `--top-k <n>` | `64` | Top-k value when the provider supports it |
| `--think <auto\|on\|off>` | `auto` | Reasoning control |
| `--shell-idle-timeout-ms <n>` | `300000` | No-output timeout for shell commands |
| `--no-ollama-autostart` | Off | Disable local Ollama auto-start |
| `--yolo` | Off | Allow tool commands to reference files outside the workspace without prompting |
| `--tui`, `-i` | Auto when no prompt | Start the terminal UI |
| `--acp` | Off | Start JSONL ACP-compatible stdio mode |
| `--json` | Off | Print a structured final result |
| `--json-stream` | Off | Print JSONL progress events and final result |
| `--resume [session-id]` | Off | Resume latest session or a specific session/id prefix |
| `--list-sessions` | Off | List resumable sessions for the workspace |
| `--list-models` | Off | List models for the selected provider |
| `--version`, `-v` | Off | Print the installed CLI version |
| `--help`, `-h` | Off | Show command help |

Reasoning behavior:

- `auto` enables Gemma 4 thinking instructions and provider-level reasoning when the selected model/provider supports it.
- `on` requests reasoning when supported.
- `off` disables Gemma thinking instructions and provider-level reasoning controls.
- Some providers or models do not expose reasoning controls; the CLI reports and retries where it can.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `GEMMA_PROVIDER` | Default provider. Invalid values fall back to `ollama`. |
| `GEMMA_MODEL` | Default model id. |
| `GEMMA_ENDPOINT` | Generic endpoint alias for the selected provider. |
| `GEMMA_CWD` | Default workspace root. |
| `GEMMA_CLI_DIAGNOSTICS_DIR` | Override `.gemmacli` diagnostics/session storage root. |
| `GEMMA_CLI_HOME` | Override the user skill root; defaults to `~/.gemmacli`. |
| `GEMMA_CLI_SHELL_IDLE_TIMEOUT_MS` | Default no-output shell timeout. |
| `GEMMA_SHELL_IDLE_TIMEOUT_MS` | Backward-compatible shell timeout variable. |
| `OLLAMA_URL` | Ollama endpoint. |
| `LMSTUDIO_URL`, `LM_STUDIO_URL` | LM Studio endpoint. |
| `LLAMACPP_URL`, `LLAMA_CPP_URL` | llama.cpp endpoint. |
| `LITERTLM_URL`, `LITERT_LM_URL` | LiteRT-LM endpoint. |
| `GEMINI_API_KEY` | Gemini API key. |
| `GEMINI_API_BASE_URL` | Gemini API base URL. |

Example:

```bash
GEMMA_PROVIDER=lmstudio GEMMA_ENDPOINT=http://host:1234 gemma --list-models
```

## ACP Mode

Start the minimal JSONL Agent Client Protocol compatible stdio mode:

```bash
gemma --acp
```

Supported methods:

- `initialize`
- `session/new`
- `session/prompt` (conversation history is retained across prompts in the session)
- `models/list`
- `skills/list`

## Troubleshooting

Check installed version:

```bash
gemma --version
```

Check runtime visibility:

```bash
gemma --provider ollama --list-models
gemma --provider lmstudio --list-models
gemma --provider llamacpp --endpoint http://127.0.0.1:8080 --list-models
gemma --provider litertlm --endpoint http://127.0.0.1:9379 --list-models
gemma --provider gemini --list-models
```

Common issues:

| Symptom | What to check |
| --- | --- |
| `Ollama model "..." is not installed` | Pull the exact model with `ollama pull <model>`. |
| Ollama not reachable | Start `ollama serve`, check `OLLAMA_URL`, or remove `--no-ollama-autostart` for the default local endpoint. |
| LM Studio returns no models | Start the LM Studio server and make sure the model is installed or loaded. |
| Wrong model on LM Studio | Use `gemma --provider lmstudio --list-models` and pass the exact id. |
| llama.cpp or LiteRT-LM fails | Confirm the OpenAI-compatible server is running and that `/v1/models` returns a model id. |
| Gemini returns no models | Set `GEMINI_API_KEY`; `--list-models` returns an empty list without a key. |
| Large-context behavior is not as expected | Configure context in the runtime itself, especially Ollama and LM Studio. |
| Media path is ignored | Use `@path/to/file.ext`, a quoted path, or an absolute/relative path with a supported extension. |
| Video sampling fails | Install `ffmpeg` and `ffprobe`, or provide image frames directly. |
| Shell command appears stuck | Increase `--shell-idle-timeout-ms` for commands with long quiet periods. |

For reproducible debugging, run with `--json-stream` and inspect `.gemmacli/logs/*.jsonl`.

## Source

`gemma-cli` is developed in the [Open Gemma Project monorepo](https://github.com/LyalinDotCom/GemmaDesktop) alongside the shared SDK and Gemma Desktop workbench.

## License

Apache License, Version 2.0. See the `LICENSE` file shipped in this package.
