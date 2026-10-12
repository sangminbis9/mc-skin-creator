import { expect, it } from "vitest";
import { boundedProjection } from "./audit/currentDefaultE2E";

it("preserves bounded normalized plan semantics without expanding raw-response permissions", () => {
  const text = "Visible hair forms a connected strand. ".repeat(10);
  const projected = boundedProjection({ observed: text, prompt: text, skinPlan: {
    hiddenSurfaces: [{ evidence: text, completion: text }],
    outfitPlan: { accessories: [{ evidence: text }] },
  } }) as { observed: string; prompt?: string; skinPlan: { hiddenSurfaces: {evidence: string; completion: string}[]; outfitPlan: {accessories: {evidence: string}[]} } };
  expect(projected.observed).toHaveLength(240);
  expect(projected.prompt).toBeUndefined();
  expect(projected.skinPlan.hiddenSurfaces[0]).toEqual({ evidence: text, completion: text });
  expect(projected.skinPlan.outfitPlan.accessories[0].evidence).toBe(text);
  expect(boundedProjection({ skinPlan: { hiddenSurfaces: [{ evidence: "Bearer example", completion: "data:image/png;base64,abc" }] } }))
    .toEqual({ skinPlan: { hiddenSurfaces: [{ evidence: "[redacted]", completion: "[redacted]" }] } });
  expect((boundedProjection({ skinPlan: { hiddenSurfaces: [{ evidence: text.repeat(4) }] } }) as typeof projected).skinPlan.hiddenSurfaces[0].evidence).toHaveLength(1024);
});
