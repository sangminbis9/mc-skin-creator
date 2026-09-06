import { describe, expect, it } from "vitest";
import { buildOutfitPlan, buildOutfitPlanCandidates } from "../src/outfitIdentity";
import { buildIdentityPixelPlans, buildFacePixelPlanVariants } from "../src/identityPlans";
import { layoutSatisfiesIdentityRenderContract } from "../src/identityQuantization";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { semanticSignatures, semanticConvergence } from "./generalizationSupport";
import { analysisFromAnnotation, colorSupport, convergence, diagnose, FAILURE_CLASSES, signatures, validateManifest, type AnnotatedCase } from "./generalizationSupport";

const annotation = (): AnnotatedCase => ({ id: "contract-only", photoId: 1, sourceUrl: "https://www.pexels.com/photo/contract-only-1/", author: "contract test, not a real dataset entry", framing: "upper_body", pose: "frontal", lighting: "daylight", headBox: [0.1, 0.1, 0.6, 0.4], clothing: "blue long-sleeve shirt", hair: "short hair", face: "closed mouth", accessories: "none visible", upperVisible: true, lowerVisible: false, feetVisible: false, features: { topType: "shirt", topColor: "blue", sleeveLength: "long" }, hints: {}, cues: ["blue shirt"], expected: { upperColor: "#416b9d", hiddenLowerPattern: "none" } });
const atlas = () => ({ width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) });

