# Gemma CLI Feature Matrix

This file is the single feature tracker for the Gemma CLI MVP. Gemini CLI is the reference for feature categories and TUI expectations; Gemma CLI intentionally keeps the first product smaller, local-first, and easier to validate.

| Feature Area | Gemini CLI Baseline | Gemma CLI Target | Status |
| --- | --- | --- | --- |
| Package architecture | Multi-package Node/TypeScript workspace with CLI and core packages | Independent Node/TypeScript workspace with `packages/cli` and `packages/core` | Enabled |
| CLI entrypoint | `gemini` binary with interactive and non-interactive flows | `gemma` binary defaults to interactive TUI; `-p`/`--prompt`, scenarios, provider, model, and token-budget flags run headless | Enabled |
| Model provider: local | Gemini is hosted-first | Ollama provider targeting local Gemma models, defaulting to `gemma4:26b` | Enabled |
| Agent loop | Full agent runtime with model/tool coordination | Compact JSON action loop: answer or request one tool call per turn, including recovery for tool calls nested in local-model answer text | Enabled |
| Workspace file tools | Broad workspace tooling | `list_files`, `read_file`, and `write_file` stay workspace-bound and validate paths | Enabled |
| Read-only command tool | Safe shell-adjacent inspection commands | `run_command` remains allowlisted for harmless read-only commands like `pwd`, `ls`, `cat`, `rg`, `find`, `sed`, `node --version`, and `npm --version` | Enabled |
| First-class shell tool | Agent can run shell commands and surface stuck/interactive state | `shell_command` runs through the user shell, can modify workspace files, supports cancellation, uses idle-based stuck detection instead of hard long-running timeouts, and tells the user to rerun interactively with `! -i <command>` or `!!` | Enabled |
| TUI shell mode | Shell prompt, shell history, command approval and interactive handoff | `! <command>` runs one shell command from the TUI; `! -i <command>` attaches the terminal to an interactive command; `!!` repeats the last shell command interactively | Enabled |
| Stuck command handling | Long-running/interactive command detection and user handoff | Agent shell commands are stopped only after idle timeout or cancellation, avoiding false positives for long-running commands that keep producing output | Enabled |
| Cancellation | Escape/cancel support for in-flight work | Escape cancels the active agent/shell run; typing during a run stages the next input but does not submit until the current run ends | Enabled |
| Running indicator | Active work is visibly distinct | Ink TUI shows a spinner, running label, and status text that says Escape cancels and typing stages next input | Enabled |
| Coding tasks | Multi-step coding support | Can create/edit files through `write_file`, inspect files, run shell commands, and generate larger artifacts with `--max-tokens` | Enabled |
| Fixed scenario suite | Extensive integration/eval coverage | Fixed harmless scenarios: `script-generation`, `file-analysis`, `code-generation`, `workspace-search` | Enabled |
| App shell/chrome | Header, banner, sticky header, main content, footer, status rows | Ink-rendered terminal composition with logo, title/version, model/provider summary, open history area, separator, hint/status row, input row, and footer columns | Enabled |
| Conversation history | History manager, renderers per item type, pending items, show-more lines | In-memory typed history entries render as distinct cells for prompts, assistant output, thinking, tool summaries, shell output, commands, settings, and errors | Enabled |
| TUI agent execution | Interactive prompts run through the same tool-capable agent loop as headless prompts | Ink prompts call the agent runtime, surface tool calls/results in history, and can create or modify files instead of dumping implementation text back to the screen | Enabled |
| Streaming output | Stream hooks update history as chunks arrive | Provider streaming remains available in the runtime; Ink prompt execution prioritizes the tool-capable agent loop with visible running state, cancellation, and final/tool turn rendering | Partial |
| Markdown/code rendering | Assistant output preserves paragraphs, lists, and code blocks | TUI history wraps long lines while preserving newlines and lightly formatting headings, bullets, blockquotes, and fenced code blocks instead of flattening responses into one paragraph | Enabled |
| Thinking display | Thought summaries/loading indicator while model reasons | Ollama `message.thinking` chunks drive compact dim thinking summaries without dumping raw reasoning text | Enabled |
| Input bar | Rich prompt component with cursor handling, paste handling, suggestions, shell mode | Ink-owned input row with visible caret, placeholder text, Escape/Ctrl+U clearing, staged input while busy, and submit handling in the component | Enabled |
| Slash command registry | Built-in/user/workspace/extension/MCP/agent/skill command kinds | Fixed built-in command registry with names, parameter placeholders, descriptions, and insertion text | Enabled |
| Slash suggestions | Live popup suggestion rows with active item, descriptions, and parameter metadata | Live suggestion rows appear while typing `/`, filter against subcommands like `/settings m`, and show parameter hints for commands like `/settings maxTurns <n>` and `/run <command>` | Enabled |
| Slash autocomplete | Tab completion for slash commands and parameters | Tab completes command/subcommand prefixes and inserts parameter-ready forms where applicable, for example `/run ` and `/settings maxTurns ` | Enabled |
| Model selection | `/model` command and model dialog | `/model` lists Ollama models; `/model <name>` selects active model and updates chrome | Enabled |
| Settings | Settings dialog and settings command hooks | `/settings` shows provider/model/cwd/maxTurns/skills/history; `/settings maxTurns <n>` updates turn limit | Enabled |
| Stats | Session stats display and model stats display | `/stats` shows last-run model, turns, tool calls, duration; footer shows latest stats | Enabled |
| History scrolling | Batched scroll hooks, mouse support, animated scrollbar | Slash-command scrolling: `/scroll up`, `/scroll down`, `/scroll top`, `/scroll bottom` | Enabled |
| Resize handling | Responsive layouts recalculate available space and redraw cleanly | Ink TTY path listens for resize events, recomputes terminal dimensions, truncates rows to width, and switches to compact footer/status at narrow widths | Enabled |
| Skills display | Skill command and skill inbox UI | `/skills` lists loaded local skills; selected skills influence the agent prompt | Enabled |
| Shortcuts help | `?` or shortcut dialog with keybindings | `/help` and `/commands`; full keyboard shortcut overlay deferred | Partial |
| Themes/semantic colors | Theme dialog and semantic color palette | Fixed Ink color palette with dim text, magenta prompt, and blue/green logo accents | Partial |
| Authentication flows | OAuth/API-key flows and settings | Out of scope for MVP | Not enabled |
| Extensions/skills | Extension and skill loading | Local `.gemma/skills/*.md` or `.txt` skill loading, selectable with repeatable `--skill` | Minimal |
| ACP/A2A protocols | Agent Client Protocol and A2A server packages | Minimal JSONL stdio ACP bridge with `initialize`, `session/new`, `session/prompt`, `models/list`, and `skills/list`; A2A remains out of scope | Minimal |
| MCP support | MCP server/client integrations | Out of scope for MVP | Not enabled |
| Telemetry | OpenTelemetry and Google Cloud exporters | Out of scope for MVP | Not enabled |
| Sandbox containers | Docker/Podman sandbox support | Out of scope for MVP; local workspace boundary and command behavior are explicit instead | Not enabled |
| IDE integration | VS Code companion and related integrations | Out of scope for MVP | Not enabled |
| Tests | Unit, integration, eval, memory, perf tests | Focused tests for providers, agent loop, tools, scenarios, CLI args, TUI commands, shell command behavior, and deterministic TUI snapshots | Enabled |

MVP completion means the `gemma` CLI can run fixed scenarios, default into a usable Ink TUI, complete prompt-based coding/file-analysis tasks against local Ollama from either headless or TUI mode, and run shell commands with clear cancellation and interactive handoff paths.
