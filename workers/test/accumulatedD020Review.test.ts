// Offline saved-plan transfer and unadopted palette study. No live imports.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { PhotoAnalysis } from "../src/analysis";
import { categoricalHeadwearBrowOcclusion } from "../src/headwearFootprint";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildHairStructurePlan } from "../src/headStructure";
import { buildOutfitPlan, preserveObservedSleeveCuffs } from "../src/outfitIdentity";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildProceduralSourceAtlas } from "../src/generate";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { encodePng, decodePng, type RawImage } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

it("composes verified transfers and isolates eye pigment adjacency without changing production", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis }, immutable = JSON.stringify(t);
    const p: SkinPlan = structuredClone(t.skinPlan.skinPlan);
    const hidden = categoricalHeadwearBrowOcclusion(a.fallbackFeatures.hat, p.facePixelPlan.pixels, p.facePixelPlan.layout);
    expect(hidden).toHaveLength(4);
    p.facePixelPlan.pixels = p.facePixelPlan.pixels.filter(q => !(q.role === "brow" && hidden.some(h => h.x === q.x && h.y === q.y)));
    p.facePixelPlan.headwearOccludedBrows = { reason: "headwear_material_occlusion", cells: hidden };
    p.headIdentityPlan.baseFace = p.facePixelPlan;
    p.headIdentityPlan.ownership = resolveHeadOwnership(a, p.hairPlan, p.facePixelPlan);
    p.outfitPlan.upper.pattern = buildOutfitPlan(a).upper.pattern;
    p.outfitPlan = preserveObservedSleeveCuffs(p.outfitPlan, a);
    const current = buildReferenceStylePlan(a);
    const design = { ...t.referenceStyle.design, eyeBoundaryPolicy: current.eyeBoundaryPolicy, drape: current.drape };
    const style = t.injectedParameters.faceStyle;
    const base = buildProceduralSourceAtlas(t.injectedParameters.features, style, p)!;
    const selected = selectReferenceStyleAtlas(base, p, design, style).selected!;
    expect(selected).not.toBeNull();
    const composition = selected.composition, atlas = composition.atlas;
    expect(composition.diagnostic.faceFinish.eyePresentation.kind).toBe("paired_lower_pigment");
    expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(atlas, base, p, style, buildReferenceCraftPlan(p, selected.design, composition)).ok).toBe(true);
    expect(p.outfitPlan.upper.leftSleeve.cuff?.color).toBe("#eeeae1");
    expect(p.outfitPlan.upper.pattern.blockColors).toHaveLength(5);
    expect(p.outfitPlan.upper.pattern.frontGraphic?.color).toBe("#242326");
    expect(composition.diagnostic.looseHair.frontEvidence).toBe("observed_front_lock_endpoint");
    expect(selectReferenceStyleAtlas(base, p, design, style).selected!.composition.atlas.rgba).toEqual(atlas.rgba);
    const b = CLASSIC_LAYOUT.head.base.front, o = CLASSIC_LAYOUT.head.overlay.front;
    const at = (x: number, y: number, r = b) => ((r.y + y) * 64 + r.x + x) * 4;
    const pixel = (image: RawImage, x: number, y: number, r = b) => [...image.rgba.slice(at(x, y, r), at(x, y, r) + 4)];
    const study = structuredClone(atlas), eyes = p.facePixelPlan.pixels.filter(q => q.role === "iris");
    const rows = eyes.map((q, side) => {
      const lower = { x: q.x, y: q.y + 1 }, outward = { x: q.x + (side === 0 ? -1 : 1), y: q.y + 1 };
      const pigment = pixel(atlas, lower.x, lower.y), neighbor = pixel(atlas, outward.x, outward.y);
      const contour = pixel(base, q.x, q.y);
      expect(pixel(atlas, lower.x, lower.y, o)[3]).toBe(0);
      expect(p.headIdentityPlan.ownership!.cells.find(c => c.face === "front" && c.layer === "base" && c.x === outward.x && c.y === outward.y)?.owner).toBe("hair_base");
      // Palette study: the pre-finish renderer's existing contour shade, not
      // a new source observation or an adopted provider/renderer workaround.
      study.rgba.set(contour.slice(0, 3), at(lower.x, lower.y));
      return { lower, pigment, outward, neighbor, contour,
        pigmentToHairRgbDistance: pigment.slice(0, 3).reduce((n, v, i) => n + Math.abs(v - neighbor[i]), 0),
        contourToHairRgbDistance: contour.slice(0, 3).reduce((n, v, i) => n + Math.abs(v - neighbor[i]), 0) };
    });
    let delta = 0;
    for (let i = 0; i < 4096; i++) {
      expect(study.rgba[i * 4 + 3]).toBe(atlas.rgba[i * 4 + 3]);
      if (![0, 1, 2].some(ch => study.rgba[i * 4 + ch] !== atlas.rgba[i * 4 + ch])) continue;
      expect(eyes.some(q => at(q.x, q.y + 1) === i * 4)).toBe(true); delta++;
    }
    expect(delta).toBe(2);
    const rejected = measureReferenceRenderedQuality({ ...composition, atlas: study }, base, p, selected.design, style);
    expect(rejected.constructionValid).toBe(false); // Study MUST NOT bypass production's pigment contract.
    // A separate silhouette study, not source measurement: reserve one skin
    // separator beside each lower iris while keeping the original eye pigment.
    // These cells are currently hair-owned, so this MUST remain rejected.
    const separatorStudy = structuredClone(atlas);
    const skin = [1, 3, 5].map(i => Number.parseInt(style.skinTone.slice(i, i + 2), 16));
    for (const row of rows) {
      expect(pixel(atlas, row.outward.x, row.outward.y, o)[3]).toBe(0);
      separatorStudy.rgba.set(skin, at(row.outward.x, row.outward.y));
    }
    const separatorRejected = measureReferenceRenderedQuality({ ...composition, atlas: separatorStudy }, base, p, selected.design, style);
    expect(separatorRejected.constructionValid).toBe(false);
    const separatorChanges = [];
    for (let i = 0; i < 4096; i++) {
      expect(separatorStudy.rgba[i * 4 + 3]).toBe(atlas.rgba[i * 4 + 3]);
      if (![0, 1, 2].some(ch => separatorStudy.rgba[i * 4 + ch] !== atlas.rgba[i * 4 + ch])) continue;
      expect(rows.some(row => at(row.outward.x, row.outward.y) === i * 4)).toBe(true);
      separatorChanges.push({ x: i % 64 - b.x, y: Math.floor(i / 64) - b.y });
    }
    expect(separatorChanges).toHaveLength(2);
    // Saved-plan ablation of the new categorical boundary, not a fabricated
    // full historical analysis. Unit tests separately exercise the production
    // planner for jaw/shoulder/chest lengths. Rebuild actual structure/ownership
    // from the retained hints; never repaint hair-owned atlas cells as skin.
    expect(p.hairPlan.template).toBe("long_curtain");
    expect(p.hairPlan.headMask.source).toBe("semantic_template");
    expect(p.hairPlan.headMask.semanticSilhouette?.sideWidthFamily).toBe("narrow");
    expect(a.renderHints.sideHairShape).toBe("face_framing");
    const narrowed = structuredClone(p);
    narrowed.hairPlan.headMask.faces.front = narrowed.hairPlan.headMask.faces.front.filter(c => c.y <= 1 || c.x === 0 || c.x === 7);
    narrowed.hairPlan.structure = buildHairStructurePlan(a, narrowed.facePixelPlan.layout, narrowed.hairPlan.headMask, narrowed.hairPlan.salience);
    narrowed.headIdentityPlan.ownership = resolveHeadOwnership(a, narrowed.hairPlan, narrowed.facePixelPlan);
    expect(narrowed.facePixelPlan).toEqual(p.facePixelPlan);
    expect(narrowed.outfitPlan).toEqual(p.outfitPlan);
    for (const f of ["left", "right", "top", "back"] as const) expect(narrowed.hairPlan.headMask.faces[f]).toEqual(p.hairPlan.headMask.faces[f]);
    const narrowedBase = buildProceduralSourceAtlas(t.injectedParameters.features, style, narrowed)!;
    const narrowedSelected = selectReferenceStyleAtlas(narrowedBase, narrowed, design, style).selected!;
    expect(narrowedSelected).not.toBeNull();
    const narrowedAtlas = narrowedSelected.composition.atlas;
    expect(validateReferenceAtlasCraft(narrowedAtlas, narrowedBase, narrowed, style,
      buildReferenceCraftPlan(narrowed, narrowedSelected.design, narrowedSelected.composition)).ok).toBe(true);
    expect(validateFinalAtlas(narrowedAtlas)).toEqual({ ok: true, problems: [] });
    expect(selectReferenceStyleAtlas(narrowedBase, narrowed, design, style).selected!.composition.atlas.rgba).toEqual(narrowedAtlas.rgba);
    const narrowChanges: Array<{ x: number; y: number }> = [];
    const headRects = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
    for (let i = 0; i < 4096; i++) {
      if (![0, 1, 2, 3].some(ch => atlas.rgba[i * 4 + ch] !== narrowedAtlas.rgba[i * 4 + ch])) continue;
      const x = i % 64, y = Math.floor(i / 64);
      expect(headRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
      narrowChanges.push({ x, y });
    }
    expect(narrowChanges.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(pixel(narrowedAtlas, row.lower.x, row.lower.y)).toEqual(row.pigment);
      expect(narrowedSelected.composition.diagnostic.faceFinish.blushCells).toContainEqual(row.outward);
      const lip = skin.map((v, i) => Math.max(0, v - (i === 0 ? 18 : 45)));
      const existingBlush = skin.map((v, i) => Math.round(v * 0.9 + lip[i] * 0.1));
      expect(pixel(narrowedAtlas, row.outward.x, row.outward.y)).toEqual([...existingBlush, 255]);
    }
    const out = freshAuditOutput("evaluation-artifacts/accumulated-d020-review-20261011-");
    for (const [name, image] of [["current", atlas], ["contour-study-not-adopted", study], ["separator-study-not-adopted", separatorStudy], ["narrow-face-framing", narrowedAtlas]] as const) {
      const encoded = await encodePng(image); expect((await decodePng(encoded)).rgba).toEqual(image.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(renderSkinViews(image)[0].image, 384, 576)), { flag: "wx" });
      const head: RawImage = { width: 8, height: 8, rgba: new Uint8Array(256) };
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) head.rgba.set(pixel(image, x, y), (y * 8 + x) * 4);
      writeFileSync(`${out}/${name}-base-head.png`, await encodePng(scaleNearestNeighbor(head, 320, 320)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_saved_plan_transfer_and_unadopted_palette_study", providerCalls: 0,
      sourceSummarySha256: sha(bytes), sourcePngSha256: sha(png), currentRgba: sha(atlas.rgba), studyRgba: sha(study.rgba),
      transferContracts: ["cloth_palette_and_graphic", "front_lock_endpoint", "headwear_brow_occlusion", "paired_lower_pigment", "attached_cuff_material"],
      currentCraftPass: true, currentAtlasPass: true, selectedFamilies: { face: selected.design.face.family, hair: selected.design.hair.family, outfit: selected.design.outfit.family },
      sourceEyePlanUnchanged: true, rows, studyChangedPixels: delta, studyRejectedByCurrentProduction: rejected.violations,
      separatorStudyRgba: sha(separatorStudy.rgba), separatorChanges, separatorStudyRejected: separatorRejected.violations,
      historicalCategoricalFrontSideWidthCode: "identityPlans.ts: frontWidth = short && narrow ? 1 : 2",
      narrowedRgba: sha(narrowedAtlas.rgba), narrowedCraftPass: true, narrowedAtlasPass: true,
      narrowChanges, narrowedNonHeadDiff: 0, lowerEyePigmentPreserved: true,
      narrowReplayMode: "saved_plan_boundary_transplant_with_production_structure_and_ownership",
      adopted: false, freshLiveVerified: false, reconstructedMissingAnalysis: false, productionChangesThisTest: 0,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("ACCUMULATED_D020_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);
