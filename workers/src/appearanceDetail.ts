/** Optional single-call evidence for details that cannot reliably be recovered
 * from prose. Unknown is explicit and never licenses added paint. */
const tips = ["unknown", "not_in_front", "shoulder", "chest", "waist"] as const;
const textures = ["unknown", "straight", "wavy", "braided"] as const;
const patterns = ["unknown", "none", "torso_blocks", "wrap_blocks", "torso_gradient"] as const;
const sockTops = ["unknown", "above_knee", "at_knee", "below_knee"] as const;
const shapes = ["unknown", "none", "beanie", "ear_beanie"] as const;
const neutralHair = ["unknown", "not_neutral", "gray", "silver", "platinum", "white"] as const;
const templeEnds = ["unknown", "above_ear", "at_ear", "cheek", "jaw", "below_jaw"] as const;
const rearHairPatterns = ["unknown", "straight", "ends_in", "ends_out", "low_wave", "loose_wave", "layered_wave", "ringlets", "tight_coils"] as const;
export type RearHairPattern = Exclude<typeof rearHairPatterns[number], "unknown">;
const color = { type: "string" } as const;
const list = { type: "array", maxItems: 5, items: color } as const;
const enumerated = (values: readonly string[]) => ({ type: "string", enum: values });
const properties = {
  hairNeutral: enumerated(neutralHair), templeLeft: enumerated(templeEnds), templeRight: enumerated(templeEnds),
  rearHairPattern: enumerated(rearHairPatterns),
  frontHairLeft: enumerated(tips), frontHairRight: enumerated(tips), frontHairTexture: enumerated(textures),
  upperPattern: enumerated(patterns), upperPalette: list, leftSleeveColor: color, rightSleeveColor: color,
  skirtBase: color, skirtCheck: color, beanie: enumerated(shapes), beanieBase: color, beanieTrim: list,
  sockTop: enumerated(sockTops),
};
export const APPEARANCE_DETAIL_SCHEMA = { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };

export interface AppearanceDetail {
  hairNeutral: typeof neutralHair[number]; templeLeft: typeof templeEnds[number]; templeRight: typeof templeEnds[number];
  rearHairPattern: typeof rearHairPatterns[number];
  /** Optional local corroboration from the already uploaded portrait pixels. */
  neutralHairSample?: string;
  frontHairLeft: typeof tips[number]; frontHairRight: typeof tips[number]; frontHairTexture: typeof textures[number];
  upperPattern: typeof patterns[number]; upperPalette: string[]; leftSleeveColor: string; rightSleeveColor: string;
  skirtBase: string; skirtCheck: string; beanie: typeof shapes[number]; beanieBase: string; beanieTrim: string[];
  sockTop: typeof sockTops[number];
}

