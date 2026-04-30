# Gemma Desktop Agents Guide

This file is the soul of the monorepo and the single source of truth for agent guidance.

Compatibility entry files such as `CLAUDE.md` and `GEMINI.md` should only point agents back here. They should not duplicate policy, add separate rules, or imply preference for any particular agent.

## Identity

This repository is the shared home for the `Gemma Desktop` product family.

We are here to make open models more usable, more understandable, and more shippable.

## North Star

Build the best platform for developers who want to ship real software on top of open models, starting with local inference on macOS and growing outward from a strong foundation.

We are not trying to be a novelty wrapper around model APIs. We are trying to make open-model development feel durable, legible, and production-minded.

## Strategic Bet

Our core bet is that developers need more than a pleasant chat abstraction.

They need software that understands:

- the model
- the runtime
- the machine
- the protocol
- the failure modes
- the tradeoffs hiding behind "compatible"

`Gemma Desktop` should help people build with open models without pretending the edges do not exist.

## What We Believe

1. Local AI has many sharp edges, and pretending otherwise creates weak products.
2. Honest abstractions beat magical abstractions.
3. Good tooling should help a developer understand the system, not just call it.
4. Testability and observability are product features.
5. Documentation is part of the product, not an afterthought.
6. If the SDK and docs are strong, the app can be exceptional.

## Repo Shape

`GemmaDesktopSDK` is the foundation of this repository.

The SDK should make runtimes, model behavior, tooling, and failure modes more legible rather than hiding them behind pleasant but misleading abstractions.

Do not let app convenience bypass SDK contracts. If a behavior matters across runtimes, encode it in the SDK, test it in the SDK, and document it clearly.

`GemmaDesktopApp` should prove the SDK can power a polished end-user experience.

`gemmadesktop-cli` is the headless SDK parity harness for the same product behavior. It should make SDK-backed desktop features testable without building or launching Electron.

The projects in this repo should strengthen each other. None of them should become an excuse to bypass the SDK or skip the documentation work.

## Quality Bar

We should build things that are:

- transparent about what is happening
- readable during debugging
- useful for automation
- resilient to runtime differences
- realistic about hardware limits
- designed for long-term benchmarking and comparison
- maintainable under heavy iteration, not just impressive in the first draft
- easy to verify with static analysis, focused tests, and direct inspection
- explicit about assumptions, contracts, and failure modes

If we have to choose between flashy and trustworthy, we choose trustworthy.

## Documentation Stance

Our documentation should hold the reader's hand without talking down to them.

It should explain terminology, runtimes, hardware expectations, model tradeoffs, and inference-stack reality in a way that helps someone make good decisions. The docs should not just describe our products. They should help developers become sharper about local AI itself.

## Agent Instructions

Agents working in this repository should treat this file as a living record of the project's soul and strategy.

When the strategic direction sharpens, changes, or matures, update this file carefully so the history of what we believe and why stays coherent over time. Do not let `AGENTS.md` turn into a tactical dumping ground.

Keep tactical thoughts, implementation planning, architecture notes, and other execution detail in `../specs`, but only when those thoughts belong to tracked workstreams and that shared workspace folder exists.

Agents should optimize for long-term engineering speed, not short-term code volume.

This repository is greenfield. Prefer direct, clean fixes over backward-compatibility layers unless the user explicitly asks for compatibility support or a migration path.

### P0 SDK/Desktop/CLI Parity

`gemmadesktop-cli` parity is P0. When changing `GemmaDesktopApp` in a way that adds, removes, or materially changes SDK-backed behavior, update the headless CLI in the same change unless there is a concrete reason it cannot apply.

This includes runtime adapter wiring, session creation, mode and tool surfaces, request metadata, model/runtime defaults, research flows, attachment behavior, tool orchestration, debugging and trace output, and any SDK option the desktop app relies on.

Future agents must treat CLI coverage as part of the acceptance criteria for SDK-backed desktop changes:

- add or adjust CLI commands, flags, metadata wiring, or output when the desktop app gains new SDK-backed behavior
- add focused CLI tests that prove the headless path exercises the same SDK contract
- keep root validation wired so `npm run check` covers SDK, CLI, and app deterministic lanes
- if a desktop SDK change genuinely does not affect the CLI, say why in the work notes or final summary instead of leaving the parity decision implicit

### App Main-Process Architecture

`GemmaDesktopApp/src/main/ipc.ts` is an IPC composition edge, not the home for product behavior. The durable direction is to keep Electron channel registration thin and move domain behavior into named main-process modules with explicit dependencies.

