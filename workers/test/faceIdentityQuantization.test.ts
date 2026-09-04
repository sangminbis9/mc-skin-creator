import { describe, expect, it } from "vitest";
import { measureFaceIdentityRetention, measureFacePlanPixelDifference, measureGenericFaceConvergence } from "../src/faceIdentityFidelity";
import { buildFaceIdentitySaliencePlan, faceSalienceScore } from "../src/faceIdentitySalience";
import { buildFacePixelPlanVariants, measureFacePixelPlanCost } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function withoutGlasses() {
  const base = makeAnalysis();
  return makeAnalysis({
    canonicalIdentity: {
      ...base.canonicalIdentity,
      features: base.canonicalIdentity.features.filter((feature) => !/glass/i.test(feature.feature)),
    },
    fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" },
    observed: { ...base.observed, accessories: "no glasses" },
    negativePrompt: "no glasses",
  });
}

describe("source-specific face identity quantization", () => {
  it("jointly preserves wide and close eye spacing instead of rounding each half independently", () => {
    const analysis = withoutGlasses();
    const source = makeIdentityGeometry();
    const wide = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null,
      eyes: { ...source.eyes, leftCenterX: 0.27, rightCenterX: 0.75, interEyeDistance: 0.48 },
    }) }, 1)[0];
    const close = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null,
      eyes: { ...source.eyes, leftCenterX: 0.42, rightCenterX: 0.58, interEyeDistance: 0.16 },
    }) }, 1)[0];
    const spacing = (plan: typeof wide) => {
      const left = plan.layout.leftEyeXs.reduce((sum, value) => sum + value, 0) / plan.layout.leftEyeXs.length;
      const right = plan.layout.rightEyeXs.reduce((sum, value) => sum + value, 0) / plan.layout.rightEyeXs.length;
      return right - left;
    };
    expect(spacing(wide)).toBeGreaterThan(spacing(close));
    expect(wide.layout.leftEyeXs).not.toEqual(close.layout.leftEyeXs);
    expect(wide.layout.rightEyeXs).not.toEqual(close.layout.rightEyeXs);
  });

  it("preserves confident width/row asymmetry and suppresses low-confidence perspective noise", () => {
    const analysis = withoutGlasses();
    const source = makeIdentityGeometry();
    const asymmetricEyes = { ...source.eyes, leftWidth: 0.07, rightWidth: 0.22, leftCenterY: 0.35, rightCenterY: 0.52, verticalAsymmetry: -0.17 };
    const confident = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null, eyes: asymmetricEyes, confidence: { ...source.confidence, eyes: 0.94 },
    }) }, 1)[0];
    const uncertain = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null, eyes: asymmetricEyes, confidence: { ...source.confidence, eyes: 0.6 },
    }) }, 1)[0];
    expect(confident.layout.leftEyeWidth).toBeLessThan(confident.layout.rightEyeWidth);
    expect(confident.layout.leftEyeRow).not.toBe(confident.layout.rightEyeRow);
    expect(confident.layout.eyeTopology).toBe("asymmetric");
    expect(uncertain.layout.leftEyeWidth).toBe(uncertain.layout.rightEyeWidth);
    expect(uncertain.layout.leftEyeRow).toBe(uncertain.layout.rightEyeRow);
  });

  it("keeps measured brows above eyes and resolves hairline collisions deterministically", () => {
    const analysis = withoutGlasses();
    const source = makeIdentityGeometry();
    const first = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null,
      eyes: { ...source.eyes, leftCenterY: 0.55, rightCenterY: 0.55 },
      brows: { ...source.brows, leftY: 0.28, rightY: 0.42, thickness: 0.82 },
      hairline: { ...source.hairline, depthByColumn: [0.2, 0.2, 0.2, 0, 0, 0.2, 0.2, 0.2] },
    }) }, 1)[0];
    const second = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null,
      eyes: { ...source.eyes, leftCenterY: 0.55, rightCenterY: 0.55 },
      brows: { ...source.brows, leftY: 0.28, rightY: 0.42, thickness: 0.82 },
      hairline: { ...source.hairline, depthByColumn: [0.2, 0.2, 0.2, 0, 0, 0.2, 0.2, 0.2] },
    }) }, 1)[0];
    expect(first).toEqual(second);
    expect(first.layout.leftBrowRow).toBeLessThan(first.layout.leftEyeRow);
    expect(first.layout.rightBrowRow).toBeLessThan(first.layout.rightEyeRow);
    expect(first.layout.leftBrowRow).not.toBe(first.layout.rightBrowRow);
    const brows = first.pixels.filter((pixel) => pixel.role === "brow");
    const eyes = first.pixels.filter((pixel) => pixel.role === "iris" || pixel.role === "sclera");
    const fringe = first.pixels.filter((pixel) => pixel.cluster === "fringe");
    expect(brows.every((brow) => !eyes.some((eye) => eye.x === brow.x && eye.y === brow.y))).toBe(true);
    expect(brows.every((brow) => !fringe.some((hair) => hair.x === brow.x && hair.y === brow.y))).toBe(true);
  });

  it("uses an adjacent cell to retain a confident tilt when an eye is one cell wide", () => {
    const analysis = withoutGlasses();
    const source = makeIdentityGeometry();
    const tilted = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null,
      eyes: { ...source.eyes, leftWidth: 0.08, rightWidth: 0.08 },
      brows: { ...source.brows, tilt: 0.1 },
      confidence: { ...source.confidence, brows: 0.9 },
    }) }, 1)[0];
    const flat = buildFacePixelPlanVariants({ ...analysis, identityGeometry: makeIdentityGeometry({
      glasses: null,
      eyes: { ...source.eyes, leftWidth: 0.08, rightWidth: 0.08 },
      brows: { ...source.brows, tilt: 0.03 },
      confidence: { ...source.confidence, brows: 0.9 },
    }) }, 1)[0];
    const browCells = (plan: typeof tilted) => plan.pixels.filter((pixel) => pixel.role === "brow");
    expect(tilted.layout.leftEyeWidth).toBe(1);
    expect(tilted.layout.browTiltOffset).toBe(1);
    expect(browCells(tilted)).toHaveLength(browCells(flat).length + 2);
    expect(browCells(tilted).every((pixel) => pixel.y < tilted.layout.leftEyeRow)).toBe(true);
  });

  it("uses salient source mouth width/topology/Y and keeps alternatives bounded", () => {
    const base = withoutGlasses();
    const source = makeIdentityGeometry();
    const analysis = {
      ...base,
      identityGeometry: makeIdentityGeometry({
        glasses: null,
        mouth: { ...source.mouth, width: source.face.visibleRight - source.face.visibleLeft > 0 ? 3.4 * (source.face.visibleRight - source.face.visibleLeft) / 8 : 0.3, centerY: 0.82, opening: "teeth" },
      }),
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: [{ feature: "wide toothy mouth", category: "face" as const, priority: 5 as const, confidence: "high" as const, evidence: "broad visible teeth", targetRegions: ["head.front"] }],
      },
    };
    const variants = buildFacePixelPlanVariants(analysis, 20);
    expect(variants.length).toBeLessThanOrEqual(3);
    expect(variants[0].layout.mouthWidth).toBe(4);
    expect(variants[0].layout.mouthRow).toBe(6);
    expect(variants[0].layout.mouthTopology).toBe("wide_teeth_smile");
    expect(variants.every((plan) => measureFacePixelPlanCost(plan).p5ContractViolations === 0)).toBe(true);
  });

  it("constrains eyes to the face window and keeps both glasses lens openings readable", () => {
    const source = makeIdentityGeometry();
    const plan = buildFacePixelPlanVariants(makeAnalysis({ identityGeometry: makeIdentityGeometry({
      faceWindow: { ...source.faceWindow, visibleFaceWidthAtEyes: 0.62 },
    }) }), 1)[0];
    const start = Math.floor((8 - plan.layout.faceWindow.visibleWidthAtEyes) / 2);
    const end = start + plan.layout.faceWindow.visibleWidthAtEyes - 1;
    expect([...plan.layout.leftEyeXs, ...plan.layout.rightEyeXs].every((x) => x >= start && x <= end)).toBe(true);
    expect(plan.glassesPlan.lensOpenings.every((opening) =>
      plan.layout.leftEyeXs.includes(opening.x) || plan.layout.rightEyeXs.includes(opening.x),
    )).toBe(true);
    expect(plan.glassesPlan.framePixels.some((frame) => plan.glassesPlan.lensOpenings.some((opening) => frame.face === "front" && frame.x === opening.x && frame.y === opening.y))).toBe(false);
  });

  it("allocates source-conditioned salience budgets rather than one fixed face template", () => {
    const base = withoutGlasses();
    const source = makeIdentityGeometry();
    const eyes = buildFaceIdentitySaliencePlan({ ...base, identityGeometry: makeIdentityGeometry({
      glasses: null,
      eyes: { ...source.eyes, leftCenterX: 0.25, rightCenterX: 0.77, interEyeDistance: 0.52, openness: 0.92 },
    }) });
    const mouth = buildFaceIdentitySaliencePlan({ ...base, identityGeometry: makeIdentityGeometry({
      glasses: null,
      mouth: { ...source.mouth, width: 0.48, opening: "teeth" },
    }) });
    expect(eyes.primary.map((cue) => cue.axis)).not.toEqual(mouth.primary.map((cue) => cue.axis));
    expect(faceSalienceScore(eyes, "eye_spacing")).toBeGreaterThan(faceSalienceScore(mouth, "eye_spacing"));
    expect(mouth.pixelBudget.mouth).toBeGreaterThanOrEqual(eyes.pixelBudget.mouth);
  });

  it("reports stage retention, feature pixel diffs, and reduced source-backed convergence", () => {
    const base = withoutGlasses();
    const source = makeIdentityGeometry();
    const inputs = [
      makeIdentityGeometry({ glasses: null, eyes: { ...source.eyes, leftCenterX: 0.27, rightCenterX: 0.75, interEyeDistance: 0.48 } }),
      makeIdentityGeometry({ glasses: null, eyes: { ...source.eyes, leftCenterX: 0.42, rightCenterX: 0.58, interEyeDistance: 0.16 }, mouth: { ...source.mouth, width: 0.2, opening: "closed" } }),
      makeIdentityGeometry({ glasses: null, brows: { ...source.brows, leftY: 0.24, rightY: 0.28, thickness: 0.9 }, mouth: { ...source.mouth, centerY: 0.84 } }),
    ];
    const plans = inputs.map((identityGeometry) => buildFacePixelPlanVariants({ ...base, identityGeometry }, 1)[0]);
    const convergence = measureGenericFaceConvergence(plans);
    expect(convergence.identicalFullPatterns).toBe(0);
    expect(convergence.convergence).toBeLessThan(0.75);
    const retention = measureFaceIdentityRetention({ ...base, identityGeometry: inputs[0] }, plans[0]);
    expect(retention.stageRetention.geometryToQuantized).toBeGreaterThan(0.5);
    expect(retention.largestLossStage).toBe("geometry_to_quantization");
    const difference = measureFacePlanPixelDifference(plans[0], plans[1]);
    expect(difference.changedFace).toBeGreaterThan(0);
    expect(difference.eyes + difference.mouth).toBeGreaterThan(0);
  });
});
