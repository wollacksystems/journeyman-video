# journeyman-video

The 34-second Journeyman launch film, and the pipeline that renders it.

Six scenes, hook to tagline. A little under half the runtime — 16 of 34 seconds —
is the deployed endpoint's own output, replayed at native 1920x1080 through the
same console chrome the product ships. No puppet footage, no mocked response, no
narrator. One of those scenes is an **abstention**: a real question the evidence
did not answer, and the surface saying so instead of guessing.

The full cut, scene by scene, with the credits and the reading-budget
derivation, is written up in
[wollacksystems.github.io#17](https://github.com/wollacksystems/wollacksystems.github.io/issues/17).

## Spec

| | |
| --- | --- |
| Duration | 34.000 s exactly |
| Frame | 1920x1080, 24 fps, 816 frames |
| Video | `h264 High / yuv420p, CRF 17, closed GOP 48, +faststart` |
| Audio | `aac 44.1 kHz stereo`, synthesized — no recorded audio anywhere |
| Size | 3,689,709 bytes |

## The layout contract — read this before moving a file

The pipeline resolves paths relative to the repository root, and three files
depend on being exactly where they are:

- `brag/runtime.mjs` and `brag/check-surface.mjs` both derive
  `ROOT` as the parent of `brag/`.
- `src/pages/brag/[state].astro` reads `src/styles/global.css` from
  `process.cwd()`.
- `src/components/BragTimeline.astro` imports `./BrandMark.astro`.

So `brag/`, `src/components/`, `src/pages/brag/` and `src/styles/` are load-
bearing **relative positions**, not just directories. Nothing here was edited to
make it work in this repo — that is the point. If you restructure, you will break
the build in a way the error message will not explain.

## Prerequisites

- Node >= 22.12.0
- `npm install`
- **Chromium/Chrome** — headless, driven over CDP. Override with `BRAG_CHROME`.
- **ffmpeg** and **ffprobe** — override with `BRAG_FFMPEG` / `BRAG_FFPROBE`.
- Network access, for Google Fonts and (in the capture step) the endpoint.

`npm run build` and `npm run check` need none of the last three.

## Commands

```bash
npm run build          # emits ZERO pages — the capture surface is gated
npm run check          # astro check

npm run capture:fixture -- --capture   # hit the live endpoint, record raw bytes
npm run capture:fixture                # derive brag/fixture.json from raw/

npm run capture        # shoot the three console states at 1920x1080
npm run cut            # build, shoot 816 frames, synthesize the bed, mux, verify

npm run check:surface  # class drift guard — run before re-rendering
```

`npm run cut -- --only bed | mux | sheet` re-renders a single stage.

`npm run check:surface` is deliberately **not** in CI. Run it by hand before
re-cutting. The reason is in the next section.

## Why a default build emits nothing

`src/pages/brag/[state].astro` returns no paths from `getStaticPaths` unless
`BRAG_CAPTURE=1` is set:

```
BRAG_CAPTURE=1 npm run build && npx astro preview   # then capture
/brag/ask   /brag/answer   /brag/abstention   /brag/cut
```

So the capture surface is not a page of anything. A normal build leaves it out of
`dist/` entirely, which is what lets this repository exist without publishing a
half-working surface. CI asserts this by building without the flag.

## The drift guard, and what it no longer catches

`src/pages/brag/[state].astro` reproduces the markup of the site's
`AskLibraryDemo.astro` so the site's real stylesheet applies to it. That copy is
the video's honesty claim, and `check-surface.mjs` is what keeps the copy honest:
every `ask-*` class the surface uses must exist in the demo component.

**The guard now compares against a vendored copy, not the live site.** While it
lived in the site repo it read the real component, so it could not lie. It can now.
If the site renames `.ask-source-seg`, the vendored copy keeps the old name, the
guard passes, and the video silently shows an unstyled slip.

Two things bound that:

1. The vendored files are pinned by commit and hash in [PROVENANCE.md](PROVENANCE.md).
2. `npm run check:surface` fails loudly when the two drift — as long as someone
   runs it.

It is not in CI on purpose. `check-surface.mjs` needs a reference that CI would
have to fetch across repos, and a guard that only works when it is remembered
would be theatre. Running it by hand, immediately before a re-cut, is the version
that is actually true.

## Deliverables

| Path | What |
| --- | --- |
| `assets/journeyman-brag.mp4` | The cut. |
| `assets/share-copy.md` | LinkedIn, X, and one-liner copy for the cut. |

`brag/out/` is render scratch — 816 PNG frames, `cut.html`, `sheet.html`, and the
synthesized `bed.wav`, about 60 MB — and is gitignored. Re-rendering produces it
again; it is not the source of truth.

## Known limits, on the record

- **The frames are reproducible; the audio is not byte-for-byte.** Two renders of
  the same seeded score differ by about ±1 LSB in 625 of 1.76 M samples, because
  the browser's audio graph is float32. The seed controls the material, not the
  sample values. Frames hash identically across runs.
- **The cut is 34 s, not the 15–25 s its method asks for.** The method's own
  readability law and its brevity law disagree at this copy length, and
  readability won. Scene boundaries are *derived* from the reading budgets, not
  chosen. If the copy is ever shortened, re-derive the boundaries — do not trim
  them.
- **No poster frame.** The method asks for a best frame to be baked in as the
  idle thumbnail. Frame 0 here is the ground the piece arrives out of, which is
  honest but does not do the thumbnail's job.
- **The method was used; the renderer was not.** `/brag`'s own bundled renderer
  was never invoked on the machine that built this. The method is — the four
  steps, the tone presets, the creative laws, the deliverable list — implemented
  directly against Astro, Chromium, Web Audio and ffmpeg, because the cut has to
  be reproducible from a clean checkout. Credit for the method is the method's;
  the code is this repo's. No composition guarantees from that renderer apply
  here — the equivalent guarantee is the driver's own gates, which are fatal in
  the build rather than log lines.

## Origin

Extracted from [wollacksystems/wollacksystems.github.io](https://github.com/wollacksystems/wollacksystems.github.io),
where this work was written but never committed. The site repo keeps the launch
site and is unaffected: no file it ships was changed, and it builds zero capture
pages.