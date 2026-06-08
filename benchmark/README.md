# Open Gemma Benchmark

This folder is a standalone benchmark surface for Gemma CLI and Google Gemma model targets. It is designed to work from a clean clone without building the whole monorepo.

The benchmark philosophy is simple: prompt Gemma CLI like a normal user, let Gemma CLI and the selected runtime use their defaults, and record exactly what happened.

## Quick Start

```sh
cd benchmark
npm install
npm run benchmark:throughput:dry-run
npm run benchmark:throughput
```

`npm install` installs the published `gemma-cli` package into `benchmark/node_modules`. The scripts resolve `benchmark/node_modules/.bin/gemma` first, then fall back to `gemma` on `PATH`.

Reports are written to `benchmark/reports/`. Per-case Gemma CLI workspaces are written to `benchmark/workspaces/`. Both folders are ignored by git.

## Setup Contract

The benchmark scripts are intentionally not setup assistants.

They detect missing runtime commands, stopped endpoints, missing models, missing imports, missing model files, and unsupported runtime transports. They report or skip those cases honestly.

They do not:

- install Ollama, LM Studio, LiteRT-LM, llama.cpp, or other runtimes
- download or import model artifacts
- substitute community model variants when a Google model is missing
- change runtime defaults
- set generation controls such as temperature, top-p, top-k, max tokens, max turns, or context tokens

The benchmark repo plus a local npm install of `gemma-cli` is enough to run the scripts. Runtime servers and model files are the user's setup responsibility.

The only downloaded assets the scripts may fetch are the small public media fixtures when they are missing from `benchmark/fixtures/media/`. The current fixture files are checked in.

## Required Local Tools

Minimum local tools:

- Node.js `>=20`
- npm
- Gemma CLI from `npm install` in this folder

Provider-specific tools:

| Provider | Required local setup | Default endpoint |
| --- | --- | --- |
| Ollama | Ollama app/server, `ollama` CLI, Google Gemma models pulled locally | `http://127.0.0.1:11434` |
| LM Studio | LM Studio app, local server enabled, `lms` CLI, Google model ids installed locally | `http://127.0.0.1:1234` |
| LiteRT-LM | `litert-lm serve` running and imported model ids available | `http://127.0.0.1:9379` |
| llama.cpp | `llama-server` available, plus Google QAT GGUF files when using managed mode | `http://127.0.0.1:8080` |

No environment variables are required for the current benchmark scripts. Use command-line flags for endpoint overrides.

## Last Tested Stack

Use these versions or newer for comparable runs unless you are intentionally testing older runtime behavior. These are reproducibility anchors from the latest canonical report set, not hidden script requirements.

| Component | Last tested |
| --- | --- |
| Host | macOS darwin/arm64 |
| Node.js | `v24.14.1` |
| Gemma CLI | `gemma-cli 0.1.11` local repo build |
| Ollama | `0.30.6` |
| LM Studio CLI | `lms CLI commit efce996` |
| LiteRT-LM | `0.13.1` |
| llama.cpp | build `9430 (d48a56eff)` |

The latest reports used a local Gemma CLI build because they validated a direct-media fix before it was committed. Clean-clone usage still follows the intended path: `cd benchmark && npm install`, then run the scripts through the npm-installed CLI.

## Model Matrix

Default model matrices use only Google-provided Gemma models for the target weights. If one is missing locally, the affected row is skipped. Do not replace a missing Google model with a community, quantizer, MLX-community, bartowski, unsloth, or other non-Google variant.

### Ollama

Install the Google Gemma targets you want to compare:

```sh
ollama pull gemma4:e2b
ollama pull gemma4:e4b
ollama pull gemma4:12b
ollama pull gemma4:26b
ollama pull gemma4:31b
ollama pull gemma4:12b-mlx
ollama pull gemma4:26b-mlx
ollama pull gemma4:31b-mlx
```

Recommended observed context and defaults for apples-to-apples local runs:

| Model | Context | Temperature | Top-p | Top-k | Quantization |
| --- | ---: | ---: | ---: | ---: | --- |
| `gemma4:e2b` | `131072` | `1` | `0.95` | `64` | `Q4_K_M` |
| `gemma4:e4b` | `131072` | `1` | `0.95` | `64` | `Q4_K_M` |
| `gemma4:12b` | `262144` | `1` | `0.95` | `64` | `Q4_K_M` |
| `gemma4:26b` | `262144` | `1` | `0.95` | `64` | `Q4_K_M` |
| `gemma4:31b` | `262144` | `1` | `0.95` | `64` | `Q4_K_M` |
| `gemma4:12b-mlx` | `131072` | `1` | `0.95` | `64` | `NVFP4` |
| `gemma4:26b-mlx` | `262144` | `1` | `0.95` | `64` | `NVFP4` |
| `gemma4:31b-mlx` | `262144` | `1` | `0.95` | `64` | `NVFP4` |

Configure Ollama model context in Ollama itself. The benchmark records the context reported by Ollama; it does not pass context flags to Gemma CLI.
For Gemma MLX comparison rows, use the low-bit `*-mlx` or `*-nvfp4` tags as the primary apples-to-apples lane. BF16 MLX tags are precision-ceiling fallbacks and should not be treated as the main performance comparison against Q4/NVFP4 regular or Qwen rows.

The large-context comparison also includes nearest Qwen 3.6 comparison targets when installed:

```sh
ollama pull qwen3.6:27b
ollama pull qwen3.6:27b-mlx
ollama pull qwen3.6:35b-a3b
ollama pull qwen3.6:35b-mlx
```

### LM Studio

Install the matching Google-owned LM Studio model ids:

```sh
lms get google/gemma-4-e2b --gguf
lms get google/gemma-4-e4b --gguf
lms get google/gemma-4-12b --gguf
lms get google/gemma-4-26b-a4b --gguf
lms get google/gemma-4-31b --gguf
```

For large-context Gemma MLX comparison rows, install the concrete MLX repos used by the current LM Studio runtime:

```sh
lms get https://huggingface.co/mlx-community/gemma-4-12B-it-4bit --yes
lms get https://huggingface.co/jedisct1/gemma-4-12B-it-txt-mlx-8bit --yes
lms get google/gemma-4-26b-a4b-qat --mlx
lms get https://huggingface.co/lmstudio-community/gemma-4-31B-it-MLX-4bit --yes
```

Recommended LM Studio model settings:

| Runtime key | Source package | Max context | Last tested quantization |
| --- | --- | ---: | --- |
| `google/gemma-4-e2b` | `lmstudio-community/gemma-4-E2B-it-GGUF` | `131072` | `Q4_K_M` |
| `google/gemma-4-e4b` | `lmstudio-community/gemma-4-E4B-it-MLX-8bit` | `131072` | `8bit` |
| `google/gemma-4-12b` | `lmstudio-community/gemma-4-12B-it-GGUF` | `262144` | `Q4_K_M` |
| `gemma-4-12b-it@4bit` | `mlx-community/gemma-4-12B-it-4bit` | `131072` | `4bit` MLX |
| `gemma-4-12b-it-txt-mlx` | `jedisct1/gemma-4-12B-it-txt-mlx-8bit` | `131072` | `8bit` text-only MLX fallback |
| `google/gemma-4-26b-a4b` | `lmstudio-community/gemma-4-26B-A4B-it-GGUF` | `262144` | `Q8_0` |
| `google/gemma-4-26b-a4b-qat` | `lmstudio-community/gemma-4-26B-A4B-it-QAT-MLX-4bit` | `262144` | `4bit` MLX |
| `google/gemma-4-31b` | `lmstudio-community/gemma-4-31B-it-GGUF` | `262144` | `Q4_K_M` |
| `gemma-4-31b-it-mlx` | `lmstudio-community/gemma-4-31B-it-MLX-4bit` | `262144` | `4bit` MLX |