Use this as the recommended template for new app-main work:

- put pure domain logic, normalization, persistence helpers, runtime orchestration, file processing, and tool implementations in dedicated modules named for the capability they own
- expose one small service factory when a module needs app-owned dependencies such as `GemmaDesktop`, live sessions, settings, windows, notification broadcasts, or model leases
- keep `registerIpcHandlers()` and future domain registrars focused on validation, calling a service method, and returning serializable data
- group related IPC channels behind domain registrars as they are extracted, for example sessions, environment/model lifecycle, browser, attachments/content, skills/memory, speech/read-aloud, automations, settings/notifications, workspace/files, sidebar/global chat
- preserve channel names and preload contracts unless the user explicitly asks for a public API change
- prefer typed dependency objects over importing shared mutable singletons into every module
- add architecture tests that protect ownership boundaries, public channel lists, prompt-section order, or service contracts; do not rely on arbitrary line-count limits as a substitute for design
- when moving behavior out of `ipc.ts`, do behavior-preserving extraction first, run targeted tests, then make any logic changes in a separate step

The new normal is that `ipc.ts` should read like a table of contents and integration layer. If a change needs a helper large enough to explain, test, cache, retry, stream progress, touch models, or coordinate state across turns, create or extend a domain module instead of nesting it inside an IPC handler.

When we name capabilities, we should be explicit about what kind of thing they are.

- direct tools should have direct task names and should do one concrete action immediately
- any capability that spins up another model session with its own context and tools should be named as an agent, not as a plain tool
- agent names should make that delegation obvious, and their descriptions should say they start a child session
- prompts, settings, docs, and UI labels should preserve that distinction instead of blurring it

### System Prompt Architecture

The system prompt is product infrastructure, not a scratchpad. Keep it structured, inspectable, and hard to accidentally degrade.

- preserve explicit section boundaries in composed prompts; SDK-owned sections should stay tagged by source, and app-owned additions should stay inside the app prompt context wrapper
- keep durable user memory quarantined as passive context at the end of app-owned prompt additions; never place memory between operational instructions, tool routing, or mode policy
- put stable behavioral policy in SDK prompt profiles, put dynamic tool-routing rules in SDK tool-context composition, and put desktop-app-only UI/tool notes in app prompt sections
- do not duplicate the same browser, search, file-editing, or action-bias rule across fallback prompts, mode prompts, and app prompts; move the rule to the narrowest layer that can decide it from active session state
- when adding a tool or delegated agent, update the prompt layer that names the capability so direct tools and child-session agents remain visibly distinct
- when changing prompt composition, add or update static prompt-design tests that validate section order, memory isolation, duplicate-line drift, and any new routing boundary
- when changing shipped prompt markdown, update snapshots intentionally and read the resulting prompt through the debug panel or snapshot output before considering the work done

That means:

- prefer designs that stay legible and maintainable as the codebase grows
- treat static analysis as part of the product quality bar, not optional polish
- tighten types, interfaces, and internal contracts when doing so makes the system easier to change safely
- check assumptions instead of leaving them implicit when they can be verified by code, docs, tests, or runtime evidence
- add tests when they protect meaningful behavior, catch regressions, or verify important contracts
- prefer narrow, high-signal tests over large numbers of brittle or low-value tests
- avoid test quantity for its own sake; we want confidence, not ceremonial coverage
- preserve room for fast iteration by favoring code that is straightforward to inspect, reason about, and verify
- when adding, removing, or materially changing shipped project dependencies, update any user-facing About or open-source credits inventory in the affected app so attribution stays accurate over time
- if a change affects shipped dependencies or user-visible attribution in consuming apps, make sure the app side stays in sync

When implementation details, runtime behavior, or API semantics need grounding in real-world examples, consult the local reference projects at `/Users/dmitrylyalin/Source/Reference_Projects` first. This library includes major open-source projects, including Ollama and its documentation, and should be treated as a preferred source of practical reference context.

When behavior depends on a real open model, prefer real-model validation on Ollama over mocks once focused unit coverage exists. Use **live tests** as the short name for validation that runs real models, real tools, real websites, real files, or real runtimes instead of mocks. Use **live scenario tests** for the user-shaped CLI/app scenarios where an agent runs the flow, reviews the evidence, and judges whether the outcome is genuinely useful. Separate short live tests from longer preflight suites so developers can run the smallest useful real-model check first.

Live scenario tests exist to expose real product behavior, not to reward brittle prompt hacks or validator gaming. When a real scenario fails, agents should respond in one of three ways:

- make a real product fix that improves the generic capability the scenario exercises
- make a real test-fixture or harness fix when the failure is in the scenario setup itself, such as a dead asset URL or non-deterministic local precondition
- report the capability gap plainly when the model, runtime, tool surface, or local environment cannot currently handle the scenario

Do not change a scenario, evaluator, prompt, or fixture to merely make a failing run look green. If a scenario reveals that a browser tool is missing from the CLI, a model cannot process a modality, a Go toolchain is unavailable, or a website blocks automation, record that honestly and either fix the product surface or preserve the failure as useful evidence.

## Test Discipline

Every meaningful change needs validation. Do not treat testing as optional cleanup after coding.

Use these two standard lanes by default:

- for a small or localized change, run the narrowest tests that directly cover the touched behavior, plus any nearby contract tests that would catch obvious fallout
- for a broad, risky, or cross-cutting change, run the full deterministic suite first, then run the full live suite when the change touches model behavior, runtime integration, research flows, session orchestration, or other user-visible end-to-end behavior

The standard commands are:

- minimal targeted validation: `npm --workspace GemmaDesktopSDK run test -- tests/<file>.test.ts`, `npm --workspace gemmadesktop-cli run test -- tests/<file>.test.ts`, or `npm --workspace GemmaDesktopApp run test -- tests/<file>.test.ts`
- full deterministic repo validation: `npm run check`
- full repo validation including live-model lanes: `npm run check:full`
- SDK deterministic suite only: `npm --workspace GemmaDesktopSDK run check`
- SDK full suite including live routing and live research: `npm --workspace GemmaDesktopSDK run check:full`
- CLI deterministic suite only: `npm --workspace gemmadesktop-cli run check`
- App deterministic suite only: `npm --workspace GemmaDesktopApp run check`
- App full suite including live research: `npm --workspace GemmaDesktopApp run check:full`
- App live research preflight: `npm --workspace GemmaDesktopApp run test:research-preflight`

Agents must also use judgment instead of matching tests mechanically to filenames.

- do not stop at the most obvious test file if the change crosses a boundary such as SDK to app, main to preload, preload to renderer, or storage to presentation
- run additional tests for the user journey you changed, not just the module you edited
- if you touch shared helpers, prompts, session state, tooling policy, research orchestration, or runtime adapters, expand coverage beyond the nearest unit test
- if a change could plausibly affect real-model behavior, prefer escalating into the live lanes instead of arguing that mock coverage is probably enough
- when in doubt, choose the stronger validation path

Helpful hints:

- tooling, runtimes, search, fetch, batching, research planner, and session engine changes usually need SDK tests first and often live SDK follow-up
- SDK-backed desktop behavior changes usually need matching CLI tests before app validation so the headless parity path stays useful
- IPC handlers, preload bridges, session persistence, app state orchestration, menu bar behavior, browser panels, and attachment flows usually need App tests and may also need the live app research lane when the user experience depends on real model output
- small UI-only changes can stay targeted if they are genuinely presentation-only, but once a UI change depends on state timing, IPC events, persistence, or approvals, treat it as integration-sensitive rather than cosmetic

The repo has local models available, so do not under-test major changes just to save runtime. Slow validation is preferable to shipping regressions in real app behavior.

Live scenario results require human review of the generated artifacts, not just a green process exit. When running live scenario tests, inspect the saved JSON, tool trace, final answer, evaluator notes, and any attachments or generated files against the scenario's actual goal. Report whether the run was practically useful, partially useful, or misleading, even if the automated evaluator passed.

## Git And GitHub Flow

This repository uses direct-to-`main` publishing by default.

When the user asks to commit, push, publish, or push to GitHub, interpret that as committing on the current `main` line and pushing `main` to `origin` unless the user explicitly asks for a branch or pull request.

Do not create feature branches, draft PRs, or review branches as a default safety workflow in this repo. Do not import a generic GitHub publishing flow from tools, skills, or other repositories if it conflicts with this rule.

If the user explicitly asks for a branch or PR, use the requested branch/PR flow. Otherwise, keep the direct-to-`main` path simple: inspect status, stage the intended files, commit, run the appropriate validation, and push `main`.

Working directly on `main` with multiple agents is the user's preferred flow in this repository. When the user asks to commit, push, publish, or push to GitHub and the worktree contains unrelated changes, do not stop just to ask which files to include. Stage only the changes you made to the best of your ability, including partial hunks when another agent has edited the same file, leave unrelated work unstaged, and report what remains outside the commit. Ask for clarification only when you cannot separate your changes safely or the requested operation would require destructive cleanup.

## Live Model Safety

