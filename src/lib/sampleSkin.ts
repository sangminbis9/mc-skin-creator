import { generateSkinFromFeatures } from "./skinFromFeatures";
import { normalizeFeatures } from "./skinFeatures";

/** The welcome preview and editable example use the same real 64×64 skin. */
export function createSampleSkin(): HTMLCanvasElement {
  return generateSkinFromFeatures(
    normalizeFeatures({
      skinTone: "#efc7a6",
      hairColor: "#292821",
      hairstyle: "short",
      topType: "jacket",
      topColor: "#586d47",
      topAccentColor: "#202820",
      bottomType: "pants",
      bottomColor: "#292d29",
      shoesColor: "#e2e5d9",
    }),
  );
}
