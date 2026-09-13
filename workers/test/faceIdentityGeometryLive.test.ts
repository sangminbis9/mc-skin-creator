import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { FACE_IDENTITY_GEOMETRY_SCHEMA, FACE_IDENTITY_GEOMETRY_PROMPT, FACE_GEOMETRY_MODEL, FACE_GEOMETRY_TIMEOUT_MS, faceIdentityGeometryRequest, runFaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { directBoundaryUsable } from "../src/directFaceContour";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import { GEMMA_IDENTITY_GEOMETRY_SCHEMA } from "../src/identityGeometryEnrichment";
import { workersAiStructuredInput } from "../src/gemini";
import { base64ToBytes, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import worker from "../src/index";
import type { Env } from "../src/types";
import type { AnnotatedCase } from "./generalizationSupport";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const json = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, "utf8"));
const optional = async (p: string) => { try { return await readFile(p); } catch { return null; } };
const FROZEN = "evaluation-artifacts/generalization-20260905";
const HISTORICAL = "evaluation-artifacts/head-structure-iteration-final";

type SavedFaceOnlyResult = {
  ok?: boolean;
  providerShapeValid?: boolean;
  semanticValid?: boolean;
  measurements?: {
    eyes?: Record<string, unknown>;
    brows?: Record<string, unknown>;
    nose?: Record<string, unknown>;
    mouth?: Record<string, unknown>;
    contour?: Record<"cheek" | "jaw" | "chin", { left: number | null; right: number | null; y: number | null; evidence: string; confidence: number }>;
    jawCheekRatio?: number | null;
  } | null;
  topology?: {
    cells?: { role: string }[];
    provenance?: Partial<Record<"cheek" | "jaw" | "chin", { width: number; provenance: string }>>;
    hairPlanUnchanged?: boolean;
    outfitPlanUnchanged?: boolean;
    geometryUsage?: Record<string, boolean>;
  } | null;
};

const isFiniteRecord = (value: unknown, fields: string[]) => !!value && typeof value === "object"
  && fields.every(field => Number.isFinite((value as Record<string, unknown>)[field]));

function lowerFaceBehavior(result: SavedFaceOnlyResult): "contour_emitted" | "broad_no_contour" | "collision_suppressed" | "unusable" {
  const direct = result.topology?.provenance;
  if (!direct?.cheek || !direct.jaw) return "unusable";
  if ((result.topology?.cells?.length ?? 0) > 0) return "contour_emitted";
  // Width 5 on both independently observed rows is the broad 8x8 family.
  // An empty result with a narrower row is kept separate: it may have been
  // suppressed by hair/covering/glasses ownership and is not quality evidence.
  return direct.cheek.width >= 5 && direct.jaw.width >= 5
    ? "broad_no_contour"
    : "collision_suppressed";
}

function activationEvidence(results: SavedFaceOnlyResult[]) {
  const ratios = new Set<string>();
  const behaviors = new Set<string>();
  let accepted = 0, usableFaceCore = 0, usableCheekJaw = 0, optionalChinValid = 0, directProvenanceValid = 0;
  let providerAndSemanticValid = true, noFabrication = true, hairFrozen = true, outfitFrozen = true;
  for (const result of results) {
    providerAndSemanticValid &&= result.ok === true && result.providerShapeValid === true && result.semanticValid === true;
    if (result.ok) accepted++;
    const measurements = result.measurements;
    if (measurements
      && isFiniteRecord(measurements.eyes, ["leftCenterX", "leftCenterY", "rightCenterX", "rightCenterY", "confidence"])
      && isFiniteRecord(measurements.brows, ["leftGap", "rightGap", "slope", "confidence"])
      && isFiniteRecord(measurements.nose, ["x", "y", "strength", "confidence"])
      && isFiniteRecord(measurements.mouth, ["x", "y", "width", "leftCornerY", "rightCornerY", "confidence"])) usableFaceCore++;
    const contour = measurements?.contour;
    const cheekJawUsable = !!contour && directBoundaryUsable(contour.cheek) && directBoundaryUsable(contour.jaw);
    if (cheekJawUsable) usableCheekJaw++;
    if (typeof measurements?.jawCheekRatio === "number") ratios.add(measurements.jawCheekRatio.toFixed(3));
    if (contour) {
      const chin = contour.chin;
      const exactUnknownChin = chin.evidence === "unknown" && chin.left === null && chin.right === null && chin.y === null && chin.confidence === 0;
      if (directBoundaryUsable(chin) || exactUnknownChin) optionalChinValid++;
      for (const boundary of [contour.cheek, contour.jaw, contour.chin]) {
        if (boundary.evidence === "unknown") noFabrication &&= boundary.left === null && boundary.right === null && boundary.y === null && boundary.confidence === 0;
      }
    }
    const provenance = result.topology?.provenance;
    if (cheekJawUsable && [provenance?.cheek?.provenance, provenance?.jaw?.provenance].every(value => value === "observed_geometry" || value === "inferred_geometry")) directProvenanceValid++;
    const behavior = lowerFaceBehavior(result);
    if (behavior === "contour_emitted" || behavior === "broad_no_contour") behaviors.add(behavior);
    hairFrozen &&= result.topology?.hairPlanUnchanged === true;
    outfitFrozen &&= result.topology?.outfitPlanUnchanged === true;
  }
  const requiredBehaviors = ["contour_emitted", "broad_no_contour"];
  return {
    accepted, providerAndSemanticValid, usableFaceCore, usableCheekJaw, optionalChinValid, directProvenanceValid, noFabrication,
    distinctRatios: ratios.size, lowerFaceBehaviors: [...behaviors].sort(), hairFrozen, outfitFrozen,
    pass: results.length === 3 && accepted === 3 && providerAndSemanticValid && usableFaceCore === 3 && usableCheekJaw === 3
      && optionalChinValid === 3 && directProvenanceValid === 3 && noFabrication && ratios.size >= 2
      && requiredBehaviors.every(behavior => behaviors.has(behavior)) && hairFrozen && outfitFrozen,
  };
}

