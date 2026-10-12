import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { observedGoateeMustache } from "../src/facialHairEvidence";
import { observedShavedScalpHairShadow } from "../src/scalpCloseHairEvidence";
import { buildOutfitPlan } from "../src/outfitIdentity";

it("audits remaining 019 acquisition gaps without promoting absent evidence or executing providers", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-019";
    const summaryBytes = readFileSync(`${root}/summary.json`), pngBytes = readFileSync(`${root}/skin.png`);
    const state = JSON.parse(summaryBytes.toString()).currentDefaultE2E;
    const r = state.result, p = r.diagnostics.normalizedPrimary, plans = r.analysis.skinPlan;
    const a = makeAnalysis({ ...p, inferred: { hairBack: null, upperBody: null, lowerBody: null, shoes: null },
      identityPrompt: p.observed.hair, outfitPrompt: p.observed.clothing, negativePrompt: "" });
    const faceEvidence = [p.observed.face, ...p.canonicalIdentity.mustPreserve,
      ...p.canonicalIdentity.features.filter((f: { category: string }) => f.category === "face")
        .flatMap((f: { feature: string; evidence: string }) => [f.feature, f.evidence])].join("; ");
    expect(faceEvidence).not.toMatch(/\bm(?:ou|u)stache\b/i);
    expect(observedGoateeMustache(a.observed.face, a.canonicalIdentity.mustPreserve, true, a.canonicalIdentity.features)).toBe(false);
    expect(p.observed.hair).not.toMatch(/\bvisible\s+scalp\b|\bscalp\s+(?:is\s+)?visible\b/i);
    expect(observedShavedScalpHairShadow(a)).toBe(false);
    expect(plans.hairPlan).toMatchObject({ surfaceOnly: true, lengthClass: "short",
      headMask: { source: "semantic_template", endpointRows: { left: 3, right: 3 }, earExposure: { left: 0.85, right: 0.85 },
        semanticSilhouette: { provenance: "observed_categorical", endpointCue: "cropped", sideEndpointCue: "none", sideWidthFamily: "narrow" } },
      structure: { partChannel: { column: null, direction: "none", points: [] } } });
    expect(plans.hairPlan.surfaceMaterial).toBeUndefined();
    expect(p.sourceSelection.portraitRegion).toBeNull();
    expect(r.diagnostics.localization.status).toBe("MISSING");
    expect(r.diagnostics.geometry).toBeNull();
    expect(Object.values(plans.facePixelPlan.layout.geometryUsage).every(v => v === false)).toBe(true);
    expect(p.observed.clothing).toMatch(/\bplaid\b/);
    expect(plans.outfitPlan.upper.pattern.construction).toBe("crossed_bands");
    expect(buildOutfitPlan(a)).toMatchObject({ upper: { garmentType: "shirt" }, lower: { garmentType: "pants", waistRow: 10 } });
    const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
    const output = mkdtempSync("evaluation-artifacts/current-019-remaining-boundary-20260928-");
    writeFileSync(`${output}/audit.json`, JSON.stringify({ mode: "offline_saved_evidence_audit", providerCalls: 0,
      summarySha256: sha(summaryBytes), pngSha256: sha(pngBytes),
      shortHair: { length: "short", endpointRows: [3, 3], ears: [0.85, 0.85], part: "none", surfaceOnly: true, retained: true },
      missingMustache: { earliestObservedBoundary: "accepted_primary_evidence", consumerAddsAbsentCue: false },
      missingScalpVisibility: { earliestObservedBoundary: "accepted_primary_evidence", materialInvented: false },
      missingLocalization: { status: "MISSING", geometryCalls: 0, rejectedEvidenceUsed: false },
      pattern: { acceptedObservation: "plaid", plan: "crossed_bands", sourceFineStripeFidelityNotClaimed: true },
      shirtCategory: { live: "dress_upper", currentOffline: "shirt", freshLiveVerificationPending: true },
      conclusion: "No additional supported downstream correction established. Preserve source-specific evidence; do not fabricate density, mustache or geometry. New live validation requires separate approval." }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(summaryBytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(pngBytes);
    expect(network).not.toHaveBeenCalled(); console.info(`REMAINING_BOUNDARY ${output}`);
  } finally { network.mockRestore(); }
});
