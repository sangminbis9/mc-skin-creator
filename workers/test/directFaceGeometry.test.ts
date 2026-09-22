import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { PhotoAnalysis } from "../src/analysis";
import { applyCropVisibility, parseIdentityGeometry } from "../src/identityGeometry";
import { applyDirectContourVisibility, directBoundaryExpansionPlausible, parseDirectLowerFaceContour, type DirectLowerFaceContour } from "../src/directFaceContour";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { GEMMA_IDENTITY_GEOMETRY_SCHEMA, GEMMA_IDENTITY_GEOMETRY_PROMPT, GEOMETRY_ENRICHMENT_MODEL, GEOMETRY_ENRICHMENT_TIMEOUT_MS, geometryEnrichmentRequest, runIdentityGeometryEnrichment, validateGeometryProviderShape } from "../src/identityGeometryEnrichment";
import { workersAiStructuredInput } from "../src/gemini";
import type { CompactV3Schema } from "../src/compactPhotoAnalysisV3";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";
import type { Env } from "../src/types";
import worker from "../src/index";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { wireFixture } from "./compactV3Support";

export function directContour(cheek = 0.72, jaw = 0.5, chin = 0.3): DirectLowerFaceContour {
  const b = (width: number, y: number) => ({ left: (1 - width) / 2, right: (1 + width) / 2, y, evidence: "observed" as const, confidence: 0.9 });
  return { cheek: b(cheek, 0.6), jaw: b(jaw, 0.76), chin: b(chin, 0.88) };
}
export function directGeometry() {
  const geometry = makeIdentityGeometry();
  return { ...geometry, face: { ...geometry.face, visibleLeft: 0.1, visibleRight: 0.9 }, directLowerFaceContour: directContour() };
}
export function geometryWireFixture(): Record<string, unknown> {
  const geometry = directGeometry();
  function project(schema: CompactV3Schema, value: unknown): unknown {
    if (value === null) return null;
    if (schema.properties) return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, project(child, (value as Record<string, unknown>)[key])]));
    if (schema.items) return (value as unknown[]).map(item => project(schema.items!, item));
    return value;
  }
  return project(GEMMA_IDENTITY_GEOMETRY_SCHEMA, { ...geometry,
    occlusion: { crown: false, leftHair: false, rightHair: false, chin: false, leftEar: false, rightEar: false },
  }) as Record<string, unknown>;
}
const pixels = (jaw: number, chin: number, cheek = 0.72) => buildIdentityPixelPlans(makeAnalysis({ identityGeometry: { ...directGeometry(), directLowerFaceContour: directContour(cheek, jaw, chin) } })).facePixelPlan;
const contourPixels = (plan: ReturnType<typeof pixels>) => plan.pixels.filter(p => p.cluster === "complexion");
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("direct source boundaries, no derived-ratio fabrication", () => {
  it("has exactly one image-number convention for all measurements", () => {
    expect(GEMMA_IDENTITY_GEOMETRY_PROMPT).toContain("Image 0 is the TIGHT FACE crop");
    expect(GEMMA_IDENTITY_GEOMETRY_PROMPT).toContain("Image 1 is the WIDE HEAD crop");
    const extension = GEMMA_IDENTITY_GEOMETRY_PROMPT.split("DIRECT LOWER FACE:")[1];
    expect(extension).toContain("ONLY the TIGHT FACE crop specified in the coordinate contract above");
    expect(extension).not.toMatch(/image\s*\d/i);
  });
  it("accepts plausible cross-row expansion but retains unknown-contract rejection", () => {
    const face = { visibleLeft: 0, visibleRight: 1, foreheadY: 0, chinY: 1 };
    const c = directContour(0.5, 0.51, 0.16), errors: string[] = [];
    expect(parseDirectLowerFaceContour(c, face, errors)).toEqual(c);
    expect(errors).toEqual([]);
    c.jaw = { left: null, right: null, y: null, evidence: "unknown", confidence: 0.4 };
    const unknownErrors: string[] = [];
    expect(parseDirectLowerFaceContour(c, face, unknownErrors)).toBeNull();
    expect(unknownErrors).toEqual(["geometry.directLowerFaceContour.jaw.confidence:unknown_requires_zero"]);
  });
  it("derives the cross-row plausibility envelope from measured face and row geometry", () => {
    const face = { visibleLeft: 0.1, visibleRight: 0.9, foreheadY: 0.15, chinY: 0.85 };
    const upper = { left: 0.3, right: 0.7, y: 0.5, evidence: "observed" as const, confidence: 0.9 };
    const squareJaw = { left: 0.29, right: 0.71, y: 0.62, evidence: "observed" as const, confidence: 0.9 };
    const contradictoryJaw = { left: 0.075, right: 0.925, y: 0.62, evidence: "observed" as const, confidence: 0.9 };
    expect(directBoundaryExpansionPlausible(upper, squareJaw, face)).toBe(true);
    expect(directBoundaryExpansionPlausible(upper, contradictoryJaw, face)).toBe(false);
    const contour = { cheek: upper, jaw: contradictoryJaw, chin: { left: 0.42, right: 0.58, y: 0.78, evidence: "observed" as const, confidence: 0.9 } };
    const errors: string[] = [];
    expect(parseDirectLowerFaceContour(contour, { ...face, visibleLeft: 0, visibleRight: 1 }, errors)).toBeNull();
    expect(errors).toEqual(["geometry.directLowerFaceContour.jaw.width:implausible_cross_row_expansion"]);
  });
  it("same cheek / different jaw yields distinct independent layouts", () => {
    const broad = pixels(0.68, 0.3), narrow = pixels(0.5, 0.3);
    expect(broad.layout.faceShape.cheekWidth).toBe(narrow.layout.faceShape.cheekWidth);
    expect(broad.layout.faceShape.jawWidth).not.toBe(narrow.layout.faceShape.jawWidth);
    expect(contourPixels(broad)).not.toEqual(contourPixels(narrow));
  });
  it("same jaw / different chin yields different chin topology", () => {
    const broad = pixels(0.68, 0.6), narrow = pixels(0.68, 0.3);
    expect(broad.layout.faceShape.jawWidth).toBe(narrow.layout.faceShape.jawWidth);
    expect(contourPixels(broad).filter(p => p.role === "chin_contour")).toHaveLength(0);
    expect(contourPixels(narrow).filter(p => p.role === "chin_contour")).toHaveLength(2);
  });
  it("preserves all five calibrated eye/brow/mouth/nose/hair/glasses/outfit signatures when only contour changes", async () => {
    const annotations = JSON.parse(await readFile("evaluation-artifacts/generalization-20260905/annotations.json", "utf8")) as Array<{ id: string; existing?: boolean }>;
    const calibrated = annotations.filter(a => a.existing);
    expect(calibrated).toHaveLength(5);
    for (const item of calibrated) {
      const stored = JSON.parse(await readFile(`evaluation-artifacts/generalization-20260905/after/${item.id}/analysis-and-plan.json`, "utf8")) as { analysis: PhotoAnalysis };
      const metrics = JSON.parse(await readFile(`evaluation-artifacts/head-structure-iteration-final/${item.id}/metrics.json`, "utf8"));
      const geometry = parseIdentityGeometry(metrics.sourceGeometryAfter)!;
      const base = buildIdentityPixelPlans({ ...stored.analysis, identityGeometry: geometry });
      const middle = (geometry.face.visibleLeft + geometry.face.visibleRight) / 2;
      const w = geometry.face.visibleRight - geometry.face.visibleLeft;
      const h = geometry.face.chinY - geometry.face.foreheadY;
      const boundary = (width: number, row: number) => ({ left: middle - width / 2, right: middle + width / 2,
        y: geometry.face.foreheadY + h * row, evidence: "observed" as const, confidence: 0.9 });
      // Synthetic isolated-axis regression, explicitly not production evidence.
      const direct = { cheek: boundary(w * 0.95, 0.55), jaw: boundary(w * 0.72, 0.8), chin: boundary(w * 0.4, 0.96) };
      expect(parseDirectLowerFaceContour(direct, geometry.face)).not.toBeNull();
      const after = buildIdentityPixelPlans({ ...stored.analysis, identityGeometry: { ...geometry, directLowerFaceContour: direct } });
      const identityCells = (plan: typeof after.facePixelPlan) => plan.pixels.filter(p => p.cluster !== "complexion").sort((a, b) => a.y - b.y || a.x - b.x);
      expect(identityCells(after.facePixelPlan), item.id).toEqual(identityCells(base.facePixelPlan));
      expect(after.hairPlan, item.id).toEqual(base.hairPlan);
      expect(after.outfitPlan, item.id).toEqual(base.outfitPlan);
      expect(after.headIdentityPlan.glasses, item.id).toEqual(base.headIdentityPlan.glasses);
      const contourCells = [...base.facePixelPlan.pixels, ...after.facePixelPlan.pixels]
        .filter(p => p.cluster === "complexion");
      const nonContourOwnership = (value: typeof after.headIdentityPlan.ownership) => value && ({ ...value,
        cells: value.cells.filter(cell => cell.sourceGroupId !== "complexion"
          && !contourCells.some(p => cell.layer === "base" && cell.face === "front" && p.x === cell.x && p.y === cell.y))
          .sort((a, b) => `${a.layer}:${a.face}:${a.x}:${a.y}`.localeCompare(`${b.layer}:${b.face}:${b.x}:${b.y}`)),
      });
      expect(nonContourOwnership(after.headIdentityPlan.ownership), item.id).toEqual(nonContourOwnership(base.headIdentityPlan.ownership));
    }
  });
  it("direct beats derived 0.88 and semantic square without moving any other identity pixels", () => {
    const geometry = directGeometry();
    geometry.faceShape.jawWidth = geometry.faceShape.cheekWidth * 0.88;
    geometry.diagnostics.derivedMeasurements.push("faceShape");
    const base = makeAnalysis();
    const analysis = makeAnalysis({ identityGeometry: geometry, renderHints: { ...base.renderHints, jawShape: "square", faceShape: "square" } });
    const a = buildIdentityPixelPlans(analysis);
    const b = buildIdentityPixelPlans({ ...analysis, identityGeometry: { ...geometry, directLowerFaceContour: directContour(0.72, 0.68, 0.6) } });
    expect(a.facePixelPlan.layout.faceShape.jawWidth).toBe(4);
    expect(a.facePixelPlan.layout.directContour?.jaw?.provenance).toBe("observed_geometry");
    expect(a.facePixelPlan.pixels.filter(p => p.cluster !== "complexion")).toEqual(b.facePixelPlan.pixels.filter(p => p.cluster !== "complexion"));
    expect(a.hairPlan).toEqual(b.hairPlan);
  });
  it("legacy caches parse unchanged and expose derived provenance", () => {
    const legacy = makeIdentityGeometry() as unknown as Record<string, unknown>;
    delete legacy.faceShape;
    const parsed = parseIdentityGeometry(legacy)!;
    expect(parsed.directLowerFaceContour).toBeUndefined();
    expect(parsed.faceShape.jawWidth / parsed.faceShape.cheekWidth).toBeCloseTo(0.88);
    expect(parsed.diagnostics.provenance.faceShape).toBe("derived_geometry");
    expect(parseIdentityGeometry(parsed)?.diagnostics.provenance.faceShape).toBe("derived_geometry");
  });
  it.each(["chinClipped", "sourceChinClipped", "chinOccluded"] as const)("%s removes chin alone", field => {
    const geometry = directGeometry();
    geometry.visibility[field] = true;
    const safe = applyDirectContourVisibility(geometry.directLowerFaceContour, geometry.visibility);
    expect(safe.chin).toEqual({ left: null, right: null, y: null, evidence: "unknown", confidence: 0 });
    expect(safe.cheek).toEqual(geometry.directLowerFaceContour.cheek);
    const plan = buildIdentityPixelPlans(makeAnalysis({ identityGeometry: applyCropVisibility(geometry, geometry.visibility) })).facePixelPlan;
    expect(plan.layout.directContour?.jaw?.width).toBe(4);
    expect(plan.layout.directContour?.chin).toBeUndefined();
    expect(contourPixels(plan).some(p => p.role === "chin_contour")).toBe(false);
  });
  it("no geometry does not fabricate contours; all direct budgets <=6 inside UV", () => {
    expect(contourPixels(buildIdentityPixelPlans(makeAnalysis()).facePixelPlan)).toEqual([]);
    const plan = pixels(0.5, 0.3, 0.61);
    expect(contourPixels(plan).length).toBeLessThanOrEqual(6);
    expect(contourPixels(plan).every(p => p.x >= 1 && p.x <= 6 && p.y <= 7)).toBe(true);
  });
  it("rejects contradictions and nonfinite/hidden-side fabrications without changing values", () => {
    const geometry = directGeometry();
    for (const alter of [
      (c: DirectLowerFaceContour) => { c.jaw.left = 0; },
      (c: DirectLowerFaceContour) => { c.jaw.y = 0.5; },
      (c: DirectLowerFaceContour) => { c.jaw.right = Infinity; },
      (c: DirectLowerFaceContour) => { c.chin.evidence = "unknown"; },
    ]) {
      const c = directContour(); alter(c);
      expect(parseDirectLowerFaceContour(c, geometry.face)).toBeNull();
    }
    expect(parseDirectLowerFaceContour(directContour(), geometry.face)).not.toBeNull();
  });
  it("reuses exact native Gemma transport, reasoning off and two images", async () => {
    const wire = geometryWireFixture();
    expect(validateGeometryProviderShape(wire)).toEqual([]);
    const input = workersAiStructuredInput(geometryEnrichmentRequest("face", "head"), GEOMETRY_ENRICHMENT_MODEL);
    expect(input).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema" } });
    const run = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(wire) } }] }));
    const result = await runIdentityGeometryEnrichment({ AI: { run } } as unknown as Env, "face", "head");
    expect(result.ok).toBe(true);
    expect(result.geometry?.directLowerFaceContour).toEqual(directContour());
    expect(run).toHaveBeenCalledExactlyOnceWith(GEOMETRY_ENRICHMENT_MODEL, input);
  });
  it("deadline stops awaiting one binding call without retry", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise(() => {}));
    const pending = runIdentityGeometryEnrichment({ AI: { run } } as unknown as Env, "face", "head");
    await vi.advanceTimersByTimeAsync(GEOMETRY_ENRICHMENT_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ ok: false, httpStatus: 504 });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(["valid", "provider_error", "invalid_schema", "timeout"])("ordinary /api/generate enrichment is fail-open: %s", async mode => {
    const image = `data:image/png;base64,${bytesToBase64(await encodePng({ width: 320, height: 480, rgba: new Uint8Array(320 * 480 * 4).fill(255) }))}`;
    const sourceAnalysis = makeAnalysis();
    sourceAnalysis.renderHints.fringeOpening = "center";
    const primary = wireFixture(sourceAnalysis);
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(primary) }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn(async () => {
      if (mode === "provider_error") throw new Error("503 provider unavailable");
      if (mode === "invalid_schema") return { response: "{}" };
      if (mode === "timeout") return await new Promise(() => {});
      return { response: geometryWireFixture() };
    });
    const env = { GEMINI_API_KEY: "offline-test-key", AI: { run }, IDENTITY_GEOMETRY_ENRICHMENT_ENABLED: "true",
      IMAGE_GENERATION_ENABLED: "true", IMAGE_CRITIQUE_ENABLED: "true", HEAD_CANDIDATE_SELECTION_ENABLED: "true",
      MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
    } as unknown as Env;
    const pending = worker.fetch(new Request("https://local/api/generate", { method: "POST", body: JSON.stringify({ image }) }), env);
    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; skinPngBase64: string; analysis: { identityGeometry?: unknown } };
    expect(body.ok).toBe(true);
    const png = await decodePng(base64ToBytes(body.skinPngBase64));
    expect([png.width, png.height]).toEqual([64, 64]);
    expect(validateFinalAtlas(png).ok).toBe(true);
    expect(Boolean(body.analysis.identityGeometry)).toBe(mode === "valid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  }, 35_000);
});
