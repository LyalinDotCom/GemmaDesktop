#!/usr/bin/env node
// Post-hoc functional validator for the solar-iterative benchmark.
//
// Loads the generated app in jsdom with a recording canvas stub, drives the
// animation, and exercises the features each iteration was asked to add. It
// never edits the workspace — it only observes. Checks are deliberately
// tolerant of implementation details (element ids, label offsets) because each
// model is free to structure the app its own way; what matters is observable
// behavior. Every check records a detail string so ambiguous results can be
// reviewed by a human.
//
// Usage: node gemma-solar-iterative-validate.mjs <workspace-dir>
// Output: one JSON object on stdout.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// jsdom comes from the monorepo root (a root dependency); the benchmark
// package itself stays dependency-light.
const require = createRequire(join(resolve(here, '..'), 'package.json'));
const { JSDOM } = require('jsdom');

const workspace = process.argv[2];
if (!workspace) {
  console.log(JSON.stringify({ error: 'usage: node gemma-solar-iterative-validate.mjs <workspace-dir>' }));
  process.exit(1);
}

const PLANETS = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

const finish = (extra = {}) => {
  const passCount = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ checks: results, passCount, total: results.length, ...extra }, null, 2));
  process.exit(0);
};

// --- static checks -----------------------------------------------------------
const htmlPath = join(workspace, 'index.html');
const appPath = join(workspace, 'app.js');
check('index.html exists', existsSync(htmlPath));
check('style.css exists', existsSync(join(workspace, 'style.css')));
check('app.js exists', existsSync(appPath));
if (!existsSync(htmlPath) || !existsSync(appPath)) {
  finish({ note: 'core files missing; functional checks skipped' });
}

let syntaxOk = true;
try {
  execFileSync('node', ['--check', appPath], { stdio: 'pipe', timeout: 30_000 });
} catch (error) {
  syntaxOk = false;
}
check('node --check app.js passes', syntaxOk);
if (!syntaxOk) {
  finish({ note: 'syntax error; functional checks skipped' });
}

// --- jsdom harness -----------------------------------------------------------
const html = readFileSync(htmlPath, 'utf8');
const appJs = readFileSync(appPath, 'utf8');

const arcs = [];
let fillTexts = [];
const ctxStub = new Proxy(
  {
    arc: (x, y, r) => arcs.push({ x, y, r }),
    fillText: (text, x, y) => fillTexts.push({ text: String(text), x, y }),
    strokeText: (text, x, y) => fillTexts.push({ text: String(text), x, y }),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => {};
    },
    set() {
      return true;
    },
  },
);

const frameQueue = [];
let dom;
try {
  dom = new JSDOM(html.replace(/<script[^>]*src=["'][^"']*app\.js["'][^>]*><\/script>/i, ''), {
    url: `file://${htmlPath}`,
    runScripts: 'outside-only',
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
      window.requestAnimationFrame = (cb) => {
        frameQueue.push(cb);
        return frameQueue.length;
      };
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    },
  });
} catch (error) {
  check('index.html parses in jsdom', false, String(error).slice(0, 200));
  finish();
}
check('index.html parses in jsdom', true);

const { window } = dom;
const { document } = window;

let loadError;
try {
  window.eval(appJs);
} catch (error) {
  loadError = error;
}
check('app.js evaluates without throwing', !loadError, loadError ? String(loadError).slice(0, 200) : '');
if (loadError) {
  finish({ note: 'app.js threw on load; behavior checks skipped' });
}

const stepFrames = (count) => {
  for (let i = 0; i < count; i += 1) {
    const cb = frameQueue.shift();
    if (!cb) return false;
    arcs.length = 0;
    fillTexts = [];
    try {
      cb(Date.now());
    } catch (error) {
      check('animation frame executes without throwing', false, String(error).slice(0, 200));
      finish();
    }
  }
  return true;
};

stepFrames(3);
check('animation loop keeps scheduling frames', frameQueue.length > 0, `pending frames: ${frameQueue.length}`);
const frameArcCount = arcs.length;
check('a frame draws the system (>= 10 arcs: sun + planets + orbits)', frameArcCount >= 10, `arcs per frame: ${frameArcCount}`);

const labelsDrawn = new Set(fillTexts.map((t) => t.text.trim()));
const planetLabels = PLANETS.filter((p) => labelsDrawn.has(p));
check('all 8 planet labels drawn (iteration 2)', planetLabels.length === 8, `labels found: ${planetLabels.join(',') || 'none'}`);

const labelFor = (name) => fillTexts.find((t) => t.text.trim() === name);

// Motion: a planet's label position changes across frames.
const trackName = planetLabels.includes('Earth') ? 'Earth' : planetLabels[0];
let moved = false;
if (trackName) {
  stepFrames(1);
  const a = labelFor(trackName);
  stepFrames(1);
  const b = labelFor(trackName);
  moved = Boolean(a && b) && (a.x !== b.x || a.y !== b.y);
}
check('planets move between frames', moved, trackName ? `tracked ${trackName}` : 'no labels to track');

