import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ANALYSIS_PROMPT } from "../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_V2_PROMPT } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, adaptGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { semanticFixture, wireFixture, namedGemmaFixture } from "./compactV3Support";

const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-033";
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("preserves observed scalp/palette strings through both provider adapters (explicit=%s)", explicit => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  // Synthetic contract controls, not reconstructed or newly measured live data.
  const a = semanticFixture("plain");
  a.observed.hair = explicit ? "Shaved head with visible very short stubble." : "Very short cropped black hair.";
  a.observed.clothing = explicit ? "Navy, tan and teal striped shirt." : "Navy and tan striped shirt.";
  a.observed.colorPalette = explicit ? ["navy", "tan", "teal", "black"] : ["navy", "tan", "black"];
  const wire = wireFixture(a), adapted = adaptGemmaNamedPhotoAnalysis(namedGemmaFixture(wire));
  expect(adapted.ok).toBe(true);
  if (!adapted.ok) throw new Error("synthetic_adaptation_failed");
  for (const input of [wire, adapted.compact]) {
    const before = structuredClone(input), normalized = normalizeCompactPhotoAnalysisV3(input, { imageCount: 1 });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error("synthetic_normalization_failed");
    expect(normalized.analysis.observed).toEqual(a.observed);
    expect(input).toEqual(before);
  }
  expect(network).not.toHaveBeenCalled();
});

it("audits retained 033 face cues and marks the historical localization subtype unrecoverable", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
  const r = JSON.parse(bytes.toString()).currentDefaultE2E.result;
  const primary = r.diagnostics.normalizedPrimary, plan = r.analysis.skinPlan;
  const cues = primary.faceMeasurementEvidence.cues;
  expect(Object.keys(cues)).toHaveLength(8);
  for (const [cue, evidence] of Object.entries(cues)) {
    expect(plan.facePixelPlan.layout.measurementTrace[cue]).toMatchObject({
      ...(evidence as object), selected: "categorical_grammar",
    });
  }
  expect(Object.values(plan.facePixelPlan.layout.geometryUsage).every(v => v === false)).toBe(true);
  expect(primary.sourceSelection.portraitRegion).toBeNull();
  expect(r.diagnostics.geometry).toBeNull();
  expect(plan.hairPlan).toMatchObject({ surfaceOnly: true, lengthClass: "short" });
  expect(plan.hairPlan.surfaceMaterial).toBeUndefined();
  const preservedIdentityEvidence = JSON.stringify({ observed: primary.observed, canonicalIdentity: primary.canonicalIdentity });
  expect(preservedIdentityEvidence).not.toMatch(/teal|turquoise|visible scalp|scalp (?:is )?visible|stubble/i);
  // Do not mistake the old post-normalization diagnostic for the raw suffix.
  const previous = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260928-031/summary.json", "utf8"))
    .currentDefaultE2E.result;
  expect(previous.diagnostics.normalizedPrimary.sourceSelection.portraitRegion).not.toBeNull();
  expect(previous.diagnostics.localization.status).toBe("MISSING");

  expect(COMPACT_PHOTO_ANALYSIS_V2_PROMPT.startsWith(ANALYSIS_PROMPT)).toBe(true);
  expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT.startsWith(ANALYSIS_PROMPT)).toBe(true);
  expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT.startsWith(COMPACT_PHOTO_ANALYSIS_V3_PROMPT)).toBe(true);
  expect(ANALYSIS_PROMPT).toContain("root/scalp part visibility");
  expect(ANALYSIS_PROMPT).toContain("describe garment type, colors and general patterns");
  expect(ANALYSIS_PROMPT).toContain(" | REGION:[subject L,T,R,B,head L,T,R,B,face L,T,R,B,confidence]");
  const out = mkdtempSync("evaluation-artifacts/current-033-remaining-evidence-20260928-");
  writeFileSync(`${out}/verification.json`, JSON.stringify({ providerCalls: 0,
    summarySha256: hash(bytes), pngSha256: hash(png), retainedFaceCues: Object.keys(cues), cueTraceLoss: 0,
    promptHashes: { v3: hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT), gemma: hash(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT) },
    promptInstructionsInherited: true, productionChange: false,
    limitations: {
      scalpMaterial: "No explicit visible-scalp/stubble evidence in preserved 033 observed/canonical fields. Short crop alone is not measured scalp transparency.",
      teal: "Absent from preserved observed/canonical evidence; do not inject historical colors into this run.",
      localization: "Accepted region null and geometry skipped are proven. Historical post-normalization MISSING does not establish the pre-normalization subtype; that suffix was not saved.",
      inference: "Synthetic adapter roundtrips preserve explicit and absent cues. They are not recovery of raw live responses or proof of provider perception accuracy.",
    },
  }, null, 2), { flag: "wx" });
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  expect(readFileSync(`${root}/skin.png`)).toEqual(png);
  expect(network).not.toHaveBeenCalled();
  console.info(`REMAINING_EVIDENCE_033 ${out}`);
});
