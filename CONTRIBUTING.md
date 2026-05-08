# Contributing to Gemma Desktop

Thanks for wanting to help. Gemma Desktop is an alpha, source-first project, so the best contributions are small, well-verified changes that make local open-model work more legible and reliable.

Before changing code, read [AGENTS.md](AGENTS.md). It is the repository's source of truth for product direction, quality expectations, validation, and SDK/App/CLI parity.

## Development Setup

Prerequisites:

- Node.js and npm
- macOS for the desktop app path
- A local model runtime for live checks; Ollama is the default

Install dependencies from the repository root:

```bash
npm install
```

Run the app in development:

```bash
npm run dev
```

For live model work, start Ollama and install an appropriate model first:

```bash
ollama pull gemma4:26b
```

Use helper-class models only for helper-scoped behavior. For main assistant, build, runtime, CLI parity, or end-to-end validation, use `gemma4:26b` or stronger unless a change is explicitly about a smaller model path.

## Repository Shape

- `GemmaDesktopSDK/` contains the SDK contracts, runtime adapters, tools, prompts, sessions, and tests.
- `GemmaDesktopApp/` contains the Electron and React desktop app.
- `gemmadesktop-cli/` contains the headless parity harness for SDK-backed desktop behavior.

The SDK is the foundation. If a desktop change adds, removes, or materially changes SDK-backed behavior, update the CLI path in the same contribution or explain why the CLI is unaffected.

## Validation

Run the narrowest useful checks while developing, then choose the final validation lane based on risk.

Targeted examples:

```bash
npm --workspace GemmaDesktopSDK run test -- tests/<file>.test.ts
npm --workspace gemmadesktop-cli run test -- tests/<file>.test.ts
npm --workspace GemmaDesktopApp run test -- tests/<file>.test.ts
```

Full deterministic validation:

```bash
npm run check
```

Full validation including live model lanes:

```bash
npm run check:full
```

Use the live lanes when changes touch model behavior, runtime integration, research flows, session orchestration, or other user-visible end-to-end behavior. Any live test that loads real Ollama models must clean them up explicitly.

## Good First Contributions

Good starter patches usually improve one of these areas:

- Documentation that clarifies setup, runtime expectations, or validation.
- Focused tests around existing behavior.
- Small SDK, CLI, or app fixes with clear acceptance criteria.
- Developer-experience improvements that keep `npm run check` reliable.

Avoid broad refactors, dependency churn, or UI rewrites as first patches. The project is moving quickly, and narrow changes are easier to review and verify.

## Safety And Licensing

This repository currently does not grant a license unless one is added later. Do not copy code, assets, model files, voices, or documentation from other projects unless their license permits it and attribution is updated where needed.

Gemma Desktop can read files, run commands, automate browsers, and invoke local model runtimes. Treat untrusted files, web pages, PDFs, images, and prompts as potentially hostile input when designing or testing changes.
