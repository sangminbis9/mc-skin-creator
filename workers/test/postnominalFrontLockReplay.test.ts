// Immutable same-run replay; deliberately no live runner imports.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildReferenceStylePlan, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
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

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("retains D020's high-confidence, length-bound face-framing claim through selection and paint", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("5777df6ec264f7fee456464e5e4e6467774d42d8af06c210cc1477c295724747");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace, immutable = JSON.stringify(t);
    const saved: SkinPlan = t.skinPlan.skinPlan, originalDesign: ReferenceStylePlan = t.referenceStyle.design;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    const canonical = a.canonicalIdentity.features.find(f => f.category === "hair" && f.confidence === "high")!;
    expect(canonical.evidence).toBe("Chest-length locks framing the face and wispy bangs peeking out under the beanie");
    expect(a.observed.hair).toBe(t.primary.observed.hair);
    expect(saved.assignments.some(f => f.category === "hair" && f.confidence === "high" && f.evidence === canonical.evidence)).toBe(true);
    const design = structuredClone(originalDesign);
    expect(design.drape.eligible).toBe(false);
    design.drape = buildReferenceStylePlan(a).drape;
    expect(design.drape.eligible).toBe(true);
    // Overall chest length + separate face framing is not sufficient. The
    // explicit canonical endpoint is necessary, not an invented completion.
    for (const confidence of ["medium", "low"] as const) {
      const weaker = structuredClone(a);
      weaker.canonicalIdentity.features.filter(f => f.category === "hair").forEach(f => { f.confidence = confidence; });
      expect(buildReferenceStylePlan(weaker).drape.eligible).toBe(false);
    }
    const hidden = structuredClone(a); hidden.visibleRegions.hair = false;
    expect(buildReferenceStylePlan(hidden).drape.eligible).toBe(false);
    const st = t.injectedParameters.faceStyle, features = t.injectedParameters.features;
    const render = (p: SkinPlan, d: ReferenceStylePlan) => {
      const base = buildProceduralSourceAtlas(features, st, p)!;
      const r = composeReferenceStyleAtlas(base, p, d, st);
      expect(validateFinalAtlas(r.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(r.atlas, base, p, st, buildReferenceCraftPlan(p, d, r)).ok).toBe(true);
      return { base, ...r };
    };
    const actual = await decodePng(png), before = render(saved, originalDesign), after = render(saved, design);
    expect(before.atlas.rgba).toEqual(actual.rgba);
    const front = after.diagnostic.looseHair.points.filter(p => p.face === "front");
    expect(front).toHaveLength(16); expect(after.diagnostic.looseHair.frontEvidence).toBe("observed_front_lock_endpoint");
    expect(after.diagnostic.looseHair.points.filter(p => p.face === "back"))
      .toEqual(before.diagnostic.looseHair.points.filter(p => p.face === "back"));
    const b = CLASSIC_LAYOUT.body.base.front, o = CLASSIC_LAYOUT.body.overlay.front;
    const allowed = new Set(front.map(p => (b.y + p.y) * 64 + b.x + p.x));
    let changed = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.atlas.rgba[i * 4 + 3]).toBe(before.atlas.rgba[i * 4 + 3]);
      if (![0, 1, 2].some(c => after.atlas.rgba[i * 4 + c] !== before.atlas.rgba[i * 4 + c])) continue;
      changed++; expect(allowed.has(i), `unrelated pixel ${i}`).toBe(true);
    }
    expect(changed).toBe(16);
    const occluded = front.filter(p => after.atlas.rgba[((o.y + p.y) * 64 + o.x + p.x) * 4 + 3] !== 0);
    expect(occluded.map(p => [p.x, p.y])).toEqual([[0, 0], [7, 0]]);
    // Compose with the independently tested cloth correction; do not rebuild
    // unavailable primary context or alter any other saved plan parameter.
    const combinedPlan = structuredClone(saved);
    combinedPlan.outfitPlan.upper.pattern = buildOutfitPlan(a).upper.pattern;
    const combined = render(combinedPlan, design);
    const selected = selectReferenceStyleAtlas(combined.base, combinedPlan, design, st).selected!;
    expect(selected).not.toBeNull(); expect(selected.composition.atlas.rgba).toEqual(combined.atlas.rgba);
    expect(render(combinedPlan, design).atlas.rgba).toEqual(combined.atlas.rgba);
    const out = freshAuditOutput("evaluation-artifacts/postnominal-front-lock-replay-20261011-");
    for (const [name, r] of [["before", before], ["hair-only", after], ["combined", combined]] as const) {
      const encoded = await encodePng(r.atlas); expect((await decodePng(encoded)).rgba).toEqual(r.atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(r.atlas).filter(v => ["front", "back"].includes(v.name)))
        writeFileSync(`${out}/${name}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_same_run_drape_only_replay", providerCalls: 0,
      sourceRoot: root, sourceSummarySha256: sha(bytes), sourcePngSha256: sha(png), actualPngExactBaseline: true,
      earliestLoss: "NORMALIZED_PRESERVED_SELECTION_LOST", canonicalHairEvidence: canonical.evidence,
      beforeDrape: originalDesign.drape, afterDrape: design.drape, changedPixels: changed, unrelatedChangedPixels: 0,
      visibleFrontCells: front.length - occluded.length, preservedHoodOcclusion: occluded.map(p => [p.x, p.y]),
      beforeRgba: sha(before.atlas.rgba), hairOnlyRgba: sha(after.atlas.rgba), combinedRgba: sha(combined.atlas.rgba),
      otherSameRunParametersUnchanged: true, craftPass: true, atlasPass: true, selectionAccepted: true,
      freshLiveDeliveryVerified: false, eyePresentation: combined.diagnostic.faceFinish,
      unresolved: ["eye_readability", "cuff_color", "invalid_localization"] }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("POSTNOMINAL_FRONT_LOCK_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
