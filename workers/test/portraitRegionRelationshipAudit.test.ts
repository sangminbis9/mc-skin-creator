import { describe, expect, it } from "vitest";
import { classifyPortraitLocalization, validatePhotoAnalysis, validatePortraitRegion } from "../src/analysis";
import { calibrationLocalizationGate } from "./audit/calibrationLocalizationGate";
import { auditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";
import { makeAnalysis } from "./helpers";

// Synthetic contract fixtures only: no provider output or historical rejected coordinates.
const sourceClass = "synthetic_contract_test";
const providerOrigin = false;
const boundaryWidth = 0.25 * 1.02;
const boundaryHeight = 0.2 * 1.08;
const base = [0, 0, 1, 1, 0, 0, boundaryWidth, boundaryHeight, 0, 0, 0.25, 0.2, 0.9];
const withSlots = (changes: Record<number, number>) => base.map((value, index) => changes[index] ?? value);
const evidence = (slots: number[]) => `Synthetic contract portrait | REGION:[${slots.join(",")}]`;
const relationship = (slots: number[]) => auditLocalizationTrace(classifyPortraitLocalization(evidence(slots)));

describe("portrait face/head relationship: offline contract", () => {
  it("documents the synthetic origin and exact L,T,R,B endpoint slot mapping", () => {
    expect({ sourceClass, providerOrigin }).toEqual({ sourceClass: "synthetic_contract_test", providerOrigin: false });
    const trace = classifyPortraitLocalization(evidence(base));
    expect(trace).toMatchObject({ status: "VALID", numericCount: 13 });
    const validated = validatePortraitRegion(base);
    expect(validated).toEqual({ ok: true, region: {
      subjectBox: { left: 0, top: 0, right: 1, bottom: 1 },
      headBox: { left: 0, top: 0, right: boundaryWidth, bottom: boundaryHeight },
      faceBox: { left: 0, top: 0, right: 0.25, bottom: 0.2 }, confidence: 0.9,
    } });
  });

  it.each([
    ["exact equality", base, "VALID", null],
    ["width just above", withSlots({ 6: boundaryWidth + 0.0001 }), "VALID", null],
    ["height just above", withSlots({ 7: boundaryHeight + 0.0001 }), "VALID", null],
    ["width just below", withSlots({ 6: boundaryWidth - 0.0001 }), "INVALID_REGION", "head_width_ratio"],
    ["height just below", withSlots({ 7: boundaryHeight - 0.0001 }), "INVALID_REGION", "head_height_ratio"],
    ["both just below", withSlots({ 6: boundaryWidth - 0.0001, 7: boundaryHeight - 0.0001 }),
      "INVALID_REGION", "both_ratios"],
  ] as const)("%s preserves acceptance and identifies only the failed predicate", (_name, slots, status, detail) => {
    const validation = validatePortraitRegion(slots);
    const trace = classifyPortraitLocalization(evidence(slots));
    const audit = relationship(slots);
    expect(trace.status).toBe(status);
    expect(validation.ok).toBe(status === "VALID");
    expect(audit?.relationshipFailure ?? null).toBe(detail);
    if (detail) {
      expect(validation).toEqual({ ok: false, reason: "face_head_relationship_invalid" });
      expect(trace.validationReason).toBe("face_head_relationship_invalid");
    }
    expect(JSON.stringify(audit)).not.toContain("REGION:");
  });

  it("retains neighboring reasons and existing priority", () => {
    const tooSmall = withSlots({ 10: 0.024, 11: 0.034, 6: 0.024, 7: 0.034 });
    expect(validatePortraitRegion(tooSmall)).toEqual({ ok: false, reason: "face_bounds_too_small" });
    const widthAndOutside = withSlots({ 6: boundaryWidth - 0.0001, 8: 0.5, 10: 0.75 });
    expect(validatePortraitRegion(widthAndOutside)).toEqual({ ok: false, reason: "face_head_relationship_invalid" });
    expect(relationship(widthAndOutside)?.relationshipFailure).toBe("head_width_ratio");
    const faceOutside = withSlots({ 6: 0.4, 7: 0.4, 8: 0.5, 9: 0.1, 10: 0.75, 11: 0.3 });
    expect(validatePortraitRegion(faceOutside)).toEqual({ ok: false, reason: "face_outside_head" });
    expect(relationship(faceOutside)?.relationshipFailure).toBeUndefined();
    const headOutside = withSlots({ 2: 0.3, 3: 0.3, 6: 0.4, 7: 0.4 });
    expect(validatePortraitRegion(headOutside)).toEqual({ ok: false, reason: "head_outside_subject" });
    expect(relationship(headOutside)?.relationshipFailure).toBeUndefined();
    const malformed = withSlots({ 6: 1.01 });
    expect(validatePortraitRegion(malformed)).toEqual({ ok: false, reason: "malformed_normalized_bounds" });
    expect(relationship(malformed)?.relationshipFailure).toBeUndefined();
  });

  it("keeps normalization null, calibration ineligible, and crop/geometry unstarted", () => {
    const rejected = withSlots({ 6: boundaryWidth - 0.0001 });
    const source = evidence(rejected);
    const input = makeAnalysis({ sourceSelection: {
      ...makeAnalysis().sourceSelection, portraitEvidence: source, portraitRegion: null,
    } });
    const before = validatePhotoAnalysis(input);
    const trace = classifyPortraitLocalization(source);
    const after = validatePhotoAnalysis(input);
    expect(after).toEqual(before);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.analysis.sourceSelection.portraitRegion).toBeNull();
    const gate = calibrationLocalizationGate({ primaryPassed: true, quality: "pass", faceVisible: true,
      portraitImageIndex: 0, trace, portraitRegion: after.analysis.sourceSelection.portraitRegion });
    let cropPreparations = 0;
    let geometryPosts = 0;
    if (gate.calibrationLocalizationEligible) { cropPreparations++; geometryPosts++; }
    expect({ eligible: gate.calibrationLocalizationEligible, cropPreparations, geometryPosts })
      .toEqual({ eligible: false, cropPreparations: 0, geometryPosts: 0 });
  });

  it("allowlists only a fixed enum and excludes unexpected trace payloads", () => {
    const trace = classifyPortraitLocalization(evidence(withSlots({ 6: boundaryWidth - 0.0001 })));
    const allowed = auditLocalizationTrace({ ...trace, unexpected: "secret", relationshipFailure: "untrusted" } as typeof trace);
    expect(allowed?.relationshipFailure).toBeUndefined();
    expect(JSON.stringify(allowed)).not.toContain("secret");
  });
});
