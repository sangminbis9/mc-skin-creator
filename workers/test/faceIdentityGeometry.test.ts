import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import { FACE_IDENTITY_GEOMETRY_SCHEMA, FACE_IDENTITY_GEOMETRY_PROMPT, FACE_GEOMETRY_MODEL, FACE_GEOMETRY_TIMEOUT_MS, faceIdentityGeometryRequest, parseFaceIdentityGeometry, resolveFaceGeometry, runFaceIdentityGeometryAnalysis, validateFaceGeometryProviderShape } from "../src/faceIdentityGeometry";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { buildQuantizedLayoutVariants } from "../src/identityQuantization";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import { GEMMA_IDENTITY_GEOMETRY_SCHEMA } from "../src/identityGeometryEnrichment";
import { workersAiStructuredInput } from "../src/gemini";
import type { PhotoAnalysis } from "../src/analysis";
import type { Env } from "../src/types";
import worker from "../src/index";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { wireFixture } from "./compactV3Support";

function fixture(cheek = 0.72, jaw = 0.50, chin = 0.30) {
  const g = makeIdentityGeometry();
  const boundary = (width: number, y: number) => ({ left: (1 - width) / 2, right: (1 + width) / 2, y, evidence: "observed", confidence: 0.9 });
  return { face: { envelopeLeft: 0.1, envelopeRight: 0.9, foreheadY: 0.12, chinY: 0.96 },
    eyes: { leftCenterX: 0.3, rightCenterX: 0.7, leftCenterY: 0.40, rightCenterY: 0.40, leftWidth: 0.16, rightWidth: 0.16, openness: 0.7 },
    brows: { leftY: 0.28, rightY: 0.28, thickness: 0.5, tilt: 0.1 },
    nose: { centerX: 0.5, contrastY: 0.6, visibleStrength: 0.4 },
    mouth: { ...g.mouth, centerX: 0.5, centerY: 0.74, leftCornerY: 0.74, rightCornerY: 0.74, width: 0.24 },
    confidence: { faceBounds: 0.9, eyes: 0.9, brows: 0.9, nose: 0.9, mouth: 0.9 },
    directLowerFaceContour: { cheek: boundary(cheek, 0.60), jaw: boundary(jaw, 0.76), chin: boundary(chin, 0.88) } };
}
const plan = (raw = fixture()) => buildIdentityPixelPlans(makeAnalysis({ faceIdentityGeometry: parseFaceIdentityGeometry(raw)! }));
const contour = (p: ReturnType<typeof plan>) => p.facePixelPlan.pixels.filter(p => ["cheek_contour", "jaw_contour", "chin_contour"].includes(p.role));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("independent face geometry contract and existing grammar", () => {
  it("validates without head/hair; never creates a fake full geometry object", () => {
    expect(validateFaceGeometryProviderShape(fixture())).toEqual([]);
    const parsed = parseFaceIdentityGeometry(fixture())!;
    expect(parsed).toBeTruthy();
    expect(Object.keys(parsed)).toEqual(["source", "face", "eyes", "brows", "nose", "mouth", "confidence", "directLowerFaceContour"]);
    const a = makeAnalysis({ faceIdentityGeometry: parsed });
    expect(a.identityGeometry).toBeUndefined();
    expect(resolveFaceGeometry(a)?.eyes.interEyeDistance).toBeCloseTo(0.4);
    // Unrelated invalid head data is not an input to the face validator.
    const unrelated = { hair: { crown: NaN }, faceWire: fixture() };
    expect(parseFaceIdentityGeometry(unrelated.faceWire)).toEqual(parsed);
  });
  it("keeps the schema much smaller and exactly one image in the native wire", () => {
    const metrics = inspectGeminiResponseSchema(FACE_IDENTITY_GEOMETRY_SCHEMA);
    const old = inspectGeminiResponseSchema(GEMMA_IDENTITY_GEOMETRY_SCHEMA);
    expect(metrics.valid).toBe(true);
    expect(metrics.serializedBytes!).toBeLessThan(old.serializedBytes! / 2);
    expect(metrics.requiredCount).toBeLessThan(old.requiredCount / 2);
    expect(Object.keys(FACE_IDENTITY_GEOMETRY_SCHEMA.properties!)).toEqual(["face", "eyes", "brows", "nose", "mouth", "confidence", "directLowerFaceContour"]);
    const request = faceIdentityGeometryRequest("data:image/png;base64,AQID");
    expect(request.imageDataUrls).toHaveLength(1);
    expect(request.timeoutCapMs).toBe(25_000);
    expect(request.allowWorkersAiFallback).toBe(false);
    expect(FACE_IDENTITY_GEOMETRY_PROMPT).toContain("exactly one image: the tight face crop");
    expect(FACE_IDENTITY_GEOMETRY_PROMPT).not.toMatch(/Image [01]/);
    expect(workersAiStructuredInput(request, FACE_GEOMETRY_MODEL)).toBeTruthy();
  });
  it("permits local crop boundaries beyond a narrower global scale reference", () => {
    const raw = fixture(0.54, 0.46, 0.24);
    raw.face.envelopeLeft = 0.35; raw.face.envelopeRight = 0.70;
    raw.directLowerFaceContour.cheek.left = 0.28;
    raw.directLowerFaceContour.cheek.right = 0.82;
    expect(parseFaceIdentityGeometry(raw)).not.toBeNull();
  });
  it("accepts plausible wider jaw, rejects extreme jump and row reversal", () => {
    expect(parseFaceIdentityGeometry(fixture(0.50, 0.56, 0.20))).not.toBeNull();
    expect(parseFaceIdentityGeometry(fixture(0.40, 0.90, 0.20))).toBeNull();
    const raw = fixture(); raw.directLowerFaceContour.jaw.y = 0.5;
    expect(parseFaceIdentityGeometry(raw)).toBeNull();
  });
  it("unknown chin is independently valid only with null coordinates and zero confidence", () => {
    const raw = { ...fixture(), directLowerFaceContour: { ...fixture().directLowerFaceContour, chin: { left: null, right: null, y: null, evidence: "unknown", confidence: 0 } } };
    expect(parseFaceIdentityGeometry(raw)).not.toBeNull();
    raw.directLowerFaceContour.chin.confidence = 0.4;
    expect(parseFaceIdentityGeometry(raw)).toBeNull();
  });
  it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid coordinate %s without coercion", value => {
    const raw = fixture(); raw.eyes.leftCenterX = value;
    expect(parseFaceIdentityGeometry(raw)).toBeNull();
  });
  it("unknown jaw does not erase cheek-to-chin ordering", () => {
    const raw = { ...fixture(), directLowerFaceContour: { ...fixture().directLowerFaceContour, jaw: { left: null, right: null, y: null, evidence: "unknown", confidence: 0 } } };
    expect(parseFaceIdentityGeometry(raw)).not.toBeNull();
    raw.directLowerFaceContour.chin.y = 0.5;
    expect(parseFaceIdentityGeometry(raw)).toBeNull();
  });
  it("same cheek/different jaw and same jaw/different chin use distinct existing topology", () => {
    const a = plan(fixture(0.72, 0.68, 0.3)), b = plan(fixture(0.72, 0.5, 0.3));
    expect(a.facePixelPlan.layout.faceShape.cheekWidth).toBe(b.facePixelPlan.layout.faceShape.cheekWidth);
    expect(contour(a)).not.toEqual(contour(b));
    const c = plan(fixture(0.72, 0.68, 0.6));
    expect(c.facePixelPlan.layout.faceShape.jawWidth).toBe(a.facePixelPlan.layout.faceShape.jawWidth);
    expect(contour(c)).not.toEqual(contour(a));
    expect(contour(a).length).toBeLessThanOrEqual(6);
  });
  it("face axes use geometry while hair provenance and hair plan remain semantic", () => {
    const p = plan(); const baseline = buildIdentityPixelPlans(makeAnalysis());
    expect(p.facePixelPlan.layout.geometryUsage).toMatchObject({ eyes: true, brows: true, nose: true, mouth: true, hairline: false, fringePeaks: false, temple: false, crown: false, majorVolumePeaks: false });
    expect(p.facePixelPlan.layout.geometryProvenance).toMatchObject({ eyes: "observed_geometry", brows: "observed_geometry", nose: "observed_geometry", mouth: "observed_geometry", fringe: "semantic_fallback" });
    expect(p.hairPlan).toEqual(baseline.hairPlan);
    expect(p.outfitPlan).toEqual(baseline.outfitPlan);
    expect(buildQuantizedLayoutVariants(makeAnalysis({ faceIdentityGeometry: parseFaceIdentityGeometry(fixture())! }))).toHaveLength(3);
  });
  it("face-only takes precedence while real full head data remains available", () => {
    const full = makeIdentityGeometry();
    const base = buildIdentityPixelPlans(makeAnalysis({ identityGeometry: full }));
    const a = makeAnalysis({ identityGeometry: full, faceIdentityGeometry: parseFaceIdentityGeometry(fixture())! });
    const p = buildIdentityPixelPlans(a);
    expect(resolveFaceGeometry(a)?.eyes.leftCenterX).toBe(0.3);
    expect(p.hairPlan).toEqual(base.hairPlan);
    expect(p.facePixelPlan.layout.crownGeometry).toEqual(base.facePixelPlan.layout.crownGeometry);
  });
  it("all twelve stored baselines are identical when enrichment is absent", async () => {
    const annotations = JSON.parse(await readFile("evaluation-artifacts/generalization-20260905/annotations.json", "utf8")) as { id: string }[];
    expect(annotations).toHaveLength(12);
    for (const { id } of annotations) {
      const { analysis } = JSON.parse(await readFile(`evaluation-artifacts/generalization-20260905/after/${id}/analysis-and-plan.json`, "utf8")) as { analysis: PhotoAnalysis };
      expect(buildIdentityPixelPlans({ ...analysis, faceIdentityGeometry: undefined }), id).toEqual(buildIdentityPixelPlans(analysis));
    }
  });
  it("times out after exactly one native call and never retries", async () => {
    vi.useFakeTimers(); const run = vi.fn(() => new Promise(() => {}));
    const pending = runFaceIdentityGeometryAnalysis({ AI: { run } } as unknown as Env, "face");
    await vi.advanceTimersByTimeAsync(FACE_GEOMETRY_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ ok: false, httpStatus: 504 });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(["valid", "unavailable", "malformed", "schema", "semantic", "timeout"])("valid primary => HTTP200/valid PNG for %s", async mode => {
    const image = `data:image/png;base64,${bytesToBase64(await encodePng({ width: 320, height: 480, rgba: new Uint8Array(320 * 480 * 4).fill(255) }))}`;
    const primary = wireFixture(makeAnalysis());
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(primary) }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn(async () => {
      if (mode === "unavailable") throw new Error("503 unavailable");
      if (mode === "malformed") return { response: "not JSON" };
      if (mode === "schema") return { response: {} };
      if (mode === "timeout") return await new Promise(() => {});
      const raw = fixture(); if (mode === "semantic") raw.mouth.centerY = 0.2;
      return { response: raw };
    });
    const env = { GEMINI_API_KEY: "offline-test-key", AI: { run }, FACE_GEOMETRY_ENRICHMENT_ENABLED: "true", SYNCHRONOUS_ENHANCEMENTS_ENABLED: "true",
      IMAGE_GENERATION_ENABLED: "true", IMAGE_CRITIQUE_ENABLED: "true", HEAD_CANDIDATE_SELECTION_ENABLED: "true",
      MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
    const request = () => new Request("https://local/api/generate", { method: "POST", body: JSON.stringify({ image }) });
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; skinPngBase64: string; analysis: PhotoAnalysis & { skinPlan: { facePixelPlan: ReturnType<typeof plan>["facePixelPlan"] } } };
    expect(body.ok).toBe(true);
    const png = await decodePng(base64ToBytes(body.skinPngBase64));
    expect([png.width, png.height]).toEqual([64, 64]);
    expect(validateFinalAtlas(png).ok).toBe(true);
    expect(body.analysis.skinPlan.facePixelPlan.layout.geometryUsage.eyes).toBe(mode === "valid");
    expect(body.analysis.skinPlan.facePixelPlan.layout.geometryUsage.nose).toBe(mode === "valid");
    expect(body.analysis.skinPlan.facePixelPlan.layout.geometryUsage.crown).toBe(false);
    // Raw internal measurements are not added to the public analysis summary.
    expect(body.analysis.faceIdentityGeometry).toBeUndefined();
    expect(body.analysis.identityGeometry).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    if (mode !== "valid") {
      const baseline = await worker.fetch(request(), { ...env, FACE_GEOMETRY_ENRICHMENT_ENABLED: "false", SYNCHRONOUS_ENHANCEMENTS_ENABLED: "false" });
      const original = await baseline.json() as { skinPngBase64: string; analysis: PhotoAnalysis };
      expect(body.skinPngBase64).toBe(original.skinPngBase64);
      expect(body.analysis).toEqual(original.analysis);
      expect(run).toHaveBeenCalledTimes(1);
    }
  }, 35_000);
});
