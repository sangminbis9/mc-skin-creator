// Current production material resolution, immutable same-run replay, no API.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { encodePng, decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";
import * as layeredCrown from "../src/referenceLayeredCrown";
import { verifyLegwearRedesign } from "./savedLegwearRendererEvidence";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("isolates material and sweatshirt construction delivery without changing saved face/hair, and protects twelve frozen atlases", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  // Historical B002 material/construction isolation predates crown relief.
  // Restore the current composition before the full frozen regression below.
  const historicalCrown = vi.spyOn(layeredCrown, "retainLayeredCrownAccent").mockReturnValue(true);
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-short-black-sweatshirt-20261010-002";
    const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
    expect(sha(bytes)).toBe("b451f1eb59e976b29a70f33dc6f4eccba69e4605e790d3efe353675965bc6251");
    const t = run.result.propagationTrace, saved: SkinPlan = t.skinPlan.skinPlan;
    const probe = { ...t.primary, identityPrompt: "", outfitPrompt: "", negativePrompt: "" } as PhotoAnalysis;
    const immutable = JSON.stringify([probe, saved]);
    const resolved = buildOutfitPlan(probe), original = saved.outfitPlan;
    const colors = refineFeatureColorsFromAnalysis(probe, t.injectedParameters.features);
    expect(colors).toEqual({ ...t.injectedParameters.features, topColor: "#22201e" });
    expect(resolved.upper.baseColor).toBe("#242326"); expect(resolved.lower.baseColor).toBe("#77777c");
    // Isolated replay: retain unavailable prompt-derived context and all saved
    // construction. Transfer only the two now-correct material roles, not an
    // entire freshly synthesized plan from incomplete historical context.
    const plan: SkinPlan = { ...saved, outfitPlan: { ...original,
      upper: { ...original.upper, baseColor: resolved.upper.baseColor,
        leftSleeve: { ...original.upper.leftSleeve, color: resolved.upper.baseColor },
        rightSleeve: { ...original.upper.rightSleeve, color: resolved.upper.baseColor },
        colorBlocks: original.upper.colorBlocks.map(block => block.id === "upper_base" ? { ...block, color: resolved.upper.baseColor } : block) },
      lower: { ...original.lower, baseColor: resolved.lower.baseColor,
        legwear: { ...original.lower.legwear, color: original.lower.legwear.kind === "none" ? resolved.lower.baseColor : original.lower.legwear.color } },
    } };
    const style = { ...t.injectedParameters.faceStyle, topColor: colors.topColor }, design = t.referenceStyle.design;
    const render = (p: SkinPlan, f = t.injectedParameters.features, st = t.injectedParameters.faceStyle) => {
      const baseline = buildProceduralSourceAtlas(f, st, p)!;
      const composition = composeReferenceStyleAtlas(baseline, p, design, st);
      expect(validateReferenceAtlasCraft(composition.atlas, baseline, p, st, buildReferenceCraftPlan(p, design, composition)).ok).toBe(true);
      return composition.atlas;
    };
    const before = render(saved), actual = await decodePng(readFileSync(`${root}/skin.png`)), after = render(plan, colors, style);
    expect(before.rgba).toEqual(actual.rgba); expect(render(plan, colors, style).rgba).toEqual(after.rgba);
    expect(validateFinalAtlas(after)).toEqual({ ok: true, problems: [] });
    expect(plan.facePixelPlan).toBe(saved.facePixelPlan); expect(plan.hairPlan).toBe(saved.hairPlan);
    expect(plan.headIdentityPlan).toBe(saved.headIdentityPlan);
    expect(plan.outfitPlan.upper.leftSleeve.length).toBe("short");
    const headRects = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
    const changed: number[] = [];
    for (let i = 0; i < 4096; i++) {
      expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
      if ([0, 1, 2].some(ch => after.rgba[i * 4 + ch] !== before.rgba[i * 4 + ch])) {
        expect(headRects.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)).toBe(false);
        changed.push(i);
      }
    }
    expect(changed.length).toBeGreaterThan(0); expect(JSON.stringify([probe, saved])).toBe(immutable);
    // Second ablation: the observed standalone sweatshirt is mapped to the
    // existing pullover construction. Do not rebuild absent prompt context.
    const construction: SkinPlan = { ...plan, outfitPlan: { ...plan.outfitPlan,
      upper: { ...plan.outfitPlan.upper, garmentType: resolved.upper.garmentType,
        leftSleeve: resolved.upper.leftSleeve, rightSleeve: resolved.upper.rightSleeve },
      outerLayer: resolved.outerLayer, outerLayerRegions: resolved.outerLayerRegions,
    } };
    const resolvedStyle = buildFaceStyle(probe, colors);
    const constructionStyle = { ...style, topType: resolvedStyle.topType, sleeveLength: resolvedStyle.sleeveLength };
    expect(construction.outfitPlan.upper.garmentType).toBe("sweater");
    expect(construction.outfitPlan.upper.leftSleeve.length).toBe("long");
    expect(construction.outfitPlan.upper.rightSleeve.length).toBe("long");
    expect(construction.outfitPlan.upper.leftSleeve.source).toBe("strongly_implied");
    expect(constructionStyle.garmentTexture).toBe(style.garmentTexture);
    const constructed = render(construction, colors, constructionStyle);
    expect(render(construction, colors, constructionStyle).rgba).toEqual(constructed.rgba);
    expect(validateFinalAtlas(constructed)).toEqual({ ok: true, problems: [] });
    const constructionPixels: number[] = [];
    const allowedRects = (["body", "leftArm", "rightArm"] as const).flatMap(part => {
      const layout = CLASSIC_LAYOUT[part];
      return [...Object.values(layout.base), ...Object.values(layout.overlay)];
    });
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => after.rgba[i * 4 + ch] !== constructed.rgba[i * 4 + ch])) {
      expect(allowedRects.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h), `construction_boundary:${i}`).toBe(true);
      constructionPixels.push(i);
    }
    expect(constructionPixels.length).toBeGreaterThan(0);
    historicalCrown.mockRestore();
    const priorBytes = readFileSync("evaluation-artifacts/compact-current-normalization-20261008-dMBCyH/results.json");
    expect(sha(priorBytes)).toBe("ee1699a4839ac6b2d59281b8224a57b9b38b62a940e2597155cc15e3ab3489b4");
    const prior = JSON.parse(priorBytes.toString()).rows as Array<{ id: string; planSha256: string; atlasSha256: string }>;
    const oldAtlasRoot = "evaluation-artifacts/reference-style-composition-20261005-04Pt8Q";
    const oldAtlasManifest = readFileSync(`${oldAtlasRoot}/results.json`);
    expect(sha(oldAtlasManifest)).toBe("db86ce1b42187093d1696c2ee8aef79b8b70ac4d7b07c4d77f923e1e11864c46");
    const oldAtlases = JSON.parse(oldAtlasManifest.toString()).cases as Array<{
      caseId: string; selection: { selectedHash: string };
    }>;
    const annotations: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
    const rows = [];
    for (const f of annotations) {
      const raw = strictBoundaryAnalysisFromAnnotation(f).analysis;
      if (f.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${f.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const a = normalizeAnalysisForRendering(raw), p = buildSkinPlan(a);
      const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
      const st = buildFaceStyle(a, features, p.hairPlan), base = buildProceduralSourceAtlas(features, st, p)!;
      const selected = selectReferenceStyleAtlas(base, p, buildReferenceStylePlan(a), st).selected!;
      expect(selected).toBeTruthy();
      const atlas = selected.composition.atlas;
      const old = prior.find(r => r.id === f.id)!;
      expect(sha(JSON.stringify(p)), f.id).toBe(old.planSha256);
      const atlasDiff = sha(atlas.rgba) === old.atlasSha256 ? 0 : 1;
      let legwearMigrationPixels = 0;
      if (atlasDiff) {
        // Preserve the pinned old hash and inspect its actual pixels. Only the
        // separately approved legwear redesign may differ, never face/hair or
        // unrelated garment material. No regenerated historical baseline.
        expect(f.id).toBe("full-body-layered");
        expect(oldAtlases.find(r => r.caseId === f.id)!.selection.selectedHash).toBe(old.atlasSha256);
        const oldPng = readFileSync(`${oldAtlasRoot}/${f.id}-selected.png`);
        expect(sha(oldPng)).toBe("1346da50f89e868b2e52563abd5efc4415d720260256b38557b41a5139d33ea0");
        const oldAtlas = await decodePng(oldPng);
        expect(sha(oldAtlas.rgba)).toBe(old.atlasSha256);
        legwearMigrationPixels = verifyLegwearRedesign(oldAtlas, atlas, p.outfitPlan);
        expect(legwearMigrationPixels).toBeGreaterThan(0);
        expect(readFileSync(`${oldAtlasRoot}/${f.id}-selected.png`)).toEqual(oldPng);
      }
      expect(validateReferenceAtlasCraft(atlas, base, p, st, buildReferenceCraftPlan(p, selected.design, selected.composition)).ok).toBe(true);
      expect(validateFinalAtlas(atlas)).toEqual({ ok: true, problems: [] });
      rows.push({ id: f.id, calibrated: !!f.existing, planDiff: 0, atlasDiff,
        legwearMigrationPixels, unrelatedAtlasDiff: 0, craftPass: true });
    }
    expect(rows).toHaveLength(12); expect(rows.filter(r => r.calibrated)).toHaveLength(5);
    expect(rows.filter(r => r.atlasDiff)).toHaveLength(1);
    expect(rows.filter(r => r.calibrated && r.atlasDiff)).toHaveLength(0);
    expect(sha(readFileSync(`${oldAtlasRoot}/results.json`))).toBe(sha(oldAtlasManifest));
    const output = freshAuditOutput("evaluation-artifacts/sweatshirt-material-binding-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after], ["construction", constructed]] as const) {
      writeFileSync(`${output}/${name}-skin.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${output}/${name}-front.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_material_only_replay", providerCalls: 0,
      sourceRun: run.runId, sourceSummarySha256: sha(bytes), immutableLivePngExactReplay: true,
      beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.rgba), changedPixels: changed.length,
      observed: probe.observed.clothing, beforeMaterials: [original.upper.baseColor, original.lower.baseColor],
      afterMaterials: [plan.outfitPlan.upper.baseColor, plan.outfitPlan.lower.baseColor],
      sourceAnalysisUnchanged: true, faceHairUnchanged: true, sleevesUnchanged: true, alphaUnchanged: true,
      constructionAblation: { rgbaSha256: sha(constructed.rgba), changedPixels: constructionPixels.length,
        allowedBoundary: "torso_and_arms_only", garmentType: construction.outfitPlan.upper.garmentType,
        leftSleeve: construction.outfitPlan.upper.leftSleeve, rightSleeve: construction.outfitPlan.upper.rightSleeve,
        faceHairUnchanged: true, materialTextureUnchanged: true, noRecoveredMissingPrompt: true },
      frozen: rows, qualityGoalComplete: false, remaining: ["fresh_live_delivery_unverified", "primary_hair_length", "primary_iris_color", "invalid_localization"] }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    console.info("SWEATSHIRT_MATERIAL_REPLAY", output);
  } finally { historicalCrown.mockRestore(); network.mockRestore(); }
}, 180_000);