Treat live-model cleanup as a hard safety requirement, not a nice-to-have. Loading multiple large Ollama models at once can destabilize or crash the machine.

- Main product work must use a main-capable model. General chat, Explore, Plan, and Act validation should use `gemma4:26b` or a stronger local model by default. Act/build-mode validation especially is high/xhigh work; do not use `gemma4:e2b`, `gemma4:e4b`, or other small helper-class models to judge whether Act behavior is good enough.
- Small/helper models are acceptable for explicitly helper-scoped tasks such as summarization, labels, low-risk descriptions, or narrow auxiliary checks. They are not acceptable for validating main activity, SDK-backed desktop behavior, or CLI parity behavior unless the user explicitly asks to test that lower-model path.
- If a live regression, CLI scenario, or behavior investigation accidentally runs on a helper-class model, rerun the meaningful validation on `gemma4:26b` or stronger before drawing conclusions.
- any test that loads or relies on a real Ollama model must use explicit lifecycle control and must unload that model in `finally`, `afterEach`, or `afterAll`
- never rely on process exit, worker shutdown, or Ollama idle eviction as cleanup
- prefer exclusive live-test execution or another guard that prevents multiple heavy live-model tests from overlapping
- if another Ollama model is already resident, resolve that intentionally before starting another heavy live-model test
- assume live-model tests may need to unload a model that was already warm; do not run them casually alongside other local inference work
- oMLX live validation can use the OpenAI-compatible API key saved in Gemma Desktop app settings. When a local run needs it, read it from `~/Library/Application Support/Gemma Desktop/settings.json` or pass it through `GEMMA_DESKTOP_OMLX_API_KEY`, but never print, hard-code, or commit the secret.

## User-Curated Data Safety

Two things inside Gemma Desktop are hand-curated by the user and must never be deleted, moved, or wiped by an agent as part of a reset, cleanup, test-prep, `rm -rf`, "reinstall clean", or "start clean" flow:

1. **User memory** — the `memory.md` file inside Gemma Desktop's Electron userData directory, surfaced through the in-app Memory panel. Long-lived personal notes the user built up by hand.
2. **Installed skills** — the `skills/` directory inside that same userData directory, surfaced through the app's Skills modal. Installing and removing skills is a manual user action; agents do not add or remove them on the user's behalf. Skill folders managed by other developer tools are also user-owned and must not be removed during cleanup.

Settings, conversations, sessions, caches, and other generated state are fair game to wipe when the user asks to reset things. Memory and skills are not. If a reset procedure would touch either directly, transitively, or by removing a parent directory that contains them, stop and require the user to manage those items manually from the in-app Memory panel and Skills modal. When in doubt, ask before deleting anything under the userData directory or the skills roots above.

## App-Specific Note

When diagnosing `GemmaDesktopApp` session state after the recent storage change, do not assume sessions are stored in one global `.gemma` directory. The app keeps a global list of open projects in application state, but each project's actual session data lives inside that project's hidden `.gemma/session-state` directory. In practice, inspect the global application state to find the relevant project path first, then open that project's `.gemma/session-state` folder when tracing or debugging a session.

### Global Assistant Chat Diagnostics

Assistant Home, Welcome Chat, the right-dock Assistant Chat, and menu-bar Assistant Chat can all point at the app-global Assistant Chat surface. Do not debug these as normal project sessions unless the global chat target is explicitly assigned to a project session.

For the built-in fallback Assistant Chat, the session id is `talk-assistant` and the persisted state lives under Electron `userData`, not a project `.gemma` folder:

- macOS default: `~/Library/Application Support/Gemma Desktop/global-session-state/talk/session.json`
- code path: `getTalkSessionFilePath(app.getPath('userData'))`
- workspace path: `~/Library/Application Support/Gemma Desktop/global-session-state/talk/workspace`

When diagnosing confusing Assistant Chat or CoBrowse behavior, inspect this JSON read-only first. The highest-signal fields are:

- `appMessages` for the visible conversation turns
- `debugLogs` for IPC events, duplicate send attempts, cancellations, hidden resume turns, tool calls, and runtime activity
- `pendingTurn` for a turn that was still active when the app crashed, reloaded, or was stopped
- `snapshot.metadata` and `snapshot.history` for session metadata and SDK-visible history

Helpful quick inspection pattern:

```sh
node -e 'const fs=require("fs"); const p=process.env.HOME+"/Library/Application Support/Gemma Desktop/global-session-state/talk/session.json"; const s=JSON.parse(fs.readFileSync(p,"utf8")); console.log({id:s.meta?.id,lastMessage:s.meta?.lastMessage,messages:s.appMessages?.length,debugLogs:s.debugLogs?.length,pendingTurn:Boolean(s.pendingTurn)});'
```

