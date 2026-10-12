import { expect, it } from "vitest";
import { normalizeAnalysisForRendering } from "../src/generate";
import { makeAnalysis } from "./helpers";

function normalize(hair: string, faceFraming = false) {
  const a = makeAnalysis();
  a.observed.hair = hair; a.identityPrompt = "";
  a.inferred.hairBack = { value: "tapered neat nape", rationale: "" };
  Object.assign(a.renderHints, { overallHairLength: "jaw", hairBackShape: "tapered", sideHairLength: "jaw" });
  if (faceFraming) a.renderHints.sideHairShape = "face_framing";
  return normalizeAnalysisForRendering(a).renderHints;
}
it.each([
  "the hair is long enough to frame the face and likely reaches the jawline on the sides",
  "hair is long enough to cover the ears",
  "long enough hair to cover the ears",
  "hair is not long enough to tie back",
  "hair is long enough to tuck behind the ears",
])("relative sufficiency is not a chest-length observation: %s", hair => {
  expect(normalize(hair)).toMatchObject({ overallHairLength: "jaw", hairBackShape: "tapered" });
});
it.each(["long straight hair", "hair is long", "long hair with staggered bangs"])(
  "preserves the existing explicit long-length fallback: %s", hair => {
    expect(normalize(hair)).toMatchObject({ overallHairLength: "chest", hairBackShape: "long" });
  });

it.each([
  "Side hair is long and covers ears, suggesting the back is also long enough to cover the nape.",
  "Long side hair covers the ears.",
  "The bangs are long and cover the eyes.",
])("local strand length cannot invent a chest-length overall endpoint: %s", rationale => {
  const a = makeAnalysis();
  a.identityPrompt = "";
  a.observed.hair = "voluminous, messy black hair with a dense, staggered fringe reaching the eyes; hair covers ears and frames the face; hair ends roughly at the jawline/neck area";
  a.inferred.hairBack = { value: "rounded", rationale };
  Object.assign(a.renderHints, { overallHairLength: "jaw", hairBackShape: "rounded", sideHairLength: "jaw", sideHairShape: "face_framing" });
  expect(normalizeAnalysisForRendering(a).renderHints).toMatchObject({ overallHairLength: "jaw", hairBackShape: "rounded" });
});

it.each([
  ["long side hair covers ears; the back hair is long", "chest"],
  ["side hair is long; back hair reaches the waist", "waist"],
  ["long bangs; shoulder-length hair", "shoulder"],
])("local strand wording preserves independent overall evidence: %s", (hair, expected) => {
  expect(normalize(hair).overallHairLength).toBe(expected);
});
it.each(["chest", "waist", "hip"] as const)("explicit %s endpoint remains authoritative", length => {
  expect(normalize(`hair is long enough to tie back; ${length}-length hair`).overallHairLength).toBe(length);
});

it.each([
  "hair ends at the jaw/shoulder length visually",
  "jaw / shoulder-length hair",
  "shoulder/jaw length hair",
  "hair is jaw-length or shoulder-length",
  "hair ends at jaw or shoulder level",
  "hair is jaw-to-shoulder length",
  "hair is chest/waist length",
  "hair is ear/shoulder length",
  "focused portrait crop confirms jaw/shoulder-length hair",
])("ambiguous endpoint alternatives cannot replace the structured length: %s", hair => {
  expect(normalize(hair).overallHairLength).toBe("jaw");
});

it.each([
  ["jaw/chin-length hair", "jaw"],
  ["chin / jaw length hair", "jaw"],
  ["shoulder-length straight hair", "shoulder"],
  ["hair reaches the shoulders", "shoulder"],
  ["jaw-length front locks with shoulder-length back hair", "shoulder"],
  ["hair described as jaw/shoulder length; back hair clearly reaches the waist", "waist"],
  ["focused portrait crop confirms shoulder-length hair", "shoulder"],
])("independent explicit endpoints and equivalent aliases remain supported: %s", (hair, expected) => {
  expect(normalize(hair).overallHairLength).toBe(expected);
});

it.each([
  "layered hair, tapered around the ears",
  "hair is neatly trimmed around the ears",
  "hair is faded at the ears with a layered nape",
])("local ear grooming is not an overall length endpoint: %s", hair => {
  expect(normalize(hair).overallHairLength).toBe("jaw");
});

it("preserves the observed F011 phrase with its actual structured face-framing context", () => {
  // The default helper has tapered sides; that would exercise the separate
  // compact-cut rule, not this run's actual face-framing contract.
  expect(normalize("Ash-gray/silver textured medium-short hair with messy parted fringe partially covering forehead and brows, tapered around ears, falling to nape", true)
    .overallHairLength).toBe("jaw");
});

it.each([
  ["hair is tapered around ears, with an independently observed shoulder-length back", "shoulder"],
  ["ear-length hair with tapered sides", "ear"],
  ["hair ends at the ears", "ear"],
  ["hair falls to the ears", "ear"],
  ["hair is tapered around ears, with jaw-length side locks", "jaw"],
])("local grooming does not hide a separate endpoint: %s", (hair, expected) => {
  expect(normalize(hair).overallHairLength).toBe(expected);
});
