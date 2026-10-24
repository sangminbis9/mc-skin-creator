import { normalizeFeatures } from "./skinFeatures";
import { createCuratedLacePixels } from "./curatedLaceSkin";
import { pixelsToSkinCanvas } from "./skinAtlas";

// Curated real atlas: never returned as the result of live photo generation.
export const demoHints = normalizeFeatures({
  skinTone: "#f4d1bc", hairColor: "#46312a", hairstyle: "long",
  topType: "shirt", topColor: "#efebdb", bottomType: "skirt",
  bottomColor: "#efebdb", shoesColor: "#f6ead8", hat: "none",
});

export async function loadDemoSkin(): Promise<HTMLCanvasElement> {
  return pixelsToSkinCanvas(createCuratedLacePixels());
}
