import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import { normalizeAnalysisForRendering, buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { validatePortraitRegion } from "../src/analysis";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { encodePng } from "../src/png";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("compares stored accepted geometry through the current renderer under one explicitly fixed primary context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const v3Path = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json";
    const v4Path = "evaluation-artifacts/current-source-v4-localization-29002888-live-20260926-002/summary.json";
    const v3Bytes = readFileSync(v3Path), v4Bytes = readFileSync(v4Path);
    const v3 = JSON.parse(v3Bytes.toString()).currentDefaultE2E.result;
    const v4 = JSON.parse(v4Bytes.toString()).currentSourceV4;
    expect(v4.classification).toBe("V4_LOCALIZATION_AND_GEOMETRY_ACQUIRED");
    expect(v4.geometry).toMatchObject({ providerShapeValid: true, semanticValid: true, errors: [] });
    expect(v4.localization.evidence.provenanceComplete).toBe(true);
    expect(validatePortraitRegion(v4.localization.evidence.region).ok).toBe(true);
    const baseline = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/results.json", "utf8"))
      .cases.find((r: { id: string }) => r.id === "current-geometry-fixed-context");
    const saved = v3.diagnostics.normalizedPrimary;
    const fixed = makeAnalysis({ ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing });
    const subjects = [
      { id: "semantic", geometry: undefined },
      { id: "v3-center-crop", geometry: acceptedFaceGeometry(v3.diagnostics.geometry.acceptedGeometry) },
      { id: "v4-subject-crop", geometry: acceptedFaceGeometry(v4.acceptedGeometry) },
    ];
    expect(subjects[1].geometry).toEqual(v3.diagnostics.geometry.acceptedGeometry);
    expect(subjects[2].geometry).toEqual(v4.acceptedGeometry);
    const root = mkdtempSync("evaluation-artifacts/current-geometry-comparison-20260927-");
    const cases = [];
    let reference: ReturnType<typeof buildProceduralFallbackAtlas> = null;
    let referencePlan: ReturnType<typeof buildSkinPlan> | undefined;
    for (const subject of subjects) {
      const analysis = normalizeAnalysisForRendering({ ...structuredClone(fixed), faceIdentityGeometry: subject.geometry });
      const plans = buildFacePixelPlanVariants(analysis, 3);
      expect(plans.length, subject.id).toBeGreaterThan(0); expect(plans.length).toBeLessThanOrEqual(3);
      const plan = buildSkinPlan(analysis);
      const style = buildFaceStyle(analysis, v3.features, plan.hairPlan);
      const atlas = buildProceduralFallbackAtlas(v3.features, style, plan);
      expect(atlas, subject.id).not.toBeNull(); if (!atlas) throw new Error(`atlas_rejected:${subject.id}`);
      const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
      expect(craft.ok, `${subject.id}:${craft.problems.join(";")}`).toBe(true);
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      const changed = [];
      if (reference) {
        expect(plan.outfitPlan).toEqual(referencePlan!.outfitPlan);
        expect(plan.hairPlan).toEqual(referencePlan!.hairPlan);
        for (let p = 0; p < 4096; p++) {
          expect(atlas.rgba[p * 4 + 3]).toBe(reference.rgba[p * 4 + 3]);
          if ([0, 1, 2].some(c => atlas.rgba[p * 4 + c] !== reference!.rgba[p * 4 + c])) {
            const x = p % 64, y = Math.floor(p / 64); changed.push({ x, y });
            expect(y < 16, subject.id).toBe(true);
          }
        }
      } else { reference = atlas; referencePlan = plan; }
      if (subject.id === "v3-center-crop") {
        expect(sha(JSON.stringify(plan))).toBe(baseline.planHash);
        expect(sha(atlas.rgba)).toBe(baseline.atlasHash);
      }
      writeFileSync(`${root}/${subject.id}.png`, await encodePng(atlas), { flag: "wx" });
      for (const view of renderSkinViews(atlas).filter(v => ["front", "front_left_three_quarter", "front_right_three_quarter"].includes(v.name))) {
        writeFileSync(`${root}/${subject.id}-${view.name}-head.png`,
          await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
      }
      const face = new Uint8Array(8 * 8 * 4);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const p = ((y + 8) * 64 + x + 8) * 4;
        face.set(atlas.rgba.subarray(p, p + 4), (y * 8 + x) * 4);
      }
      writeFileSync(`${root}/${subject.id}-face-uv.png`, await encodePng(scaleNearestNeighbor({ width: 8, height: 8, rgba: face }, 256, 256)), { flag: "wx" });
      cases.push({ id: subject.id, geometry: subject.geometry ?? null, plan, style, craft,
        candidateCount: plans.length, candidateCosts: plans.map(p => ({ variantId: p.variantId, cost: p.candidateCost })),
        changedFromSemantic: changed, planHash: sha(JSON.stringify(plan)), atlasHash: sha(atlas.rgba) });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, productionSourceChanged: false,
      v3SummarySha: sha(v3Bytes), v4SummarySha: sha(v4Bytes),
      v4Provenance: { localization: v4.localization.evidence, crop: v4.crop }, cases,
      context: "Fixed partial -006 primary with identical helper-filled omitted fields and features in all arms; only geometry changes.",
      limitations: ["Not reconstruction of full historical primary responses or a fresh live PNG.",
        "Different acquisitions/crops/derivative encodings; not a controlled localization-effect or provider-accuracy experiment.",
        "No manual recentering, measurement coercion, source-specific production rules or V4 activation."] }, null, 2), { flag: "wx" });
    expect(readFileSync(v3Path)).toEqual(v3Bytes); expect(readFileSync(v4Path)).toEqual(v4Bytes);
    expect(network).not.toHaveBeenCalled();
    console.info(`CURRENT_GEOMETRY_COMPARISON ${root}`);
  } finally { network.mockRestore(); }
}, 30_000);
