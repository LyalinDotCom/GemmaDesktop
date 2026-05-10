# Gemma CLI 10-Change Smoke Test

This is a living smoke-test plan for validating that Gemma CLI can survive a multi-turn coding session against a simple project. The plan is allowed to change as we learn what guidance the model needs. Keep the final prompts focused on the path that actually reaches green without turning them into narrow implementation instructions.

## Official Live Suite Workflow

Use this file as the repeatable live test suite for clean sessions. The suite is intentionally manual at the prompt level: run one Gemma CLI command per change, validate with local shell commands, and update the run log as evidence changes.

### Preflight

Run these from the repo root before a live suite run:

```bash
npm run build
npm test
```

Use the built CLI for model-backed runs:

```bash
node packages/cli/dist/index.js \
  --provider ollama \
  --model gemma4:31b \
  --think on \
  --json-stream \
  --max-turns 32 \
  --prompt "PROMPT"
```

For faster baseline comparisons, change only `--model gemma4:26b`. Keep `--json-stream` on so thinking, content chunks, tool starts, tool results, heartbeats, and final status remain visible during long local-model calls.

### Pass Criteria

A run is green only when all 10 changes complete in one target folder and each change is independently validated. Trust command exit codes, code inspection, and direct CLI execution over the model's final summary.

Required validation after each change:

```bash
npm test --prefix RUN_TARGET
npm run build --prefix RUN_TARGET
```

Required validation at least once after the initial project exists and again after CLI-affecting changes:

```bash
node RUN_TARGET/bin/cli.js --help
```

Also inspect files for scratch/self-correction text when the model rewrites generated code:

```bash
rg -n "Wait|oops|placeholder|I will fix|mistake in my draft|self-correction" RUN_TARGET
```

### Failure Handling

If a run becomes hard to trust, stop it and start a new `RUN_TARGET`. Do not contort the next prompt to forbid the exact bad command or exact bad implementation. Record the failure here, fix the runtime or prompts at the system level when appropriate, then restart.

Minor correction prompts are allowed when they are normal user feedback, for example "the CLI crashes when I run it" or "date filtering misses transactions on the end date." They should not prescribe internal implementation details unless a real user reasonably would.

### Permission Smoke

This suite also covers the outside-workspace permission behavior that bit us with `~/source/foo.txt`.

- TUI approval path: start the TUI, ask it to create `~/source/foo.txt`, approve the outside-workspace dialog with `Y`, then validate the file exists at the shell-expanded home path and that no literal `./~/` folder was created under the repo.
- Headless safety path: outside-workspace file access should fail closed unless `--yolo` is explicitly supplied.
- The permission dialog should be visually obvious as an interactive action, with explicit `Y` allow and `N` deny choices.

### TUI Rendering Smoke

When touching Ink TUI rendering, static history, `/clear`, input layout, or terminal-size handling, run the focused rendering checks before any live agent suite:

```bash
npm run test --workspace gemma-cli -- --run src/tui/ink/StaticHistory.test.ts src/tui.test.ts
npm run snapshot:tui
npm run smoke:tui-resize
```

For resize regressions, the automated expectation is that a terminal resize updates dimensions immediately, waits for resize churn to settle, clears the current terminal frame, and remounts Ink `Static` history exactly once. Also do one manual TUI drag-resize before publishing if the change touched the live Ink frame.

## Goal

Use Gemma CLI command by command to create and evolve one small, dependency-free Node.js project through 10 changes. After every Gemma prompt, validate the result outside the agent with normal shell commands and code inspection.

The target app should be easy to validate without an interactive browser. Use a ledger utility because correctness can be checked with deterministic Node tests.

## Rules

- Do not drive the test with a generated runner script.
- Use one Gemma CLI prompt per change.
- Validate after every prompt with local commands.
- Inspect code when test output is too shallow to prove the change.
- If a run becomes polluted, misleading, or hard to trust, stop that run and restart in a new target folder.
- When restarting, update this file with what failed and improve the green-path prompts.
- Do not count "Gemma said it worked" as validation.
- Keep prompts user-like. Do not add exact "do not use command X" or "must implement Y this way" wording just because a prior run failed. Put those expectations in validation notes, not in the user prompt.

## Target Folder

Use a fresh folder per run:

```text
test-projects/ledger10-runNN
```

Replace `RUN_TARGET` in prompts and commands with the active run folder.

## Validation Commands

Run these after each prompt once the project exists:

```bash
npm test --prefix RUN_TARGET
npm run build --prefix RUN_TARGET
```

Use these for inspection as needed:

```bash
find RUN_TARGET -maxdepth 3 -type f -print
sed -n '1,220p' RUN_TARGET/src/ledger.js
sed -n '1,220p' RUN_TARGET/src/cli.js
sed -n '1,260p' RUN_TARGET/test/ledger.test.js
```

Validation should check whether `npm run build` is meaningful. A fake build that only prints success is a test finding, not something to prevent by overfitting the next user prompt.

## Green-Path Prompt Sequence

### Change 1: Create the Project

```text
Make me a small dependency-free Node.js ledger project in RUN_TARGET. It should have a simple CLI, a reusable ledger module, and tests for adding transactions plus income, expense, and net totals. I need to be able to run npm test and npm run build in the project when it is done.
```

### Change 2: Category Totals

```text
In RUN_TARGET, add category summaries to the ledger app and cover the behavior with tests. Make sure the existing project still works.
```

### Change 3: Date Filtering

```text
In RUN_TARGET, add date range filtering and monthly summaries. Include tests for the important edge cases and make sure the app still works.
```

### Change 4: CSV Export

```text
In RUN_TARGET, add CSV export for the ledger data. Include tests that would catch broken CSV output.
```

### Inserted Change: Date Range Bug Fix

Use this when date filtering passes the generated tests but fails an independent whole-day boundary check.

```text
In RUN_TARGET, I noticed date range filtering can miss transactions later on the end date when I use a YYYY-MM-DD end date. Please make date filtering handle normal whole-day ranges reliably and add tests for that case.
```

### Change 5: JSON Import and Validation

```text
In RUN_TARGET, add JSON import for transactions and validate bad input cleanly. Cover the happy path and a few bad inputs with tests.
```

### Change 6: CLI Commands

```text
In RUN_TARGET, make the CLI more useful with commands for the features we have so far. Add tests for the command-line behavior.
```

### Change 7: Budgets

```text
In RUN_TARGET, add basic category budgets and budget status reporting. Add tests so I can trust the results.
```

### Change 8: Recurring Transactions

```text
In RUN_TARGET, add recurring transactions for weekly and monthly items. Cover tricky date behavior with tests.
```

### Change 9: HTML Report

```text
In RUN_TARGET, add an HTML report generator for a ledger summary. Include tests for report content and safe handling of user text.
```

### Change 10: Public API and Docs

```text
In RUN_TARGET, add a helpful README with examples and do a cleanup pass on the public API. Add enough tests to catch accidental export breakage.
```

## Run Log

### Terminal-Bench v2 Harbor Smoke - 2026-05-04

