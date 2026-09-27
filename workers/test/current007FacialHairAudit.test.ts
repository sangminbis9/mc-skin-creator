import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import type { FaceStyle } from "../src/skinPack";
import type { SkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const livePath = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-007/summary.json";
const stylePath = "evaluation-artifacts/qualified-cropped-hair-20260927-trMIMa/results.json";
const sample = (image: RawImage, p: { x: number; y: number }) => Array.from(image.rgba.slice(((p.y + 8) * 64 + p.x + 8) * 4, ((p.y + 8) * 64 + p.x + 8) * 4 + 4));

it("audits actual -007 and current facial-hair delivery without changing categories or saving provider output", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const liveBytes = readFileSync(livePath), styleBytes = readFileSync(stylePath);
    const live = JSON.parse(liveBytes.toString()).currentDefaultE2E;
    const result = live.result, primary = result.diagnostics.normalizedPrimary;
    const frozenStyle: FaceStyle = JSON.parse(styleBytes.toString()).style;
    const actualBytes = readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-007/skin.png");
    const actual = await decodePng(actualBytes);
    expect(sha(actualBytes)).toBe(live.png.sha256);
    expect(primary.fallbackFeatures.facialHair).toBe("goatee");
    expect(result.features.facialHair).toBe("goatee");
    expect(frozenStyle).toMatchObject({ facialHair: "goatee", goateeHasMustache: true });
    const partial = normalizeAnalysisForRendering(makeAnalysis({ ...primary,
      identityPrompt: primary.observed.hair, outfitPrompt: primary.observed.clothing }));
    const currentPlan = buildSkinPlan(partial);
    const currentStyle = buildFaceStyle(partial, result.features, currentPlan.hairPlan);
    const subjects: Array<{ id: string; plan: SkinPlan; style: FaceStyle }> = [
      { id: "frozen-live-plan-context", plan: result.analysis.skinPlan, style: frozenStyle },
      { id: "current-qualified-crop-context", plan: currentPlan, style: currentStyle },
    ];
    const root = mkdtempSync("evaluation-artifacts/current-007-facial-hair-audit-20260927-");
    const cases = [];
    for (const subject of subjects) {
      const points = facialHairBaseFootprint(subject.style);
      expect(points).toEqual([{ x: 2, y: 5 }, { x: 5, y: 5 }, { x: 3, y: 7 }, { x: 4, y: 7 }]);
      const variants = [
        { id: "combined", facialHair: "goatee", goateeHasMustache: true },
        { id: "chin-only", facialHair: "goatee", goateeHasMustache: false },
        { id: "none", facialHair: "none", goateeHasMustache: false },
        // Diagnostic comparison only, never promoted to production source evidence.
        { id: "beard-counterfactual", facialHair: "beard", goateeHasMustache: false },
      ];
      const runs = [];
      for (const variant of variants) {
        const style = { ...subject.style, facialHair: variant.facialHair, goateeHasMustache: variant.goateeHasMustache };
        const stages: Array<{ stage: string; points: number[][] }> = [];
        const atlas = buildProceduralFallbackAtlas(result.features, style, subject.plan,
          (stage, image) => stages.push({ stage, points: points.map(p => sample(image, p)) }));
        expect(atlas).not.toBeNull(); if (!atlas) throw new Error("audit_atlas_rejected");
        const craft = validateAtlasCraft(atlas, style, subject.plan.facePixelPlan, subject.plan.hairPlan, subject.plan);
        expect(craft.ok, craft.problems.join(";")).toBe(true); expect(validateFinalAtlas(atlas).ok).toBe(true);
        writeFileSync(`${root}/${subject.id}-${variant.id}.png`, await encodePng(atlas), { flag: "wx" });
        const head = extractRenderedHeadView(renderSkinViews(atlas).find(v => v.name === "front")!);
        writeFileSync(`${root}/${subject.id}-${variant.id}-head.png`, await encodePng(scaleNearestNeighbor(head, 256, 256)), { flag: "wx" });
        runs.push({ variant: variant.id, atlas, stages, craft, hash: sha(atlas.rgba) });
      }
      const combined = runs[0], none = runs[2];
      const cells = points.map((point, i) => ({ ...point,
        actual: sample(actual, point), enabled: sample(combined.atlas, point), disabled: sample(none.atlas, point),
        actualMatchesEnabled: JSON.stringify(sample(actual, point)) === JSON.stringify(sample(combined.atlas, point)),
        retainedAtFinal: JSON.stringify(sample(combined.atlas, point)) !== JSON.stringify(sample(none.atlas, point)),
        stages: combined.stages.map((s, n) => ({ stage: s.stage, differsFromNoHair: JSON.stringify(s.points[i]) !== JSON.stringify(none.stages[n].points[i]) })) }));
      expect(cells.every(c => c.retainedAtFinal)).toBe(true);
      expect(cells.every(c => c.actualMatchesEnabled)).toBe(true);
      expect(cells.every(c => c.stages.length > 0 && c.stages.every(s => s.differsFromNoHair))).toBe(true);
      const changedByBeard = [];
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => combined.atlas.rgba[p * 4 + c] !== runs[3].atlas.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64); changedByBeard.push({ x, y }); expect(y).toBeLessThan(16);
      }
      cases.push({ id: subject.id, cells, changedByBeard,
        runs: runs.map(run => ({ variant: run.variant, stages: run.stages, craft: run.craft, hash: run.hash, width: 64, height: 64 })) });
    }
    const report = { providerCalls: 0, sourceSummarySha256: sha(liveBytes), actualPngSha256: sha(actualBytes), cases,
      currentHairFix: { surfaceOnly: currentPlan.hairPlan.surfaceOnly, style: currentStyle.hairstyle },
      primaryEvidence: { facialHair: primary.fallbackFeatures.facialHair, observedFace: primary.observed.face,
        sleeveLength: primary.fallbackFeatures.sleeveLength, observedClothing: primary.observed.clothing },
      geometry: result.diagnostics.geometry,
      limitation: "Partial stored context; no recovered raw response. Beard counterfactual is not a source annotation or a production fix." };
    writeFileSync(`${root}/results.json`, JSON.stringify(report, null, 2), { flag: "wx" });
    expect(readFileSync(livePath)).toEqual(liveBytes); expect(readFileSync(stylePath)).toEqual(styleBytes);
    expect(network).not.toHaveBeenCalled();
    console.info(`CURRENT_007_FACIAL_HAIR_AUDIT ${root}`);
  } finally { network.mockRestore(); }
}, 30_000);
