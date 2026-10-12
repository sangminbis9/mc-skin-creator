import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { runPhotoAnalysis, validatePortraitRegion } from "../src/analysis";
import { runFaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { buildFaceStyle, buildProceduralFallbackAtlas, createIdentityCrops, faceGeometryCropEligibility, generateSkin, normalizeAnalysisForRendering } from "../src/generate";
import { encodePng, bytesToBase64, base64ToBytes, decodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { buildSkinPlan } from "../src/skinPlan";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { Env } from "../src/types";

vi.mock("../src/analysis", async importOriginal => ({ ...await importOriginal<typeof import("../src/analysis")>(), runPhotoAnalysis: vi.fn() }));
vi.mock("../src/faceIdentityGeometry", async importOriginal => ({ ...await importOriginal<typeof import("../src/faceIdentityGeometry")>(), runFaceIdentityGeometryAnalysis: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("dispatches face geometry only for a usable crop with known retained face coverage", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const historical = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009/summary.json", "utf8")).currentDefaultE2E;
  const live = historical.result;
  expect(faceGeometryCropEligibility(historical.cropReplay.diagnostics)).toEqual({
    status: "coverage_unknown", reason: "localized_face_unavailable" });
  const rawRegion = { subjectBox: { left: .45, top: .04, right: .96, bottom: 1 },
    headBox: { left: .57, top: .07, right: .9, bottom: .52 },
    faceBox: { left: .59, top: .15, right: .88, bottom: .45 }, confidence: .95 };
  const validation = validatePortraitRegion(rawRegion);
  expect(validation.ok).toBe(true); if (!validation.ok) throw new Error("synthetic_region_invalid");
  const region = validation.region;
  const cases = [
    { id: "centered-unknown", width: 320, height: 480, eyes: [.43, .57], region: undefined },
    { id: "off-center-unknown", width: 320, height: 480, eyes: [.66, .82], region: undefined },
    { id: "off-center-localized", width: 320, height: 480, eyes: [.66, .82], region },
    { id: "small-source-region-unusable", width: 56, height: 84, eyes: [.66, .82], region },
  ];
  const rows = [];
  for (const input of cases) {
    const rgba = new Uint8Array(input.width * input.height * 4).fill(255);
    // Synthetic marks only: known source coordinates let this test distinguish
    // cropping from resolution without pretending to detect a real person's eyes.
    for (const eye of input.eyes) {
      const p = (Math.floor(input.height * .3) * input.width + Math.floor(input.width * eye)) * 4;
      rgba.set([30, 20, 10, 255], p);
    }
    const image = `data:image/png;base64,${bytesToBase64(await encodePng({ width: input.width, height: input.height, rgba }))}`;
    const analysis = makeAnalysis({ ...live.diagnostics.normalizedPrimary,
      identityPrompt: live.diagnostics.normalizedPrimary.observed.hair,
      outfitPrompt: live.diagnostics.normalizedPrimary.observed.clothing,
      sourceSelection: { ...makeAnalysis().sourceSelection, portraitRegion: input.region } });
    const crops = await createIdentityCrops(image, input.region);
    expect(crops).not.toBeNull(); if (!crops) throw new Error("synthetic_crop_unavailable");
    const box = crops.diagnostics.finalFaceBox;
    const bothMarkersInside = input.eyes.every(x => x >= box.left && x <= box.right && .3 >= box.top && .3 <= box.bottom);
    vi.mocked(runPhotoAnalysis).mockResolvedValue({ ok: true, analysis, neuronsSpent: 0, providerCalls: 0 });
    vi.mocked(runFaceIdentityGeometryAnalysis).mockResolvedValue({ ok: true,
      geometry: live.diagnostics.geometry.acceptedGeometry, measurements: null, providerShapeValid: true,
      errors: [], elapsedMs: 0, neuronsSpent: 0 });
    const result = await generateSkin({ FACE_GEOMETRY_ENRICHMENT_ENABLED: "true" } as Env, image);
    expect(result.status).toBe(200);
    const eligible = input.id === "off-center-localized";
    expect(runFaceIdentityGeometryAnalysis).toHaveBeenCalledTimes(eligible ? 1 : 0);
    const body = result.body as { skinPngBase64: string; analysis: { skinPlan: { facePixelPlan: { layout: { geometryUsage: { eyes: boolean } } } } } };
    expect(body.analysis.skinPlan.facePixelPlan.layout.geometryUsage.eyes).toBe(eligible);
    expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
    const decision = faceGeometryCropEligibility(crops.diagnostics);
    expect(decision.status).toBe(eligible ? "eligible" : input.width < 100 ? "ineligible" : "coverage_unknown");
    if (!eligible) {
      const baseline = await generateSkin({ FACE_GEOMETRY_ENRICHMENT_ENABLED: "false" } as Env, image);
      expect(result.body).toEqual(baseline.body);
      expect(runFaceIdentityGeometryAnalysis).not.toHaveBeenCalled();
    } else {
      // Head/hair coverage flags must not falsely reject a retained face.
      const headClipped = structuredClone(crops.diagnostics);
      headClipped.crownClipped = true; headClipped.quality.headCoverageAdequate = false;
      expect(faceGeometryCropEligibility(headClipped)).toEqual(decision);
      for (const edge of ["left", "top", "right", "bottom"] as const) {
        const clipped = structuredClone(crops.diagnostics);
        clipped.finalFaceBox![edge] = clipped.faceBox![edge] + (["left", "top"].includes(edge) ? .001 : -.001);
        expect(faceGeometryCropEligibility(clipped)).toEqual({ status: "ineligible", reason: "localized_face_clipped" });
      }
      const retained = structuredClone(crops.diagnostics);
      retained.cropMode = "face_fallback";
      retained.finalFaceBox = retained.faceBox;
      expect(faceGeometryCropEligibility(retained)).toEqual(decision);
    }
    rows.push({ id: input.id, cropMode: crops.diagnostics.cropMode, box,
      dimensions: crops.diagnostics.faceCropDimensions, bothSyntheticEyeMarkersInside: bothMarkersInside,
      quality: crops.diagnostics.quality, decision, mockGeometryCalls: eligible ? 1 : 0, geometryUsed: eligible });
    vi.mocked(runPhotoAnalysis).mockClear(); vi.mocked(runFaceIdentityGeometryAnalysis).mockClear();
  }
  expect(rows[0].bothSyntheticEyeMarkersInside).toBe(true);
  expect(rows[1].bothSyntheticEyeMarkersInside).toBe(false);
  expect(rows[2].bothSyntheticEyeMarkersInside).toBe(true);
  expect(rows[3].quality.usableForFaceGeometry, JSON.stringify(rows[3])).toBe(false);
  expect(network).not.toHaveBeenCalled();
  const root = mkdtempSync("evaluation-artifacts/face-geometry-coverage-dispatch-20260927-");
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, syntheticPrimaryStubs: 4,
    syntheticGeometryStubs: 1, productionChange: true, rows,
    conclusion: "Only known, retained, resolution-eligible face coverage dispatches optional geometry. Unknown coverage is not labeled invalid.",
    limits: "Controlled synthetic images and accepted stub values only; not provider accuracy or new real-person geometry." }, null, 2), { flag: "wx" });
  console.info(`COVERAGE_DISPATCH_AUDIT ${root}`);
}, 30_000);

it("records a current 009 primary-only counterfactual without altering historical accepted geometry", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const sourcePath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-009/summary.json";
  const saved = readFileSync(sourcePath);
  const source = JSON.parse(saved.toString()).currentDefaultE2E;
  const live = source.result, primary = live.diagnostics.normalizedPrimary;
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  expect(faceGeometryCropEligibility(source.cropReplay.diagnostics).status).toBe("coverage_unknown");
  const context = makeAnalysis({ ...primary, identityPrompt: primary.observed.hair,
    outfitPrompt: primary.observed.clothing, negativePrompt: "" });
  const root = mkdtempSync("evaluation-artifacts/current-009-coverage-gate-replay-20260927-");
  const rendered = [];
  for (const useGeometry of [true, false]) {
    const analysis = normalizeAnalysisForRendering({ ...context,
      faceIdentityGeometry: useGeometry ? live.diagnostics.geometry.acceptedGeometry : undefined });
    const plan = buildSkinPlan(analysis), style = buildFaceStyle(analysis, live.features, plan.hairPlan);
    const atlas = buildProceduralFallbackAtlas(live.features, style, plan);
    expect(atlas).not.toBeNull(); if (!atlas) throw new Error("offline_atlas_rejected");
    const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
    expect(craft.ok, JSON.stringify(craft)).toBe(true);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
    expect(plan.facePixelPlan.layout.geometryUsage.eyes).toBe(useGeometry);
    const id = useGeometry ? "before-accepted-center-crop" : "after-primary-only";
    writeFileSync(`${root}/${id}.png`, await encodePng(atlas), { flag: "wx" });
    for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter"].includes(v.name))) {
      writeFileSync(`${root}/${id}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
    }
    rendered.push({ id, plan, atlas, craft });
  }
  expect(rendered[0].plan.hairPlan).toEqual(rendered[1].plan.hairPlan);
  expect(rendered[0].plan.outfitPlan).toEqual(rendered[1].plan.outfitPlan);
  const changed = [];
  for (let p = 0; p < 4096; p++) {
    if ([0, 1, 2, 3].some(c => rendered[0].atlas.rgba[p * 4 + c] !== rendered[1].atlas.rgba[p * 4 + c])) {
      expect(Math.floor(p / 64)).toBeLessThan(16);
      changed.push({ x: p % 64, y: Math.floor(p / 64) });
    }
  }
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0,
    historicalSummarySha256: sha(saved), inputDecision: faceGeometryCropEligibility(source.cropReplay.diagnostics),
    changedHeadPixels: changed, changedBodyPixels: 0, hairPlanUnchanged: true, outfitPlanUnchanged: true,
    cases: rendered.map(r => ({ id: r.id, facePlan: r.plan.facePixelPlan, craft: r.craft,
      rgbaHash: sha(r.atlas.rgba), planHash: sha(JSON.stringify(r.plan)) })),
    limitation: "Offline counterfactual using allowlisted primary plus explicit helper context. Not a new production PNG or newly measured source geometry. Known centered unknown crops also skip optional geometry; likeness improvement is not guaranteed." }, null, 2), { flag: "wx" });
  expect(readFileSync(sourcePath)).toEqual(saved);
  expect(network).not.toHaveBeenCalled();
  console.info(`COVERAGE_GATE_REPLAY ${root}`);
}, 30_000);
