#!/usr/bin/env node
/**
 * Cut the brag (wollacksystems/journeyman#29).
 *
 *   node brag/capture.mjs && node brag/cut.mjs
 *   node brag/cut.mjs --fps 24
 *   node brag/cut.mjs --only bed     # just the music bed
 *   node brag/cut.mjs --only mux     # just re-mux the frames already shot
 *   node brag/cut.mjs --only sheet   # just rebuild the review page
 *   BRAG_CHROME=/path/to/chrome BRAG_FFMPEG=/path/to/ffmpeg node brag/cut.mjs
 *
 * Inputs: the three stills `brag/out/{ask,answer,abstention}.png` and the
 * geometry `brag/capture.mjs` recorded beside them in `brag/out/frames.json`
 * (the console's zoom, and where the answer's source stamp sits in the frame —
 * the proof scene draws its box there). Run the capture first; this fails with
 * that instruction rather than cutting a video around a missing frame.
 *
 * Then it builds the cut state (`BRAG_CAPTURE=1`), serves `dist/` with
 * `brag/out/` mounted at `/frames`, and walks the timeline at a fixed rate:
 *
 *     816 frames at 24 fps = 34.000 s exactly
 *
 * Every frame is `window.__brag.seek(t)` — the timeline is a pure function of t,
 * so this is a render, not a recording, and two runs agree byte for byte. The bed
 * is rendered by `OfflineAudioContext` in the same browser (`brag/music.bed.js`),
 * then ffmpeg muxes the sequence and the WAV into `journeyman-brag.mp4`. The
 * bed's material is seeded and reproduces, but its samples agree only to the last
 * bit of a float32, which is measured and written up in `music.bed.js`: the
 * frames are the part of this pipeline that hashes identically, and the audio is
 * the part that does not. Finally it
 * rebuilds without the flag, so `dist/` is not left holding capture pages.
 *
 * Checked, not assumed — each of these is fatal:
 *   - the stills are 1920x1080 and the stamp box was recorded;
 *   - the timeline is 34.0 s and its six scenes match the outline in #29;
 *   - every line of copy is on screen at full opacity for as long as the
 *     reading budget in `BragTimeline.astro` says it needs, measured by walking
 *     the clock and reading the real opacities out of the page, and no line
 *     wraps to more rows than it was set for — a cut whose text flies by is a
 *     bug, and this is the test for it;
 *   - seeking actually moves the frame (480 identical PNGs would cut a very
 *     confident video of nothing);
 *   - every written frame is exactly 1920x1080;
 *   - the bed is real audio: a measured peak near full scale, not silence;
 *   - the muxed file is 1920x1080/20.000 s with a video and an audio stream.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIST,
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
  sleep,
} from './runtime.mjs';

const DURATION = 34;
const FRAME_NAME = (i) => `${String(i).padStart(5, '0')}.png`;

/**
 * The outline in issue #29, as the driver expects to find it in the page.
 *
 * These boundaries are not round because they are not decoration: each one is
 * the moment its scene's last line has been legible long enough to read, which
 * is why they sum to exactly 20.0 rather than to nice halves. Changing one
 * without re-reading the copy is how the text starts flying by again.
 */
const EXPECTED_SCENES = [
  { id: 'hook', from: 0, to: 4.5 },
  { id: 'capture', from: 4.5, to: 8.1 },
  { id: 'pipeline', from: 8.1, to: 13.4 },
  { id: 'demo', from: 13.4, to: 22.2 },
  { id: 'proof', from: 22.2, to: 30.2 },
  { id: 'tagline', from: 30.2, to: 34 },
];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? true);
};

const fps = Number(flag('fps') ?? 24);
const only = flag('only') ? String(flag('only')) : null;
const outDir = String(flag('out') ?? join(ROOT, 'brag', 'out'));
const restore = !args.includes('--no-restore');
const framesDir = join(outDir, 'frames');
const videoFile = join(outDir, 'journeyman-brag.mp4');
const bedFile = join(outDir, 'bed.wav');
const timelineFile = join(outDir, 'frames.json');
const FFMPEG = process.env.BRAG_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.BRAG_FFPROBE || 'ffprobe';

