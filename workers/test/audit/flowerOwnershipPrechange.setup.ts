// Offline negative control only. Before bounded flowers, both flower and clip
// took exactly the same unresolved-region branch in this one pure resolver.
// Change only its local discriminant, not analysis, provider validation, paint
// style or caller data. Never imported by a production/live runner.
import { vi } from "vitest";
vi.mock("../../src/headOwnership", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/headOwnership")>();
  const resolve: typeof original.resolveHeadOwnership = (analysis, hair, face) =>
    original.resolveHeadOwnership(analysis.renderHints.hairAccessory === "flower"
      ? { ...analysis, renderHints: { ...analysis.renderHints, hairAccessory: "clip" } }
      : analysis, hair, face);
  return { ...original, resolveHeadOwnership: resolve };
});