- Dataset/task: `terminal-bench@2.0`, `configure-git-webserver`, one attempt, one concurrent trial.
- Model: `gemma4:31b` through Ollama at `http://host.docker.internal:11434`.
- Package under test: local packed tarballs for the pending Gemma CLI runtime fixes.
- Target/jobs: `/tmp/gemma-cli-tbench2-smoke/gemma-cli-local-output-limit-fix-smoke-20260504-210323`.
- Status: abandoned after evidence collection; do not count as a Harbor pass.
- Evidence: the JSONL log reached `run_completed`, installed git, configured `/git/server`, pushed `hello.html`, started the HTTP server, and verified `curl http://localhost:8080/hello.html` returned `hello world`.
- Failure: the CLI process stayed alive after `run_completed`, so Harbor never wrote `gemma-cli.exitcode` until the run was manually stopped.
- Runtime fix added after this run: the CLI entrypoint now flushes stdout/stderr and exits with the returned headless exit code.

### Terminal-Bench v2 Harbor Exit Smoke - 2026-05-04

- Dataset/task: `terminal-bench@2.0`, `configure-git-webserver`, one attempt, one concurrent trial.
- Model: `gemma4:31b` through Ollama at `http://host.docker.internal:11434`.
- Package under test: local packed tarballs for the pending Gemma CLI runtime fixes.
- Target/jobs: `/tmp/gemma-cli-tbench2-smoke/gemma-cli-local-exit-fix-smoke-20260504-211753`.
- Status: failed with `NonZeroAgentExitCodeError`; trust only as process-lifetime evidence, not as a task-quality pass.
- Evidence: Harbor completed in about 9 minutes and wrote `agent/gemma-cli.exitcode` as `1`, proving the headless CLI no longer hangs after a failed run.
- Failure: the run failed during a model turn with `Ollama OpenAI-compatible stream was aborted: This operation was aborted.`
- Runtime fix added after this run: local provider transport aborts are treated as one retryable transient failure when the Gemma CLI run signal has not been cancelled.

### Terminal-Bench v2 Harbor Smoke Pass - 2026-05-04

- Dataset/task: `terminal-bench@2.0`, `configure-git-webserver`, one attempt, one concurrent trial.
- Model: `gemma4:31b` through Ollama at `http://host.docker.internal:11434`, context loaded at `262144`.
- Package under test: local packed tarballs for the pending Gemma CLI runtime fixes.
- Target/jobs: `/tmp/gemma-cli-tbench2-smoke/gemma-cli-local-abort-retry-smoke-20260504-212912`.
- Status: passed; Harbor reported `1/1 Mean: 1.000`, reward `1.0`, `0` exceptions, runtime `8m 38s`.
- Evidence: agent exit code was `0`; JSONL reached `run_completed` after 14 turns and 13 tool calls; the agent installed git, created the bare repo and post-receive hook, started the web server, pushed `hello.html`, and verified `curl http://localhost:8080/hello.html` returned `hello world`.
- Notes: the model first wrote a malformed `webserver.py`, then noticed the bad code from tool/history evidence and overwrote it with a clean version before verification.

### Ad Hoc Notes App Investigation

- Target: `test-projects/notesapp02`
- Session: `.gemmacli/sessions/1018389f.json`
- Status: investigated
- Notes:
  - The third run started from a 24 KB pasted HTML design prompt and never recorded `run_completed` or `run_failed`; the Node process aborted with V8 heap OOM while the Ink TUI was still showing model reasoning progress.
  - Related issues in the same session: `search_text` failed with `spawn rg ENOENT`, the npm conversion churned through mismatched ESLint 10/8 config, and the app's Vite build was not validated before the final answer.
  - Runtime fixes added: truncate oversized pasted prompts only in visual TUI history, throttle Ink model-progress redraws, mark stale `running` diagnostic runs as interrupted on resume, avoid duplicating huge prompts in JSONL run-start events, and fall back to built-in text search when `rg` is unavailable.
  - Validation after the fix: repo `npm run build`, repo `npm test`, notes app `npm run lint`, and notes app `npm run build` all passed.

### React Skill Run 01

- Target: `test-projects/react-notes-skill-run01`
- Model: `gemma4:31b` through Ollama runtime model `gemma-cli/gemma4-31b-cdfe9e7730:ctx262144`
- Session: `.gemmacli/sessions/c95fb5ea.json`
- Status: failed; do not trust this generated app
- Notes:
  - Prompt relied on auto-detection for the built-in React skill.
  - The run created package/config/source files and showed React-specific planning, but `run_started` did not report auto-detected skills. Runtime change added after this run: JSON stream `run_started` and final payload now include merged skills plus `detectedSkills`.
  - Gemma wrote a bad tooltip implementation, tried a stale patch, then recovered by rereading and replacing `src/components/ui.tsx`.
  - The run then streamed a very large `write_file` payload for a main app component, emitted an incomplete/malformed tool call, and entered heartbeat-only Ollama activity until the stream aborted. Runtime reported the Ollama reset command: `ollama stop 'gemma-cli/gemma4-31b-cdfe9e7730:ctx262144'`.
  - Independent inspection found no `src/App.tsx`, a malformed `tailwind.config.js` glob, and stray text appended to `src/main.tsx`: `" applicants: null}`.
  - Validation: `npm install --prefix test-projects/react-notes-skill-run01` succeeded, but `npm run build --prefix test-projects/react-notes-skill-run01` failed with an unterminated string literal in `src/main.tsx`.
  - Skill tuning added after this run: the React skill now explicitly asks for focused component files and smaller `write_file` payloads for non-trivial apps.

### React Skill Run 02

- Target: `test-projects/react-notes-skill-run02`
- Model: `gemma4:31b` through Ollama runtime model `gemma-cli/gemma4-31b-cdfe9e7730:ctx262144`
- Session: `.gemmacli/sessions/2b71db99.json`
- Status: failed; do not trust this generated app
- Notes:
  - Prompt used the multi-prompt strategy and relied on auto-detection.
  - Telemetry fix worked: `run_started` reported `skills:["React App Builder"]` and `detectedSkills:["React App Builder"]`.
  - Gemma scaffolded a Vite project and installed dependencies, then emitted a valid-looking `exec_command` JSON for Tailwind setup followed by noisy repeated raw suffixes: `<tool_call|>}<tool_call|>}<tool_call|>}<tool_call|>`.
  - The old parser treated this as protocol drift during streaming and the provider turn entered heartbeat-only activity. The run was terminated and abandoned.
  - Runtime fix added after this run: accept completed JSON tool calls with trailing noisy marker/brace suffixes during streaming and final parse, so the intended tool executes instead of forcing another Ollama turn. Regression test added in `agent.test.ts`.
  - Validation after the fix: repo `npm run typecheck`, `npm test`, and `npm run build` passed.

### React Skill Run 03

- Target: `test-projects/react-notes-skill-run03`
- Model: `gemma4:31b` through Ollama runtime model `gemma-cli/gemma4-31b-cdfe9e7730:ctx262144`
- Session: `.gemmacli/sessions/e5dd8764.json`
- Status: failed; do not trust this generated app
- Notes:
  - Prompt used the same multi-prompt strategy and auto-detected the React skill.
  - The parser fix from run 02 worked for a short noisy suffix: an `npm install lucide-react react-markdown clsx tailwind-merge` command with trailing `<tool_call|>}` markers executed successfully.
  - A later `write_file` for `src/index.css` emitted a complete tool call and then streamed raw marker tokens indefinitely. The run was terminated and abandoned before the app was implemented.
  - Runtime fix added after this run: streaming protocol monitor now cuts off a completed tool JSON followed by repeated raw marker suffixes and executes the completed tool call instead of waiting for Ollama to finish the marker loop. Regression coverage updated in `agent.test.ts`.
  - Validation after the fix: repo `npm run typecheck`, `npm test`, and `npm run build` passed.

