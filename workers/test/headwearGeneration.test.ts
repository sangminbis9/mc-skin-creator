import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHeadwearPaint, headwearFaceOcclusion } from "../../shared/headwear";
import { normalizeFeatures } from "../../src/lib/skinFeatures";
import { observedHeadwearCategory, observedHelmetVisor } from "../src/observedHeadwear";
import { makeAnalysis } from "./helpers";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { wireFixture } from "./compactV3Support";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { renderSkinEngine } from "../src/skinEngine";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { validateAtlasCraftFoundation, validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { encodePng } from "../src/png";
import { buildSkinViewMontage, inspectRenderedSkin, renderSkinViews } from "../src/skinRender";

const cases = [
  ["cap", "A teal baseball cap with a forward brim", "#2f7775"],
  ["beanie", "A burgundy ribbed cuffed knitted beanie", "#6e2638"],
  ["hard_hat", "A bright yellow rigid safety helmet with molded ridges", "#e3c14d"],
  ["full_helmet", "A red full-face motorcycle helmet with an opaque smoked visor and chin guard", "#c0392b"],
  ["helmet", "A white open-face helmet", "#f2f2f2"],
] as const;

describe("headwear source fidelity", () => {
  it.each(cases)("retains %s through optional-cache normalization and the client", (hat, accessories) => {
    const a = makeAnalysis(); a.observed.accessories = accessories;
    const wire = wireFixture(a); delete wire.fallbackFeatures;
    const parsed = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
    expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    expect(parsed.analysis.fallbackFeatures.hat).toBe(hat);
    expect(normalizeFeatures({ hat }).hat).toBe(hat);
  });
  it.each(["Holding a yellow safety helmet", "No red full-face helmet", "A helmet printed on the shirt", "Maybe a blue helmet", "A cap-sleeve blouse", "Holding a red cap", "A picture of a blue helmet"])("does not invent worn headwear: %s", text => {
    expect(observedHeadwearCategory(text)).toBeNull();
    const a = makeAnalysis(); a.observed.accessories = text;
    const wire = wireFixture(a); delete wire.fallbackFeatures;
    const parsed = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.analysis.fallbackFeatures.hat).toBe("none");
  });
  it("does not confuse a mark printed on a worn cap with a picture of a cap", () => {
    expect(observedHeadwearCategory("Wearing a teal baseball cap with a white printed logo")).toBe("cap");
  });
  it("keeps clear/raised visor openings instead of painting them opaque", () => {
    expect(observedHelmetVisor("A clear transparent visor")).toBe("clear");
    expect(observedHelmetVisor("The visor is raised")).toBe("raised");
    expect(observedHelmetVisor("A dark red full-face helmet with a clear visor")).toBe("clear");
    expect(observedHelmetVisor("An opaque visor, not raised")).toBe("opaque");
    expect(headwearFaceOcclusion("full_helmet", "opaque").has("2:4")).toBe(true);
    expect(headwearFaceOcclusion("full_helmet", "clear").has("2:4")).toBe(false);
    expect(headwearFaceOcclusion("full_helmet", "raised").has("2:4")).toBe(false);
  });
  it.each([
    ["A baseball cap in a dark teal color", "cap", "#2f7775"],
    ["A burgundy ribbed wool knitted beanie with a folded cuff", "beanie", "#6e2638"],
    ["A safety helmet in bright yellow", "hard_hat", "#e3c14d"],
    ["A full-face helmet is red with a black visor", "full_helmet", "#c0392b"],
    ["Wearing a teal baseball cap with a white printed logo", "cap", "#2f7775"],
  ])("resolves the headwear material in %s", (accessories, hat, color) => {
    const a = makeAnalysis(); a.observed.accessories = accessories;
    a.fallbackFeatures = { ...a.fallbackFeatures, hat, hatColor: "black" };
    expect(refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures)).hatColor).toBe(color);
  });
  it("preserves an exact provider shell color instead of quantizing it to a broad name", () => {
    const a = makeAnalysis(); a.observed.accessories = "A red full-face helmet with black visor";
    a.fallbackFeatures = { ...a.fallbackFeatures, hat: "full_helmet", hatColor: "#d53226" };
    expect(refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures)).hatColor).toBe("#d53226");
  });
  it.each(["clear", "raised"] as const)("keeps visible eyes with a %s visor through the full engine", visor => {
    const raw = makeAnalysis(); raw.observed.accessories = `A red full-face helmet with a ${visor} visor`;
    raw.fallbackFeatures = { ...raw.fallbackFeatures, hat: "full_helmet", hatColor: "red", hatVisor: visor, glasses: "none", facialHair: "none", earrings: false };
    const a = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(a);
    const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures)), style = buildFaceStyle(a, features, plan.hairPlan);
    const baseline = buildProceduralSourceAtlas(features, style, plan)!;
    const result = renderSkinEngine(baseline, plan, a, style);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(plan.facePixelPlan.pixels.filter(p => p.role === "iris").length).toBeGreaterThanOrEqual(2);
    expect(plan.facePixelPlan.renderContract.eyes).toBeDefined();
  });
  it.each(cases)("renders a legal, shaded and source-owned %s through the full engine", async (hat, accessories, color) => {
    const raw = makeAnalysis(); raw.observed.accessories = accessories;
    raw.fallbackFeatures = { ...raw.fallbackFeatures, glasses: "none", facialHair: "none", earrings: false, hat, hatColor: "black" };
    if (hat === "full_helmet") { raw.visibleRegions.face = false; raw.visibleRegions.hair = false; raw.observed.face = "Hidden behind opaque visor"; raw.observed.hair = "Not visible"; }
    const a = normalizeAnalysisForRendering(raw), immutable = JSON.stringify(a);
    const f = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures));
    expect(f.hatColor).toBe(color);
    const plan = buildSkinPlan(a), style = buildFaceStyle(a, f, plan.hairPlan);
    const baseline = buildProceduralSourceAtlas(f, style, plan);
    expect(baseline).not.toBeNull(); if (!baseline) return;
    const result = renderSkinEngine(baseline, plan, a, style);
    if (!result.ok) {
      const candidates = selectReferenceStyleAtlas(baseline, plan, buildReferenceStylePlan(a), style);
      console.info(JSON.stringify({ hat, reason: result.reason, foundation: validateAtlasCraftFoundation(baseline, style).problems,
        candidates: candidates.candidates.map(c => ({ quality: c.quality?.violations, foundation: c.foundation?.problems, error: c.error })) }));
    }
    expect(result.ok).toBe(true); if (!result.ok) return;
    const paint = buildHeadwearPaint(hat, String(f.hatColor), style.hatVisor);
    for (const c of paint) {
      const r = CLASSIC_LAYOUT.head[c.layer][c.face], i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      expect([...result.atlas.rgba.slice(i, i + 4)]).toEqual([...c.color, 255]);
    }
    expect(paint.filter(c => c.layer === "overlay").length).toBeGreaterThan(10);
    expect(paint.filter(c => c.layer === "overlay").length).toBeLessThan(154);
    if (hat === "full_helmet") {
      expect(plan.facePixelPlan.pixels).toHaveLength(0);
      expect(plan.facePixelPlan.renderContract.eyes).toBeUndefined();
    } else expect(plan.facePixelPlan.pixels.some(p => p.role === "iris")).toBe(true);
    expect(validateFinalAtlas(result.atlas).ok).toBe(true);
    const views = renderSkinViews(result.atlas);
    expect(inspectRenderedSkin(views).ok).toBe(true);
    expect(JSON.stringify(a)).toBe(immutable);
    if (process.env.HEADWEAR_ARTIFACT_DIR) {
      const out = process.env.HEADWEAR_ARTIFACT_DIR; mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${hat}-64.png`), await encodePng(result.atlas));
      writeFileSync(join(out, `${hat}-views.png`), await encodePng(buildSkinViewMontage(views)));
    }
  }, 20000);
});
