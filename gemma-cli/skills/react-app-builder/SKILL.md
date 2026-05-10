---
name: React App Builder
description: Use when building or changing React web apps, including Vite apps, dashboards, components, frontend tools, visualizers, and polished interactive UI.
---

# React App Builder

Use this skill when building or changing React web apps.

## Product Standard

- Build the actual app experience as the first screen unless the user explicitly asks for a landing page.
- Treat visual design, interaction design, responsive behavior, accessibility, and validation as core requirements, not optional polish.
- Make the app feel purpose-built for the domain. Pick a clear visual direction, then execute it consistently through layout, typography, color, motion, controls, and empty/loading/error states.
- Prefer dense, ergonomic operational UI for tools and dashboards. Prefer immersive, expressive, canvas/WebGL, or animation-heavy treatment for visualizers, games, and simulations.

## React Implementation Workflow

- For new React projects, prefer Vite with React unless the workspace already has a different React stack.
- Create complete package.json scripts for start/dev, build, and a meaningful validation path. Do not leave placeholder npm scripts.
- If the user asks for a validation script or validation command, add a real validate script to package.json and run it before finalizing.
- For anything beyond a tiny component, split the app into focused files such as App, state/data helpers, and domain components before writing large UI bodies. Keep each file and write_file payload small enough to complete reliably in one tool call.
- Do not put a whole non-trivial app into one large App.jsx/App.tsx file. Keep App as orchestration and move panels, editors, lists, controls, canvases, and cards into separate component files before they grow past a small, reviewable size.
- Keep components small enough to reason about, but do not split files just to appear architectural. Use local state first; add reducers or context only when the interaction complexity needs it.
- Prefer writing entry/config files and component shells first, then fill feature components one file at a time. Re-read nearby files before wiring imports if a prior write looked malformed or incomplete.
- When changing file extensions or replacing the main app file, inspect and update the actual entrypoint (`src/main.jsx`, `src/main.tsx`, etc.). Remove stale Vite starter App files/assets so the generated app is the one mounted in the browser.
- Do not let styling tooling block the app. Plain CSS with a strong visual system is acceptable for generated apps. If Tailwind setup or init fails once, write the needed config manually or switch to plain CSS instead of repeating setup commands.
- Keep setup commands short and purposeful. Avoid long shell chains when one failed subcommand would obscure what actually happened.
- Wire real controls and state changes. Buttons, sliders, toggles, filters, keyboard flows, tabs, forms, and menus should do useful work in the DOM.
- Do not add dead controls such as settings, export, sync, or account buttons unless they perform a real local action. Remove the control or implement it.
- Do not write placeholder copy, fake TODO branches, or comments saying a real app would do something later. Implement the usable version now or state the blocker.

## Look And Feel Rules

- Avoid generic AI-web defaults: purple-blue gradients, oversized marketing cards, one-note palettes, stock-like hero layouts, and walls of explanatory text.
- Choose distinctive type scale, spacing, surface treatment, and color contrast that match the app purpose. Use CSS variables to keep the visual system coherent.
- Use stable layout constraints for boards, toolbars, panels, canvases, cards, and controls so content does not jump or overlap across desktop and mobile.
- Use familiar controls: icon buttons for tools, tabs for views, segmented controls for modes, sliders/steppers/inputs for numeric values, toggles for binary settings, and menus for option sets.
- Include thoughtful micro-interactions where they clarify state, but never let animation hide broken layout or missing functionality.
- Ensure text fits its container, controls remain tappable on mobile, and the important product state is visible without reading instructions.

## React App Validation

- Run npm install when dependencies are added or package-lock/package.json needs to match.
- Run npm run build before claiming a React app is done. If the scaffold includes lint, run npm run lint and fix unused imports, dead state, dead handlers, and unreachable controls before finalizing.
- Add and run a focused validation/test script when behavior is complex, when the user requested validation, or when the repo has no tests.
- With modern Vite React scaffolds, import only the hooks and APIs used by each file. Do not keep a default React import unless the file actually references React.
- For non-trivial apps, validate after each focused slice or small group of files before continuing. A late build after many large writes is too hard to debug.
- When possible, validate generated UI with code-level checks for requested features, real DOM state, responsive CSS evidence, and absence of placeholder/scratch text.
- Before finalizing, verify the entrypoint imports the generated app file and search for leftover scaffold text such as "Get started", "Count is", "Edit src/App", "Explore Vite", and "Learn more".
- For visualizers and animation-heavy apps, verify the canvas or rendered surface is non-empty and that controls update simulation state.
