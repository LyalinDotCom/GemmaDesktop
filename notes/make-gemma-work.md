# Making Gemma4 Work for Coding, Research, and Local Agent Scenarios

Date: 2026-06-03

This report summarizes what the Open Gemma Project did to make Gemma4 usable enough for coding, research, Assistant Chat, multimodal file reading, and other local-model agent scenarios. It is based on:

- the current implementation in `gemma-sdk`, `gemma-cli`, and `gemma-desktop`
- commit history from late April through late May 2026
- current tests and validation suites
- local persisted CLI/live-run evidence under `.gemmacli` and `test-projects`
- bounded read-only search of Codex archived session logs under `~/.codex`
- read-only inspection of Gemma Desktop global Assistant Chat diagnostics and model lifecycle logs

The short version: the work was not one trick. We made Gemma4 more reliable by combining prompt architecture, runtime request shaping, simpler tool contracts, recovery loops, evidence guards, helper/secondary model audits, model lifecycle control, deep research orchestration, and live scenario testing. The system became less dependent on Gemma4 "just knowing what to do" and more like a product that constrains, observes, and helps the model recover.

## Executive Summary

Gemma4 became usable for agentic coding and research because the product stopped treating the model as a generic frontier-model clone and started designing around its actual behavior.

The biggest themes:

1. Gemma4 needs a small, explicit, phase-appropriate tool surface.
2. Gemma4 benefits from thinking being enabled, but the product must prevent reasoning-only completions from counting as success.
3. Gemma4 often needs direct continuation nudges after tool calls, failed tools, empty responses, malformed JSON, repeated loops, and premature final answers.
4. Coding success requires tool evidence, not model claims. File writes must be verified, validation commands must be observed, and finalization must be backed by actual run results.
5. Research success requires source coverage, citation discipline, structured fallback reports, and deterministic recovery when planner/worker/synthesis output is malformed or too thin.
6. Desktop Assistant Chat needs a helper/secondary model path that can audit the primary turn, fill in missing final messages, restart one bad turn, or recover a failed turn without exposing helper internals to the user.
7. Local runtime behavior is a product surface. Ollama, LM Studio, and oMLX need request-shape controls, timeout handling, thinking settings, capability discovery, and load/unload safety.
8. Live tests were critical. The team repeatedly captured real Gemma4 failures, fixed the product surface, then reran scenarios until the failures became recoverable.

The strongest current evidence is the Gemma CLI web live suite. Early `gemma4:31b` web runs failed on placeholder text, stale Vite starter content, repeated phrase stream loops, malformed finalization, stale patches, and blank React entrypoints. Later runs completed full multi-turn scenarios for both a React notes app and a Three.js black-hole simulation with independent validators passing after every turn.

## For the Gemma Model Team: Train These Behaviors So Product Hacks Disappear

The most important takeaway for model training is that many of our "optimizations" are compensating for behaviors the model should ideally learn directly. The product now has guards, retries, aliases, scratch-text filters, helper audits, and tool-surface restrictions because those layers make Gemma4 usable today. But the better long-term outcome is a Gemma model that does not need those hacks.

### 1. Tool-call serialization and JSON discipline

Train Gemma to emit exactly one valid tool action when a tool is needed:

- no Markdown fences around tool JSON
- no prose before or after tool JSON
- no raw transport markers or channel tokens
- no partial tool JSON followed by a final answer
- no hidden scratch text inside tool arguments
- no "I will now call..." text instead of the call

The recurring failure was not simply "bad JSON." It was bad JSON under realistic coding pressure: large file contents, patches, regexes, CSV escaping, template literals, and multiline strings.

High-value training targets:

- escape literal newlines inside JSON strings as `\n`
- escape quotes and backslashes when they are part of a JSON string
- preserve code-level escape sequences such as `\\n`, `\\t`, `\\"`, and regex escapes exactly
- do not turn a code string or regex containing literal `\n` into an actual newline in source code
- do not double-escape patch text into literal `\\n` text when the receiving tool expects decoded newline-separated diff lines
- keep file content separate from self-correction commentary

The model should learn a strict distinction between three layers:

1. The JSON transport layer.
2. The tool argument string after JSON decoding.
3. The programming-language source code inside that string.

Many of our local fixes exist because Gemma collapses those layers when editing files.

### 2. Editing and patching behavior

The clearest example came from the ledger CSV export live run. Gemma repeatedly failed patch-context matches in `bin/cli.js`, then used an exact `oldText`/`newText` edit. While trying to fix CSV escaping, it corrupted a regex containing literal `\n` into a real newline inside the regex literal, causing `SyntaxError: Invalid regular expression: missing /`.

Our product fix was to remove the default CLI `edit_file` tool that asked for exact `oldText`/`newText` replacements. Gemma CLI now favors `apply_patch` for focused diffs and `write_file` for complete file replacement after reading enough current content.

What the model should learn instead:

- Prefer a small unified patch when editing an existing file.
- Use exact current surrounding context from a recent read.
- After a patch hunk fails, reread the exact target and emit a smaller patch.
- Do not repeat stale patch context.
- Do not switch to large exact string replacement for escape-heavy code.
- Do not use shell scripts to mutate source after a patch failure unless the user explicitly asked for that path.
- Preserve newline style and trailing newline.
- Preserve regex, CSV, JSON, and template-literal escapes exactly.
- Never insert scratch phrases such as "Wait, I see..." or "Fix: I noticed..." into source files.

This is training data gold: give the model examples where it must edit code containing regexes, CSV escaping, multiline strings, and template literals without corrupting either JSON transport escaping or source-code escaping.

### 3. Validation and completion behavior

Train Gemma to treat tool results as evidence:

- `ok:true` or process exit code 0 means the command succeeded, even if stdout is quiet.
- A still-running command is not validation success.
- A command the model intended to run is not validation evidence.
- A failed tool call should change the next action.
- A final answer should cite the validation actually observed in the tool history.

Many product gates exist because Gemma sometimes claims validation passed based on intention or because it distrusts quiet successful commands and reruns them.

### 4. Research behavior

Train Gemma to act like a source-grounded research worker:

- plan source coverage before synthesis
- distinguish search results, opened sources, and cited source IDs
- cite only sources actually available in the run
- avoid generic fallback prose when source coverage is thin
- recover from malformed structured output without inventing citations
- produce compact open questions when evidence is missing

Our research fallback system is useful, but a better model would need fewer planner retries, fewer malformed table repairs, and fewer citation salvage passes.

### 5. Self-continuation after tools

The assistant heartbeat/helper model exists because Gemma can finish a turn after tool work without giving the user a useful visible completion, or can fail a recoverable turn and need a narrow restart.

The primary model should be trained to:

- continue after successful tool calls with a concise user-facing result
- summarize what changed and what validation ran
- ask for the next input only when genuinely blocked
- avoid silent completion after tool work
- avoid answering from stale context after a hidden resume or recovery turn

The helper model path is a strong product safety net. The model-training goal should be to make it rarely necessary.

## What "Optimized Enough" Actually Meant

This was not traditional model optimization. No model weights were changed in this repository. The optimization happened in the surrounding product system:

- prompts that are short, explicit, and segmented by responsibility
- runtime settings that preserve Gemma4 thinking without leaking thinking into user-visible text
- tool schemas that avoid large nested payloads when possible
- tool aliases and argument repair for common local-model drift
- recovery prompts that turn "stuck" into one concrete next action
- verification gates that reject unsupported final answers
- helper model workers for audit, recovery, multimodal extraction, and dense file evidence
- deterministic and live tests that represent actual developer workflows
- local runtime lifecycle controls so a big model does not destabilize the machine

In other words, the product learned to meet Gemma4 where it is:

- strong enough to build and research when the task is grounded and the next action is obvious
- fragile when asked to juggle many overlapping tools, deeply nested schemas, long file payloads, or vague "make it good" objectives
- prone to silent thinking, transport-marker leakage, repeated phrase loops, stale patch retries, and final claims without evidence
- much more useful when every phase has simple instructions, tight feedback, and verifiable completion criteria

## Evidence Reviewed

### Current code paths

- `gemma-sdk/packages/sdk-core/src/session.ts`
- `gemma-sdk/packages/sdk-core/src/systemPrompts.ts`
- `gemma-sdk/packages/sdk-core/prompts/fallback.md`
- `gemma-sdk/packages/sdk-core/prompts/models/supergemma4-26b-uncensored-v2.md`
- `gemma-sdk/packages/sdk-core/src/buildMode.ts`
- `gemma-sdk/packages/sdk-runtime-ollama/src/index.ts`
- `gemma-sdk/packages/sdk-runtime-omlx/src/index.ts`
- `gemma-sdk/packages/sdk-runtime-lmstudio/src/index.ts`
- `gemma-sdk/packages/sdk-tools/src/builtin.ts`
- `gemma-sdk/packages/sdk-tools/src/runtime.ts`
- `gemma-sdk/packages/sdk-node/src/index.ts`
- `gemma-sdk/packages/sdk-node/src/research.ts`
- `gemma-sdk/packages/sdk-agent/src/agent.ts`
- `gemma-sdk/packages/sdk-agent/src/modelProfiles.ts`
- `gemma-sdk/packages/sdk-agent/src/tools/workspace.ts`
- `gemma-cli/test.md`
- `gemma-cli/skills/react-app-builder/SKILL.md`
- `gemma-cli/docs/gemini-cli-hardening-notes.md`
- `gemma-cli/features.md`
- `gemma-desktop/src/main/ipc.ts`
- `gemma-desktop/src/main/assistantHeartbeat.ts`
- `gemma-desktop/src/main/smartContent.ts`
- `gemma-desktop/src/shared/sessionModelDefaults.ts`
- `gemma-desktop/src/main/researchPresentation.ts`