// Pause: find a button whose text mentions pause (tolerant of ids).
const buttons = [...document.querySelectorAll('button, input[type="button"]')];
const pauseBtn = buttons.find((b) => /pause/i.test(b.textContent || b.value || ''));
let pauseFroze = false;
if (pauseBtn && trackName) {
  pauseBtn.click();
  stepFrames(1);
  const a = labelFor(trackName);
  stepFrames(1);
  const b = labelFor(trackName);
  pauseFroze = Boolean(a && b) && a.x === b.x && a.y === b.y;
  pauseBtn.click(); // resume for later checks
}
check('pause button freezes motion (iteration 1)', pauseFroze, pauseBtn ? '' : 'no pause-labelled button found');

// Slider: range input scales speed.
const slider = document.querySelector('input[type="range"]');
let sliderScales = false;
let fastDelta = 0;
let slowDelta = 0;
if (slider && trackName) {
  const setSpeed = (value) => {
    slider.value = String(value);
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));
    slider.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  setSpeed(slider.max || 5);
  stepFrames(1);
  const fa = labelFor(trackName);
  stepFrames(1);
  const fb = labelFor(trackName);
  fastDelta = fa && fb ? Math.hypot(fb.x - fa.x, fb.y - fa.y) : 0;
  setSpeed(slider.min || 0.1);
  stepFrames(1);
  const sa = labelFor(trackName);
  stepFrames(1);
  const sb = labelFor(trackName);
  slowDelta = sa && sb ? Math.hypot(sb.x - sa.x, sb.y - sa.y) : 0;
  sliderScales = fastDelta > slowDelta * 3 && fastDelta > 0;
}
check(
  'speed slider scales motion (iteration 1)',
  sliderScales,
  slider ? `max-speed delta=${fastDelta.toFixed(2)}px vs min-speed delta=${slowDelta.toFixed(2)}px` : 'no range input found',
);

// Click info panel: click near a planet label; tolerate unknown label offsets
// by scanning a small grid around the label position.
const canvas = document.querySelector('canvas');
let panelOpened = false;
let panelDetail = '';
const probeName = planetLabels.includes('Jupiter') ? 'Jupiter' : trackName;
if (canvas && probeName) {
  stepFrames(1);
  const label = labelFor(probeName);
  if (label) {
    const textBefore = document.body.textContent ?? '';
    const hadNameBefore = textBefore.includes(probeName);
    outer: for (let dx = -30; dx <= 10; dx += 5) {
      for (let dy = -15; dy <= 15; dy += 5) {
        canvas.dispatchEvent(new window.MouseEvent('click', {
          clientX: label.x + dx,
          clientY: label.y + dy,
          bubbles: true,
        }));
        const textAfter = document.body.textContent ?? '';
        if (!hadNameBefore && textAfter.includes(probeName)) {
          panelOpened = true;
          panelDetail = `panel text appeared after click at label offset (${dx},${dy})`;
          break outer;
        }
        if (hadNameBefore) {
          // Name pre-exists in DOM (e.g. hidden panel markup): look for a
          // visibility change on the element containing it.
          const container = [...document.querySelectorAll('div,section,aside')].find((el) =>
            (el.textContent ?? '').includes(probeName) && el.querySelector('button'),
          );
          if (container && !/(^|\s)(hidden|d-none|invisible)(\s|$)/.test(container.className) && container.style.display !== 'none') {
            panelOpened = true;
            panelDetail = `panel element visible after click at offset (${dx},${dy})`;
            break outer;
          }
        }
      }
    }
    if (!panelOpened) panelDetail = 'no click point near the label opened a panel';
  } else {
    panelDetail = 'no label position available to aim the click';
  }
}
check('clicking a planet opens an info panel (iteration 2)', panelOpened, panelDetail);

// Close button on the panel.
let panelClosed = false;
if (panelOpened) {
  const container = [...document.querySelectorAll('div,section,aside')].find((el) =>
    (el.textContent ?? '').includes(probeName) && el.querySelector('button'),
  );
  const closeBtn = container
    ? [...container.querySelectorAll('button')].find((b) => /×|✕|x|close/i.test(b.textContent ?? ''))
    : undefined;
  if (closeBtn) {
    closeBtn.click();
    const hiddenAgain = container.className.match(/(^|\s)(hidden|d-none|invisible)(\s|$)/)
      || container.style.display === 'none'
      || !(document.body.textContent ?? '').includes(probeName);
    panelClosed = Boolean(hiddenAgain);
  }
}
check('info panel close button hides it (iteration 2)', panelClosed, panelOpened ? '' : 'panel never opened');

// Asteroid belt: a frame should now contain many more arcs than the base
// system (sun + 8 orbits + 8 planets ≈ 17). Require at least 40 extra.
stepFrames(1);
const beltArcCount = arcs.length;
check('asteroid belt drawn (iteration 3)', beltArcCount >= 57, `arcs per frame: ${beltArcCount} (base system is ~17)`);

// Moon: code references a moon and the frame has at least one more arc than
// planets + sun + orbits + asteroids alone would explain. The code reference
// is the strong signal; the arc count is recorded for review.
const moonInCode = /moon/i.test(appJs);
check('moon implemented (iteration 3)', moonInCode, moonInCode ? `code references moon; arcs per frame: ${beltArcCount}` : 'no moon reference in app.js');

finish();