function workersAiSchemaHash(input: { response_format?: { json_schema?: unknown } }) {
  const named = input.response_format?.json_schema;
  const schema = named && typeof named === "object" && "schema" in named
    ? (named as { schema: unknown }).schema
    : named;
  return hash(JSON.stringify(schema ?? null));
}

async function selectSources() {
  const annotations = await json<AnnotatedCase[]>(`${FROZEN}/annotations.json`);
  const review = await json<{ reviews: { sourceHash: string; box: number[]; chinVisible: boolean; jawUnoccluded: boolean }[] }>("evaluation-artifacts/face-only-geometry-20260914/crop-review.json");
  const eligible = [];
  for (const annotation of annotations) {
    const text = `${annotation.face} ${annotation.hair} ${annotation.accessories}`.toLowerCase();
    if (!["frontal", "slight_turn"].includes(annotation.pose) || /hand|finger|mask|scarf|veil|covering|glasses|sunglasses|clipped|outside source/.test(text)) continue;
    const stored = await json<{ analysis: PhotoAnalysis }>(`${FROZEN}/after/${annotation.id}/analysis-and-plan.json`);
    // Stored evaluation records can contain full historical head geometry;
    // it must not make this face-only production-baseline probe look enriched.
    const analysis = { ...stored.analysis };
    delete analysis.identityGeometry;
    delete analysis.faceIdentityGeometry;
    if (!analysis.visibleRegions.face) continue;
    const paths = [`${HISTORICAL}/${annotation.id}/01-source-face.png`, `evaluation-artifacts/face-quantization-generalization-20260907/changed-cases/${annotation.id}/01-source-face.png`];
    let face: Buffer | null = null; let path = "";
    for (const candidate of paths) { face = await optional(candidate); if (face) { path = candidate; break; } }
    if (!face) continue;
    expect(face.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    let decoded = await decodePng(face);
    if (Math.min(decoded.width, decoded.height) < 256) continue;
    const sourceHash = hash(face);
    const reviewed = review.reviews.find(r => r.sourceHash === sourceHash);
    if (!reviewed?.chinVisible || !reviewed.jawUnoccluded) continue;
    // Explicit reviewed localization, not inferred facial coordinates. Keep
    // source bytes/artifacts intact; the derived crop exists only in memory.
    if (reviewed.box.join() !== "0,0,1,1") {
      const [left, top, right, bottom] = reviewed.box;
      expect(left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && left < right && top < bottom).toBe(true);
      const x = Math.floor(left * decoded.width), y = Math.floor(top * decoded.height);
      const width = Math.ceil(right * decoded.width) - x, height = Math.ceil(bottom * decoded.height) - y;
      const rgba = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++) rgba.set(decoded.rgba.subarray(((y + row) * decoded.width + x) * 4, ((y + row) * decoded.width + x + width) * 4), row * width * 4);
      decoded = { width, height, rgba }; face = Buffer.from(await encodePng(decoded));
    }
    const metadata = await optional(`${HISTORICAL}/${annotation.id}/metrics.json`);
    if (metadata) {
      const v = JSON.parse(metadata.toString()).sourceGeometryAfter?.visibility;
      if (v?.chinClipped || v?.sourceChinClipped || v?.chinOccluded) continue;
    }
    eligible.push({ id: annotation.id, annotation, analysis, face, path, sourceHash, cropBox: reviewed.box, faceHash: hash(face), aspect: decoded.width / decoded.height,
      dimensions: { width: decoded.width, height: decoded.height },
      sourceJpeg: annotation.photoId ? await optional(`${FROZEN}/sources/${annotation.photoId}.jpg`) : null });
  }
  const choices: typeof eligible[] = [];
  for (let a = 0; a < eligible.length - 2; a++) for (let b = a + 1; b < eligible.length - 1; b++) for (let c = b + 1; c < eligible.length; c++) {
    const set = [eligible[a], eligible[b], eligible[c]];
    if (new Set(set.map(s => s.faceHash)).size === 3) choices.push(set);
  }
  const score = (set: typeof eligible) => new Set(set.map(s => s.analysis.renderHints.faceShape)).size * 10
    + Math.max(...set.map(s => s.aspect)) - Math.min(...set.map(s => s.aspect)) + set.filter(s => s.annotation.pose === "frontal").length / 10;
  choices.sort((a, b) => score(b) - score(a) || a.map(s => s.id).join().localeCompare(b.map(s => s.id).join()));
  if (!choices.length) throw new Error("three_unique_measurable_face_crops_required");
  return choices[0];
}

