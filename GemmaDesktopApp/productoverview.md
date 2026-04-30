# Gemma Desktop Product Overview

Inspection snapshot: April 16, 2026

Scope:

- Primary focus: `GemmaDesktopApp`
- Extended scope: sibling `../GemmaDesktopSDK`
- Source basis: repo source, tests, scripts, package manifests, `../specs`

Interpretation rules used in this document:

- "Implemented" means present in checked-in code in `GemmaDesktopApp` and/or `GemmaDesktopSDK`.
- "Spec direction" means declared in `../specs` and useful for product context, but not necessarily fully shipped.
- When behavior depends on runtime discovery, the app can surface more models than the curated defaults.

## 1. Executive Snapshot

`GemmaDesktopApp` is not just a local-model chat window. It is an Electron desktop shell for a local-first AI workbench built on `GemmaDesktopSDK`, with explicit support for:

- normal conversations
- research conversations
- a separate talk/side-chat lane
- tool-governed explore vs build work modes
- plan mode overlays
- local model and runtime inspection
- session persistence per project
- local multimodal attachments
- shell/process execution
- browser and devtools-style integrations
- speech input and read-aloud output
- automations
- skills installation and activation

`GemmaDesktopSDK` is the actual backend platform underneath that experience. It provides:

- runtime adapters
- capability-aware model inspection
- session orchestration
- tool execution
- delegated worker-agent tools
- research orchestration
- prompt composition
- event streams, traces, and snapshots
- harness support for tests and benchmarks

This repo is already fairly large:

- `GemmaDesktopApp`: 137 files under `src`, 65 test files, about 285 test cases
- `GemmaDesktopSDK`: 7 workspace packages, 134 files under `packages`, 35 test files, about 122 test cases

## 2. What GemmaDesktopApp Is Right Now

At a product level, `GemmaDesktopApp` currently looks like a local desktop AI assistant for developers that tries to expose machine reality instead of hiding it.

Core identity visible in code and specs:

- local-first session storage
- runtime-aware model selection
- explicit tool policy
- observable tool usage and live activity
- machine inspection and troubleshooting
- honest support for local runtimes instead of pretending they are interchangeable

Technically, the app is:

- Electron main process for orchestration, system integrations, storage, tool gating, and SDK access
- React renderer for the UI
- typed preload bridge for renderer-to-main IPC
- `GemmaDesktopSDK` for runtime inspection, sessions, tool runtime, research, and tracing

## 3. End-User Feature Inventory

### 3.1 Session And Sidebar Features

Implemented session management features include:

- session list and active session selection
- create, update, rename, delete, and clear-history flows
- draft text persistence per session
- sidebar open/close state
- pinned sessions
- follow-up flagging
- pinned-session reordering
- project-level grouping via working directories
- project close/reopen state in the sidebar
- per-session running background-process summaries

Session metadata tracked in app types includes:

- title and title source
- runtime ID
- model ID
- conversation kind
- work mode
- plan mode
- selected skills
- selected session tools
- working directory
- timestamps
- generating/compacting state

### 3.2 Conversation Surfaces

There are three distinct conversation surfaces:

- normal conversations
- research conversations
- talk conversations

Normal conversations are the default main-chat workflow.

Research conversations are a separate lane with their own creation flow and run pipeline. They are not just a prompt template; the app and SDK both have research-specific orchestration.

Talk is a separate assistant lane with its own session ID, global storage scope, docked/overlay presentation, simplified controls, and independent message history.

### 3.3 Work Modes And Planning

The app has two main work modes:

- `explore`
- `build`

The SDK equivalents are:

- `cowork`
- `build`

Plan mode is an overlay on top of conversations, not a standalone product.

Plan mode behavior includes:

- read-only tool surface
- structured plan questions
- explicit exit/handoff flow
- prevention of build-only tools during planning
- pending plan exit state
- plan question cards and plan execution cards in the renderer

### 3.4 Chat Rendering And Message Types

The message system supports far more than plain text. Renderer message content types include:

- plain text
- images
- PDFs
- audio
- video
- thinking blocks
- fenced code blocks
- diffs
- file excerpts
- tool call blocks
- errors
- warnings
- shell session blocks
- folder links

Visible UX features implied by components and state handling:

- streaming assistant content
- streamed thinking visibility controls
- tool progress entries and worker detail timelines
- inline tool approval cards
- read-aloud actions on assistant messages
- code and diff presentation
- live activity indicators
- pending compaction indicators

### 3.5 Input And Composer Features

Implemented or strongly evidenced composer capabilities:

- multi-line text composition
- `Enter` vs `Shift+Enter` behavior in settings
- attachment composition
- camera capture modal
- speech composer control
- tool selector
- model selector
- conversation mode toolbar
- working-directory switching
- quote pinning from assistant text into the next prompt
- queued messages while a session is busy
- direct shell command launching from a session

### 3.6 Right-Dock And Workspace Features

The app has a substantial right-dock architecture. Current panels/components show support for:

- Git workspace panel
- Files workspace panel
- research setup panel
- automations panel
- doctor panel
- project browser panel
- talk panel
- shell-oriented right-dock chrome

Workspace-related behavior includes:

- local workspace inspection
- repo tree inspection with ignored/build-folder collapsing
- Git status inspection
- workspace change watching
- inference of working directory from absolute paths mentioned in chat

### 3.7 Background Processes And Shell Sessions

The app distinguishes two shell/process concepts:

- inline shell sessions
- background processes

Shell session support includes:

- PTY-backed command execution through `node-pty`
- transcript capture
- transcript truncation and peek/tail behavior
- resize/write/close operations
- exited/killed/error/interrupted states

Background process tools are explicit shared tool names:

- `start_background_process`
- `peek_background_process`
- `terminate_background_process`

These are Build-only tools and are intended for:

- dev servers
- watchers
- long-running local tasks
- download or install style jobs

### 3.8 Browser, Testing, And Devtools Features

There are two separate browser-related features.

`Chrome DevTools` session tool:

- wrapped as a session-scoped optional tool
- uses `chrome-devtools-mcp@0.21.0`
- exposed as a single `browser` tool in the conversation layer

Supported browser actions in the wrapper:

- tabs
- focus
- open
- navigate
- wait
- snapshot
- screenshot
- console
- network
- click
- fill
- type
- press
- close
- dialog
- evaluate

Project Browser:

- distinct embedded browser managed by `ProjectBrowserManager`
- restricted to localhost URLs only
- intended for local dev/testing
- tracks console errors
- can search DOM content
- stores recent console errors

Project browser tool names:

- `open_project_browser`
- `search_project_browser_dom`
- `get_project_browser_errors`

### 3.9 Research Features

Research is a first-class feature, not a cosmetic prompt mode.

App-side research features include:

- dedicated research conversation creation panel
- working-directory selection for research
- separate conversation kind
- dedicated live-activity presentation
- research result presentation helpers

SDK-side research runner features include:

- `quick` and `deep` research profiles
- multi-stage execution
- planning stage
- discovery stage
- topic worker stage
- synthesis stage
- artifact directory output under `.gemma/research`
- status callbacks
- topic plans and dossiers
- source tracking
- coverage tracking
- confidence reporting

Research task types currently modeled in SDK types:

- `news-sweep`
- `comparison`
- `catalog-status`
- `validation-explainer`

Research source families currently modeled:

- `mainstream_front_page`
- `mainstream_article`
- `wire`
- `official`
- `community`
- `reference_github_docs`

### 3.10 Speech Input

Speech input is a built-in local feature, not a browser Web Speech wrapper.

Implemented speech stack:

- provider: `managed-whisper-cpp`
- model: `large-v3-turbo-q5_0`
- chunked audio transcription pipeline
- transcript merging across chunks
- hallucination filtering heuristics
- queue-based speech sessions
- status, transcript, chunk, and error events
- runtime install/repair/remove flows

Speech-specific product behaviors visible in code:

- microphone permission support
- runtime health inspection
- install location and disk usage tracking
- busy/install/repair state reporting
- Silero-style signal heuristics reflected in transcript filtering logic

### 3.11 Read Aloud

Read-aloud is a separate local voice-output subsystem.

Implemented stack:

- provider: `kokoro-js`
- model: `Kokoro-82M-v1.0-ONNX`
- dtype: `q8`
- backend: CPU
- sample rate: 24 kHz
- output caching
- preview/test phrase
- asset manifesting and validation
- bundled-asset detection with on-demand download fallback

