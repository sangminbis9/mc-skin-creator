import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { validatePortraitRegion } from "../src/analysis";
import { buildFacePixelPlanVariants, type FacePixelPlan } from "../src/identityPlans";
import { normalizeAnalysisForRendering, buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas, validateAtlasCraft } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import { makeAnalysis } from "./helpers";

const root = "evaluation-artifacts/current-source-v4-localization-29002888-live-20260926-002";
const oldRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const planSummary = (p: FacePixelPlan) => ({
  variantId: p.variantId, planHash: hash(JSON.stringify(p)), geometryUsage: p.layout.geometryUsage,
  eyeTopology: p.layout.eyeTopology, leftEyeXs: p.layout.leftEyeXs, rightEyeXs: p.layout.rightEyeXs,
  leftEyeRow: p.layout.leftEyeRow, rightEyeRow: p.layout.rightEyeRow,
  eyeSpacing: p.layout.eyeSpacingTopology, eyeFootprint: p.layout.eyeFootprintTopology,
  mouthTopology: p.layout.mouthTopology, mouthRow: p.layout.mouthRow,
  mouthWidth: p.layout.mouthWidth, mouthCenterX: p.layout.mouthCenterX,
  eyePixels: p.pixels.filter(pixel => ["left_eye", "right_eye"].includes(pixel.cluster)),
  mouthPixels: p.pixels.filter(pixel => pixel.cluster === "mouth"),
});

