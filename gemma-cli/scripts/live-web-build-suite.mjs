#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const gemmaCliRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(gemmaCliRoot, '..');
const cliPath = path.join(gemmaCliRoot, 'packages', 'cli', 'dist', 'index.js');
const defaultTargetRoot = path.join(
  repoRoot,
  'test-projects',
  `gemma-cli-web-live-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
);
const validationInstruction =
  'Before finalizing, run npm run build, npm run validate, and npm run lint when a lint script exists in the generated app directory using cwd or --prefix; do not count root workspace npm commands as app validation. Fix failures, remove unused Vite starter code, and remove any scratch or self-correction comments from generated source. If lint exits 0 with warnings, treat lint as passed and continue unless this prompt explicitly asks to clean warnings.';
const finalizationInstruction =
  'When the app is implemented and validation has passed, call finalize_build with exact keys: summary, artifacts, validation, and instructionChecklist. The summary must be a non-empty string. The validation array must include the commands you actually ran and their passed/failed/blocked status.';
const patchRecoveryInstruction =
  'Change one file at a time. Prefer one focused patch per file; do not combine unrelated files in one patch. If a patch fails, read the exact current file region and use one smaller patch, or rewrite only that file after reading it.';

const scenarios = [
  {
    id: 'notes-app',
    title: 'React notes app',
    targetName: 'notes-app',
    prompts: [
      {
        id: 'create',
        text: (target) => [
          `Create a basic, compact Vite React note-taking web app in ${target}.`,
          'Keep the first version small and working: notebooks, notes, pinned notes, search, an editor, localStorage persistence, and responsive layout.',
          'Use JavaScript and JSX files unless the project is already TypeScript. Use focused component/helper files instead of one large App file.',
          'Keep CSS concise and avoid repeated rules.',
          'Include working npm scripts for dev, build, and validate.',
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'reactEntrypoint', 'notesCore']
      },
      {
        id: 'tags',
        text: (target) => [
          `In ${target}, add tags to notes and a tag filter that works with search and pinned notes.`,
          'Make the smallest working change, keep the existing notes app behavior intact, and update validation so regressions are caught.',
          patchRecoveryInstruction,
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'reactEntrypoint', 'notesCore', 'notesTags']
      },
      {
        id: 'archive',
        text: (target) => [
          `In ${target}, add archive and restore behavior for notes, including a way to view archived notes separately.`,
          'Make the smallest working change. Keep notebooks, pinned notes, search, tags, persistence, and validation working.',
          patchRecoveryInstruction,
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'reactEntrypoint', 'notesCore', 'notesTags', 'notesArchive']
      },
      {
        id: 'import-export',
        text: (target) => [
          `In ${target}, add local JSON export and import for the notes data.`,
          'The controls must perform real local actions, validate bad input cleanly, and keep the app buildable. Make the smallest working change.',
          patchRecoveryInstruction,
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'reactEntrypoint', 'notesCore', 'notesTags', 'notesArchive', 'notesImportExport']
      }
    ]
  },
  {
    id: 'black-hole-threejs',
    title: 'Three.js black hole simulation',
    targetName: 'black-hole-threejs',
    prompts: [
      {
        id: 'create',
        text: (target) => [
          `Create a basic, compact Vite web app in ${target} that uses Three.js for a black hole simulation.`,
          'The first screen should show an animated WebGL scene with a black hole, accretion disk or lensing-style visual, star field, and controls for mass, spin, accretion intensity, simulation speed, pause, and reset.',
          'Use focused JavaScript files for scene setup, simulation state, controls, and styling.',
          'Keep CSS concise and avoid repeated rules.',
          'Include working npm scripts for dev, build, and validate.',
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'viteEntrypoint', 'threeCore']
      },
      {
        id: 'presets',
        text: (target) => [
          `In ${target}, add black hole presets such as stellar, supermassive, and extreme, plus a live metrics panel that updates when controls change.`,
          'Make the smallest working change. Keep the Three.js scene animated and keep validation working.',
          patchRecoveryInstruction,
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'viteEntrypoint', 'threeCore', 'threePresets']
      },
      {
        id: 'lensing-quality',
        text: (target) => [
          `In ${target}, add controls for lensing/starfield intensity and a simple quality mode for lower-power machines.`,
          'The controls should update the running simulation state rather than only changing labels. Make the smallest working change.',
          patchRecoveryInstruction,
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'viteEntrypoint', 'threeCore', 'threePresets', 'threeLensingQuality']
      },
      {
        id: 'export-reset',
        text: (target) => [
          `In ${target}, add a local screenshot or snapshot export flow and a reset-view flow for the simulation.`,
          'Make the smallest working change. Keep all existing controls, animation, and validation working.',
          patchRecoveryInstruction,
          validationInstruction,
          finalizationInstruction
        ].join(' '),
        validators: ['commonWebApp', 'viteEntrypoint', 'threeCore', 'threePresets', 'threeLensingQuality', 'threeExportReset']
      }
    ]
  }
];

const validators = {
  async commonWebApp(context) {
    await assertPackageScript(context, 'build');
    await assertPackageScript(context, 'dev');
    await assertPackageScript(context, 'validate');
    await assertNoForbiddenGeneratedText(context);
    await assertNoStaleStarterContent(context);
    await ensureInstalled(context);
    await runProjectScript(context, 'build');
    await runProjectScript(context, 'validate');
    await runProjectScriptIfPresent(context, 'lint');
    await assertNoUndefinedGeneratedJavaScript(context);
    await assertDistLooksReal(context);
  },

  async viteEntrypoint(context) {
    const indexHtml = await readRequiredFile(path.join(context.targetDirectory, 'index.html'));
    const mainPath = findViteMainPath(indexHtml, context.targetDirectory);
    const mainText = await readRequiredFile(mainPath);
    assert(
      /createRoot|new\s+App|new\s+Simulation|new\s+BlackHole|WebGLRenderer|render\s*\(/i.test(mainText),
      `Vite entrypoint ${relative(mainPath)} does not appear to mount or start the app.`
    );
  },

  async reactEntrypoint(context) {
    const indexHtml = await readRequiredFile(path.join(context.targetDirectory, 'index.html'));
    const mainPath = findViteMainPath(indexHtml, context.targetDirectory);
    const mainText = await readRequiredFile(mainPath);
    assert(/createRoot\s*\(/.test(mainText), `React entrypoint ${relative(mainPath)} does not call createRoot().`);
    assert(/\.render\s*\(/.test(mainText), `React entrypoint ${relative(mainPath)} does not render the app.`);
    assert(/App|Notes|Notebook/i.test(mainText), `React entrypoint ${relative(mainPath)} does not import or render the generated notes app.`);
  },

  async notesCore(context) {
    const source = await readProjectSource(context);
    assertAny(source, [/notebooks?/i], 'notes app should include notebooks.');
    assertAny(source, [/\bnotes?\b/i], 'notes app should include notes.');
    assertAny(source, [/pinned?|pinNote|togglePin/i], 'notes app should include pinned notes behavior.');
    assertAny(source, [/search/i], 'notes app should include search.');
    assertAny(source, [/localStorage|indexedDB/i], 'notes app should persist locally.');
    assertAny(source, [/textarea|contentEditable|markdown|preview|editor/i], 'notes app should include an editor or markdown preview surface.');
  },

  async notesTags(context) {
    const source = await readProjectSource(context);
    assertAny(source, [/\btags?\b/i], 'notes tag edit should introduce tags.');
    assertAny(source, [/tagFilter|selectedTag|filter.*tag|tag.*filter/i], 'notes tag edit should include tag filtering behavior.');
  },

  async notesArchive(context) {
    const source = await readProjectSource(context);
    assertAny(source, [/archiv/i], 'notes archive edit should include archive behavior.');
    assertAny(source, [/restore|unarchive|activeNotes|archivedNotes/i], 'notes archive edit should include restore or archived-note view behavior.');
  },

  async notesImportExport(context) {
    const source = await readProjectSource(context);
    assertAny(source, [/JSON\.stringify/i, /Blob\s*\(/i, /download/i], 'notes export should serialize or download data.');
    assertAny(source, [/JSON\.parse/i, /FileReader|input[^]*type=["']file|import/i], 'notes import should parse local JSON input.');
    assertAny(source, [/try\s*{|catch\s*\(|invalid|error/i], 'notes import should handle invalid input.');
  },

  async threeCore(context) {
    const source = await readProjectSource(context);
    const packageJson = await readPackageJson(context);
    const dependencyNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {})
    ]);
    assert(dependencyNames.has('three') || /from\s+['"]three['"]|THREE\./.test(source), 'black hole app should use Three.js.');
    assertAny(source, [/WebGLRenderer|from\s+['"]three['"]|THREE\./], 'black hole app should create a Three.js/WebGL renderer.');
    assertAny(source, [/Scene\s*\(|new\s+THREE\.Scene/i], 'black hole app should create a scene.');
    assertAny(source, [/PerspectiveCamera|OrthographicCamera|Camera\s*\(/i], 'black hole app should create a camera.');
    assertAny(source, [/requestAnimationFrame|setAnimationLoop/i], 'black hole app should animate.');
    assertAny(source, [/black\s*hole|event\s*horizon|accretion/i], 'black hole app should model a black hole/accretion concept.');
    assertAny(source, [/mass/i], 'black hole app should include mass control/state.');
    assertAny(source, [/spin/i], 'black hole app should include spin control/state.');
    assertAny(source, [/pause|paused/i], 'black hole app should include pause behavior.');
    assertAny(source, [/reset/i], 'black hole app should include reset behavior.');
  },

  async threePresets(context) {
    const source = await readProjectSource(context);
    assertAny(source, [/preset/i], 'black hole preset edit should include presets.');
    assertAny(source, [/stellar|supermassive|extreme/i], 'black hole presets should include named astrophysics-inspired presets.');
    assertAny(source, [/metrics?|fps|energy|radius|schwarzschild|intensity/i], 'black hole preset edit should include a live metrics panel or computed values.');
  },

  async threeLensingQuality(context) {
    const source = await readProjectSource(context);
    assertAny(source, [/lensing|starfield|stars/i], 'black hole lensing edit should include lensing or starfield control.');
    assertAny(source, [/quality|performance|low|medium|high/i], 'black hole quality edit should include a quality/performance mode.');
    assertAny(source, [/addEventListener|onChange|input|select|slider/i], 'black hole controls should wire to state changes.');
  },

  async threeExportReset(context) {
    const source = await readProjectSource(context);
    assertAny(source, [/toDataURL|screenshot|snapshot|download|export/i], 'black hole export edit should include screenshot/snapshot export.');
    assertAny(source, [/resetView|reset\s*view|camera.*reset|defaultCamera|reset/i], 'black hole export edit should preserve or add reset-view behavior.');
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const signalCleanup = installSignalCleanup(options);
  const selectedScenarios = scenarios.filter((scenario) => options.scenario === 'all' || scenario.id === options.scenario);
  if (selectedScenarios.length === 0) {
    throw new Error(`Unknown scenario "${options.scenario}". Available: all, ${scenarios.map((item) => item.id).join(', ')}`);
  }

  const targetRoot = resolveRepoPath(options.targetRoot ?? defaultTargetRoot);
  const resultsDirectory = resolveRepoPath(options.resultsDirectory ?? path.join(targetRoot, '_suite-results'));
  const diagnosticsRoot = path.join(resultsDirectory, 'diagnostics');
  const logsDirectory = path.join(resultsDirectory, 'logs');
  const gemmaHome = path.join(resultsDirectory, 'gemma-cli-home');

  if (existsSync(targetRoot) && !options.reuseTargetRoot) {
    throw new Error(`Target root already exists: ${targetRoot}. Pass --reuse-target-root or choose a fresh --target-root.`);
  }

  await mkdir(logsDirectory, { recursive: true });
  await prepareGemmaCliHome(gemmaHome);

  const summary = {
    startedAt: new Date().toISOString(),
    model: options.model,
    targetRoot,
    resultsDirectory,
    scenarios: []
  };

  let failed = false;
  try {
    for (const scenario of selectedScenarios) {
      const scenarioResult = await runScenario({
        scenario,
        options,
        targetRoot,
        resultsDirectory,
        diagnosticsRoot,
        logsDirectory,
        gemmaHome
      });
      summary.scenarios.push(scenarioResult);
      if (scenarioResult.status !== 'passed') {
        failed = true;
        if (options.stopOnFailure) {
          break;
        }
      }
    }
  } finally {
    signalCleanup.dispose();
    if (!options.keepModelLoaded && options.provider === 'ollama') {
      await runOptionalCommand('ollama', ['stop', options.model], { cwd: repoRoot, logPrefix: '[cleanup]' });
    }
    summary.completedAt = new Date().toISOString();
    summary.status = failed ? 'failed' : 'passed';
    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  console.log(`[suite] summary: ${path.join(resultsDirectory, 'summary.json')}`);
  if (failed) {
    process.exitCode = 1;
  }
}

function installSignalCleanup(options) {
  const handler = (signal) => {
    if (!options.keepModelLoaded && options.provider === 'ollama') {
      console.error(`[suite] received ${signal}; unloading ${options.model}`);
      spawnSync('ollama', ['stop', options.model], { cwd: repoRoot, stdio: 'inherit' });
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return {
    dispose() {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    }
  };
}

async function runScenario(input) {
  const { scenario, options, targetRoot, diagnosticsRoot, logsDirectory, gemmaHome } = input;
  const targetDirectory = path.join(targetRoot, scenario.targetName);
  const diagnosticsDirectory = path.join(diagnosticsRoot, scenario.id);
  await mkdir(targetDirectory, { recursive: true });
  await mkdir(diagnosticsDirectory, { recursive: true });

  const result = {
    id: scenario.id,
    title: scenario.title,
    targetDirectory,
    diagnosticsDirectory,
    turns: [],
    status: 'passed'
  };

  console.log(`[suite] scenario ${scenario.id}: ${scenario.title}`);
  let resume = false;
  for (const turn of scenario.prompts) {
    const prompt = turn.text(relative(targetDirectory));
    const logPath = path.join(logsDirectory, `${scenario.id}-${turn.id}.jsonl`);
    const startedAt = new Date().toISOString();
    console.log(`[suite] ${scenario.id}/${turn.id}: running Gemma CLI`);
    const turnResult = {
      id: turn.id,
      prompt,
      logPath,
      startedAt,
      validators: turn.validators,
      status: 'running'
    };
    result.turns.push(turnResult);

    try {
      await runGemmaCliPrompt({
        prompt,
        resume,
        logPath,
        options,
        diagnosticsDirectory,
        gemmaHome
      });
      resume = true;
      console.log(`[suite] ${scenario.id}/${turn.id}: validating ${turn.validators.join(', ')}`);
      await runValidators(turn.validators, {
        scenario,
        turn,
        targetDirectory,
        logPath,
        options
      });
      turnResult.status = 'passed';
      turnResult.completedAt = new Date().toISOString();
    } catch (error) {
      turnResult.status = 'failed';
      turnResult.completedAt = new Date().toISOString();
      turnResult.error = error instanceof Error ? error.message : String(error);
      result.status = 'failed';
      console.error(`[suite] ${scenario.id}/${turn.id}: failed`);
      console.error(turnResult.error);
      break;
    }
  }

  return result;
}

async function runGemmaCliPrompt(input) {
  const { prompt, resume, logPath, options, diagnosticsDirectory, gemmaHome } = input;
  const args = [
    cliPath,
    '--provider',
    options.provider,
    '--model',
    options.model,
    '--think',
    options.think,
    '--json-stream',
    '--max-turns',
    String(options.maxTurns),
    '--cwd',
    repoRoot
  ];
  if (options.ollamaUrl) {
    args.push('--ollama-url', options.ollamaUrl);
  }
  if (resume) {
    args.push('--resume', 'latest');
  }
  args.push('--prompt', prompt);

  await runCommand(process.execPath, args, {
    cwd: repoRoot,
    timeoutMs: options.turnTimeoutMs,
    env: {
      ...process.env,
      GEMMA_CLI_DIAGNOSTICS_DIR: diagnosticsDirectory,
      GEMMA_CLI_HOME: gemmaHome
    },
    logPath,
    logPrefix: '[gemma]',
    watchGemmaStream: options.streamRepetitionWatchdog
  });
}

async function runValidators(names, context) {
  for (const name of names) {
    const validator = validators[name];
    if (!validator) {
      throw new Error(`Unknown validator "${name}".`);
    }
    await validator(context);
  }
}

async function prepareGemmaCliHome(gemmaHome) {
  const sourceSkills = path.join(gemmaCliRoot, 'skills');
  const targetSkills = path.join(gemmaHome, 'skills');
  await rm(targetSkills, { recursive: true, force: true });
  await mkdir(targetSkills, { recursive: true });
  for (const entry of await readdir(sourceSkills, { withFileTypes: true })) {
    await cp(path.join(sourceSkills, entry.name), path.join(targetSkills, entry.name), { recursive: true });
  }
}

async function ensureInstalled(context) {
  const packageJsonPath = path.join(context.targetDirectory, 'package.json');
  await readRequiredFile(packageJsonPath);
  const nodeModules = path.join(context.targetDirectory, 'node_modules');
  if (!existsSync(nodeModules)) {
    await runCommand('npm', ['install', '--prefix', context.targetDirectory], {
      cwd: repoRoot,
      timeoutMs: context.options.installTimeoutMs,
      logPrefix: '[npm install]'
    });
  }
}

async function runProjectScript(context, scriptName) {
  await runCommand('npm', ['--prefix', context.targetDirectory, 'run', scriptName], {
    cwd: repoRoot,
    timeoutMs: context.options.commandTimeoutMs,
    logPrefix: `[npm ${scriptName}]`
  });
}

async function runProjectScriptIfPresent(context, scriptName) {
  const packageJson = await readPackageJson(context);
  if (packageJson.scripts?.[scriptName]) {
    await runProjectScript(context, scriptName);
  }
}

async function assertNoUndefinedGeneratedJavaScript(context) {
  const sourceFiles = await listFiles(context.targetDirectory, {
    extensions: new Set(['.js', '.jsx', '.mjs'])
  });
  const lintFiles = sourceFiles.filter((file) => {
    const relativePath = relative(file);
    return !relativePath.includes('/dist/')
      && !relativePath.includes('/node_modules/')
      && !relativePath.includes('/.git/');
  });
  if (lintFiles.length === 0) {
    return;
  }

  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{js,jsx,mjs}'],
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: {
            ecmaFeatures: {
              jsx: true
            }
          },
          globals: {
            alert: 'readonly',
            Blob: 'readonly',
            cancelAnimationFrame: 'readonly',
            clearInterval: 'readonly',
            clearTimeout: 'readonly',
            console: 'readonly',
            CustomEvent: 'readonly',
            document: 'readonly',
            Event: 'readonly',
            File: 'readonly',
            FileReader: 'readonly',
            HTMLCanvasElement: 'readonly',
            Image: 'readonly',
            KeyboardEvent: 'readonly',
            localStorage: 'readonly',
            MouseEvent: 'readonly',
            navigator: 'readonly',
            performance: 'readonly',
            process: 'readonly',
            prompt: 'readonly',
            requestAnimationFrame: 'readonly',
            setInterval: 'readonly',
            setTimeout: 'readonly',
            URL: 'readonly',
            window: 'readonly'
          }
        },
        rules: {
          'no-undef': 'error'
        }
      }
    ]
  });
  const results = await eslint.lintFiles(lintFiles);
  const messages = [];
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId === 'no-undef') {
        messages.push(`${relative(result.filePath)}:${message.line}:${message.column} ${message.message}`);
      }
    }
  }
  assert(
    messages.length === 0,
    `generated JavaScript has undefined identifiers:\n${messages.slice(0, 12).join('\n')}`
  );
}

async function assertPackageScript(context, scriptName) {
  const packageJson = await readPackageJson(context);
  assert(packageJson.scripts?.[scriptName], `package.json must include a real "${scriptName}" script.`);
  assert(
    !/echo\s+['"]?(?:ok|success|done|building|built)|exit\s+0|placeholder/i.test(packageJson.scripts[scriptName]),
    `package.json script "${scriptName}" looks like a placeholder: ${packageJson.scripts[scriptName]}`
  );
}

async function readPackageJson(context) {
  const raw = await readRequiredFile(path.join(context.targetDirectory, 'package.json'));
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertNoForbiddenGeneratedText(context) {
  const source = await readProjectSource(context);
  const forbidden = [
    /<tool_call\|>/i,
    /\bnot implemented\b/i,
    /\bunimplemented\b/i,
    /\bcoming soon\b/i,
    /\bi will fix\b/i,
    /\bwait,\b/i,
    /\boops\b/i,
    /\bself[- ]correction\b/i,
    /\blet'?s fix\b/i,
    /\bfor now,\s*let'?s\b/i,
    /\bthe current .*doesn'?t actually\b/i,
    /\bmistake in my draft\b/i,
    /\bto satisfy the prompt\b/i,
    /\bin a real app\b/i,
    /\bfor this demo\b/i
  ];
  for (const pattern of forbidden) {
    assert(!pattern.test(source), `generated source contains forbidden text/pattern: ${pattern}`);
  }
}

async function assertNoStaleStarterContent(context) {
  const source = await readProjectSource(context);
  const stale = [
    /Vite \+ React/i,
    /Click on the Vite and React logos/i,
    /Edit src\/App/i,
    /count is/i,
    /Learn React/i,
    /react\.svg/i,
    /vite\.svg/i
  ];
  for (const pattern of stale) {
    assert(!pattern.test(source), `generated app still contains stale starter content: ${pattern}`);
  }
}

async function assertDistLooksReal(context) {
  const distHtml = path.join(context.targetDirectory, 'dist', 'index.html');
  assert(existsSync(distHtml), 'build should create dist/index.html.');
  const distSource = await readDirectorySource(path.join(context.targetDirectory, 'dist'), {
    extensions: new Set(['.html', '.js', '.css'])
  });
  assert(!/Vite \+ React|Click on the Vite and React logos|Edit src\/App/i.test(distSource), 'dist bundle contains stale starter content.');
  if (context.scenario.id === 'notes-app') {
    assertAny(distSource, [/note/i, /notebook/i], 'notes app dist bundle should contain notes/notebook UI text.');
  }
  if (context.scenario.id === 'black-hole-threejs') {
    assertAny(distSource, [/black/i, /accretion/i, /event horizon/i, /lensing/i], 'black hole dist bundle should contain simulation UI text.');
  }
}

async function readProjectSource(context) {
  return readDirectorySource(context.targetDirectory, {
    extensions: new Set(['.html', '.js', '.jsx', '.ts', '.tsx', '.css', '.json', '.mjs'])
  });
}

async function readDirectorySource(root, options) {
  const files = await listFiles(root, options);
  const chunks = [];
  for (const file of files) {
    if (file.includes(`${path.sep}node_modules${path.sep}`) || file.includes(`${path.sep}.git${path.sep}`)) {
      continue;
    }
    const text = await readFile(file, 'utf8');
    chunks.push(`\n--- ${relative(file)} ---\n${text}`);
  }
  return chunks.join('\n');
}

async function listFiles(root, options) {
  const output = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '.gemmacli'].includes(entry.name)) {
          continue;
        }
        await visit(file);
      } else if (entry.isFile() && options.extensions.has(path.extname(entry.name))) {
        output.push(file);
      }
    }
  }
  await visit(root);
  return output.sort();
}

function findViteMainPath(indexHtml, targetDirectory) {
  const match = indexHtml.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i)
    ?? indexHtml.match(/<script[^>]+src=["']([^"']+)["'][^>]+type=["']module["']/i);
  assert(match?.[1], 'index.html should include a module script entrypoint.');
  const src = match[1].replace(/^\//, '');
  return path.join(targetDirectory, src);
}

async function readRequiredFile(file) {
  try {
    const details = await stat(file);
    assert(details.isFile(), `${relative(file)} should be a file.`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Required file missing: ${relative(file)}`);
    }
    throw error;
  }
}

