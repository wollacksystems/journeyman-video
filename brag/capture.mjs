#!/usr/bin/env node
/**
 * Capture the brag surface's three states as 1920x1080 PNGs.
 *
 *   node brag/capture.mjs                 # build, serve, shoot all three states
 *   node brag/capture.mjs --state answer  # one state
 *   node brag/capture.mjs --out /tmp/x    # somewhere else
 *   node brag/capture.mjs --no-restore    # leave the capture build in dist/
 *   BRAG_CHROME=/path/to/chrome node brag/capture.mjs
 *
 * It builds the surface (`BRAG_CAPTURE=1 npm run build`), serves `dist/` on a
 * free loopback port, drives headless Chrome over CDP, then rebuilds without
 * the flag so `dist/` is not left holding capture pages.
 *
 * The browser, the server, the CDP client, and the gated build come from
 * `brag/runtime.mjs`, shared with `brag/cut.mjs` — the cut has to be shot
 * through the same viewport, fonts, and flags these frames were.
 *
 * Guarantees, all checked and fatal if violated:
 *   1. The viewport is exactly 1920x1080 (`Emulation.setDeviceMetricsOverride`),
 *      and the captured PNG's own IHDR is read back to prove it.
 *   2. The webfonts actually loaded — `document.fonts.load()` per family, after
 *      `document.fonts.ready` (see `loadWithFonts`). The frames come from Google
 *      Fonts over the network; a silent fallback would produce three
 *      plausible-looking images in Georgia and Helvetica.
 *   3. The console fits inside the frame, and scene 5's source stamp is on it.
 *
 * It also writes `frames.json` beside the frames: the zoom each state was shot
 * at and the source stamp's box in frame pixels. `brag/cut.mjs` needs both —
 * scene 5's proof draws a box on the stamp, and it has to be the stamp as this
 * run actually captured it, not as a second layout pass would compute it.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIST,
  FONT_CSS,
  HEIGHT,
  ROOT,
  WIDTH,
  buildWith,
  connect,
  findChrome,
  fontsReachable,
  killChrome,
  launchChrome,
  loadWithFonts,
  makeProfile,
  pngSize,
  serve,
} from './runtime.mjs';

const STATES = ['ask', 'answer', 'abstention'];

/** Breathing room between the console and the frame edge, in frame pixels. */
const FRAME_MARGIN = 24;

/** Never blow the UI up past this, however short the content is. */
const MAX_ZOOM = 1.6;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? true);
};

const outDir = String(flag('out') ?? join(ROOT, 'brag', 'out'));
const only = flag('state');
const restore = !args.includes('--no-restore');
const states = only ? [String(only)] : STATES;

for (const state of states) {
  if (!STATES.includes(state)) {
    console.error(`capture: unknown state "${state}" — expected: ${STATES.join(', ')}`);
    process.exit(2);
  }
}

/**
 * Fit the console to the frame, then measure it.
 *
 * The first version shot everything at a fixed 1.6x. A real endpoint answer is
 * long, so the slip grew past the frame and `overflow: hidden` clipped it top
 * and bottom with nothing to show for it: the ask-bar was cut off above and the
 * answer's last lines below. The frame's own box was 1920x1080 the whole time,
 * so measuring the frame proved nothing. This measures the *content*, picks the
 * largest zoom that fits, and the assertions below fail on any overflow.
 */
