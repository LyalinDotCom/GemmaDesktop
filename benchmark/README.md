# Open Gemma Benchmark

This folder is a standalone benchmark surface for Gemma models. It is meant to work from a clean clone without building the monorepo.

## Install

```sh
cd benchmark
npm install
```

That installs the published `gemma-cli` package and exposes the `gemma` command through `benchmark/node_modules/.bin`.

You also need an Ollama server and whatever models you want to test, for example:

```sh
ollama pull gemma4:e2b
ollama pull gemma4:e4b
ollama pull gemma4:12b
ollama pull gemma4:26b
ollama pull gemma4:31b
```

Missing models are skipped by default so partial local setups still produce a report.

The benchmark scripts detect missing runtime commands, stopped endpoints, missing imports, and missing model files, then report those prerequisites. They do not download models, import model artifacts, install runtimes, or change runtime defaults. Local setup belongs outside the benchmark command.

## Run

Preview the command matrix without loading models:

```sh
npm run benchmark:throughput:dry-run
```

Run the default throughput benchmark:

```sh
npm run benchmark:throughput
```

The default matrix tests:

- `gemma4:e2b`
- `gemma4:e4b`
- `gemma4:12b`
- `gemma4:26b`
- `gemma4:31b`
- thinking `on` and `off`

Reports are written to `benchmark/reports/`. Per-case Gemma CLI workspaces are written to `benchmark/workspaces/`. Both folders are ignored by git.

Turn a markdown report into a self-contained static HTML dashboard:

```sh
npm run report:site -- --input reports/manual-run.md --output reports/manual-run.html
```

The generated HTML has embedded CSS and JavaScript, no external dependencies, and sortable tables for the report data.

Run the media benchmarks:

```sh
npm run benchmark:image
npm run benchmark:audio
```

The media scripts download small open-source fixtures into `benchmark/fixtures/media/` when needed. The scripts do not download models. Missing models are skipped, and models without the required runtime media capability tag are skipped with that reason in the report.

For report-grade media comparison runs across both local runtimes:

```sh
node gemma-image-description.mjs --providers ollama,lmstudio --clean-runtime
node gemma-audio-transcription.mjs --providers ollama,lmstudio --clean-runtime
```

To compare both local runtimes when LM Studio is running:

```sh
node gemma-model-throughput.mjs --providers ollama,lmstudio
```

Provider defaults are used when `--models` is omitted. Ollama uses the `gemma4:*` tags above. LM Studio uses the matching Google-owned base model ids:

- `google/gemma-4-e2b`
- `google/gemma-4-e4b`
- `google/gemma-4-12b`
- `google/gemma-4-26b-a4b`
- `google/gemma-4-31b`

If a Google-owned LM Studio model id is not installed locally, that row is skipped. The benchmark does not substitute community, quantizer, MLX-community, bartowski, unsloth, or other non-Google variants for a missing base model.

LiteRT-LM uses imported LiteRT-LM model ids when that provider is selected:

- `gemma4-e2b,gpu,32768`
- `gemma4-e4b,gpu,32768`
- `gemma4-12b,gpu,32768`

The public LiteRT-LM repos currently cover those three target weights. The `,gpu,32768` suffix is LiteRT-LM's model-id form for selecting the GPU backend and a usable runtime context; the benchmark still does not pass Gemma CLI generation or context flags. If a model is not imported locally or `litert-lm serve` is not reachable, the affected rows are skipped or reported with the prerequisite failure.

llama.cpp uses Google-owned QAT GGUF ids when that provider is selected:

- `google/gemma-4-E2B-it-qat-q4_0-gguf`
- `google/gemma-4-E4B-it-qat-q4_0-gguf`
- `google/gemma-4-12B-it-qat-q4_0-gguf`
- `google/gemma-4-26B-A4B-it-qat-q4_0-gguf`
- `google/gemma-4-31B-it-qat-q4_0-gguf`

For a llama.cpp matrix, point the benchmark at a directory containing the matching Google GGUF files. The benchmark starts one `llama-server` per case and uses an alias that matches the model id sent to Gemma CLI:

```sh
node gemma-model-throughput.mjs --provider llamacpp --llamacpp-models-dir /path/to/google-gemma4-gguf
```

If `--llamacpp-models-dir` is omitted, the benchmark assumes you are managing the llama.cpp endpoint yourself and uses `--list-models` against that endpoint.

For a complete local LM Studio matrix, install the Google-owned model ids with LM Studio before running the benchmark:

```sh
lms get google/gemma-4-e2b --gguf
lms get google/gemma-4-e4b --gguf
lms get google/gemma-4-12b --gguf
lms get google/gemma-4-26b-a4b --gguf
lms get google/gemma-4-31b --gguf
```

The benchmark script itself never downloads models.

## What It Measures

The MVP benchmark sends a fixed, easy code-generation prompt through Gemma CLI in `--json-stream` mode and writes a markdown report with:

- output tokens per second
- wall-clock output tokens per second
- total output token count
- token source, using provider usage when available and a 4-characters-per-token estimate otherwise
- first-output latency when available
- answer size and run status
- Gemma CLI version and resolved CLI defaults, including temperature, top-p, top-k, max-token behavior, and context budget
- runtime metadata for touched providers, including Ollama, LM Studio, LiteRT-LM, and llama.cpp versions when available
- per-case context and settings as reported by Gemma CLI

The benchmark does not pass generation-tuning flags like `--temperature`, `--top-p`, `--top-k`, `--max-tokens`, `--max-turns`, or `--context-tokens`. It tests Gemma CLI defaults as the user would get them.

The benchmark unloads each Ollama model after its case unless `--keep-model-loaded` is passed. For LM Studio, it avoids unloading models that were already loaded before the benchmark case. For managed llama.cpp cases, the benchmark stops the `llama-server` process it started for that case.

For report-grade comparison runs, use clean runtime resets:

```sh
node gemma-model-throughput.mjs --providers ollama,lmstudio --clean-runtime
```

That unloads all resident Ollama and LM Studio models before and after each case and records reset evidence in the report. It does not kill the Ollama app or LM Studio app process.

## Useful Options

```sh
node gemma-model-throughput.mjs --models gemma4:e2b,gemma4:e4b --think on,off
node gemma-model-throughput.mjs --model gemma4:26b --think off
node gemma-model-throughput.mjs --providers ollama,lmstudio
node gemma-model-throughput.mjs --provider litertlm --litertlm-endpoint http://127.0.0.1:9379
node gemma-model-throughput.mjs --provider llamacpp --llamacpp-models-dir /path/to/google-gemma4-gguf
node gemma-model-throughput.mjs --endpoint http://127.0.0.1:11434
node gemma-model-throughput.mjs --ollama-endpoint http://127.0.0.1:11434 --lmstudio-endpoint http://127.0.0.1:1234
node gemma-model-throughput.mjs --providers ollama,lmstudio --clean-runtime
node gemma-model-throughput.mjs --prompt-file ./my-prompt.txt
node gemma-model-throughput.mjs --output ./reports/manual-run.md
```

Media scripts share the same runtime/model options and add fixture selection:

```sh
node gemma-image-description.mjs --fixture apollo-buzz-aldrin --model gemma4:26b --think off
node gemma-image-description.mjs --fixtures apollo-buzz-aldrin,cat-on-snow
node gemma-audio-transcription.mjs --fixture apollo-one-small-step --providers ollama,lmstudio
node gemma-audio-transcription.mjs --fixtures-dir ./fixtures/media
```

For monorepo development, point the benchmark at a locally built CLI:

```sh
node gemma-model-throughput.mjs --cli-path ../gemma-cli/packages/cli/dist/index.js
node gemma-image-description.mjs --cli-path ../gemma-cli/packages/cli/dist/index.js
node gemma-audio-transcription.mjs --cli-path ../gemma-cli/packages/cli/dist/index.js
```

## Capability Benchmarks

The benchmark folder has separate scripts for capability-specific checks:

- throughput on fixed text/code prompts
- image description for models that advertise image/vision/video attachments
- audio transcription for models that advertise audio attachments
- future time to create a small working web app
- future SVG creation quality and validity
- future video or frame analysis for models that support visual attachments

The image fixtures are:

- `apollo-buzz-aldrin`: NASA Apollo 11 photo of Buzz Aldrin on the Moon, public domain NASA source.
- `vangogh-starry-night`: Vincent van Gogh's 1889 painting The Starry Night, public-domain artwork reproduction.
- `cat-on-snow`: Wikimedia Commons image of a domestic cat on snow, CC BY-SA 3.0 / GNU FDL.

The audio fixture is:

- `apollo-one-small-step`: NASA historical-sounds MP3 of Neil Armstrong's "one small step" line.

Those scripts keep the same shape: dependency-light Node entrypoints, fixed prompts, isolated workspaces, markdown reports, and honest skips when a local model or required media capability is not available. Media reports put the raw model output or error in the last result column for manual review.