Voices currently surfaced:

- `af_heart`
- `af_bella`
- `am_michael`
- `bf_emma`
- `bm_george`

### 3.12 Skills

The app has a real skill system.

Implemented skill capabilities include:

- installed-skill discovery in Gemma Desktop's app-managed skill root
- skill catalog search
- installation and removal
- activation IDs
- token estimation
- frontmatter parsing
- context bundling for active skills
- catalog installs copied into the app-managed skill root

The skill loader recognizes text/code/config formats such as:

- Markdown
- text
- JSON
- YAML
- TOML
- TypeScript and JavaScript
- Python
- shell scripts
- SQL
- CSS

### 3.13 Automations

Automations are a persisted product surface, not just a hidden task runner.

Implemented automation features include:

- list/get/create/update/delete
- manual run
- scheduled run
- run cancellation
- automation logs
- persistent JSON storage under user data
- next-run computation
- run history retention

Supported schedule kinds:

- one-time run at a timestamp
- interval runs in minutes, hours, or days

Automation records include:

- prompt
- runtime/model
- work mode
- selected skills
- working directory
- enablement state
- schedule
- next run
- run history

### 3.14 Environment Inspection And Doctoring

The app includes a large environment and troubleshooting surface.

Doctor report coverage includes:

- app version info
- machine profile
- Node/npm/npx checks
- runtime availability
- model inventory summaries
- permission checks
- Chrome MCP integration health
- speech health
- read-aloud health
- issue aggregation with severity levels

Permissions covered:

- screen
- camera
- microphone

### 3.15 Notifications

Notifications are modeled as a first-class settings and activation system.

Implemented capabilities include:

- enable/disable notifications
- separate categories for automation finished, action required, and session completed
- permission prompt state handling
- in-app permission request flow
- activation targets back into app views
- test notification sending

### 3.16 Attachments And Multimodality

The app tracks four attachment kinds:

- image
- audio
- video
- PDF

Important implemented behavior:

- image attachments can come from files or camera capture
- audio attachments can carry normalized media type and duration
- video attachments can carry sampled frames and thumbnails
- PDFs can be inspected, rendered to images, previewed, batched, and summarized

The app does capability-aware attachment support rather than assuming all models can accept everything.

Current rules:

- image support derives from model capability records
- audio support derives from model capability records
- video support is treated as image-dependent because videos are sampled into frames
- PDF support is resolved separately through PDF conversion and worker availability

## 4. Models, Runtimes, And Default Behavior

### 4.1 Guided Model Experience

The guided default experience is explicitly centered on Gemma 4 over Ollama.

Curated Gemma catalog entries:

| Model | Tag | Tier | Badges |
| --- | --- | --- | --- |
| Gemma 4 E2B | `gemma4:e2b` | Low | Text, Vision, Audio, Thinking, Tools, 128K |
| Gemma 4 E4B | `gemma4:e4b` | Medium | Text, Vision, Audio, Thinking, Tools, 128K |
| Gemma 4 26B | `gemma4:26b` | High | Text, Vision, Thinking, Tools, 256K, MoE |
| Gemma 4 31B | `gemma4:31b` | Extra High | Text, Vision, Thinking, Tools, 256K, Dense |

Default model targets in code:

- explore default primary model: `gemma4:26b`
- build default primary model: `gemma4:26b`
- research default model: `gemma4:26b`
- helper/bootstrap model: `gemma4:e2b`

The app can still surface non-Gemma models discovered from runtimes through the fallback model lists.

### 4.2 Supported Runtime Adapters In GemmaDesktopSDK

`GemmaDesktopSDK` currently creates these adapters by default:

- `ollama-native`
- `ollama-openai`
- `lmstudio-native`
- `lmstudio-openai`
- `llamacpp-server`

Default endpoint settings in the app:

- Ollama: `http://127.0.0.1:11434`
- LM Studio: `http://127.0.0.1:1234`
- llama.cpp: `http://127.0.0.1:8080`

### 4.3 Runtime Capability Shape

The SDK is capability-aware. It models capabilities across scopes such as:

- runtime
- model
- loaded instance
- request
- server session

Examples visible in code:

- chat support
- streaming
- embeddings
- structured output
- tool calling
- reasoning control
- runtime list/download/load/unload
- stateful server chat
- multimodal input