### Current tests

Representative tests reviewed:

- `gemma-sdk/tests/sessions/session-build-validation.test.ts`
- `gemma-sdk/tests/sessions/session-empty-response.test.ts`
- `gemma-sdk/tests/sessions/session-final-message-after-tools.test.ts`
- `gemma-sdk/tests/runtimes/ollama-native-debug.test.ts`
- `gemma-sdk/tests/runtimes/ollama-native-thinking.test.ts`
- `gemma-sdk/tests/runtimes/ollama-reasoning-control.test.ts`
- `gemma-sdk/tests/tools/tool-runtime-alias.test.ts`
- `gemma-sdk/tests/tools/tool-failure-recovery.test.ts`
- `gemma-sdk/tests/tools/host-tools.test.ts`
- `gemma-sdk/tests/research/research-run.test.ts`
- `gemma-sdk/tests/research/research-hardening.test.ts`
- `gemma-sdk/packages/sdk-agent/src/agent.test.ts`
- `gemma-sdk/packages/sdk-agent/src/systemPrompt.test.ts`
- `gemma-sdk/packages/sdk-agent/src/tools/workspace.test.ts`
- `gemma-desktop/tests/assistant/assistantHeartbeat.test.ts`
- `gemma-desktop/tests/attachments/smartContent.test.ts`
- `gemma-desktop/tests/attachments/smartContentLive.test.ts`
- `gemma-desktop/tests/runtime/ollamaPrimaryResidency.test.ts`

### Local persisted evidence

Read-only evidence inspected:

- `.gemmacli/sessions/e33c0faa.json`
- `.gemmacli/logs/e33c0faa.jsonl`
- `test-projects/gemma-cli-web-live-run*/_suite-results/summary.json`
- `test-projects/gemma-cli-web-live-run*/_suite-results/logs/*.jsonl`
- `test-projects/_live-logs/gemma4-26b-webapp-*.jsonl`
- `~/.codex/session_index.jsonl`
- `~/.codex/archived_sessions/rollout-2026-04-28T19-41-27-019dd678-145f-7992-9f9c-64d84dc215a2.jsonl`
- `~/Library/Application Support/Gemma Desktop/global-session-state/talk/session.json`
- `~/Library/Application Support/Gemma Desktop/model-lifecycle.jsonl`
- `~/Library/Application Support/Gemma Desktop/settings.json` with secrets avoided

The local Gemma Desktop settings currently show primary model selection as `gemma4:31b` through `ollama-openai`; the local helper model setting is present but disabled in the inspected settings. The report below describes implemented capability, not just the current local toggle state.

The bounded Codex archive search found older thread titles that line up with the same workstreams, including "Show Gemma4 system prompt," "Fix stop handling during thinking," "Research Gemma4 prompts," "Review Gemma 4 thinking," "Investigate deep research slowness," "Map thinking levels to models," and "Fix deep research timeout." The most directly useful archived session was the April 28, 2026 Gemma Desktop debugging thread that investigated a build request looping while trying to create a web black-hole simulation in `.tmp`. That session pulled Gemma Desktop `tool.call`, `tool.result`, runtime request, warning/error, and build finalization code. The tool results showed repeated `exec_command` attempts around an `npm` invalid-name failure for `.tmp`, which matches the later product fix pattern: repeated tool failures need explicit recovery instructions, not another blind retry.

## Chronology of the Main Optimization Work

### 2026-04-27: max-step recovery and first product resilience

Commit `d5837fd` added max-step turn recovery. This is an early example of a pattern that repeats throughout the system: when the model reaches a loop boundary after doing tool work, do not just stop with a raw failure. Try to produce a grounded final response or a concrete incomplete status.

Why it mattered for Gemma4:

- Gemma4 can spend turns on reasoning, partial tool attempts, or post-tool continuation without reaching a final answer.
- A max-step boundary after tool work should not erase useful evidence.
- The user needs to know what actually happened and what remains blocked.

### 2026-04-28: Gemma thinking and tool-call failure hardening

Important commits:

- `73855cf` - Harden Gemma tool-call failure handling
- `e03a740` - Always enable Gemma thinking
- `126b7d0` - Harden Gemma thinking and tool-loop handling
- `dee6774` - Tune oMLX Gemma 4 requests
- `2685164` - Lock Gemma4 Ollama native request shape
- `8cf6c81` - Stop build validation summary loops

This was a major shift. The product stopped treating reasoning as optional for Gemma4. It forced Gemma4 thinking on in SDK request settings, Ollama native, LM Studio native, app settings, and CLI parity, while also adding prompt guidance around `<|think|>`.

Why this mattered:

- Gemma4 performs better when it has a native thought channel for tool choices, failures, validation, and self-correction.
- But reasoning can become a failure mode when the model streams only thoughts and no user-visible content or tool call.
- The fix was therefore two-sided: enable thinking, but reject thinking-only completions as incomplete.

Current code evidence:

- `gemma-sdk/packages/sdk-core/src/session.ts` has `buildGemma4ThinkingInstructions` and injects `<|think|>` for Gemma4 when reasoning is not off.
- `gemma-sdk/packages/sdk-agent/src/modelProfiles.ts` has `buildGemmaThinkingInstructions` for Gemma CLI.
- `gemma-sdk/packages/sdk-runtime-ollama/src/index.ts` maps Gemma4 native Ollama requests to `think=true` unless reasoning is explicitly off.
- `gemma-sdk/packages/sdk-runtime-omlx/src/index.ts` sets `chat_template_kwargs.enable_thinking=true` and a default Gemma4 thinking budget.
- `gemma-sdk/tests/runtimes/ollama-reasoning-control.test.ts` locks the expected thinking behavior.
- `gemma-sdk/tests/runtimes/ollama-native-thinking.test.ts` verifies that thinking is parsed separately and not leaked.

The key product decision: thinking is useful internal scaffolding, not completion evidence.

### 2026-04-29: live scenario coverage and build-mode recovery

Important commits:

- `5a9529f` - Add live CLI scenario coverage
- `3bbdcb6` - Improve live scenario logging and compaction coverage
- `474d2a7` - Add flexible live scenario provider matrix
- `328e397` - Clarify live scenario outcome review
- `e9346e6` - Tighten build-mode recovery checks

This period introduced live scenario testing as a core product practice. The tests were not just "does the process exit." They saved logs, artifacts, final answers, evaluator notes, and evidence so humans could inspect whether the result was actually useful.

Why it mattered:

- Gemma4 can produce superficially plausible final answers for incomplete work.
- Live coding/research is too complex for mocked unit tests to fully represent.
- Human review of live artifacts was needed to avoid prompt hacks that only satisfy a brittle evaluator.

Current repo guidance now preserves this explicitly:

- `AGENTS.md` defines "live tests" and "live scenario tests."
- It says live scenario results require human review of JSON, tool trace, final answer, evaluator notes, and generated files.
- It says failures should lead to product fixes, harness fixes, or honest capability-gap reporting, not scenario gaming.

### 2026-04-30: deep research orchestration

Important commits:

- `bca2ba7` - Improve deep research source coverage
- `d9555bc` - Improve deep research orchestration
- `537d258` - Handle stalled research planning and missing search
- `74f8b26` - Make research reports transparent and quality-first
- `d090e52` - Preserve research timeout abort reasons
- `5af3452` - Use report template for research reports
- `e491d2e` - Improve research report synthesis quality

This was the main research hardening wave. The product moved away from trusting a single broad model answer and toward a staged research runner with planning, source collection, worker summaries, coverage assessment, synthesis, and fallback reporting.

Why this mattered for Gemma4:

- Gemma4 can stall on structured planning.
- It can return malformed structured output.
- It can cite invalid source IDs or produce generic placeholder reports.
- It may need deterministic fallback plans when model planning fails.
- Source coverage must be explicit, not assumed.

Current code evidence in `gemma-sdk/packages/sdk-node/src/research.ts`:

- research artifacts live under `.gemma/research`
- profiles include quick and deep research
- source families include mainstream, wire, local, blogs, official, community, reference, GitHub, and docs
- planning has recovery paths: `recoverPlanFromNarrative`, `recoverPlan`, and `buildDeterministicResearchPlan`
- coverage is assessed by required families, source quality, page roles, missing topics, and follow-up seeds
- malformed worker output can be retried or salvaged through nested source-ref extraction
- final synthesis has self-checks for generic scaffolds, malformed tables, and invalid citations
- if final synthesis fails, `buildSourceBackedFinalSynthesis` can produce a source-backed fallback report rather than discarding collected evidence

