import { expect, it } from "vitest";
import { buildEyeAperturePrototypeRequest, deriveEyeApertureRatio, EYE_APERTURE_CONTRACT_VERSION,
  EYE_APERTURE_PROMPT, EYE_APERTURE_SCHEMA, validateEyeApertureObservation,
  type EyeApertureObservation } from "./audit/eyeAperturePrototype";

function fixture(): EyeApertureObservation {
  const eye = (centerX: number, side: "left" | "right") => ({ visibility: "observed" as const,
    outerCorner: { x: centerX + (side === "left" ? -0.1 : 0.1), y: 0.4 },
    innerCorner: { x: centerX + (side === "left" ? 0.1 : -0.1), y: 0.4 },
    upperLid: { x: centerX, y: 0.35 }, lowerLid: { x: centerX, y: 0.45 }, confidence: 0.9 });
  return { version: EYE_APERTURE_CONTRACT_VERSION, cropWidthPx: 200, cropHeightPx: 100,
    pose: "frontal", left: eye(0.3, "left"), right: eye(0.7, "right") };
}

it("keeps the audit-only contract distinct from production subjective openness", () => {
  const request = buildEyeAperturePrototypeRequest("data:image/png;base64,AQID", 200, 100);
  expect(request.version).toBe(EYE_APERTURE_CONTRACT_VERSION);
  expect(request.imageCount).toBe(1);
  expect(request.responseSchema).toBe(EYE_APERTURE_SCHEMA);
  expect(request.prompt).toContain(EYE_APERTURE_PROMPT);
  expect(request.prompt).toContain("200 x 100 pixels");
  expect(JSON.stringify(EYE_APERTURE_SCHEMA)).not.toContain('"openness"');
  expect(() => buildEyeAperturePrototypeRequest("not-a-png", 200, 100)).toThrow();
});

it("converts both normalized axes to pixels before dividing aperture by eye chord", () => {
  const value = fixture();
  expect(validateEyeApertureObservation(value, { widthPx: 200, heightPx: 100 }).ok).toBe(true);
  const ratio = deriveEyeApertureRatio(value);
  expect(ratio).toEqual({ left: 0.25, right: 0.25, mean: 0.25 });
  // Naive normalized-y/normalized-x is 0.5 and is dimensionally wrong here.
  expect(ratio.mean).not.toBe(0.5);
  expect(validateEyeApertureObservation(value, { widthPx: 100, heightPx: 200 }).errors)
    .toContain("eyeAperture.crop:request_mismatch");
});

it("uses a perpendicular eye-chord aperture for mild tilt", () => {
  const value = fixture(); value.pose = "mild_tilt";
  for (const e of [value.left, value.right]) {
    e.innerCorner.y = 0.5;
    const side = e === value.left ? 1 : -1;
    e.upperLid = { x: (e.outerCorner.x! + e.innerCorner.x!) / 2 + side * 0.0062, y: 0.4 };
    e.lowerLid = { x: (e.outerCorner.x! + e.innerCorner.x!) / 2 - side * 0.0062, y: 0.5 };
  }
  expect(validateEyeApertureObservation(value).ok).toBe(true);
  expect(deriveEyeApertureRatio(value).mean).toBeGreaterThan(0);
});

it("keeps a uniform resize invariant and accounts for a changed crop aspect ratio", () => {
  const base = fixture();
  const uniform = { ...fixture(), cropWidthPx: 400, cropHeightPx: 200 };
  const taller = { ...fixture(), cropWidthPx: 200, cropHeightPx: 200 };
  expect(validateEyeApertureObservation(uniform).ok).toBe(true);
  expect(deriveEyeApertureRatio(uniform).mean).toBe(deriveEyeApertureRatio(base).mean);
  expect(deriveEyeApertureRatio(taller).mean).toBe(0.5);
});

it("enforces viewer-left and viewer-right corner mapping", () => {
  const swapped = fixture();
  [swapped.left, swapped.right] = [swapped.right, swapped.left];
  expect(validateEyeApertureObservation(swapped).errors).toContain("eyeAperture.left:corner_order");
  const reversedLeft = fixture();
  [reversedLeft.left.outerCorner, reversedLeft.left.innerCorner] = [reversedLeft.left.innerCorner, reversedLeft.left.outerCorner];
  expect(validateEyeApertureObservation(reversedLeft).errors).toContain("eyeAperture.left:corner_order");
});

it("keeps occluded and blink eyes unknown, never substituting 0.5", () => {
  const value = fixture();
  value.right = { visibility: "occluded", outerCorner: { x: null, y: null }, innerCorner: { x: null, y: null },
    upperLid: { x: null, y: null }, lowerLid: { x: null, y: null }, confidence: 0 };
  expect(validateEyeApertureObservation(value).ok).toBe(true);
  expect(deriveEyeApertureRatio(value)).toEqual({ left: 0.25, right: null, mean: null });
  value.right.visibility = "blink";
  expect(validateEyeApertureObservation(value).ok).toBe(true);
  value.right.confidence = 0.5;
  expect(validateEyeApertureObservation(value).errors).toContain("eyeAperture.right:unknown_requires_null_and_zero_confidence");
});

it("rejects missing, null, nonfinite, bad chord, and invented landmarks", () => {
  const missing = fixture() as unknown as Record<string, unknown>;
  delete (missing.left as Record<string, unknown>).upperLid;
  expect(validateEyeApertureObservation(missing).errors).toContain("eyeAperture.left.upperLid:required");
  const partial = fixture(); partial.left.upperLid.x = null;
  expect(validateEyeApertureObservation(partial).errors).toContain("eyeAperture.left:observed_requires_landmarks");
  expect(deriveEyeApertureRatio(partial).left).toBeNull();
  const nonfinite = fixture(); nonfinite.left.lowerLid.y = NaN;
  expect(validateEyeApertureObservation(nonfinite).errors).toContain("eyeAperture.left.lowerLid.y:range");
  const badChord = fixture(); badChord.left.innerCorner = { ...badChord.left.outerCorner };
  expect(validateEyeApertureObservation(badChord).errors).toContain("eyeAperture.left:invalid_chord_or_lid_geometry");
  const unsupported = fixture(); unsupported.pose = "unsupported";
  expect(validateEyeApertureObservation(unsupported).errors).toContain("eyeAperture.left:unknown_requires_null_and_zero_confidence");
});