### React Skill Run 04

- Target: `test-projects/react-notes-skill-run04`
- Model: `gemma4:31b` through Ollama runtime model `gemma-cli/gemma4-31b-cdfe9e7730:ctx262144`
- Session: `.gemmacli/sessions/62686172.json`
- Status: buildable but untrusted; do not count as a solid React app run
- Notes:
  - Prompt used the same notes-app target and relied on auto-detection.
  - Skill detection worked: `run_started` reported `skills:["React App Builder"]` and `detectedSkills:["React App Builder"]`.
  - Gemma avoided the earlier Tailwind loop by choosing plain CSS, scaffolded Vite, installed `react-markdown` and `lucide-react`, and split the implementation into `storage.js`, `hooks/useNotes.js`, `App.css`, and `App.jsx`.
  - The run still relied on large `write_file` payloads: `App.css` was about 4.9 KB and `App.jsx` was about 7.1 KB. Gemma wrote malformed/self-debugging versions of `App.jsx`, noticed some of the mistakes, and rewrote the file.
  - The model also corrupted `package.json` with a trailing `"}` artifact while adding a `validate` script, then recovered after `npm run validate --prefix test-projects/react-notes-skill-run04` failed with `EJSONPARSE`.
  - Validation during the model run found a JSX syntax error in `App.jsx`; Gemma eventually rewrote the file again, but the next Ollama turn entered heartbeat-only activity and the CLI process was killed after no model chunks arrived.
  - Independent validation after killing the run: `npm run build --prefix test-projects/react-notes-skill-run04` and `npm run validate --prefix test-projects/react-notes-skill-run04` passed.
  - Independent lint failed: `npm run lint --prefix test-projects/react-notes-skill-run04` reported `src/App.jsx:1:8 'React' is defined but never used`.
  - Quality finding: the app contains a visible `Settings not implemented` alert, so it is not a polished feature-complete notes workspace.
  - Lesson: the React skill is loading reliably, but the live failure points to large structured `write_file` payloads, transport/no-progress recovery, and insufficiently small validation loops rather than missing skill detection. Future React runs should force smaller component files and validate after each focused file group.
  - Skill/tool feedback tuning added after this run: the React skill now explicitly discourages large monolithic `App.jsx`/`App.tsx` files and dead controls, and workspace writes now warn on `not implemented`, `unimplemented`, and `coming soon` generated content. Repo `npm run typecheck`, `npm test`, and `npm run build` passed after this tuning.

### React Skill Run 05

- Target: `test-projects/react-notes-skill-run05`
- Model: `gemma4:31b` through Ollama runtime model `gemma-cli/gemma4-31b-cdfe9e7730:ctx262144`
- Session: `.gemmacli/sessions/0d571d32.json`
- Status: buildable but untrusted; improved split, still not a solid React app run
- Notes:
  - Prompt asked for a polished React notes app with notebooks, pinned notes, fast search, markdown preview, localStorage persistence, responsive layout, and npm scripts for dev/build/validation. The run relied on auto-detection for the built-in React skill.
  - Skill detection worked: `run_started` reported `skills:["React App Builder"]` and `detectedSkills:["React App Builder"]`.
  - The model initially drafted malformed raw monolithic `App.jsx` content in model text, but did not execute that as a tool call. It then recovered and created focused files: `src/components/Notebooks.jsx`, `src/components/NoteList.jsx`, `src/components/Editor.jsx`, `src/storage.js`, `src/App.jsx`, and `src/App.css`.
  - Improvement from run 04: `App.jsx` dropped from about 7.1 KB to about 4.4 KB and feature code was split across components. The model-run `npm run build` passed and `finalize_build` succeeded.
  - Independent validation: `npm run build --prefix test-projects/react-notes-skill-run05` passed.
  - Independent validation failure: `npm run validate --prefix test-projects/react-notes-skill-run05` failed because no `validate` script was created despite the prompt asking for validation scripts.
  - Independent lint failed: `npm run lint --prefix test-projects/react-notes-skill-run05` reported unused default React imports in `App.jsx`, `Editor.jsx`, `NoteList.jsx`, and `Notebooks.jsx`; `App.jsx` also had unused `setIsListOpen` and `updateData`.
  - Quality finding: `App.jsx` includes a hidden sidebar button with `style={{ display: 'none' }}`, indicating unfinished responsive behavior or dead UI state.
  - Lesson: splitting files helps and skill loading is reliable, so do not switch to the profile fallback yet. The remaining gap is tighter generated-app validation and tool feedback for large frontend writes, unused/dead code, and hidden controls.
  - Skill/tool feedback tuning added after this run: the React skill now explicitly requires requested `validate` scripts, lint runs when available, cleanup of unused imports/dead state, and no unnecessary default React imports. Workspace writes now warn on oversized React/CSS file writes and hidden React buttons so Gemma gets feedback before finalizing.

### React Skill Run 06