Set max context inside LM Studio's model settings before the run. The benchmark records the max context exposed by LM Studio and does not force it. Leave generation settings at runtime defaults.
Use low-bit MLX variants as the primary apples-to-apples performance lane. The benchmark keeps BF16 packages as precision-ceiling fallbacks only. On the last local validation, LM Studio exposed the 12B `mlx-community/gemma-4-12B-it-4bit` package but failed to load it because the MLX runtime reported missing `gemma4_unified` support; that should be preserved as runtime evidence if it still fails.

For the large-context Qwen comparison, install both GGUF and MLX variants for the Qwen model ids:

```sh
lms get qwen/qwen3.6-27b --gguf
lms get qwen/qwen3.6-27b --mlx
lms get qwen/qwen3.6-35b-a3b --gguf
lms get qwen/qwen3.6-35b-a3b --mlx
```

Recommended LM Studio Qwen context for the large-context run is `262144` for `qwen/qwen3.6-27b` and `qwen/qwen3.6-35b-a3b`. Configure this in LM Studio before the run. If LM Studio autoloads a model at `4096`, the report should expose that as configuration evidence instead of hiding it.

LM Studio exposes downloaded GGUF and MLX variants through `lms ls --variants --json`, but its OpenAI model list exposes only the selected base model id. The large-context script uses the LM Studio SDK bundled with the local LM Studio installation to pre-load exact Qwen variants under benchmark identifiers, then calls Gemma CLI normally against those loaded identifiers. It does not pass context, temperature, max-token, or other generation tuning values. If the bundled SDK cannot be found, exact LM Studio variant rows are skipped with a setup message.

### LiteRT-LM

The default LiteRT-LM matrix covers the currently imported public LiteRT-LM Gemma 4 targets:

- `gemma4-e2b,gpu,32768`
- `gemma4-e4b,gpu,32768`
- `gemma4-12b,gpu,32768`

The `,gpu,32768` suffix is the LiteRT-LM model-id form for selecting the GPU backend and a 32K runtime context. The benchmark does not pass Gemma CLI generation or context flags.

### llama.cpp

The default llama.cpp matrix uses Google-owned QAT GGUF ids:

- `google/gemma-4-E2B-it-qat-q4_0-gguf`
- `google/gemma-4-E4B-it-qat-q4_0-gguf`
- `google/gemma-4-12B-it-qat-q4_0-gguf`
- `google/gemma-4-26B-A4B-it-qat-q4_0-gguf`
- `google/gemma-4-31B-it-qat-q4_0-gguf`

For managed llama.cpp runs, point the benchmark at a directory containing the matching Google GGUF files:

```sh
node gemma-model-throughput.mjs --provider llamacpp --llamacpp-models-dir /path/to/google-gemma4-gguf
```

The benchmark starts one `llama-server` per case in managed mode and stops that process after the case.

## Running Benchmarks

Preview a throughput matrix without loading models:

```sh
npm run benchmark:throughput:dry-run
```

Run the default Ollama throughput matrix:

```sh
npm run benchmark:throughput
```

Run the report-grade local Ollama and LM Studio comparison:

```sh
node gemma-model-throughput.mjs --providers ollama,lmstudio --clean-runtime
```

Run media benchmarks:

```sh
npm run benchmark:image
npm run benchmark:audio
```

Run report-grade media comparisons across Ollama and LM Studio:

```sh
node gemma-image-description.mjs --providers ollama,lmstudio --clean-runtime
node gemma-audio-transcription.mjs --providers ollama,lmstudio --clean-runtime
```

Run the large-context comparison for Gemma regular/MLX and nearest Qwen 3.6 comparison targets:

```sh
node gemma-large-context-comparison.mjs
node gemma-large-context-comparison.mjs --scenario prefill-80k --think off
```

Render a Markdown report into a self-contained static HTML dashboard:

```sh
npm run report:site -- --input reports/manual-run.md --output reports/manual-run.html
```

Combine canonical report Markdown files into one model-data report:

```sh
node gemma-combine-reports.mjs --output reports/combined-gemma-model-data.md
npm run report:site -- --input reports/combined-gemma-model-data.md --output reports/combined-gemma-model-data.html
```

## Useful Options

```sh
node gemma-model-throughput.mjs --models gemma4:e2b,gemma4:e4b --think on,off
node gemma-model-throughput.mjs --model gemma4:26b --think off
node gemma-model-throughput.mjs --providers ollama,lmstudio
node gemma-model-throughput.mjs --provider litertlm --litertlm-endpoint http://127.0.0.1:9379
node gemma-model-throughput.mjs --provider llamacpp --llamacpp-models-dir /path/to/google-gemma4-gguf
node gemma-model-throughput.mjs --ollama-endpoint http://127.0.0.1:11434 --lmstudio-endpoint http://127.0.0.1:1234
node gemma-model-throughput.mjs --providers ollama,lmstudio --clean-runtime
node gemma-model-throughput.mjs --prompt-file ./my-prompt.txt
node gemma-model-throughput.mjs --output ./reports/manual-run.md
node gemma-large-context-comparison.mjs --target ollama:gemma4:regular:26b --scenario prefill-80k --think off
```

Media scripts share the same runtime/model options and add fixture selection:

```sh
node gemma-image-description.mjs --fixture apollo-buzz-aldrin --model gemma4:26b --think off
node gemma-image-description.mjs --fixtures apollo-buzz-aldrin,cat-on-snow
node gemma-audio-transcription.mjs --fixture apollo-one-small-step --providers ollama,lmstudio
node gemma-audio-transcription.mjs --fixtures-dir ./fixtures/media
```

The large-context script defaults to Ollama plus LM Studio, clean runtime reset, both thinking modes, and both scenarios. It accepts the same endpoint and CLI options as the throughput script. It intentionally does not pass generation tuning flags.

For monorepo development, point the benchmark at a locally built CLI:

```sh
node gemma-model-throughput.mjs --cli-path ../gemma-cli/packages/cli/dist/index.js
node gemma-image-description.mjs --cli-path ../gemma-cli/packages/cli/dist/index.js
node gemma-audio-transcription.mjs --cli-path ../gemma-cli/packages/cli/dist/index.js
node gemma-large-context-comparison.mjs --cli-path ../gemma-cli/packages/cli/dist/index.js
```

## Expected Results

Expected row counts assume every recommended local model is installed and each runtime endpoint is reachable.

| Benchmark | Command shape | Expected rows |
| --- | --- | ---: |
| Ollama + LM Studio throughput | `node gemma-model-throughput.mjs --providers ollama,lmstudio --clean-runtime` | `20` completed rows |
| LiteRT-LM throughput | `node gemma-model-throughput.mjs --provider litertlm` | `6` completed rows |
| llama.cpp throughput | `node gemma-model-throughput.mjs --provider llamacpp --llamacpp-models-dir ...` | `10` completed rows |
| Ollama + LM Studio image description | `node gemma-image-description.mjs --providers ollama,lmstudio --clean-runtime` | `60` completed rows |
| Ollama + LM Studio audio transcription | `node gemma-audio-transcription.mjs --providers ollama,lmstudio --clean-runtime` | `6` completed rows plus `14` not-applicable rows |
| Ollama + LM Studio large context | `node gemma-large-context-comparison.mjs` | up to `80` completed rows, with missing MLX/Qwen rows skipped when not installed |

Missing local models are expected skips, not model failures. Missing runtime servers or unsupported transports should be reported clearly.

Audio is currently only executable for Ollama `gemma4:e2b`, `gemma4:e4b`, and `gemma4:12b` in the canonical suite. Ollama `26b` and `31b` are not tagged for audio input. LM Studio audio rows are recorded as not applicable when the runtime transport cannot deliver audio input to the model.

Some cases can take more than 10 minutes. The default throughput and media per-case timeout is `1200000` ms. The large-context comparison uses a `2700000` ms per-case timeout because 80K-token prefill on large local models can be substantially slower. Large LM Studio models may take more than 60 seconds to produce first output.

