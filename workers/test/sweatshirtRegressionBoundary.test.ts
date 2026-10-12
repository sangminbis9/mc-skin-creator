// Read-only diagnosis of a pre-existing historical plan pin failure.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildSkinPlan } from "../src/skinPlan";
import { normalizeAnalysisForRendering } from "../src/generate";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { historicalHairMaterialPlan } from "./historicalHairMaterial";

it("locates the historical warm-white plan drift independently of the sweatshirt noun", () => {
  const annotations: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const fixture = annotations.find(f => f.id === "warm-white-tee")!;
  const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
  if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
  const current = historicalHairMaterialPlan(buildSkinPlan(normalizeAnalysisForRendering(raw)));
  const old = JSON.parse(readFileSync("evaluation-artifacts/eye-axis-retention-20260927-RSxnwB/results.json", "utf8")).cases.find((r: { id: string }) => r.id === fixture.id).plan;
  expect(JSON.stringify(raw)).not.toMatch(/sweatshirt/i);
  const diffs: Array<{ path: string; before: unknown; after: unknown }> = [];
  function compare(a: unknown, b: unknown, path: string) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object") {
      const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) compare(x[k], y[k], `${path}.${k}`);
    } else diffs.push({ path, before: a, after: b });
  }
  compare(old, JSON.parse(JSON.stringify(current)), "plan");
  console.info("HISTORICAL_PLAN_DRIFT", JSON.stringify(diffs));
  expect(diffs).toEqual([
    { path: "plan.outfitPlan.accessories.0.color", before: "#77777c", after: "#684b38" },
    { path: "plan.outfitPlan.provenance.6", before: undefined,
      after: { target: "accessories.belt.color", source: "observed", evidence: "brown belt", confidence: 0.9 } },
  ]);
});
