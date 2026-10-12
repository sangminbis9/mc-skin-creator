import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { categoricalHeadwearBrowOcclusion } from "../src/headwearFootprint";
import { buildFacePixelPlanVariants, type FacePixelPlan } from "../src/identityPlans";
import { makeAnalysis } from "./helpers";

function savedFace(): FacePixelPlan {
  return JSON.parse(readFileSync("evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-020/summary.json", "utf8"))
    .currentDefaultE2E.result.propagationTrace.skinPlan.skinPlan.facePixelPlan;
}
it.each(["cap", "beanie"])("resolves only categorical brow paint covered by %s", hat => {
  const f = savedFace(), immutable = JSON.stringify(f);
  expect(categoricalHeadwearBrowOcclusion(hat, f.pixels, f.layout)).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 6, y: 1 }, { x: 5, y: 1 }]);
  expect(JSON.stringify(f)).toBe(immutable);
});
it.each(["none", "headscarf", "unknown", "hood"])("does not invent a footprint for %s", hat => {
  const f = savedFace(); expect(categoricalHeadwearBrowOcclusion(hat, f.pixels, f.layout)).toEqual([]);
});
it.each(["measured", "protected", "contract", "outside", "shared_iris", "invalid"])("retains brows for %s", reason => {
  const f = savedFace();
  if (reason === "measured") f.layout.geometryUsage.brows = true;
  if (reason === "protected") f.layout.protectedGeometry.push("eye_layout");
  if (reason === "contract") f.layout.renderContract.eyes!.protected = true;
  if (reason === "outside") f.pixels.filter(p => p.role === "brow").forEach(p => { p.y = 3; });
  if (reason === "shared_iris") f.pixels.push(...f.pixels.filter(p => p.role === "brow").map(p => ({ ...p, role: "iris" as const })));
  if (reason === "invalid") f.pixels.filter(p => p.role === "brow").forEach(p => { p.x += 0.5; });
  expect(categoricalHeadwearBrowOcclusion("beanie", f.pixels, f.layout)).toEqual([]);
});
it("integrates material occlusion into newly built plans without changing analysis or iris coordinates", () => {
  const a = makeAnalysis();
  a.fallbackFeatures.hat = "beanie";
  const unchanged = JSON.stringify(a);
  const noHat = structuredClone(a); noHat.fallbackFeatures.hat = "none";
  const visible = buildFacePixelPlanVariants(noHat, 1)[0], covered = buildFacePixelPlanVariants(a, 1)[0];
  expect(visible).toBeDefined(); expect(covered).toBeDefined();
  const expected = categoricalHeadwearBrowOcclusion("beanie", visible.pixels, visible.layout);
  expect(expected.length).toBeGreaterThan(0);
  expect(covered.headwearOccludedBrows).toEqual({ reason: "headwear_material_occlusion", cells: expected });
  expect(covered.pixels).toEqual(visible.pixels.filter(p => p.role !== "brow" || !expected.some(q => p.x === q.x && p.y === q.y)));
  expect(covered.layout).toEqual(visible.layout);
  expect(covered.candidateCost.violations).toEqual([]);
  expect(JSON.stringify(a)).toBe(unchanged);
});