Tests lock these behaviors:

- `research-run.test.ts` covers planner recovery, placeholder topic filtering, malformed worker output retry, nested citation salvage, and source-ref recovery.
- `research-hardening.test.ts` covers repeated worker open-question dedupe, malformed table detection, and fallback report hygiene.

### 2026-05-01 to 2026-05-02: model selection, build tooling, delegated web research

Important commits:

- `3a3e434` - Harden model selection and build tooling
- `8887897` - Harden delegated web research live evidence

This period connected model/runtime configuration to build reliability and research evidence.

`3a3e434` added several coding-agent hardening pieces:

- verified `write_files`
- parent-directory creation in `write_file`
- workspace escape protection for batched writes
- mutation tracking for validation/finalization
- restricted `onlyTools`
- response-header timeout and first-chunk debug timing for Ollama native
- Build prompts that pushed generated apps toward local assets, responsive CSS, accessibility, validator-driven iteration, dialog-free UI, and explicit finalization evidence
- CLI parity for Ollama timeout options, cwd creation, and JSON evidence
- helper-model behavior controlled by settings
- model lifecycle logging

`8887897` hardened delegated web research:

- source-backed delegated web research is preserved when a worker collected URLs but failed to synthesize
- delegated web research timeout was extended
- live research execution was serialized
- live defaults moved toward `gemma4:31b`
- known risk was recorded: Ollama native direct tool turns can sit silent for minutes before output or timeout

### 2026-05-07 to 2026-05-08: model loading and helper leases

Important commits:

- `67c900c` - Stop Ollama context mismatch reload loop
- `01b8574` - Refine chat activity rendering and helper model leases
- `312535c` - Tune managed model defaults and Assistant Chat startup

This work made local model lifecycle less chaotic.

Why it mattered:

- Local large-model workflows are fragile if the app repeatedly unloads and reloads models.
- Helper models are useful, but can interfere with the primary model if the lease/unload logic is careless.
- Gemma4 coding/research validation requires the actual selected model to remain stable.

Implemented behavior:

- Ollama residency checks now treat stable selected model identity as enough to avoid context mismatch reload loops.
- helper model leases can run alongside an active primary when multi-model residency is allowed.
- primary model load failures and optional warmup failures are recorded explicitly.
- app activity rendering shows ordered event runs rather than hiding useful event history.

Current code evidence:

- `gemma-desktop/src/main/ipc.ts` has primary residency and load/unload helpers such as `recordPrimaryModelLoadFailure`, `handleOptionalPrimaryWarmupFailure`, `isTrackedModelTargetResident`, and `ensurePrimaryModelTargetLoadedUnlocked`.
- `gemma-desktop/src/shared/sessionModelDefaults.ts` defines defaults for main and helper model selection.
- `~/Library/Application Support/Gemma Desktop/model-lifecycle.jsonl` shows real load, unload, skipped, and error records, including skipped loads when the selected model is already loaded.

### 2026-05-10 to 2026-05-14: Gemma CLI brought into the monorepo and hardened

Important commits:

- `3128ea8` - Import Gemma CLI into the monorepo
- `1df3084` - Move Gemma CLI agent core into `@gemma-sdk/agent`
- `e553e1d` - Harden CLI agent evidence and resume behavior
- `20529f3` - Archive legacy Gemma Desktop CLI notes

This moved the CLI from a side experiment into the shared product family and made it the canonical headless coding-agent path.

The hardening was substantial:

- final answers with pending work, embedded tool JSON, partial language, unrepaired failed patches, or unsupported validation claims are rejected
- unverified final loops get `final_response_unverified`
- validation requires completed `exec_command` or `wait_command` evidence
- stale `apply_patch` guards force rereads and smaller patches
- large existing-file writes require `overwriteExisting`
- prompt compaction preserves the original user request and recent turns
- compacted resume drops malformed assistant tool-call text
- smart quotes and escaped tool JSON are repaired where possible
- malformed tool JSON is detected instead of treated as normal assistant text
- repeated prompt histories record compaction and omitted tool-output counts

Current code evidence:

- `gemma-sdk/packages/sdk-agent/src/agent.ts`
- `gemma-sdk/packages/sdk-agent/src/tools/workspace.ts`
- `gemma-cli/packages/cli/src/diagnostics.test.ts`

`gemma-cli/docs/gemini-cli-hardening-notes.md` also records the design influence from hardened Gemini CLI branches. The key imported lessons were:

- longer turn budgets for Terminal-Bench style tasks
- clearer retry discipline
- practical missing-command package mappings
- non-interactive service startup verification
- context compaction
- masking older bulky tool outputs
- accepting Gemini-style include/exclude patterns for `read_files`

The report explicitly says not to import Gemini CLI's `replace` as-is because Gemma models had already shown brittle behavior with exact `old_string`/`new_string` edit payloads.

### 2026-05-11: helper model, multimodal workers, and model-load recovery

Important commits:

- `e986bd8` - Support cross-runtime helper model use
- `1748b72` - Support multimodal file workers across active models
- `89dc63c` - Expand image extraction detail for smart content
- `2167679` - Harden SDK build turn completion recovery
- `665b1d9` - Harden model loading and tool recovery

This day connected three important capabilities:

1. helper/secondary models can be used across runtimes
2. multimodal file workers can use a vision-capable primary or helper model
3. build turns and model-load flows got stronger recovery behavior

`e986bd8` allowed a helper model to run on a different runtime from the primary model. Example: oMLX main model plus an Ollama helper, or Ollama main plus LM Studio helper. Helper audit failures became best-effort and log `sessions.assistant-heartbeat.skipped` instead of failing the primary turn.

`1748b72` allowed image/PDF workers to choose the active primary model if it supports vision, or a resident vision-capable helper/secondary model if the primary is text-only. It also made capability metadata authoritative rather than guessing from model names.

`89dc63c` changed image extraction from a concise caption into a dense visual evidence record. The prompt now asks for visible text, object inventory, spatial layout, colors, materials, camera/viewpoint, UI chrome, small details, and uncertainty.

`2167679` made the SDK treat reasoning-only completions as lacking a user-facing outcome and made Build mode continue when the model wrote promise-only build text without a recorded build action.

`665b1d9` made repeated-tool recovery user-readable, made identical `edit_file` replacements explicit no-ops, improved sparse image materialization retries, and hardened model loading.

### 2026-05-14 to 2026-05-15: live web coding evidence converged

The strongest old local evidence comes from `gemma-cli/test.md` and `test-projects/gemma-cli-web-live-run*`.

The live suite target:

- React notes app with follow-up changes for tags, archive/restore, and JSON import/export
- Three.js black-hole simulation with follow-up changes for presets/metrics, lensing/quality controls, screenshot/reset
- one Gemma CLI session per scenario
- one prompt per turn
- independent validation after every turn
- validation checks package scripts, build output, generated source health, Vite/React entrypoints, feature evidence, stale starter text, placeholder/scratch text, and `dist` artifacts

Early failure examples:

- `gemma-cli-web-live-run02` failed because generated source still contained placeholder text and a Three.js app still contained stale Vite starter content.
- `gemma-cli-web-live-run04` notes app mostly passed, but black-hole presets entered a repeated phrase loop around "Let's do that."
- `gemma-cli-web-live-run10` notes archive failed because the stream repetition watchdog stopped the model after the phrase "i'll just add the toggle button" repeated eight times.
- old runs documented stale patch loops, malformed `finalize_build` calls, wrong Vite entrypoints, hidden file input false positives, large React file payloads, raw tool marker loops, blank React roots, and quiet successful test output that the model distrusted.

Later success examples:

- `gemma-cli-web-live-run06` passed the focused black-hole scenario.
- `gemma-cli-web-live-run08` passed the notes scenario.
- `gemma-cli-web-live-run14-notes` passed the notes scenario.
- `gemma-cli-web-live-run17` passed both notes and black-hole scenarios.
- `gemma-cli-web-live-run19` passed both notes and black-hole scenarios.

Local summary evidence:

- `test-projects/gemma-cli-web-live-run19/_suite-results/summary.json` records `model: gemma4:31b` and both scenarios passed.
- `notes-app` completed four turns: create, tags, archive, import-export.
- `black-hole-threejs` completed four turns: create, presets, lensing-quality, export-reset.
- logs show `Command exited with 0.` validation evidence, successful `finalize_build`, stale patch recoveries, entrypoint warnings, and build/lint/validate runs.

This is probably the most compelling single piece of evidence for the Gemma team: the product got from "Gemma4 creates plausible but broken web apps" to "Gemma4 can build and evolve nontrivial web apps through multiple turns with independent validators."

### 2026-05-19: published CLI hardening and live web validation

Important commits:

- `dd5b645` - Harden Gemma CLI live web build validation
- `10e0d74` - Make `gemma-cli` publishable under Apache-2.0 with SDK bundled in

`dd5b645` turned hard-won live-run failures into product rules:

- live web-app suite validates generated scripts, builds, source hygiene, requested features, stale starter cleanup, generated `dist`, and repeated stream loops
- `finalize_build` is terminal only with evidence
- malformed protocol loops are detected
- repeated visible phrases are detected
- response markers/fragments are detected
- trailing prose after JSON actions is detected
- thinking-only completions are bounded and retried

Current code evidence:

- `gemma-sdk/packages/sdk-agent/src/agent.ts` has `ModelProtocolMonitor`
- `CompleteToolCallStreamError` cuts off a complete tool JSON followed by raw marker suffixes
- `ProtocolRetryError` injects a retry instruction when visible output drifts outside the protocol
- repeated stream fragments trigger a protocol retry
- malformed responses are retried and then stopped deterministically with `model_response_malformed`

### 2026-05-20 onward: hosted model support and broader runtime hardening

Later commits added hosted Gemini runtime support, endpoint settings, and attachment delivery hardening. These are not Gemma4-specific, but they matter because the platform now separates:

- inference adapter
- discovery provider
- helper model target
- model capability metadata
- model lifecycle status

This separation keeps Gemma4-specific behavior from turning into runtime-specific accidental behavior.

## System Prompt Architecture

The project treats prompts as product infrastructure. This is one of the most important changes for Gemma4.

### Prompt composition is structured and inspectable

`gemma-sdk/packages/sdk-core/src/systemPrompts.ts` builds system prompts with explicit sections:

- fallback
- model
- environment
- tool context
- mode
- exact paths
- capabilities
- custom
- continuation

The composed prompt uses tags such as:

- `<gemma_desktop_system_prompt>`
- `<system_prompt_section source="...">`

Why this matters:

- Gemma4 is sensitive to prompt drift and duplicate instructions.
- The product needs to test prompt section order.
- Durable memory must not appear between operational rules and tool routing.
- Tool routing needs to vary by mode without creating contradictory instructions.

### Fallback prompt is direct and evidence-first

`gemma-sdk/packages/sdk-core/prompts/fallback.md` tells the model to:

- be truthful about actions and results from this session only
- use tools for files, commands, and web facts
- preserve exact paths
- avoid retry loops
- treat thin outputs as insufficient evidence
- send final text after tool work
- never end with a bare tool call

This is aligned with Gemma4 behavior. It reduces reliance on inference and makes the successful path concrete.

### Model-specific prompt handles Gemma artifacts

`gemma-sdk/packages/sdk-core/prompts/models/supergemma4-26b-uncensored-v2.md` tells the model not to emit raw channel/tool tokens and not to paste scratch notes or self-correction into file content.

This exists because local model outputs showed issues like:

- raw `<|channel>` or `<|tool_call|>` leakage
- `jsonset` or tool transport fragments
- "Wait, let's fix..." text appearing inside generated files
- tool-call syntax appearing as visible prose

### Gemma CLI prompt is a stricter JSON action contract

`gemma-sdk/packages/sdk-agent/src/agent.ts` builds the Gemma CLI system prompt. It says:

- exactly one complete action
- final answer JSON: `{"answer":"..."}`
- one tool call JSON: `{"tool":"tool_name","args":{...}}`
- no Markdown fences around actions
- one tool per assistant turn
- no status prose before a JSON tool call
- after tool results, extract new facts and choose one next concrete action
- trust `ok:true` from `exec_command` even if stdout is quiet

The prompt also has dedicated sections:

- response contract
- environment
- execution strategy
- search strategy
- runtime query examples
- workspace build rules
- tool-use discipline
- attachment rules
- available tools

This is the headless equivalent of making Gemma4's next move obvious.

## Runtime and Request-Shape Optimizations

### OpenAI-compatible inference became preferred for Ollama where appropriate

The repo guidance says:

- inference adapters identify generation/streaming behavior
- discovery providers identify health, inventory, metadata, and capability hints
- discovery can use a different protocol from inference
- do not infer provider-native inference from provider-native discovery

For Ollama, LM Studio, and oMLX, the project prefers OpenAI-compatible inference when those stacks expose it, while still using provider-native APIs for discovery, warm-loads, diagnostics, or richer metadata.

Why this mattered:

- Gemma4 native tool-calling can buffer large payloads before response headers.
- OpenAI-compatible runtimes can produce more predictable streaming shape.
- Discovery still needs runtime-native information such as model residency and capabilities.

Current code evidence:

- `gemma-sdk/packages/sdk-runtime-ollama/src/index.ts`
- `createOllamaOpenAICompatibleModelDiscoveryProvider`
- `gemma-desktop/src/shared/sessionModelDefaults.ts`
- `AGENTS.md` "Model Runtime Vocabulary"

### Ollama native hardening

The Ollama runtime adapter handles several Gemma4-specific issues:

- `think=true` for Gemma4 unless reasoning is explicitly off
- OpenAI-compatible options mapping for temperature, top-p, top-k, min-p, repeat penalty, seed, and max tokens
- native message conversion preserves assistant reasoning as `thinking`
- native tool-call parsing recovers inline pseudo tool calls such as `call:tool{...}`
- Gemma delimiter `<|"|>` is parsed
- raw thought artifacts are stripped or withheld
- first-chunk debug timing is emitted
- response header timeout and stream idle timeout default to long local-model budgets
- stalled stream errors become actionable messages rather than opaque socket failures

Tests:

- `ollama-native-debug.test.ts`
- `ollama-native-thinking.test.ts`
- `ollama-reasoning-control.test.ts`

### oMLX Gemma4 request tuning

The oMLX runtime adapter sets a Gemma4 thinking budget:

- default `DEFAULT_OMLX_GEMMA4_THINKING_BUDGET = 4096`
- `chat_template_kwargs.enable_thinking = true`
- `thinking_budget` defaulted for Gemma4 reasoning on/auto
- explicit overrides and reasoning-off are preserved

This matters because oMLX local inference has a different request contract than Ollama, but the product wants a consistent Gemma4 behavior profile.

### LM Studio output sanitization

LM Studio adapters sanitize Gemma thought/tool leakage and reason over support for native/openai output shapes. Tests cover dropping malformed empty streamed tool calls when a valid one is also present.

Why this mattered:

- local runtimes differ in how they expose reasoning/tool deltas
- a model can emit raw artifacts in one runtime but not another
- the SDK must protect downstream app behavior from those runtime-specific quirks

## Tool Surface Design

The tool surface changed from "give the model many clever capabilities" to "give the model direct, familiar, hard-to-misuse actions."

### Direct tools have literal names

Current preferred tool names include:

- `read_file`
- `read_files`
- `search_text`
- `search_paths`
- `list_tree`
- `write_file`
- `write_files` in SDK host tools
- `apply_patch` in Gemma CLI
- `exec_command`
- `wait_command`
- `cancel_command`
- `finalize_build`
- `fetch_url`
- `search_web`

Why this matters for Gemma4:

- literal action names are easier than abstract tool names
- one-action tools reduce ambiguous intent
- shallow schemas are easier to construct
- familiar developer verbs reduce tool-call drift

### Exact replacement editing was removed from the default CLI surface

One especially important product decision: Gemma CLI no longer exposes an exact `oldText`/`newText` `edit_file` tool in its default workspace tool registry.

The model-facing reason is simple. Exact replacement tools look easy, but they ask the model to serialize two large strings perfectly. That is brittle when the file contains regexes, literal `\n` text, CSV escaping, template literals, indentation-sensitive blocks, or several nearby similar snippets. In the ledger CSV live run, Gemma used an exact replacement after patch failures and corrupted a regex containing literal `\n` into an actual newline in the regex literal. The product could have added more prompt text saying "please escape newlines," but that would have overfit one failure while leaving the underlying serialization weakness intact.

Current stance:

- CLI default editing uses `apply_patch` for focused diffs and `write_file` for full replacements.
- `apply_patch` tells the model to use real newline-separated diff lines after JSON decoding, not literal `\\n` hunk text.
- `apply_patch` normalizes some double-escaped patches because Gemma still confuses transport escaping with patch contents.
- `write_file` rereads what it wrote, warns on likely stale React entrypoints, and rejects suspicious scratch/self-repair text.
- SDK host tools still contain a guarded `edit_file` implementation for app/host flows, but with explicit no-op detection, stale target feedback, optional full-file replacement behavior, newline normalization, and refreshed snapshots.

Training recommendation:

Gemma should learn to make small, context-grounded edits without relying on exact giant string replacement. When exact replacement is unavoidable, it must preserve source-code escape sequences across JSON transport. A model that can reliably edit a regex containing `\\n` without turning it into a physical newline would eliminate a meaningful amount of our product hardening.

### Tool aliases repair common model drift

`gemma-sdk/packages/sdk-tools/src/runtime.ts` accepts aliases such as:

- `execute_command` and `run_command` -> `exec_command`
- `google_search` and `web_search` -> `search_web`
- browser action aliases such as `open_url`
- parameter aliases such as `contents` -> `content`, `filePath` -> `path`, `cmd` -> `command`, and query/search aliases

The CLI workspace tools also have aliases:

- `path` can be `name`, `file`, or `target` for several tools
- `read_files` accepts Gemini-style `include` and `exclude` patterns

This improves success without exposing duplicate tool names in the active prompt.

### Tool failures become coaching evidence, not just errors

The host tools and agent loop convert common errors into concrete next-step instructions.

Examples:

- stale `apply_patch` hunk tells the model to reread the target region and retry a smaller patch
- repeated identical patch attempts are rejected
- repeated stale patch failures for the same file tell the model to stop patching unless it has fresh context
- `write_file` refuses large existing-file overwrites unless `overwriteExisting: true`
- `exec_command` refuses shell source mutation after stale patch failures for the same file
- `wait_command` distinguishes progress from completion evidence
- background commands include notes about detached stdio and verification

Why this matters:

- Gemma4 can repeat the same failed command or patch if the error is not framed as a new constraint.
- Recovery messages need to be short, literal, and action-oriented.
- The next safe action should be obvious.

### Generated file quality guards catch model scratch text

The CLI workspace tools detect suspicious generated content, including:

- "mistake in my draft"
- "self-correction"
- placeholder implementation/stub/value
- "in a real app..."
- "for this demo..."
- "to satisfy the prompt..."
- "not implemented"
- "coming soon"
- "Wait, checking..."
- "Let's fix..."

This came directly from live failures where Gemma4 wrote self-debugging commentary into source files.

The tools also warn about frontend-specific issues:

- large React component writes
- large stylesheet writes
- hidden buttons
- React entrypoints that import App but never mount into `#root`
- ambiguous/stale Vite App files

These are not generic "style" checks. They are targeted at actual ways Gemma4 produced green builds with broken UI.

## Coding and Build-Mode Hardening

### Build mode tracks mutations and validation

`gemma-sdk/packages/sdk-core/src/buildMode.ts` tracks:

- file mutations
- command runs
- finalization calls
- browser evidence
- verification attempts after the latest mutation
- passing command evidence
- failed verification after mutation

It detects validation commands for:

- Node/npm build/check/test/typecheck/lint/verify
- SVG/XML parser checks
- Rust `cargo check`
- Go `go test ./...`
- Python `pytest` or compileall

The model cannot simply say "done." If a mutation happened, the SDK checks whether the relevant verification happened after the mutation.

### Build mode continuation prompts

The SDK has continuation instructions for common Gemma4 failure modes:

- empty response
- reasoning-only response
- missing user-facing summary after tools
- failed tools without a grounded blocker
- build promise without actual action
- missing verification after mutation
- failed verification without repair or blocker
- missing `finalize_build`
- rejected `finalize_build`
- max steps after tool work

Current code evidence in `session.ts`:

- `EMPTY_RESPONSE_RETRY_INSTRUCTION`
- `COMPLETE_AFTER_TOOLS_INSTRUCTION`
- `COMPLETE_WITH_GROUNDED_TOOL_FAILURE_RESULT_INSTRUCTION`
- `COMPLETE_BUILD_ACTION_OR_BLOCKER_INSTRUCTION`
- build missing verification and finalization continuations
- repeated tool-call/failure threshold handling

Why this mattered:

- Gemma4 often writes "I will create..." or "Next I would..." when it should call a tool.
- It can finish after a failed tool without a concrete blocker.
- It can run tests, see output, and still not produce a final user-visible answer.
- It can claim validation passed based on intent instead of evidence.

### `finalize_build` is a completion gate

In the SDK host tools and CLI agent tools, `finalize_build` records:

- summary
- artifacts
- validation records
- instruction checklist
- blockers

The CLI version marks successful `finalize_build` as terminal. But the agent loop and tool implementation reject finalization when:

- validation records are missing
- the prompt explicitly forbids finalization
- a mutation request has no substantive file mutation evidence
- passed validation is not backed by completed successful command evidence
- requested pass-count thresholds are not met
- frontend entrypoints still mount stale starter files
- a React entrypoint imports an app but never mounts it

This is one of the most important coding-agent optimizations. It turns "the model said it is done" into a structured evidence record.

### Final answers are audited against tool history

`gemma-sdk/packages/sdk-agent/src/agent.ts` has several final-answer guards:

- no-tool action retry when the user asked for workspace changes
- insufficient workspace evidence retry
- premature workspace final retry
- validation retry
- suspicious workspace content retry
- final response evidence blocker

The final response pass runs with reasoning off and a small token budget so it produces a concise answer rather than more tool planning.

If the final pass cannot be accepted, the run returns an incomplete status such as:

- `final_response_unverified`
- `final_response_malformed`
- `final_response_requested_tool`
- `finalize_build_failed_at_max_turns`
- `model_response_malformed`

These completion reasons were visible in local logs. For example, `.gemmacli/logs/e33c0faa.jsonl` contains runs where final responses were rejected as unverified or as attempting another tool after the max-turn finalization pass.

### Gemma CLI live web suite proved convergence

The web live suite is a critical artifact because it was built from actual failure modes.

Official suite command:

```bash
npm --prefix gemma-cli run test:web-live
```

It runs:

- a Vite React note-taking app
- a Vite Three.js black-hole simulation

The suite validates:

- package scripts
- build output
- generated source health
- Vite/React entrypoints
- requested feature evidence
- stale starter text
- placeholder/scratch text
- `dist` artifacts
- scenario-specific behavior

Local run progression:

- run02 failed on placeholder text and stale Vite starter content
- run04 had a repeated phrase loop in black-hole presets
- run06 passed the focused black-hole scenario
- run08 passed the notes scenario
- run10 still failed notes archive due to repeated phrase watchdog
- run14-notes passed notes
- run17 passed notes and black-hole
- run19 passed notes and black-hole

The later logs show the desired pattern:

- Gemma4 emits thinking about requirements
- creates/scaffolds app files
- receives tool warnings
- fixes warnings
- handles stale patch failures
- runs build/lint/validate commands
- calls `finalize_build` with evidence
- independent suite validators pass

## Research Hardening

Gemma4 research needed a different kind of optimization than coding.

Coding requires workspace mutation and validation. Research requires:

- query planning
- source discovery
- source quality assessment
- coverage tracking
- citation validity
- synthesis quality
- transparent caveats
- fallback reports when synthesis fails

### Delegated web research

`gemma-sdk/packages/sdk-node/src/index.ts` defines a `WEB_RESEARCH_WORKER_PROMPT`.

Key rules:

- if the goal names outlets/sites, gather each directly
- use `search_web` only for discovery
- once a URL is known, prefer `fetch_url_safe`
- use quick search for latest/broad research
- do not use aggregators unless direct fetch fails
- preserve enough budget for synthesis
- return sources

The delegated web research timeout was raised to 9 minutes. This is a realistic local-model design choice: Gemma4 and local runtimes can be slow, and a too-short timeout converts slow useful work into false failure.

### Deep research runner

`gemma-sdk/packages/sdk-node/src/research.ts` implements staged research.

Major components:

- research profiles
- artifact directories
- concurrency limits
- coverage plans
- source family classification
- quality scoring
- source cards
- dossiers
- planning recovery
- source-backed final synthesis fallback
- citation and table self-checking

The research runner uses deterministic fallback planning when model planning stalls or returns malformed output. This is key for Gemma4: if a planner turn fails, research can still proceed with a sensible coverage plan.

### Coverage assessment

The runner classifies source families and page roles, then checks for:

- missing required source families
- missing topics
- low-quality or off-topic sources
- hub pages that did not enumerate specific pages
- news diversity issues
- follow-up query needs

This prevents Gemma4 from doing "one source and vibes" research.

### Synthesis quality controls

The final report rules require:

- title and dateline
- TL;DR
- key facts
- analysis sections
- optional timeline/differences when relevant
- numeric citations
- no generic filler/scaffold
- no paragraphs longer than three sentences
- no editorializing

The self-check rejects:

- generic report scaffolds
- malformed markdown table rows
- invalid citations
- suspicious placeholders

If synthesis fails, the system can build a source-backed final report from the collected sources and dossiers. That is a major robustness feature: evidence survives a weak final model pass.

## Assistant Chat Helper/Secondary Model

The user specifically mentioned this example: a secondary model checks the primary model, and when the primary fails to complete events, it nudges the system to continue.

That is implemented in Gemma Desktop as the Assistant heartbeat/helper path.

### Helper model selection

`gemma-desktop/src/shared/sessionModelDefaults.ts` defines:

- default primary runtime: `ollama-openai`
- low-memory primary model: `gemma4:26b`
- high-memory primary model: `gemma4:31b`
- default helper model tag
- helper enabled by default in default settings
- functions such as `resolveConfiguredHelperModelTarget`

At runtime, helper use depends on user settings. The local inspected settings currently show:

- primary: `gemma4:31b` on `ollama-openai`
- helper model configured separately
- helper currently disabled