function assertAny(text, patterns, message) {
  assert(patterns.some((pattern) => pattern.test(text)), message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function relative(file) {
  return path.relative(repoRoot, file) || '.';
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

async function runOptionalCommand(command, args, options) {
  try {
    await runCommand(command, args, { ...options, timeoutMs: 30_000 });
  } catch (error) {
    console.warn(`${options.logPrefix ?? '[command]'} cleanup command failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  await mkdir(path.dirname(options.logPath ?? path.join(os.tmpdir(), 'gemma-cli-web-suite.log')), { recursive: true });
  const logStream = options.logPath ? createWriteStream(options.logPath, { flags: 'a' }) : undefined;
  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const streamWatchdog = options.watchGemmaStream ? createGemmaStreamWatchdog(child) : undefined;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    const write = (chunk, stream) => {
      stream.write(chunk);
      logStream?.write(chunk);
    };
    child.stdout.on('data', (chunk) => {
      streamWatchdog?.observe(chunk);
      write(chunk, process.stdout);
    });
    child.stderr.on('data', (chunk) => write(chunk, process.stderr));
    child.on('error', (error) => {
      clearTimeout(timer);
      logStream?.end();
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      logStream?.end();
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        resolve();
      } else {
        const watchdogReason = streamWatchdog?.reason();
        reject(new Error(`${options.logPrefix ?? command} exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''} after ${durationMs}ms.${watchdogReason ? ` ${watchdogReason}` : ''}`));
      }
    });
  });
}

function createGemmaStreamWatchdog(child) {
  let pending = '';
  let recentModelText = '';
  let triggeredReason = '';
  const signatures = new Map();

  const trigger = (reason) => {
    if (triggeredReason) {
      return;
    }
    triggeredReason = `Stream repetition watchdog stopped Gemma CLI: ${reason}`;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  };

  return {
    observe(chunk) {
      pending += chunk.toString('utf8');
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).trim();
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf('\n');
        if (!line.startsWith('{')) {
          continue;
        }
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== 'model_activity') {
          continue;
        }
        const preview = event.data?.contentPreview ?? event.data?.thinkingPreview ?? '';
        if (!preview) {
          continue;
        }
        const signature = preview.replace(/\s+/g, ' ').trim();
        if (signature.length >= 18) {
          const count = (signatures.get(signature) ?? 0) + 1;
          signatures.set(signature, count);
          if (count >= 12) {
            trigger(`the same model stream fragment repeated ${count} times: ${JSON.stringify(signature.slice(0, 100))}`);
            return;
          }
        }
        recentModelText = `${recentModelText}${preview}`.slice(-12_000);
        const repeatedPair = findRepeatedLinePair(recentModelText);
        if (repeatedPair) {
          trigger(repeatedPair);
          return;
        }
        const repeatedWordRun = findRepeatedWordRun(recentModelText);
        if (repeatedWordRun) {
          trigger(repeatedWordRun);
          return;
        }
        const repeatedPhraseRun = findRepeatedPhraseRun(recentModelText);
        if (repeatedPhraseRun) {
          trigger(repeatedPhraseRun);
          return;
        }
      }
    },
    reason() {
      return triggeredReason;
    }
  };
}

function findRepeatedLinePair(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8 && !/^[{});,]+$/.test(line));
  if (lines.length < 40) {
    return '';
  }
  const counts = new Map();
  for (let index = 0; index < lines.length - 1; index += 1) {
    const pair = `${lines[index]}\n${lines[index + 1]}`;
    if (pair.length < 24) {
      continue;
    }
    const count = (counts.get(pair) ?? 0) + 1;
    counts.set(pair, count);
    if (count >= 12) {
      return `the same adjacent generated lines repeated ${count} times: ${JSON.stringify(pair.slice(0, 140))}`;
    }
  }
  return '';
}

function findRepeatedWordRun(text) {
  const normalized = text.replace(/\\n|\s+/g, ' ').toLowerCase();
  const match = normalized.match(/\b([a-z][a-z0-9_-]{2,})\b(?:\s+\1\b){14,}/);
  if (!match) {
    return '';
  }
  return `the same word repeated excessively in the model stream: ${JSON.stringify(match[1])}`;
}

function findRepeatedPhraseRun(text) {
  const normalized = text
    .replace(/\\n/g, ' ')
    .replace(/[^a-zA-Z0-9']+/g, ' ')
    .toLowerCase()
    .trim();
  if (!normalized) {
    return '';
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  for (let phraseLength = 2; phraseLength <= 8; phraseLength += 1) {
    for (let offset = 0; offset < phraseLength; offset += 1) {
      let previous = '';
      let count = 0;
      for (let index = offset; index <= words.length - phraseLength; index += phraseLength) {
        const phrase = words.slice(index, index + phraseLength).join(' ');
        if (phrase === previous) {
          count += 1;
        } else {
          previous = phrase;
          count = 1;
        }
        if (count >= 8) {
          return `the same generated phrase repeated ${count} times: ${JSON.stringify(phrase.slice(0, 120))}`;
        }
      }
    }
  }
  return '';
}

function parseArgs(argv) {
  const options = {
    provider: 'ollama',
    model: process.env.GEMMA_CLI_WEB_LIVE_MODEL ?? process.env.GEMMA_MODEL ?? 'gemma4:31b',
    ollamaUrl: process.env.OLLAMA_URL,
    scenario: 'all',
    targetRoot: process.env.GEMMA_CLI_WEB_LIVE_TARGET_ROOT,
    resultsDirectory: process.env.GEMMA_CLI_WEB_LIVE_RESULTS_DIR,
    maxTurns: Number(process.env.GEMMA_CLI_WEB_LIVE_MAX_TURNS ?? 50),
    turnTimeoutMs: Number(process.env.GEMMA_CLI_WEB_LIVE_TURN_TIMEOUT_MS ?? 30 * 60 * 1000),
    commandTimeoutMs: Number(process.env.GEMMA_CLI_WEB_LIVE_COMMAND_TIMEOUT_MS ?? 5 * 60 * 1000),
    installTimeoutMs: Number(process.env.GEMMA_CLI_WEB_LIVE_INSTALL_TIMEOUT_MS ?? 5 * 60 * 1000),
    think: process.env.GEMMA_CLI_WEB_LIVE_THINK ?? 'on',
    stopOnFailure: true,
    keepModelLoaded: false,
    reuseTargetRoot: false,
    streamRepetitionWatchdog: process.env.GEMMA_CLI_WEB_LIVE_STREAM_WATCHDOG !== 'off'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--provider':
        options.provider = readValue(argv, ++index, arg);
        break;
      case '--model':
        options.model = readValue(argv, ++index, arg);
        break;
      case '--ollama-url':
        options.ollamaUrl = readValue(argv, ++index, arg);
        break;
      case '--scenario':
        options.scenario = readValue(argv, ++index, arg);
        break;
      case '--target-root':
        options.targetRoot = readValue(argv, ++index, arg);
        break;
      case '--results-dir':
        options.resultsDirectory = readValue(argv, ++index, arg);
        break;
      case '--max-turns':
        options.maxTurns = readPositiveNumber(argv, ++index, arg);
        break;
      case '--turn-timeout-ms':
        options.turnTimeoutMs = readPositiveNumber(argv, ++index, arg);
        break;
      case '--command-timeout-ms':
        options.commandTimeoutMs = readPositiveNumber(argv, ++index, arg);
        break;
      case '--install-timeout-ms':
        options.installTimeoutMs = readPositiveNumber(argv, ++index, arg);
        break;
      case '--think':
        options.think = readValue(argv, ++index, arg);
        break;
      case '--keep-model-loaded':
        options.keepModelLoaded = true;
        break;
      case '--continue-on-failure':
        options.stopOnFailure = false;
        break;
      case '--reuse-target-root':
        options.reuseTargetRoot = true;
        break;
      case '--disable-stream-watchdog':
        options.streamRepetitionWatchdog = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  assert(['ollama', 'lmstudio'].includes(options.provider), '--provider must be ollama or lmstudio.');
  assert(['auto', 'on', 'off'].includes(options.think), '--think must be auto, on, or off.');
  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readPositiveNumber(argv, index, flag) {
  const value = Number(readValue(argv, index, flag));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/live-web-build-suite.mjs [options]

Runs the Gemma CLI live web-app build suite.

Options:
  --scenario <id>          all, notes-app, or black-hole-threejs
  --model <name>           Ollama model, default gemma4:31b
  --target-root <path>     Fresh directory for generated apps
  --results-dir <path>     Diagnostics and logs directory
  --max-turns <n>          Gemma CLI max turns per prompt
  --turn-timeout-ms <ms>   Timeout per live prompt
  --continue-on-failure    Run later scenarios after a failure
  --keep-model-loaded      Do not run ollama stop after the suite
  --disable-stream-watchdog
                           Do not fail fast on repeated model stream fragments
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