it("preflights a small face-only contract and three distinct measurable crops", async () => {
  const selected = await selectSources();
  expect(selected).toHaveLength(3);
  expect(new Set(selected.map(s => s.faceHash)).size).toBe(3);
  expect(selected.every(s => !s.analysis.identityGeometry && !s.analysis.faceIdentityGeometry)).toBe(true);
  const metrics = inspectGeminiResponseSchema(FACE_IDENTITY_GEOMETRY_SCHEMA);
  expect(metrics.valid).toBe(true);
  expect(metrics.serializedBytes!).toBeLessThan(inspectGeminiResponseSchema(GEMMA_IDENTITY_GEOMETRY_SCHEMA).serializedBytes! / 2);
  expect(faceIdentityGeometryRequest("face").imageDataUrls).toEqual(["face"]);
  if (process.env.FACE_ONLY_PREFLIGHT_PATH) await writeFile(process.env.FACE_ONLY_PREFLIGHT_PATH, JSON.stringify({
    schemaHash: hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)), promptHash: hash(FACE_IDENTITY_GEOMETRY_PROMPT), metrics,
    selected: selected.map(s => ({ id: s.id, path: s.path, sourceHash: s.sourceHash, cropBox: s.cropBox, hash: s.faceHash, dimensions: s.dimensions, pose: s.annotation.pose })),
    previousFullLatencyMs: [24455, 16704, 22020], productionFlag: false,
  }, null, 2), { flag: "wx" });
});

it("treats exact unknown chin as optional and distinguishes broad geometry from collision-suppressed emptiness", async () => {
  const saved = await json<{ results: SavedFaceOnlyResult[] }>("evaluation-artifacts/face-only-geometry-20260914/live-001/measurements.json");
  const gate = activationEvidence(saved.results);
  expect(gate).toMatchObject({ accepted: 3, providerAndSemanticValid: true, usableFaceCore: 3, usableCheekJaw: 3,
    optionalChinValid: 3, directProvenanceValid: 3, noFabrication: true, distinctRatios: 3,
    lowerFaceBehaviors: ["broad_no_contour", "contour_emitted"], hairFrozen: true, outfitFrozen: true, pass: true });
  expect(saved.results.map(lowerFaceBehavior)).toEqual(["contour_emitted", "broad_no_contour", "collision_suppressed"]);
});

it("classifies the nested schema inside Gemma named response-format wire", () => {
  const input = workersAiStructuredInput(faceIdentityGeometryRequest("face"), FACE_GEOMETRY_MODEL);
  expect(workersAiSchemaHash(input)).toBe(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)));
});

