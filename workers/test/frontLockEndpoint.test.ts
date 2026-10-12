import { expect, it } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, fallbackFeaturesToHex } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildReferenceLooseHair } from "../src/referenceLooseHair";

function sample(text: string) {
  const a = makeAnalysis();
  a.observed.hair = text;
  a.observed.accessories = "blue cap";
  a.observed.clothing = "plain white top";
  a.fallbackFeatures.hat = "cap";
  a.fallbackFeatures.hairstyle = "long";
  a.fallbackFeatures.glasses = "none";
  a.renderHints.hairAccessory = "none";
  a.renderHints.overallHairLength = "chest";
  a.renderHints.hairBackShape = "long";
  a.renderHints.sideHairLength = "shoulder";
  a.canonicalIdentity.features = [{ category: "hair", feature: text, evidence: text,
    confidence: "high", priority: 5, targetRegions: ["head.front", "head.back"] }];
  const plan = buildSkinPlan(a), design = buildReferenceStylePlan(a);
  const style = buildFaceStyle(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone), plan.hairPlan);
  return { a, plan, design, style };
}

it.each([
  "long straight hair with long side-hair that reaches the chest; the hat covers the crown",
  "front locks extend to the chest",
  "face-framing locks fall to the chest",
  "The hair frames the face and falls past the shoulders down to the chest/waist area.",
  "Straight hair frames her face and extends to the chest.",
  "Light ash-brown hair with face-framing strands extending down past the bust/chest area.",
  "Chest-length front locks and wispy brow bangs visible under beanie",
  "Waist-length face-framing strands",
  "Face-framing strands extend below the chest",
  "Front strands fall to the waist",
  "Chest-length locks framing the face and wispy bangs peeking out under the beanie",
  "Waist length strands framing her face",
  "Hip-length locks that frame their face",
])("preserves explicit torso-reaching front/side locks: %s", text => {
  const s = sample(text);
  expect(s.design.drape.eligible).toBe(true);
  const drape = buildReferenceLooseHair(s.plan, s.design, s.style);
  expect(drape.frontEvidence).toBe("observed_front_lock_endpoint");
  expect(drape.points.filter(p => p.face === "front")).toHaveLength(16);
  expect(drape.points.every(p => p.face !== "front" || p.x === 0 || p.x === 7)).toBe(true);
});

it.each([
  "long chest-length hair", "back hair reaches the chest", "side hair reaches the jaw",
  "no side-hair reaches the chest", "side-hair might reach the chest",
  "side-hair reaching the chest is hidden", "left side-hair reaches the chest",
  "a single front lock reaches the chest", "hair is tied behind the head",
  "side-hair is short; a scarf reaches the chest", "front locks printed on a shirt reach the chest",
  "front locks reach the chest in the imagined completion",
  "Hair frames the face. Back hair falls to the waist.",
  "Hair frames the face and a scarf falls past the shoulders to the chest.",
  "Hair frames the face and falls to the jaw.",
  "Hair frames only the left side of the face and falls to the chest.",
  "Hair frames the face and might fall to the chest.",
  "Hair frames the face and falls behind the shoulders to the waist.",
  "Hair frames the face and falls to the chest in a drawing on the shirt.",
  "Hair frames the face and a necklace reaches the chest.",
  "Chest-length back hair with face-framing strands at the jaw",
  "Chest-length hair. Front locks end at the jaw.",
  "Face-framing strands; a scarf extends past the chest",
  "Face-framing strands and a scarf extend below the chest",
  "Face-framing strands extending down past the shoulders",
  "Only left face-framing strands extend past the chest",
  "Chest-length front lock",
  "Maybe chest-length front locks",
  "No chest-length front locks",
  "Chest-length front locks printed on the top",
  "Chest-length locks. Short strands framing the face",
  "Chest-length scarf and locks framing the face",
  "Chest-length locks framing the shoulders",
  "Chest-length lock framing the face",
  "Chest-length locks framing only the left side of the face",
  "Possibly chest-length locks framing the face",
  "No chest-length locks framing the face",
  "Chest-length locks framing the face in an illustration",
  "Chest-length rear locks and bangs framing the face",
])("does not invent bilateral front drape: %s", text => {
  const s = sample(text);
  expect(s.design.drape.eligible).toBe(false);
  // A forged selection still cannot bypass the source evidence check.
  s.design.drape.eligible = true; s.design.drape.maxShoulderColumns = 1;
  expect(buildReferenceLooseHair(s.plan, s.design, s.style).points.filter(p => p.face === "front")).toEqual([]);
});

it("requires real bottom-head roots and retains tied/full-covering exclusions", () => {
  const s = sample("front locks extend to the chest");
  s.design.drape.eligible = true; s.design.drape.maxShoulderColumns = 1;
  for (const c of s.plan.headIdentityPlan.ownership!.cells) if (c.face === "front" && c.y === 7) c.owner = "face";
  expect(buildReferenceLooseHair(s.plan, s.design, s.style).points.filter(p => p.face === "front")).toEqual([]);
  const b = sample("front locks extend to the chest");
  b.plan.headIdentityPlan.ownership!.covering = true;
  expect(buildReferenceLooseHair(b.plan, b.design, b.style).points).toEqual([]);
  const tied = sample("hair in twin braids; front locks extend to the chest");
  expect(buildReferenceLooseHair(tied.plan, tied.design, tied.style).points).toEqual([]);
});
