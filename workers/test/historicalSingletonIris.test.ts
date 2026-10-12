import { describe, expect, it } from "vitest";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, fallbackFeaturesToHex } from "../src/generate";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { assertSingletonPigmentBoundary } from "./historicalSingletonIris";

function boundaryFixture() {
  const analysis = makeAnalysis(), plan = buildSkinPlan(analysis);
  plan.facePixelPlan.layout.eyeTopology = "readable_iris";
  plan.facePixelPlan.glassesPlan.topology = "none";
  plan.facePixelPlan.pixels = [
    { x: 2, y: 4, cluster: "left_eye", role: "iris" },
    { x: 5, y: 4, cluster: "right_eye", role: "iris" },
  ];
  plan.headIdentityPlan.ownership!.cells = [];
  const historical = makeSyntheticAtlas(), current = { ...historical, rgba: historical.rgba.slice() };
  const front = CLASSIC_LAYOUT.head.base.front;
  const pixels = plan.facePixelPlan.pixels.map(p => (front.y + p.y) * 64 + front.x + p.x);
  for (const pixel of pixels) {
    historical.rgba.set([13, 10, 7, 255], pixel * 4);
    current.rgba.set([74, 55, 40, 255], pixel * 4);
  }
  const style = buildFaceStyle(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures), plan.hairPlan);
  style.eyeColor = "#4a3728"; style.facialHair = "none";
  return { plan, historical, current, style, pixels };
}

describe("historical singleton pigment allowlist is not a general head exemption", () => {
  it("accepts only exact source pigment on the two existing iris cells without mutating inputs", () => {
    const b = boundaryFixture(), original = JSON.stringify(b);
    expect(assertSingletonPigmentBoundary(b.current, b.historical, b.plan, b.style)).toEqual(b.pixels);
    expect(JSON.stringify(b)).toBe(original);
    expect(assertSingletonPigmentBoundary(b.historical, b.historical, b.plan, b.style)).toEqual([]);
  });

  it.each(["wrong_pigment", "non_iris_head", "body", "alpha", "protected", "glasses", "missing_eye_color"] as const)("rejects %s drift", mode => {
    const b = boundaryFixture();
    if (mode === "wrong_pigment") b.current.rgba[b.pixels[0] * 4] = 75;
    if (mode === "non_iris_head") b.current.rgba[(8 * 64 + 8) * 4] ^= 1;
    if (mode === "body") b.current.rgba[(20 * 64 + 20) * 4] ^= 1;
    if (mode === "alpha") b.current.rgba[b.pixels[0] * 4 + 3] = 254;
    if (mode === "protected") b.plan.facePixelPlan.pixels.push({ x: 2, y: 4, cluster: "fringe", role: "hair_mid" });
    if (mode === "glasses") b.plan.facePixelPlan.glassesPlan.topology = "rectangular_thin";
    if (mode === "missing_eye_color") b.style.eyeColor = "";
    expect(() => assertSingletonPigmentBoundary(b.current, b.historical, b.plan, b.style)).toThrow();
  });
});