it.skipIf(process.env.RUN_FACE_ONLY_LIVE !== "approved-three")("measures three sources with exactly one Gemma call per tight face", async () => {
  const root = process.env.FACE_ONLY_LIVE_ROOT;
  if (!root) throw new Error("fresh_root_required");
  await mkdir(root, { recursive: false });
  const selected = await selectSources();
  const checkpoint = resolve(root, "measurements.json");
  const artifact = { model: FACE_GEOMETRY_MODEL, schemaHash: hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)), promptHash: hash(FACE_IDENTITY_GEOMETRY_PROMPT),
    metrics: inspectGeminiResponseSchema(FACE_IDENTITY_GEOMETRY_SCHEMA), timeoutMs: FACE_GEOMETRY_TIMEOUT_MS, imageCount: 1,
    selected: selected.map(s => ({ id: s.id, sourceHash: s.sourceHash, cropBox: s.cropBox, faceHash: s.faceHash, dimensions: s.dimensions, pose: s.annotation.pose })),
    providerCalls: 0, geminiCalls: 0, retries: 0, fallbacks: 0, results: [] as Record<string, unknown>[], qualityGate: null as Record<string, unknown> | null };
  await writeFile(checkpoint, JSON.stringify(artifact, null, 2), { flag: "wx" });
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<Env>({ configPath: resolve("wrangler.jsonc"), persist: false, remoteBindings: true });
  try {
    const binding = platform.env.AI;
    if (!binding) throw new Error("native_binding_missing");
    const env = { ...platform.env, AI: { run: async (model: never, input: never) => {
      if (model !== FACE_GEOMETRY_MODEL || artifact.providerCalls >= 3) throw new Error("provider_budget_violation");
      artifact.providerCalls++;
      await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
      return binding.run(model, input);
    } } } as unknown as Env;
    for (const s of selected) {
      const face = `data:image/png;base64,${s.face.toString("base64")}`;
      const request = faceIdentityGeometryRequest(face);
      const wireHash = hash(JSON.stringify(workersAiStructuredInput(request, FACE_GEOMETRY_MODEL)));
      const r = await runFaceIdentityGeometryAnalysis(env, face);
      let topology: Record<string, unknown> | null = null;
      if (r.geometry) {
        const baseline = buildIdentityPixelPlans(s.analysis);
        const enriched = buildIdentityPixelPlans({ ...s.analysis, faceIdentityGeometry: r.geometry });
        const cells = enriched.facePixelPlan.pixels.filter(p => ["cheek_contour", "jaw_contour", "chin_contour"].includes(p.role)).map(p => ({ x: p.x, y: p.y, role: p.role })).sort((a, b) => a.y - b.y || a.x - b.x || a.role.localeCompare(b.role));
        const topologyHash = hash(JSON.stringify(cells));
        const hairEqual = hash(JSON.stringify(baseline.hairPlan)) === hash(JSON.stringify(enriched.hairPlan));
        topology = { cells, hash: topologyHash, geometryUsage: enriched.facePixelPlan.layout.geometryUsage, provenance: enriched.facePixelPlan.layout.directContour,
          hairPlanUnchanged: hairEqual, outfitPlanUnchanged: hash(JSON.stringify(baseline.outfitPlan)) === hash(JSON.stringify(enriched.outfitPlan)) };
      }
      artifact.results.push({ id: s.id, ok: r.ok, providerShapeValid: r.providerShapeValid, semanticValid: r.ok, errors: r.errors,
        httpStatus: r.httpStatus, providerStatus: r.providerStatus, elapsedMs: r.elapsedMs, wireHash, measurements: r.measurements, topology });
      await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
    }
    artifact.qualityGate = activationEvidence(artifact.results as SavedFaceOnlyResult[]);
    await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
    expect(artifact.providerCalls).toBe(3);
  } finally { await platform.dispose(); }
}, 110_000);

