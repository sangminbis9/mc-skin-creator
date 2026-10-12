// Compare the former skin-only ranking with visible-boundary ranking offline.
// The legacy calculation is a historical diagnostic, not a production option.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import type { FaceStyle } from "../src/skinPack";
import { buildReferenceStylePlan, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const front = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
const at = (x: number, y: number, r = front) => ((r.y + y) * 64 + r.x + x) * 4;
function legacyContrast(atlas: RawImage, plan: SkinPlan) {
  const pixels = plan.facePixelPlan.pixels, landmarks = new Set(pixels.filter(p => p.cluster !== "complexion").map(p => `${p.x}:${p.y}`));
  const material = plan.headIdentityPlan.ownership?.cells.filter(p => p.layer === "base" && p.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(p.owner)) ?? [];
  const iris = pixels.filter(p => p.role === "iris");
  return iris.reduce((sum, p) => {
    if (atlas.rgba[at(p.x, p.y, outer) + 3]) return sum;
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }))
      .filter(q => q.x >= 0 && q.x < 8 && q.y >= 0 && q.y < 8 && !landmarks.has(`${q.x}:${q.y}`)
        && !material.some(c => c.x === q.x && c.y === q.y) && !atlas.rgba[at(q.x, q.y, outer) + 3]);
    return sum + (neighbors.length ? neighbors.reduce((s, q) => s + [0, 1, 2].reduce((d, ch) => d + Math.abs(atlas.rgba[at(p.x, p.y) + ch] - atlas.rgba[at(q.x, q.y) + ch]), 0), 0) / neighbors.length : 0);
  }, 0) / Math.max(1, iris.length);
}

