import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { analysisProjection, boundedProjection } from "./audit/currentDefaultE2E";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import type { SkinPlan } from "../src/skinPlan";
import { decodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-012";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("identifies the exact historical ownership projection loss without guessing provider context", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const summaryBytes = readFileSync(`${root}/summary.json`), pngBytes = readFileSync(`${root}/skin.png`);
    const live = JSON.parse(summaryBytes.toString()).currentDefaultE2E.result;
    const primary = live.diagnostics.normalizedPrimary;
    const analysis = normalizeAnalysisForRendering(makeAnalysis({ ...primary, ...live.analysis,
      fallbackFeatures: primary.fallbackFeatures, identityPrompt: primary.observed.hair,
      outfitPrompt: primary.observed.clothing, negativePrompt: "" }));
    const stored = live.analysis.skinPlan as SkinPlan;
    const ownership = resolveHeadOwnership(analysis, stored.hairPlan, stored.facePixelPlan);
    // Resolver inputs for this non-tied/non-covering case are already stored:
    // observed/canonical evidence, fallbackFeatures, renderHints and hair/face plans.
    // No complete primary response or unsaved prompt is claimed to be recovered.
    expect(stored.headIdentityPlan.ownership!.cells).toHaveLength(512);
    expect(ownership.cells.slice(0, 512)).toEqual(stored.headIdentityPlan.ownership!.cells);
    expect({ ...ownership, cells: [] }).toEqual({ ...stored.headIdentityPlan.ownership, cells: [] });
    expect(ownership.cells.length).toBeGreaterThan(512);
    const restored = structuredClone(stored);
    restored.headIdentityPlan.ownership = ownership;
    const style = buildFaceStyle(analysis, live.features, stored.hairPlan);
    const truncatedAtlas = buildProceduralFallbackAtlas(live.features, style, stored)!;
    const completeAtlas = buildProceduralFallbackAtlas(live.features, style, restored)!;
    const actual = await decodePng(pngBytes);
    const differences = (rgba: Uint8Array) => Array.from({ length: 4096 }, (_, p) => p)
      .filter(p => [0, 1, 2, 3].some(c => rgba[p * 4 + c] !== actual.rgba[p * 4 + c]))
      .map(p => ({ x: p % 64, y: Math.floor(p / 64) }));
    const missingCells = ownership.cells.slice(512);
    const incompleteDiff = differences(truncatedAtlas.rgba), restoredDiff = differences(completeAtlas.rgba);
    const output = mkdtempSync("evaluation-artifacts/current-012-ownership-persistence-20260927-");
    const craft = validateAtlasCraft(completeAtlas, style, undefined, undefined, restored);
    writeFileSync(`${output}/diagnosis.json`, JSON.stringify({ providerCalls: 0,
      historicalSummarySha256: sha(summaryBytes), historicalPngSha256: sha(pngBytes),
      historicalOwnershipCells: 512, reconstructedOwnershipCells: ownership.cells.length,
      retainedPrefixExact: true, missingCells, incompleteDiff, restoredDiff,
      actualRgbaSha256: sha(actual.rgba), restoredRgbaSha256: sha(completeAtlas.rgba), craft,
      provenance: "Deterministic resolver replay from stored inputs, not recovered raw provider response." }, null, 2), { flag: "wx" });
    expect(incompleteDiff).toHaveLength(8);
    expect(restoredDiff).toHaveLength(0);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(completeAtlas).ok).toBe(true);
    expect(readFileSync(`${root}/summary.json`)).toEqual(summaryBytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(pngBytes);
    expect(network).not.toHaveBeenCalled();
    console.info(`OWNERSHIP_PERSISTENCE ${output}`);
    // The audit projection, not the production renderer, must retain this plan.
    const projected = analysisProjection({ skinPlan: restored }) as { skinPlan: SkinPlan };
    expect(projected.skinPlan.headIdentityPlan.ownership).toEqual(ownership);
  } finally { network.mockRestore(); }
}, 30_000);

it("keeps general arrays bounded and redacts secrets in ownership data", () => {
  expect(boundedProjection(Array.from({ length: 900 }, (_, i) => i))).toHaveLength(512);
  const projected = analysisProjection({ skinPlan: { headIdentityPlan: { ownership: {
    cells: Array.from({ length: 900 }, (_, i) => ({ x: i % 8, sourceGroupId: "Bearer secret", token: "forbidden" })),
  } } }, raw: "forbidden", identityPrompt: "forbidden" }) as { skinPlan: { headIdentityPlan: { ownership: { cells: unknown[] } } } };
  expect(projected.skinPlan.headIdentityPlan.ownership.cells).toHaveLength(768);
  expect(projected.skinPlan.headIdentityPlan.ownership.cells[767]).toEqual({ x: 7, sourceGroupId: "[redacted]" });
  expect(JSON.stringify(projected)).not.toContain("forbidden");
});
