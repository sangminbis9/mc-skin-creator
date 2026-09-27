import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPortraitLocalization, validatePhotoAnalysis, validatePortraitRegion } from "../src/analysis";
import { calibrationLocalizationGate, historicalLocalizationInterpretation } from "./audit/calibrationLocalizationGate";
import { auditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";
import { makeAnalysis } from "./helpers";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";

const numbers = "0.08,0.04,0.62,0.98,0.16,0.08,0.52,0.5,0.21,0.17,0.47,0.44,0.91";
const evidence = (suffix: string) => `Visible primary portrait with reliable head bounds | ${suffix}`;
const valid = evidence(`REGION:[${numbers}]`);

describe("pre-normalization localization trace", () => {
  it("keeps provider prompt and schema hashes at the frozen contract", () => {
    const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(sha(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)).toBe("935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986");
    const referenceSuffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
    expect(sha(COMPACT_PHOTO_ANALYSIS_V3_PROMPT)).toBe("cff5595f5fe846169027512df48690236a998458e541a4e85691fc0434adde8d");
    expect(sha(`${COMPACT_PHOTO_ANALYSIS_V3_PROMPT}${referenceSuffix}`)).toBe("f1ace11fa0d4ad0608338234a108ab91de1fff510f0fd6f1732968915e036951");
  });
  it.each([
    [valid, "VALID", null, 13],
    [evidence("REGION:null"), "EXPLICIT_NULL", null, null],
    ["Visible primary portrait", "MISSING", null, null],
    [evidence(`REGION:[${numbers.split(",").slice(0, 12).join(",")}]`), "MALFORMED", null, 12],
    [evidence(`REGION:[${numbers},0.1]`), "MALFORMED", null, 14],
    [evidence(`REGION:[bad,${numbers.split(",").slice(1).join(",")}]`), "MALFORMED", null, 13],
    [evidence(`REGION:[,${numbers.split(",").slice(1).join(",")}]`), "MALFORMED", null, 13],
    [evidence(`REGION:[${numbers}`), "MALFORMED", null, null],
    [`${valid} trailing prose`, "MALFORMED", null, null],
    [evidence(`REGION:[${numbers.replace("0.21,0.17,0.47,0.44", "0.7,0.17,0.8,0.44")}]`),
      "INVALID_REGION", "face_outside_head", 13],
    [evidence(`REGION:[${numbers.replace(/0\.91$/, "1.2")}]`),
      "INVALID_REGION", "invalid_localization_confidence", 13],
  ] as const)("classifies %s without changing rich normalization", (source, status, reason, count) => {
    const before = validatePhotoAnalysis(makeAnalysis({ sourceSelection: {
      ...makeAnalysis().sourceSelection, portraitEvidence: source,
    } }));
    const beforeBytes = JSON.stringify(before);
    const trace = classifyPortraitLocalization(source);
    const after = validatePhotoAnalysis(makeAnalysis({ sourceSelection: {
      ...makeAnalysis().sourceSelection, portraitEvidence: source,
    } }));
    expect(trace).toMatchObject({ version: 1, status, validationReason: reason, numericCount: count });
    expect(JSON.stringify(after)).toBe(beforeBytes);
    expect(after.ok).toBe(true);
    if (after.ok) {
      // Historical Number("") coercion can leave this malformed trace with a valid rich region.
      // The trace is intentionally stricter; production normalization remains untouched.
      const legacyEmptyToken = source.includes("REGION:[,");
      expect(after.analysis.sourceSelection.portraitRegion === null).toBe(status !== "VALID" && !legacyEmptyToken);
    }
    expect(JSON.stringify(trace)).not.toContain(source);
  });

  it("exposes an exact audit allowlist without evidence text or coordinates", () => {
    const trace = classifyPortraitLocalization(valid);
    expect(Object.keys(auditLocalizationTrace({ ...trace, extraSecret: valid } as typeof trace))).toEqual([
      "traceVersion", "status", "markerPresent", "terminalTokenPresent", "numericCount",
      "numericParse", "regionValidation", "validationReason",
    ]);
    const serialized = JSON.stringify(auditLocalizationTrace(trace));
    expect(serialized).not.toContain("REGION:[");
    expect(serialized).not.toContain(numbers);
    expect(serialized).not.toContain("extraSecret");
  });

  it.each(["EXPLICIT_NULL", "MISSING", "MALFORMED", "INVALID_REGION"] as const)(
    "%s cannot prepare a calibration crop or geometry request", status => {
      const trace = { ...classifyPortraitLocalization(valid), status };
      const region = validatePhotoAnalysis(makeAnalysis({ sourceSelection: {
        ...makeAnalysis().sourceSelection, portraitEvidence: valid,
      } }));
      expect(region.ok).toBe(true);
      if (!region.ok) return;
      let cropPreparations = 0;
      let geometryPosts = 0;
      const providerRetry = 0;
      const gate = calibrationLocalizationGate({ primaryPassed: true, quality: "pass", faceVisible: true,
        portraitImageIndex: 0, trace: auditLocalizationTrace(trace),
        portraitRegion: region.analysis.sourceSelection.portraitRegion });
      if (gate.calibrationLocalizationEligible) { cropPreparations++; geometryPosts++; }
      expect({ eligible: gate.calibrationLocalizationEligible, cropPreparations, geometryPosts, providerRetry })
        .toEqual({ eligible: false, cropPreparations: 0, geometryPosts: 0, providerRetry: 0 });
    },
  );

  it("allows VALID with a real region but rejects hidden face and non-pass quality", () => {
    const trace = classifyPortraitLocalization(valid);
    const region = validatePhotoAnalysis(makeAnalysis({ sourceSelection: {
      ...makeAnalysis().sourceSelection, portraitEvidence: valid,
    } }));
    expect(region.ok).toBe(true);
    if (!region.ok) return;
    const input = { primaryPassed: true, quality: "pass", faceVisible: true, portraitImageIndex: 0,
      trace: auditLocalizationTrace(trace), portraitRegion: region.analysis.sourceSelection.portraitRegion };
    expect(calibrationLocalizationGate(input).calibrationLocalizationEligible).toBe(true);
    expect(calibrationLocalizationGate({ ...input, faceVisible: false }).calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...input, quality: "warn" }).calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...input, portraitRegion: null }).calibrationLocalizationEligible).toBe(false);
  });

  it("does not infer pre-normalization trace from historical normalized artifacts", () => {
    const root = resolve("evaluation-artifacts");
    const open = JSON.parse(readFileSync(resolve(root,
      "face-geometry-openness-production-derivative-open-anchor-live-20260924-002/summary.json"), "utf8"));
    const wavy = JSON.parse(readFileSync(resolve(root,
      "face-geometry-openness-wavy-production-derivative-live-20260925-002/summary.json"), "utf8"));
    expect(open.primaryResults[0].localizationTrace).toBeUndefined();
    expect(validatePortraitRegion(open.primaryResults[0].sourceSelection.portraitRegion).ok).toBe(true);
    expect(wavy.primary.localizationTrace).toBeUndefined();
    expect(wavy.primary.sourceSelection.portraitRegion).toBeNull();
    expect(historicalLocalizationInterpretation(open.primaryResults[0].sourceSelection.portraitRegion))
      .toEqual({ classification: "INFERRED_VALID_FROM_NORMALIZED_REGION", preNormalizationTraceObserved: false });
    expect(historicalLocalizationInterpretation(wavy.primary.sourceSelection.portraitRegion))
      .toEqual({ classification: "UNKNOWN_NULL_COLLAPSED", preNormalizationTraceObserved: false });
  });
});
