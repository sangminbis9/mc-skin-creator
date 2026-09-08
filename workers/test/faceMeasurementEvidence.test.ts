import { describe, expect, it, vi } from "vitest";
import { ANALYSIS_PROMPT, PHOTO_ANALYSIS_SCHEMA, runPhotoAnalysis, validatePhotoAnalysis } from "../src/analysis";
import { FACE_MEASUREMENT_VALUES, FACE_MEASUREMENT_EVIDENCE_SCHEMA, parseFaceMeasurementEvidence, resolveFaceMeasurements, type FaceMeasurementEvidence } from "../src/faceMeasurementEvidence";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

/** Synthetic contract fixture only; never a frozen person's measurement. */
function evidence(overrides: Partial<FaceMeasurementEvidence["cues"]> = {}): FaceMeasurementEvidence {
  return {
    referenceImageIndex: 0,
    cues: { ...Object.fromEntries(Object.keys(FACE_MEASUREMENT_VALUES).map(key => [key, { value: "unknown", provenance: "unknown", confidence: 0 }])), ...overrides } as FaceMeasurementEvidence["cues"],
  };
}
function subject(faceMeasurementEvidence?: FaceMeasurementEvidence) {
  const seed = makeAnalysis();
  return makeAnalysis({
    canonicalIdentity: { ...seed.canonicalIdentity, features: seed.canonicalIdentity.features.filter(f => f.category !== "face" && f.category !== "accessory") },
    fallbackFeatures: { ...seed.fallbackFeatures, glasses: "none", expression: "neutral" },
    observed: { ...seed.observed, face: "visible face", accessories: "none" },
    renderHints: { ...seed.renderHints, faceShape: "oval", eyeShape: "almond", eyeSize: "average", eyeSpacing: "average", mouthShape: "small", mouthOpening: "closed", bangs: "none", bangsLength: "none", eyebrowShape: "straight" },
    ...(faceMeasurementEvidence ? { faceMeasurementEvidence } : {}),
  });
}
const observed = <T extends string>(value: T) => ({ value, provenance: "observed_categorical" as const, confidence: 0.9 });
const plan = (input: ReturnType<typeof subject>) => buildFacePixelPlanVariants(input, 1)[0];
const pixels = (input: ReturnType<typeof subject>) => plan(input).pixels;