### 4.4 Bootstrap Behavior

`GemmaDesktopApp` has an explicit Ollama bootstrap path.

Startup environment inspection is read-only: it reports detected runtimes, visible models, and current bootstrap state without pulling models. The bootstrap path only performs model preparation after an explicit retry, a saved-model warmup, or a guided download action.

When invoked explicitly, bootstrap can:

- check Ollama reachability
- try to launch the Ollama app
- fall back to `ollama serve`
- check for required guided model tags
- pull missing models for the chosen target
- load the helper model
- report bootstrap progress back to the renderer

### 4.5 Reasoning Control

Reasoning settings are modeled per model ID with modes:

- `auto`
- `on`
- `off`

The current hard-coded reasoning-control support rule is narrow:

- supported for guided Gemma tags on `ollama-native`

## 5. Tooling Surface

### 5.1 Default Tool Policy By Mode

Default Explore-mode tools:

- `list_tree`
- `search_paths`
- `search_text`
- `read_file`
- `read_files`
- `fetch_url`
- `search_web`
- `workspace_inspector_agent`
- `workspace_search_agent`
- `web_research_agent`
- `activate_skill`

Default Build-mode tools:

- all Explore tools
- `write_file`
- `edit_file`
- `exec_command`
- `workspace_editor_agent`
- `workspace_command_agent`

### 5.2 Core Direct Tools From GemmaDesktopSDK

Host/direct tools registered in the SDK:

- `list_tree`
- `search_paths`
- `search_text`
- `read_file`
- `read_files`
- `write_file`
- `edit_file`
- `exec_command`
- `fetch_url`
- `fetch_url_safe`
- `search_web`

What these tools imply:

- repo-aware shallow tree listing
- recursive path discovery
- ripgrep-based text search
- paginated file reads
- batch file reads
- direct file creation/overwrite
- exact-text patching with stale-target reconciliation
- direct shell execution with timeouts
- browser-like fetch and readable extraction
- No-key HTML web search across Google and Bing with auto fallback

### 5.3 Delegated Agent Tools From GemmaDesktopSDK

Delegated tools start child model sessions and are intentionally named as agents:

- `workspace_inspector_agent`
- `workspace_search_agent`
- `workspace_editor_agent`
- `workspace_command_agent`
- `web_research_agent`

These delegated tools can:

- inspect or search the workspace in a child session
- synthesize broader repository findings
- return file writes and apply them
- decide shell commands and then execute them
- perform multi-step web research with cited source lists

### 5.4 App-Level Session Tools

App-defined optional session-scoped tools:

- Chrome DevTools
- Ask Gemini
- macOS Screenshots

Mapped tool names:

- Chrome DevTools -> `browser`
- Ask Gemini -> `ask_gemini`
- macOS Screenshots -> `list_macos_windows`, `take_macos_screenshot`

### 5.5 App-Level Special Tooling

Additional app-specific tool surfaces include:

- `ask_user`
- `exit_plan_mode`
- legacy planning aliases
- background-process tool names
- project-browser tool names

There is also tool-approval plumbing for:

- Chrome mutating actions
- session-scoped optional tools
- blocked tools in restricted modes

## 6. Persistence And Local Storage

The app is strongly local-storage oriented.

Key storage locations and rules:

- per-project session state lives in `<project>/.gemma/session-state`
- per-project research artifacts live in `<project>/.gemma/research`
- per-session attachments/assets live under session-specific `assets` directories
- the sidebar keeps a global list of open/closed project roots
- the global talk session lives under app user data in `global-session-state/talk`
- automations persist under app user data in `automations`

Important repo guidance also confirms:

- sessions are not stored in one single global `.gemma` folder
- each project's actual session data lives inside that project

Persistence-related features implemented in code:

- session snapshot save/resume
- session artifact relocation when working directory changes
- path rewriting for persisted asset references
- cleanup helpers for deleting session artifacts

## 7. Renderer/Main-Process Architecture

### 7.1 Preload Bridge Categories

The typed preload bridge currently exposes at least these capability groups:

- `sidebar`
- `sessions`
- `environment`
- `doctor`
- `system`
- `events`
- `browser`
- `talk`
- `settings`
- `notifications`
- `skills`
- `folders`
- `terminals`
- `attachments`
- `workspace`
- `files`
- `links`
- `clipboard`
- `media`
- `speech`
- `readAloud`
- `plan`
- `automations`
- `debug`

### 7.2 Main-Process Responsibilities

The Electron main process handles:

- creating and configuring the `Gemma Desktop` SDK instance
- session lifecycle and persistence
- bootstrap/model loading behavior
- tool permission policy
- IPC handlers
- browser integrations
- shell sessions and PTY management
- speech/read-aloud runtime services
- notifications
- doctor reports
- automations
- workspace watching

### 7.3 Prompt Layering

Prompt assets bundled in the app include:

- `baseline.md`
- `assistant.md`
- `explore.md`
- `act.md`
- `plan.md`

Current prompt loading behavior:

- baseline prompt is always present for app chat system instructions
- a mode-specific prompt can be layered on top for `assistant`, `explore`, or `act`
- the planning prompt is composed from `baseline.md` plus `plan.md` with tool-name substitutions
- the SDK then adds its own fallback/model/environment/tool-context/mode layers around the app custom prompt

## 8. GemmaDesktopSDK Deep Overview

### 8.1 SDK Package Map

The sibling SDK workspace currently contains 7 packages:

| Package | Purpose |
| --- | --- |
| `@gemma-desktop/sdk-core` | shared runtime/session/event/trace/prompt contracts |
| `@gemma-desktop/sdk-harness` | scenario runner and benchmark harness |
| `@gemma-desktop/sdk-node` | high-level Node entry point, session factory, research runner, PDF helpers |
| `@gemma-desktop/sdk-runtime-ollama` | Ollama native and OpenAI-compatible adapters |
| `@gemma-desktop/sdk-runtime-lmstudio` | LM Studio native and OpenAI-compatible adapters |
| `@gemma-desktop/sdk-runtime-llamacpp` | llama.cpp server adapter |
| `@gemma-desktop/sdk-tools` | tool registry, permission policy, host tools, web and workspace tooling |

### 8.2 sdk-core

`sdk-core` defines the backbone:

- capability records
- attachment kinds
- content parts
- tool definitions and results
- structured output specs
- token usage
- session messages
- runtime adapters
- environment inspection
- mode selection
- session engine
- session compaction
- prompt composition
- event creation
- trace rendering
- shell command execution helpers
- build-mode validation helpers

Notable `sdk-core` product concepts:

- every important action emits events
- history compaction is an SDK feature
- build sessions track mutations and command executions
- post-edit verification can be summarized and enforced

### 8.3 sdk-tools

`sdk-tools` provides:

- tool registry
- tool runtime
- permission policy abstraction
- host tools
- web execution helpers
- workspace search backend
- batch/parallel host executor

Workspace tooling covers:

- tree listing
- path search
- text search
- single-file read
- batch file read

Web tooling covers:

- single-page fetch with readable extraction
- search result extraction
- feed/XML support
- safe-search and domain filters

### 8.4 sdk-node

`sdk-node` is the high-level SDK entry point used by the app.

It provides:

- `createGemmaDesktop()`
- `GemmaDesktop` class
- `GemmaDesktopSession` class
- default adapter registration
- default tool registry
- delegated-agent tool definitions
- environment inspection aggregation
- session creation/resume
- debug snapshot generation
- research runner access
- PDF inspection and rendering exports

### 8.5 sdk-harness

The harness package exists to support:

- defined scenarios
- session factory injection
- benchmark results
- scenario evaluation and classification

This is consistent with the product positioning in specs: app UX plus benchmark-grade backend traces.

### 8.6 Runtime Adapters

Ollama adapter family:

- native adapter
- OpenAI-compatible adapter
- capabilities for chat, streaming, embeddings, runtime listing, download, conditional load/unload, structured output, tool calling, reasoning control

LM Studio adapter family:

- native adapter
- OpenAI-compatible adapter
- native-path model metadata normalization
- loaded-instance handling
- conditional tool-calling support
- stateful-chat capability reporting

llama.cpp adapter:

- OpenAI-compatible chat/stream/embed path
- health check and model listing
- router-mode detection
- router-mode load/unload support

### 8.7 Research Runner

The SDK research runner is notably deep for an early product.

