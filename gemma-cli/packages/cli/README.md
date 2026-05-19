# gemma-cli

A local-first terminal coding agent optimized for Gemma models, with support for any OpenAI-compatible local runtime (Ollama, LM Studio, llama.cpp servers).

`gemma-cli` runs entirely on your machine against a local model. It can inspect a workspace, edit files, execute shell commands, capture diagnostics, resume sessions, and validate builds — all without sending your code to a remote API.

> **Status: alpha.** Independent fan project; not affiliated with Google, the Gemma team, Ollama, or LM Studio. Output can be wrong or unsafe — use version control and inspect diffs before trusting generated changes.

## Install

```bash
npm install -g gemma-cli
```

Or run without installing:

```bash
npx gemma-cli --prompt "Summarize this repo"
```

Requires Node.js 20+ and a running local model server.

## Quick start

Pull a Gemma model with Ollama:

```bash
ollama pull gemma4:26b
```

Launch the TUI in your project directory:

```bash
gemma
```

Or run a one-shot prompt:

```bash
gemma --prompt "Inspect this repo and summarize it."
```

Pick a scenario:

```bash
gemma --scenario file-analysis
```

## Common options

| Flag | Description |
| --- | --- |
| `--prompt <text>` | Run a one-shot prompt and exit |
| `--scenario <id>` | Run a fixed scenario |
| `--tui` | Force the interactive TUI |
| `--resume [session-id]` | Resume the last session, or a specific one |
| `--provider <ollama\|lmstudio>` | Choose runtime (default: ollama) |
| `--model <name>` | Override the default model |
| `--cwd <path>` | Workspace root (default: current directory) |
| `--max-turns <n>` | Cap on model/tool turns |
| `--think <auto\|on\|off>` | Reasoning control |
| `--acp` | Speak the Agent Client Protocol on stdio |

Run `gemma --help` for the full list.

## Defaults

| Model | Tag | Role |
| --- | --- | --- |
| Gemma 4 26B | `gemma4:26b` | Primary local model |
| Gemma 4 31B | `gemma4:31b` | Larger model when you have headroom |
| Gemma 4 E2B/E4B | `gemma4:e2b`, `gemma4:e4b` | Helper-scoped tasks |

Ollama base URL defaults to `http://127.0.0.1:11434`; LM Studio defaults to `http://127.0.0.1:1234`.

## Source

`gemma-cli` is developed in the [Open Gemma Project](https://github.com/) monorepo alongside the shared agent SDK and the Gemma Desktop workbench. The SDK code is bundled directly into this package — no separate `@gemma-sdk/*` install is needed.

## License

Apache License, Version 2.0. See the `LICENSE` file shipped in this package.