async function fitToFrame(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => {
      const frame = document.querySelector('.brag-frame');
      const ui = document.querySelector('.brag-ui');
      if (!frame || !ui) return { error: 'the frame or console is missing' };

      const root = document.documentElement.style;
      root.setProperty('--brag-zoom', '1');
      const naturalHeight = ui.getBoundingClientRect().height;
      const available = frame.getBoundingClientRect().height - 2 * ${FRAME_MARGIN};
      const zoom = Math.min(${MAX_ZOOM}, available / naturalHeight);
      root.setProperty('--brag-zoom', String(zoom));

      // Re-measure after the zoom is applied, then report the real boxes.
      const f = frame.getBoundingClientRect();
      const u = ui.getBoundingClientRect();
      return {
        zoom,
        naturalHeight,
        frame: { top: f.top, left: f.left, width: f.width, height: f.height },
        ui: { top: u.top, left: u.left, width: u.width, height: u.height },
      };
    })()`,
  });
  const fitted = result?.result?.value;
  if (!fitted) throw new Error('could not measure the console');
  if (fitted.error) throw new Error(fitted.error);
  return fitted;
}

/** Navigate, wait for load, prove the fonts loaded, then screenshot. */
async function captureState(cdp, url, file, state) {
  await loadWithFonts(cdp, url);
  const fit = await fitToFrame(cdp);

  const probe = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      frame: (() => {
        const el = document.querySelector('.brag-frame');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      })(),
      status: document.querySelector('.ask-bar-status')?.textContent ?? null,
      stamped: document.querySelector('.ask-source-seg')?.textContent ?? null,
      // Scene 5 is the source stamp; if it sits off-frame the frame is
      // useless no matter how good the rest of it looks. Reported in frame
      // pixels so the cut can crop to it (brag/cut.mjs).
      source: (() => {
        const el = document.querySelector('.ask-source');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      })(),
    })`,
  });

  const value = probe?.result?.value;
  if (!value) throw new Error('the page returned no probe result');

  if (value.innerWidth !== WIDTH || value.innerHeight !== HEIGHT) {
    throw new Error(
      `viewport is ${value.innerWidth}x${value.innerHeight}, expected ${WIDTH}x${HEIGHT}`,
    );
  }
  if (!value.frame || value.frame.width !== WIDTH || value.frame.height !== HEIGHT) {
    throw new Error(
      `the .brag-frame is ${value.frame ? `${value.frame.width}x${value.frame.height}` : 'missing'}, ` +
        `expected ${WIDTH}x${HEIGHT} — the capture would be cropped or padded`,
    );
  }

  // The frame is a fixed box with `overflow: hidden`, so content that is too
  // tall is clipped *silently*. Assert the console actually sits inside it.
  const eps = 0.5;
  const overflow = [];
  if (fit.ui.top < fit.frame.top - eps) overflow.push(`top by ${(fit.frame.top - fit.ui.top).toFixed(1)}px`);
  if (fit.ui.top + fit.ui.height > fit.frame.top + fit.frame.height + eps) {
    overflow.push(
      `bottom by ${(fit.ui.top + fit.ui.height - (fit.frame.top + fit.frame.height)).toFixed(1)}px`,
    );
  }
  if (fit.ui.left < fit.frame.left - eps) overflow.push('left');
  if (fit.ui.left + fit.ui.width > fit.frame.left + fit.frame.width + eps) overflow.push('right');
  if (overflow.length > 0) {
    throw new Error(
      `the console overflows the frame (${overflow.join(', ')}) — it would be silently ` +
        `clipped. Console is ${fit.ui.height.toFixed(1)}px tall at zoom ${fit.zoom.toFixed(3)} ` +
        `(natural ${fit.naturalHeight.toFixed(1)}px); the fit should have prevented this.`,
    );
  }

  const frameBottom = fit.frame.top + fit.frame.height;
  // A zero-height box would mean the stamp is styled out of existence, and the
  // position check below would pass trivially. Scene 5 depends on it rendering.
  if (state === 'answer' && (!value.source || value.source.height < 20)) {
    throw new Error(
      `the answer frame has no source stamp (${value.source ? `height ${value.source.height}` : 'element missing'}) — scene 5 has nothing to show.`,
    );
  }
  if (value.source && value.source.bottom > frameBottom + eps) {
    throw new Error(
      `the source stamp sits ${(value.source.bottom - frameBottom).toFixed(1)}px below the frame ` +
        `(bottom ${value.source.bottom.toFixed(1)} vs ${frameBottom.toFixed(1)}) — scene 5's ` +
        'proof would be cropped out of the shot.',
    );
  }

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
  });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return { probe: value, fit };
}

/**
 * The geometry the cut needs: zoom per state, and where the answer's source
 * stamp sits in its frame. Written next to the PNGs so the two cannot be from
 * different runs.
 */
function writeTimeline(rows, dir) {
  const states = {};
  for (const { state, probe, fit } of rows) {
    const source = probe.source;
    states[state] = {
      zoom: Number(fit.zoom.toFixed(4)),
      ui: {
        left: Number(fit.ui.left.toFixed(2)),
        top: Number(fit.ui.top.toFixed(2)),
        width: Number(fit.ui.width.toFixed(2)),
        height: Number(fit.ui.height.toFixed(2)),
      },
      stamp: source
        ? {
            x: Number(source.left.toFixed(2)),
            y: Number(source.top.toFixed(2)),
            width: Number((source.right - source.left).toFixed(2)),
            height: Number((source.bottom - source.top).toFixed(2)),
          }
        : null,
    };
  }
  writeFileSync(
    join(dir, 'frames.json'),
    JSON.stringify({ width: WIDTH, height: HEIGHT, states }, null, 2) + '\n',
  );
}