describe("generalization evidence and ownership contracts (synthetic unit tests)", () => {
  it("rejects insufficient, duplicate and missing-source manifests", () => {
    expect(() => validateManifest([annotation()])).toThrow("insufficient");
    expect(() => validateManifest([annotation(), annotation()], 2)).toThrow("duplicate");
    expect(() => validateManifest([annotation(), { ...annotation(), id: "another" }], 2)).toThrow("duplicate");
    expect(() => validateManifest([{ ...annotation(), author: undefined }], 1)).toThrow("license");
  });
  it("rejects invisible expectations, invalid crops and unsafe inline image payloads", () => {
    expect(() => validateManifest([{ ...annotation(), expected: { lowerColor: "#777777" } }], 1)).toThrow("unobservable");
    expect(() => validateManifest([{ ...annotation(), headBox: [0, 0, NaN, 1] }], 1)).toThrow("crop");
    expect(() => validateManifest([{ ...annotation(), cues: [] }], 1)).toThrow("cue");
    expect(() => validateManifest([{ ...annotation(), clothing: "data:image/png;base64,test" }], 1)).toThrow("payload");
  });
  it("does not inherit glasses, mustard knit, smiles or an observed lower half", () => {
    const a = analysisFromAnnotation(annotation());
    expect(a.fallbackFeatures.glasses).toBe("none");
    expect(a.renderHints.garmentTexture).toBe("plain");
    expect(a.renderHints.mouthOpening).toBe("closed");
    expect(a.observed.accessories).toBe("none visible");
    expect(a.quality).toBe("warn");
    expect(a.identityGeometry).toBeUndefined();
    expect(JSON.stringify(a)).not.toMatch(/mustard|silver-rimmed|warm smile/);
  });
  it.each(["horizontal striped", "checkered", "vertical striped"])("does not invent %s trousers from upper-only evidence", (pattern) => {
    const a = analysisFromAnnotation({ ...annotation(), clothing: `blue ${pattern} shirt with long sleeves` });
    const p = buildOutfitPlan(a);
    expect(p.upper.pattern.kind).not.toBe("none");
    expect(p.lower.pattern.kind).toBe("none");
    expect(p.lower.source).toBe("conservative");
    expect(p.lower.garmentType).toBe("pants");
    expect(p.accessories).toHaveLength(0);
  });
  it.each(["white", "red", "green"])("keeps %s upper color out of gray trousers and footwear", (upper) => {
    const a = analysisFromAnnotation({ ...annotation(), clothing: `${upper} shirt and gray trousers with black shoes`, lowerVisible: true, feetVisible: true });
    const p = buildOutfitPlan(a);
    expect(p.lower.baseColor).toBe("#77777c");
    expect(p.lower.shoeColor).toBe("#242326");
  });
  it("retains light-gray modifiers through actual body pixels", () => {
    const a = analysisFromAnnotation({ ...annotation(), clothing: "light gray sweater", features: { topType: "sweater", topColor: "light-gray" } });
    const p = buildOutfitPlan(a), image = atlas(); applyOutfitPlan(image, p, "#d39e80");
    expect(p.upper.baseColor).toBe("#b7b7b7");
    expect(colorSupport(image, CLASSIC_LAYOUT.body.base.front, "#b7b7b7")).toBeGreaterThan(40);
  });
  it.each(["loafers", "sandals", "footwear"])("keeps the existing %s color vocabulary in scoped evidence", (shoes) => {
    const a = analysisFromAnnotation({ ...annotation(), clothing: `red shirt; gray trousers; white ${shoes}`, lowerVisible: true, feetVisible: true });
    expect(buildOutfitPlan(a).lower.shoeColor).toBe("#eeeae1");
  });
  it("keeps a tank's sleeveless grammar and graphic off the outer long-sleeved shirt", () => {
    const a = analysisFromAnnotation({ ...annotation(), clothing: "open vertically striped blue shirt over a white graphic tank top", features: { topType: "shirt", topColor: "blue", sleeveLength: "long" }, hints: { garmentTexture: "striped" } });
    const p = buildOutfitPlan(a), image = atlas(); applyOutfitPlan(image, p, "#d39e80");
    expect(p.upper.leftSleeve.length).toBe("long");
    expect(p.upper.pattern.kind).toBe("vertical_stripe");
    expect(p.upper.neckline.innerVisible).toBe(true);
    expect(colorSupport(image, CLASSIC_LAYOUT.leftArm.base.front, "#416b9d")).toBeGreaterThan(10);
  });
  it("keeps observed lowercase garment motifs and punctuation attachments", () => {
    const a = analysisFromAnnotation({ ...annotation(), clothing: "red shirt, gold shoulder marks, viewer-left chest badge; gray plaid skirt", lowerVisible: true });
    const p = buildOutfitPlan(a);
    expect(p.upper.pattern.kind).toBe("center_graphic");
    expect(p.upper.pattern.anchor).toBe("left");
    expect(p.lower.pattern.kind).toBe("checker_block");
  });
  it.each(["broad curved hair strands", "large shoulder bag", "wide eyes"])("does not turn %s into a mouth-width constraint", (unrelated) => {
    const a = analysisFromAnnotation(annotation());
    a.canonicalIdentity.features.push({ feature: unrelated, category: unrelated.includes("eyes") ? "face" : unrelated.includes("hair") ? "hair" : "accessory", priority: 5, confidence: "high", evidence: "visible", targetRegions: ["head.front"] });
    const p = buildIdentityPixelPlans(a).facePixelPlan;
    expect(p.layout.mouthWidth).toBe(2);
    expect(p.layout.renderContract.mouth?.minimumPerceptualWidth).toBe(2);
    expect(p.candidateCost.violations).toEqual([]);
  });
  it.each(["broad smile", "wide mouth", "mouth is large"])("still honors actual P5 %s evidence", (feature) => {
    const a = analysisFromAnnotation(annotation());
    a.canonicalIdentity.features.push({ feature, category: "face", priority: 5, confidence: "high", evidence: "visible", targetRegions: ["head.front"] });
    const plans = buildFacePixelPlanVariants(a, 3);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every(p => p.layout.mouthWidth >= 4 && p.layout.renderContract.mouth?.protected && layoutSatisfiesIdentityRenderContract(p.layout))).toBe(true);
  });
  it("ignores palette-only changes for structural convergence but sees sleeve changes", () => {
    const p = buildOutfitPlan(analysisFromAnnotation(annotation()));
    const a = atlas(), b = atlas(); applyOutfitPlan(a, p, "#d39e80"); b.rgba.set(a.rgba);
    // Monotonic palette translation preserves each within-face color partition.
    for (let i = 0; i < b.rgba.length; i += 4) if (b.rgba[i + 3]) for (let k = 0; k < 3; k++) b.rgba[i + k] = Math.max(0, b.rgba[i + k] - 4);
    expect(signatures(a)).toEqual(signatures(b));
    const c = atlas(); applyOutfitPlan(c, { ...p, upper: { ...p.upper, leftSleeve: { ...p.upper.leftSleeve, terminationRow: 0 } } }, "#d39e80");
    expect(signatures(a).body).not.toBe(signatures(c).body);
    expect(convergence([signatures(a).body, signatures(b).body]).exactPairs).toBe(1);
  });
  it("detects erased colors independently of a correct plan and classifies severity", () => {
    const c = annotation(), p = buildOutfitPlan(analysisFromAnnotation(c));
    const result = diagnose(c, p, atlas());
    expect(result.failures).toContainEqual(expect.objectContaining({ category: "RENDERER_LOSS", severity: "critical", cue: "upper color" }));
    expect(FAILURE_CLASSES).toHaveLength(10);
  });
  it("keeps the candidate cap deterministic without output diversity tricks", () => {
    const a = makeAnalysis();
    expect(buildOutfitPlanCandidates(a, 20).length).toBeLessThanOrEqual(3);
    expect(buildOutfitPlan(a)).toEqual(buildOutfitPlan(a));
  });
  it("detects semantic plan convergence despite different palettes and evidence labels", () => {
    const first = buildSkinPlan(analysisFromAnnotation(annotation()));
    const second = structuredClone(first);
    second.outfitPlan.upper.baseColor = "#ff0000";
    second.outfitPlan.observedConstruction = "different prose does not confer identity";
    expect(semanticSignatures(first)).toEqual(semanticSignatures(second));
    expect(semanticConvergence([semanticSignatures(first).body, semanticSignatures(second).body]).equalPairs).toBe(1);
    second.outfitPlan.upper.leftSleeve.terminationRow = 0;
    expect(semanticSignatures(first).body).not.toEqual(semanticSignatures(second).body);
  });
});
