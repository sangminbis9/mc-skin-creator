import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CLASSIC_LAYOUT, type BodyPart, type BoxUV } from "../src/uvLayout";
import { validateReferenceStyleSurfaces, type StyledSurfaceCell } from "../src/referenceStyleConstraints";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { validatePairwiseReferenceSurfaces } from "./fixtures/referenceConstraintsPairwiseOracle";
import { freshAuditOutput } from "./freshAuditOutput";
import { makeAnalysis } from "./helpers";

function plan() {
  const a = makeAnalysis(); a.observed.hair = "long hair drapes over shoulders";
  a.renderHints.overallHairLength = "chest";
  return buildReferenceStylePlan(a);
}
const layers = ["base", "overlay"] as const;
const owners: StyledSurfaceCell["owner"][] = ["hair", "garment", "accessory", "covering", "face"];

it("matches the frozen pairwise oracle on dense valid surfaces and randomized ownership graphs", () => {
  const p = plan(), cells: StyledSurfaceCell[] = [];
  for (const part of Object.keys(CLASSIC_LAYOUT) as BodyPart[]) for (const layer of layers)
    for (const face of Object.keys(CLASSIC_LAYOUT[part][layer]) as (keyof BoxUV)[]) {
      const r = CLASSIC_LAYOUT[part][layer][face];
      // Numeric tuple slots must not alias adjacent faces, including x+1/y+1 probes.
      expect(r.w).toBeLessThan(16); expect(r.h).toBeLessThan(16);
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++)
        cells.push({ part, layer, face, x, y, owner: "hair", drapeGroup: face === "back" ? "rear_curtain" : "front_lock" });
    }
  const same = (input: StyledSurfaceCell[]) => {
    const before = JSON.stringify(input);
    expect(validateReferenceStyleSurfaces(input, p)).toEqual(validatePairwiseReferenceSurfaces(input, p));
    expect(JSON.stringify(input)).toBe(before);
  };
  // Dense graph covers all same-face, cross-layer, head/body, body/arm and
  // physical-seam connections. Source group and eligibility remain independent.
  same(cells); same([...cells].reverse());
  let state = 0x510d;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let sample = 0; sample < 160; sample++) {
    const input: StyledSurfaceCell[] = [];
    for (let i = 0; i < 200; i++) {
      const c = { ...cells[next() % cells.length], owner: owners[next() % owners.length] };
      const group = next() % 4;
      c.drapeGroup = group === 0 ? "" : group === 1 ? "rear_curtain" : group === 2 ? "front_lock" : "other_lock";
      input.push(c);
      if (next() % 13 === 0) input.push({ ...c, owner: "hair" });
      if (next() % 17 === 0) input.push({ ...c, x: -1 });
    }
    p.drape.eligible = sample % 2 === 0;
    p.drape.rearCompletion = sample % 3 === 0 ? "source_supported" : undefined;
    same(input);
  }
});

it("preserves reachable and broken locks for both sides, layers, and rear-curtain columns", () => {
  const p = plan(); p.drape.eligible = true; p.drape.rearCompletion = "source_supported";
  for (const headLayer of layers) for (const bodyLayer of layers) for (const armLayer of layers) {
    for (const x of [0, 7]) {
      const head: StyledSurfaceCell = { part: "head", face: "front", layer: "base", x, y: 7, owner: "hair", drapeGroup: "lock" };
      const root = { ...head, layer: headLayer }, body = { ...head, part: "body" as const, layer: bodyLayer, y: 0 };
      const arm = { ...body, part: x === 0 ? "rightArm" as const : "leftArm" as const, layer: armLayer, x: x === 0 ? 3 : 0 };
      for (const input of [[head, root, body, arm], [head, root, arm], [head, root, { ...body, drapeGroup: "different" }, arm]])
        expect(validateReferenceStyleSurfaces(input, p)).toEqual(validatePairwiseReferenceSurfaces(input, p));
    }
    for (let x = 0; x < 8; x++) {
      const h: StyledSurfaceCell = { part: "head", face: "back", layer: "base", x, y: 7, owner: "hair", drapeGroup: "rear_curtain" };
      const cells = [h, { ...h, layer: headLayer }, { ...h, part: "body" as const, layer: bodyLayer, y: 0 }];
      expect(validateReferenceStyleSurfaces(cells, p)).toEqual(validatePairwiseReferenceSurfaces(cells, p));
    }
  }
});

it("reduces pairwise coordinate reads without changing validation or depending on timing thresholds", () => {
  const p = plan(), source: StyledSurfaceCell[] = [];
  for (const layer of layers) for (let y = 0; y < 12; y++) for (let x = 0; x < 8; x++)
    source.push({ part: "body", face: "back", layer, x, y, owner: "hair", drapeGroup: "rear_curtain" });
  for (let x = 1; x <= 6; x++) source.push({ part: "head", face: "back", layer: "base", x, y: 7, owner: "hair", drapeGroup: "rear_curtain" });
  const run = (validate: typeof validateReferenceStyleSurfaces) => {
    let coordinateReads = 0;
    const input = source.map(c => ({ ...c, get x() { coordinateReads++; return c.x; }, get y() { coordinateReads++; return c.y; } }));
    const started = performance.now(), result = validate(input, p);
    return { result, coordinateReads, wallMs: performance.now() - started };
  };
  const before = run(validatePairwiseReferenceSurfaces), after = run(validateReferenceStyleSurfaces);
  expect(after.result).toEqual(before.result); expect(after.coordinateReads).toBeLessThan(before.coordinateReads / 4);
  const out = freshAuditOutput("evaluation-artifacts/reference-constraint-index-20261011-");
  writeFileSync(`${out}/summary.json`, JSON.stringify({ providerCalls: 0, vertices: source.length, before, after,
    note: "deterministic coordinate reads; timings are local only, not Worker CPU; validator predicates unchanged" }, null, 2), { flag: "wx" });
  console.info("CONSTRAINT_INDEX", out);
});
