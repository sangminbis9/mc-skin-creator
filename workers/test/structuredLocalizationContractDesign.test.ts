import { describe, expect, it } from "vitest";
import { validatePhotoAnalysis, validatePortraitRegion } from "../src/analysis";
import { makeAnalysis } from "./helpers";

const coordinates = [0.08, 0.04, 0.62, 0.98, 0.16, 0.08, 0.52, 0.5, 0.21, 0.17, 0.47, 0.44, 0.91];
const structured = {
  subjectBox: { left: 0.08, top: 0.04, right: 0.62, bottom: 0.98 },
  headBox: { left: 0.16, top: 0.08, right: 0.52, bottom: 0.5 },
  faceBox: { left: 0.21, top: 0.17, right: 0.47, bottom: 0.44 },
  confidence: 0.91,
};

describe("structured localization design: existing semantic and legacy baseline", () => {
  it("maps a valid named region and the equivalent legacy 13-number region identically", () => {
    const named = validatePortraitRegion(structured);
    const legacy = validatePortraitRegion(coordinates);
    expect(named.ok).toBe(true);
    expect(legacy).toEqual(named);
  });

  it("documents why an explicit structured null needs a new internal localization authority mode", () => {
    const input = makeAnalysis();
    input.sourceSelection.portraitEvidence = `Synthetic portrait | REGION:[${coordinates.join(",")}]`;
    input.sourceSelection.portraitRegion = null;
    const legacy = validatePhotoAnalysis(input);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.analysis.sourceSelection.portraitRegion).toEqual(structured);
      expect(legacy.analysis.sourceSelection.portraitEvidence).toBe("Synthetic portrait");
    }
  });
});