export const APPEARANCE_DETAIL_PROMPT = `
Also return appearanceDetail, a compact supplement. Keep all other required fields and their rules unchanged.
- hairNeutral: MAIN visible color of the hair strands at the crown, not the hair roots, skin, background, highlights, or clothing: gray, silver, platinum (near-white cool blonde), white, not_neutral (brown, black, golden blonde, vivid dye), or unknown. Check hair against the face and explicitly distinguish gray/silver/platinum from brown. A small dark parting does not turn light hair brown.
- templeLeft/templeRight: for each viewer side, locate the tip of hair that actually borders the front of the cheek, measured against that side's ear and jaw. Use above_ear, at_ear, cheek, jaw, below_jaw or unknown. Long hair ONLY at the back/nape is not a face-side lock. Do not extend angled bangs at the temple into cheek strands.
- rearHairPattern: classify the main loose lengths you can actually see, including lengths at the sides or over the shoulders; never assert that a hidden back was observed. straight if the main length and ends fall without bends; ends_in or ends_out if only the tips turn under or flip out; low_wave if bends begin low after a mostly straight upper run; loose_wave for broad repeating S-bends; layered_wave for waves with clearly staggered lengths; ringlets for large rounded curls; tight_coils for small tight coils. Ignore tilt, flyaways, bangs and tied/braided sections; use unknown if loose texture is unclear.
- frontHairLeft/frontHairRight: trace each main lock, ponytail, or braid separately on the image-viewer left/right. A lock may start behind the ear and pass over the shoulder onto the FRONT of the garment, even if the temple ends at the ear. Classify the lowest visually supported extent on foreground fabric: shoulder only for a lock visibly on the shoulder fabric that stops near the seam; chest when the lock descends onto the chest below the seam; waist near the waistband. Hair merely near the shoulder or nape does not overlap fabric. Report not_in_front when the visible side has no foreground hair, or unknown if it is occluded or uncertain. Never extend beyond the crop or confuse a bow, scarf, or printed hair with a front lock. frontHairTexture is straight, wavy, braided or unknown.
- upperPattern: torso_blocks for several clearly bounded large color patches on the body only (contrast sleeves), wrap_blocks if the same patches visibly continue on sleeves, torso_gradient only for gradual multicolor transitions on the torso, none or unknown otherwise. upperPalette lists only those observed body colors, largest/base first. For a visibly contrasting sleeve body, give its own hex in leftSleeveColor and rightSleeveColor; these refer to the broad sleeve fabric, not trim. Leave blank if it matches the main body or is unknown.
- skirtBase and skirtCheck: fabric ground and visibly contrasting check line of an observed plaid/check skirt. Sample perceived cloth color, not the shadowed pleat, skin, top, or bow. If plaid has no confident line color leave just skirtCheck blank. For other garments leave both blank.
- beanie: ear_beanie only when small fabric ears/corners visibly protrude from a knit hat; beanie for an ordinary worn knit hat; none or unknown for everything else. beanieBase is the visibly dominant fabric and beanieTrim lists any clearly visible band patches, in screen order. Never use hair, hoodie, background or clip color. A hood on the back of the neck is not headwear.
- sockTop: only for tall socks seen to end separately above shoes, use above_knee (cuff clearly above kneecap), at_knee, or below_knee (cuff visibly below kneecap but taller than mid-calf). Use unknown for tights, short socks, occlusion, or uncertain alignment. Pose alone is not asymmetry.
Colors must be 6-digit #RRGGBB, or empty string if not supported. Palette arrays are empty if unsupported, otherwise at most five distinct #RRGGBB colors. Use muted, light values for visibly pastel fabrics, not the names of colors or generic saturated approximations.`;

export function readAppearanceDetail(value: unknown): AppearanceDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const pick = <T extends string>(allowed: readonly T[], candidate: unknown, fallback: T): T =>
    typeof candidate === "string" && allowed.includes(candidate as T) ? candidate as T : fallback;
  const hex = (input: unknown) => typeof input === "string" && /^#[\da-f]{6}$/i.test(input) ? input.toLowerCase() : "";
  const palette = (input: unknown) => Array.isArray(input) && input.length <= 5 ? [...new Set(input.map(hex).filter(Boolean))] : [];
  return { hairNeutral: pick(neutralHair, v.hairNeutral, "unknown"), templeLeft: pick(templeEnds, v.templeLeft, "unknown"),
    templeRight: pick(templeEnds, v.templeRight, "unknown"), rearHairPattern: pick(rearHairPatterns, v.rearHairPattern, "unknown"),
    frontHairLeft: pick(tips, v.frontHairLeft, "unknown"), frontHairRight: pick(tips, v.frontHairRight, "unknown"),
    frontHairTexture: pick(textures, v.frontHairTexture, "unknown"), upperPattern: pick(patterns, v.upperPattern, "unknown"), upperPalette: palette(v.upperPalette),
    leftSleeveColor: hex(v.leftSleeveColor), rightSleeveColor: hex(v.rightSleeveColor), skirtBase: hex(v.skirtBase), skirtCheck: hex(v.skirtCheck),
    beanie: pick(shapes, v.beanie, "unknown"), beanieBase: hex(v.beanieBase), beanieTrim: palette(v.beanieTrim), sockTop: pick(sockTops, v.sockTop, "unknown") };
}