But the implemented feature supports helper audits when enabled.

### Helper structured tasks

`gemma-desktop/src/main/ipc.ts` includes:

- `makeStructuredResponseFormat`
- `ASSISTANT_TURN_AUDIT_RESPONSE_FORMAT`
- `ASSISTANT_TURN_RECOVERY_RESPONSE_FORMAT`
- `runHelperStructuredTask`

The helper audit output has actions:

- `noop`
- `complete`
- `restart`

The failed-turn recovery output has:

- `completionMessage`

The helper task:

- checks whether helper model use is enabled
- resolves helper target
- acquires a helper lease
- creates a minimal helper session
- uses a structured response format
- limits the helper to `maxSteps: 1`
- returns structured output and helper identifiers

### Audit behavior

`auditAssistantTurnWithHelper` asks the helper to inspect:

- recent conversation
- latest user message
- assistant visible text
- reasoning excerpt
- tool activity

The helper chooses:

- `noop` when the primary answer is acceptable
- `complete` when the turn was useful but missed a crisp user-facing completion
- `restart` when the primary gave up too early, stopped on next-step narration, or should continue

The instructions prefer `complete` over `restart` to avoid expensive or disruptive reruns. The helper must never mention helper internals to the user.

### Recovery behavior

`recoverFailedAssistantTurnWithHelper` is a hidden failed-turn recovery agent. It writes a concise user-facing completion message using:

- conversation
- failed transcript
- tool outputs
- error string

It must not pretend unverified facts are true. It must distinguish:

- confirmed facts
- unconfirmed facts
- blockers

Again, it must not mention helper internals.

### Applying helper decisions

After a primary Assistant Chat turn completes, `gemma-desktop/src/main/ipc.ts` audits it if the turn is a talk session and was not aborted.

The decision handling:

- helper failure is caught and logged as `sessions.assistant-heartbeat.skipped`
- `complete` replaces or sets the final visible completion message
- `restart` records helper activity, logs `sessions.assistant-heartbeat.restart`, reruns the session with a hidden instruction, strips hidden heartbeat messages and the superseded assistant stub, and rebuilds final blocks
- failed primary turns can recover via helper and log `sessions.assistant-heartbeat.recover`

`gemma-desktop/src/main/assistantHeartbeat.ts` contains:

- decision normalization
- visible helper activity summaries
- completion message application
- hidden heartbeat message stripping

Tests in `assistantHeartbeat.test.ts` verify:

- helper failures skip without failing completed primary turns
- noop/complete/restart normalization
- markdown preservation
- visible helper activity
- replacement of last visible text block
- removal of hidden nudge and superseded assistant stub

This is one of the clearest examples of product-level Gemma4 optimization. The primary model can do useful work but miss the final "event complete" moment. The helper path converts that into either a completion message or a one-time continuation.

## Multimodal and Smart Content

Gemma4 coding and research often need file context. The project extended that to images/PDFs through smart content workers.

Key behavior from commits `1748b72`, `89dc63c`, and `665b1d9`:

- image/PDF file-reading workers can use the active primary model if it supports the modality
- if the primary is text-only, a resident vision-capable helper/secondary model can be used
- capability metadata from runtimes is authoritative
- if no model supports the modality, the user gets an actionable error instead of a fake text read
- image extraction asks for dense visual evidence, not a short caption
- sparse image materialization can retry for real detail
- live image extraction has gated real-model coverage

Why this matters:

- A text-only Gemma4 primary should not be asked to hallucinate image details from a file path.
- A helper model can enrich the context for the primary model.
- The main model then reasons over extracted evidence rather than raw unsupported media.

This pattern mirrors the Assistant heartbeat design: use secondary model capacity for a narrow helper-scoped job, then feed the primary model better grounded context.

## Model Selection, Runtime Vocabulary, and Lifecycle Safety

The repo draws a hard line between:

- inference adapter
- model discovery provider
- lifecycle/warm-load behavior
- diagnostics
- helper model
- primary model

This is crucial for local Gemma4 because runtimes do not behave uniformly.

### Defaults

Current documented defaults:

- Gemma4 26B as primary local model
- Gemma4 31B when there is more memory/headroom
- Gemma4 E2B/E4B only for helper-scoped tasks

`AGENTS.md` explicitly says main product validation should use `gemma4:26b` or stronger. It says small helper-class models are not acceptable for validating main activity, SDK-backed desktop behavior, or CLI parity behavior unless the user explicitly asks for that lower-model path.

### Lifecycle safety

Large local models can destabilize a machine if loaded carelessly. The repo therefore added:

- model load/unload logs
- residency checks
- skipped load handling
- benign unload-miss handling for LM Studio
- stale load-feedback suppression when model selection changes
- helper leases
- explicit live-test unloads in finally/after hooks
- guidance to avoid overlapping heavy live-model tests

The local `model-lifecycle.jsonl` showed real examples:

- load blocked due to insufficient system resources
- unload errors when an instance was not loaded
- skipped load when a selected model was already loaded
- successful load/unload records
- Gemma4 31B loaded on `ollama-openai` and later skipped because it was already loaded

This is product work, not just infrastructure. A coding agent that crashes or overloads the machine cannot be considered reliable.

## Protocol and Stream Recovery

Gemma4 local runs exposed several protocol failure modes:

- empty responses
- thinking-only responses
- malformed JSON
- native tool-call transport fragments
- repeated raw marker suffixes
- repeated visible phrases
- final answer that embeds a tool call
- final answer that requests another tool after max turns
- output token limit before valid JSON completes
- transient transport disconnects

The current Gemma CLI agent loop handles these directly.

### Parser repair

`parseActionOrRecoveryInstruction` tries to parse an action. If parsing fails, it sends a terse retry instruction:

- do not repeat malformed response
- return exactly one JSON object
- use `{"answer":"..."}`
- or use `{"tool":"tool_name","args":{...}}`
- escape newlines and quotes correctly

### Protocol monitor

`ModelProtocolMonitor` watches stream chunks. It can:

- accept a completed tool call followed by noisy raw marker suffixes
- interrupt repeated stream fragments
- interrupt visible protocol drift
- send a retry instruction with reasoning off

This came directly from logs where Gemma4 emitted a valid-looking tool JSON and then streamed repeated `<tool_call|>}`-style markers indefinitely.

### Empty and transient response recovery

The agent loop retries:

- empty model content up to two times
- output-limit responses once
- transient transport failures once

On these retries it often disables reasoning so the model returns a concrete action instead of more hidden thought.

### Context compaction

The CLI agent has provider-facing context compaction:

- preserve system prompt
- preserve original user request
- preserve recent turns
- mask older bulky tool results
- insert a compaction notice
- keep full diagnostics locally

Local logs show this in practice:

- `promptHistory.compacted: true`
- `firstUserPreserved: true`
- many omitted tool messages
- malformed assistant messages omitted from prompt history

This matters because long Gemma4 coding sessions can exceed context or become confused by too much old tool output.

## Browser, Search, and Research Surfaces

The repo now treats web surfaces as distinct:

- `fetch_url` is direct read, not a browser
- `search_web` is generic grounded search outside CoBrowse
- browser tools handle deeper scripted website interaction
- Project Browser is visible in-app browser
- CoBrowse routes search and browser interaction differently
- Chrome DevTools is a separate advanced debugging surface

Why this matters for Gemma4:

- too many overlapping browser/search tools confuse the model
- fetch failures need escalation to browser, not repeated fetches
- CoBrowse needs mode-enforced tool routing
- research needs grounded search outside visible browser interaction

The tool prompt composition in `session.ts` dynamically names active direct tools and delegated agents. It splits direct tools from child-session agents so the model can distinguish "do one action now" from "spawn another model session."

## Observability and Diagnostics

Reliability improved because failures became inspectable.

### CLI diagnostics

Gemma CLI logs include:

- run start and completion
- selected model
- runtime model
- context size requested/loaded
- prompt history compaction details
- skills detected
- model heartbeats
- thinking previews
- content previews
- tool start/result
- final turn
- completion status/reason

The local `.gemmacli/logs/e33c0faa.jsonl` file had over 900,000 lines of activity from a long coding experiment. It preserved:

- repeated resumed runs
- compaction metadata
- malformed assistant-message omission
- final response rejections
- validation-only recovery turns
- command evidence

### Desktop diagnostics

Gemma Desktop global Assistant Chat diagnostics include:

- `appMessages`
- `debugLogs`
- `pendingTurn`
- `snapshot.metadata`
- `snapshot.history`

The inspected global Assistant Chat session showed:

- 1200 debug logs
- OpenAI-compatible streaming events
- `gemma-4-26b-a4b-it-nvfp4` model chunks
- reasoning content deltas
- tool calls and results
- turn metrics and turn-complete events

This proves the app is capturing runtime-level detail needed to debug local Gemma4 behavior.

### Research artifacts

Deep research stores artifacts under `.gemma/research` and exposes progress through `gemma-desktop/src/main/researchPresentation.ts`.

The UI presentation breaks progress into:

- plan
- sources
- depth
- workers
- synthesis
- artifacts
- follow-up instructions

Research is therefore visible as a multi-stage process, not a single opaque answer.

## The Role of Skills

The React App Builder skill became part of making Gemma4 successful in web coding scenarios.

`gemma-cli/skills/react-app-builder/SKILL.md` instructs:

- prefer Vite React for new React projects
- add real scripts, not placeholder npm scripts
- split nontrivial apps into focused files
- keep `App` as orchestration
- inspect and update actual entrypoints
- remove stale Vite starter files/assets
- do not let styling tooling block the app
- implement real controls, not dead buttons
- avoid placeholder copy and fake TODO branches
- run `npm run build`
- run lint when present
- validate entrypoint, requested features, DOM state, responsive CSS, and placeholder absence

This addressed a specific live failure class: Gemma4 was more reliable when prompts and skills forced smaller file payloads, focused component files, and real validation after each slice.

## What We Learned From Old Runs

The old run evidence is maybe more valuable than the current code because it shows why each hardening layer exists.

### Failure mode: green build but wrong app

Observed:

- Vite build passed while the app still mounted stale starter content.
- React entrypoint imported the wrong `App` file.
- `src/main.jsx` imported `App` but did not mount `createRoot(...).render(...)`.

Product fixes:

- entrypoint warnings in `write_file`
- `finalize_build` rejection for stale Vite starter app
- `finalize_build` rejection when React entrypoint imports app but does not mount it
- suite validators search generated source and built bundles for stale starter strings

### Failure mode: placeholder or self-correction text in generated files

Observed:

- generated code included placeholder implementation text
- generated source included "Wait..." or "Let's fix..." style commentary
- models wrote "in a real app..." comments rather than implementing local behavior

Product fixes:

- suspicious content detection in workspace tools
- live suite validators reject placeholder/scratch text
- prompts explicitly forbid self-correction comments inside file contents
- skills emphasize implementing usable local behavior now

### Failure mode: stale patch loops

Observed:

- model reused old patch context
- repeated patches failed
- model tried to use previous reads as if they were fresh
- model switched to unsafe shell surgery after patch failure

Product fixes:

- stale patch failure messages require reread
- duplicate stale patch retries rejected
- read-only loop guard after stale patch failure
- `write_file` full replacement guarded after stale patch failures
- `exec_command` source mutation guarded after stale patch failures

### Failure mode: escape-heavy edit payloads corrupt code

Observed:

- In the ledger CSV export live run, Gemma repeatedly failed patch-context matches in `bin/cli.js`.
- It then switched to the exact `oldText`/`newText` `edit_file` tool.
- While fixing CSV escaping, it corrupted a regex containing literal `\n` into a real newline inside the regex literal.
- The resulting file failed syntax validation with `SyntaxError: Invalid regular expression: missing /`.
- Similar runs showed malformed CSV template literals, malformed test-file writes, and source files polluted with self-debugging comments while the model tried to repair escaping mistakes.

Why this matters:

This was not just an implementation bug in our edit tool. It exposed a model-side weakness: Gemma was not reliably preserving the boundary between JSON string escaping, tool argument text, and the source-code escape sequences inside that text.

Product fixes:

- removed exact `oldText`/`newText` `edit_file` from the default Gemma CLI workspace tool surface
- kept `apply_patch` as the main existing-file edit primitive
- kept `write_file` for complete file writes after current content is known
- added patch normalization for some double-escaped newline/quote cases
- added explicit prompt/tool guidance for real newline-separated patches after JSON decoding
- added scratch-content guards for self-debugging text inside writes, edits, and patches
- added no-op/stale-target feedback in host `edit_file` where that tool still exists

Model-training recommendation:

Train Gemma on edit tasks where the correct output requires preserving both transport escaping and source-code escaping. Good examples include:

- JavaScript regexes containing literal `\n`
- CSV escaping with commas, quotes, and embedded newlines
- JSON string literals containing escaped quotes and backslashes
- template literals containing generated newline text
- stale patch failures that require rereading before a smaller patch
- source files where self-correction text must stay in reasoning and never enter the file

The desired model behavior is not "be careful." It is concrete: emit a valid tool call, preserve the exact source escapes, edit the smallest target that can solve the problem, validate with `node --check` or tests, then summarize only observed evidence.

### Failure mode: protocol drift and marker loops

Observed:

- complete tool JSON followed by repeated raw marker suffixes
- malformed mixed tool output
- repeated visible phrases while not taking action
- thinking-only final responses

Product fixes:

- stream protocol monitor
- completed tool-call cut-off recovery
- repeated fragment/phrase watchdog
- malformed response retry instructions
- reasoning off on protocol retry
- empty response retry instructions
- deterministic incomplete statuses after repeated malformed output

### Failure mode: successful quiet command distrusted by model

Observed:

- command exited successfully but stdout lacked "passed"
- model reran tests repeatedly because it did not trust quiet success

Product fixes:

- `exec_command` output now includes `Command exited with 0.`
- system prompt says `ok:true` means exit status 0 even with quiet stdout

### Failure mode: validation claims without validation evidence

Observed:

- model claimed validation passed based on intent
- model included commands in `finalize_build` that were not actually run
- model treated still-running command progress as success

Product fixes:

- validation evidence must come from completed `exec_command` or `wait_command`
- `finalize_build` rejects missing command evidence
- `wait_command` progress output says not to claim tests passed yet
- final response evidence blocker rejects unsupported claims

### Failure mode: too-large write payloads

Observed:

- large React `write_file` payloads became malformed or incomplete
- monolithic `App.jsx` drafts were hard to recover

Product fixes:

- React skill requires focused component files
- large React file warning
- prompts encourage writing separate complete files one at a time
- live suite prompts ask for focused component/helper files

### Failure mode: context overload and bad resume

Observed:

- long CLI experiments accumulated hundreds of tool messages
- malformed assistant tool-call text could re-enter resumed prompt history
- old tool outputs could distract the model

Product fixes:

- context compaction
- bulky tool result masking
- original request preservation
- malformed assistant tool-call omission
- resume diagnostics for stale running runs

## Current Acceptance Criteria and Validation Lanes

The repo now defines validation as part of the product contract.

Standard commands:

- targeted SDK tests: `npm --workspace gemma-sdk run test -- tests/<category>/<file>.test.ts`
- targeted CLI tests: `npm --workspace gemma-cli run test -- tests/<category>/<file>.test.ts`
- targeted Desktop tests: `npm --workspace gemma-desktop run test -- tests/<category>/<file>.test.ts`
- full deterministic suite: `npm run check`
- full live-model suite: `npm run check:full`
- Gemma CLI deterministic suite: `npm run check:gemma-cli`
- App deterministic suite: `npm --workspace gemma-desktop run check`
- App live research preflight: `npm --workspace gemma-desktop run test:research-preflight`
- CLI web live suite: `npm --prefix gemma-cli run test:web-live`

The validation stance is important:

- small changes get narrow targeted tests
- cross-cutting changes get broader deterministic tests
- runtime/model/research/session changes should escalate into live lanes
- live scenario tests require human review of artifacts and traces
- use `gemma4:26b` or stronger for main product validation
- helper-class models are not acceptable for main activity validation

This is how the project avoids overfitting to mocked test success.

## What the Gemma Team Should Take Away

### 1. Gemma4 can do coding work, but only with explicit product scaffolding

The product succeeded by turning coding into a sequence of small, verifiable actions:

- inspect
- write or patch
- validate
- repair
- finalize with evidence

The model is not expected to infer all quality bars from a vague request.

### 2. Thinking helps, but reasoning-only output must be treated as incomplete

Gemma4 thinking improved tool choice and self-correction. But the system had to:

- keep thinking separate
- strip thought leakage
- reject thinking-only completions
- retry with reasoning off when necessary

### 3. Tool schema shape matters as much as prompt wording

Gemma4 struggled with:

- overlapping tools
- exact replacement payloads
- large nested JSON
- large monolithic file content
- stale patch context

It did better with:

- direct tool names
- one tool per turn
- shallow parameters
- complete file writes for new files
- focused `apply_patch` for existing files
- structured tool result feedback

### 4. Secondary models are most useful as narrow workers

The helper model strategy is not "another model solves everything." It is useful because it has narrow scopes:

- audit a completed assistant turn
- write a missing completion
- restart one incomplete turn
- recover a failed turn
- perform dense image/PDF extraction

This makes helper work cheaper, safer, and easier to reason about.

### 5. Research needs coverage and fallback, not just better synthesis prompts

The research system improved because it:

- plans coverage
- evaluates sources
- retries malformed output
- salvages citations
- rejects generic synthesis
- can produce source-backed fallback reports

The model's final prose is only one stage.

### 6. Local runtime ergonomics are part of model quality

Ollama, LM Studio, and oMLX behavior changed the perceived capability of Gemma4. Timeouts, stream shape, thinking settings, model loading, model residency, and debug logs were all necessary to make the model feel usable.

### 7. Live tests were the forcing function

