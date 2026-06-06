# Open Gemma Benchmark Agent Guide

This folder is for user-shaped benchmark scenarios, not synthetic provider tuning.

## Philosophy

Benchmark scripts should exercise Gemma CLI the way a user would: choose a prompt, choose a model/runtime dimension to compare, run the CLI, and record what happened.

Do not pass generation-tuning flags such as `--temperature`, `--top-p`, `--top-k`, `--max-tokens`, `--max-turns`, or `--context-tokens` from benchmark scripts unless the benchmark is explicitly about that setting. For normal capability and throughput tests, Gemma CLI defaults are the product under test.

If a setting matters for interpreting a run, record it as observed metadata instead of forcing it. Reports should make the stack reproducible by capturing:

- Gemma CLI version and resolved CLI defaults
- provider, model, and thinking mode used for each case
- runtime versions for touched providers such as Ollama and LM Studio
- model context metadata, loaded context, temperature, max-token behavior, and other settings surfaced by Gemma CLI or the runtime
- Node, platform, and architecture for the benchmark host

## Benchmark Shape

Keep scripts dependency-light and runnable from a clean clone:

```sh
cd benchmark
npm install
npm run benchmark:throughput
```

The benchmark package may depend on the published `gemma-cli` package. Avoid extra npm dependencies unless there is a concrete reason they are required.

Prefer fixed prompts, isolated workspaces, JSON-stream output from Gemma CLI, markdown reports, and honest skips when a local runtime or model is unavailable.

Default model matrices must use only Google-provided base Gemma models for the target weights. Do not substitute community, quantizer, MLX-community, bartowski, unsloth, or other non-Google variants when a Google model is missing. Benchmark scripts should skip missing models; local setup and downloads belong outside the script.

## Runtime Handling

For Ollama live runs, unload models after each case unless the user explicitly asks to keep them loaded.

For LM Studio live runs, avoid disturbing models that were already loaded before the case. If a benchmark case caused a model to load, try to unload it after the case and record cleanup failures honestly.

For report-grade comparison runs, prefer `--clean-runtime`. This unloads all resident Ollama and LM Studio models before and after each case and records reset evidence. It should not hard-kill the Ollama or LM Studio app processes unless the user explicitly asks for process-level restarts.

Reports must include the runtimes touched, runtime versions, CLI versions, and model configuration snapshots from the available provider APIs. If a runtime does not expose a setting directly, record that absence instead of inventing or forcing a value.

## Future Capability Scripts

Future scripts should follow the same philosophy for web apps, SVG generation, audio transcription, and video or frame analysis: prompt like a user, let Gemma CLI own defaults, validate the resulting artifact, and record the exact stack that produced it.
