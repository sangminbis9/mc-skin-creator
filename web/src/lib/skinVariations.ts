import { CLASSIC_LAYOUT as L, type BodyPart } from "../../shared/skinLayout";
import {
  analyzeHair,
  HAIR_FINISHES,
  preserveDrapedHair,
  varyOriginalHair,
  type VariationHints,
} from "./hairVariations";
import { makeWardrobe, TOP_STYLES, BOTTOM_STYLES } from "./wardrobeVariations";

export type VariationRegion = "head" | "upper" | "lower";
export interface SkinVariation {
  id: string;
  label: string;
  pixels: Uint8ClampedArray;
  description?: string;
  disabledReason?: string;
}
export const VARIATION_PARTS: Record<VariationRegion, BodyPart[]> = {
  head: ["head"],
  upper: ["body", "rightArm", "leftArm"],
  lower: ["rightLeg", "leftLeg"],
};
function check(data: Uint8ClampedArray) {
  if (data.length !== 64 * 64 * 4)
    throw new Error("64×64 RGBA 스킨이 필요합니다.");
}
/** Replace, never blend: transparent pixels must clear the previous outfit. */
export function replaceSkinRegion(
  target: Uint8ClampedArray,
  source: Uint8ClampedArray,
  region: VariationRegion,
) {
  check(target);
  check(source);
  const result = new Uint8ClampedArray(target);
  for (const part of VARIATION_PARTS[region])
    for (const layer of [L[part].base, L[part].overlay])
      for (const r of Object.values(layer)) {
        for (let y = r.y; y < r.y + r.h; y++)
          for (let x = r.x; x < r.x + r.w; x++) {
            const i = (y * 64 + x) * 4;
            result.set(source.subarray(i, i + 4), i);
          }
      }
  return result;
}
/** An immutable generation baseline prevents repeated choices accumulating distortions. */
export function createSkinVariations(
  original: Uint8ClampedArray,
  current: Uint8ClampedArray,
  hints: VariationHints = {},
): Record<VariationRegion, SkinVariation[]> {
  check(original);
  check(current);
  const analysis = analyzeHair(original, hints);
  const initial = (): SkinVariation[] => [
    {
      id: "current",
      label: "Current",
      description: "Keep your edits.",
      pixels: new Uint8ClampedArray(current),
    },
    {
      id: "original",
      label: "Original",
      description: "The initial skin before edits.",
      pixels: new Uint8ClampedArray(original),
    },
  ];
  return {
    head: [
      ...initial(),
      ...HAIR_FINISHES.map(({ id, label, description }) => {
        const pixels = varyOriginalHair(original, id, analysis);
        const changesVolume = analysis.nodes.some(
          (n) => n.layer === "overlay" && pixels[n.i + 3] !== original[n.i + 3],
        );
        for (const layer of [L.head.base, L.head.overlay]) {
          const r = layer.front;
          for (let y = 2; y < 8; y++)
            for (let x = 0; x < 8; x++) {
              const i = ((r.y + y) * 64 + r.x + x) * 4;
              // Keep manual face edits, but do not undo the new fringe relief
              // when the current pixel is merely the baseline/previous option.
              const isHair =
                analysis.mask.has(i) ||
                (layer === L.head.overlay &&
                  analysis.mask.has(
                    ((L.head.base.front.y + y) * 64 + L.head.base.front.x + x) *
                      4,
                  ));
              if (!isHair) pixels.set(current.subarray(i, i + 4), i);
            }
        }
        return {
          id,
          label,
          description,
          pixels,
          disabledReason:
            analysis.reason ??
            (!changesVolume
              ? "This region is already near its volume limit."
              : undefined),
        };
      }),
    ],
    upper: [
      ...initial(),
      ...TOP_STYLES.map((style) => {
        const pixels = makeWardrobe(original, "upper", style, analysis.skin);
        preserveDrapedHair(pixels, original, analysis);
        return { ...style, pixels };
      }),
    ],
    lower: [
      ...initial(),
      ...BOTTOM_STYLES.map((style) => ({
        ...style,
        pixels: makeWardrobe(original, "lower", style, analysis.skin),
      })),
    ],
  };
}
