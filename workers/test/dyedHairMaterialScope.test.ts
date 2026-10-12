import { expect, it } from "vitest";
import { fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { makeAnalysis } from "./helpers";

function recover(text: string) {
  const a = makeAnalysis(); a.observed.hair = text; a.fallbackFeatures.hairColor = "dark-brown";
  const input = fallbackFeaturesToHex(a.fallbackFeatures);
  const before = JSON.stringify(a);
  const result = refineFeatureColorsFromAnalysis(a, input);
  expect(JSON.stringify(a)).toBe(before);
  return { actual: result.hairColor, fallback: input.hairColor };
}
it.each([
  ["long, wavy, dyed-pink hair with thick bangs", "#e58bb6"],
  ["pink hair with a white ribbon", "#e58bb6"],
  ["hair is pink", "#e58bb6"],
  ["dyed blue curly hair", "#4d9de0"],
  ["purple braids with pink ribbons", "#8560b0"],
  ["green short hair with a black clip", "#4fa05a"],
  ["the hair is a pink color", "#e58bb6"],
  ["pink color, wavy texture", "#e58bb6"],
])("recovers supported dyed material without a fallback-enum change: %s", (text, color) => {
  expect(recover(text).actual).toBe(color);
});
it.each([
  "pink bow in hair", "pink hair bow", "hair pink ribbon", "blue hair clip",
  "hair with purple ribbons", "green jacket, long hair", "pink cardigan and long hair",
  "possibly pink hair", "not pink hair", "hair color unknown, pink bow",
  "pink and blue hair", "dyed-pink and black hair", "pink hair; purple hair",
  "brown and pink hair", "hair with pink highlights",
])("does not steal accessory color or collapse uncertain/multicolor material: %s", text => {
  const r = recover(text); expect(r.actual).toBe(r.fallback);
});