The team did not guess all of this up front. Real runs exposed:

- stale starter apps
- placeholder source
- malformed tool markers
- empty responses
- bad entrypoints
- repeated phrase loops
- silent success distrust
- stale patch loops
- unverified final answers

Each class of failure became a product guardrail, prompt rule, test, or runtime fix.

## Model Training and Evaluation Recommendations

The repo evidence can be converted into model-hardening data. The best training set is not just successful transcripts. It should include failure, tool feedback, corrected continuation, and final evidence.

### High-priority supervised fine-tuning examples

Build examples where the target answer is the corrected model behavior after a realistic failure:

- Malformed tool JSON -> one valid JSON tool call with no prose or fences.
- Tool call with literal newlines in JSON -> corrected escaping using `\n`.
- Regex or source string containing `\\n` -> preserve the source escape instead of converting it to a physical newline.
- Double-escaped patch hunk -> correct decoded patch text.
- Stale patch failure -> reread exact target lines, then emit one smaller patch.
- Exact replacement temptation -> use a focused patch instead of giant `oldText`/`newText`.
- Scratch text in file draft -> retry with only valid source code.
- Quiet successful command -> final answer that trusts exit code 0.
- Long-running command progress -> wait or report still running, not success.
- Research source mismatch -> cite only opened source IDs and name missing evidence.

### High-priority RL or preference-ranking pairs

For coding turns, prefer completions that:

- use one concrete tool action instead of planning indefinitely
- choose `apply_patch` for existing-file diffs
- choose `write_file` for new files or intentional full replacement
- avoid exact string replacement when code contains escapes
- make smaller component files instead of one huge React file
- run validation before finalizing
- report only validation observed in the tool history

Reject completions that:

- paste file content as prose instead of calling the write tool
- include self-correction text inside source
- claim validation without a completed command
- repeat a failed patch without rereading
- treat transport markers as normal output
- emit multiple competing tool calls in one response
- convert source-code escapes into physical JSON/string newlines

### Suggested coding evals

These should be run against the model without our strongest product guardrails, so the model team can see whether the model itself improved:

- Edit a JavaScript regex containing literal `\\n`; the correct file must still pass `node --check`.
- Add CSV export that handles commas, quotes, embedded newlines, and category fields; validate with direct CLI output comparison.
- Fix a stale patch failure by rereading the file and applying a smaller patch.
- Build a small React notes app using multiple focused component files; reject placeholder text and stale Vite starter content.
- Write a Node CLI with persistence across process invocations; validate via separate CLI calls, not only unit tests.
- Handle a quiet successful command and produce a final answer without rerunning it.
- Recover from one malformed tool call by emitting a clean tool call, not by apologizing.

### Suggested research evals

- Given a broad topic, produce a coverage plan before synthesis.
- When one source is thin, open another source instead of padding the report.
- Cite only source IDs actually opened in the run.
- Recover from malformed table output and still produce a readable source-backed report.
- End with explicit open questions when evidence is insufficient.

### What success would let us remove or relax

If Gemma learns these behaviors, the product could eventually simplify:

- fewer JSON repair paths
- fewer scratch-content rejection patterns
- fewer protocol-retry nudges
- less patch normalization
- less aggressive final-answer evidence blocking
- less need to remove exact edit tools from the active surface
- fewer helper-model restarts for missing completions

That is the important framing for the Gemma team: our current system is model hardening against a model that is not yet hard enough. The training opportunity is to move these behaviors into the model so the SDK and app can become simpler, not just more defensive.

## Remaining Known Risks

The system is much better, but it is not magic.

Known risks:

- Gemma4 can still enter repeated phrase or protocol loops under hard prompts.
- Very large file writes remain risky.
- Stale patch recovery is improved but not perfect.
- Research quality still depends on source availability and model synthesis strength.
- Live multimodal extraction quality depends on the selected vision model.
- Helper model audits depend on helper being enabled and loadable.
- Local model lifecycle still needs careful cleanup to avoid memory pressure.
- OpenAI-compatible inference is usually more predictable, but provider-native APIs still matter for discovery and lifecycle.
- Green deterministic tests do not replace live scenario review for agentic workflows.

## High-Signal Reference Timeline

This timeline is a compact reference for the team.

| Date | Commit | What it contributed |
| --- | --- | --- |
| 2026-04-27 | `d5837fd` | Max-step turn recovery |
| 2026-04-28 | `73855cf` | Gemma tool-call failure hardening |
| 2026-04-28 | `e03a740` | Gemma thinking always enabled across SDK/runtime/app/CLI |
| 2026-04-28 | `126b7d0` | Thinking and tool-loop hardening |
| 2026-04-28 | `dee6774` | oMLX Gemma4 request tuning |
| 2026-04-28 | `2685164` | Ollama native Gemma4 request-shape tests |
| 2026-04-29 | `5a9529f` | Live CLI scenario coverage |
| 2026-04-29 | `3bbdcb6` | Live logging and compaction coverage |
| 2026-04-29 | `474d2a7` | Flexible live scenario provider matrix |
| 2026-04-29 | `e9346e6` | Build-mode recovery checks |
| 2026-04-30 | `d9555bc` | Deep research orchestration |
| 2026-04-30 | `537d258` | Stalled research planning and missing search recovery |
| 2026-04-30 | `74f8b26` | Transparent, quality-first research reports |
| 2026-04-30 | `5af3452` | Research report template |
| 2026-04-30 | `e491d2e` | Research synthesis quality |
| 2026-05-01 | `3a3e434` | Model selection and build tooling hardening |
| 2026-05-02 | `8887897` | Delegated web research evidence hardening |
| 2026-05-07 | `67c900c` | Stop Ollama context mismatch reload loop |
| 2026-05-08 | `01b8574` | Helper model leases and activity rendering |
| 2026-05-10 | `3128ea8` | Gemma CLI imported into monorepo |
| 2026-05-10 | `1df3084` | Gemma CLI core moved into `@gemma-sdk/agent` |
| 2026-05-11 | `e986bd8` | Cross-runtime helper model use |
| 2026-05-11 | `1748b72` | Multimodal workers across active/helper models |
| 2026-05-11 | `89dc63c` | Dense image extraction prompt |
| 2026-05-11 | `2167679` | SDK build turn completion recovery |
| 2026-05-11 | `665b1d9` | Model loading and tool recovery hardening |
| 2026-05-14 | `e553e1d` | CLI evidence, resume, and final-answer hardening |
| 2026-05-19 | `dd5b645` | Gemma CLI live web build validation hardening |

## Most Important Current Files

For the Gemma team, these are the best files to inspect first:

1. `AGENTS.md`
   - Captures the product philosophy and Gemma-centered constraints.

2. `gemma-sdk/packages/sdk-core/src/session.ts`
   - Main SDK session loop, prompt composition, continuation/recovery behavior.

3. `gemma-sdk/packages/sdk-core/src/buildMode.ts`
   - Build-mode evidence tracking and validation/finalization policy.

4. `gemma-sdk/packages/sdk-runtime-ollama/src/index.ts`
   - Ollama Gemma4 request shaping, thinking, native parsing, and stream timeout handling.

5. `gemma-sdk/packages/sdk-node/src/research.ts`
   - Deep research orchestration, coverage, source quality, synthesis, fallback reports.

6. `gemma-sdk/packages/sdk-agent/src/agent.ts`
   - Gemma CLI JSON action loop, protocol monitor, final-answer evidence guards, compaction.

7. `gemma-sdk/packages/sdk-agent/src/tools/workspace.ts`
   - CLI workspace tools, stale patch guards, write verification, suspicious content checks, finalization.

8. `gemma-cli/test.md`
   - Living live-test log documenting the actual failures and fixes.

9. `gemma-cli/skills/react-app-builder/SKILL.md`
   - Skill-level prompt tuning for reliable React/web app generation.

10. `gemma-desktop/src/main/ipc.ts`
    - Desktop orchestration, helper structured tasks, assistant heartbeat, model lifecycle wiring.

11. `gemma-desktop/src/main/assistantHeartbeat.ts`
    - Helper model audit/restart/recovery normalization and visible activity summaries.

12. `gemma-desktop/src/main/smartContent.ts`
    - Multimodal smart content routing and dense extraction behavior.

## Final Assessment

The Open Gemma Project made Gemma4 work by building a product system that compensates for local-model fragility without hiding it.

For coding, the winning pattern was:

- small action steps
- verified writes
- focused patches
- command evidence
- finalization evidence
- live validators
- protocol recovery

For research, the winning pattern was:

- staged planning
- source coverage
- worker evidence
- citation validation
- synthesis self-checks
- source-backed fallback reports

For Assistant Chat and other app scenarios, the winning pattern was:

- structured prompts
- helper model audits
- hidden continuation nudges
- failure recovery
- runtime lifecycle control
- detailed diagnostics

The most important strategic point is that the project did not make Gemma4 reliable by pretending the sharp edges were gone. It made Gemma4 reliable by making the sharp edges visible, tested, recoverable, and increasingly hard for the user to trip over.