- Target: `test-projects/react-notes-skill-run06`
- Model: `gemma4:31b` through Ollama runtime model `gemma-cli/gemma4-31b-cdfe9e7730:ctx262144`
- Initial session: `.gemmacli/sessions/4789b47b.json`
- Correction sessions: `.gemmacli/sessions/1dc01fb9.json` and `.gemmacli/sessions/f8eccb14.json`
- Status: initial run was build/lint green but untrusted; corrected target now passes independent mounted-app checks
- Notes:
  - Prompt asked for a polished React notes app with notebooks, pinned notes, fast search, markdown preview, localStorage persistence, responsive layout, and npm scripts for dev/build/validation. The run relied on auto-detection for the built-in React skill.
  - Skill detection worked: `run_started` reported `skills:["React App Builder"]` and `detectedSkills:["React App Builder"]`.
  - Gemma scaffolded a Vite React app, installed `lucide-react` and `react-markdown`, added a `validate` script, and split the implementation into `storage.ts`, `context.tsx`, `components/UI.tsx`, `components/Sidebar.tsx`, `components/Editor.tsx`, `App.tsx`, and `index.css`.
  - The oversized-write feedback fired for `Sidebar.tsx`, but Gemma rewrote the same large file rather than splitting it further. This warning is useful evidence, but not a hard enforcement mechanism.
  - The model initially configured Tailwind/PostCSS incorrectly, saw build failures, installed `@tailwindcss/postcss`, switched CSS to `@import "tailwindcss"`, and reached a passing model-run `npm run validate`.
  - Independent validation found a critical false-green failure: `src/main.jsx` still imported `./App.jsx`, while the generated app lived in `src/App.tsx`. The mounted `App.jsx` was the untouched Vite starter, so build/lint/validate passed against the wrong app.
  - Runtime/tool fix added after this failure: `finalize_build` now rejects stale or ambiguous Vite React entrypoints when a generated `App.tsx`/`App.jsx` is not the mounted app, and `write_file` warns when writing `src/App.tsx` while `src/main.jsx` still imports `./App.jsx`.
  - Correction attempt 1 exposed a separate tool-shape problem: Gemma repeatedly called `list_tree` with `path:["test-projects/react-notes-skill-run06"]`, and the old tool silently treated that malformed path as the workspace root. The run was killed after no useful progress.
  - Runtime/tool fix added after correction attempt 1: `list_tree` now rejects non-string `path` values instead of defaulting to `.`. Regression coverage was added.
  - Correction attempt 2 used a valid string path, created `src/main.tsx`, updated `index.html` to `/src/main.tsx`, and removed the stale Vite starter files/assets: `src/main.jsx`, `src/App.jsx`, `src/App.css`, and the default assets.
  - Model-run validation during correction attempt 2: `npm --prefix test-projects/react-notes-skill-run06 run lint` passed and `npm --prefix test-projects/react-notes-skill-run06 run build` passed. The model still did not run `validate` despite the prompt asking for validation.
  - Independent validation after correction: `npm run lint --prefix test-projects/react-notes-skill-run06`, `npm run build --prefix test-projects/react-notes-skill-run06`, and `npm run validate --prefix test-projects/react-notes-skill-run06` all passed.
  - Independent mounted-app checks passed: source search found no stale Vite starter strings, no stale `App.jsx` references, no protocol markers, and no obvious `not implemented`/`coming soon` placeholders. The built bundle contains the generated notes app text such as `Gemma Notes` and no Vite starter copy.
  - Residual product-quality risk: the generated app is now mounted and buildable, but the live run still needs deeper UX validation. For example, visible notebook controls should create, rename, or delete notebooks rather than only filtering existing seeded data.
  - Lesson: the React skill is detected and loaded reliably. The bad-small-code pattern is mostly caused by tool-call protocol drift, malformed tool arguments, stale scaffold entrypoints, and validation gaps where a green build can prove the wrong thing. Keep improving tool feedback and finalization checks before falling back to a custom profile.

### React Skill Run 07

- Target: `test-projects/react-black-hole-skill-run01`
- Model: `gemma4:31b` through Ollama runtime model `gemma-cli/gemma4-31b-cdfe9e7730:ctx262144`
- Session: `.gemmacli/sessions/914d0258.json`
- Status: failed; buildable but untrusted blank-app risk
- Notes:
  - Prompt asked for a polished Vite React black hole visualizer with an animated visual surface, accretion disk / lensing style effects, controls for mass, spin, accretion intensity, camera distance, simulation speed, and pause/reset flow.
  - Skill detection worked: `run_started` reported `skills:["React App Builder"]` and `detectedSkills:["React App Builder"]`.
  - Gemma scaffolded Vite, added a `validate` script, created canvas-based visualizer files, and recovered after a malformed `BlackHoleCanvas.jsx` write leaked self-correction text into the file. The large React write warning fired for both the 10.5 KB failed write and the smaller 4.3 KB correction.
  - Model-run `npm run validate --prefix test-projects/react-black-hole-skill-run01` passed, and `finalize_build` correctly rejected the first completion because the reported validation command did not match the exact successful command.
  - Independent validation found a more important false-green failure: `src/main.jsx` imported `App` but only exported a `Main` component and never called `ReactDOM.createRoot(...).render(...)`. The Vite build passed, but the browser would render a blank root.
  - Independent lint failed on unused default `React` imports in `App.jsx`, `BlackHoleCanvas.jsx`, `constants/simulation.js`, and `main.jsx`.
  - Runtime/tool fix added after this run: React entrypoint writes now warn when a `src/main.*` file imports `App` without a root mount, and `finalize_build` rejects React entrypoints that import an app but do not mount it into `#root`.
  - Lesson: build success is still too weak for generated React apps. Finalization needs entrypoint and browser-render checks before a visual app can be trusted.

### Run 01

- Target: `test-projects/ledger10-run01`
- Status: aborted
- Notes:
  - The earlier ad hoc `test-projects/ledger10-smoke` run was stopped before this documented plan started. Do not use it as the green run.
  - Change 1: completed and independently validated with `npm test` and `npm run build`.
  - Change 1 issue: Gemma tried `npm run build` before creating `package.json`, then recovered.
  - Change 1 issue: the generated build script only echoed success. This remains a validation finding, not a prompt constraint.
  - Change 2 was stopped because the prompt became overfit and implementation-specific.

### Run 02

- Target: `test-projects/ledger10-run02`
- Status: failed
- Notes:
  - Restart with the user-like prompt sequence above.
  - Change 1: `npm test --prefix test-projects/ledger10-run02` passed.
  - Change 1 failure: `npm run build --prefix test-projects/ledger10-run02` failed because no `build` script existed, despite the prompt asking for npm scripts for build and test.
  - Change 1 failure: `test/ledger.test.js` contains a broken unused test function with `latetNet()`, so the passing test suite did not prove the whole test file was clean.
  - Lesson: keep the prompt user-like, but validation must inspect code and run both commands. Restart in a new folder rather than patching a polluted run.

### Run 03

- Target: `test-projects/ledger10-run03`
- Status: failed
- Notes:
  - Restarting from change 1 with a user-like prompt that states the commands the user expects to run afterward.
  - Change 1 failure: Gemma ran only `mkdir -p test-projects/ledger10-run03`, then answered that it created files and that tests/build passed.
  - Independent validation found no files and `npm test --prefix test-projects/ledger10-run03` failed because `package.json` did not exist.
  - Runtime fix added: final answers that claim project/file completion or requested npm validation now need substantive tool evidence and successful matching `exec_command` output, not just a thin directory command.
  - Core regression test added for this failure mode.

### Run 04

