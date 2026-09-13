/** Explicit opt-in: three Gemma measurements, then a separately approved smoke. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { directBoundaryUsable, directBoundaryWidth, parseDirectLowerFaceContour, type DirectLowerFaceContour } from "../src/directFaceContour";
import { GEMMA_IDENTITY_GEOMETRY_SCHEMA, GEMMA_IDENTITY_GEOMETRY_PROMPT, GEOMETRY_ENRICHMENT_MODEL, GEOMETRY_ENRICHMENT_TIMEOUT_MS, runIdentityGeometryEnrichment } from "../src/identityGeometryEnrichment";
import { parseIdentityGeometry, type GeometryCropVisibility, type IdentityGeometryAnalysis } from "../src/identityGeometry";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import worker from "../src/index";
import { base64ToBytes, decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import type { AnnotatedCase } from "./generalizationSupport";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const ARTIFACTS = "evaluation-artifacts";
const FROZEN = `${ARTIFACTS}/generalization-20260905`;
const HEAD_STRUCTURE = `${ARTIFACTS}/head-structure-iteration-final`;
const CHANGED_FACE = `${ARTIFACTS}/face-quantization-generalization-20260907/changed-cases`;
const pngDimensions = (value: Buffer) => ({ width: value.readUInt32BE(16), height: value.readUInt32BE(20) });
const readOptional = async (path: string) => { try { return await readFile(path); } catch { return null; } };
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

type Candidate = {
  id: string;
  annotation: AnnotatedCase;
  analysis: PhotoAnalysis;
  geometry?: IdentityGeometryAnalysis;
  face: Buffer;
  head: Buffer;
  sourceJpeg?: Buffer;
  semanticShape: string;
  outlineAspect: number;
  cropRolesDistinct: boolean;
  measurability: Record<string, boolean | number | string>;
};

function visibilityFor(geometry: IdentityGeometryAnalysis | undefined): GeometryCropVisibility | undefined {
  if (!geometry) return undefined;
  const v = geometry.visibility;
  return { cropClippingKnown: v.cropClippingKnown, sourceClippingKnown: v.sourceClippingKnown,
    crownClipped: v.crownClipped, leftHairClipped: v.leftHairClipped, rightHairClipped: v.rightHairClipped,
    chinClipped: v.chinClipped, leftEarClipped: v.leftEarClipped, rightEarClipped: v.rightEarClipped,
    sourceCrownClipped: v.sourceCrownClipped, sourceLeftHairClipped: v.sourceLeftHairClipped,
    sourceRightHairClipped: v.sourceRightHairClipped, sourceChinClipped: v.sourceChinClipped };
}

async function candidates(): Promise<Candidate[]> {
  const annotations = await readJson<AnnotatedCase[]>(`${FROZEN}/annotations.json`);
  const headStructureIds = new Set((await readdir(HEAD_STRUCTURE, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name));
  const changedIds = new Set((await readdir(CHANGED_FACE, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name));
  const eligible: Candidate[] = [];
  for (const annotation of annotations) {
    const stored = await readJson<{ analysis: PhotoAnalysis }>(`${FROZEN}/after/${annotation.id}/analysis-and-plan.json`);
    const preferredPair = headStructureIds.has(annotation.id)
      ? { face: `${HEAD_STRUCTURE}/${annotation.id}/01-source-face.png`, head: `${HEAD_STRUCTURE}/${annotation.id}/01b-source-head.png`, metrics: `${HEAD_STRUCTURE}/${annotation.id}/metrics.json` }
      : changedIds.has(annotation.id)
        ? { face: `${CHANGED_FACE}/${annotation.id}/01-source-face.png`, head: `${FROZEN}/after/${annotation.id}/head-crop.png`, metrics: null }
        : null;
    if (!preferredPair) continue;
    const [face, head] = await Promise.all([readOptional(preferredPair.face), readOptional(preferredPair.head)]);
    if (!face || !head) continue;
    const metadata = preferredPair.metrics ? await readJson<{ sourceGeometryAfter?: unknown }>(preferredPair.metrics) : null;
    const geometry = metadata?.sourceGeometryAfter ? parseIdentityGeometry(metadata.sourceGeometryAfter) ?? undefined : undefined;
    const faceSize = pngDimensions(face);
    const evidenceText = `${annotation.face} ${annotation.accessories} ${annotation.hair}`.toLowerCase();
    const stablePose = annotation.pose === "frontal" || annotation.pose === "slight_turn";
    const noLowerFaceOcclusion = !/hand|finger|mask|mouth outside|chin outside|sunglasses|glasses/.test(evidenceText);
    const noJawCovering = !/headscarf|scarf|face covering|veil/.test(evidenceText);
    const knownChinVisible = !geometry || (!geometry.visibility.chinClipped && !geometry.visibility.sourceChinClipped && !geometry.visibility.chinOccluded);
    const sourceResolutionSufficient = Math.min(faceSize.width, faceSize.height) >= 256;
    const faceVisible = stored.analysis.visibleRegions.face;
    const cropContainsChin = knownChinVisible && !/clipped|outside source/.test(annotation.face.toLowerCase());
    const bothSidesMeasurable = stablePose && noLowerFaceOcclusion && noJawCovering;
    const measurability = { faceVisible, stablePose, noLowerFaceOcclusion, noJawCovering, knownChinVisible,
      cropContainsChin, bothSidesMeasurable, sourceResolutionSufficient, faceWidth: faceSize.width, faceHeight: faceSize.height };
    if (![faceVisible, stablePose, noLowerFaceOcclusion, noJawCovering, knownChinVisible, cropContainsChin, bothSidesMeasurable, sourceResolutionSufficient].every(Boolean)) continue;
    const sourceJpeg = annotation.photoId ? await readOptional(`${FROZEN}/sources/${annotation.photoId}.jpg`) ?? undefined : undefined;
    eligible.push({ id: annotation.id, annotation, analysis: stored.analysis, geometry, face, head, sourceJpeg,
      semanticShape: stored.analysis.renderHints.faceShape, outlineAspect: faceSize.width / faceSize.height,
      cropRolesDistinct: hash(face) !== hash(head), measurability });
  }
  if (eligible.length < 3) throw new Error("insufficient_measurable_source_pairs");
  const combinations: Candidate[][] = [];
  for (let a = 0; a < eligible.length - 2; a++) for (let b = a + 1; b < eligible.length - 1; b++) for (let c = b + 1; c < eligible.length; c++) combinations.push([eligible[a], eligible[b], eligible[c]]);
  combinations.sort((left, right) => {
    const score = (set: Candidate[]) => new Set(set.map(c => c.semanticShape)).size * 10
      + (Math.max(...set.map(c => c.outlineAspect)) - Math.min(...set.map(c => c.outlineAspect)))
      + set.filter(c => c.annotation.pose === "frontal").length / 10;
    return score(right) - score(left) || left.map(c => c.id).join().localeCompare(right.map(c => c.id).join());
  });
  return combinations[0];
}

function lowerFaceTopology(analysis: PhotoAnalysis, geometry: IdentityGeometryAnalysis) {
  const legacyGeometry = { ...geometry };
  delete legacyGeometry.directLowerFaceContour;
  const legacy = buildIdentityPixelPlans({ ...analysis, identityGeometry: legacyGeometry });
  const direct = buildIdentityPixelPlans({ ...analysis, identityGeometry: geometry });
  const contour = (plan: typeof direct) => plan.facePixelPlan.pixels
    .filter(p => p.cluster === "complexion" && ["cheek_contour", "jaw_contour", "chin_contour"].includes(p.role))
    .map(p => ({ x: p.x, y: p.y, role: p.role })).sort((a, b) => a.y - b.y || a.x - b.x || a.role.localeCompare(b.role));
  const signature = (plan: typeof direct, kind: "eye" | "brow" | "mouth" | "nose" | "hair") => hash(JSON.stringify(kind === "hair"
    ? { fringe: plan.facePixelPlan.pixels.filter(p => p.cluster === "fringe"), hair: plan.hairPlan }
    : plan.facePixelPlan.pixels.filter(p => kind === "eye" ? p.cluster === "left_eye" || p.cluster === "right_eye" : kind === "brow" ? p.role === "brow" : p.cluster === kind)));
  return {
    legacy: { cheekWidth: legacy.facePixelPlan.layout.faceShape.cheekWidth, jawWidth: legacy.facePixelPlan.layout.faceShape.jawWidth,
      derivedRatio: geometry.faceShape.cheekWidth ? (geometry.faceShape.cheekWidth * 0.88) / geometry.faceShape.cheekWidth : null, cells: contour(legacy) },
    direct: { cheekWidth: direct.facePixelPlan.layout.faceShape.cheekWidth, jawWidth: direct.facePixelPlan.layout.faceShape.jawWidth,
      chinWidth: direct.facePixelPlan.layout.directContour?.chin?.width ?? null, faceBoundaryBudget: direct.facePixelPlan.layout.salience.pixelBudget.faceBoundary,
      provenance: direct.facePixelPlan.layout.directContour, cells: contour(direct) },
    topologyHash: hash(JSON.stringify(contour(direct))),
    freeze: Object.fromEntries((["eye", "brow", "mouth", "nose", "hair"] as const).map(kind => [`${kind}SignatureEqual`, signature(legacy, kind) === signature(direct, kind)])),
  };
}

it("preflights three measurable source pairs and the corrected contract", async () => {
  const selected = await candidates();
  expect(new Set(selected.map(c => c.id)).size).toBe(3);
  expect(selected.every(c => Object.values(c.measurability).slice(0, 8).every(Boolean))).toBe(true);
  expect(GEMMA_IDENTITY_GEOMETRY_PROMPT).toContain("Image 0 is the TIGHT FACE crop");
  expect(GEMMA_IDENTITY_GEOMETRY_PROMPT).toContain("Image 1 is the WIDE HEAD crop");
  const extension = GEMMA_IDENTITY_GEOMETRY_PROMPT.split("DIRECT LOWER FACE:")[1];
  expect(extension).not.toMatch(/image\s*\d/i);
  expect(extension).toContain("If evidence is unknown, left/right/y must be null and confidence must be exactly 0.");
  const metrics = inspectGeminiResponseSchema(GEMMA_IDENTITY_GEOMETRY_SCHEMA);
  expect(metrics.valid).toBe(true);
  expect(metrics.unsupportedConstructs).toEqual([]);
  if (process.env.DIRECT_FACE_OFFLINE_REPORT) await writeFile(process.env.DIRECT_FACE_OFFLINE_REPORT, JSON.stringify({
    providerCalls: 0, schemaHash: hash(JSON.stringify(GEMMA_IDENTITY_GEOMETRY_SCHEMA)), promptHash: hash(GEMMA_IDENTITY_GEOMETRY_PROMPT), metrics,
    coordinateConvention: "Image 0 tight face; Image 1 wide head; extension has no competing numbering",
    selected: selected.map(c => ({ id: c.id, semanticShape: c.semanticShape, outlineAspect: c.outlineAspect, cropRolesDistinct: c.cropRolesDistinct, measurability: c.measurability })),
    productionFlagConfigured: false, activationEligible: false,
  }, null, 2), { flag: "wx" });
});

it.skipIf(process.env.RUN_DIRECT_FACE_GEOMETRY_LIVE !== "approved-three")("measures three visible lower-face contours once using native Gemma", async () => {
  const root = process.env.DIRECT_FACE_LIVE_ROOT;
  if (!root) throw new Error("fresh_artifact_root_required");
  await mkdir(root, { recursive: false });
  const selected = await candidates();
  const checkpoint = resolve(root, "measurements.json");
  const artifact = {
    model: GEOMETRY_ENRICHMENT_MODEL, schemaHash: hash(JSON.stringify(GEMMA_IDENTITY_GEOMETRY_SCHEMA)), schemaBytes: Buffer.byteLength(JSON.stringify(GEMMA_IDENTITY_GEOMETRY_SCHEMA)),
    promptHash: hash(GEMMA_IDENTITY_GEOMETRY_PROMPT), timeoutMs: GEOMETRY_ENRICHMENT_TIMEOUT_MS,
    selection: "stored source/crop diagnostics; lower-face measurability before pose and semantic-shape diversity; no fixture-id branch",
    selected: selected.map(c => ({ id: c.id, faceHash: hash(c.face), headHash: hash(c.head), semanticShape: c.semanticShape, outlineAspect: c.outlineAspect, cropRolesDistinct: c.cropRolesDistinct, measurability: c.measurability })),
    providerCalls: 0, retries: 0, geminiCalls: 0, results: [] as Array<Record<string, unknown>>, qualityGate: null as null | Record<string, unknown>,
  };
  await writeFile(checkpoint, JSON.stringify(artifact, null, 2), { flag: "wx" });
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<Env>({ configPath: resolve("wrangler.jsonc"), persist: false, remoteBindings: true });
  try {
    const binding = platform.env.AI;
    if (!binding) throw new Error("native_binding_missing");
    const env = { ...platform.env, AI: { run: async (model: never, input: never) => {
      if (model !== GEOMETRY_ENRICHMENT_MODEL || artifact.providerCalls >= 3) throw new Error("provider_budget_or_model_violation");
      artifact.providerCalls++;
      await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
      return binding.run(model, input);
    } } } as unknown as Env;
    for (const item of selected) {
      const r = await runIdentityGeometryEnrichment(env, `data:image/png;base64,${item.face.toString("base64")}`, `data:image/png;base64,${item.head.toString("base64")}`, visibilityFor(item.geometry));
      const raw = r.measuredContour;
      const geometry = r.geometry;
      const rawWidths = raw ? { cheek: directBoundaryWidth(raw.cheek) ?? null, jaw: directBoundaryWidth(raw.jaw) ?? null, chin: directBoundaryWidth(raw.chin) ?? null } : { cheek: null, jaw: null, chin: null };
      const semanticErrors: string[] = [];
      const semanticValid = !!raw && !!geometry && !!parseDirectLowerFaceContour(raw, geometry.face, semanticErrors);
      const topology = geometry ? lowerFaceTopology(item.analysis, geometry) : null;
      artifact.results.push({ id: item.id, ok: r.ok, errors: r.errors, elapsedMs: r.elapsedMs,
        httpStatus: r.httpStatus ?? null, providerStatus: r.providerStatus ?? (r.ok ? "binding_success" : null),
        providerStructuredResponse: !!raw, providerShapeValid: !!raw, semanticValid, semanticErrors,
        directLowerFaceContour: raw ?? null, widths: rawWidths,
        visibleFaceWidth: geometry ? geometry.face.visibleRight - geometry.face.visibleLeft : null,
        jawCheekRatio: rawWidths.cheek && rawWidths.jaw ? rawWidths.jaw / rawWidths.cheek : null,
        chinJawRatio: rawWidths.jaw && rawWidths.chin ? rawWidths.chin / rawWidths.jaw : null,
        provenance: geometry?.diagnostics.provenance ?? null, visibility: geometry?.visibility ?? item.geometry?.visibility ?? null, topology });
      await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
      console.log(JSON.stringify({ case: item.id, ok: r.ok, elapsedMs: r.elapsedMs, errors: r.errors }));
    }
    const accepted = artifact.results.filter(r => r.ok && r.topology) as Array<Record<string, unknown>>;
    const ratios = accepted.map(r => Number(r.jawCheekRatio)).filter(Number.isFinite);
    const usableCheekJaw = accepted.filter(r => {
      const c = r.directLowerFaceContour as DirectLowerFaceContour; return directBoundaryUsable(c?.cheek) && directBoundaryUsable(c?.jaw);
    }).length;
    const usableChin = accepted.filter(r => directBoundaryUsable((r.directLowerFaceContour as DirectLowerFaceContour)?.chin)).length;
    const topologyHashes = new Set(accepted.map(r => (r.topology as { topologyHash: string }).topologyHash));
    const allFrozen = accepted.every(r => Object.values((r.topology as { freeze: Record<string, boolean> }).freeze).every(Boolean));
    const allCropRolesDistinct = selected.every(c => c.cropRolesDistinct);
    artifact.qualityGate = { contractValid: accepted.length, usableCheekJaw, usableChin,
      distinctRatiosAtProviderPrecision: new Set(ratios.map(v => v.toFixed(2))).size,
      allRatiosLegacy088: ratios.length > 0 && ratios.every(v => v.toFixed(2) === "0.88"), distinctTopologyCases: topologyHashes.size,
      allFrozen, allCropRolesDistinct, validCallsAtOrAbove23s: accepted.filter(r => Number(r.elapsedMs) >= 23_000).length,
      automaticPass: accepted.length === 3 && usableCheekJaw >= 2 && usableChin >= 2 && new Set(ratios.map(v => v.toFixed(2))).size >= 2
        && !ratios.every(v => v.toFixed(2) === "0.88") && topologyHashes.size >= 2 && allFrozen && allCropRolesDistinct,
      visualSourcePlausibility: "pending_manual_review" };
    await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
  } finally { await platform.dispose(); }
  expect(artifact.providerCalls).toBe(3);
}, 160_000);

it.skipIf(process.env.RUN_DIRECT_FACE_GENERATION_SMOKE !== "approved-one")("runs one production-equivalent generation only after the live quality gate", async () => {
  const liveRoot = process.env.DIRECT_FACE_LIVE_ROOT;
  const smokeRoot = process.env.DIRECT_FACE_SMOKE_ROOT;
  if (!liveRoot || !smokeRoot || process.env.DIRECT_FACE_VISUAL_REVIEW !== "approved") throw new Error("approved_live_gate_and_fresh_smoke_root_required");
  const live = await readJson<{ results: Array<{ id: string; ok: boolean }>; qualityGate: { automaticPass: boolean } }>(resolve(liveRoot, "measurements.json"));
  if (!live.qualityGate.automaticPass) throw new Error("direct_geometry_quality_gate_failed");
  const selected = await candidates();
  const smokeCase = selected.find(c => live.results.some(r => r.id === c.id && r.ok) && c.sourceJpeg);
  if (!smokeCase?.sourceJpeg) throw new Error("accepted_public_source_required");
  await mkdir(smokeRoot, { recursive: false });
  const checkpoint = resolve(smokeRoot, "smoke.json");
  const artifact = { sourceHash: hash(smokeCase.sourceJpeg), geminiCalls: 0, primaryGemmaCalls: 0, geometryGemmaCalls: 0,
    retries: 0, status: null as number | null, ok: false, generationMode: null as string | null, identityGeometry: false,
    directProvenance: null as unknown, png: null as null | { width: number; height: number; finalAtlasValid: boolean }, elapsedMs: 0 };
  await writeFile(checkpoint, JSON.stringify(artifact, null, 2), { flag: "wx" });
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<Env>({ configPath: resolve("wrangler.jsonc"), persist: false, remoteBindings: true });
  const started = Date.now();
  const originalFetch = globalThis.fetch;
  try {
    if (!platform.env.AI) throw new Error("native_binding_missing");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("generativelanguage.googleapis.com")) {
        if (++artifact.geminiCalls > 1) throw new Error("smoke_gemini_budget_exceeded");
        await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
      }
      return originalFetch(input, init);
    });
    const binding = platform.env.AI;
    const env = { ...platform.env, IDENTITY_GEOMETRY_ENRICHMENT_ENABLED: "true", SYNCHRONOUS_ENHANCEMENTS_ENABLED: undefined,
      IMAGE_GENERATION_ENABLED: "false", IMAGE_CRITIQUE_ENABLED: "false", HEAD_CANDIDATE_SELECTION_ENABLED: "false",
      MCSKIN_KV: { get: async () => null, put: async () => undefined },
      AI: { run: async (model: never, input: { response_format?: { json_schema?: unknown } }) => {
        const schemaHash = hash(JSON.stringify(input.response_format?.json_schema ?? null));
        if (schemaHash === hash(JSON.stringify(GEMMA_IDENTITY_GEOMETRY_SCHEMA))) artifact.geometryGemmaCalls++;
        else artifact.primaryGemmaCalls++;
        if (artifact.geometryGemmaCalls > 1 || artifact.primaryGemmaCalls > 1) throw new Error("smoke_workers_ai_budget_exceeded");
        await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
        return binding.run(model, input as never);
      } },
    } as unknown as Env;
    const image = `data:image/jpeg;base64,${smokeCase.sourceJpeg.toString("base64")}`;
    const response = await worker.fetch(new Request("https://local/api/generate", { method: "POST", body: JSON.stringify({ image }) }), env);
    artifact.status = response.status;
    const body = await response.json() as { ok?: boolean; generationMode?: string; skinPngBase64?: string; analysis?: PhotoAnalysis };
    artifact.ok = body.ok === true;
    artifact.generationMode = body.generationMode ?? null;
    artifact.identityGeometry = !!body.analysis?.identityGeometry;
    artifact.directProvenance = body.analysis?.identityGeometry?.diagnostics.provenance.directLowerFaceContour ?? null;
    if (body.skinPngBase64) {
      const png = await decodePng(base64ToBytes(body.skinPngBase64));
      artifact.png = { width: png.width, height: png.height, finalAtlasValid: validateFinalAtlas(png).ok };
    }
    artifact.elapsedMs = Date.now() - started;
    await writeFile(checkpoint, JSON.stringify(artifact, null, 2));
    expect(artifact).toMatchObject({ status: 200, ok: true, generationMode: "procedural_fallback", identityGeometry: true,
      png: { width: 64, height: 64, finalAtlasValid: true } });
    expect(artifact.geminiCalls).toBeLessThanOrEqual(1);
    expect(artifact.primaryGemmaCalls).toBeLessThanOrEqual(1);
    expect(artifact.geometryGemmaCalls).toBe(1);
  } finally { vi.unstubAllGlobals(); await platform.dispose(); }
}, 130_000);
