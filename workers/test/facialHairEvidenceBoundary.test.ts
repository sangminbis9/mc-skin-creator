// Offline regression. Synthetic cache branches are NOT reconstructed provider responses.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { wireFixture, namedGemmaFixture } from "./compactV3Support";
import { normalizeCompactPhotoAnalysisV2 } from "../src/compactPhotoAnalysis";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { adaptGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { buildFaceStyle, fallbackFeaturesToHex, normalizeAnalysisForRendering,
  refineFeatureColorsFromAnalysis } from "../src/generate";

const checkpoint = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-003/summary.json.checkpoint-000029.json";
const originalBytes = readFileSync(checkpoint);
const record = JSON.parse(originalBytes.toString("utf8"));
const saved = record.snapshot.currentDefaultE2E.result.diagnostics.normalizedPrimary;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_network_forbidden"); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(() => { expect(readFileSync(checkpoint)).toEqual(originalBytes); });

it("verifies the live evidence without pretending its normalized projection is raw provider output", () => {
  expect(hash(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
  expect(record.snapshot.currentDefaultE2E.httpStatus).toBe(200);
  expect(saved.observed.face).toMatch(/mustache and goatee/i);
  expect(saved.canonicalIdentity.mustPreserve.join(" ")).toMatch(/goatee and mustache/i);
  expect(saved.fallbackFeatures.facialHair).toBe("none");
  expect(record.snapshot.currentDefaultE2E.result.features.facialHair).toBe("none");
  const adapter = readFileSync("test/audit/currentDefaultE2E.ts", "utf8");
  expect(adapter).toContain("normalizedPrimary: null");
  expect(adapter).toContain("normalizeCompactPhotoAnalysisV3(compact");
  // Presence/absence of the original optional cache field was not captured.
  expect(saved).not.toHaveProperty("providerFallbackFeaturesPresence");
});

it.each(["omitted_object", "omitted_key", "none", "goatee", "mustache", "beard", "stubble"] as const)(
  "preserves corroborated evidence through optional-cache normalization: %s", mode => {
    // Only the already-saved source observations are reused. Other fields remain explicitly synthetic.
    const synthetic = makeAnalysis();
    synthetic.observed.face = saved.observed.face;
    synthetic.canonicalIdentity = structuredClone(saved.canonicalIdentity);
    const compact = wireFixture(synthetic);
    if (mode === "omitted_object") delete compact.fallbackFeatures;
    else if (mode === "omitted_key") delete compact.fallbackFeatures!.facialHair;
    else compact.fallbackFeatures!.facialHair = mode;
    const before = JSON.stringify(compact);
    const adapted = adaptGemmaNamedPhotoAnalysis(namedGemmaFixture(compact));
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error("synthetic_adapter_failed");
    expect(adapted.compact.fallbackFeatures).toEqual(compact.fallbackFeatures);
    const v2 = normalizeCompactPhotoAnalysisV2(adapted.compact);
    const v3 = normalizeCompactPhotoAnalysisV3(adapted.compact, { imageCount: 1 });
    expect(v2.ok).toBe(true); expect(v3.ok).toBe(true);
    if (!v2.ok || !v3.ok) throw new Error("synthetic_normalization_failed");
    expect(v3.analysis).toEqual(v2.analysis);
    expect(JSON.stringify(compact)).toBe(before);
    const expected = mode.startsWith("omitted_") || mode === "none" ? "goatee" : mode;
    expect(v3.analysis.fallbackFeatures.facialHair).toBe(expected);
    expect(v3.analysis.observed.face).toBe(saved.observed.face);
    expect(v3.analysis.canonicalIdentity).toEqual(saved.canonicalIdentity);
    const rendered = normalizeAnalysisForRendering(v3.analysis);
    const features = refineFeatureColorsFromAnalysis(rendered,
      fallbackFeaturesToHex(rendered.fallbackFeatures, rendered.renderHints.skinUndertone));
    expect(features.facialHair).toBe(expected);
    expect(buildFaceStyle(rendered, features).facialHair).toBe(expected);
  },
);