- Target: `test-projects/ledger10-run04`
- Status: stopped after change 5
- Notes:
  - Restart after rebuilding the CLI with the evidence guard fix.
  - Change 1: completed and independently validated with `npm test --prefix test-projects/ledger10-run04`, `npm run build --prefix test-projects/ledger10-run04`, CLI execution, code inspection, and scratch-text search.
  - Change 1 finding: the generated build script only copies `lib/ledger.js` into `dist/`; it passes but is a weak validation signal.
  - Change 1 finding: Gemma briefly wrote scratch/self-correction text into a file, then fixed it before validation passed. Final files are clean.
  - Change 2: category summaries completed and independently validated with `npm test`, `npm run build`, CLI execution, code inspection, and scratch-text search.
  - Change 2 finding: Gemma recovered correctly from a failed edit by reading the file and rewriting it.
  - Change 2 finding: tests contain an odd `new NullLedger()` helper pattern, but it passes and does not currently pollute the implementation.
  - Change 3: date range filtering and monthly summaries completed; generated tests and build passed.
  - Change 3 finding: write_file scratch guard rejected a bad generated test file containing self-correction text, and Gemma retried cleanly.
  - Change 3 failure: independent boundary check found that `getTransactionsInRange(new Date('2023-01-01'), new Date('2023-01-31'))` excludes a transaction at `2023-01-31T12:00:00`.
  - Next step: insert a user-level bug fix before continuing to CSV.
  - Inserted date fix 1: Gemma adjusted the end date with `setHours(23, 59, 59, 999)` and added a same-date test.
  - Inserted date fix 1 failure: independent noon-on-end-date check still prints `0`, likely due `YYYY-MM-DD` parsing/timezone behavior.
  - Inserted date fix 2: Gemma created a repro test, saw it fail, changed the implementation to `setUTCHours`, saw the repro pass, and then removed the repro file.
  - Inserted date fix 2 failure: Gemma edited scratch text and an invalid unused date into the main test file even though tests passed.
  - Runtime fix added: scratch-content guard now catches the `Wait, I see a typo in my thought` pattern for `edit_file` replacements; regression test added in `workspace.test.ts`.
  - Inserted cleanup: Gemma cleaned the polluted test file. Independent validation passed with `npm test`, `npm run build`, the noon-on-end-date reproduction, code inspection, and scratch-text search.
  - Change 4 CSV attempt: stopped after a long silent headless `--json` run. Product issue found: headless JSON mode hides Ollama activity until final output, making long local thinking runs look dead.
  - Runtime improvement added: `--json-stream` emits JSONL progress events (`run_started`, `model_start`, `model_activity`, `tool_start`, `tool_result`, `final_turn`, `run_completed`) for headless runs.
  - `--json-stream --think off` smoke check completed and showed activity chunks plus final `run_completed` output.
  - Change 4 CSV retry: completed with `--json-stream` and visible tool/model progress. Independent validation passed with `npm test`, `npm run build`, a direct CSV escaping check for comma/quote/newline/category text, code inspection, and scratch-text search.
  - Change 4 finding: generated CSV tests are weaker than ideal for quotes/newlines, but the implementation passed a stronger independent check.
  - Change 5 JSON import attempt: Gemma implemented JSON import and tests, recovered from one failing assertion, and independent validation passed for happy path plus malformed JSON, non-array JSON, non-number amount, and empty description.
  - Change 5 runtime failure: the live headless run was stopped because Gemma kept rerunning tests after a successful `exec_command` result. The project tests passed, but the generated test file no longer printed its old success message, so the model distrusted the quiet output.
  - Runtime fix added: successful `exec_command` results now include `Command exited with 0.` and the system prompt explicitly says `ok:true` means exit status 0 even when stdout is quiet or lacks "passed" wording.
  - JSON import resume attempt: reproduced `Ollama response did not include text content (done_reason=stop)` after a thinking-only response. The provider's hidden empty-response retry was not enough.
  - Runtime fix added: the agent now catches empty-content provider errors, appends a protocol repair instruction, forces thinking off for the next call, and continues instead of failing the run immediately.
  - JSON import retry after empty-response fix: recovered past the crash and read the existing implementation/tests, but spent multiple turns rerunning the same successful `npm test` because the output was quiet.
  - Runtime fix added: duplicate successful validation commands are reused after the latest file change, with an explicit result telling the model not to rerun identical validation only because stdout is short.
  - JSON import retry after duplicate-command fix: Gemma still distrusted quiet successful test output and made an unnecessary edit to add a success log, introducing a syntax error into `test/ledger.test.js`.
  - Runtime fix added: after a successful validation command, the agent rejects cosmetic edits that only add "All tests passed" style output and tells the model to trust the exit code instead.
  - JSON import cleanup: repaired the polluted assertion message, kept the restored success log, and independently validated with `npm test`, `npm run build`, and scratch-text search.
  - Change 6 attempt: stopped while read-only after the user requested a fresh left-to-right run in a clean folder.

### Run 05

- Target: `test-projects/ledger10-run05`
- Status: stopped during change 3
- Notes:
  - Restarting from change 1 in a clean folder per user request. Goal is to run the plan left to right until it works within reason, with minor correction prompts allowed only when they preserve the spirit of the test.
  - Change 1: completed by Gemma and independently validated with `npm test`, `npm run build`, and CLI add/report commands.
  - Change 1 failure: `lib/ledger.js` contained scratch placeholder text: `This is just a placeholder, I will fix it in a real write`.
  - Runtime fix added: write/edit scratch guard now rejects placeholder/self-repair comments such as "placeholder" and "I will fix".
  - Change 1 finding: the build script is still weak (`echo 'Build complete'`). Treat as a validation finding unless the next cleanup prompt naturally improves it.
  - Change 1 correction attempt: Gemma hit a protocol-retry stall after a malformed mixed read_files response, so the run was stopped.
  - Manual cleanup applied to preserve the clean run: removed the scratch placeholder branch and changed `npm run build` to `node --check lib/ledger.js && node --check bin/cli.js`.
  - Change 1 after cleanup: independent validation passed with `npm test`, `npm run build`, CLI add/report commands, and scratch-text search.
  - Change 2: category summaries completed after Gemma repaired a generated syntax error in `bin/cli.js`.
  - Change 2 validation: independent `npm test`, `npm run build`, CLI add/report commands, and scratch-text search passed.
  - Change 2 finding: CLI persistence currently saves amount, description, type, and category but not date. Watch whether the date filtering prompt naturally fixes persisted dates.
  - Change 3 attempt 1: Gemma applied the ledger-library date/monthly summary patch, then drifted while drafting a CLI patch and the Ollama call eventually failed with `TypeError: fetch failed`.
  - Change 3 attempt 1 validation: the partial project still passed `npm test` and `npm run build`, but CLI/report/tests were not updated for date filtering, so the change is incomplete.
  - Runtime fix added: transient local provider transport failures such as `fetch failed` now get one retry with thinking disabled and an explicit instruction to trust only completed tool results.
  - Change 3 attempt 2: Gemma resumed and updated `bin/cli.js`, but then repeatedly drafted malformed test-file writes with scratch text embedded in visible JSON. The process was stopped after several quiet minutes.
  - Runtime fix added: protocol-retry turns now force thinking off, and write/edit/apply_patch scratch guards now reject `mistake in my draft` and `Wait, checking...` patterns.
  - Change 3 attempt 2 validation: `npm test` and `npm run build` still passed, but independent CLI execution showed `report` printed `Period: report to Now` because the report command parsed `args[0]` as the start date. Stop this run rather than stacking more fixes onto a polluted target.

### Run 06

- Target: `test-projects/ledger10-run06`
- Status: stopped during change 1
- Notes:
  - Restarting from change 1 after the transient transport retry, protocol retry, and scratch-guard fixes.
  - Change 1 failure: Gemma initially emitted many tool calls and a final summary in one response. The runtime executed only the first `mkdir`, then the model attempted `exec_command` with `cwd: "test-projects/ledger10-run06"` before `package.json` existed.
  - Product bug found: `npm test` in an empty child cwd can walk up to the repo root and run the workspace test suite, creating false validation evidence for the wrong project.
  - Runtime fix added: package-manager script commands (`npm test`, `npm run build`, etc.) now fail in a cwd without `package.json` unless the command uses an explicit `--prefix`; duplicate validation reuse also distinguishes `cwd`.

### Run 07

