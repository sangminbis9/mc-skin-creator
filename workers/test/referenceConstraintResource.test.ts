import { afterEach, expect, it, vi } from "vitest";
import * as uv from "../src/uvLayout";
import { validateReferenceStyleSurfaces, type StyledSurfaceCell } from "../src/referenceStyleConstraints";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { makeAnalysis } from "./helpers";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const a = makeAnalysis(); a.observed.hair = "long hair drapes over shoulders";
  a.renderHints.overallHairLength = "chest";
  const plan = buildReferenceStylePlan(a);
  const root: StyledSurfaceCell = { part: "head", face: "front", layer: "base", x: 7, y: 7, owner: "hair", drapeGroup: "left_lock" };
  const body: StyledSurfaceCell = { ...root, part: "body", y: 0 };
  const arm: StyledSurfaceCell = { ...body, part: "leftArm", layer: "overlay", x: 0 };
  return { plan, root, body, arm };
}

it("builds no seam arrays without valid named-hair vertices, but still rejects invalid ownership", () => {
  const b = fixture(), spy = vi.spyOn(uv, "getBoxUvSeams");
  expect(validateReferenceStyleSurfaces([], b.plan).ok).toBe(true);
  expect(validateReferenceStyleSurfaces([{ ...b.body, drapeGroup: undefined }], b.plan).violations).toContain("hair_drape_disconnected");
  expect(validateReferenceStyleSurfaces([{ ...b.root, x: 8 }], b.plan).violations).toContain("surface_coordinate_invalid");
  expect(validateReferenceStyleSurfaces([{ ...b.body, owner: "garment" }], b.plan).ok).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});

it("visits exactly the occupied part/layers without caching source or validation results", () => {
  const b = fixture(), spy = vi.spyOn(uv, "getBoxUvSeams");
  const cells = [b.root, b.body, b.arm], original = JSON.stringify(cells);
  const result = validateReferenceStyleSurfaces(cells, b.plan);
  expect(result.ok).toBe(true);
  expect(spy.mock.calls.map(([box]) => box)).toEqual([uv.CLASSIC_LAYOUT.head.base, uv.CLASSIC_LAYOUT.body.base, uv.CLASSIC_LAYOUT.leftArm.overlay]);
  result.violations.push("caller_mutation");
  expect(validateReferenceStyleSurfaces(cells, b.plan).violations).toEqual([]);
  expect(validateReferenceStyleSurfaces([b.root, b.arm], b.plan).violations).toContain("hair_drape_disconnected");
  expect(JSON.stringify(cells)).toBe(original);
});

it("retains physical seam and group boundaries instead of accepting a merely matching label", () => {
  const b = fixture();
  const front = { ...b.body, x: 7 }, side: StyledSurfaceCell = { ...front, face: "left", x: 0 };
  expect(validateReferenceStyleSurfaces([b.root, front, side], b.plan).ok).toBe(true);
  expect(validateReferenceStyleSurfaces([b.root, { ...front, drapeGroup: "unrelated" }, side], b.plan).violations).toContain("hair_drape_disconnected");
  expect(validateReferenceStyleSurfaces([b.root, { ...front, owner: "garment" }, side], b.plan).violations).toContain("hair_drape_disconnected");
  expect(validateReferenceStyleSurfaces([b.root, front, { ...side, x: 2 }], b.plan).violations).toContain("hair_drape_disconnected");
});
