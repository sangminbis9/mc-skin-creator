import { expect, it } from "vitest";
import { fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { makeAnalysis } from "./helpers";

function color(hair: string) {
  const a = makeAnalysis(); a.observed.hair = hair; a.fallbackFeatures.hairColor = "dyed-blue";
  const input = fallbackFeaturesToHex(a.fallbackFeatures);
  return { actual: refineFeatureColorsFromAnalysis(a, input).hairColor, fallback: input.hairColor };
}

it.each([
  ["The hair is a medium ash-gray color, styled in a layered, somewhat messy cut.", "gray"],
  ["The hair is an ashy grey colour, with a red ribbon.", "gray"],
  ["Hair is a brown color.", "brown"],
  ["The curls are a platinum blonde colour, with a black clip.", "platinum"],
  ["Hair is a medium dark-brown color; the fringe is straight.", "dark-brown"],
  ["The fringe is a silver color.", "gray"],
  ["Hair is white color, layered texture.", "white"],
])("preserves complete predicative hair material: %s", (text, expected) => {
  expect(color(text).actual).toBe(fallbackFeaturesToHex({ ...makeAnalysis().fallbackFeatures, hairColor: expected }).hairColor);
});

it.each([
  "The hair is a medium ash-gray color ribbon.",
  "The hair is a gray color bow.",
  "The hair clip is a gray color.",
  "The ribbon in the hair is a gray color.",
  "The hair is a gray color print on the shirt.",
  "Possibly the hair is a gray color.",
  "The hair is possibly a gray color.",
  "The hair is not a gray color.",
  "The hair is a gray color but uncertain.",
  "The hair is a gray and white color.",
  "The hair is a gray color; the hair is a white color.",
  "The hair is a gray color, white hair.",
  "The coat is a gray color, the hair is hidden.",
  "A gray color, the hair is straight.",
  "The hair is a color, gray ribbon.",
  "The hair is a gray color option in the catalog.",
])("does not widen material ownership or collapse uncertainty: %s", text => {
  const r = color(text); expect(r.actual).toBe(r.fallback);
});