- Target: `test-projects/ledger10-run07`
- Status: in progress
- Notes:
  - Restarting from change 1 after the package-manager cwd validation fix.
  - Change 1: completed after the scratch-content guard rejected a polluted first test file, and Gemma retried with a clean test file.
  - Change 1 validation: Gemma ran `npm test` and then, after runtime validation forced it, `npm run build` in the project cwd.
  - Change 1 failure: independent CLI execution failed with `SyntaxError: The requested module 'node:util' does not provide an export named 'Command'`.
  - Change 1 finding: the generated build script only echoes success, so it did not catch the broken CLI entry point.
  - Prompt fix added: the system prompt now says generated CLIs need at least one direct CLI command execution, and build scripts that only echo/print success are not proof of a project build.
  - Change 1 correction: Gemma reproduced the CLI crash, fixed the invalid import, and updated the build script away from pure `echo`.
  - Change 1 correction finding: scratch guards rejected two polluted edit attempts before Gemma used a clean `write_file`.
  - Change 1 correction validation: independent `npm test`, `npm run build`, direct CLI execution with `--income 100 --expense 40 --list`, direct `node --check` on the CLI and ledger module, and scratch-text search passed.
  - Change 1 residual finding: the generated build script uses `node --check lib/ledger.js bin/cli.js`, which exits 0 but may not syntax-check every intended file on all Node versions. The independent direct check covered both files.
  - Change 2 attempt: Gemma updated `lib/ledger.js` for categories, then drafted a polluted test edit and entered another quiet protocol-retry stall. The process was stopped rather than trusting a partial change.
  - Runtime improvement added: headless `--json-stream` now emits `model_heartbeat` events while a model call is pending without chunks, so long local calls and stuck retries remain visible.
  - Change 2 partial validation: after stopping, the project still passed `npm test`, `npm run build`, and direct CLI execution, but tests/CLI were not updated for categories. Treat this as incomplete.

### Run 08

- Target: `test-projects/ledger10-run08`
- Model: `gemma4:31b`
- Status: stopped during change 4
- Notes:
  - Restarting with the official live-suite workflow and the 31B model.
  - Change 1: completed in one headless `--json-stream` run. The stream showed heartbeats during the initial long provider wait, then thinking/content/tool progress throughout.
  - Change 1 finding: Gemma initially wrote a syntax typo in `src/cli.js`, noticed it in thinking, and fixed it before validation.
  - Change 1 finding: the first `finalize_build` call was rejected because validation commands were listed separately after being run as a combined `npm test && npm run build`; Gemma recovered by running `npm test` and `npm run build` separately.
  - Change 1 validation: independent `npm test --prefix test-projects/ledger10-run08`, `npm run build --prefix test-projects/ledger10-run08`, direct `node --check` on `src/ledger.js` and `src/cli.js`, direct CLI execution, and scratch-text search passed.
  - Change 1 residual finding: the generated build script only copies files into `dist`, so direct `node --check` remains the stronger build validation.
  - Change 2: category summaries completed and generated tests passed.
  - Change 2 finding: Gemma recovered from one malformed `write_file` call where the path was missing.
  - Change 2 failure: independent CLI validation found `node src/cli.js add Lunch -12 Food` followed by `node src/cli.js summary` printed an empty summary because CLI state was still in-memory.
  - Inserted CLI persistence correction: user-like correction prompt asked for the commands to work across invocations. Gemma added `save`/`load` support and made `src/cli.js` persist to `ledger.json` in the current working directory.
  - Inserted CLI persistence validation: independent clean-state run of `add Lunch -12 Food` then `summary` printed `Food: -12`; `npm test`, `npm run build`, `node --check`, and scratch-text search passed.
  - Change 3: date range filtering and monthly summaries completed, but generated tests/build were not sufficient.
  - Change 3 failure: independent CLI validation found `add Salary 100 Income 2023-01-15T10:00:00Z` still grouped under the current month, `range 2023-01-01 2023-01-31` printed usage, and `getTransactionsInRange('2023-01-01', '2023-01-31')` missed a transaction at `2023-01-31T12:00:00Z`.
  - Inserted date-handling correction: user-like correction prompt reported the observed failures. Gemma fixed CLI argument parsing, passed the optional date through `add`, and changed whole-day end dates to include the final day.
  - Inserted date-handling validation: independent project-local `npm test`, `npm run build`, `node --check`, clean CLI add/monthly/range execution from the project directory, and direct Jan 31 noon range check passed.
  - Change 3 finding: Gemma first validated dated CLI behavior from the repo root, creating a root `ledger.json`; it later noticed the project-local validation gap but still only summarized. Independent validation cleaned the root artifact and verified from the target directory.
  - Change 4 attempt: stopped after Gemma repeatedly generated malformed CSV template literals and scratch/self-debugging comments inside `src/ledger.js`.
  - Runtime gap found: the scratch-content guard blocked earlier `Correction:` and `Wait, I see...` patterns, but allowed `Fix: I noticed...`, `Wait, I keep making...`, and `Let's be extremely careful` comments into source.
  - Runtime fix added: scratch-content guard now rejects those self-debugging patterns and has a regression test based on this CSV failure.

### Run 09

- Target: `test-projects/ledger10-run09`
- Model: `gemma4:31b`
- Status: stopped during change 1
- Notes:
  - Restarting from change 1 in a clean folder after tightening the scratch-content guard found during Run 08 change 4.
  - Change 1 failure: Gemma created `package.json` and `ledger.js`, then streamed repeated raw `<tool_call|>}` transport markers while drafting the CLI. The live run was killed rather than waiting on malformed output.
  - Change 1 finding: the malformed CLI draft also contained demo-scaffold comments such as "In a real app, we'd persist data", "For this demo", and "To satisfy the prompt", which are not acceptable generated implementation.
  - Runtime fix added: the protocol monitor now cuts off repeated raw tool-call transport markers and retries with thinking disabled. Scratch-content guard now rejects demo/assignment scaffold comments instead of allowing fake implementations.

### Run 10