describe("primary categorical face measurement evidence", () => {
  it("keeps the primary schema additive, compact and serializable", () => {
    expect(PHOTO_ANALYSIS_SCHEMA.required).not.toContain("faceMeasurementEvidence");
    expect(inspectGeminiResponseSchema(FACE_MEASUREMENT_EVIDENCE_SCHEMA)).toMatchObject({ valid: true, jsonSerializable: true, unsupportedConstructs: [] });
    expect(JSON.stringify(FACE_MEASUREMENT_EVIDENCE_SCHEMA).length).toBeLessThan(3500);
    expect(ANALYSIS_PROMPT).toContain("SAME primary response");
    expect(validatePhotoAnalysis(makeAnalysis()).ok).toBe(true);
    expect(parseFaceMeasurementEvidence(undefined, 0, true)).toBeUndefined();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.74, 1.1])("keeps unsafe confidence %s unknown", confidence => {
    const parsed = parseFaceMeasurementEvidence(evidence({ eyeSpacing: { ...observed("wide"), confidence } }), 0, true)!;
    expect(parsed.cues.eyeSpacing).toEqual({ value: "unknown", provenance: "unknown", confidence: 0 });
  });

  it("rejects fabricated calibration, wrong source index, hidden face, and malformed categories", () => {
    const raw = evidence({ eyeSpacing: observed("wide") });
    expect(parseFaceMeasurementEvidence(raw, 1, true)!.cues.eyeSpacing.value).toBe("unknown");
    expect(parseFaceMeasurementEvidence(raw, 0, false)!.cues.eyeSpacing.value).toBe("unknown");
    for (const invalid of [{ ...raw.cues.eyeSpacing, provenance: "calibrated_geometry" }, { ...raw.cues.eyeSpacing, value: 0.7 }]) {
      expect(parseFaceMeasurementEvidence({ ...raw, cues: { eyeSpacing: invalid } }, 0, true)!.cues.eyeSpacing.value).toBe("unknown");
    }
  });

  it("never upgrades legacy defaults, inferred cues or unknown cues into observations", () => {
    const legacy = subject();
    const inferred = subject(evidence({ eyeSpacing: { value: "wide", provenance: "inferred", confidence: 0.95 } }));
    expect(resolveFaceMeasurements(legacy).eyeSpacing.provenance).toBe("unknown");
    expect(resolveFaceMeasurements(inferred).eyeSpacing).toMatchObject({ provenance: "inferred", selected: "legacy_fallback" });
    expect(pixels(inferred)).toEqual(pixels(legacy));
    expect(pixels(subject(evidence()))).toEqual(pixels(legacy));
  });

  it("preserves discrete spacing and aperture separately without creating geometry", () => {
    const narrow = subject(evidence({ eyeSpacing: observed("narrow"), eyeFootprint: observed("compact"), eyeOpenness: observed("narrow") }));
    const wide = subject(evidence({ eyeSpacing: observed("wide"), eyeFootprint: observed("medium"), eyeOpenness: observed("open") }));
    const n = plan(narrow), w = plan(wide);
    const gap = (p: typeof n) => p.layout.rightEyeXs[0] - p.layout.leftEyeXs.at(-1)!;
    const wideCompact = plan(subject(evidence({ eyeSpacing: observed("wide"), eyeFootprint: observed("compact") })));
    expect(gap(wideCompact)).toBeGreaterThan(gap(n));
    expect(n.layout.eyeTopology).toBe("compact_dark");
    expect(w.layout.eyeTopology).toBe("open_iris_sclera");
    expect(n.layout.eyeWidth).toBe(1);
    expect(w.layout.eyeWidth).toBe(2);
    expect(w.layout.measurementTrace?.eyeOpenness.selected).toBe("categorical_grammar");
    expect(w.layout.geometryUsage.eyes).toBe(false);
    expect(narrow.identityGeometry).toBeUndefined();
    expect(wide.identityGeometry).toBeUndefined();
    for (const p of [n, w]) {
      const start = Math.floor((8 - p.layout.faceWindow.visibleWidthAtEyes) / 2);
      const end = start + p.layout.faceWindow.visibleWidthAtEyes - 1;
      expect([...p.layout.leftEyeXs, ...p.layout.rightEyeXs].every(x => x >= start && x <= end)).toBe(true);
    }
  });

  it("adds a visible high brow relation and preserves mouth width/opening without invented mouth Y", () => {
    const close = plan(subject(evidence({ browEyeDistance: observed("close"), mouthWidth: observed("narrow"), mouthOpenness: observed("closed") })));
    const high = plan(subject(evidence({ browEyeDistance: observed("high"), mouthWidth: observed("wide"), mouthOpenness: observed("teeth"), expression: observed("smile") })));
    expect(high.layout.leftEyeRow - high.layout.leftBrowRow).toBeGreaterThan(close.layout.leftEyeRow - close.layout.leftBrowRow);
    expect(high.layout.mouthWidth).toBe(4);
    expect(close.layout.mouthWidth).toBe(2);
    expect(high.layout.mouthTopology).toBe("wide_teeth_smile");
    expect(close.layout.mouthTopology).toBe("closed_compact");
    expect(high.layout.mouthRow).toBe(6);
    expect(high.layout.geometryUsage.mouth).toBe(false);
  });

  it("keeps all accepted continuous geometry above conflicting categorical cues", () => {
    const base = { ...subject(), identityGeometry: makeIdentityGeometry({ glasses: null }) };
    const conflicting = { ...base, faceMeasurementEvidence: evidence({ eyeSpacing: observed("wide"), eyeOpenness: observed("open"), browEyeDistance: observed("high"), mouthWidth: observed("narrow"), mouthOpenness: observed("closed") }) };
    expect(plan(conflicting).pixels).toEqual(plan(base).pixels);
    const { measurementTrace, ...layout } = plan(conflicting).layout;
    expect(layout).toEqual(plan(base).layout);
    expect(measurementTrace?.eyeSpacing.provenance).toBe("calibrated_geometry");
    const g = makeIdentityGeometry();
    const partial = { ...conflicting, identityGeometry: makeIdentityGeometry({ glasses: null, confidence: { ...g.confidence, brows: 0.3 } }) };
    expect(plan(partial).layout.measurementTrace?.browEyeDistance.selected).toBe("categorical_grammar");
    expect(plan(partial).layout.measurementTrace?.eyeSpacing.selected).toBe("continuous_geometry");
    expect(plan(partial).layout.leftEyeRow - plan(partial).layout.leftBrowRow).toBe(2);
    expect(plan(partial).layout.rightEyeRow - plan(partial).layout.rightBrowRow).toBe(2);
    expect(plan(partial).layout.geometryTarget.leftBrowEyeDistance).toBe(2);
  });

  it("prioritizes an observed medium mouth over a conflicting legacy wide hint", () => {
    const input = subject(evidence({ mouthWidth: observed("medium") }));
    input.renderHints.mouthShape = "wide";
    expect(plan(input).layout.mouthWidth).toBe(3);
  });

  it("fits every spacing/footprint combination without leaving the visible eye window", () => {
    for (const faceShape of ["oval", "round"] as const) for (const earExposure of ["covered", "partial", "visible"] as const) {
      for (const eyeSpacing of ["narrow", "medium", "wide"] as const) for (const eyeFootprint of ["compact", "medium", "wide"] as const) {
        const input = subject(evidence({ eyeSpacing: observed(eyeSpacing), eyeFootprint: observed(eyeFootprint) }));
        input.renderHints.faceShape = faceShape;
        input.renderHints.earExposure = earExposure;
        const p = plan(input).layout;
        const start = Math.floor((8 - p.faceWindow.visibleWidthAtEyes) / 2);
        const end = start + p.faceWindow.visibleWidthAtEyes - 1;
        expect([...p.leftEyeXs, ...p.rightEyeXs].every(x => Number.isInteger(x) && x >= start && x <= end)).toBe(true);
        expect(p.rightEyeXs[0] - p.leftEyeXs.at(-1)!).toBeGreaterThanOrEqual(2);
        expect(p.leftEyeXs.length).toBe(p.eyeWidth);
        expect(p.rightEyeXs.length).toBe(p.eyeWidth);
        expect(p.rightEyeXs).toEqual(p.leftEyeXs.map(x => 7 - x).reverse());
      }
    }
  });

  it("preserves glasses openings and keeps occluded eye evidence from changing their layout", () => {
    const base = makeAnalysis();
    const input = { ...base, faceMeasurementEvidence: evidence({ eyeSpacing: observed("wide"), eyeOpenness: observed("open") }) };
    expect(plan(input).glassesPlan).toEqual(plan(base).glassesPlan);
    expect(plan(input).pixels).toEqual(plan(base).pixels);
    expect(plan(input).layout.measurementTrace?.eyeSpacing.selected).toBe("legacy_fallback");
  });

  it("keeps candidate count bounded and does not mutate shared analysis, hair or outfit hints", () => {
    const input = subject(evidence({ browEyeDistance: observed("high"), eyeOpenness: observed("open") }));
    const before = JSON.stringify(input);
    const first = buildFacePixelPlanVariants(input, 99);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(buildFacePixelPlanVariants(input, 99)).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
    expect(normalizeAnalysisForRendering(input).faceMeasurementEvidence).toEqual(input.faceMeasurementEvidence);
  });

  it.each(["light", "medium", "dark"])("carries observed brow and mouth cues to %s complexion atlas while preserving body and head outside face", skinTone => {
    const base = subject();
    base.fallbackFeatures.skinTone = skinTone;
    // Use a readable existing smile foundation on every complexion; this test
    // exercises evidence transport, not the frozen closed-mouth palette.
    base.renderHints.mouthShape = "wide";
    base.renderHints.mouthOpening = "teeth_visible";
    const changed = { ...base, faceMeasurementEvidence: evidence({ browEyeDistance: observed("high"), mouthWidth: observed("wide"), mouthOpenness: observed("teeth") }) };
    const render = (input: typeof base) => {
      const normalized = normalizeAnalysisForRendering(input);
      const features = refineFeatureColorsFromAnalysis(normalized, fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
      const skinPlan = buildSkinPlan(normalized);
      return { atlas: buildProceduralFallbackAtlas(features, buildFaceStyle(normalized, features), skinPlan), skinPlan };
    };
    const before = render(base), after = render(changed);
    expect(before.atlas).not.toBeNull();
    expect(after.atlas).not.toBeNull();
    const fronts = [CLASSIC_LAYOUT.head.base.front, CLASSIC_LAYOUT.head.overlay.front];
    let changedFace = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const offset = (y * 64 + x) * 4;
      const a = [...before.atlas!.rgba.slice(offset, offset + 4)], b = [...after.atlas!.rgba.slice(offset, offset + 4)];
      if (fronts.some(front => x >= front.x && x < front.x + front.w && y >= front.y && y < front.y + front.h)) changedFace += Number(a.join() !== b.join());
      else expect(b, `unrelated UV ${x},${y}`).toEqual(a);
    }
    expect(changedFace).toBeGreaterThan(0);
    expect(after.skinPlan.facePixelPlan.layout.measurementTrace?.mouthWidth.selected).toBe("categorical_grammar");
  });

  it("carries provider evidence through one mocked primary call, parser, normalization and FacePixelPlan", async () => {
    const response = makeAnalysis({ faceMeasurementEvidence: evidence({ browEyeDistance: observed("high") }) });
    const run = vi.fn(async () => ({ response }));
    const env = { VISION_MODEL: "test-primary", VISION_FALLBACK_MODEL: "test-fallback", AI: { run } } as unknown as Env;
    const result = await runPhotoAnalysis(env, "data:image/png;base64,synthetic-test");
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("mock primary failed");
    expect(plan(normalizeAnalysisForRendering(result.analysis)).layout.measurementTrace?.browEyeDistance).toMatchObject({ value: "high", provenance: "observed_categorical", selected: "categorical_grammar" });
    expect(result.analysis.identityGeometry).toBeUndefined();
  });

  it("uses the existing Gemini primary envelope once and keeps the selected photo provenance", async () => {
    const response = makeAnalysis({ faceMeasurementEvidence: evidence({ browSlope: observed("arched"), eyeOpenness: observed("normal") }) });
    response.sourceSelection.portraitImageIndex = 1;
    response.faceMeasurementEvidence!.referenceImageIndex = 1;
    expect(validatePhotoAnalysis(response).ok).toBe(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const fallback = vi.fn();
    try {
      const env = { GEMINI_API_KEY: "offline-test-key", VISION_MODEL: "gemini-3.6-flash", AI: { run: fallback } } as unknown as Env;
      const result = await runPhotoAnalysis(env, ["data:image/png;base64,iVBORw0KGgo=", "data:image/png;base64,iVBORw0KGgo="]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
      const [url, request] = fetchSpy.mock.calls[0];
      expect(String(url)).toMatch(/\/v1beta\/models\/gemini-3\.6-flash:generateContent$/);
      const body = JSON.parse(String(request!.body));
      expect(body.generationConfig.responseJsonSchema.properties.faceMeasurementEvidence).toEqual(FACE_MEASUREMENT_EVIDENCE_SCHEMA);
      expect(body).not.toHaveProperty("response_format");
      expect(body.contents[0].parts.filter((p: Record<string, unknown>) => p.inlineData)).toHaveLength(2);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("mock Gemini primary failed");
      expect(result.attempts).toBe(1);
      expect(result.analysis.faceMeasurementEvidence!.referenceImageIndex).toBe(1);
      expect(plan(result.analysis).layout.browTiltOffset).toBe(1);
      expect(plan(result.analysis).layout.measurementTrace?.browSlope.provenance).toBe("observed_categorical");
    } finally { fetchSpy.mockRestore(); }
  });
});
