// Offline semantic boundary: no provider runner, missing prompt or photo label injection.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { preserveObservedScarfBeltColors } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { buildReferenceScarfFinish, observedScarfFall } from "../src/referenceScarfFinish";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it.each([
  "Pale ribbed scarf wrapped around the throat with one hanging tail ending in fringes",
  "Blue scarf wrapped around neck with a hanging end",
  "Red scarf with draping tails",
  "Ivory scarf has one hanging tail",
])("retains an explicitly noun-bound hanging scarf: %s", text => {
  expect(observedScarfFall(text)).toBe("long");
});
it.each([
  "Scarf with fringed ends", // Fringe is not a length observation.
  "Scarf around neck and hair with one hanging tail",
  "Scarf and a cardigan with hanging tails",
  "Hair with a hanging tail and a neck scarf",
  "Scarf. One hanging tail", // No cross-sentence anaphora inference.
  "Scarf with possibly one hanging tail",
  "Scarf with no hanging tail",
  "Scarf with a hidden hanging end",
  "Head scarf with one hanging tail",
  "Head-scarf with one hanging tail",
  "Scarf wrapped around the head with one hanging tail",
  "Scarf with one hanging tail covering the hair",
  "Scarf with one hanging tail attached to a bag",
])("does not transfer unrelated or uncertain tails into neck clothing: %s", text => {
  expect(observedScarfFall(text)).toBeNull();
});

