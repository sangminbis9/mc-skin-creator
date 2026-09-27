/** Offline contract verification only. Never imports the CLI live selector. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { extractAnalysisPayload } from "../src/analysis";
import auditWorker from "./primaryFaceMeasurementAuditWorker";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { APERTURE_INPUTS } from "./audit/eyeAperturePilotContract";
import { APERTURE_CROP_PATHS } from "./audit/eyeAperturePilot";
import { APERTURE_V2_OPTIONS, v2Measurements } from "./audit/eyeApertureV2LiveContract";
import { EYE_APERTURE_V2_PROMPT, EYE_APERTURE_V2_SCHEMA, EYE_APERTURE_V2_VERSION,
  type ApertureV2Eye, type EyeApertureV2Observation } from "./audit/eyeApertureV2Prototype";

const ROOT = path.resolve("evaluation-artifacts/eye-aperture-v2-signed-gap-review-20260926-001");
const PILOT = "evaluation-artifacts/eye-aperture-v2-first-live-check-20260926-001/summary.json";
const write = process.env.WRITE_APERTURE_V2_SIGNED_GAP_REVIEW === "approved-offline";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name); return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
});
const network = vi.fn(() => { throw new Error("external_network_forbidden"); });
const rows: object[] = [];
let image: string;
let historical: Record<string, unknown>;
let baseline: Record<string, string> = {};
let start: object;
const id = () => randomBytes(16).toString("hex");
const fixture = (u = -2, l = 3): EyeApertureV2Observation => ({
  version: EYE_APERTURE_V2_VERSION, cropWidthPx: 185, cropHeightPx: 192, pose: "frontal",
  left: { visibility: "observed", outerCorner: { x: .2, y: .5 }, innerCorner: { x: .4, y: .5 },
    upperLidOffsetPx: u, lowerLidOffsetPx: l, confidence: .9 },
  right: { visibility: "observed", outerCorner: { x: .8, y: .5 }, innerCorner: { x: .6, y: .5 },
    upperLidOffsetPx: -4, lowerLidOffsetPx: 6, confidence: .7 },
});
const unavailable = (): ApertureV2Eye => ({ visibility: "unknown", outerCorner: { x: null, y: null },
  innerCorner: { x: null, y: null }, upperLidOffsetPx: null, lowerLidOffsetPx: null, confidence: 0 });
function freeze(value: unknown) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
}
beforeAll(async () => {
  vi.stubGlobal("fetch", network);
  expect(Object.keys(process.env).filter(k => /^RUN_BOUND_PROFILE/.test(k))).toEqual([]);
  const bytes = fs.readFileSync(APERTURE_CROP_PATHS[0]);
  expect(sha(bytes)).toBe(APERTURE_INPUTS[0].sha256);
  image = `data:image/png;base64,${bytes.toString("base64")}`; // in memory, fake binding only
  const record = await readLatestAuditCheckpoint(path.resolve(PILOT));
  expect(record).not.toBeNull(); expect(sha(JSON.stringify(record!.snapshot))).toBe(record!.snapshotSha256);
  const snapshot = record!.snapshot as { apertureV2: { slots: Array<{ outcome: Record<string, unknown>; accepted: unknown;
    derived: unknown; status: string; httpStatus: number; requestIdentity: object }>; fixedHashes: Record<string, string>;
    sourceSha256: string; posts: number; retry: number }; providerCalls: object };
  const batch = snapshot.apertureV2, first = batch.slots[0];
  expect(first).toMatchObject({ httpStatus: 200, accepted: null, derived: null,
    outcome: { providerOutcome: "returned", shapeValid: true, semanticContractValid: false, elapsedMs: 4062,
      semanticErrors: ["eyeApertureV2.left:nonpositive_or_nonfinite_gap", "eyeApertureV2.right:nonpositive_or_nonfinite_gap"] } });
  expect(batch.slots[1].status).toBe("not_attempted"); expect(batch.posts).toBe(1); expect(batch.retry).toBe(0);
  for (const [file, hash] of Object.entries(batch.fixedHashes)) expect(sha(fs.readFileSync(file))).toBe(hash);
  historical = { checkpointSequence: record!.sequence, checkpointSha256: record!.snapshotSha256,
    normal: { httpStatus: first.httpStatus, outcome: first.outcome, accepted: null, ratio: null },
    open: "not_attempted", providerCalls: snapshot.providerCalls, finalRequestIdentity: first.requestIdentity,
    fixedCodeHashesVerified: Object.keys(batch.fixedHashes).length, rejectedOffsetsAvailable: false,
    violationSubtype: "UNKNOWN", historicalWireBytesAvailable: false,
    limitation: "Recorded hashes are evidence, not reconstruction of the historical raw request or rejected values." };
  if (write) {
    expect(fs.existsSync(ROOT)).toBe(false);
    const files = new Set([...walk(path.resolve("evaluation-artifacts")), ...git("-C", "..", "ls-files", "--cached", "--others", "--exclude-standard", "-z")
      .split("\0").filter(Boolean).map(p => path.resolve("..", p)).filter(p => fs.existsSync(p) && fs.statSync(p).isFile())]);
    baseline = Object.fromEntries([...files].sort().map(p => [p, sha(fs.readFileSync(p))]));
    start = { head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), status: git("status", "--short", "--untracked-files=all"),
      diffSha256: sha(git("diff", "--no-ext-diff", "--binary")), numstat: git("diff", "--numstat"),
      preservedFileCount: files.size, baselineManifestSha256: sha(JSON.stringify(baseline)) };
  }
}, 60000);

async function boundary(label: string, raw: unknown, representation: "object" | "json" = "json") {
  const before = structuredClone(raw); freeze(raw);
  const response = { response: representation === "json" ? JSON.stringify(raw) : raw };
  const extracted = extractAnalysisPayload(response);
  expect(extracted).toEqual(before); // includes exact numeric types; nonfinite tested as native object
  const run = vi.fn(async (model: string, wire: unknown) => {
    expect(model).toBe(APERTURE_V2_OPTIONS.model);
    const input = wire as { messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      response_format: { json_schema: { schema: unknown } } };
    expect(input.messages[0].content.find(c => c.type === "text")?.text)
      .toBe(`${EYE_APERTURE_V2_PROMPT}\nCrop dimensions: 185 x 192 pixels.`);
    expect(input.response_format.json_schema.schema).toEqual(EYE_APERTURE_V2_SCHEMA);
    expect(sha(JSON.stringify(wire))).toBe("9f5fe19e9c55bb212afd4d27de721b448bf8f00f30d48bb370fc67a77c44b5fb");
    return response;
  });
  const gateway = vi.fn(() => { throw new Error("primary_forbidden"); }), token = id();
  const env = { PRIMARY_AUDIT_TOKEN: token, AI: { run, gateway } } as unknown as Env;
  const http = await auditWorker.fetch(new Request("http://offline.invalid/experimental-eye-aperture-v2-audit", {
    method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": id() },
    body: JSON.stringify({ imageDataUrl: image, batchRunId: id(), slot: 0 }),
  }), env);
  expect(http.status).toBe(200);
  const body = await http.json() as { shapeValid: boolean; semanticContractValid: boolean; shapeErrors: string[];
    semanticErrors: string[]; accepted: EyeApertureV2Observation | null };
  expect(raw).toEqual(before); expect(extracted).toEqual(before);
  expect(run).toHaveBeenCalledTimes(1); expect(gateway).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  if (body.accepted) expect(body.accepted).toEqual(before);
  else expect(body).not.toHaveProperty("measurement");
  const derived = body.accepted ? v2Measurements(body.accepted, 0) : null;
  rows.push({ label, providerOrigin: false, executionMode: "offline_synthetic", representation,
    shapeValid: body.shapeValid, semanticContractValid: body.semanticContractValid,
    shapeErrors: body.shapeErrors, semanticErrors: body.semanticErrors,
    leftGap: derived?.left.measurement?.gapPx ?? null, leftRatio: derived?.left.measurement?.ratio ?? null,
    leftAvailable: derived?.left.measurementAvailable ?? false, rightAvailable: derived?.right.measurementAvailable ?? false,
    bilateralMean: derived?.meanRatio ?? null, valuesAndTypesPreserved: true, inputUnmutated: true });
  return { body, derived };
}

for (const [u, l] of [[-2, 3], [1, 6], [-6, -1], [0, 5]]) it(`actual endpoint preserves signed offsets ${u},${l}`, async () => {
  const { body, derived } = await boundary(`signed_${u}_${l}`, fixture(u, l));
  expect(body.semanticContractValid).toBe(true);
  expect(derived!.left.measurement!.gapPx).toBe(5);
  expect(derived!.left.measurement!.ratio).toBeCloseTo(5 / 37);
  expect(derived!.left.measurement!.upperPx).toEqual({ x: 55.5, y: 96 + u });
  expect(derived!.left.measurement!.lowerPx).toEqual({ x: 55.5, y: 96 + l });
  expect(derived!.right.upperLidOffsetPx).toBe(-4); expect(derived!.right.lowerLidOffsetPx).toBe(6);
  expect(derived!.right.measurement!.gapPx).toBe(10);
});
for (const [u, l] of [[3, -2], [2, 2]]) it(`actual endpoint rejects gap ${l - u} before any accepted ratio`, async () => {
  const { body, derived } = await boundary(`invalid_gap_${l - u}`, fixture(u, l));
  expect(body.shapeValid).toBe(true); expect(body.semanticErrors).toEqual(["eyeApertureV2.left:nonpositive_or_nonfinite_gap"]);
  expect(body.accepted).toBeNull(); expect(derived).toBeNull();
});
for (const partial of [false, true]) it(`actual endpoint abstention with partial=${partial}`, async () => {
  const raw = fixture(); raw.right = unavailable(); if (!partial) raw.left = unavailable();
  const { body, derived } = await boundary(partial ? "partial" : "abstention", raw);
  expect(body.semanticContractValid).toBe(true); expect(derived!.right.measurement).toBeNull();
  expect(derived!.meanRatio).toBeNull(); expect(derived!.left.measurementAvailable).toBe(partial);
});
for (const [label, value, stage, error] of [
  ["null", null, "semantic", "eyeApertureV2.left:observed_requires_landmarks"],
  ["string", "3", "shape", "eyeApertureV2.left.upperLidOffsetPx:type"],
  ["nan", NaN, "shape", "eyeApertureV2.left.upperLidOffsetPx:range"],
  ["infinity", Infinity, "shape", "eyeApertureV2.left.upperLidOffsetPx:range"],
] as const) it(`actual extractor/endpoint invalid ${label}`, async () => {
  const raw = fixture(); const altered = { ...raw, left: { ...raw.left, upperLidOffsetPx: value } };
  const { body } = await boundary(label, altered, "object");
  expect(stage === "shape" ? body.shapeErrors : body.semanticErrors).toEqual([error]); expect(body.accepted).toBeNull();
});
it("missing field fails shape; JSON numeric overflow parses as infinity and fails shape", async () => {
  const raw = fixture(), left: Partial<ApertureV2Eye> = { ...raw.left }; delete left.upperLidOffsetPx;
  const missing = await boundary("missing", { ...raw, left });
  expect(missing.body.shapeErrors).toEqual(["eyeApertureV2.left.upperLidOffsetPx:required"]);
  const overflowJson = JSON.stringify(fixture()).replace('"upperLidOffsetPx":-2', '"upperLidOffsetPx":1e309');
  const parsed = extractAnalysisPayload({ response: overflowJson });
  expect((parsed!.left as ApertureV2Eye).upperLidOffsetPx).toBe(Infinity);
  const result = await boundary("parsed_numeric_overflow", parsed, "object");
  expect(result.body.shapeErrors).toEqual(["eyeApertureV2.left.upperLidOffsetPx:range"]);
});
it("finite subtraction overflow candidates fail reconstructed image bounds before gap", async () => {
  expect(Number.MAX_VALUE - -Number.MAX_VALUE).toBe(Infinity);
  const { body } = await boundary("finite_extreme_offsets", fixture(-Number.MAX_VALUE, Number.MAX_VALUE));
  expect(body.shapeValid).toBe(true); expect(body.semanticErrors).toEqual(["eyeApertureV2.left:lid_outside_image"]);
  expect(body.accepted).toBeNull();
});
it("tilted left/right normals remain positive-y without swapping or re-scaling signed offsets", async () => {
  const raw = fixture(); raw.pose = "mild_tilt";
  raw.left.outerCorner = { x: 37 / 185, y: 50 / 192 }; raw.left.innerCorner = { x: 67 / 185, y: 90 / 192 };
  raw.right.outerCorner = { x: 148 / 185, y: 50 / 192 }; raw.right.innerCorner = { x: 118 / 185, y: 90 / 192 };
  const { derived } = await boundary("tilted_normals", raw);
  expect(derived!.left.measurement!.normal.x).toBeCloseTo(-.8); expect(derived!.right.measurement!.normal.x).toBeCloseTo(.8);
  for (const side of ["left", "right"] as const) {
    expect(derived![side].measurement!.normal.y).toBeCloseTo(.6);
    expect(derived![side].measurement!.chordWidthPx).toBeCloseTo(50);
  }
  expect(derived!.left.measurement!.upperPx.x).toBeCloseTo(53.6);
  expect(derived!.left.measurement!.upperPx.y).toBeCloseTo(68.8);
  expect(derived!.left.measurement!.ratio).toBeCloseTo(.1);
  expect(derived!.right.measurement!.ratio).toBeCloseTo(.2);
});

afterAll(() => {
  expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  if (!write) return;
  const changed = Object.entries(baseline).filter(([file, hash]) => !fs.existsSync(file) || sha(fs.readFileSync(file)) !== hash).map(([file]) => file);
  expect(changed).toEqual([]); expect(fs.existsSync(ROOT)).toBe(false); fs.mkdirSync(ROOT);
  fs.writeFileSync(path.join(ROOT, "verification.json"), JSON.stringify({ start, historical,
    execution: { providerOrigin: false, executionMode: "offline_synthetic", externalNetwork: 0, remoteWrangler: 0,
      health: 0, gemini: 0, gemma: 0, geometryProvider: 0, evaluator: 0, packageManager: 0 },
    rows, preservation: { checked: Object.keys(baseline).length, changed },
  }, null, 2), { flag: "wx" });
}, 60000);
