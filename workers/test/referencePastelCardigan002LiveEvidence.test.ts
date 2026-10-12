// Consumed G-002 evidence only. No runner imports, remote calls or missing-field reconstruction.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import { makeAnalysis } from "./helpers";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";

const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261011-002";
const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");

it("recovers G002's accepted primary, exact PNG and complete teardown without re-calling a provider", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("d8f5b46b7ada2fba8e12a32f4cc94452671b1d189fe1f15fe721913b04e0adad");
    expect(sha(png)).toBe("0ef2e4d8b467761419f60cc73cab0f233032bc6ea3049e9bc68211a93e819222");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
    expect(versions).toHaveLength(67);
    for (const [i, file] of versions.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${file}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
      if (i === versions.length - 1) { expect(c.event).toBe("auditLifecycleFinalized"); expect(c.snapshot).toEqual(s); }
    }
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
      ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
      ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
      temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
    expect(e).toMatchObject({ runId: "0efa31608410c96ed733e0fa1aa77971", generationPosts: 1,
      providerRetry: 0, httpStatus: 200, elapsedMs: 41981, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toHaveLength(2);
    expect(r.bindingAttempts[0]).toMatchObject({ stage: "geminiPrimary", completion: "returned", httpStatus: 429, elapsedMs: 1424 });
    expect(r.bindingAttempts[1]).toMatchObject({ stage: "gemmaPrimary", completion: "returned", httpStatus: null, elapsedMs: 36968 });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [],
      strictRuntimePass: true, strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.localization).toMatchObject({ status: "INVALID_REGION", validationReason: "face_head_relationship_invalid", relationshipFailure: "head_height_ratio" });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(e.propagationLink).toEqual({ runIdMatch: true, analysisInputMatch: true, generationInputMatch: true, pngDiskMatch: true, atlasDiskMatch: true });
    expect(e.preprocessing.analysis).toMatchObject({ width: 597, height: 896, bytes: 35819,
      sha256: "7a3b74482ec859c08111360013c478753699fb0170bbea935c0645d5e55cac8c" });
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(t.primary.observed.hair).toContain("long, wavy, dyed-pink hair");
    expect(t.injectedParameters.features.hairColor).toBe("#3b2a1e");
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = { ...t.injectedParameters,
      faceStyle: { ...t.injectedParameters.faceStyle, hairAccessoryScale: "medium" } };
    const actual = await decodePng(png), base = buildProceduralSourceAtlas(params.features, params.faceStyle, p)!;
    const composed = composeReferenceStyleAtlas(base, p, d, params.faceStyle);
    expect(composed.atlas.rgba).toEqual(actual.rgba);
    expect(validateFinalAtlas(actual)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(composed.atlas, base, p, params.faceStyle,
      buildReferenceCraftPlan(p, d, composed)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/reference-pastel-cardigan-002-evidence-review-20261011-");
    for (const v of renderSkinViews(actual)) writeFileSync(`${out}/live-${v.name}.png`,
      await encodePng(scaleNearestNeighbor(v.image, v.image.width * 4, v.image.height * 4)), { flag: "wx" });
    writeFileSync(`${out}/verification.json`, JSON.stringify({ liveRoot: root, runId: e.runId,
      summaryHash: sha(bytes), pngHash: sha(png), rgbaHash: sha(actual.rgba), providerCallsInThisReplay: 0,
      checkpointCount: versions.length, exactSavedPlanReplay: true, atlasValid: true, craftValid: true,
      firstMaterialLoss: { cue: "dyed-pink hair", stage: "NORMALIZED_PRESERVED_PARAMETER_LOST",
        injectedColor: params.features.hairColor }, selectedFamilies: t.selectedFamilies,
      eyeCells: p.facePixelPlan.pixels.filter((cell: { role: string }) => cell.role === "iris")
        .map((cell: { x: number; y: number }) => ({ x: cell.x, y: cell.y,
          layers: ["base", "overlay"].map(layer => {
            const uv = CLASSIC_LAYOUT.head[layer as "base" | "overlay"].front;
            const i = ((uv.y + cell.y) * 64 + uv.x + cell.x) * 4;
            return { layer, rgba: [...actual.rgba.slice(i, i + 4)] };
          }), owners: composed.diagnostic.surfaces.filter(c => c.part === "head" && c.face === "front" && c.x === cell.x && c.y === cell.y) })),
      liveCalls: { geminiPrimary: 1, gemmaPrimary: 1, geometry: 0, retry: 0 },
      unknownRemoteDeletion: !s.serverSidePreviewDeletionIndependentlyConfirmed }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled(); console.info(`G002_EVIDENCE ${out}`);
  } finally { network.mockRestore(); }
}, 30000);

it("characterizes the recovered dyed material and remaining head coupling without reconstructing primary context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
    const t = s.currentDefaultE2E.result.propagationTrace, p = t.skinPlan.skinPlan, d = t.referenceStyle.design;
    const { features } = t.injectedParameters;
    // Consumed G002 used the same medium ribbon footprint for every scale.
    const style = { ...t.injectedParameters.faceStyle, hairAccessoryScale: "medium" as const };
    // Only this stored observed field is under test. The synthetic carrier is
    // not a reconstructed primary response or a fresh normalization result.
    const carrier = makeAnalysis(); carrier.observed.hair = t.primary.observed.hair;
    const hairColor = refineFeatureColorsFromAnalysis(carrier, features).hairColor;
    expect(hairColor).toBe("#e58bb6");
    const headStages: Record<string, { stage: string; rgba: number[] }[]> = { before: [], after: [] };
    const trace = (key: string) => (stage: string, atlas: { rgba: Uint8Array | Uint8ClampedArray }) =>
      headStages[key].push({ stage, rgba: [...atlas.rgba.slice(425 * 4, 425 * 4 + 4)] });
    const base = buildProceduralSourceAtlas(features, style, p, trace("before"))!;
    const before = composeReferenceStyleAtlas(base, p, d, style);
    const actual = await decodePng(readFileSync(`${root}/skin.png`));
    expect(before.atlas.rgba).toEqual(actual.rgba);
    const afterStyle = { ...style, hairColor }, afterFeatures = { ...features, hairColor };
    const afterBase = buildProceduralSourceAtlas(afterFeatures, afterStyle, p, trace("after"))!;
    const after = composeReferenceStyleAtlas(afterBase, p, d, afterStyle);
    const hairCells = new Set(before.diagnostic.surfaces.filter(c => c.owner === "hair").map(c => {
      const uv = CLASSIC_LAYOUT[c.part][c.layer][c.face]; return (uv.y + c.y) * 64 + uv.x + c.x;
    }));
    // Hidden top/underside seam partners inherit their visible hair edge in
    // reconcileBaseHorizontalSeams; this is not permission for the whole face.
    const visibleHair = new Set(hairCells);
    for (const seam of getBoxUvSeams(CLASSIC_LAYOUT.head.base).horizontal)
      seam.primary.forEach((cell, i) => {
        if (visibleHair.has(cell.y * 64 + cell.x)) {
          const other = seam.adjacent[i]; hairCells.add(other.y * 64 + other.x);
        }
      });
    const changed: number[] = [];
    const outsideHair = Array.from({ length: 4096 }, (_, i) => i).filter(i => !hairCells.has(i) &&
      [0, 1, 2, 3].some(ch => after.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch]));
    const alphaChanges = Array.from({ length: 4096 }, (_, i) => i).filter(i => after.atlas.rgba[i * 4 + 3] !== actual.rgba[i * 4 + 3]);
    // Characterization, NOT a clean ownership verdict: the baseline renderer
    // also derives brows/seams from hair pigment and exposes one accessory
    // cell when the pigment changes. Preserve this defect as an explicit
    // unresolved boundary rather than claiming zero collateral alpha changes.
    const headCells = new Set<number>();
    for (const layer of ["base", "overlay"] as const) for (const face of ["top", "bottom", "front", "back", "left", "right"] as const) {
      const uv = CLASSIC_LAYOUT.head[layer][face];
      for (let y = 0; y < uv.h; y++) for (let x = 0; x < uv.w; x++)
        headCells.add((uv.y + y) * 64 + uv.x + x);
    }
    expect(outsideHair.length).toBe(37);
    expect(outsideHair.every(i => headCells.has(i))).toBe(true);
    expect(alphaChanges).toEqual([425]);
    expect(after.diagnostic.surfaces).toContainEqual({ part: "head", face: "top", layer: "overlay", x: 1, y: 6, owner: "accessory" });
    for (const cell of p.facePixelPlan.pixels.filter((c: { role: string }) => c.role === "iris")) {
      const uv = CLASSIC_LAYOUT.head.base.front, offset = ((uv.y + cell.y) * 64 + uv.x + cell.x) * 4;
      expect(after.atlas.rgba.slice(offset, offset + 4)).toEqual(actual.rgba.slice(offset, offset + 4));
    }
    for (let i = 0; i < 4096; i++) {
      if ([0, 1, 2].some(ch => after.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) {
        expect(hairCells.has(i) || headCells.has(i), `unrelated body cell changed: ${i}`).toBe(true); changed.push(i);
      }
    }
    expect(changed.length).toBeGreaterThan(0);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, afterBase, p, afterStyle,
      buildReferenceCraftPlan(p, d, after)).ok).toBe(true);
    expect(composeReferenceStyleAtlas(afterBase, p, d, afterStyle).atlas.rgba).toEqual(after.atlas.rgba);
    const out = freshAuditOutput("evaluation-artifacts/dyed-hair-material-replay-20261011-");
    for (const [label, atlas] of [["live", actual], ["offline-after", after.atlas]] as const) {
      writeFileSync(`${out}/${label}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${out}/${label}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 4, v.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${out}/verification.json`, JSON.stringify({ runId: s.currentDefaultE2E.runId,
      scope: "saved_plan_hair_color_only_counterfactual_not_fresh_live", providerCalls: 0,
      observedMaterial: "dyed-pink hair", oldParameter: features.hairColor, newParameter: hairColor,
      changedRgbCells: changed.length, outsideCompositorHairCells: outsideHair.length,
      unrelatedBodyCells: 0, alphaChanges, headStages, irisRgbaUnchanged: true,
      unresolvedBoundary: "existing_head_material_accessory_coupling_not_fixed_by_color_recovery",
      liveRgba: sha(actual.rgba), afterRgba: sha(after.atlas.rgba), craftValid: true, atlasValid: true,
      deterministic: true, savedAnalysisReconstructed: false }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled(); console.info(`DYED_HAIR_REPLAY ${out}`);
  } finally { network.mockRestore(); }
}, 30000);