It includes:

- planning and topic decomposition
- concurrency controls
- topic workers
- search/fetch batching
- source normalization
- dossier generation
- synthesis pass
- status streaming
- artifact emission
- pass counts and coverage snapshots

### 8.8 Testing Posture In SDK

The SDK test suite covers areas such as:

- environment inspection
- delegated tools
- host tools
- session compaction
- build validation
- reasoning settings
- tool failure recovery
- image/audio/PDF input
- web tools
- live Ollama routing
- live Gemma research

## 9. Dependency Inventory

### 9.1 Direct Runtime Dependencies In GemmaDesktopApp

| Dependency | Version | Role |
| --- | --- | --- |
| `@gemma-desktop/sdk-core` | local workspace | core contracts from sibling SDK |
| `@gemma-desktop/sdk-harness` | local workspace | harness support |
| `@gemma-desktop/sdk-node` | local workspace | high-level SDK entry point |
| `@gemma-desktop/sdk-runtime-llamacpp` | local workspace | llama.cpp adapter |
| `@gemma-desktop/sdk-runtime-lmstudio` | local workspace | LM Studio adapters |
| `@gemma-desktop/sdk-runtime-ollama` | local workspace | Ollama adapters |
| `@gemma-desktop/sdk-tools` | local workspace | tool runtime and built-ins |
| `@huggingface/transformers` | `3.5.1` | read-aloud model loading and local inference helpers |
| `@modelcontextprotocol/sdk` | `1.29.0` | MCP client plumbing |
| `@xterm/addon-fit` | `0.11.0` | terminal fit behavior |
| `@xterm/xterm` | `6.0.0` | terminal UI |
| `highlight.js` | `11.11.1` | syntax highlighting |
| `kokoro-js` | `1.2.1` | offline voice synthesis |
| `lucide-react` | `0.475.0` | icons |
| `react` | `19.2.4` | renderer UI |
| `react-dom` | `19.2.4` | renderer UI DOM runtime |
| `react-markdown` | `9.1.0` | markdown rendering |
| `rehype-highlight` | `7.0.2` | code highlighting in markdown |
| `remark-gfm` | `4.0.1` | GFM markdown features |

### 9.2 Optional Native/Platform Dependencies In GemmaDesktopApp

Optional PTY/runtime dependencies:

- `@lydell/node-pty`
- platform-specific `@lydell/node-pty-*` prebuild packages

These enable terminal-backed shell sessions and background process support.

### 9.3 App Dev And Build Tooling

Important app dev/build dependencies:

- Electron
- electron-vite
- electron-builder
- TypeScript
- Vitest
- ESLint
- Tailwind CSS
- PostCSS
- `@vitejs/plugin-react`

### 9.4 Notable Upstream Runtime Dependencies Surfaced In About

The app’s About screen intentionally highlights user-visible and runtime-relevant upstream components rather than every transitive package.

Highlighted upstreams include:

- `whisper.cpp`
- OpenAI Whisper model family
- Silero VAD
- Kokoro 82M
- `kokoro-js`
- Transformers.js
- ONNX Runtime Node
- `phonemizer`
- Model Context Protocol SDK
- `@mozilla/readability`
- `got-scraping`
- `jsdom`
- `fast-xml-parser`
- `pdf-to-img`
- `chrome-devtools-mcp`
- macOS `screencapture`
- Electron
- React
- Tailwind CSS
- `lucide-react`
- `react-markdown`
- `remark-gfm`
- `rehype-highlight`
- `highlight.js`

### 9.5 Direct Dependencies Inside GemmaDesktopSDK Packages

SDK package-level direct dependencies:

- `sdk-harness` -> `@gemma-desktop/sdk-core`
- `sdk-node` -> core, harness, all runtime adapters, tools, `pdf-to-img`
- `sdk-runtime-llamacpp` -> `@gemma-desktop/sdk-core`
- `sdk-runtime-lmstudio` -> `@gemma-desktop/sdk-core`
- `sdk-runtime-ollama` -> `@gemma-desktop/sdk-core`
- `sdk-tools` -> `@gemma-desktop/sdk-core`, `@mozilla/readability`, `ajv`, `fast-xml-parser`, `got-scraping`, `jsdom`

SDK workspace dev dependencies:

- TypeScript
- Vitest
- ESLint
- `@types/node`
- `@types/jsdom`
- `fast-glob`
- `ajv`

## 10. Build, Test, And Packaging

### 10.1 App Scripts

Important `GemmaDesktopApp` scripts:

- `dev`
- `build`
- `preview`
- `check`
- `lint`
- `test`
- `typecheck`
- `prepare:read-aloud-assets`
- `pack`
- `dist`

Monorepo-specific behavior:

- `postinstall`, `predev`, `prebuild`, `pretest`, and `pretypecheck` all bootstrap/build the sibling SDK first

### 10.2 SDK Scripts

Important `GemmaDesktopSDK` scripts:

- `build`
- `build:no-check`
- `check`
- `lint`
- `typecheck`
- `typecheck:tests`
- `test`
- `test:ollama-live`
- `test:research-live`

### 10.3 Packaging

Packaging stack and behavior:

- `electron-builder`
- app ID: `com.gemmadesktop.app`
- mac targets: `dmg`, `zip`
- Windows target: `nsis`
- Linux targets: `AppImage`, `deb`
- read-aloud assets bundled through `.cache/read-aloud-assets`
- specific runtime assets unpacked from ASAR for `kokoro-js`, `phonemizer`, `onnxruntime-node`, and `node-pty` prebuilds
- packaging script explicitly compensates for monorepo "extraneous" runtime dependencies

### 10.4 Read-Aloud Asset Preparation

The repo includes a script that downloads and verifies pinned Kokoro ONNX assets from Hugging Face, writes a manifest, and stages them into `.cache/read-aloud-assets`.

### 10.5 Test Coverage Shape

Representative `GemmaDesktopApp` test areas:

- skills
- shell history and shell sessions
- notifications
- attachment support
- project browser
- research presentation and live research
- session persistence and path inference
- read aloud
- conversation process strip
- tool selector and mode toolbar
- Gemma install
- startup risk dialog
- speech service
- Chrome MCP
- doctor panel

Representative `GemmaDesktopSDK` test areas:

- environment inspection
- delegated tools
- host tools
- session compaction
- system prompts
- reasoning control
- LM Studio/Ollama behavior
- build validation
- web tools
- multimodal inputs
- live-model research

## 11. Spec Direction And Product Intent

The sibling specs add important context beyond what is already implemented.

### 11.1 GemmaDesktopApp V1 Direction From Specs

Spec framing says the app should be:

- one continuous surface for asking, building, and inspecting
- machine-aware
- transparent about memory, context, runtime, and failures
- local-first
- SDK-backed rather than bypassing SDK logic

The current codebase already reflects a lot of that direction:

- visible runtime/model/system state
- tool execution visibility
- multiple task lanes
- session-local and project-local persistence
- deep environment/doctor surfaces

### 11.2 GemmaDesktopSDK V1 Direction From Specs

The SDK spec positions `GemmaDesktopSDK` as:

- a dependency-light TypeScript SDK
- runtime-aware
- local-first
- useful for both app UX and automation
- explicit about capabilities and failure modes
- event-rich
- suitable for testing and benchmarks

The current package split and code strongly match that vision.

### 11.3 Important Non-Goals Called Out In Specs

Spec non-goals worth noting:

- no reliance on AI SDK as the core platform
- no magical normalization that hides runtime differences
- no hosted-service dependency for basic web tools
- no GUI-first shortcuts inside the SDK that bypass testable contracts

## 12. Bottom Line

`GemmaDesktopApp` already has the shape of a serious local-model desktop workbench rather than a thin chat shell. The codebase includes:

- a multi-lane conversation product
- runtime-aware model orchestration
- strong local tooling
- real multimodal ingestion
- speech input and voice output
- browser/testing integrations
- automations
- doctoring and environment awareness
- a meaningful SDK platform under the UI

`GemmaDesktopSDK` is not just a provider wrapper. It is already acting as:

- a runtime abstraction layer
- a session engine
- a tool runtime
- a delegated-worker framework
- a research engine
- a tracing and benchmark substrate

If you want, the next useful follow-up would be one of these:

- a feature matrix that separates "implemented", "partial", and "spec only"
- a dependency map grouped by runtime risk and packaging risk
- a user-facing product brief derived from this internal overview
