#!/usr/bin/env node
/**
 * Guards the brag capture surface against drifting from the console it copies.
 *
 * `src/pages/brag/[state].astro` reproduces the markup of
 * `src/components/AskLibraryDemo.astro` so the real `global.css` styles apply
 * without touching the shipped demo. The cost of that choice is drift: if the
 * demo renames `.ask-source-seg`, the capture surface keeps the old name, the
 * rule stops matching, and the video silently shows a broken slip that nobody
 * notices until it is cut.
 *
 * So: every `ask-*` class the surface uses must exist in the demo component.
 * The surface may use fewer classes than the demo (it renders one state at a
 * time); it may not invent any.
 *
 * Reads source, not a build, so it runs in CI without a capture build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = join(ROOT, 'src/components/AskLibraryDemo.astro');
const SURFACE = join(ROOT, 'src/pages/brag/[state].astro');

/** Every class token in a file's static `class="..."` attributes. */
function classesIn(file) {
  const source = readFileSync(file, 'utf8');
  const found = new Set();
  for (const [, value] of source.matchAll(/class="([^"]*)"/g)) {
    for (const token of value.split(/\s+/).filter(Boolean)) found.add(token);
  }
  return found;
}

/**
 * Classes the surface styles for itself, in its own inline <style> block. A few
 * are legitimate additions (`.ask-cite` marks the real `[E-...]` keys), so a
 * class is only a problem if nothing anywhere styles it.
 */
function locallyStyled(file) {
  const source = readFileSync(file, 'utf8');
  const block = source.match(/<style is:inline>([\s\S]*?)<\/style>/);
  if (!block) return new Set();
  return new Set([...block[1].matchAll(/\.([a-zA-Z][\w-]*)/g)].map(([, name]) => name));
}

const demo = classesIn(DEMO);
const surface = classesIn(SURFACE);
const local = locallyStyled(SURFACE);

// Only the console's own namespace is checked: `btn`/`sr-only` come from the
// site's global styles and are shared far beyond this component.
const invented = [...surface]
  .filter((name) => name.startsWith('ask-'))
  .filter((name) => !demo.has(name) && !local.has(name))
  .sort();

const relativeSurface = relative(ROOT, SURFACE);

if (invented.length > 0) {
  console.error(
    `check-surface: ${relativeSurface} uses ${invented.length} class(es) that ` +
      `${relative(ROOT, DEMO)} does not define:`,
  );
  for (const name of invented) console.error(`  .${name}`);
  console.error(
    '\nThe capture surface copies the demo so the real stylesheet applies. ' +
      'Either the demo renamed these and this file needs the same rename, or ' +
      'the surface invented a class that has no styles.',
  );
  process.exit(1);
}

const fromDemo = [...surface].filter((name) => name.startsWith('ask-') && demo.has(name)).length;
const ownCount = [...surface].filter((name) => name.startsWith('ask-') && local.has(name)).length;
console.log(
  `check-surface: ${relativeSurface} uses ${fromDemo} ask-* class(es) defined by the demo ` +
    `and ${ownCount} it styles itself; none invented.`,
);
