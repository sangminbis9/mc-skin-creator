// Saved semantic evidence only; isolate category/material/ownership, not a new primary.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { observedGenericHatCategory } from "../src/observedHeadwear";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { resolveHeadOwnership } from "../src/headOwnership";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

it("restores D009's observed blue headwear through the existing bounded footprint without altering cloth", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-009";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
    expect(sha(bytes)).toBe("e2d9d4f7cbdcdf65d55923c9c719ae1b8e661d591c00174dceb5971ca283330c");
    const r = JSON.parse(bytes.toString()).currentDefaultE2E, t = r.result.propagationTrace;
    expect(Object.hasOwn(r.result.diagnostics.providerAppearance, "fallbackFeatures")).toBe(false);
    // Only these helpers' retained fields are used; no missing prompt is filled in.
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    const immutable = JSON.stringify(a), p: SkinPlan = structuredClone(t.skinPlan.skinPlan);
    const hat = observedGenericHatCategory(a.observed.accessories);
    expect(hat).toBe("cap"); if (!hat) throw Error("headwear_evidence_missing");
    const recovered = { ...a, fallbackFeatures: { ...a.fallbackFeatures, hat } };
    const old = t.injectedParameters;
    const color = refineFeatureColorsFromAnalysis(recovered, old.features).hatColor;
    expect(color).toBe("#7fc3e8");
    p.headIdentityPlan.ownership = resolveHeadOwnership(recovered, p.hairPlan, p.facePixelPlan);
    const features = { ...old.features, hat, hatColor: color }, style = { ...old.faceStyle, hat, hatColor: color };
    const baseline = buildProceduralSourceAtlas(features, style, p)!;
    const after = composeReferenceStyleAtlas(baseline, p, t.referenceStyle.design, style);
    const before = composeReferenceStyleAtlas(buildProceduralSourceAtlas(old.features, old.faceStyle, t.skinPlan.skinPlan)!,
      t.skinPlan.skinPlan, t.referenceStyle.design, old.faceStyle).atlas;
    expect(before.rgba).toEqual((await decodePng(png)).rgba);
    const craft = validateReferenceAtlasCraft(after.atlas, baseline, p, style,
      buildReferenceCraftPlan(p, t.referenceStyle.design, after));
    expect(craft.ok, JSON.stringify(craft)).toBe(true);
    expect(validateFinalAtlas(after.atlas).ok).toBe(true);
    const headRects = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
    let changed = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => before.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      expect(headRects.some(rect => i % 64 >= rect.x && i % 64 < rect.x + rect.w
        && Math.floor(i / 64) >= rect.y && Math.floor(i / 64) < rect.y + rect.h), `non-head:${i}`).toBe(true);
      changed++;
    }
    expect(changed).toBeGreaterThan(0);
    expect(p.outfitPlan).toEqual(t.skinPlan.skinPlan.outfitPlan);
    expect(p.hairPlan).toEqual(t.skinPlan.skinPlan.hairPlan);
    expect(p.facePixelPlan).toEqual(t.skinPlan.skinPlan.facePixelPlan);
    const out = freshAuditOutput("evaluation-artifacts/observed-headwear-reconstruction-20261010-");
    for (const [name, image] of [["before", before], ["after", after.atlas]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(image), { flag: "wx" });
      for (const view of renderSkinViews(image)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, runId: r.runId,
      sourceSummarySha256: sha(bytes), actualPngExactReplay: true,
      beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.atlas.rgba), changedHeadPixels: changed,
      unrelatedPixelChanges: 0, beforeHat: "none", afterHat: hat, afterHatColor: color,
      categoryBasis: "explicit_observed_generic_hat_existing_bounded_crown_grammar_not_baseball_shape_claim",
      optionalProviderCachePresent: false, craftPass: true, finalAtlasPass: true,
      providerCalls: 0, missingPromptsReconstructed: false, newLiveDeliveryVerified: false,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(a)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("HEADWEAR_RECONSTRUCTION", out);
  } finally { network.mockRestore(); }
}, 60_000);
