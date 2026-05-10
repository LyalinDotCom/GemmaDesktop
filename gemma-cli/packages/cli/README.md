# Gemma CLI

Gemma CLI is an unofficial coding agent for terminal-based software work. It can inspect a workspace, edit files, run commands, keep local session diagnostics, and drive multi-turn coding tasks through local model providers.

This is not an official Google, DeepMind, Gemma, Ollama, or LM Studio project. It is provided as-is, without warranties. It can run commands and modify files in your workspace, so use it at your own risk and review changes before trusting them.

## Install

```sh
npm install -g gemma-cli
```

Then start the terminal UI:

```sh
gemma
```

Run a single prompt:

```sh
gemma --prompt "summarize this repository"
```

## Supported Inference Stacks

Gemma CLI currently supports:

- Ollama, the default local provider. The default Ollama model is `gemma4:26b`.
- LM Studio, through its local server API.

Common examples:

```sh
gemma --provider ollama --model gemma4:26b
gemma --provider lmstudio --model google/gemma-4-31b
```

List local models:

```sh
gemma --provider ollama --list-models
gemma --provider lmstudio --list-models
```

## Gemma-Focused Behavior

The CLI is designed to work especially well with Gemma models. It includes Gemma 4 prompt formatting, reasoning controls, model profile labels, thinking stream handling where the provider exposes it, and fallback behavior for providers that do not expose the same reasoning controls.

The default settings intentionally favor long-context coding sessions. Ollama instability should be treated as a provider/runtime recovery problem rather than solved by shrinking context.

## Basic Capabilities

- Terminal UI with model selection and resumable local sessions.
- Headless prompt mode for scripts and test runs.
- JSON and JSONL streaming output for diagnostics and automation.
- Workspace tools for reading, writing, patching, and inspecting files.
- Command execution with visible tool results.
- Local diagnostics under `.gemmacli/` for session snapshots and event logs.
- Optional skills loaded from workspace skill files.

## Useful Commands

```sh
gemma --help
gemma --resume
gemma --resume <session-id>
gemma --json-stream --prompt "build and test this"
gemma --cwd /path/to/project
```

Inside the TUI, useful slash commands include:

```text
/model
/status
/stats
/sessions
/resume
/clear
/debug:prompt
/quit
```

## Warranty And Risk

Gemma CLI is experimental software. It may generate incorrect code, run the wrong command, misunderstand a repository, or corrupt files. Keep important work in version control, inspect diffs, and run your own validation before using its output.