For CoBrowse bugs, correlate UI symptoms with both `appMessages` and `debugLogs`. A visible assistant turn without a neighboring visible user message may have been triggered by `sendHiddenInstruction` / CoBrowse resume. If the browser jumps to an old topic, look for a hidden resume turn that reused stale context, a queued message draining after a control handoff, or assistant-heartbeat "missing completion" recovery continuing an old turn.

Queued messages in the renderer (`globalQueuedMessages` and `queuedMessagesBySession`) are in-memory UI state, not the source of truth in `session.json`. The persisted evidence is usually the resulting `sessions.send-message.request`, `sessions.talk.send-message.request`, `session.event.user_message`, `generation_started`, `generation_cancelled`, and `turn_complete` entries in `debugLogs`.

Do not delete or rewrite `global-session-state/talk/session.json` during diagnosis unless the user explicitly asks to reset Assistant Chat. This file is not the curated memory file, but it is still the user's conversation history and often the only durable evidence for timing-sensitive bugs.

### Browser And Search Surfaces

Gemma Desktop has several browser-like and web-access surfaces. Keep their names and roles precise so future changes do not blur the product behavior:

- `fetch_url` is not a browser. It is the default direct read path for one known, readable public URL or endpoint that does not need clicks, typing, login, or JavaScript-driven interaction. If it returns mostly loaders, placeholders, or a thin app shell, escalate to an actual browser surface instead of retrying the same fetch shape.
- `search_web` is the only generic web search tool name the model should see. Outside CoBrowse, it must use Gemini API search with Google Search grounding. In CoBrowse only, the same `search_web` tool name must open Google Search in the visible Project Browser. Do not expose both grounded search and browser-backed Google search as separate choices in the same turn.
- `browser` is the managed browser tool used for deeper scripted website interaction: complex pages, navigation flows, dynamic content, trackers, and pages where fetch is not enough. It is not the visible Project Browser and must not be available during CoBrowse.
- `chrome_devtools` controls the user's live Chrome session for advanced debugging, console/network inspection, screenshots, page evaluation, and targeted Chrome tab interaction. It is only available when Chrome DevTools support is enabled in settings and selected for the session; mutating actions may require explicit approval.
- Project Browser is the visible in-app Electron browser surfaced in Work mode and in Assistant Home CoBrowse. Current code allows agent navigation to `http` and `https` URLs, including localhost and external sites. In Work mode it is primarily for visible app/web verification. In CoBrowse it becomes the human-assisted browser surface.

CoBrowse is special and should stay mode-enforced, not prompt-enforced by convention:

- CoBrowse search must use `search_web`, and that tool must route to real Google Search in the visible Project Browser. Possible bot detection, CAPTCHA, login, 2FA, payment, or permission prompts are expected; the point of CoBrowse is that the user can complete those browser-side steps and then resume.
- Outside CoBrowse, search must remain grounded Gemini API search. The model should never get to choose between grounded search and browser-backed Google search.
- During CoBrowse, all browsing and page interaction must use the visible Project Browser tools: `open_project_browser`, `search_project_browser_dom`, and `get_project_browser_errors`. The managed `browser`, `fetch_url`, `web_research_agent`, and `chrome_devtools` surfaces must be removed from the active tool surface.
- Do not infer CoBrowse from Project Browser having a `sessionId`; normal Work-mode Project Browser opens also have session ownership. Treat `ProjectBrowserState.coBrowseActive` and CoBrowse session metadata as the source of truth.
- CoBrowse tool availability and instructions belong in system-level session composition, not user-visible prompt text. Route tools dynamically from session mode and metadata, and cover the routing with focused tests.
- If a future feature changes any of these surfaces, update the tool routing, system instructions, tests, and this section together so the distinction remains durable.

## Multi-Agent Coordination

Multiple coding agents may work in this repository at the same time.

Before making changes, look for a `hey.md` file in the repo root and read it first.

When `hey.md` exists, use it as the shared coordination board for active agents. Leave short notes about what you are touching, what you are investigating, and any files or areas other agents should avoid so work does not conflict.

If parallel work starts and `hey.md` does not exist yet, create it and keep the notes brief, concrete, and current.

When you finish, delete `hey.md` only if you are confident you are the last active agent in the repo. If you are not sure, leave it in place and tell the user it still needs cleanup after the remaining agents finish.

Before creating additional Markdown files beyond the ones already present in this repo, ask for permission first.