## What Reports Measure

Throughput reports use a fixed, easy code-generation prompt through Gemma CLI in `--json-stream` mode.

Media reports use fixed image-description or audio-transcription prompts with local fixtures. Raw model output or provider error is preserved in the final result column for manual review.

Large-context reports use a short control prompt and a deterministic local text prompt of about `80,000` estimated input tokens. The full long prompt is passed directly to Gemma CLI, but the Markdown report records the prompt size, hash, expected marker counts, and raw model output instead of embedding hundreds of kilobytes of prompt text.

Reports include:

- output tokens per second
- wall-clock output tokens per second
- total output token count
- token source, using provider usage when available and a 4-characters-per-token estimate otherwise
- first-output latency when available
- completion time when available
- model time when available
- answer size and run status
- Gemma CLI version and resolved CLI defaults
- provider, model, thinking mode, context, temperature, and max-token behavior for each case
- runtime versions and model configuration snapshots from provider APIs
- runtime reset and loaded-state evidence for clean-runtime runs
- fixture source, license, and reference description or transcript for media runs
- scenario id, prompt size, prompt hash, and expected marker values for large-context runs

The benchmark does not pass generation-tuning flags like `--temperature`, `--top-p`, `--top-k`, `--max-tokens`, `--max-turns`, or `--context-tokens`. If those values appear in a report, they were observed from Gemma CLI or the runtime.

## Runtime Cleanup

By default, the benchmark unloads each Ollama model after its case unless `--keep-model-loaded` is passed.

For LM Studio, the benchmark avoids unloading models that were already loaded before the case. If the benchmark caused a model to load, it tries to unload that model afterward and records cleanup failures honestly.

For managed llama.cpp cases, the benchmark stops the `llama-server` process it started for that case.

For report-grade comparisons, prefer:

```sh
node gemma-model-throughput.mjs --providers ollama,lmstudio --clean-runtime
node gemma-large-context-comparison.mjs
```

`--clean-runtime` unloads all resident Ollama and LM Studio models before and after each case and records reset evidence. It does not kill the Ollama or LM Studio app processes.

The large-context script enables clean runtime reset by default because the prompt prefill comparison is especially sensitive to resident-model state.

## Media Fixtures

Image fixtures:

- `apollo-buzz-aldrin`: NASA Apollo 11 photo of Buzz Aldrin on the Moon, public domain NASA source.
- `vangogh-starry-night`: Vincent van Gogh's 1889 painting The Starry Night, public-domain artwork reproduction.
- `cat-on-snow`: Wikimedia Commons image of a domestic cat on snow, CC BY-SA 3.0 / GNU FDL.

Audio fixture:

- `apollo-one-small-step`: NASA historical-sounds MP3 of Neil Armstrong's "one small step" line. Reference transcript: "That's one small step for (a) man, one giant leap for mankind."

Keep fixture details in sync with `fixtures/media/README.md` and `gemma-media-benchmark-core.mjs`.

## Interpreting Failures

Do not treat unexpected failures as stop criteria.

If a model/runtime combination should work for a user, investigate whether the failure is:

- a Gemma CLI bug
- an SDK/provider adapter bug
- a benchmark harness bug
- a runtime transport limitation
- a missing local model or model configuration problem
- a real model capability gap

Preserve useful failures in reports when they are real. Fix the product or harness when the failure is caused by Gemma CLI, SDK behavior, attachment routing, timeout policy, runtime detection, or report rendering.

## Future Capability Scripts

This folder is expected to grow into independent benchmark categories:

- throughput on fixed text/code prompts
- time to create a small working web app
- SVG creation quality and validity
- image description
- audio transcription
- video or frame analysis for models and runtimes that support visual attachments

Future scripts should keep the same shape: dependency-light Node entrypoints, fixed prompts, isolated workspaces, JSON-stream output where applicable, Markdown reports, static HTML dashboards, clean runtime evidence, and honest skips when local prerequisites are missing.
