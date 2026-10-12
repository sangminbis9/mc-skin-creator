import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { PhotoAnalysis } from "../src/analysis";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("isolates the clothing-only covered candidate using immutable F006 source plans", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-006";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("85d1fdb2a9d0e2498de32a2d67c2977b8259187ad11dd672b6a1a22f60a3e4eb");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    const plan: SkinPlan = t.skinPlan.skinPlan, style = t.injectedParameters.faceStyle;
    const immutable = JSON.stringify(t), baseline = buildProceduralSourceAtlas(t.injectedParameters.features, style, plan)!;
    const actual = await decodePng(png), original = t.referenceStyle.design;
    expect(style.hat).toBe("none"); expect(plan.headIdentityPlan.ownership!.covering).toBe(false);
    expect(composeReferenceStyleAtlas(baseline, plan, original, style).atlas.rgba).toEqual(actual.rgba);
    const current = buildReferenceStylePlan(a);
    expect(current.hair.family).toBe("short_shaggy_masculine");
    expect(current.candidates.hair.some(c => c.family === "hoodie_beanie_compatible")).toBe(false);
    const ablated = structuredClone(original);
    ablated.candidates.hair = ablated.candidates.hair.filter((c: { family: string }) => c.family !== "hoodie_beanie_compatible");
    ablated.hair = ablated.candidates.hair[0];
    const root = freshAuditOutput("evaluation-artifacts/reference-hoodie-hair-selection-20261011-");
    const modes = [{ mode: "actual-live", design: original }, { mode: "without-clothing-only-covered-candidate", design: ablated },
      { mode: "current-offline-selection", design: current }];
    const results = [];
    for (const { mode, design } of modes) {
      const selection = selectReferenceStyleAtlas(baseline, plan, design, style);
      expect(selection.selected).not.toBeNull();
      const chosen = selection.selected!;
      if (mode === "actual-live") expect(chosen.composition.atlas.rgba).toEqual(actual.rgba);
      expect(validateReferenceAtlasCraft(chosen.composition.atlas, baseline, plan, style,
        buildReferenceCraftPlan(plan, chosen.design, chosen.composition)).ok).toBe(true);
      const changed = Array.from({ length: 4096 }, (_, i) => i).filter(i =>
        [0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== chosen.composition.atlas.rgba[i * 4 + ch]));
      const head = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
      for (const i of changed) expect(head.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)).toBe(true);
      writeFileSync(`${root}/${mode}.png`, await encodePng(chosen.composition.atlas), { flag: "wx" });
      for (const v of renderSkinViews(chosen.composition.atlas)) writeFileSync(`${root}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, family: chosen.design.hair.family, changedPixels: changed.length, craftPass: true,
        rgbaSha256: sha(chosen.composition.atlas.rgba), candidates: selection.candidates.map(c => ({
          id: c.id, rejection: c.rejection, violations: c.quality?.violations, score: c.quality?.score })),
        outerHairCells: chosen.quality.metrics.actualOuterHairCells });
    }
    expect(results[2].rgbaSha256).toBe(results[1].rgbaSha256);
    expect(results[2].changedPixels).toBe(70);
    expect(results[2].outerHairCells).toBe(18);
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), providerCalls: 0,
      sourceHat: style.hat, sourceCovering: plan.headIdentityPlan.ownership!.covering, currentFirstHair: current.hair,
      savedFirstHair: original.hair, evidence: "same saved plans; remove only clothing-derived covered candidate",
      classification: "OFFLINE_CANDIDATE_ABLATION_NOT_NEW_PROVIDER_EVIDENCE", results }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info("HOODIE_HAIR_SELECTION", root);
  } finally { network.mockRestore(); }
}, 60_000);
