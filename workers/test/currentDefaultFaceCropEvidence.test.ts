import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildQuantizedLayoutVariants } from "../src/identityQuantization";
import { parseFaceIdentityGeometry, validateFaceGeometryProviderShape } from "../src/faceIdentityGeometry";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering } from "../src/generate";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { encodePng } from "../src/png";
import { renderSkinViews } from "../src/skinRender";
import { makeAnalysis } from "./helpers";

const evidencePath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004/summary.json";
const evidenceBytes = readFileSync(evidencePath);
const e2e = JSON.parse(evidenceBytes.toString("utf8")).currentDefaultE2E;
const diagnostics = e2e.result.diagnostics;
const crop = e2e.cropReplay.diagnostics;
const saved = diagnostics.normalizedPrimary;
const geometry = diagnostics.geometry.acceptedGeometry;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let fetchGuard: ReturnType<typeof vi.spyOn>;
beforeAll(() => { fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterAll(() => { expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard.mockRestore(); });

it("ties missing localization to the actual transmitted center crop, not a new recrop", () => {
  expect(diagnostics.localization.markerPresent).toBe(false);
  expect(saved.sourceSelection.portraitRegion).toBeNull();
  expect(e2e.cropReplay.matchesActualWire).toBe(true);
  expect(e2e.cropReplay.replaySha256).toBe(e2e.cropReplay.actualWireCropSha256);
  expect(e2e.cropReplay.replaySha256).toBe("0e2a052bc14ca48ed48c57ef646c7c1cc5c995cc497161bbd6ba273a292f6167");
  expect(crop.cropMode).toBe("center_fallback");
  expect(crop.faceCropDimensions).toEqual({ width: 343, height: 382 });
  expect(crop.faceCropLateralGuard.reason).toBe("localized_head_unavailable");
  expect(crop.quality.sourceClippingKnown).toBe(false);
  expect(crop.quality.usableForFaceGeometry).toBe(true);
  // Neither clippingRisk=true nor the false directional flags establish
  // complete face visibility: these fallback fields explicitly lack evidence.
  expect(crop.clippingRisk).toBe(true);
  expect(crop.quality.warnings).toContain("portrait_region_unavailable");
});

it("revalidates only the allowlisted stored geometry, without inventing raw provider output", () => {
  const wire = structuredClone(geometry);
  delete wire.source;
  delete wire.eyes.interEyeDistance;
  delete wire.eyes.verticalAsymmetry;
  delete wire.nose.leftRightBias;
  expect(validateFaceGeometryProviderShape(wire)).toEqual([]);
  const errors: string[] = [];
  expect(parseFaceIdentityGeometry(wire, errors)).toEqual(geometry);
  expect(errors).toEqual([]);
  expect(geometry.face.envelopeRight).toBe(1);
  expect(geometry.face.chinY).toBe(1);
  expect(geometry.directLowerFaceContour.chin.evidence).toBe("unknown");
});

it("separates accepted geometry-driven grammar from the saved categorical observation", async () => {
  // Missing rich context is synthetic test context, not restored live data.
  // Both arms share it; the only ablation is faceIdentityGeometry presence.
  const analysis = normalizeAnalysisForRendering(makeAnalysis({
    ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing,
    faceIdentityGeometry: geometry,
  }));
  const without = { ...analysis, faceIdentityGeometry: undefined };
  const measured = buildQuantizedLayoutVariants(analysis)[0].layout;
  const categorical = buildQuantizedLayoutVariants(without)[0].layout;
  const historical = e2e.result.analysis.skinPlan.facePixelPlan.layout;
  const keys = ["leftEyeXs", "rightEyeXs", "leftEyeWidth", "rightEyeWidth", "eyeSpacingTopology", "eyeFootprintTopology", "eyeOpenness", "eyeTopology", "browDistanceTopology", "browSlopeTopology", "mouthOpening", "noseX"] as const;
  const select = (layout: typeof measured) => Object.fromEntries(keys.map(key => [key, layout[key]]));
  expect(select(measured)).toEqual(select(historical));
  expect(measured.geometryUsage.eyes).toBe(true);
  expect(measured.eyeTopology).toBe("asymmetric");
  expect(measured.mouthOpening).toBe("open");
  expect(categorical.geometryUsage.eyes).toBe(false);
  expect(categorical.mouthOpening).toBe("closed");
  expect(saved.faceMeasurementEvidence.cues.eyeSpacing.value).toBe("medium");
  expect(measured.eyeSpacingTopology).toBe("narrow");

  const features = { ...fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone), skinTone: "#633a23" };
  const variants = [];
  const atlases = [];
  const root = mkdtempSync("evaluation-artifacts/current-default-face-crop-evidence-20260926-");
  for (const [name, input] of [["accepted-geometry", analysis], ["categorical-counterfactual", without]] as const) {
    const plan = buildSkinPlan(input), style = buildFaceStyle(input, features);
    const atlas = buildProceduralFallbackAtlas(features, style, plan);
    expect(atlas).not.toBeNull();
    if (!atlas) throw new Error("diagnostic_atlas_rejected");
    const finalAtlas = validateFinalAtlas(atlas), craft = validateAtlasCraft(atlas, style, undefined, undefined, plan);
    expect(finalAtlas.ok).toBe(true);
    expect(craft.ok).toBe(true);
    atlases.push(atlas);
    variants.push({ name, layout: select(plan.facePixelPlan.layout), facePlanHash: sha(Buffer.from(JSON.stringify(plan.facePixelPlan))), atlasHash: sha(atlas.rgba), finalAtlas, craft });
    writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
  }
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => atlases[0].rgba[p * 4 + c] !== atlases[1].rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every(p => p.y < 16)).toBe(true);
  const b = crop.finalFaceBox;
  writeFileSync(`${root}/results.json`, JSON.stringify({
    mode: "offline_saved_evidence_geometry_presence_ablation_not_new_live_or_ground_truth",
    providerCalls: 0, sourceImageReads: 0, sourceSummarySha256: sha(evidenceBytes),
    historicalCropSha256: e2e.cropReplay.actualWireCropSha256,
    originalCorrespondingBox: { left: b.left * 900, right: b.right * 900, top: b.top * 1350, bottom: b.bottom * 1350 },
    crop, geometryValidation: "pass_does_not_prove_measurement_accuracy", variants, changed,
    limitations: ["unsaved rich context synthetic and identical in both arms", "categorical ablation is not a proposed production replacement", "no corrected localization or geometry available", "no aperture or confidence threshold tuning"],
  }, null, 2), { flag: "wx" });
  expect(readFileSync(evidencePath)).toEqual(evidenceBytes);
});