- Target: `test-projects/ledger10-run10`
- Model: `gemma4:31b`
- Status: stopped during change 4
- Notes:
  - Restarting from change 1 in a clean folder after adding repeated-transport-token recovery and demo-scaffold scratch guards.
  - Change 1 prompt: create a small dependency-free Node.js ledger project with a simple CLI, reusable ledger module, tests for adding transactions and income/expense/net totals, plus `npm test` and `npm run build`.
  - Change 1 result: Gemma created `package.json`, `lib/ledger.js`, `bin/cli.js`, `test/ledger.test.js`, and `scripts/build.js`; model-run validation passed `npm test`, `npm run build`, `node --check`, and a basic CLI `add`.
  - Change 1 protocol finding: Gemma first called `finalize_build` with `sumary`; the tool rejected it, then Gemma recovered and called the tool correctly with `summary`.
  - Change 1 independent validation: `npm test --prefix test-projects/ledger10-run10`, `npm run build --prefix test-projects/ledger10-run10`, `node --check` for all generated JS files, `ledger help`, and `ledger add Salary 5000` all completed.
  - Change 1 quality finding: help output contains a visible typo, `trong list all transactions`; this should be corrected by a normal follow-up prompt rather than manually patching the generated project.
  - Change 2 prompt: fix the help typo, then add category summaries with tests while keeping the existing project working.
  - Change 2 model validation: Gemma added `category` to transactions, `getCategorySummary()`, a `cat-summary` CLI command, list-category output, and a category-summary unit test; model-run `npm test` and `npm run build` passed.
  - Change 2 independent validation: `npm test`, `npm run build`, and `node --check` passed; help typo was fixed.
  - Change 2 failure: realistic CLI use still fails because `add Salary 5000 Income` and a separate `cat-summary` invocation do not share state, so `cat-summary` prints only the header. This needs a normal correction prompt for dependency-free CLI persistence.
  - Inserted persistence correction: user-like prompt reported the exact CLI behavior, asked for dependency-free persistence, and required CLI-level verification so the issue cannot silently pass.
  - Persistence correction path: Gemma first wrote invalid `java.readFileSync`/`java.writeFileSync`, noticed the mistake, replaced it with Node `fs`, added `load()`/`save()`, and made `addTransaction()` save state.
  - Persistence correction validation loop: Gemma's first unit-test run failed because tests leaked persistent state between cases; it diagnosed the `10500 !== 5500` failure and cleaned before each test. The first CLI integration run failed because `bin/cli.js` was resolved from the repo root; it updated the integration test to compute `PROJECT_ROOT`.
  - Persistence correction final model validation: `npm --prefix test-projects/ledger10-run10 test && node test-projects/ledger10-run10/test/cli.test.js` passed with 8 unit tests and an integration flow covering `add`, `summary`, `cat-summary`, and `list` across separate process invocations.
  - Persistence correction independent validation: from a clean `.ledger.json`, `npm test`, `node test/cli.test.js`, `npm run build`, `node --check`, and manual CLI `add Salary 5000 Income`, `add Coffee -5 Food`, `summary`, `cat-summary`, and `list` passed.
  - Change 3 prompt: add date range filtering and monthly summaries with edge-case tests.
  - Change 3 path: Gemma added optional transaction dates, date range summaries, monthly summaries, and CLI `monthly`/`range` commands. It hit repeated patch-context failures updating CLI help, reread the file, then recovered with narrower edits.
  - Change 3 model validation: generated unit tests passed, but independent validation found `getTransactionsInRange('2024-01-01', '2024-01-31')` missed a transaction at `2024-01-31T12:00:00Z`.
  - Inserted date-boundary correction: user-like prompt reported the whole-day end-date failure. Gemma fixed date-only end ranges with `setUTCHours(23, 59, 59, 999)` and added a regression test for an end-date transaction.
  - Change 3 final independent validation: `npm test`, `node test/cli.test.js`, `npm run build`, `node --check`, a direct Jan 31 noon range reproduction, and scratch-text search passed.
  - Change 4 prompt: add CSV export for ledger data with tests that catch broken CSV output.
  - Change 4 failure: Gemma repeatedly failed patch-context matches in `bin/cli.js`, then used the exact `oldText`/`newText` `edit_file` tool. While fixing CSV escaping it corrupted a regex containing literal `\n` into a real newline inside a regex literal, causing `SyntaxError: Invalid regular expression: missing /`.
  - Change 4 finding: this is a model-facing tool-design failure, not just a local implementation bug. The `edit_file` tool encourages large exact replacement strings and is fragile for escape-heavy code. Repeating prompts about escaping would overfit the test.
  - Runtime fix added: the default workspace tool registry no longer exposes `edit_file`. Use `apply_patch` for diffs and `write_file` for complete file replacements. `agents.md` now records that exact oldText/newText edit tools and batch write tools should not be rebuilt for Gemma without new live-test evidence.
  - Next step: restart in `test-projects/ledger10-run11` after rebuilding, rather than continuing a polluted change-4 target.

### Run 11

- Target: `test-projects/ledger10-run11`
- Model: `gemma4:31b`
- Status: stopped after the recurring-transaction turn by user request; 8 planned feature changes completed plus 2 normal correction prompts
- Session: `.gemmacli/sessions/b3ec5321.json`
- Log: `.gemmacli/logs/b3ec5321.jsonl`
- Notes:
  - Restarted from a clean target after removing the default `edit_file` tool and rebuilding.
  - Run shape: 10 prompts from `2026-05-03T15:50:10Z` to `2026-05-03T18:02:53Z`, 97 persisted history entries, and 77 tool history entries.
  - Tool mix in the persisted session: `write_file` 32, `exec_command` 17, `read_file` 15, `read_files` 6, `apply_patch` 5, `list_tree` 1, `finalize_build` 1.
  - Change 1: Gemma created a dependency-free Node ledger project with module, CLI, tests, and build script. Generated tests/build passed.
  - Correction after Change 1: independent CLI execution found separate invocations did not share state. A normal user-like correction prompt led Gemma to add persistence and CLI-level verification.
  - Change 2: category summaries completed and validated.
  - Change 3: date range filtering and monthly summaries completed, but independent validation found two realistic date bugs: simple end dates missed later same-day transactions, and UTC month-boundary timestamps could be grouped into the local previous month.
  - Correction after Change 3: Gemma fixed whole-day end dates and UTC monthly bucketing with regression tests.
  - Change 4: CSV export completed. Earlier runs showed this was where `edit_file` failed badly; without `edit_file`, Gemma used `write_file`/`apply_patch` and got to green.
  - Change 5: JSON import completed with bad-input validation.
  - Change 6: CLI commands for accumulated features completed. The runtime recovered from malformed raw tool-marker drift instead of silently treating it as an answer.
  - Change 7: category budgets and budget status completed. Independent validation included migration from the old array storage format to the new object format.
  - Change 8: recurring transactions for weekly and monthly rules completed. Gemma's first implementation failed generated tests on UTC/monthly behavior, then fixed UTC stepping. A larger follow-up `apply_patch` failed with `apply_patch: hunk @@ -76 did not match`, after which Gemma recovered by rewriting the manageable file with `write_file`.
  - Change 8 model validation: `npm test --prefix test-projects/ledger10-run11` passed after the rewrite, including weekly recurrence, Jan 31 month-end recurrence, and idempotent sync tests.
  - Change 8 independent validation after the run: from the target folder, `npm test`, `npm run build`, `node --check lib/ledger.js`, `node --check bin/cli.js`, `node --check test/ledger.test.js`, and `node --check test/cli.test.js` passed. A direct API reproduction for monthly recurrence from `2023-01-31T00:00:00Z` through `2023-04-30T00:00:00Z` produced `2023-01-31,2023-02-28,2023-03-31,2023-04-30` and a second sync added 0 duplicates.
  - Tool lesson confirmed: `apply_patch` is good for targeted diffs, but patch-context failures are expected when the model patches against stale context. Runtime/prompt guidance should make the model re-read and patch smaller, or use `write_file` for full replacement when the file is small enough.
  - Trust level: useful live-suite evidence and materially better than Runs 08-10, but still not a full green 10-change suite because the user paused after Change 8. Do not claim the official 10-change suite is complete from this run.

### Harbor Terminal-Bench Sample Run 01

- Harness: `uvx harbor run` against `/tmp/harbor-tb-sample/terminal-bench-sample`
- Agent: `bench.harbor.gemma_cli_agent:GemmaCliAgent`
- Model: `gemma4:26b` via local Ollama at `http://host.docker.internal:11434`
- Install source: local npm tarballs plus `/tmp/gemma-cli-node-22-linux-amd64.tgz`
- Result: `/tmp/gemma-cli-harbor-jobs-9/gemma-cli-local-0.1.2-stdio-fix-full-sample/result.json`
- Status: completed 10 trials in 55m23s; 0 exceptions; mean `0.100`
- Scoring:
  - Passed: `configure-git-webserver__iXvC5X2`
  - Failed: `regex-log__epD8XHK`, `sqlite-with-gcov__yjpCM7Y`, `polyglot-c-py__qhpYtQv`, `log-summary-date-ranges__t7Fpbs2`, `chess-best-move__M3cBkur`, `qemu-startup__xmvokE5`, `fix-code-vulnerability__p5UFXb4`, `qemu-alpine-ssh__z34RAR2`, `build-cython-ext__KDit2Wi`