if (!Number.isFinite(fps) || fps <= 0 || fps > 60) {
  console.error(`cut: --fps must be between 1 and 60 (got "${flag('fps')}")`);
  process.exit(2);
}
if (only && !['bed', 'mux', 'sheet'].includes(only)) {
  console.error(`cut: --only must be "bed", "mux", or "sheet" (got "${only}")`);
  process.exit(2);
}

/** Run a command, return { code, stdout, stderr } — no shell, no surprises. */
function run(command, argv) {
  return new Promise((ok) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => ok({ code: -1, stdout, stderr: String(error.message) }));
    child.on('close', (code) => ok({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * The review page: the whole cut, one openable file.
 *
 * Frames and video are inlined as data URIs for the same reason capture.mjs's
 * sheet inlines its PNGs — a page that references sibling files only renders
 * when something is serving that directory, and a review artifact should not
 * need a server, a running process, or a particular working directory.
 *
 * It autoplays muted (browsers block autoplay with sound, and this cut is
 * text-driven so it carries muted) with the bed one click away. If the capture
 * run left `reading.json` beside the frames, the page also prints the reading
 * table it measured, so the claim that the copy is legible now sits next to the
 * copy. That file is what the run measured, not a restatement of the budget —
 * and if it is missing, the page simply says nothing rather than guessing.
 */
const REVIEW_BEATS = [
  { t: 2.3, label: 'hook' },
  { t: 6.0, label: 'capture' },
  { t: 10.4, label: 'pipeline' },
  { t: 14.8, label: 'demo \u2014 ask' },
  { t: 18.4, label: 'demo \u2014 answer' },
  { t: 24.6, label: 'proof \u2014 the stamp' },
  { t: 26.9, label: 'proof \u2014 the abstention' },
  { t: 32.0, label: 'tagline' },
];

function writeReview(dir) {
  const cells = REVIEW_BEATS.map(({ t, label }) => {
    const index = Math.min(total - 1, Math.round(t * fps));
    const file = join(framesDir, FRAME_NAME(index));
    if (!existsSync(file)) return null;
    return `      <figure>
        <figcaption>${label}<span>t=${t.toFixed(2)}s \u00b7 ${FRAME_NAME(index)}</span></figcaption>
        <img src="data:image/png;base64,${readFileSync(file).toString('base64')}" alt="${label}" />
      </figure>`;
  }).filter(Boolean);

  const video = existsSync(videoFile)
    ? `    <video controls autoplay muted loop playsinline preload="metadata" src="data:video/mp4;base64,${readFileSync(
        videoFile,
      ).toString('base64')}"></video>`
    : '    <p class="meta">no video yet \u2014 run the full cut to mux one.</p>';

  // What the capture run measured out of the page, if it left it here.
  const readingFile = join(dir, 'reading.json');
  const measured = existsSync(readingFile) ? JSON.parse(readFileSync(readingFile, 'utf8')) : null;
  const readingTable = measured
    ? `    <h2>Reading time, measured out of the rendered page</h2>
    <p class="meta">
      ${measured.words} words of on-screen copy, ${measured.held.toFixed(1)}s of it held at
      full opacity, sampled every ${(measured.step * 1000).toFixed(1)}ms. The capture run
      fails the build when a line is under its budget, lands at the wrong moment, or wraps
      to more rows than it is set for.
    </p>
    <table>
      <tr><th>scene</th><th>line</th><th>words</th><th>tier</th><th>budget</th><th>held</th><th>rate</th><th>rows</th></tr>
${measured.lines
  .map(
    (l) =>      `<tr><td>${l.scene}</td><td class="sel">${l.what ?? l.line}</td>` +
      `<td>${l.words || ''}</td><td>${l.tier}</td><td>${l.budget.toFixed(2)}s</td>` +
      `<td class="held">${l.hold.toFixed(2)}s</td>` +
      `<td>${l.tier === 'still' ? '' : `${(l.words / l.hold).toFixed(1)} w/s`}</td>` +
      `<td>${l.tier === 'still' ? '' : `${l.rows}/${l.maxLines}`}</td></tr>`,
  )
  .join('\n')}
    </table>
`
    : '';

  // Generated from the outline the driver already asserts, so the review page
  // cannot describe a different edit than the one it is showing.
  const sceneTable = EXPECTED_SCENES.map((s) => `${s.id} ${s.from}\u2013${s.to}`).join(' \u00b7 ');

  const file = join(dir, 'cut.html');
  writeFileSync(
    file,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Journeyman \u2014 the ${DURATION}-second cut</title>
    <style>
      body { margin: 0; padding: 26px; background: #0b0b0c; color: #e8e2d8;
             font: 14px/1.5 system-ui, sans-serif; }
      h1 { margin: 0 0 6px; font-size: 15px; letter-spacing: .14em; text-transform: uppercase; }
      p.meta { margin: 0 0 20px; color: #b9ac9c; }
      .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
      figure { margin: 0; }
      figcaption { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0;
                   font: 600 11px/1.4 ui-monospace, monospace; letter-spacing: .08em;
                   text-transform: uppercase; }
      figcaption span { color: #b9ac9c; font-weight: 400; }
      img { display: block; width: 100%; height: auto; border: 1px solid #33291f; }
      video { display: block; width: 100%; margin-top: 24px; border: 1px solid #33291f; }
      h2 { margin: 34px 0 8px; font: 600 12px/1.4 ui-monospace, monospace;
           letter-spacing: .14em; text-transform: uppercase; color: #e25822; }
      table { border-collapse: collapse; width: 100%; max-width: 1120px; }
      th, td { padding: 6px 14px 6px 0; text-align: left; vertical-align: top;
               border-bottom: 1px solid #1e1a15; font: 400 12px/1.4 ui-monospace, monospace; }
      th { color: #b9ac9c; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
      td.sel { color: #e8e2d8; }
      td.held { color: #e25822; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>Journeyman \u2014 the ${DURATION}-second cut</h1>
    <p class="meta">
      ${sceneTable} \u00b7 ${WIDTH}\u00d7${HEIGHT} \u00b7 ${fps} fps \u00b7
      ${total} frames \u00b7 music bed synthesized, no rendered sim footage \u00b7
      autoplays muted \u2014 unmute it for the bed
    </p>
${video}
    <div class="grid">
${cells.join('\n')}
    </div>
${readingTable}  </body>
</html>
`,
  );
  return { file, beats: cells.length };
}

async function ffmpeg(argv) {
  const result = await run(FFMPEG, argv);
  if (result.code !== 0) {
    throw new Error(
      `${FFMPEG} exited ${result.code}:\n${result.stderr.split('\n').slice(-14).join('\n')}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Preflight: the stills and their geometry come from brag/capture.mjs.

if (only === null || only === 'bed') {
  for (const state of ['ask', 'answer', 'abstention']) {
    const file = join(outDir, `${state}.png`);
    if (!existsSync(file)) {
      throw new Error(`${file} is missing — run \`node brag/capture.mjs\` first.`);
    }
    const size = pngSize(file);
    if (!size || size.width !== WIDTH || size.height !== HEIGHT) {
      throw new Error(
        `${file} is ${size ? `${size.width}x${size.height}` : 'not a PNG'}, expected ${WIDTH}x${HEIGHT}`,
      );
    }
  }
}

/** The console zoom and the source stamp's box, recorded by the capture. */
function readTimeline() {
  if (!existsSync(timelineFile)) {
    throw new Error(`${timelineFile} is missing — run \`node brag/capture.mjs\` first.`);
  }
  const data = JSON.parse(readFileSync(timelineFile, 'utf8'));
  const stamp = data.states?.answer?.stamp;
  if (!stamp || !stamp.width) {
    throw new Error(
      `the capture recorded no source stamp box for the answer frame (${timelineFile}) — ` +
        "scene 5's proof would have nothing to draw its box around.",
    );
  }
  return data;
}

// ---------------------------------------------------------------------------

const chrome = findChrome();
const total = Math.round(DURATION * fps);

console.log(`cut: chromium ${chrome}`);
console.log(
  (await fontsReachable())
    ? 'cut: webfonts reachable'
    : 'cut: WARNING — the Google Fonts stylesheet is unreachable; the font check will fail',
);

let cdp = null;
let browser = null;
let profile = null;
let server = null;

if (only === null || only === 'bed') {
  const timeline = only === 'bed' ? null : readTimeline();
  if (timeline) {
    console.log(
      `cut: stills recorded at zoom ask=${timeline.states.ask.zoom.toFixed(2)} ` +
        `answer=${timeline.states.answer.zoom.toFixed(2)} ` +
        `abstention=${timeline.states.abstention.zoom.toFixed(2)}; ` +
        `stamp at ${JSON.stringify(timeline.states.answer.stamp)}`,
    );
  }

  console.log('cut: building the capture surface (BRAG_CAPTURE=1)');
  if ((await buildWith({ ...process.env, BRAG_CAPTURE: '1' })) !== 0) {
    throw new Error('the cut build failed');
  }

  mkdirSync(outDir, { recursive: true });
  if (timeline) {
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
  }

  // `/frames` is how the cut page gets the stills: brag/out is not part of the
  // site build, and it must not be.
  ({ server } = await serve(DIST, { '/frames': outDir }));
  const port = server.address().port;
  profile = makeProfile('brag-cut-');
  browser = launchChrome(chrome, profile);

  try {
    cdp = await connect(chrome, profile);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // The cut state: the timeline, at exactly the viewport the stills were
    // captured at, on the same faces.
    await loadWithFonts(cdp, `http://127.0.0.1:${port}/brag/cut/`);
    await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: 'window.__brag ? window.__brag.ready : Promise.reject(new Error("no timeline"))',
    });

    const describe = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(() => {
        if (!window.__brag) return { error: 'the cut page exposed no timeline' };
        return {
          duration: window.__brag.duration,
          scenes: window.__brag.scenes,
          stillsMissing: document.querySelector('[data-cut]').hasAttribute('data-stills-missing'),
        };
      })()`,
    });
    const info = describe?.result?.value;
    if (!info || info.error) throw new Error(info?.error ?? 'the cut page returned no timeline');
    if (info.duration !== DURATION) {
      throw new Error(`the timeline is ${info.duration}s long, expected exactly ${DURATION}s`);
    }
    const actual = JSON.stringify(info.scenes);
    if (actual !== JSON.stringify(EXPECTED_SCENES)) {
      throw new Error(
        `the timeline's scenes do not match issue #29's outline:\n  page:     ${actual}\n  expected: ${JSON.stringify(EXPECTED_SCENES)}`,
      );
    }
    if (info.stillsMissing) {
      throw new Error(
        'the cut page could not decode a still — check that brag/out is mounted at /frames ' +
          'and that brag/capture.mjs has run.',
      );
    }

    // Where the stamp is, so scene 5's proof box lands on it. Skipped when there
    // is no timeline to read the stamp's box out of — `--only bed` renders audio
    // and shoots nothing — but it happens before the reading walk below, so that
    // walk measures the page in the state the frames will be shot in.
    if (timeline) {
      await cdp.send('Runtime.evaluate', {
        expression: `window.__brag.setup(${JSON.stringify({ stamp: timeline.states.answer.stamp })})`,
      });
    }

    // Readability, as a measurement rather than an opinion. The cut is only
    // readable if each line of copy is genuinely on screen at full opacity for
    // as long as its budget says — so walk the clock faster than the shooter
    // does and read the real opacities out of the page, rather than trusting the
    // table in the component to describe what the component does.
    const READ_STEP = 1 / 120;
    const measured = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      timeoutMs: 120_000,
      expression: `(() => {
        const plan = window.__brag.reading;
        const step = ${READ_STEP};
        const held = plan.map(() => ({ hold: 0, first: null, last: null }));
        for (let t = 0; t <= window.__brag.duration + 1e-9; t += step) {
          window.__brag.seek(t);
          const now = window.__brag.opacities();
          plan.forEach((entry, index) => {
            if (now[entry.line] >= 0.995) {
              held[index].hold += step;
              if (held[index].first === null) held[index].first = t;
              held[index].last = t;
            }
          });
        }
        return plan.map((entry, index) => {
          const node = document.querySelector(entry.line);
          let rows = 0;
          if (node) {
            const lineHeight = parseFloat(getComputedStyle(node).lineHeight);
            // Rows from the box, not from a range's rects: a <br> is a rect too,
            // so a deliberately two-line card would otherwise read as a wrap.
            rows =
              lineHeight > 0 ? Math.round(node.getBoundingClientRect().height / lineHeight) : 0;
          }
          return { ...entry, ...held[index], rows };
        });
      })()`,
    });

    const reading = measured?.result?.value;
    if (!Array.isArray(reading) || !reading.length) {
      throw new Error('the cut page exposed no reading table — nothing to check the copy against.');
    }
    const trouble = [];
    console.log('cut: reading time, measured out of the rendered page');
    console.log('cut:   scene      what                     words  tier     budget   held    rate  rows');
    for (const entry of reading) {
      // A hero still carries no words: it is budgeted as an artefact to scan, so
      // it has a hold and a landing but no rate and no row count.
      const isStill = entry.tier === 'still';
      const rate = !isStill && entry.hold > 0 ? entry.words / entry.hold : null;
      console.log(
        `cut:   ${entry.scene.padEnd(9)}  ${entry.what.padEnd(23)} ` +
          `${String(isStill ? '' : entry.words).padStart(4)}  ${entry.tier.padEnd(7)} ` +
          `${entry.budget.toFixed(2)}s  ${entry.hold.toFixed(2)}s  ` +
          `${(rate === null ? '-' : rate.toFixed(1)).padStart(4)}  ` +
          `${isStill ? '   -' : `${String(entry.rows).padStart(2)}/${entry.maxLines}`}`,
      );
      if (!isStill && !entry.rows) {
        trouble.push(`${entry.what} (${entry.line}) is not in the page — the selector drifted`);
        continue;
      }
      // One sample of slack: the walk samples the window, it does not sum it.
      if (entry.hold + READ_STEP < entry.budget) {
        trouble.push(
          `${entry.what} holds ${entry.hold.toFixed(2)}s, under its ${entry.budget.toFixed(2)}s budget` +
            (rate === null ? '' : ` (${rate.toFixed(1)} words a second)`),
        );
      }
      const land = entry.from + entry.land;
      if (entry.first === null || Math.abs(entry.first - land) > 0.03) {
        trouble.push(
          `${entry.what} reaches full opacity at ` +
            `${entry.first === null ? 'no point' : `${entry.first.toFixed(2)}s`}, ` +
            `not the ${land.toFixed(2)}s its reading row claims`,
        );
      }
      if (!isStill && entry.rows > entry.maxLines) {
        trouble.push(
          `${entry.what} wraps to ${entry.rows} rows, more than the ${entry.maxLines} it is set for`,
        );
      }
    }
    const totalWords = reading.reduce((sum, e) => sum + e.words, 0);
    const totalHeld = reading.reduce((sum, e) => sum + e.hold, 0);
    const slowest = reading
      .filter((e) => e.tier !== 'still' && e.hold > 0)
      .reduce((worst, e) => Math.max(worst, e.words / e.hold), 0);
    console.log(
      `cut:   ${totalWords} words of copy, ${totalHeld.toFixed(1)}s held at full opacity, ` +
        `nothing faster than ${slowest.toFixed(1)} words a second`,
    );
    // Written beside the frames so the review page can print what was measured
    // rather than what was intended.
    writeFileSync(
      join(outDir, 'reading.json'),
      `${JSON.stringify(
        {
          step: READ_STEP,
          words: totalWords,
          held: Number(totalHeld.toFixed(3)),
          lines: reading.map(
            ({ line, what, scene, words, tier, budget, hold, first, last, rows, maxLines }) => ({
              line,
              what,
              scene,
              words,
              tier,
              budget,
              hold: Number(hold.toFixed(3)),
              first,
              last,
              rows,
              maxLines,
            }),
          ),
        },
        null,
        2,
      )}\n`,
    );
    if (trouble.length) {
      throw new Error(
        'the cut is faster than its reading budget:\n  ' +
          trouble.join('\n  ') +
          '\nFix the line\u2019s ramp, its scene length, or its word count — not this check.',
      );
    }

    if (timeline) {
      // A seek that does not move the frame would cut thirty-four confident
      // seconds of nothing, so prove the clock moves before shooting the
      // sequence. One sample per scene, near its middle.
      const samples = EXPECTED_SCENES.map((scene) => Number(((scene.from + scene.to) / 2).toFixed(2)));
      const seen = [];
      for (const t of samples) {
        await cdp.send('Runtime.evaluate', { expression: `window.__brag.seek(${t})` });
        const probe = await cdp.send('Runtime.evaluate', {
          returnByValue: true,
          expression: `(() => {
            let visible = null;
            let best = 0;
            for (const scene of document.querySelectorAll('.cut-scene')) {
              const opacity = Number(scene.style.opacity || 0);
              if (opacity > best) {
                best = opacity;
                visible = scene.dataset.scene;
              }
            }
            return { visible, progress: document.querySelector('.cut-progress-fill').style.width };
          })()`,
        });
        seen.push(probe?.result?.value);
      }
      console.log(`cut: seek check ${seen.map((s) => `${s.visible}@${s.progress}`).join('  ')}`);
      const distinct = new Set(seen.map((s) => s.visible));
      if (distinct.size !== samples.length) {
        throw new Error(
          `seeking did not move the cut between scenes (saw ${[...distinct].join(', ')} over ` +
            `${samples.length} samples) — the timeline script is not painting frames.`,
        );
      }

      console.log(`cut: shooting ${total} frames at ${fps} fps (${DURATION}s)`);
      const started = Date.now();
      for (let index = 0; index < total; index++) {
        const t = index / fps;
        await cdp.send('Runtime.evaluate', { expression: `window.__brag.seek(${t})` });
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
        });
        const file = join(framesDir, FRAME_NAME(index));
        writeFileSync(file, Buffer.from(shot.data, 'base64'));

        const size = pngSize(file);
        if (!size || size.width !== WIDTH || size.height !== HEIGHT) {
          throw new Error(`${file} is not ${WIDTH}x${HEIGHT} (${JSON.stringify(size)})`);
        }
        if (index % fps === 0 || index === total - 1) {
          const elapsed = (Date.now() - started) / 1000;
          const rate = (index + 1) / elapsed;
          console.log(
            `cut:   ${String(index + 1).padStart(4)}/${total}  t=${t.toFixed(3)}s  ` +
              `${rate.toFixed(1)} fps  ${statSync(file).size} B  eta ${((total - index - 1) / rate).toFixed(0)}s`,
          );
        }
      }
      console.log(`cut: ${total} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }

    // The bed, rendered by the same browser: `brag/music.bed.js` is injected and
    // evaluated in the page, because OfflineAudioContext is the only headless
    // path that yields bytes (see #31).
    const score = readFileSync(join(ROOT, 'brag', 'music.bed.js'), 'utf8');
    const bed = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      timeoutMs: 120_000,
      expression: `(async () => {
        ${score}

        const rate = 44100;
        const ctx = new OfflineAudioContext(2, Math.round(rate * ${DURATION}), rate);
        const normalize = renderBed(ctx);
        const buffer = await ctx.startRendering();
        const stats = normalize(buffer);

        // 16-bit PCM WAV, interleaved.
        const channels = buffer.numberOfChannels;
        const frames = buffer.length;
        const bytes = frames * channels * 2;
        const view = new DataView(new ArrayBuffer(44 + bytes));
        const text = (offset, value) => {
          for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
        };
        text(0, 'RIFF');
        view.setUint32(4, 36 + bytes, true);
        text(8, 'WAVE');
        text(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, channels, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * channels * 2, true);
        view.setUint16(32, channels * 2, true);
        view.setUint16(34, 16, true);
        text(36, 'data');
        view.setUint32(40, bytes, true);

        const data = [];
        for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
        let offset = 44;
        for (let i = 0; i < frames; i++) {
          for (let c = 0; c < channels; c++) {
            const sample = Math.max(-1, Math.min(1, data[c][i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
          }
        }

        let binary = '';
        const raw = new Uint8Array(view.buffer);
        for (let i = 0; i < raw.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, raw.subarray(i, i + 0x8000));
        }
        return {
          seconds: frames / rate,
          channels,
          rate,
          peak: stats.peak,
          rms: stats.rms,
          appliedGain: stats.appliedGain,
          base64: btoa(binary),
        };
      })()`,
    });

    const rendered = bed?.result?.value;
    if (!rendered) throw new Error('the bed returned no audio');
    if (Math.abs(rendered.seconds - DURATION) > 0.001) {
      throw new Error(`the bed is ${rendered.seconds}s long, expected ${DURATION}s`);
    }
    // The trap #31 recorded: a WAV that exists is not a WAV that sounds.
    if (!(rendered.peak > 0.2)) {
      throw new Error(
        `the bed is silence (peak ${rendered.peak}) — the score did not reach the buffer.`,
      );
    }
    writeFileSync(bedFile, Buffer.from(rendered.base64, 'base64'));
    console.log(
      `cut: bed ${rendered.seconds.toFixed(3)}s  ${rendered.channels}ch  ${rendered.rate} Hz  ` +
        `peak ${rendered.peak.toFixed(4)} normalized x${rendered.appliedGain.toFixed(2)}  ` +
        `rms ${rendered.rms.toFixed(4)}  ${(statSync(bedFile).size / 1024 / 1024).toFixed(2)} MB`,
    );

    // Independently: what the encoder sees, in dBFS.
    const levels = await ffmpeg(['-hide_banner', '-i', bedFile, '-af', 'volumedetect', '-f', 'null', '-']);
    const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(levels.stderr);
    const max = /max_volume:\s*(-?[\d.]+) dB/.exec(levels.stderr);
    console.log(`cut: bed levels — mean ${mean?.[1] ?? '?'} dB, max ${max?.[1] ?? '?'} dB`);
    if (!max || Number(max[1]) < -6) {
      throw new Error(`the bed peaks at ${max?.[1] ?? 'unknown'} dBFS — too quiet to be the mix.`);
    }
  } finally {
    if (cdp) cdp.close();
    if (browser) killChrome(browser, profile);
    if (server) server.close();
    if (restore) {
      console.log('cut: restoring the default build');
      const code = await buildWith(process.env);
      if (code !== 0) console.warn(`cut: the default build exited ${code}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Mux. No video filters at all: the frames are the final render, the bed is the
// final mix, so this step is a container change and cannot alter the edit.

if (only === 'mux' || only === null) {
  const last = join(framesDir, FRAME_NAME(total - 1));
  if (!existsSync(last)) {
    throw new Error(
      `${last} is missing — shoot the frames first (node brag/cut.mjs), or pass the --fps ` +
        'matching the run that wrote them.',
    );
  }
  if (!existsSync(bedFile)) {
    throw new Error(`${bedFile} is missing — run \`node brag/cut.mjs --only bed\` first.`);
  }

  console.log(`cut: muxing ${total} frames @ ${fps} fps + ${bedFile}`);
  await ffmpeg([
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', join(framesDir, '%05d.png'),
    '-i', bedFile,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '17',
    '-pix_fmt', 'yuv420p',
    // A keyframe every two seconds: seeking in a shared clip is common.
    '-g', String(fps * 2),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-shortest',
    '-movflags', '+faststart',
    videoFile,
  ]);

  // Verify the container, not the intent: a mux that silently dropped the
  // audio stream, or stretched the sequence, would still produce a file.
  const probe = await run(FFPROBE, [
    '-hide_banner',
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    videoFile,
  ]);
  if (probe.code !== 0) throw new Error(`ffprobe failed:\n${probe.stderr}`);
  const info = JSON.parse(probe.stdout);
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const seconds = Number(info.format?.duration ?? 0);

  if (!video) throw new Error('the muxed file has no video stream');
  if (!audio) throw new Error('the muxed file has no audio stream — the bed was dropped');
  if (video.width !== WIDTH || video.height !== HEIGHT) {
    throw new Error(`the video is ${video.width}x${video.height}, expected ${WIDTH}x${HEIGHT}`);
  }
  if (Math.abs(seconds - DURATION) > 0.12) {
    throw new Error(
      `the file runs ${seconds.toFixed(3)}s, expected ${DURATION}s — the frame count and the ` +
        `rate disagree (${total} frames at ${fps} fps is ${(total / fps).toFixed(3)}s).`,
    );
  }

  console.log(
    `cut: ${videoFile}\n` +
      `cut:   ${(statSync(videoFile).size / 1024 / 1024).toFixed(2)} MB  ${seconds.toFixed(3)}s  ` +
      `${video.codec_name}/${video.pix_fmt} ${video.width}x${video.height} @ ${video.r_frame_rate}  ` +
      `${audio.codec_name} ${audio.sample_rate} Hz ${audio.channels}ch`,
  );
}

if (only === 'sheet' || only === null) {
  const review = writeReview(outDir);
  console.log(
    `cut: ${review.file} \u2014 ${review.beats} beat(s), ` +
      `${(statSync(review.file).size / 1024 / 1024).toFixed(2)} MB, self-contained`,
  );
}