it("recovers accepted -002 provenance and isolates geometry consumption under a fixed prior analysis context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const liveBytes = readFileSync(`${root}/summary.json`), oldBytes = readFileSync(`${oldRoot}/summary.json`);
    const summary = JSON.parse(liveBytes.toString()), current = summary.currentSourceV4;
    const previous = JSON.parse(oldBytes.toString()).currentDefaultE2E;
    expect(current.classification).toBe("V4_LOCALIZATION_AND_GEOMETRY_ACQUIRED");
    expect(current).toMatchObject({ primaryPosts: 1, geometryPosts: 1, retry: 0, diskRecovery: true,
      primaryHttp: 200, geometryHttp: 200,
      geometry: { providerShapeValid: true, semanticValid: true, errors: [] } });
    const evidence = current.localization.evidence;
    expect(current.localization.status).toBe("captured");
    expect(evidence.provenanceComplete).toBe(true);
    expect(evidence.derivativeSha256).toBe("a98165d2ed43a031cfbd182871417a3555f31474a630df6a6be34278b5e317f3");
    expect(evidence.runId).toBe(current.primaryRunId);
    expect(validatePortraitRegion(evidence.region).ok).toBe(true);
    expect(current.crop.sourceDerivativeSha256).toBe(evidence.derivativeSha256);
    expect(current.crop.primaryRunId).toBe(evidence.runId);
    expect(current.crop.geometryRunId).toBe(current.geometryRunId);
    expect(current.crop).toMatchObject({ width: 294, height: 357,
      sha256: "84f436144f3254e2feedd8be6b0792152e70678c232451fdfc7d5aed26d54aab",
      diagnostics: { cropMode: "subject_aware", quality: { usableForFaceGeometry: true } } });
    const records = readdirSync(root).filter(name => /^summary\.json\.checkpoint-\d+\.json$/.test(name)).sort()
      .map(name => JSON.parse(readFileSync(`${root}/${name}`, "utf8")));
    for (const record of records) expect(record.snapshotSha256).toBe(hash(JSON.stringify(record.snapshot)));
    const captured = records.find(record => record.event === "currentSourceV4PrimaryCaptured");
    const geometryIntent = records.find(record => record.event === "currentSourceV4GeometryPostStarted");
    expect(captured.sequence).toBeLessThan(geometryIntent.sequence);
    expect(captured.snapshot.currentSourceV4.localization.evidence).toEqual(evidence);
    expect(captured.snapshot.currentSourceV4.geometryPosts).toBe(0);
    expect(records.at(-1).snapshot).toEqual(summary);

    const oldGeometry = acceptedFaceGeometry(previous.result.diagnostics.geometry.acceptedGeometry);
    const newGeometry = acceptedFaceGeometry(current.acceptedGeometry);
    expect(newGeometry).toEqual(current.acceptedGeometry);
    const saved = previous.result.diagnostics.normalizedPrimary;
    // A controlled counterfactual, NOT reconstruction of the fresh V4 analysis.
    // Omitted historical rich fields come from the same synthetic test helper in both arms.
    const control = makeAnalysis({ ...saved, identityPrompt: saved.observed.hair,
      outfitPrompt: saved.observed.clothing, faceIdentityGeometry: oldGeometry });
    const beforeInput = normalizeAnalysisForRendering(structuredClone(control));
    const afterInput = normalizeAnalysisForRendering({ ...structuredClone(control), faceIdentityGeometry: newGeometry });
    expect({ ...afterInput, faceIdentityGeometry: null }).toEqual({ ...beforeInput, faceIdentityGeometry: null });
    const before = buildFacePixelPlanVariants(beforeInput, 3), after = buildFacePixelPlanVariants(afterInput, 3);
    for (const plans of [before, after]) {
      expect(plans.length).toBeGreaterThan(0); expect(plans.length).toBeLessThanOrEqual(3);
      for (const plan of plans) {
        expect(plan.layout.geometryUsage.eyes).toBe(true);
        expect(plan.layout.geometryUsage.mouth).toBe(true);
        expect(plan.candidateCost.violations).toEqual([]);
      }
    }
    const measurements = (g: typeof newGeometry) => ({
      faceWidth: g.face.envelopeRight - g.face.envelopeLeft,
      eyeWidthRatio: g.eyes.rightWidth / g.eyes.leftWidth,
      normalizedEyeSpacing: g.eyes.interEyeDistance / (g.face.envelopeRight - g.face.envelopeLeft),
      rawOpenness: g.eyes.openness, eyeConfidence: g.confidence.eyes,
    });
    const output = mkdtempSync("evaluation-artifacts/current-source-v4-geometry-replay-20260926-");
    const beforePlan = buildSkinPlan(beforeInput), afterPlan = buildSkinPlan(afterInput);
    const features = previous.result.features;
    const style = buildFaceStyle(beforeInput, features);
    expect(buildFaceStyle(afterInput, features)).toEqual(style);
    const beforeAtlas = buildProceduralFallbackAtlas(features, style, beforePlan)!;
    const afterAtlas = buildProceduralFallbackAtlas(features, style, afterPlan)!;
    expect(beforeAtlas).not.toBeNull(); expect(afterAtlas).not.toBeNull();
    expect(beforePlan.outfitPlan).toEqual(afterPlan.outfitPlan);
    const preBrowRoot = "evaluation-artifacts/current-source-v4-geometry-replay-20260926-tfRjW9";
    const preBrowReport = JSON.parse(readFileSync(`${preBrowRoot}/results.json`, "utf8"));
    expect(hash(liveBytes)).toBe(preBrowReport.latestSummarySha256);
    expect(hash(oldBytes)).toBe(preBrowReport.previousSummarySha256);
    expect(afterPlan).toEqual(preBrowReport.renderComparison.afterPlan);
    const preBrowAtlas = await decodePng(readFileSync(`${preBrowRoot}/new-geometry-counterfactual.png`));
    expect(hash(preBrowAtlas.rgba)).toBe(preBrowReport.renderComparison.afterAtlasHash);
    const browRepairChangedPixels = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => preBrowAtlas.rgba[p * 4 + c] !== afterAtlas.rgba[p * 4 + c])) {
      browRepairChangedPixels.push({ x: p % 64, y: Math.floor(p / 64) });
      expect(Math.floor(p / 64)).toBeLessThan(16);
      expect(afterAtlas.rgba[p * 4 + 3]).toBe(preBrowAtlas.rgba[p * 4 + 3]);
    }
    // Hold the authoritative plan fixed and vary only obsolete style-level brow
    // shape. Differences reveal paint that is not owned by the selected plan.
    const browStyleProbe = [];
    for (const eyebrowShape of ["straight", "arched", "slanted", "soft"] as const) {
      const probe = buildProceduralFallbackAtlas(features, { ...style, eyebrowShape }, afterPlan)!;
      expect(probe).not.toBeNull();
      const differences = [];
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => probe.rgba[p * 4 + c] !== afterAtlas.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        differences.push({ x, y, before: Array.from(afterAtlas.rgba.slice(p * 4, p * 4 + 4)),
          after: Array.from(probe.rgba.slice(p * 4, p * 4 + 4)),
          plannedRoles: afterPlan.facePixelPlan.pixels.filter(cell => cell.x === x - 8 && cell.y === y - 8).map(cell => cell.role) });
      }
      expect(differences, eyebrowShape).toEqual([]);
      browStyleProbe.push({ eyebrowShape, differences });
    }
    const changedPixels: Array<{ x: number; y: number }> = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => beforeAtlas.rgba[p * 4 + c] !== afterAtlas.rgba[p * 4 + c])) {
      changedPixels.push({ x: p % 64, y: Math.floor(p / 64) });
      expect(Math.floor(p / 64)).toBeLessThan(16);
      expect(beforeAtlas.rgba[p * 4 + 3]).toBe(afterAtlas.rgba[p * 4 + 3]);
    }
    const livePng = readFileSync(`${oldRoot}/skin.png`);
    const actual = await decodePng(livePng);
    expect(hash(livePng)).toBe(previous.png.sha256);
    let historicalReplayMismatchPixels = 0;
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => actual.rgba[p * 4 + c] !== beforeAtlas.rgba[p * 4 + c])) historicalReplayMismatchPixels++;
    for (const [name, atlas] of [["old-live-reference", actual], ["old-geometry-control", beforeAtlas], ["new-geometry-counterfactual", afterAtlas]] as const) {
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      writeFileSync(`${output}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter", "front_right_three_quarter"].includes(v.name))) {
        writeFileSync(`${output}/${name}-${view.name}.png`, await encodePng(view.image), { flag: "wx" });
        writeFileSync(`${output}/${name}-${view.name}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 192, 192)), { flag: "wx" });
      }
    }
    writeFileSync(`${output}/results.json`, JSON.stringify({ mode: "offline_geometry_only_counterfactual",
      additionalProviderCalls: 0, productionChange: "legacy_brow_eye_mouth_paint_suppressed_when_face_plan_present", latestSummarySha256: hash(liveBytes),
      previousSummarySha256: hash(oldBytes), checkpointCount: records.length,
      durableLocalizationBeforeGeometry: true,
      context: "Fixed -005 partial normalized analysis; same synthetic missing context in both arms; not fresh V4 full analysis",
      before: { measurements: measurements(oldGeometry), plans: before.map(planSummary) },
      after: { measurements: measurements(newGeometry), plans: after.map(planSummary) },
      renderComparison: { changedPixels, bodyPixelDiff: 0, alphaDiff: 0, featuresAndStyleFixed: true,
        beforeAtlasHash: hash(beforeAtlas.rgba), afterAtlasHash: hash(afterAtlas.rgba),
        historicalReplayMismatchPixels, exactHistoricalReplay: historicalReplayMismatchPixels === 0,
        beforeCraft: validateAtlasCraft(beforeAtlas, style, undefined, undefined, beforePlan),
        afterCraft: validateAtlasCraft(afterAtlas, style, undefined, undefined, afterPlan),
        beforePlan, afterPlan, browStyleProbe },
      productionPngGenerated: false, measurementAccuracyCertified: false,
      rendererRepairComparison: { preBrowRoot, samePlan: true, changedPixels: browRepairChangedPixels,
        beforeHash: hash(preBrowAtlas.rgba), afterHash: hash(afterAtlas.rgba), bodyPixelDiff: 0, alphaDiff: 0 },
      limitation: "Different valid geometry/crops are not a controlled provider repeat or proof of source likeness improvement.",
    }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(liveBytes);
    expect(readFileSync(`${oldRoot}/summary.json`)).toEqual(oldBytes);
    expect(readFileSync(`${oldRoot}/skin.png`)).toEqual(livePng);
    expect(network).not.toHaveBeenCalled();
    console.info(`V4_GEOMETRY_REPLAY ${output}`);
  } finally { network.mockRestore(); }
});
