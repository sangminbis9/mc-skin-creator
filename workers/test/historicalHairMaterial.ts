/** Test-only migration boundary. Never used by production or to rewrite history.
 * Old exact hashes include the intentionally removed horizontal foundation bands.
 * Reverse ONLY that material edit, assert the new roles, then retain old hash checks.
 */
import { expect, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas, type ReferenceCompositionResult } from "../src/referenceStyleRenderer";
import { FACE_STYLE_TEMPLATES, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import * as faceFinish from "../src/referenceFaceFinish";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import type { RawImage } from "../src/png";
import { assertTorsoMaterialBoundary, withHistoricalTorsoMaterial } from "./historicalTorsoMaterial";

const ids = new Set(["foundation-left", "foundation-right", "foundation-back"]);

/** Synchronous historical replay only. Reproduce the pre-calm-neutral mouth
 * preference without changing source identity, validators or historical PNGs.
 * Current output must be rendered after this scoped preference is restored.
 */
export function withHistoricalCalmMouth<T>(render: () => T): T {
  const template = FACE_STYLE_TEMPLATES.soft_feminine_calm as { mouthCells: number };
  const current = template.mouthCells;
  expect(current).toBe(0);
  template.mouthCells = 2;
  try { return render(); } finally { template.mouthCells = current; }
}

/** Historical compositor only: reproduce the former two-cell paint budget.
 * Never validate this projection as current output. Only the finisher receives
 * a clone with the width-retention branch disabled; the actual source plan,
 * presentation choice, expression and production validators remain intact.
 * The frozen exact hash below still detects any unrelated delta.
 */
export function withHistoricalMouthBudget<T>(render: () => T): T {
  const actual = faceFinish.applyReferenceFaceFinish;
  const spy = vi.spyOn(faceFinish, "applyReferenceFaceFinish").mockImplementation((atlas, pixels, design, ...rest) => {
    const contract = pixels.renderContract.mouth;
    const budget = Math.max(2, FACE_STYLE_TEMPLATES[design.face.family].mouthCells);
    if (!contract || contract.minimumPerceptualWidth <= budget
      || faceFinish.referenceMouthPresentation(pixels, design, rest[2], rest[1]) === "omit_neutral")
      return actual(atlas, pixels, design, ...rest);
    expect(budget).toBe(2);
    const projected = { ...pixels, renderContract: { ...pixels.renderContract, mouth: { ...contract, minimumPerceptualWidth: 2 as const } } };
    expect(faceFinish.referenceMouthPresentation(projected, design, rest[2], rest[1])).toBe("retain_source");
    return actual(atlas, projected, design, ...rest);
  });
  try { return render(); } finally { spy.mockRestore(); }
}

export function assertRetainedMouthBoundary(current: RawImage, old: RawImage, plan: SkinPlan) {
  const contract = plan.facePixelPlan.renderContract.mouth;
  const front = CLASSIC_LAYOUT.head.base.front;
  const allowed = new Set(contract && contract.minimumPerceptualWidth > 2
    ? plan.facePixelPlan.pixels.filter(p => p.cluster === "mouth" && p.role === "lip")
      .map(p => (front.y + p.y) * 64 + front.x + p.x) : []);
  const changed = [];
  for (let i = 0; i < 4096; i++) {
    expect(current.rgba[i * 4 + 3], `mouth alpha:${i}`).toBe(old.rgba[i * 4 + 3]);
    if (![0, 1, 2].some(ch => current.rgba[i * 4 + ch] !== old.rgba[i * 4 + ch])) continue;
    expect(allowed.has(i), `non-retained-mouth changed:${i}`).toBe(true);
    changed.push(i);
  }
  return changed;
}
export function historicalHairMaterialPlan(current: SkinPlan): SkinPlan {
  const old = structuredClone(current);
  if (!["straight_bands", "wavy_bands"].includes(old.hairPlan.structure.grammar)) return old;
  for (const group of old.hairPlan.structure.groups) if (group.kind === "foundation" && ids.has(group.id)) {
    for (const p of group.points) {
      expect(p.layer).toBe("base");
      expect(p.role).toBe(p.x === 0 || p.x === 7 ? "shadow" : "mid");
      p.role = p.y % 3 === 0 ? "mid" : "shadow";
    }
  }
  for (const c of old.headIdentityPlan.ownership?.cells ?? []) if (c.owner === "hair_base" && c.layer === "base" && ids.has(c.sourceGroupId ?? "")) {
    expect(c.role).toBe(c.x === 0 || c.x === 7 ? "shadow" : "mid");
    c.role = c.y % 3 === 0 ? "mid" : "shadow";
  }
  return old;
}

export function assertHairMaterialPixelBoundary(current: RawImage, historical: RawImage, plan: SkinPlan) {
  const allowed = new Set<number>();
  if (["straight_bands", "wavy_bands"].includes(plan.hairPlan.structure.grammar)) {
    for (const c of plan.headIdentityPlan.ownership?.cells ?? []) {
      if (c.owner !== "hair_base" || c.layer !== "base" || !ids.has(c.sourceGroupId ?? "")
        || c.role === (c.y % 3 === 0 ? "mid" : "shadow")) continue;
      const r = CLASSIC_LAYOUT.head.base[c.face];
      allowed.add((r.y + c.y) * 64 + r.x + c.x);
    }
    // Existing reconcileBaseHorizontalSeams copies visible edge material to
    // the touching top/underside perimeter before the final ownership replay.
    // License only the exact partners of changed foundation cells, never an
    // entire extra face or an arbitrary non-hair region.
    const foundation = new Set(allowed);
    for (const seam of getBoxUvSeams(CLASSIC_LAYOUT.head.base).horizontal)
      seam.primary.forEach((p, index) => {
        if (foundation.has(p.y * 64 + p.x)) {
          const q = seam.adjacent[index]; allowed.add(q.y * 64 + q.x);
        }
      });
  }
  const changedPixels = [];
  for (let i = 0; i < 4096; i++) {
    expect(current.rgba[i * 4 + 3], `material cannot change alpha:${i}`).toBe(historical.rgba[i * 4 + 3]);
    if (![0, 1, 2].some(ch => current.rgba[i * 4 + ch] !== historical.rgba[i * 4 + ch])) continue;
    expect(allowed.has(i), `non-foundation material changed:${i}`).toBe(true);
    changedPixels.push(i);
  }
  return changedPixels;
}

export function historicalHairMaterialReplay(
  features: Parameters<typeof buildProceduralSourceAtlas>[0], style: FaceStyle,
  plan: SkinPlan, design: ReferenceStylePlan, current: ReferenceCompositionResult,
) {
  const original = JSON.stringify(plan);
  const oldPlan = historicalHairMaterialPlan(plan);
  const currentBaseline = buildProceduralSourceAtlas(features, style, plan)!;
  expect(measureReferenceRenderedQuality(current, currentBaseline, plan, design, style).violations).toEqual([]);
  const baseline = buildProceduralSourceAtlas(features, style, oldPlan)!;
  expect(baseline).toBeTruthy();
  const composition = composeReferenceStyleAtlas(baseline, oldPlan, design, style);
  const changedPixels = assertHairMaterialPixelBoundary(current.atlas, composition.atlas, plan);
  // Structure, ownership and finish decisions cannot change with paint roles.
  expect(current.diagnostic.surfaces).toEqual(composition.diagnostic.surfaces);
  expect(current.diagnostic.faceFinish).toEqual(composition.diagnostic.faceFinish);
  expect(JSON.stringify(plan)).toBe(original);
  const historical = withHistoricalTorsoMaterial(() => composeReferenceStyleAtlas(baseline, oldPlan, design, style));
  const torsoMaterialPixels = assertTorsoMaterialBoundary(composition.atlas, historical.atlas, oldPlan.outfitPlan);
  const beforeMouthFix = withHistoricalMouthBudget(() => withHistoricalTorsoMaterial(() => composeReferenceStyleAtlas(baseline, oldPlan, design, style)));
  const retainedMouthPixels = assertRetainedMouthBoundary(historical.atlas, beforeMouthFix.atlas, oldPlan);
  expect(JSON.stringify(plan)).toBe(original);
  return { plan: oldPlan, baseline, composition: beforeMouthFix, changedPixels, torsoMaterialPixels, retainedMouthPixels };
}
