// Authored semantic construction cases, not new photo/provider observations.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as primary from "../src/analysis";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, generateSkin, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { assertTorsoMaterialBoundary, withHistoricalTorsoMaterial } from "./historicalTorsoMaterial";
import type { Env } from "../src/types";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("preserves plain sweater identity and encodes a quiet center through the default PNG path for independent palettes", async () => {
  const root = mkdtempSync("evaluation-artifacts/quiet-torso-material-20261008-");
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const run = vi.spyOn(primary, "runPhotoAnalysis");
  const cases = [];
  try {
    for (const color of ["black", "cream", "blue"] as const) {
      const raw = makeAnalysis(), clothing = `Plain ${color} crew-neck pullover sweater with long sleeves; gray trousers`;
      raw.observed.clothing = clothing; raw.outfitPrompt = clothing;
      raw.canonicalIdentity.features = raw.canonicalIdentity.features.filter(f => f.category !== "outfit");
      raw.canonicalIdentity.features.push({ category: "outfit", feature: clothing, evidence: clothing,
        priority: 5, confidence: "high", targetRegions: ["torso.front", "arm.left", "arm.right"] });
      raw.canonicalIdentity.mustPreserve = ["short side-swept black fringe", "thin silver glasses", clothing];
      raw.visibleRegions.lowerBody = true;
      Object.assign(raw.fallbackFeatures, { topType: "sweater", topColor: color, topAccentColor: color, bottomColor: "gray", sleeveLength: "long" });
      Object.assign(raw.renderHints, { garmentTexture: "plain", outerGarment: "none", neckAccessory: "none", bottomPattern: "plain" });
      expect(primary.validatePhotoAnalysis(raw).ok).toBe(true);
      const a = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(a), originalPlan = JSON.stringify(plan);
      const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
      const style = buildFaceStyle(a, colors, plan.hairPlan), design = buildReferenceStylePlan(a);
      const base = buildProceduralSourceAtlas(colors, style, plan)!;
      const after = selectReferenceStyleAtlas(base, plan, design, style).selected!;
      const before = withHistoricalTorsoMaterial(() => selectReferenceStyleAtlas(base, plan, design, style).selected!);
      expect(before).not.toBeNull(); expect(after).not.toBeNull();
      expect(after.quality.violations).toEqual([]);
      expect(after.design).toEqual(before.design);
      expect(JSON.stringify(plan)).toBe(originalPlan);
      const changed = assertTorsoMaterialBoundary(after.composition.atlas, before.composition.atlas, plan.outfitPlan);
      expect(changed.length).toBeGreaterThan(0);
      const r = CLASSIC_LAYOUT.body.base.front;
      const plainFront = [1, 3, 5].map(i => Number.parseInt(plan.outfitPlan.upper.baseColor.slice(i, i + 2), 16));
      for (const x of [2, 3, 4, 5]) for (let y = 3; y < plan.outfitPlan.lower.waistRow - 1; y++) {
        const offset = ((r.y + y) * 64 + r.x + x) * 4;
        // Reference composition intentionally rebuilds the garment foundation;
        // compare to its source material, not legacy baseline micro-highlights.
        expect(Array.from(after.composition.atlas.rgba.slice(offset, offset + 4))).toEqual([...plainFront, 255]);
      }
      // The migration checker must still reject an unrelated limb or alpha edit.
      const bad = { ...after.composition.atlas, rgba: after.composition.atlas.rgba.slice() };
      const sleeve = CLASSIC_LAYOUT.rightArm.base.front, index = ((sleeve.y + 3) * 64 + sleeve.x + 1) * 4;
      bad.rgba[index] ^= 127;
      expect(() => assertTorsoMaterialBoundary(bad, before.composition.atlas, plan.outfitPlan)).toThrow();
      run.mockResolvedValue({ ok: true, analysis: raw, neuronsSpent: 0, attempts: 1 });
      const ai = vi.fn(async () => { throw new Error("unexpected_inference"); });
      const env = { AI: { run: ai }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
      const response = await generateSkin(env, `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(4)))}`);
      expect(response.status).toBe(200);
      const png = base64ToBytes(response.body.skinPngBase64!), decoded = await decodePng(png);
      expect(decoded.rgba).toEqual(after.composition.atlas.rgba); expect(validateFinalAtlas(decoded).ok).toBe(true);
      expect(ai).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
      writeFileSync(`${root}/${color}-default.png`, png, { flag: "wx" });
      for (const [label, atlas] of [["before", before.composition.atlas], ["after", decoded]] as const) {
        writeFileSync(`${root}/${color}-${label}-atlas.png`, await encodePng(atlas), { flag: "wx" });
        for (const view of renderSkinViews(atlas)) writeFileSync(`${root}/${color}-${label}-${view.name}.png`,
          await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      }
      cases.push({ color, observedClothing: clothing, outfitPlan: plan.outfitPlan,
        sourcePlanHash: hash(originalPlan), selectedDesign: after.design, changedPixels: changed,
        defaultPngHash: hash(png), defaultMatchesSelected: true, quality: after.quality });
    }
    expect(new Set(cases.map(c => c.defaultPngHash)).size).toBe(3);
    writeFileSync(`${root}/summary.json`, JSON.stringify({ providerCalls: 0, evidence: "authored_semantic_units_not_live",
      earliestLoss: "PLAN_PRESERVED_COMPOSITION_INVENTED_CENTRAL_MATERIAL_STRIPE", cases }, null, 2), { flag: "wx" });
    console.info(`QUIET_TORSO_MATERIAL ${root}`);
  } finally { run.mockRestore(); network.mockRestore(); }
}, 120000);
