import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import { resolveFaceGeometry, type FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { quantizeResolvedFaceGeometry } from "../src/identityQuantization";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";

const currentPath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009/summary.json";
const priorPath = "evaluation-artifacts/current-source-v4-localization-29002888-live-20260926-002/summary.json";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const shape = (g: FaceIdentityGeometryAnalysis) => {
  const width = g.face.envelopeRight - g.face.envelopeLeft;
  const x = (n: number) => (n - g.face.envelopeLeft) / width * 7;
  return { leftEyeTarget: x(g.eyes.leftCenterX), rightEyeTarget: x(g.eyes.rightCenterX),
    pairCenter: (x(g.eyes.leftCenterX) + x(g.eyes.rightCenterX)) / 2,
    noseTarget: x(g.nose.centerX), mouthTarget: x(g.mouth.centerX),
    eyeSpacing: g.eyes.interEyeDistance / width * 7,
    leftWidth: g.eyes.leftWidth / width * 8, rightWidth: g.eyes.rightWidth / width * 8 };
};

// Coordinate-system diagnostic only: carries all observed coordinates through
// one affine map. Not a recrop, new measurement, repaired value or production input.
function changeCoordinates(input: FaceIdentityGeometryAnalysis): FaceIdentityGeometryAnalysis {
  const g = structuredClone(input), t = (n: number) => n * 0.8 + 0.05;
  g.face = { envelopeLeft: t(g.face.envelopeLeft), envelopeRight: t(g.face.envelopeRight),
    foreheadY: t(g.face.foreheadY), chinY: t(g.face.chinY) };
  for (const k of ["leftCenterX", "rightCenterX", "leftCenterY", "rightCenterY"] as const) g.eyes[k] = t(g.eyes[k]);
  for (const k of ["leftWidth", "rightWidth", "interEyeDistance", "verticalAsymmetry"] as const) g.eyes[k] *= 0.8;
  g.brows.leftY = t(g.brows.leftY); g.brows.rightY = t(g.brows.rightY);
  g.nose.centerX = t(g.nose.centerX); g.nose.contrastY = t(g.nose.contrastY); g.nose.leftRightBias *= 0.8;
  for (const k of ["centerX", "centerY", "leftCornerY", "rightCornerY"] as const) g.mouth[k] = t(g.mouth[k]);
  g.mouth.width *= 0.8;
  for (const edge of Object.values(g.directLowerFaceContour)) {
    if (edge.left !== null) edge.left = t(edge.left);
    if (edge.right !== null) edge.right = t(edge.right);
    if (edge.y !== null) edge.y = t(edge.y);
  }
  return g;
}

it("locates current 009 face displacement before rendering and compares source-linked accepted measurements offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const currentBytes = readFileSync(currentPath), priorBytes = readFileSync(priorPath);
    const current = JSON.parse(currentBytes.toString()).currentDefaultE2E;
    const prior = JSON.parse(priorBytes.toString()).currentSourceV4;
    const live = current.result, primary = live.diagnostics.normalizedPrimary;
    expect(prior.localization.evidence.derivativeSha256).toBe(live.inputs.analysis.sha256);
    expect(prior.geometry).toMatchObject({ providerShapeValid: true, semanticValid: true, errors: [] });
    const original = acceptedFaceGeometry(live.diagnostics.geometry.acceptedGeometry);
    const localized = acceptedFaceGeometry(prior.acceptedGeometry);
    expect(original).toEqual(live.diagnostics.geometry.acceptedGeometry);
    expect(localized).toEqual(prior.acceptedGeometry);
    const context = makeAnalysis({ ...primary, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "" });
    const output = mkdtempSync("evaluation-artifacts/current-default-009-face-origin-20260927-");
    const cases = [];
    const analyses = [original, localized].map(g => normalizeAnalysisForRendering({ ...structuredClone(context), faceIdentityGeometry: g }));
    expect({ ...analyses[0], faceIdentityGeometry: null }).toEqual({ ...analyses[1], faceIdentityGeometry: null });
    for (const [i, analysis] of analyses.entries()) {
      const g = analysis.faceIdentityGeometry!, normalized = shape(g);
      const resolved = resolveFaceGeometry(analysis)!;
      expect(resolved.eyes).toEqual(g.eyes); expect(resolved.face.visibleLeft).toBe(g.face.envelopeLeft);
      const layout = quantizeResolvedFaceGeometry(analysis, resolved);
      const shifted = { ...analysis, faceIdentityGeometry: changeCoordinates(g) };
      const shiftedLayout = quantizeResolvedFaceGeometry(shifted, resolveFaceGeometry(shifted)!);
      for (const k of ["leftEyeXs", "rightEyeXs", "leftEyeRow", "rightEyeRow", "mouthCenterX", "mouthRow", "noseX", "noseY"] as const)
        expect(shiftedLayout[k], k).toEqual(layout[k]);
      expect(layout.geometryTarget.leftEyeCenterX).toBeCloseTo(normalized.leftEyeTarget, 10);
      expect(layout.geometryTarget.rightEyeCenterX).toBeCloseTo(normalized.rightEyeTarget, 10);
      expect(normalized.pairCenter).toBeGreaterThan(3.5);
      const plan = buildSkinPlan(analysis), style = buildFaceStyle(analysis, live.features, plan.hairPlan);
      const atlas = buildProceduralFallbackAtlas(live.features, style, plan);
      expect(atlas).not.toBeNull(); if (!atlas) throw new Error("offline_atlas_rejected");
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      expect(validateAtlasCraft(atlas, style, undefined, undefined, plan).ok).toBe(true);
      const id = i === 0 ? "current-center-fallback" : "historical-localized-counterfactual";
      const view = renderSkinViews(atlas).find(v => v.name === "front")!;
      writeFileSync(`${output}/${id}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
      writeFileSync(`${output}/${id}.png`, await encodePng(atlas), { flag: "wx" });
      cases.push({ id, normalized, layout: plan.facePixelPlan.layout, facePlan: plan.facePixelPlan,
        hairPlanHash: sha(JSON.stringify(plan.hairPlan)), outfitPlanHash: sha(JSON.stringify(plan.outfitPlan)),
        coordinateInvariancePass: true, atlasHash: sha(atlas.rgba) });
    }
    expect(cases[0].hairPlanHash).toBe(cases[1].hairPlanHash);
    expect(cases[0].outfitPlanHash).toBe(cases[1].outfitPlanHash);
    expect(cases[0].facePlan).toEqual(live.analysis.skinPlan.facePixelPlan);
    const actualBytes = readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009/skin.png");
    expect(sha(actualBytes)).toBe(current.png.sha256);
    const actual = await decodePng(actualBytes);
    const replay = await decodePng(readFileSync(`${output}/current-center-fallback.png`));
    let frontDiff = 0;
    const explicitScleraPaletteChanges = [];
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) {
      const at = (y * 64 + x) * 4;
      if ([0, 1, 2, 3].some(c => actual.rgba[at + c] !== replay.rgba[at + c])) {
        frontDiff++;
        // Position diagnosis is independent of the later, explicit sclera RGB
        // repair. Require its exact role and color; no other face diff is allowed.
        expect(cases[0].facePlan.pixels.some(p => p.role === "sclera" && p.x + 8 === x && p.y + 8 === y)).toBe(true);
        const skin = [1, 3, 5].map(i => parseInt(live.features.skinTone.slice(i, i + 2), 16));
        expect(Array.from(replay.rgba.slice(at, at + 4)))
          .toEqual([...skin.map((v, i) => Math.round(v * .28 + [236, 232, 218][i] * .72)), 255]);
        expect(actual.rgba[at + 3]).toBe(255);
        explicitScleraPaletteChanges.push({ x, y });
      }
    }
    expect(frontDiff).toBe(cases[0].facePlan.pixels.filter(p => p.role === "sclera").length);
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, productionChange: false,
      currentSummarySha256: sha(currentBytes), historicalSummarySha256: sha(priorBytes),
      sourceDerivativeSha256: live.inputs.analysis.sha256, actualPngSha256: sha(actualBytes), frontDiff, explicitScleraPaletteChanges,
      cases, conclusion: "Right-shifted face-normalized targets already exist in both accepted observations; no raw crop-origin translation leak or downstream positional loss is established.",
      limitation: "Historical V4 geometry is a source-linked counterfactual, not this run's production measurement. Accepted bounds do not prove complete crop coverage or pose-independent identity. Missing rich fields are explicit helper context." }, null, 2), { flag: "wx" });
    expect(readFileSync(currentPath)).toEqual(currentBytes); expect(readFileSync(priorPath)).toEqual(priorBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`FACE_ORIGIN_AUDIT ${output}`);
  } finally { network.mockRestore(); }
}, 30_000);
