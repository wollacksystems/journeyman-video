/**
 * Shared capture runtime for the brag pipeline.
 *
 * `capture.mjs` (shoot the three demo frames) and `cut.mjs` (shoot the 20s
 * cut's timeline and mux it) both need the same four things: a discovered
 * Chromium, a static server for `dist/`, a CDP client, and a gated build. They
 * live here rather than in either driver so the two cannot drift — the cut must
 * be shot through the exact same viewport, font stack, and browser flags the
 * verified frames were.
 *
 * There are no dependencies on purpose: the site repo has no Playwright, and it
 * does not need one. Node ships both `fetch` and a WebSocket client, which is
 * all CDP takes, and the Chromium is discovered in the same ms-playwright cache
 * the render drivers use (or passed as BRAG_CHROME).
 *
 * This file is deliberately mechanism-only. Anything that *asserts* about a
 * frame (fonts loaded, viewport, overflow, the source stamp) belongs to the
 * driver that knows what that frame is supposed to show.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = join(ROOT, 'dist');

/** The frame. Every brag artifact is exactly this size. */
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** The faces the cards need; DESIGN.md is the reason each one is here. */
export const FONT_FAMILIES = ['Instrument Serif', 'Inter', 'JetBrains Mono'];

export const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@600&display=swap';

