# Provenance

Every file here started somewhere else. This is the record of what came from
where, so a future reader can tell imported work from new work and re-sync the
vendored files against the site.

## Vendored from `wollacksystems/wollacksystems.github.io`

Taken at commit **`3e9e575cd3027b8430c80ee0a1c205ea6613e952`**
(*feat: surface the recording and consent commitments in a trust band (#16)*).

These six files are byte-for-byte copies. Do not reformat them — the drift
guard reads them mechanically, and a reformat is a diff nobody can review.

| File in this repo | Bytes | SHA-256 |
| --- | --- | --- |
| `src/styles/global.css` | 21066 | `c4c37cf29e94aa665bbe45fe0e9785b7ab1f3746b3c20a3f9537a385a8556d51` |
| `src/components/BrandMark.astro` | 1034 | `295f33bebb8dde9e4c07bfc3995f1bdb75b4f18edefba7318bc32e750b74c8ae` |
| `src/components/AskLibraryDemo.astro` | 6543 | `b3fc9074c16d0554f7213b4e24cdf67a9a3ce6720066de1855a3fb1daa42b7ab` |
| `src/lib/brand.ts` | 3035 | `46b90c4aef4a765b677e7dd395b02ac64bdebf0428663b678f50023d3b8c7ce2` |
| `src/lib/library-demo.ts` | 5480 | `ea34f440f2a7dd24f8024ab83ec7efc9e56d0d3e1ddb2e421a69ff053e7ef603` |
| `src/lib/retrieval.ts` | 4256 | `492f5aebd107df4d75bc3f4a4d04885190cb8313e541de55c1eb3054ad6c8ae0` |

Every path above sits at the origin path of the same name — nothing was renamed
on the way in, which is what lets the pipeline's root-relative lookups work
unchanged.

Why each one is here:

- **`global.css`** — the capture surface inlines it (`readFileSync` on
  `src/styles/global.css`) rather than importing it, so that rendering the
  capture pages cannot rename the site's shared CSS chunk and change the
  content hash every shipped page points at.
- **`BrandMark.astro`** — imported directly by the timeline for the closing mark.
- **`AskLibraryDemo.astro`** — **not rendered.** It is the reference the class
  drift guard compares against. See the caveat in the README.
- **`lib/brand.ts`**, **`lib/library-demo.ts`**, **`lib/retrieval.ts`** —
  transitively imported by the two components above. None of them import
  anything themselves; the closure stops here.

### Re-syncing

```bash
gh api repos/wollacksystems/wollacksystems.github.io/contents/src/styles/global.css?ref=3e9e575 --jq .content
```

Replace each file with the newer upstream version, update the SHA-256 above and
the commit id, then run `npm run check:surface`. A newer commit that no longer
supplies these three files is a signal to revisit the split rather than to
force it.

## Imported from the site repo's uncommitted work

Written here originally, on 2026-09-25, and never committed to the site repo.
They moved here unchanged.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `src/components/BragTimeline.astro` | 40219 | `0dfd7c915f1e9295dfda6a19f789c395a034bfd36136edf0c5d93bd1798b006c` |
| `src/pages/brag/[state].astro` | 12702 | `99992d8ab6deead3f031ebee9db18c41b4e69c26f6d85418d85340f2639634f3` |
| `brag/fixture.json` | 6908 | `e37395ecf303eb761287d90a280a479ae596355526df041aa286922a0f059504` |
| `brag/raw/abstention.json` | 1752 | `bf3a05d2df3c6a9f64781cf20e962ed3f1024291b011e92894e26bae056a79c5` |
| `brag/raw/answer.json` | 2564 | `79d05aeb9863abdacedab345005f01410f76d8518507e5be97de29c78cb180bf` |

`brag/runtime.mjs`, `brag/capture.mjs`, `brag/capture-fixture.mjs`,
`brag/cut.mjs`, `brag/check-surface.mjs` and `brag/music.bed.js` are the same
author's work and moved as-is.

## The deliverable

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `assets/journeyman-brag.mp4` | 3689709 | `54245cfa4456f4d462b9c7bebd319025b08cd9df3cc353d867447c2605cb0720` |

`h264 High / yuv420p, 1920x1080, 24 fps, 816 frames, CRF 17, closed GOP 48,
+faststart`, `aac 44.1 kHz stereo`. 34.000 s exactly.

Regenerating it is expected to produce a **byte-different** file: the music bed
is synthesized through a float32 audio graph, so two renders of the same seeded
score differ by about ±1 LSB in 625 of 1.76 M samples. The frames hash
identically; the audio does not. See "Known limits" in the README.