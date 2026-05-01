# Gemma Desktop CLI

`gemmadesktop-cli` runs Gemma Desktop's SDK session path from Node without launching the Electron app. Use it for quick headless checks against the same SDK runtime adapters and request metadata shape the desktop app depends on.

## Basic Query

From the repository root:

```bash
npm --workspace gemmadesktop-cli run cli -- run "Say hello in one sentence." --model gemma4:e2b --runtime ollama-native
```

That command builds the CLI, creates an SDK session, streams the assistant text to stdout, and exits when the turn completes.

## Requirements

- Install workspace dependencies with `npm install` if they are missing.
- Start the target runtime first. For the default Ollama path, make sure Ollama is running at `http://127.0.0.1:11434`.
- Make sure the requested model is already installed in that runtime, for example:

```bash
ollama pull gemma4:e2b
```

## Common Syntax

Run a prompt:

```bash
npm --workspace gemmadesktop-cli run cli -- run "What is local inference?" --model gemma4:e2b --runtime ollama-native
```

Use stdin:

```bash
echo "Explain why SDK parity matters." | npm --workspace gemmadesktop-cli run cli -- run --model gemma4:e2b --runtime ollama-native
```

Preview the exact SDK session request without running a model turn:

```bash
npm --silent --workspace gemmadesktop-cli run cli -- preview --model gemma4:e2b --runtime ollama-native --json
```

Inspect configured runtimes:

```bash
npm --workspace gemmadesktop-cli run cli -- inspect
```

Emit JSON for automation:

```bash
npm --silent --workspace gemmadesktop-cli run cli -- run "Return a short JSON-ish summary of Gemma." --model gemma4:e2b --runtime ollama-native --json
```

Use `npm --silent` for JSON commands so npm does not print its lifecycle banner before the CLI's machine-readable output.

## On-Demand Deep Scenarios

The CLI includes a small catalog of slower headless scenarios for manual acceptance passes. These are intentionally not part of the default deterministic suite.

```bash
npm --silent --workspace gemmadesktop-cli run cli -- scenario run act-webapp-black-hole --model gemma4:31b --runtime ollama-native --cwd /tmp/gemma-headless-act --json
npm --silent --workspace gemmadesktop-cli run cli -- scenario run pdf-attention-authors --model gemma4:31b --runtime ollama-native --cwd /tmp/gemma-headless-pdf --json
npm --silent --workspace gemmadesktop-cli run cli -- scenario run web-hacker-news-frontpage --model gemma4:31b --runtime ollama-native --json
npm --silent --workspace gemmadesktop-cli run cli -- scenario run web-news-coverage-compare --model gemma4:31b --runtime ollama-native --json
npm --silent --workspace gemmadesktop-cli run cli -- scenario run research-gemma4-availability --model gemma4:31b --runtime ollama-native --json
```

Each scenario emits JSON with the session turns, artifact directory, evaluator checks, and issues. Use `gemma4:26b` or `gemma4:31b` for these runs; helper-class models are not suitable for judging the main headless behavior. ACT build runs default reasoning metadata to `off` so Gemma 4 starts coding sooner; pass `--reasoning on` or `--reasoning auto` to override that for diagnosis.

## Useful Options

- `--mode explore` or `--mode build`: choose the SDK mode preset.
- `--cwd <path>`: set the working directory for SDK tools and session context.
- `--only-tool <name>`: restrict the active mode to the listed SDK tools. Can repeat.
- `--tool <name>`: add an SDK tool to the active mode. Can repeat.
- `--without-tool <name>`: remove a tool from the active mode. Can repeat.
- `--approval-mode require|yolo`: require approval for risky build commands, or auto-approve commands that are not hard-denied.
- `--reasoning auto|on|off`: pass desktop-style reasoning metadata.
- `--ollama-option key=value`: pass numeric Ollama request options such as `num_ctx=8192`.
- `--ollama-keep-alive <value>`: pass the Ollama keep-alive value used by the request.
- `--ollama-response-header-timeout-ms <count>`: fail an Ollama request if response headers do not arrive within the timeout.
- `--ollama-stream-idle-timeout-ms <count>`: fail an accepted Ollama stream if no chunk arrives within the timeout.
- `--lmstudio-option key=value`: pass numeric LM Studio request options such as `temperature=0.8`.
- `--omlx-option key=value`: pass numeric oMLX request options such as `max_tokens=4096`.
- `--show-events`: mirror SDK events to stderr, or include them in JSON output.
- `--debug-runtime`: mirror runtime debug records to stderr as JSON lines.

## Runtime Defaults

When endpoint flags are omitted, the CLI mirrors the desktop defaults:

- Ollama: `http://127.0.0.1:11434`
- LM Studio: `http://127.0.0.1:1234`
- llama.cpp server: `http://127.0.0.1:8080`
- oMLX: `http://127.0.0.1:8000`

Override them with `--ollama-endpoint`, `--lmstudio-endpoint`, `--llamacpp-endpoint`, or `--omlx-endpoint`.