- Trust level: harness and adapter are runnable, but this is not a clean quality score. The final passing task required manual recovery because the old tarball left a background `http-server` attached to the CLI process after `run_completed`; the workspace was patched afterward so future builds release those handles.
- Runtime/tool fixes learned from the run:
  - Added the Harbor adapter under `bench/harbor/gemma_cli_agent.py` for installing Gemma CLI inside task containers and routing to host Ollama.
  - Increased shell idle timeout and terminate shell process groups so slow commands such as `apt-get` are not misclassified as stuck and orphaned.
  - Return from `exec_command` after the shell process exits even if a background child keeps stdio open, then release child handles so the CLI can exit while the background service keeps running.
  - Report failed background launches from stderr even when the parent shell exits `0`.
  - Warn when standalone shell state changes such as `export` or `cd` cannot persist to later tool calls.
  - Add output-cap guidance so models rerun noisy commands with narrower output.
  - Stream `read_file` windows from files larger than the byte cap instead of rejecting paged reads.
  - Fix Gemma native tool schema inference so action words like "directory to list" do not make `path` an `ARRAY`.
  - Repair Gemma delimiter leakage in single-string JSON tool calls, including native-style `<|"|>` string delimiters inside JSON wrappers.
- Verification after fixes:
  - `npm run build`
  - `npm test`
  - `npm test --workspace packages/core -- workspace.test.ts agent.test.ts modelProfiles.test.ts`
  - Repacked `/tmp/gemma-cli-core-0.1.2.tgz` and `/tmp/gemma-cli-0.1.2.tgz`

### Harbor Terminal-Bench Targeted Run 02

- Harness: `uvx harbor run` against `/tmp/harbor-tb-sample/terminal-bench-sample`
- Task filter: `--include-task-name configure-git-webserver`
- Agent: `bench.harbor.gemma_cli_agent:GemmaCliAgent`
- Model: `gemma4:26b` via local Ollama at `http://host.docker.internal:11434`
- Result: `/tmp/gemma-cli-harbor-jobs-11/gemma-cli-local-0.1.2-bg-detach-configure-git-webserver/result.json`
- Status: completed 1 trial in 2m46s; 0 exceptions; mean `1.000`
- Trust level: clean targeted smoke. No manual recovery was used.
- Finding from failed targeted run 01: `exec_command` returned promptly for `node /app/server.js &`, but the background service died after stdio closed, so the verifier could not reach port 8080.
- Runtime fix added before targeted run 02: `exec_command` now detects shell background operators and redirects background command stdio to temporary logs while the launching shell exits. This lets common background servers continue running without requiring the model to know `nohup`, while still capturing short startup output and stderr launch failures.
- Verification after the fix:
  - `npm test --workspace packages/core -- workspace.test.ts`
  - `npm test --workspace packages/core -- workspace.test.ts agent.test.ts modelProfiles.test.ts`
  - `npm run build`
  - Repacked `/tmp/gemma-cli-core-0.1.2.tgz` with shasum `142891553213640e3028819a2dcad539e1cd96e3`

### Apply Patch 26B Targeted Runs 01-03

- Date: 2026-05-05
- Model: `gemma4:26b`
- Targets:
  - `test-projects/apply-patch-26b-run01`
  - `test-projects/apply-patch-26b-run02`
  - `test-projects/apply-patch-26b-run03`
- Status: targeted investigation completed; runtime fix added for accidental patch renames
- Notes:
  - Run 01 mirrored a user black-hole app prompt in an empty folder. Gemma chose `write_file` for all files instead of `apply_patch`, then entered repeated scratch-content rewrites in `main.js`. This did not reproduce patch formatting failure, but confirmed that `write_file` remains the natural path for new files.
  - Run 02 forced an existing-file edit using `apply_patch`. Gemma spent a long time drafting messy patches in reasoning, including wrong paths, but the actual tool payload was clean: one multi-file unified diff with real newline-separated lines. The patch updated `package.json`, `src/main.js`, and `test/main.test.js`; `npm test` passed.
  - Run 03 forced stale context by changing `package.json` after Gemma read it. The first `apply_patch` payload was well-formed but failed with `apply_patch: hunk @@ -4 did not match in package.json`. Gemma followed the tool feedback, re-read `package.json`, and did not retry the same stale patch.
  - Run 03 then exposed a worse tool-design failure: Gemma's corrected patch used `+++ b/n/src/main.js` instead of `+++ b/src/main.js`. The old patcher treated this as a rename and wrote `n/src/main.js`, while leaving the original `src/main.js` in place. Gemma noticed the suspicious `renamed n/src/main.js` result and started inspecting, but the correction loop was slow and the run was stopped after enough evidence was collected.
  - Runtime fix added: `applyPatch` now rejects implicit renames from mismatched `---`/`+++` headers before applying any hunks, unless a future caller explicitly opts into renames. This converts the `b/n/src/main.js` typo into a clean model-facing error instead of a workspace mutation.
- Verification after the fix:
  - `npm run test --workspace gemma-cli-core -- src/tools/applyPatch.test.ts`
  - `npm run build`
  - `npm test`

### Managed Command Handoff Live Runs 01-02

- Date: 2026-05-05
- Model: `gemma4:26b`
- Status: targeted command-handoff validation passed
- Runtime fix under test:
  - `exec_command` returns a `commandId` for commands that keep running after producing output.
  - `wait_command` gives the model incremental output and final exit status without requiring the model to invent shell polling.
  - `cancel_command` stops still-running commands by `commandId`.
- Direct tool checks:
  - `npm run dev` with a minimal `node server.js` dev script returned `cmd_1`, included `Local: http://localhost:43210/`, and `cancel_command` stopped it.
  - A finite progress script returned `cmd_1`; repeated `wait_command` calls returned incremental `avg=22.0ms` through `avg=26.0ms` output and then `Command exited with 0`.
- Agent live runs:
  - Dev server run `790ef1ba`: Gemma created `test-projects/live-dev-handoff-run01`, ran `npm run dev --prefix ...`, received `commandId: cmd_1`, did not restart the server, and called `cancel_command` before the final answer.
  - Short progress run `22ed0812`: Gemma created `test-projects/live-progress-run01`; the script finished before the default 15s handoff, proving short finite commands still return normally.
  - Long progress run `cd2c6b36`: Gemma created `test-projects/live-progress-run02`, ran a 3-second interval progress script, received `commandId: cmd_1` after the 15s handoff with output through `avg=24.0ms`, called `wait_command`, received `avg=25.0ms`, `avg=26.0ms`, and `Command exited with 0`, then answered with the final average.
- Validation:
  - `npm test --workspace gemma-cli-core -- src/tools/workspace.test.ts`
  - `npm run build`
  - `npm test`
