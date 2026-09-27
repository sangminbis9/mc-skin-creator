import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { FACE_IDENTITY_GEOMETRY_SCHEMA, parseFaceIdentityGeometry, runFaceIdentityGeometryAnalysis, validateFaceGeometryProviderShape, type FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import type { CompactV3Schema } from "../src/compactPhotoAnalysisV3";
import type { Env } from "../src/types";
import { decodeImage } from "../src/png";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const roots = [
  "evaluation-artifacts/v4-wavy-saved-face-crop-geometry-live-20260925-001",
  "evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002",
];
const crops = [
  { path: "evaluation-artifacts/v4-saved-localization-crop-readiness-20260925-001/face-crop.png",
    hash: "26be2fb184d5497fa19ec5be826df248c53807db399408f5fa559f836adffab1", width: 185, height: 192 },
  { path: "evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002/face-crop.png",
    hash: "e67afbb8d0a9fa9b1eca6741a82f56f94e976492bab5a29b34bea939923a95a2", width: 320, height: 344 },
];
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function acceptedObservations() {
  const records = await Promise.all(roots.map(root => readLatestAuditCheckpoint(path.resolve(root, "summary.json"))));
  for (const record of records) expect(record?.snapshotSha256).toBe(sha(record?.snapshot));
  const normal = (records[0]!.snapshot as { savedV4FaceGeometry: { acceptedGeometry: FaceIdentityGeometryAnalysis; normalOpenness: number } }).savedV4FaceGeometry;
  const open = (records[1]!.snapshot as { v4Open: { acceptedGeometry: FaceIdentityGeometryAnalysis; openOpenness: number } }).v4Open;
  return { records, normal, open };
}

function providerWire(schema: CompactV3Schema, value: unknown): unknown {
  if (value === null) return null;
  if (schema.properties) return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) =>
    [key, providerWire(child, (value as Record<string, unknown>)[key])]));
  return value;
}

it("reads both authoritative accepted observations without a rounded report projection", async () => {
  const { records, normal, open } = await acceptedObservations();
  expect(records.map(record => record?.sequence)).toEqual([31, 40]);
  expect(normal.normalOpenness).toBe(0.5);
  expect(open.openOpenness).toBe(0.5);
  expect(acceptedFaceGeometry(normal.acceptedGeometry).eyes.openness).toBe(normal.normalOpenness);
  expect(acceptedFaceGeometry(open.acceptedGeometry).eyes.openness).toBe(open.openOpenness);
  expect(normal.acceptedGeometry.confidence.eyes).toBe(0.95);
  expect(open.acceptedGeometry.confidence.eyes).toBe(0.95);
});

it("verifies the two exact source crops without resizing or re-encoding", async () => {
  for (const crop of crops) {
    const bytes = await readFile(path.resolve(crop.path));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(crop.hash);
    const decoded = await decodeImage(bytes);
    expect([decoded.width, decoded.height]).toEqual([crop.width, crop.height]);
  }
});

it.each([0, 0.25, 0.5, 0.6, 0.73, 1])("preserves exact openness %s through extraction, validation, projection and checkpoint", async openness => {
  const { normal } = await acceptedObservations();
  const raw = providerWire(FACE_IDENTITY_GEOMETRY_SCHEMA, normal.acceptedGeometry) as Record<string, unknown>;
  (raw.eyes as Record<string, unknown>).openness = openness;
  const run = vi.fn(async () => ({ response: raw }));
  const result = await runFaceIdentityGeometryAnalysis({ AI: { run } } as unknown as Env, "data:image/png;base64,AQID");
  expect(run).toHaveBeenCalledTimes(1);
  expect(result.providerShapeValid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.measurements?.eyes.openness).toBe(openness);
  expect(result.geometry?.eyes.openness).toBe(openness);
  const projected = acceptedFaceGeometry(result.geometry!);
  expect(projected.eyes.openness).toBe(openness);
  const directory = await mkdtemp(path.join(tmpdir(), "openness-fidelity-"));
  try {
    const file = path.join(directory, "summary.json");
    await atomicCheckpoint(file, { acceptedGeometry: projected, reportedOpenness: projected.eyes.openness }, "accepted");
    const restored = await readLatestAuditCheckpoint(file);
    expect((restored?.snapshot as { acceptedGeometry: FaceIdentityGeometryAnalysis }).acceptedGeometry.eyes.openness).toBe(openness);
    expect((restored?.snapshot as { reportedOpenness: number }).reportedOpenness).toBe(openness);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each([undefined, null, "0.5", NaN, Infinity, -Infinity])("rejects non-numeric or absent openness %s without defaulting", async openness => {
  const { normal } = await acceptedObservations();
  const raw = providerWire(FACE_IDENTITY_GEOMETRY_SCHEMA, normal.acceptedGeometry) as Record<string, unknown>;
  if (openness === undefined) delete (raw.eyes as Record<string, unknown>).openness;
  else (raw.eyes as Record<string, unknown>).openness = openness;
  expect(validateFaceGeometryProviderShape(raw).length).toBeGreaterThan(0);
  expect(parseFaceIdentityGeometry(raw)).toBeNull();
  const run = vi.fn(async () => ({ response: raw }));
  const result = await runFaceIdentityGeometryAnalysis({ AI: { run } } as unknown as Env, "data:image/png;base64,AQID");
  expect(run).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(false);
  expect(result.geometry).toBeNull();
});