it.skipIf(process.env.RUN_FACE_ONLY_SMOKE !== "approved-one")("runs one production-equivalent smoke only after the saved quality gate passes", async () => {
  const liveRoot = process.env.FACE_ONLY_LIVE_ROOT, root = process.env.FACE_ONLY_SMOKE_ROOT;
  if (!liveRoot || !root) throw new Error("live_and_fresh_smoke_root_required");
  const live = await json<{ results: SavedFaceOnlyResult[]; schemaHash: string; promptHash: string }>(resolve(liveRoot, "measurements.json"));
  const gate = activationEvidence(live.results);
  expect(gate.pass).toBe(true);
  expect(live.schemaHash).toBe(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)));
  expect(live.promptHash).toBe(hash(FACE_IDENTITY_GEOMETRY_PROMPT));
  const selected = await selectSources();
  const s = selected.find(s => s.sourceJpeg);
  if (!s?.sourceJpeg) throw new Error("public_jpeg_required");
  await mkdir(root, { recursive: false });
  const path = resolve(root, "smoke.json");
  const artifact = { gemini: 0, primaryGemma: 0, faceGemma: 0, faceGemmaElapsedMs: null as number | null, elapsedMs: 0,
    http: null as number | null, ok: false, analysisPresent: false, featuresPresent: false, skinPngBase64Present: false,
    generationMode: null as string | null, activationGate: gate, geometryUsage: null as unknown, directProvenance: null as unknown,
    chinUsable: false, png: null as unknown, sourceHash: hash(s.sourceJpeg), errors: [] as string[] };
  const save = () => writeFile(path, JSON.stringify(artifact, null, 2));
  await writeFile(path, JSON.stringify(artifact, null, 2), { flag: "wx" });
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<Env>({ configPath: resolve("wrangler.jsonc"), persist: false, remoteBindings: true });
  const started = Date.now(), originalFetch = globalThis.fetch;
  try {
    const binding = platform.env.AI;
    if (!binding) throw new Error("native_binding_missing");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("generativelanguage.googleapis.com")) {
        if (artifact.gemini >= 1) throw new Error("gemini_budget");
        artifact.gemini++; await save();
      }
      return originalFetch(input, init);
    });
    const env = { ...platform.env, FACE_GEOMETRY_ENRICHMENT_ENABLED: "true", IDENTITY_GEOMETRY_ENRICHMENT_ENABLED: undefined,
      SYNCHRONOUS_ENHANCEMENTS_ENABLED: undefined, IMAGE_GENERATION_ENABLED: "false", IMAGE_CRITIQUE_ENABLED: "false", HEAD_CANDIDATE_SELECTION_ENABLED: "false",
      MCSKIN_KV: { get: async () => null, put: async () => undefined },
      AI: { run: async (model: never, input: { response_format?: { json_schema?: unknown } }) => {
        if (model !== FACE_GEOMETRY_MODEL) throw new Error("model_violation");
        const face = workersAiSchemaHash(input) === live.schemaHash;
        if (face ? artifact.faceGemma >= 1 : artifact.primaryGemma >= 1) throw new Error("workers_budget");
        if (face) artifact.faceGemma++; else artifact.primaryGemma++;
        await save();
        const providerStarted = Date.now();
        try { return await binding.run(model, input as never); }
        finally { if (face) artifact.faceGemmaElapsedMs = Date.now() - providerStarted; await save(); }
      } } } as unknown as Env;
    const response = await worker.fetch(new Request("https://local/api/generate", { method: "POST", body: JSON.stringify({ image: `data:image/jpeg;base64,${s.sourceJpeg.toString("base64")}` }) }), env);
    artifact.http = response.status;
    const body = await response.json() as { ok?: boolean; generationMode?: string; skinPngBase64?: string; features?: unknown; analysis?: { skinPlan?: { facePixelPlan: ReturnType<typeof buildIdentityPixelPlans>["facePixelPlan"] } } };
    artifact.ok = body.ok === true; artifact.analysisPresent = !!body.analysis; artifact.featuresPresent = !!body.features;
    artifact.skinPngBase64Present = typeof body.skinPngBase64 === "string" && body.skinPngBase64.length > 0; artifact.generationMode = body.generationMode ?? null;
    const layout = body.analysis?.skinPlan?.facePixelPlan.layout;
    artifact.geometryUsage = layout?.geometryUsage ?? null; artifact.directProvenance = layout?.directContour ?? null; artifact.chinUsable = !!layout?.directContour?.chin;
    if (body.skinPngBase64) { const bytes = base64ToBytes(body.skinPngBase64); const magic = Buffer.from(bytes.subarray(0, 8)).toString("hex");
      const p = await decodePng(bytes); artifact.png = { magic, decoded: true, width: p.width, height: p.height, valid: validateFinalAtlas(p).ok }; }
    artifact.elapsedMs = Date.now() - started; await save();
    expect(artifact).toMatchObject({ http: 200, ok: true, analysisPresent: true, featuresPresent: true, skinPngBase64Present: true,
      generationMode: "procedural_fallback", faceGemma: 1, png: { magic: "89504e470d0a1a0a", decoded: true, width: 64, height: 64, valid: true } });
    expect(artifact.gemini + artifact.primaryGemma + artifact.faceGemma).toBeLessThanOrEqual(3);
    expect(layout?.geometryUsage).toMatchObject({ eyes: true, brows: true, mouth: true, nose: true, hairline: false,
      fringePeaks: false, crown: false, temple: false, majorVolumePeaks: false, faceWindow: false, faceShape: false });
    expect(layout?.directContour?.cheek).toBeTruthy(); expect(layout?.directContour?.jaw).toBeTruthy();
  } finally { vi.unstubAllGlobals(); await platform.dispose(); }
}, 130_000);
