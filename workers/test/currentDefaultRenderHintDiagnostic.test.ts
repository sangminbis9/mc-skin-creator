import { expect, it } from "vitest";
import { failedE2ERenderHint } from "./audit/currentDefaultE2E";
import { semanticFixture, wireFixture } from "./compactV3Support";
import { normalizeCompactPhotoAnalysisV3, validateCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";

it("records only the first failed canonical slot without changing rejection", () => {
  const wire = wireFixture(semanticFixture("plain"));
  // Authored wrong-slot probe, NOT the token from consumed live B003.
  wire.renderHints.hairLength[1] = "ear";
  const before = JSON.stringify(wire);
  const errors = validateCompactPhotoAnalysisV3(wire, { imageCount: 1 });
  expect(errors).toEqual(["renderHints.hairLength[1]:fieldVocabulary"]);
  expect(failedE2ERenderHint(wire, [...errors, "renderHints.eyes[0]:fieldVocabulary"])).toEqual({
    group: "hairLength", index: 1, cue: "sideHairLength", value: "ear",
    allowedValuesForCue: ["none", "short", "cheek", "jaw", "shoulder"],
  });
  expect(JSON.stringify(wire)).toBe(before);
  expect(normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 })).toEqual({ ok: false, errors });
});

it("redacts unrecognized text and ignores malformed/non-slot errors", () => {
  const wire = wireFixture(semanticFixture("plain"));
  for (const value of ["unrecognized", "data:image/png;base64,private", "Bearer private", "private free-form description"]) {
    wire.renderHints.hairLength[1] = value;
    expect(failedE2ERenderHint(wire, ["renderHints.hairLength[1]:fieldVocabulary"])?.value).toBe("[redacted]");
  }
  for (const error of ["renderHints.hairLength[99]:fieldVocabulary", "renderHints.hairLength[-1]:fieldVocabulary",
    "renderHints.hairLength[01]:fieldVocabulary", "renderHints.noGroup[1]:fieldVocabulary",
    "renderHints.__proto__[1]:fieldVocabulary", "renderHints.hairLength[1]:type", "sourceSelection:required"]) {
    expect(failedE2ERenderHint(wire, [error])).toBeNull();
  }
  expect(failedE2ERenderHint(null, ["renderHints.hairLength[1]:fieldVocabulary"])).toBeNull();
});

it("keeps every valid side-hair token and normalized result unchanged", () => {
  for (const value of ["none", "short", "cheek", "jaw", "shoulder"]) {
    const wire = wireFixture(semanticFixture("plain")); wire.renderHints.hairLength[1] = value;
    const before = normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 });
    const errors = validateCompactPhotoAnalysisV3(wire, { imageCount: 1 });
    expect(errors).toEqual([]); expect(failedE2ERenderHint(wire, errors)).toBeNull();
    expect(before.ok).toBe(true);
    expect(normalizeCompactPhotoAnalysisV3(wire, { imageCount: 1 })).toEqual(before);
  }
});