it("replays the saved observed tail through reference selection/PNG with exactly ten body cells changed", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const path = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001/summary.json";
    const bytes = readFileSync(path), evidence = JSON.parse(bytes.toString()).currentDefaultE2E;
    expect(sha(bytes)).toBe("d9f82481a49f537a37b26bb5d23534eda6d07560a9d233d070ca83d002938ff1");
    const trace = evidence.result.propagationTrace, original = JSON.stringify(trace);
    const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const plan: SkinPlan = structuredClone(trace.skinPlan.skinPlan);
    plan.headIdentityPlan.ownership = resolveHeadOwnership(a, plan.hairPlan, plan.facePixelPlan);
    plan.outfitPlan = preserveObservedScarfBeltColors(plan.outfitPlan, a);
    const planSnapshot = JSON.stringify(plan);
    const assignment = plan.assignments.find(p => p.category === "accessory" && p.feature === "Cream fringed knit scarf")!;
    expect(assignment.evidence).toBe("Pale ribbed scarf wrapped around the throat with one hanging tail ending in fringes");
    expect(assignment.confidence).toBe("high");
    expect(trace.primary.canonicalIdentity.features.some((f: { evidence: string }) => f.evidence === assignment.evidence)).toBe(true);
    expect(trace.renderAnalysis.canonicalIdentity.features.some((f: { evidence: string }) => f.evidence === assignment.evidence)).toBe(true);
    expect(observedScarfFall(assignment.evidence)).toBe("long");
    const style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const baseline = buildProceduralSourceAtlas(features, style, plan)!;
    const beforePath = "evaluation-artifacts/hair-flower-ownership-offline-20261010-DFNbfT/styled.png";
    const beforeBytes = readFileSync(beforePath), before = await decodePng(beforeBytes);
    expect(sha(before.rgba)).toBe("a2c60886be6cd92f13333950ab2561b0fe429cad493122bc894666d10ccaa84b");
    const result = renderReferencePrimaryAtlas(baseline, plan, a, style);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
    expect(result.summary.status).toBe("reference_style_accepted");
    const finish = buildReferenceScarfFinish(plan, style.skinTone);
    expect(finish).toMatchObject({ status: "authored", observedFall: "long" });
    expect(finish.paints).toHaveLength(10);
    const scarf = plan.outfitPlan.accessories.find(p => p.kind === "scarf")!;
    expect(scarf.color).toBe("#ded2b6");
    // Pin the later two-cell authored eye presentation separately, then project
    // it out for this historical scarf-only comparison. Never rewrite evidence.
    const scarfProjection = structuredClone(result.atlas), head = CLASSIC_LAYOUT.head.base.front;
    for (const x of [2, 5]) {
      const i = ((head.y + 3) * 64 + head.x + x) * 4;
      expect(result.summary.design?.face.family).toBe("dark_stylish");
      expect([...result.atlas.rgba.slice(i, i + 4)]).toEqual([199, 193, 184, 255]);
      scarfProjection.rgba.set(before.rgba.slice(i, i + 4), i);
    }
    // Independently authorize the old bounded long-tail grammar, not arbitrary
    // renderer diagnostics. Everything outside the two migrations stays exact.
    const front = CLASSIC_LAYOUT.body.base.front, permitted = new Map<number, number[]>();
    const color = [1, 3, 5].map(i => Number.parseInt(scarf.color.slice(i, i + 2), 16));
    for (let y = 3; y < 8; y++) for (const x of [3, 4]) {
      permitted.set(((front.y + y) * 64 + front.x + x) * 4,
        [...color.map(c => Math.round(c * (y === 7 ? 0.72 : x === 3 ? 0.90 : 0.84))), 255]);
    }
    const changed: number[] = [];
    for (let i = 0; i < before.rgba.length; i += 4) {
      if (permitted.has(i)) {
        expect([...result.atlas.rgba.slice(i, i + 4)], `tail:${i}`).toEqual(permitted.get(i));
        if ([0, 1, 2, 3].some(c => result.atlas.rgba[i + c] !== before.rgba[i + c])) changed.push(i / 4);
      } else expect(scarfProjection.rgba.slice(i, i + 4), `unrelated:${i}`).toEqual(before.rgba.slice(i, i + 4));
    }
    expect(changed).toHaveLength(10);
    expect(validateFinalAtlas(result.atlas)).toEqual({ ok: true, problems: [] });
    const png = await encodePng(result.atlas);
    expect((await decodePng(png)).rgba).toEqual(result.atlas.rgba);
    expect(renderReferencePrimaryAtlas(baseline, plan, a, style)).toEqual(result);
    const noTrustedTail = structuredClone(plan);
    noTrustedTail.assignments.filter(p => p.evidence === assignment.evidence).forEach(p => { p.confidence = "low"; });
    expect(buildReferenceScarfFinish(noTrustedTail, style.skinTone).status).toBe("not_observed");
    expect(JSON.stringify(trace)).toBe(original);
    expect(JSON.stringify(plan)).toBe(planSnapshot);
    expect(readFileSync(path)).toEqual(bytes); expect(readFileSync(beforePath)).toEqual(beforeBytes);
    expect(network).not.toHaveBeenCalled();
    const output = freshAuditOutput("evaluation-artifacts/reference-hanging-scarf-offline-20261010-");
    writeFileSync(`${output}/after.png`, png, { flag: "wx" });
    for (const [stage, atlas] of [["before", before], ["after", result.atlas]] as const)
      for (const view of renderSkinViews(atlas)) writeFileSync(`${output}/${stage}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
    writeFileSync(`${output}/summary.json`, JSON.stringify({ scope: "saved_observation_offline_replay_not_live",
      sourceRunId: evidence.runId, sourceSummarySha256: sha(bytes), historicalPreserved: true,
      earliestLoss: "PLAN_EVIDENCE_PRESERVED_SCARF_FALL_SELECTION_LOST", cue: assignment.evidence,
      sourceObservationsUnchanged: true, planUnchangedByScarfFinish: true, changedPixels: changed, intentionalEyePresentationPixels: 2, unrelatedPixelsChanged: 0, finish,
      beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(result.atlas.rgba), finalPngSha256: sha(png),
      validation: result.summary, providerCalls: 0 }, null, 2), { flag: "wx" });
    console.info(`REFERENCE_HANGING_SCARF ${output}`);
  } finally { network.mockRestore(); }
}, 60_000);
