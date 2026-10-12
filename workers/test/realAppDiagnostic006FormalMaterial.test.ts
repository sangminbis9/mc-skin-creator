// Offline only. Read immutable same-run -006 evidence; never select a live runner.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { preserveObservedFormalSuit } from "../src/outfitIdentity";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";

const sourceRoot = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-006";
const sourceBytes = fs.readFileSync(path.join(sourceRoot, "summary.json"));
const run = JSON.parse(sourceBytes.toString()).currentDefaultE2E;
const trace = run.result.propagationTrace;
const savedPlan: SkinPlan = trace.skinPlan.skinPlan;
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it.each([
  ["dark charcoal grey", "#242326"], ["charcoal gray", "#242326"],
  ["dark gray", "#242326"], ["dark-grey", "#242326"],
  ["gray", "#77777c"], ["grey", "#77777c"], ["light gray", "#b7b7b7"],
  ["blue", "#416b9d"],
])("preserves formal material value without collapsing all colors: %s", (name, expected) => {
  const a = makeAnalysis();
  a.observed.clothing = `A ${name} suit jacket over a white shirt with a dark tie with white stripes.`;
  a.outfitPrompt = a.observed.clothing;
  a.visibleRegions.upperBody = true;
  a.renderHints.outerGarment = "open_jacket";
  a.renderHints.neckAccessory = "tie";
  const plan = buildSkinPlan(a).outfitPlan;
  expect(plan.formalSuit).toMatchObject({ jacketColor: expected, shirtColor: "#eeeae1", tieColor: "#242326" });
});

it("keeps charcoal descriptors scoped to their own material, not adjacent shirts or tie trim", () => {
  const a = makeAnalysis();
  a.observed.clothing = "A gray suit jacket over a white shirt and a navy tie with charcoal gray stripes.";
  a.renderHints.outerGarment = "open_jacket";
  const plan = buildSkinPlan(a).outfitPlan;
  expect(plan.formalSuit).toMatchObject({ jacketColor: "#77777c", shirtColor: "#eeeae1", tieColor: "#273954" });
});

it("replays exact -006 before/after pixels with only observed formal material binding changed", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const evidenceBefore = JSON.stringify(trace.renderAnalysis), oldPlan = JSON.stringify(savedPlan);
    const style: FaceStyle = trace.injectedParameters.faceStyle;
    const design: ReferenceStylePlan = trace.referenceStyle.design;
    const beforeSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, savedPlan)!;
    const before = composeReferenceStyleAtlas(beforeSource, savedPlan, design, style);
    const disk = await decodePng(fs.readFileSync(path.join(sourceRoot, "skin.png")));
    expect(before.atlas.rgba).toEqual(disk.rgba);
    expect(savedPlan.outfitPlan.formalSuit?.jacketColor).toBe("#77777c");
    const fixedPlan = structuredClone(savedPlan);
    fixedPlan.outfitPlan = preserveObservedFormalSuit(savedPlan.outfitPlan, trace.renderAnalysis);
    expect(fixedPlan.outfitPlan.formalSuit).toMatchObject({ jacketColor: "#242326", shirtColor: "#eeeae1",
      tieColor: "#242326", tieAccent: "#eeeae1", trouserColor: "#242326" });
    const afterSource = buildProceduralSourceAtlas(trace.injectedParameters.features, style, fixedPlan)!;
    const after = composeReferenceStyleAtlas(afterSource, fixedPlan, design, style);
    expect(after.diagnostic.constraints.ok).toBe(true);
    const craft = validateReferenceAtlasCraft(after.atlas, afterSource, fixedPlan, style,
      buildReferenceCraftPlan(fixedPlan, design, after));
    expect(craft.ok, craft.problems.join(",")).toBe(true);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(composeReferenceStyleAtlas(afterSource, fixedPlan, design, style).atlas.rgba).toEqual(after.atlas.rgba);
    for (const layer of ["base", "overlay"] as const) for (const r of Object.values(CLASSIC_LAYOUT.head[layer]))
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
        const i = ((r.y + y) * 64 + r.x + x) * 4;
        expect(after.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
      }
    expect(JSON.stringify(trace.renderAnalysis)).toBe(evidenceBefore);
    expect(JSON.stringify(savedPlan)).toBe(oldPlan);
    expect(sha(sourceBytes)).toBe("7db087c1e533df73d22a6ab78ce9fd6a40320bbeeb44e0dcbc67f5503e2c9d4d");
    expect(sha(after.atlas.rgba)).not.toBe(sha(disk.rgba));
    const output = fs.mkdtempSync("evaluation-artifacts/real-app-006-charcoal-material-offline-20261008-");
    for (const [name, atlas] of [["before", before.atlas], ["after", after.atlas]] as const) {
      fs.writeFileSync(path.join(output, `${name}.png`), await encodePng(atlas), { flag: "wx" });
      const front = renderSkinViews(atlas).find(v => v.name === "front")!;
      fs.writeFileSync(path.join(output, `${name}-front.png`), await encodePng(scaleNearestNeighbor(front.image, 192, 384)), { flag: "wx" });
    }
    fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify({ evidenceMode: "saved_same_run_plan_parameter_replay",
      runId: run.runId, sourceSummarySha256: sha(sourceBytes), beforeMatchesActualPng: true,
      earliestLoss: "FORMAL_SUIT_PARAMETERS_LOST", lostEvidence: "dark charcoal grey",
      beforeFormalSuit: savedPlan.outfitPlan.formalSuit, afterFormalSuit: fixedPlan.outfitPlan.formalSuit,
      beforeRgbaSha256: sha(before.atlas.rgba), afterRgbaSha256: sha(after.atlas.rgba), headPixelDiff: 0,
      sourceEvidenceUnchanged: true, selectedFamilyUnchanged: true, atlasPass: true, craftPass: craft.ok,
      hairPart: trace.primary.renderHints.hairPart, fringeOpening: trace.primary.renderHints.fringeOpening,
      observedHairLength: trace.primary.renderHints.overallHairLength, noPrimaryHairCorrection: true,
      providerCalls: 0, freshLiveDeliveryVerified: false }, null, 2), { flag: "wx" });
    console.log("REAL_APP_006_CHARCOAL_MATERIAL_OFFLINE", output);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
