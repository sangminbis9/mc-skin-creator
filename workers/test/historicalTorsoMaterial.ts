// Test-only bounded migration: preserve old exact atlas evidence while proving
// the new quiet torso cannot repaint a sleeve, face, print, boundary or alpha.
import { expect, vi } from "vitest";
import * as finish from "../src/referenceGarmentFinish";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { OutfitPlan } from "../src/outfitIdentity";
import type { RawImage } from "../src/png";

function oldPaints(plan: OutfitPlan) {
  return finish.referenceGarmentFoldPlan(plan).map(p => {
    if (p.part !== "body" || !["front", "back"].includes(p.face)) return p;
    expect([1, 6]).toContain(p.x);
    const ridge = p.x === 1;
    const dark = Math.max(...p.sourceColor) <= 64;
    return { ...p, x: ridge ? 3 : 4,
      color: dark ? p.sourceColor.map(v => ridge ? v + 16 : Math.round(v * 0.5)) as [number, number, number] : p.color };
  });
}
export function withHistoricalTorsoMaterial<T>(render: () => T): T {
  const spy = vi.spyOn(finish, "applyReferenceGarmentFinish").mockImplementation((atlas, plan) => {
    const changed = [];
    for (const p of oldPaints(plan)) {
      const r = CLASSIC_LAYOUT[p.part].base[p.face], i = ((r.y + p.y) * 64 + r.x + p.x) * 4;
      if (atlas.rgba[i + 3] !== 255 || p.sourceColor.some((v, ch) => atlas.rgba[i + ch] !== v)) continue;
      if (p.color.every((v, ch) => atlas.rgba[i + ch] === v)) continue;
      atlas.rgba.set(p.color, i); changed.push(p);
    }
    return changed;
  });
  try { return render(); } finally { spy.mockRestore(); }
}
export function assertTorsoMaterialBoundary(current: RawImage, old: RawImage, plan: OutfitPlan) {
  const allowed = new Map<number, Set<string>>();
  for (const p of [...finish.referenceGarmentFoldPlan(plan), ...oldPaints(plan)]) {
    if (p.part !== "body" || !["front", "back"].includes(p.face)) continue;
    const r = CLASSIC_LAYOUT.body.base[p.face], index = (r.y + p.y) * 64 + r.x + p.x;
    const colors = allowed.get(index) ?? new Set<string>();
    colors.add(p.sourceColor.join(",")); colors.add(p.color.join(",")); allowed.set(index, colors);
  }
  const changed = [];
  for (let i = 0; i < 4096; i++) {
    expect(current.rgba[i * 4 + 3], `torso alpha:${i}`).toBe(old.rgba[i * 4 + 3]);
    const a = Array.from(current.rgba.slice(i * 4, i * 4 + 3)).join(","), b = Array.from(old.rgba.slice(i * 4, i * 4 + 3)).join(",");
    if (a === b) continue;
    expect(allowed.get(i)?.has(a), `new unauthorized torso material:${i}`).toBe(true);
    expect(allowed.get(i)?.has(b), `old unauthorized torso material:${i}`).toBe(true);
    changed.push(i);
  }
  return changed;
}