it("removes the dark-eye ranking bias without moving landmarks, changing candidate paints or losing frozen identities", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const output = freshAuditOutput("evaluation-artifacts/eye-boundary-selection-20261010-");
    const liveBytes = readFileSync("evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-004/summary.json");
    expect(sha(liveBytes)).toBe("5a5589bfe40eee3780770f30c88960d434506b491817990dfc1d47d6ad60bbbe");
    const t = JSON.parse(liveBytes.toString()).currentDefaultE2E.result.propagationTrace;
    const contexts: Array<{ id: string; a: PhotoAnalysis; plan: SkinPlan; style: FaceStyle; baseline: RawImage; calibrated: boolean }> = [{
      id: "C004", a: { ...t.primary, ...t.renderAnalysis }, plan: t.skinPlan.skinPlan, style: t.injectedParameters.faceStyle,
      baseline: buildProceduralSourceAtlas(t.injectedParameters.features, t.injectedParameters.faceStyle, t.skinPlan.skinPlan)!, calibrated: false,
    }];
    const annotationBytes = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
    const fixtures: AnnotatedCase[] = JSON.parse(annotationBytes.toString());
    for (const f of fixtures) {
      const raw = strictBoundaryAnalysisFromAnnotation(f).analysis;
      if (f.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${f.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const a = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(a);
      const colors = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
      const style = buildFaceStyle(a, colors, plan.hairPlan);
      contexts.push({ id: f.id, a, plan, style, baseline: buildProceduralSourceAtlas(colors, style, plan)!, calibrated: !!f.existing });
    }
    const rows = [];
    for (const c of contexts) {
      const immutable = JSON.stringify([c.a, c.plan, c.style]), design = buildReferenceStylePlan(c.a);
      const now = selectReferenceStyleAtlas(c.baseline, c.plan, design, c.style);
      expect(now.selected, c.id).not.toBeNull();
      const current = now.selected!, candidates = [];
      for (const candidate of now.candidates.filter(p => p.quality?.constructionValid && p.foundation?.ok)) {
        const [f, h, o] = candidate.id.split("/");
        const choice: ReferenceStylePlan = { ...design, face: design.candidates.face.find(p => p.family === f)!,
          hair: design.candidates.hair.find(p => p.family === h)!, outfit: design.candidates.outfit.find(p => p.family === o)! };
        const composition = composeReferenceStyleAtlas(c.baseline, c.plan, choice, c.style), m = candidate.quality!.metrics;
        const oldContrast = legacyContrast(composition.atlas, c.plan);
        const oldScore = Math.round((Math.min(1, oldContrast / 255) * 30 + Math.min(1, m.irisToneSeparation / 384) * 6
          - Object.values(m.outerCoverage).reduce((s, n) => s + n, 0) * 12 - m.headTopCoverage * 12 - m.isolatedOuterPixels * 2
          - (choice.face.cost + choice.hair.cost + choice.outfit.cost) * 0.1) * 1000) / 1000;
        candidates.push({ id: candidate.id, choice, composition, oldContrast, oldScore, newScore: candidate.quality!.score });
      }
      candidates.sort((a, b) => b.oldScore - a.oldScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const old = candidates[0], before = old.composition.atlas, after = current.composition.atlas;
      expect(current.design.hair.family, c.id).toBe(old.choice.hair.family);
      expect(current.design.outfit.family, c.id).toBe(old.choice.outfit.family);
      const changes = [];
      for (let i = 0; i < 4096; i++) {
        expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
        if ([0, 1, 2].some(ch => after.rgba[i * 4 + ch] !== before.rgba[i * 4 + ch])) {
          const x = i % 64 - front.x, y = Math.floor(i / 64) - front.y;
          expect(x >= 0 && x < 8 && y >= 0 && y < 8, `${c.id}: face-only palette change`).toBe(true);
          expect(c.plan.headIdentityPlan.ownership?.cells.some(p => p.face === "front" && p.layer === "base" && p.x === x && p.y === y && ["hair_base", "covering", "tied_hair", "other_p5"].includes(p.owner))).toBe(false);
          changes.push({ x, y });
        }
      }
      const craft = validateReferenceAtlasCraft(after, c.baseline, c.plan, c.style, buildReferenceCraftPlan(c.plan, current.design, current.composition));
      expect(craft.ok, `${c.id}: ${craft.problems}`).toBe(true);
      expect((await decodePng(await encodePng(after))).rgba).toEqual(after.rgba);
      expect(JSON.stringify([c.a, c.plan, c.style])).toBe(immutable);
      if (c.id === "C004") {
        expect(old.choice.face.family).toBe("clean_masculine_soft"); expect(old.oldScore).toBe(24.015);
        expect(current.design.face.family).toBe("soft_feminine_doll");
        expect(changes).toHaveLength(11);
        const actual = await decodePng(readFileSync("evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-004/skin.png"));
        expect(before.rgba).toEqual(actual.rgba);
      } else {
        expect(changes, `${c.id}: unchanged frozen output`).toEqual([]);
      }
      for (const [name, atlas] of [["before", before], ["after", after]] as const) {
        const view = renderSkinViews(atlas).find(v => v.name === "front")!.image;
        writeFileSync(`${output}/${c.id}-${name}.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
      }
      rows.push({ id: c.id, calibrated: c.calibrated, beforeFace: old.choice.face.family, afterFace: current.design.face.family,
        changedFaceCells: changes, sourceUnchanged: true, hairOutfitUnchanged: true, craftPass: craft.ok,
        beforeRgba: sha(before.rgba), afterRgba: sha(after.rgba), candidates: candidates.map(p => ({ id: p.id, oldContrast: p.oldContrast, oldScore: p.oldScore, newScore: p.newScore })) });
    }
    expect(rows).toHaveLength(13); expect(rows.filter(r => r.calibrated)).toHaveLength(5);
    expect(network).not.toHaveBeenCalled();
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_ranking_comparison", providerCalls: 0,
      liveSummarySha256: sha(liveBytes), annotationSha256: sha(annotationBytes), rows }, null, 2), { flag: "wx" });
    console.info("EYE_BOUNDARY_SELECTION", output);
  } finally { network.mockRestore(); }
}, 180_000);