export const STEP_TIMEOUT_MS = 30_000;
export const LAUNCH_TIMEOUT_MS = 20_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Chromium to drive: an explicit override, or the ms-playwright cache. */
export function findChrome() {
  const explicit = process.env.BRAG_CHROME;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`BRAG_CHROME=${explicit} does not exist`);
    return explicit;
  }

  const localAppData = process.env.LOCALAPPDATA;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    localAppData && join(localAppData, 'ms-playwright'),
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    '/usr/bin',
    '/usr/local/bin',
    '/Applications/Google Chrome.app/Contents/MacOS',
  ].filter((root) => root && existsSync(root));

  const relatives = [
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-linux', 'chrome'],
    ['chrome-linux64', 'chrome'],
  ];

  const found = [];
  for (const root of roots) {
    // Newest chromium-* first, so capture matches what the render drivers use.
    const versions = readdirSync(root)
      .filter((name) => /^chrom(e|ium)-/.test(name))
      .sort()
      .reverse();
    for (const version of versions) {
      for (const relative of relatives) {
        const candidate = join(root, version, ...relative);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
    for (const bare of ['chrome', 'google-chrome', 'chromium']) {
      const candidate = join(root, bare);
      if (existsSync(candidate)) found.push(candidate);
    }
  }

  if (found.length === 0) {
    throw new Error(
      'no Chromium found. Install one (npx playwright-core install chromium), ' +
        'or point BRAG_CHROME at a Chrome/Chromium binary.',
    );
  }
  return found[0];
}

/** Exactly 1920x1080, read back from the PNG's own IHDR. */
export function pngSize(file) {
  const header = readFileSync(file).subarray(0, 24);
  if (header.length < 24 || header.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  // The cut is assembled from stills on disk, so the capture server has to be
  // able to hand one back to the page.
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

/** Serve `dist/` — enough for a static Astro build, directory indexes included. */
export function serve(root, extraRoutes = {}) {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);

    for (const [prefix, dir] of Object.entries(extraRoutes)) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        const rest = pathname.slice(prefix.length).replace(/^\/+/, '');
        const target = resolve(join(dir, rest));
        if (!target.startsWith(resolve(dir)) || !existsSync(target)) {
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
        res.end(readFileSync(target));
        return;
      }
    }

    let target = resolve(join(root, pathname));
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
    if (!existsSync(target)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

/**
 * A minimal CDP client: send a command, await its reply, and let a caller wait
 * on one event. `once` subscribes *before* the caller triggers the event, which
 * is what makes `Page.loadEventFired` reliable across a navigation.
 */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const waiting = this.waiters.get(message.method);
      if (!waiting) return;
      this.waiters.delete(message.method);
      waiting(message.params);
    });
  }

  send(method, params = {}, timeoutMs = STEP_TIMEOUT_MS) {
    const id = ++this.nextId;
    return new Promise((ok, no) => {
      const timer = setTimeout(
        () => no(new Error(`CDP ${method} did not answer within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          ok(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          no(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = STEP_TIMEOUT_MS) {
    return new Promise((ok, no) => {
      const timer = setTimeout(
        () => no(new Error(`CDP never saw ${method} within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.waiters.set(method, (params) => {
        clearTimeout(timer);
        ok(params);
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** Chrome, with the devtools port written into `profile/DevToolsActivePort`. */
export function launchChrome(chrome, profile) {
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // The page is 2D DOM; the GPU process only crashed here.
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  return child;
}

/** Best-effort teardown of *our* browser process tree, never the user's. */
export function killChrome(child, profile) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32' && child.pid) {
    // Chrome forks; killing the parent can leave children holding the profile.
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* a locked profile dir is not worth failing the run over */
  }
}

export function makeProfile(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function connect(chrome, profile) {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('chrome never wrote DevToolsActivePort');
    await sleep(100);
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();

  let target = null;
  while (!target) {
    if (Date.now() > deadline) throw new Error('chrome exposed no page target');
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
    } catch {
      /* the endpoint is not up yet */
    }
    if (!target) await sleep(100);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => no(new Error('CDP websocket failed to open')), {
      once: true,
    });
  });
  return new Cdp(ws);
}

/** `npm` is a shell script off Windows and a .cmd on it. */
export function buildWith(env) {
  // Windows runs `npm run build` through cmd.exe as one string: Node (>=20.12,
  // CVE-2024-27980) refuses to spawn a .cmd directly, and passing args *with*
  // shell:true is deprecated for being unsafe. Elsewhere spawn npm as usual.
  const child =
    process.platform === 'win32'
      ? spawn('npm run build', { stdio: 'inherit', cwd: ROOT, shell: true, env })
      : spawn('npm', ['run', 'build'], { stdio: 'inherit', cwd: ROOT, env });
  return new Promise((ok) => {
    child.on('error', () => ok(1));
    child.on('close', (code) => ok(code ?? 1));
  });
}

/** Whether the Google Fonts stylesheet is reachable — the cards depend on it. */
export async function fontsReachable() {
  try {
    return (await fetch(FONT_CSS)).ok;
  } catch {
    return false;
  }
}

/**
 * Load the page, prove every face the cards use actually rendered, and hand
 * back the probe. A silent fallback would produce plausible-looking frames in
 * Georgia and Helvetica that no longer match the product.
 */
export async function loadWithFonts(cdp, url, families = FONT_FAMILIES) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;

  const probe = await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const families = ${JSON.stringify(families)};
      // Ask for each face explicitly. document.fonts.ready only waits on fonts
      // the page has already *used*, and the scenes use different ones.
      // fonts.load requests them, so this proves all three are genuinely
      // fetchable rather than quietly absent. An unknown family resolves with
      // zero faces.
      const loaded = {};
      for (const family of families) {
        const faces = await document.fonts.load('16px "' + family + '"');
        loaded[family] = faces.length > 0;
      }
      await document.fonts.ready;
      return Object.fromEntries(
        families.map((f) => [f, loaded[f] && document.fonts.check('16px "' + f + '"')]),
      );
    })()`,
  });

  const fonts = probe?.result?.value;
  if (!fonts) throw new Error('the page returned no font probe');
  const missing = Object.entries(fonts)
    .filter(([, ok]) => !ok)
    .map(([family]) => family);
  if (missing.length > 0) {
    throw new Error(
      `these webfonts did not load: ${missing.join(', ')}. The frames would render in ` +
        'fallback faces and stop matching the product — fix the network, or self-host the fonts.',
    );
  }
  return fonts;
}
