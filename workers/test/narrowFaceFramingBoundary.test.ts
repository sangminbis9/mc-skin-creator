import { expect, it } from "vitest";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function fixture(length: "jaw" | "shoulder" | "chest", texture: "straight" | "wavy" = "straight") {
  const a = makeAnalysis();
  a.observed.hair = `${length}-length ${texture} brown hair framing the face`;
  a.observed.accessories = "none";
  a.negativePrompt = "no glasses";
  a.canonicalIdentity.features = [{ category: "hair", feature: a.observed.hair,
    evidence: a.observed.hair, confidence: "high", priority: 5, targetRegions: ["head.front", "head.back"] }];
  Object.assign(a.fallbackFeatures, { hairstyle: "long", hat: "none", glasses: "none", facialHair: "none" });
  Object.assign(a.renderHints, { overallHairLength: length, sideHairLength: length === "jaw" ? "jaw" : "shoulder",
    sideHairShape: "face_framing", hairTexture: texture, hairVolume: "normal", hairBackShape: "long", hairAccessory: "none" });
  return a;
}

it.each(["jaw", "shoulder", "chest"] as const)("%s narrow face-framing retains connected outer locks without a second front rail", length => {
  for (const texture of ["straight", "wavy"] as const) {
    const a = fixture(length, texture), frozen = JSON.stringify(a);
    const p = buildIdentityPixelPlans(a), m = p.hairPlan.headMask;
    expect(m.source).toBe("semantic_template");
    expect(m.semanticSilhouette?.sideWidthFamily).toBe("narrow");
    for (let y = 2; y <= m.endpointRows.left; y++) {
      expect(m.faces.front.filter(c => c.y === y).map(c => c.x).sort((x, z) => x - z)).toEqual([0, 7]);
    }
    expect(m.faces.front.filter(c => c.y === 0)).toHaveLength(8);
    expect(m.faces.front.filter(c => c.y === 1)).toHaveLength(8);
    expect(m.faces.left.some(c => c.y === m.endpointRows.left)).toBe(true);
    expect(m.faces.back.some(c => c.y === (length === "jaw" ? 6 : 7))).toBe(true);
    for (const x of [1, 6]) expect(p.headIdentityPlan.ownership?.cells.some(c => c.face === "front" && c.layer === "base"
      && c.x === x && c.y === 4 && c.owner === "hair_base")).toBe(false);
    expect(JSON.stringify(a)).toBe(frozen);
    expect(buildIdentityPixelPlans(a)).toEqual(p);
  }
});

it("retains measured hair silhouette independently of categorical side framing", () => {
  const a = makeAnalysis();
  Object.assign(a.renderHints, { overallHairLength: "chest", sideHairLength: "shoulder", sideHairShape: "face_framing" });
  a.identityGeometry = makeIdentityGeometry();
  const b = structuredClone(a); b.renderHints.sideHairShape = "ear_hugging";
  const first = buildIdentityPixelPlans(a), second = buildIdentityPixelPlans(b);
  expect(first.hairPlan.headMask.source).toBe("identity_geometry");
  expect(first.hairPlan.headMask).toEqual(second.hairPlan.headMask);
  expect(first.facePixelPlan).toEqual(second.facePixelPlan);
});

it.each(["full", "curly", "coily", "ear_hugging", "hidden", "headscarf"])("retains existing mass for %s rather than applying a universal face cutout", mode => {
  const a = fixture("chest");
  if (mode === "full") a.renderHints.hairVolume = "full";
  if (mode === "curly" || mode === "coily") a.renderHints.hairTexture = mode;
  if (mode === "ear_hugging") a.renderHints.sideHairShape = "ear_hugging";
  if (mode === "hidden") a.visibleRegions.hair = false;
  if (mode === "headscarf") a.fallbackFeatures.hat = "headscarf";
  const m = buildIdentityPixelPlans(a).hairPlan.headMask;
  if (mode === "headscarf") expect(m.coveringTopology?.fit).toBe("fitted_headscarf");
  else for (const x of [1, 6]) expect(m.faces.front.some(c => c.x === x && c.y === 4)).toBe(true);
});
