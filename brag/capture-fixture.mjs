#!/usr/bin/env node
/**
 * Capture the real endpoint bytes the brag's demo scenes replay.
 *
 * The cut shows a grounded answer and an abstention. Both must be *real*
 * service output, so this script records the verbatim HTTP response bodies and
 * the metadata around them, then derives the structured fixture the capture
 * surface reads. Nothing in the fixture is retyped by hand: run
 * `node brag/capture-fixture.mjs --capture`, then `node brag/capture-fixture.mjs`.
 *
 * Why freeze rather than screen-record: the model's citations vary run to run.
 * Two captures of the same in-corpus question in this project cited different
 * narration rows, so a live recording is not reproducible and the video could
 * not be rebuilt. The bytes are real; only their replay is scripted.
 *
 * Requires no dependencies — Node's fetch and fs only.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(HERE, "raw");
const FIXTURE = join(HERE, "fixture.json");

const ENDPOINT =
  "https://br-rough-heart-b5xnq94n-agent.compute.c-7.us-east-2.aws.neon.tech/";

/**
 * The two brag scenes. `answer` is in-corpus and must retrieve the ATC scenario;
 * `abstention` is deliberately out of corpus and must refuse rather than invent.
 */
const CASES = [
  {
    id: "answer",
    role: "in-corpus",
    question:
      "The tool changer stopped in the middle of a tool change. Should I keep resetting it?",
  },
  {
    id: "abstention",
    role: "out-of-corpus",
    question: "How do I recalibrate the spindle laser interferometer?",
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** mm:ss.s as seconds, for the source stamp and the scrub position. */
function clockSeconds(clock) {
  const parts = clock.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * One rendered evidence row, e.g.
 *   [E-...-lesson] atc-jam-env-00 — unknown source @ 00:00.0-00:50.0: An ATC...
 * The camera is the literal string `unknown source` for rows with no camera, so
 * the stamp picker below can skip them.
 */
function parseEvidence(evidence) {
  return evidence
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^\[([^\]]+)\]\s+(.+?)\s+—\s+(.+?)\s+@\s+(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?):\s*([\s\S]*)$/);
      if (!m) return { key: null, raw: line };
      const [, key, scenario, camera, startClock, endClock, text] = m;
      return {
        key,
        scenario,
        camera,
        startClock,
        endClock,
        text,
        hasCamera: camera !== "unknown source",
      };
    });
}

function buildStamp(entry, verifiedKeys) {
  if (!entry || !entry.hasCamera) return null;
  // The session is the full scenario clip the evidence came from; the scrub
  // shows where inside it the cited moment sits. 50s is the corpus' clip
  // length, and every row in this corpus is drawn from a 50s scenario.
  const sessionSeconds = 50;
  const startSec = clockSeconds(entry.startClock);
  const endSec = clockSeconds(entry.endClock);
  return {
    key: entry.key,
    camera: entry.camera.toUpperCase(),
    scenario: entry.scenario,
    startClock: entry.startClock,
    endClock: entry.endClock,
    durationSeconds: +(endSec - startSec).toFixed(1),
    text: entry.text,
    scrubPercent: Math.round((startSec / sessionSeconds) * 100),
    verified: verifiedKeys.includes(entry.key),
  };
}

async function capture() {
  mkdirSync(RAW_DIR, { recursive: true });
  for (const [i, c] of CASES.entries()) {
    if (i > 0) {
      // Voyage's free tier is 3 requests/minute; space the calls out.
      console.log("waiting 25s for the embedding rate limit…");
      await sleep(25_000);
    }
    const started = Date.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: c.question }] }),
    });
    const raw = await res.text();
    const record = {
      id: c.id,
      role: c.role,
      question: c.question,
      endpoint: ENDPOINT,
      capturedAt: new Date().toISOString(),
      httpStatus: res.status,
      elapsedMs: Date.now() - started,
      rawBytes: Buffer.byteLength(raw),
      body: raw,
    };
    writeFileSync(join(RAW_DIR, `${c.id}.json`), JSON.stringify(record, null, 2) + "\n");
    console.log(`${c.id}: HTTP ${res.status}, ${record.rawBytes} bytes, ${record.elapsedMs}ms`);
  }
}

function build() {
  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json")).sort();
  const cases = [];
  let capturedAt = null;

  for (const file of files) {
    const rec = JSON.parse(readFileSync(join(RAW_DIR, file), "utf8"));
    const body = JSON.parse(rec.body);
    const evidence = parseEvidence(body.evidence ?? "");
    const verified = body.citations?.verified ?? [];
    const withCamera = evidence.find((e) => e.hasCamera && verified.includes(e.key));
    // Prefer a *verified* row with a camera; fall back to any row with a camera
    // so the abstention scene can still show what retrieval returned.
    const anyWithCamera = evidence.find((e) => e.hasCamera);
    capturedAt = capturedAt ?? rec.capturedAt;
    cases.push({
      id: rec.id,
      role: rec.role,
      question: rec.question,
      httpStatus: rec.httpStatus,
      elapsedMs: rec.elapsedMs,
      answer: body.answer ?? "",
      citations: { verified, unverified: body.citations?.unverified ?? [] },
      evidence,
      stamp: buildStamp(withCamera ?? anyWithCamera, verified),
    });
  }

  const fixture = {
    schema: "brag-endpoint-fixture",
    schemaVersion: 1,
    provenance: {
      endpoint: ENDPOINT,
      capturedAt,
      request: 'POST {"messages":[{"role":"user","content":"..."}]}',
      transport: "identical to the deployed agent function's documented contract",
      note: "Verbatim response bodies live in brag/raw/. This file is derived from them; do not hand-edit.",
    },
    cases,
  };
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
  for (const c of cases) {
    console.log(
      `${c.id}: ${c.citations.verified.length} verified / ${c.citations.unverified.length} unverified, ` +
        `stamp ${c.stamp ? `${c.stamp.camera} @ ${c.stamp.startClock} (${c.stamp.verified ? "verified" : "retrieved"})` : "none"}`,
    );
  }
  console.log(`wrote ${FIXTURE}`);
}

if (process.argv.includes("--capture")) await capture();
else build();
