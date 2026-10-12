import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("preserves D010's existing long-sleeve policy in the executable atlas, alone and with observed materials/front locks", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-010";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("26c58761d0f08a862e8f4721194d02a8271236beb252c3700682c203a9ab8eb6");
    const run = JSON.parse(bytes.toString()).currentDefaultE2E, t = run.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, old = t.injectedParameters, immutable = JSON.stringify(t);
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    expect(old.faceStyle.sleeveLength).toBe("long");
    expect(saved.outfitPlan.upper.leftSleeve.length).toBe("short");
    expect(saved.outfitPlan.upper.rightSleeve.length).toBe("short");
    // Missing prompt context is not reconstructed. Only the observed-derived
    // sleeve roles and their exact added construction are transferred.
    const resolved = buildOutfitPlan(a), colors = refineFeatureColorsFromAnalysis(a, old.features);
    expect(resolved.upper.leftSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
    expect(resolved.upper.rightSleeve).toMatchObject({ length: "long", terminationRow: 11, source: "strongly_implied" });
    expect(saved.outfitPlan.outerLayer.regions).not.toContain("cuffs");
    expect(resolved.outerLayer.regions).toEqual([
      saved.outfitPlan.outerLayer.regions[0], "cuffs", ...saved.outfitPlan.outerLayer.regions.slice(1),
    ]);
    expect(resolved.outerLayer.expectedPixels - saved.outfitPlan.outerLayer.expectedPixels).toBe(32);
    const actual = await decodePng(png), root = freshAuditOutput("evaluation-artifacts/hoodie-sleeve-propagation-20261010-");
    const results = [];
    for (const mode of ["before", "sleeves-only", "cumulative"] as const) {
      const p = structuredClone(saved), design = structuredClone(t.referenceStyle.design);
      const features = { ...old.features }, style = { ...old.faceStyle };
      if (mode !== "before") {
        for (const key of ["leftSleeve", "rightSleeve"] as const) {
          p.outfitPlan.upper[key] = { ...resolved.upper[key], color: saved.outfitPlan.upper[key].color };
        }
        p.outfitPlan.outerLayer = structuredClone(resolved.outerLayer);
        p.outfitPlan.outerLayerRegions = [...resolved.outerLayerRegions];
        p.outfitPlan.provenance = p.outfitPlan.provenance.map(x => x.target === "upper.sleeves"
          ? resolved.provenance.find(y => y.target === "upper.sleeves")! : x);
      }
      if (mode === "cumulative") {
        features.hatColor = colors.hatColor; style.hatColor = colors.hatColor;
        p.outfitPlan.upper.pattern = structuredClone(resolved.upper.pattern);
        design.drape = buildReferenceStylePlan(a).drape;
        expect(design.drape.eligible).toBe(true);
        expect(colors.hatColor).toBe("#2f7775");
      }
      const base = buildProceduralSourceAtlas(features, style, p)!;
      const output = composeReferenceStyleAtlas(base, p, design, style);
      if (mode === "before") expect(output.atlas.rgba).toEqual(actual.rgba);
      else {
        const selection = selectReferenceStyleAtlas(base, p, design, style).selected!;
        expect(selection).toBeTruthy(); expect(selection.composition.atlas.rgba).toEqual(output.atlas.rgba);
      }
      expect(composeReferenceStyleAtlas(base, p, design, style).atlas.rgba).toEqual(output.atlas.rgba);
      const craft = validateReferenceAtlasCraft(output.atlas, base, p, style, buildReferenceCraftPlan(p, design, output));
      expect(craft.ok, JSON.stringify(craft)).toBe(true); expect(validateFinalAtlas(output.atlas).ok).toBe(true);
      const parts = mode === "cumulative" ? ["head", "body", "leftArm", "rightArm"] as const : ["leftArm", "rightArm"] as const;
      const allowed = parts.flatMap(part => [...Object.values(CLASSIC_LAYOUT[part].base), ...Object.values(CLASSIC_LAYOUT[part].overlay)]);
      let changed = 0;
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => output.atlas.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) {
        changed++;
        expect(allowed.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h), `outside:${mode}:${i}`).toBe(true);
      }
      if (mode !== "before") expect(changed).toBeGreaterThan(0);
      expect(p.facePixelPlan).toEqual(saved.facePixelPlan); expect(p.hairPlan).toEqual(saved.hairPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      const encoded = await encodePng(output.atlas); expect((await decodePng(encoded)).rgba).toEqual(output.atlas.rgba);
      writeFileSync(`${root}/${mode}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(output.atlas)) writeFileSync(`${root}/${mode}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
      results.push({ mode, changedPixels: changed, unrelatedPixels: 0, craftPass: true, atlasPass: true,
        rgbaSha256: sha(output.atlas.rgba), leftSleeve: p.outfitPlan.upper.leftSleeve, rightSleeve: p.outfitPlan.upper.rightSleeve,
        hatColor: features.hatColor, pattern: p.outfitPlan.upper.pattern, looseHair: output.diagnostic.looseHair });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), runId: run.runId,
      providerCalls: 0, earliestLoss: "PARAMETER_PRESERVED_PLAN_LOST", actualPngExactBaseline: true,
      oldInjectedSleeveLength: old.faceStyle.sleeveLength, oldPlanSleeveLength: saved.outfitPlan.upper.leftSleeve.length,
      garmentDefaultIsObservedSleeveEvidence: false, fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false,
      results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("HOODIE_SLEEVE_REPLAY", root);
  } finally { network.mockRestore(); }
}, 90_000);
