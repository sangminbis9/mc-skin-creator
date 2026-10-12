// Offline: preserve historical H-004; presentation change, not new source evidence.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { FACE_STYLE_TEMPLATES, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildProceduralSourceAtlas } from "../src/generate";
import { referenceMouthPresentation } from "../src/referenceFaceFinish";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";
import { withHistoricalCalmMouth } from "./historicalHairMaterial";

const root = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-004";
const bytes = readFileSync(`${root}/summary.json`);
const trace = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function context() {
  const plan: SkinPlan = structuredClone(trace.skinPlan.skinPlan);
  const style: FaceStyle = structuredClone(trace.injectedParameters.faceStyle);
  const design: ReferenceStylePlan = structuredClone(trace.referenceStyle.design);
  return { plan, style, design };
}

it("restores the current preference even when a synchronous historical replay throws", () => {
  const before = JSON.stringify(FACE_STYLE_TEMPLATES);
  expect(() => withHistoricalCalmMouth(() => { throw new Error("historical_replay_failed"); }))
    .toThrow("historical_replay_failed");
  expect(JSON.stringify(FACE_STYLE_TEMPLATES)).toBe(before);
  const { plan, style, design } = context();
  expect(referenceMouthPresentation(plan.facePixelPlan, design, style, [])).toBe("omit_neutral");
});

it.each(["smile", "open", "full", "red", "wide", "protected", "geometry", "corners", "teeth", "asymmetric", "collision", "unknown", "legacy"])(
  "retains source mouth in calm family for %s", condition => {
    const { plan, style, design } = context(), face = plan.facePixelPlan;
    const protectedCells: Array<{ x: number; y: number }> = [];
    if (condition === "smile") style.expression = "smile";
    if (condition === "open") style.mouthOpening = "slightly_open";
    if (condition === "full") style.lipFullness = "full";
    if (condition === "red") style.lipColor = "red";
    if (condition === "wide") style.mouthShape = "wide";
    if (condition === "protected") face.renderContract.mouth!.protected = true;
    if (condition === "geometry") face.protectedGeometry.push("mouth");
    if (condition === "corners") face.layout.mouthCornerOffsets = [-1, 0];
    if (condition === "teeth") face.pixels.find(p => p.cluster === "mouth")!.role = "teeth";
    if (condition === "asymmetric") face.renderContract.mouth!.preserveAsymmetry = true;
    if (condition === "collision") protectedCells.push(face.pixels.find(p => p.cluster === "mouth")!);
    if (condition === "unknown") delete style.lipColor;
    if (condition === "legacy") design.version = "reference_style_v1";
    expect(referenceMouthPresentation(face, design, style, protectedCells)).toBe("retain_source");
  });

it("isolates three lip cells in actual neutral H evidence, preserving plan, eyes, hair and outfit", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const { plan, style, design } = context(), identity = JSON.stringify(plan);
    expect(design.face.family).toBe("soft_feminine_calm");
    expect(trace.primary.faceMeasurementEvidence.cues.expression).toMatchObject({ value: "neutral", confidence: 0.9 });
    expect(style).toMatchObject({ expression: "neutral", mouthShape: "small", mouthOpening: "closed", lipColor: "natural" });
    const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, style, plan)!;
    // V1 keeps exactly the former retained-mouth decision; no historical bytes are rewritten.
    const before = composeReferenceStyleAtlas(baseline, plan, { ...design, version: "reference_style_v1" }, style);
    expect(before.atlas.rgba).toEqual((await decodePng(readFileSync(`${root}/skin.png`))).rgba);
    const after = composeReferenceStyleAtlas(baseline, plan, design, style);
    const front = CLASSIC_LAYOUT.head.base.front;
    const lips = plan.facePixelPlan.pixels.filter(p => p.cluster === "mouth");
    const allowed = new Set(lips.map(p => (front.y + p.y) * 64 + front.x + p.x));
    const changed = Array.from({ length: 4096 }, (_, i) => i).filter(i => [0, 1, 2, 3].some(c => before.atlas.rgba[i * 4 + c] !== after.atlas.rgba[i * 4 + c]));
    expect(changed).toHaveLength(3); expect(changed.every(p => allowed.has(p))).toBe(true);
    expect(JSON.stringify(plan)).toBe(identity);
    expect(after.diagnostic.faceFinish.mouthPresentation).toBe("omit_neutral");
    const quality = measureReferenceRenderedQuality(after, baseline, plan, design, style);
    expect(quality.constructionValid, quality.violations.join(",")).toBe(true);
    const craft = validateReferenceAtlasCraft(after.atlas, baseline, plan, style, buildReferenceCraftPlan(plan, design, after));
    expect(craft.ok, craft.problems.join(",")).toBe(true);
    expect(composeReferenceStyleAtlas(baseline, plan, design, style).atlas.rgba).toEqual(after.atlas.rgba);
    const output = freshAuditOutput("evaluation-artifacts/reference-calm-neutral-mouth-offline-20261010-");
    for (const [name, result] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(result.atlas), { flag: "wx" });
      const view = renderSkinViews(result.atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${output}/${name}-front.png`, await encodePng(scaleNearestNeighbor(view, 192, 384)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ scope: "saved_plan_presentation_counterfactual_not_live",
      sourceSummarySha256: sha(bytes), family: design.face.family, primaryExpression: "neutral", primaryMouth: "small_closed_natural",
      earliestBoundary: "PRESENTATION_FAMILY_FORCED_NEUTRAL_LIP_RETENTION", historicalMatchesLive: true,
      changedPixels: changed.length, outsideMouthDiff: 0, sourcePlanUnchanged: true, craftPass: craft.ok,
      beforeRgba: sha(before.atlas.rgba), afterRgba: sha(after.atlas.rgba), providerCalls: 0 }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info(`CALM_NEUTRAL_MOUTH ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);
