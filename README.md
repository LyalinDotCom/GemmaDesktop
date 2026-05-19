# Open Gemma Project

**Open Gemma Project** is a local-first monorepo for two maintained developer products on top of open models, with Gemma as the guided first-class path.

The active repo is intentionally centered on two runnable projects:

- **`gemma-desktop`** - an Electron desktop workbench for local model chat, coding, browsing, research, voice, and multimodal workflows.
- **`gemma-cli`** - a terminal coding agent optimized for local Gemma models.

Both products are built on the common **`@gemma-sdk/*`** packages in `gemma-sdk/`. The SDK is the foundation: runtime adapters, session orchestration, tool execution, prompt policy, tracing, attachment handling, and validation behavior should live there when they matter across products.

Legacy or paused experiments are not active products. In particular, **`archive/gemmadesktop-cli/` is archived and not maintained**; new command-line work belongs in `gemma-cli`, and shared behavior belongs in `gemma-sdk/`.

Gemma 4 is the primary target path. Other open models can work through Ollama, LM Studio, llama.cpp-compatible servers, and OpenAI-compatible runtimes when their capabilities are exposed clearly enough.

> **Status: alpha.** This is an independent fan project. It is not built by, endorsed by, sponsored by, or affiliated with Google, Google DeepMind, the Gemma team, Ollama, LM Studio, or any other vendor mentioned here. See [Alpha And Safety](#alpha-and-safety) before running it on important work.

## Why This Exists

Open models are getting useful fast, but shipping real software with them still means dealing with runtime quirks, capability mismatches, context limits, quantization tradeoffs, tool-calling failures, and backend-specific behavior.

Open Gemma Project is where those edges get made visible and testable. The goal is not to hide local inference behind a pleasant chat abstraction. The goal is to make model behavior, runtime behavior, tool behavior, and failure modes legible enough that developers can build durable products on top.

## Active Products

### Gemma CLI

`gemma-cli` is the canonical headless coding-agent product.

It can inspect a workspace, edit files, run commands, preserve diagnostics, resume sessions, and validate builds from a terminal. It is the fastest place to harden SDK-backed agent behavior because it removes Electron from the loop and makes live model behavior easier to reproduce.

The CLI is where the newest Gemma-optimized agent loop, tool design, recovery behavior, and validation evidence rules are expected to land first. When those capabilities are broadly useful, they should move into `@gemma-sdk/agent` or another shared SDK package.

Run it from source after building:

```bash
npm run build:gemma-cli
npm --workspace gemma-cli run start -- --provider ollama --model gemma4:26b --prompt "Inspect this repo and summarize it."
```

Useful validation:

```bash
npm run check:gemma-cli
```

### Gemma Desktop

`gemma-desktop` is the polished desktop workbench.

It provides local model chat, project-aware Work mode, a visible Project Browser, CoBrowse, multimodal attachments, PDF handling, research workflows, local speech-to-text, local read-aloud, memory, skills, MCP integration, model/runtime diagnostics, and a menu-bar assistant.

The desktop app should prove the SDK can power a real end-user product without bypassing SDK contracts. If desktop behavior depends on a model runtime, tool surface, session state, prompt policy, attachment path, or validation contract, that behavior should be represented in the SDK and testable headlessly where practical.

Run it in development:

```bash
npm run dev
```

Useful validation:

```bash
npm run check:gemma-desktop
```

## Shared SDK

`gemma-sdk/` contains the shared packages used by both runnable products.

Current package families include:

- `@gemma-sdk/agent` - Gemma-optimized agent loop, model providers, profiles, skills, and workspace tools.
- `@gemma-sdk/core` - session and prompt infrastructure, build-mode validation, runtime contracts, tracing, and transport types.
- `@gemma-sdk/tools` - shared built-in tools and tool runtime helpers.
- `@gemma-sdk/node` - Node-oriented SDK utilities.
- `@gemma-sdk/runtime-*` - runtime adapters for Ollama, LM Studio, llama.cpp, and oMLX-style servers.

The SDK should make runtimes, model behavior, tool use, and failure modes more legible rather than hiding them behind misleading abstractions.

Useful validation:

```bash
npm run check:sdk
```

## Repository Layout

```text
gemma-cli/        Terminal coding-agent product and CLI-specific tests/docs.
gemma-desktop/    Electron + React desktop product.
gemma-sdk/        Shared SDK packages consumed by both products.
docs/             Root-level product screenshots and shared docs.
archive/          Archived or paused project snapshots, not active products.
```

The long-term shape is:

- `gemma-cli` and `gemma-desktop` remain the two runnable products.
- `gemma-sdk` remains the shared foundation.
- SDK-backed behavior should have CLI/headless coverage when practical.
- Product-specific UI and packaging should stay in the owning product folder.

## Archived Projects

`archive/gemmadesktop-cli/` is a legacy Gemma Desktop CLI experiment retained only as historical reference. It is not maintained, not part of the active npm workspace, not part of the release path, and should not be used as the source of truth for current command-line behavior.

For current terminal work, use `gemma-cli/`. For behavior shared between the desktop app and CLI, use `gemma-sdk/`.

## Getting Started

Prerequisites:

- Node.js 20+
- npm
- macOS for the desktop app
- A local model runtime, with Ollama as the default path

Install dependencies:

```bash
npm install
```

Pull the default local model:

```bash
ollama pull gemma4:26b
```

Build the CLI and SDK path:

```bash
npm run build:gemma-cli
```

Run the desktop app:

```bash
npm run dev
```

Run deterministic validation for the full repo:

```bash
npm run check
```

Run deterministic plus live-model validation:

```bash
npm run check:full
```

## Model Defaults

The guided Gemma path currently centers on:

| Model | Tag | Typical Role |
| --- | --- | --- |
| Gemma 4 26B | `gemma4:26b` | Primary local model for main CLI/app validation |
| Gemma 4 31B | `gemma4:31b` | Stronger main model when the machine has enough headroom |
| Gemma 4 E2B/E4B | `gemma4:e2b`, `gemma4:e4b` | Helper-scoped tasks such as titles, narration, or low-risk summaries |

Main product behavior should be validated with `gemma4:26b` or stronger unless a test is explicitly targeting a smaller helper-class model.

## Development Principles

- Keep core behavior in the SDK when both products need it.
- Treat the CLI as the fastest reproducible harness for agent behavior.
- Treat the desktop app as proof that the SDK can support a polished product.
- Prefer honest abstractions over magical ones.
- Make runtime, model, and tool failures observable.
- Add focused tests for contracts that matter.
- Use live tests when behavior depends on real models, tools, files, websites, or runtimes.

## Alpha And Safety

This is experimental local-agent software.

- Output can be wrong, incomplete, unsafe, or inconsistent.
- Local tools can read and modify files when enabled.
- Shell commands run in working directories and can have side effects.
- Web pages, PDFs, images, audio, video, and source files can contain prompt-injection content.
- Local model runtimes can stall, crash, stream malformed output, or behave differently across versions.
- Loading multiple large local models can destabilize a machine.

Use version control, inspect diffs, and run validation before trusting generated changes.

## Affiliation

Open Gemma Project is an independent fan project. It is not built by, endorsed by, sponsored by, or affiliated with Google, Google DeepMind, the Gemma team, Ollama, LM Studio, or any other vendor mentioned in this repository.

"Gemma" is a trademark of its respective owner. This project uses the name to describe the model family it is primarily built around.

## License

This repository is licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) for the full text and [`NOTICE`](NOTICE) for attribution.

The published `gemma-cli` package on npm carries the same license. The shared `@gemma-sdk/agent` workspace package is intentionally not published — its code is bundled into the products that consume it (currently `gemma-cli`, eventually `gemma-desktop`), so consumers only ever install the product packages.