/**
 * A self-contained review sheet: the frames are inlined as data URIs, because
 * a page that references sibling PNGs only renders when something is serving
 * that directory. One openable file beats a server for review.
 */
function writeSheet(rows, dir) {
  const LABELS = {
    ask: 'scene 4 — the question going in',
    answer: 'scenes 4/5 — grounded answer, Paper slip, source stamp',
    abstention: 'scene 5 — the refusal, on the console\u2019s own ground',
  };
  const cells = rows
    .map(
      ({ state, file, size, bytes }) => `    <figure>
      <figcaption>${LABELS[state] ?? state}<span>${state}.png \u00b7 ${size.width}\u00d7${size.height} \u00b7 ${(bytes / 1024).toFixed(0)} KB</span></figcaption>
      <img src="data:image/png;base64,${readFileSync(file).toString('base64')}" alt="${state} frame" />
    </figure>`,
    )
    .join('\n');

  writeFileSync(
    join(dir, 'sheet.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Brag capture \u2014 ${rows.length} frame(s)</title>
    <style>
      body { margin: 0; background: #0b0b0c; color: #e8e2d8; font: 14px/1.5 system-ui, sans-serif; }
      figure { margin: 0 0 28px; }
      figcaption { display: flex; justify-content: space-between; gap: 16px; padding: 10px 14px;
                   font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
      figcaption span { color: #b9ac9c; letter-spacing: .02em; text-transform: none; }
      img { display: block; width: 100%; height: auto; }
    </style>
  </head>
  <body>
${cells}
  </body>
</html>
`,
  );
}

// ---------------------------------------------------------------------------

const chrome = findChrome();
console.log(`capture: chromium ${chrome}`);

console.log(
  (await fontsReachable())
    ? 'capture: webfonts reachable'
    : 'capture: WARNING — the Google Fonts stylesheet is unreachable; the font check will fail',
);

console.log('capture: building the surface (BRAG_CAPTURE=1)');
if ((await buildWith({ ...process.env, BRAG_CAPTURE: '1' })) !== 0) {
  throw new Error('the surface build failed');
}

mkdirSync(outDir, { recursive: true });
const { server, port } = await serve(DIST);
const profile = makeProfile('brag-capture-');
const browser = launchChrome(chrome, profile);
const written = [];

try {
  const cdp = await connect(chrome, profile);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // The authoritative viewport: independent of the OS window and of the
    // device-scale factor, so the PNG is exactly the frame.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const state of states) {
      const url = `http://127.0.0.1:${port}/brag/${state}/`;
      const file = join(outDir, `${state}.png`);
      rmSync(file, { force: true });
      const { probe, fit } = await captureState(cdp, url, file, state);

      const size = pngSize(file);
      if (!size) throw new Error(`${file} is not a PNG`);
      if (size.width !== WIDTH || size.height !== HEIGHT) {
        throw new Error(`${file} is ${size.width}x${size.height}, expected ${WIDTH}x${HEIGHT}`);
      }
      const bytes = statSync(file).size;
      console.log(
        `capture: ${state.padEnd(11)} ${size.width}x${size.height}  ${String(bytes).padStart(7)} bytes  ` +
          `zoom=${fit.zoom.toFixed(2)} ui=${fit.ui.width.toFixed(0)}x${fit.ui.height.toFixed(0)}  ` +
          `status="${probe.status}"`,
      );
      if (probe.stamped) {
        console.log(
          `capture: ${' '.repeat(11)} stamp="${probe.stamped}" at y=${probe.source.top.toFixed(0)}..${probe.source.bottom.toFixed(0)}`,
        );
      }
      written.push({ state, file, bytes, size, probe, fit });
    }
  } finally {
    cdp.close();
  }
} finally {
  killChrome(browser, profile);
  server.close();
  if (restore) {
    console.log('capture: restoring the default build');
    const code = await buildWith(process.env);
    if (code !== 0) console.warn(`capture: the default build exited ${code}`);
  }
}

writeSheet(written, outDir);
writeTimeline(written, outDir);
console.log(
  `capture: ${written.length} frame(s) + sheet.html + frames.json in ${outDir}` +
    (only ? '\ncapture: NOTE — a partial run (--state) records only that state; frames.json is ' +
      'input to brag/cut.mjs and wants all three.' : ''),
);
