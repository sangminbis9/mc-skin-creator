import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import type { SkinPlan } from "../src/skinPlan";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { validateFinalAtlas } from "../src/skinPost";
import type { HairStructureRole } from "../src/headStructure";

// Rejected aesthetic candidate, intentionally test-only. Connected role ramps
// avoid pixel noise but visual inspection does not establish a quality gain.
// Never activated by the production style builder or provider contract.
function candidateColor(role: HairStructureRole | undefined, hair: [number, number, number]) {
  const factor = role === "shadow" || role === "tip" || role === "part_shadow" ? 0.78
    : role === "light" || role === "part_light" ? 1.08 : 0.96;
  return hair.map(v => Math.min(255, Math.max(0, Math.round(v * factor))));
}
function roleRampCandidate(before: ReturnType<typeof composeReferenceStyleAtlas>, plan: SkinPlan, hair: [number, number, number]) {
  const material = structuredClone(before);
  const cells = material.diagnostic.surfaces.filter(c => c.part === "head" && c.layer === "overlay" && c.owner === "hair");
  const key = (c: { face: string; x: number; y: number }) => `outer:${c.face}:${c.x},${c.y}`;
  const sourceRoles = new Map(plan.headIdentityPlan.ownership!.cells.filter(c => c.layer === "base" && c.owner === "hair_base").map(c => [key(c), c.role]));
  const colors = new Map(cells.map(c => [key(c), candidateColor(sourceRoles.get(key(c)), hair)]));
  // Use the saved plan's physical seam groups, not independent face sampling.
  const ordered = [...cells].sort((a, b) => ["front", "right", "left", "back", "top", "bottom"].indexOf(a.face) - ["front", "right", "left", "back", "top", "bottom"].indexOf(b.face) || a.y - b.y || a.x - b.x);
  for (const group of plan.headIdentityPlan.ownership!.continuities) {
    const seed = ordered.find(c => group.cells.includes(key(c)));
    if (!seed) continue;
    for (const k of group.cells) if (colors.has(k)) colors.set(k, colors.get(key(seed))!);
  }
  for (const c of cells) {
    const r = CLASSIC_LAYOUT.head.overlay[c.face], i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
    material.atlas.rgba.set(colors.get(key(c))!, i);
  }
  return material;
}

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("records the material boundary on the exact saved F004 plan without a provider request", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-004";
    const bytes = readFileSync(`${sourceRoot}/summary.json`);
    expect(sha(bytes)).toBe("185d2388a2d7343d54d8d11cfc32dd5e04506c9fc61869411c88257fbddfe918");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const plan: SkinPlan = t.skinPlan.skinPlan, style = t.injectedParameters.faceStyle;
    const immutable = JSON.stringify(plan);
    const baseline = buildProceduralSourceAtlas(t.injectedParameters.features, style, plan)!;
    const composed = composeReferenceStyleAtlas(baseline, plan, t.referenceStyle.design, style);
    expect(sha(composed.atlas.rgba)).toBe("172f1f5cb4d9284a2ad5a648b534f1ea71eb83c2738ba39716cd2365d816ad31");
    expect(validateReferenceAtlasCraft(composed.atlas, baseline, plan, style, buildReferenceCraftPlan(plan, t.referenceStyle.design, composed)).ok).toBe(true);
    const hair = [1, 3, 5].map(i => Number.parseInt(style.hairColor.slice(i, i + 2), 16)) as [number, number, number];
    const material = roleRampCandidate(composed, plan, hair);
    const root = freshAuditOutput("evaluation-artifacts/reference-hair-accent-material-audit-20261011-");
    const cells = composed.diagnostic.surfaces.filter(c => c.part === "head" && c.layer === "overlay" && c.owner === "hair").map(c => {
      const r = CLASSIC_LAYOUT.head.overlay[c.face], i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      const p = plan.headIdentityPlan.ownership!.cells.find(p => p.layer === "outer" && p.face === c.face && p.x === c.x && p.y === c.y)!;
      return { face: c.face, x: c.x, y: c.y, group: p.sourceGroupId, role: p.role,
        baseline: [...baseline.rgba.slice(i, i + 4)], composed: [...composed.atlas.rgba.slice(i, i + 4)] };
    });
    const front = cells.filter(c => c.face === "front");
    const baselineColors = [...new Set(front.map(c => c.baseline.join(":")))];
    const composedColors = [...new Set(front.map(c => c.composed.join(":")))];
    const materialColors = [...new Set(material.diagnostic.surfaces.filter(c => c.part === "head" && c.face === "front" && c.owner === "hair" && c.layer === "overlay").map(c => {
      const r = CLASSIC_LAYOUT.head.overlay.front, i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
      return [...material.atlas.rgba.slice(i, i + 3)].join(":");
    }))];
    expect(baselineColors.length).toBeGreaterThan(3); expect(composedColors).toHaveLength(1);
    expect(materialColors.length).toBeGreaterThan(1); expect(materialColors.length).toBeLessThanOrEqual(3);
    expect(material.diagnostic.surfaces).toEqual(composed.diagnostic.surfaces);
    let changed = 0;
    const allowed = new Set(material.diagnostic.surfaces.filter(c => c.part === "head" && c.layer === "overlay" && c.owner === "hair").map(c => {
      const r = CLASSIC_LAYOUT.head.overlay[c.face]; return (r.y + c.y) * 64 + r.x + c.x;
    }));
    for (let i = 0; i < 4096; i++) {
      expect(material.atlas.rgba[i * 4 + 3]).toBe(composed.atlas.rgba[i * 4 + 3]);
      if ([0, 1, 2].some(ch => material.atlas.rgba[i * 4 + ch] !== composed.atlas.rgba[i * 4 + ch])) {
        changed++; expect(allowed.has(i)).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(0);
    expect(validateFinalAtlas(material.atlas).ok).toBe(true);
    const materialCraft = validateReferenceAtlasCraft(material.atlas, baseline, plan, style, buildReferenceCraftPlan(plan, t.referenceStyle.design, material));
    // The test-only recolor is NOT the current production paint contract.
    // Keep the validator authoritative; do not rewrite diagnostics to make it pass.
    expect(materialCraft.ok).toBe(false);
    expect(materialCraft.problems).toEqual(["paint_contract_mismatch:hair"]);
    expect(materialCraft.foundation!.ok).toBe(true);
    expect(roleRampCandidate(composed, plan, hair).atlas.rgba).toEqual(material.atlas.rgba);
    for (const [name, atlas] of [["baseline", baseline], ["composed", composed.atlas], ["source-ramp", material.atlas]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, summarySha: sha(bytes), providerCalls: 0,
      baselineColors, composedColors, materialColors, changedOwnedOuterCells: changed,
      beforeHash: sha(composed.atlas.rgba), materialHash: sha(material.atlas.rgba), productionCraftPass: true,
      candidateCraftPass: materialCraft.ok, candidateCraftErrors: materialCraft.problems, atlasPass: true,
      candidateStatus: "REJECTED_NOT_PRODUCTION", reason: "broad shade blocks; no verified visual quality gain",
      cells, sourcePlanUnchanged: JSON.stringify(plan) === immutable }, null, 2), { flag: "wx" });
    expect(JSON.stringify(plan)).toBe(immutable); expect(network).not.toHaveBeenCalled();
    console.info("HAIR_ACCENT_MATERIAL_AUDIT", root, JSON.stringify({ baselineColors, composedColors, front }));
  } finally { network.mockRestore(); }
});

it("bounds the rejected authored palette without rewriting source color", () => {
  expect(candidateColor("shadow", [154, 154, 154])).toEqual([120, 120, 120]);
  expect(candidateColor("mid", [154, 154, 154])).toEqual([148, 148, 148]);
  expect(candidateColor("light", [154, 154, 154])).toEqual([166, 166, 166]);
  expect(candidateColor("mid", [0, 0, 0])).toEqual([0, 0, 0]);
  expect(candidateColor("mid", [60, 30, 20])).toEqual([58, 29, 19]);
});
