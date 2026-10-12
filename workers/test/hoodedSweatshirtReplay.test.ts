import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("isolates the observed attached hood against immutable F003 without reconstructing missing analysis", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-003";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("ad3447747ebe2e327264b48917944bdce0c26536bcd796801918186d33644f8a");
    const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, immutable = JSON.stringify(t), old = t.injectedParameters;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(a.observed.clothing).toContain("black hooded sweatshirt");
    expect(old.faceStyle.topType).toBe("hoodie");
    expect(saved.outfitPlan.upper.garmentType).toBe("sweater");
    const resolved = buildOutfitPlan(a);
    expect(resolved.upper.garmentType).toBe("hoodie");
    expect(resolved.upper.neckline).toMatchObject({ kind: "hood_opening", innerVisible: false });
    expect(resolved.outerLayer.regions).toContain("hood_rim");
    const actual = await decodePng(png), root = freshAuditOutput("evaluation-artifacts/hooded-sweatshirt-replay-20261011-");
    const results = [];
    for (const mode of ["before", "hood-only"] as const) {
      const p = structuredClone(saved), style = old.faceStyle, design = t.referenceStyle.design;
      if (mode === "hood-only") {
        p.outfitPlan.upper.garmentType = resolved.upper.garmentType;
        p.outfitPlan.upper.collar = resolved.upper.collar;
        p.outfitPlan.upper.neckline = structuredClone(resolved.upper.neckline);
        p.outfitPlan.outerLayer = structuredClone(resolved.outerLayer);
        p.outfitPlan.outerLayerRegions = [...resolved.outerLayerRegions];
      }
      const base = buildProceduralSourceAtlas(old.features, style, p)!;
      const composed = composeReferenceStyleAtlas(base, p, design, style);
      if (mode === "before") expect(composed.atlas.rgba).toEqual(actual.rgba);
      else {
        const selected = selectReferenceStyleAtlas(base, p, design, style).selected!;
        expect(selected).toBeTruthy(); expect(selected.composition.atlas.rgba).toEqual(composed.atlas.rgba);
      }
      expect(composeReferenceStyleAtlas(base, p, design, style).atlas.rgba).toEqual(composed.atlas.rgba);
      expect(validateFinalAtlas(composed.atlas)).toEqual({ ok: true, problems: [] });
      const craft = validateReferenceAtlasCraft(composed.atlas, base, p, style, buildReferenceCraftPlan(p, design, composed));
      expect(craft.ok, JSON.stringify(craft)).toBe(true);
      const allowed = ["body", "rightArm", "leftArm"] as const;
      const rects = allowed.flatMap(k => [...Object.values(CLASSIC_LAYOUT[k].base), ...Object.values(CLASSIC_LAYOUT[k].overlay)]);
      const changedPixels: number[] = [];
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== composed.atlas.rgba[i * 4 + ch])) {
        changedPixels.push(i); const x = i % 64, y = Math.floor(i / 64);
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h), `outside:${mode}:${i}`).toBe(true);
      }
      if (mode !== "before") expect(changedPixels.length).toBeGreaterThan(0);
      expect(p.facePixelPlan).toEqual(saved.facePixelPlan); expect(p.hairPlan).toEqual(saved.hairPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      expect(p.outfitPlan.upper.pattern).toEqual(saved.outfitPlan.upper.pattern);
      expect(p.outfitPlan.upper.leftSleeve).toEqual(saved.outfitPlan.upper.leftSleeve);
      const encoded = await encodePng(composed.atlas); expect((await decodePng(encoded)).rgba).toEqual(composed.atlas.rgba);
      writeFileSync(`${root}/${mode}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(composed.atlas)) writeFileSync(`${root}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changedPixels, unrelatedPixels: 0, craftPass: true, atlasPass: true, rgbaSha256: sha(composed.atlas.rgba),
        category: p.outfitPlan.upper.garmentType, neckline: p.outfitPlan.upper.neckline, outerLayer: p.outfitPlan.outerLayer });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), runId: e.runId,
      providerCalls: 0, mode: "offline_saved_plan_hood_counterfactual_not_live", actualPngExactBaseline: true,
      fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false,
      classification: "PARAMETER_PRESERVED_PLAN_LOST", results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("HOODED_SWEATSHIRT_REPLAY", root);
  } finally { network.mockRestore(); }
}, 90_000);
