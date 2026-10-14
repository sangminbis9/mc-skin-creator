import type { PhotoAnalysis } from "./analysis";
import { observedWearables } from "./observedWearables";

export type OutfitEvidence = "observed" | "strongly_implied" | "conservative";
export type UpperGarmentType =
  | "tshirt"
  | "shirt"
  | "hoodie"
  | "sweater"
  | "jacket"
  | "coat"
  | "dress_upper"
  | "vest"
  | "other";
export type OutfitNeckline =
  | "crew"
  | "v_neck"
  | "open_collar"
  | "shirt_collar"
  | "high_neck"
  | "hood_opening"
  | "layered"
  | "unknown";
export type OutfitSleeveLength =
  | "sleeveless"
  | "short"
  | "elbow"
  | "long"
  | "rolled"
  | "layered";
export type OutfitPatternKind =
  | "none"
  | "horizontal_stripe"
  | "vertical_stripe"
  | "checker_block"
  | "center_graphic"
  | "irregular_group"
  | "color_panel";
export type OutfitAccessoryKind =
  | "bag_strap"
  | "scarf"
  | "bow"
  | "tie"
  | "necklace"
  | "suspenders"
  | "belt"
  | "large_pocket"
  | "hood_string"
  | "wrist_cuff"
  | "choker" | "brooch" | "watch" | "bracelet" | "waist_chain"
  | "thigh_accessory";

export interface OutfitProvenance {
  target: string;
  source: OutfitEvidence;
  evidence: string;
  confidence: number;
}

export interface OutfitColorBlock {
  id: string;
  region:
    | "all"
    | "front_center"
    | "front_left"
    | "front_right"
    | "shoulders"
    | "horizontal_band"
    | "vertical_opening";
  color: string;
  source: OutfitEvidence;
  priority: number;
}

export interface OutfitSleevePlan {
  length: OutfitSleeveLength;
  terminationRow: number;
  color: string;
  source: OutfitEvidence;
  evidence: string;
  /** Observed attached trim only; absent retains historical sleeve material. */
  cuff?: { color: string; source: "observed"; evidence: string };
}

export interface OutfitPatternPlan {
  kind: OutfitPatternKind;
  /** Explicitly observed chest symbol; absent keeps the legacy generic mark. */
  graphicShape?: "cross";
  /** Plaid is crossing bands rather than disconnected check tiles. */
  construction?: "crossed_bands" | "pixel_blocks" | "stepped_gradient";
  /** Named cloth colors; list order is a design input, not measured positions. */
  gradientColors?: string[];
  /** Absent means the renderer's vertical design default, not observed direction. */
  gradientDirection?: "horizontal" | "vertical";
  /** Ordered, explicitly named colors of observed block cloth, not trim. */
  blockColors?: string[];
  /** Separately observed chest ink over cloth; never repeated on sleeves/back. */
  frontGraphic?: { color: string; anchor: "center"; source: "observed"; evidence: string };
  color: string;
  placement: "front" | "wrap" | "front_and_sleeves";
  /** Ordered observed horizontal-band accents; absent for legacy/two-color cloth. */
  stripeColors?: string[];
  /** Observed accents for existing crossed bands; never inferred from plain checks. */
  crossedBandColors?: string[];
  /** Observed local motif ownership in anatomical Minecraft part coordinates.
   * Empty means placement was ambiguous/negated; absent preserves legacy cloth. */
  surfaceParts?: ("body" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg")[];
  motif?: "floral";
  anchor: "left" | "center" | "right";
  frequency: 1 | 2 | 3;
  source: OutfitEvidence;
  evidence: string;
}

export interface OutfitAccessoryPlan {
  kind: OutfitAccessoryKind;
  color: string;
  side: "left" | "center" | "right" | "crossbody";
  source: OutfitEvidence;
  evidence: string;
}

/** A source-parameterized construction, not a provider contract/category.
 * Unknown trim stays absent; unseen trousers remain conservative completion. */
export interface FormalSuitGrammar {
  family: "formal_suit";
  jacketColor: string;
  shirtColor: string;
  tieColor: string | null;
  tieAccent: string | null;
  /** Observed topology independent of hue; absent keeps legacy/plain handling. */
  tiePattern?: "striped";
  /** Authored construction; absent preserves immutable historical rendering. */
  construction?: "connected_tie_tapered_front";
  frontDrape?: "tapered" | "straight_open";
  lapelStyle: "notch" | "peak" | "shawl";
  shirtOpening: number;
  jacketOpening: "open" | "buttoned";
  trouserColor: string;
  shoeColor: string;
}

export interface OutfitIdentityCue {
  id: string;
  salience: number;
  evidence: string;
  targets: string[];
}

export interface OutfitIdentitySaliencePlan {
  primary: OutfitIdentityCue[];
  secondary: OutfitIdentityCue[];
  tertiary: OutfitIdentityCue[];
  pixelBudget: {
    torsoShape: number;
    sleeves: number;
    neckline: number;
    lowerGarment: number;
    pattern: number;
    accessories: number;
  };
}

export interface OutfitPlan {
  coordinateSpace: "minecraft.classic.body_uv";
  formalSuit?: FormalSuitGrammar;
  upper: {
    garmentType: UpperGarmentType;
    baseColor: string;
    accentColor: string;
    neckline: {
      kind: OutfitNeckline;
      width: number;
      depth: number;
      symmetric: boolean;
      innerVisible: boolean;
      source: OutfitEvidence;
    };
    collar: "none" | "paired" | "lapel" | "hood";
    /** Explicit collar palette, or continuation of the shirt material. Legacy
     * plans without this field retain their prior cached accent behavior. */
    collarColor?: string;
    /** Exclusive upper-cloth end. A cropped category alone does not prove
     * exposed skin: the lower material meets it unless a gap is observed. */
    hem?: { endRow: number; skinGapRows: number; source: OutfitEvidence; evidence: string };
    leftSleeve: OutfitSleevePlan;
    rightSleeve: OutfitSleevePlan;
    colorBlocks: OutfitColorBlock[];
    pattern: OutfitPatternPlan;
    backCompletion: "wrap_pattern" | "continue_material" | "plain_conservative";
  };
  lower: {
    garmentType: "pants" | "jeans" | "shorts" | "skirt" | "dress_continuation" | "leggings" | "other";
    baseColor: string;
    waistRow: number;
    garmentRows: number;
    skinExposureRows: number;
    shoeRows: number;
    shoeColor: string;
    shoeStyle?: "sneakers" | "dress_shoes" | "boots" | "loafers" | "sandals";
    pattern: OutfitPatternPlan;
    accent: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
    /** Observed location, with a designed finite frayed-denim glyph. A tear
     * alone does not establish visible skin or an unseen matching knee. */
    kneeDistressing?: { parts: Array<"leftLeg" | "rightLeg">; exposedSkin: boolean; source: "observed"; evidence: string };
    legwear: {
      kind: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
      color: string;
      asymmetry: "none" | "left" | "right" | "both";
      source: OutfitEvidence;
      /** Only a pattern explicitly attached to visible legwear, never a shirt stripe. */
      pattern?: "diagonal_stripe";
    };
    source: OutfitEvidence;
  };
  outerLayer: {
    regions: Array<"collar" | "lapels" | "hood_rim" | "cuffs" | "hem" | "pocket" | "strap" | "skirt_pleats" | "legwear" | "lower_accent" | "lower_fold" | "pattern_depth" | "graphic_depth" | "thigh_accessory" | "shoe_depth">;
    purpose: "physical_depth_only";
    expectedPixels: number;
  };
  accessories: OutfitAccessoryPlan[];
  salience: OutfitIdentitySaliencePlan;
  provenance: OutfitProvenance[];
  observedConstruction: string;
  hiddenCompletion: string;
  lowerBodySource: "observed" | "minimum_inference";
  outerLayerRegions: string[];
  inventionPolicy: "extend_existing_materials_only";
  candidate: { index: number; axis: "baseline" | "neckline_boundary" | "waist_boundary"; cost: number };
}

export interface OutfitCandidateCost {
  garmentStructureError: number;
  dominantColorBlockError: number;
  sleeveError: number;
  necklineError: number;
  waistBoundaryError: number;
  patternLoss: number;
  accessoryLoss: number;
  seamPenalty: number;
  craftPenalty: number;
  outerInflation: number;
  total: number;
}

const COLORS: Record<string, string> = {
  black: "#242326", white: "#eeeae1", gray: "#77777c", grey: "#77777c",
  "light-gray": "#b7b7b7", red: "#b53a35", orange: "#c96d32", yellow: "#d5af3f",
  green: "#467a50", "dark-green": "#284c38", blue: "#416b9d", navy: "#273954",
  // Preserve the observed value class using the existing dark-blue palette.
  "dark-blue": "#273954",
  denim: "#49647d", purple: "#755386", pink: "#c8798c", brown: "#684b38",
  beige: "#c5aa82", cream: "#ded2b6", gold: "#c6a34b", silver: "#b9bec5",
};

function color(value: string | undefined, fallback: string): string {
  if (value && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const normalized = value?.trim().toLowerCase().replace(/[_ ]/g, "-") ?? "";
  return COLORS[normalized] ?? fallback;
}

const COLOR_WORD = "black|white|gray|grey|red|orange|yellow|green|blue|navy|denim|purple|pink|brown|beige|cream|gold|silver";

const UPPER_WORDS = "top|shirt|t-shirt|tshirt|blouse|sweater|sweatshirt|hoodie|jacket|blazer|cardigan|coat|vest|dress|jersey";
const LOWER_WORDS = "pants|trousers|chinos|jeans|shorts|skirt|skort|leggings|bottoms?";
const FOOTWEAR_WORDS = "shoes?|sneakers?|boots?|loafers?|sandals?|footwear";
const ALL_GARMENTS = `${UPPER_WORDS}|${LOWER_WORDS}|${FOOTWEAR_WORDS}|socks?|stockings?`;

/** Footwear height is not a second upper garment. Preserve offsets so the
 * original clause still owns colors and attached graphic evidence. */
function garmentNounScanText(text: string): string {
  return text.replace(/\b(?:low|mid|high)[- ]top(?=\s+(?:sneakers?|shoes?)\b)/g,
    value => " ".repeat(value.length));
}

/** An observed standalone pullover can use the existing sweater construction
 * without inventing knit texture, a hood, or an unseen additional layer. */
export function observedStandaloneSweatshirt(analysis: PhotoAnalysis): boolean {
  return observedStandalonePullover(analysis, "sweatshirt");
}

/** An attached, positively observed hood changes construction, not material.
 * Reuse the standalone/layer/visibility guards; never borrow a nearby hood. */
export function observedStandaloneHoodedSweatshirt(analysis: PhotoAnalysis): boolean {
  return observedStandaloneSweatshirt(analysis) &&
    new RegExp(`\\bhooded[- ]+(?:(?:${COLOR_WORD})[- ]+)?sweatshirt\\b`).test(analysis.observed.clothing.toLowerCase());
}

function observedStandalonePullover(analysis: PhotoAnalysis, garment: "sweatshirt" | "hoodie"): boolean {
  const text = analysis.observed.clothing.toLowerCase();
  const attachedGraphic = observedAttachedChestGraphic(analysis);
  const construction = attachedGraphic ? text.replace(attachedGraphic.evidence, "") : text;
  return analysis.visibleRegions.upperBody && analysis.renderHints.outerGarment === "none" &&
    new RegExp(`\\b${garment}\\b`).test(text) &&
    !/\b(?:over|under|underneath|layered|no|not|without|possibly|maybe|uncertain|hidden|obscured|unknown|print|graphic|motif)\b/.test(construction) &&
    [...garmentNounScanText(text).matchAll(new RegExp(`\\b(?:${UPPER_WORDS})\\b`, "g"))].length === 1;
}

/** A bounded positive attachment, not a garment depicted in a graphic.
 * Do not borrow color/placement from another garment, accessory or prompt. */
function observedAttachedChestGraphic(analysis: PhotoAnalysis): OutfitPatternPlan | null {
  const text = analysis.observed.clothing.toLowerCase();
  if (!analysis.visibleRegions.upperBody || analysis.renderHints.outerGarment !== "none" ||
    /\b(?:over|under|underneath|layered|no|not|without|possibly|maybe|uncertain|unknown|hidden|obscured|occluded|picture|depicting|depiction)\b/.test(text)) return null;
  const garments = [...garmentNounScanText(text).matchAll(new RegExp(`\\b(?:${UPPER_WORDS})\\b`, "g"))];
  if (garments.length !== 1) return null;
  const garment = garments[0];
  if (!/^(?:hoodie|sweatshirt|sweater|shirt|t-shirt|tshirt|top)$/.test(garment[0])) return null;
  const after = text.slice(garment.index + garment[0].length);
  // Tonal describes contrast, not a missing color. Keep requiring explicit ink
  // and chest attachment. Printed/embossed uncertainty does not change the
  // observed symbol or authorize a raised duplicate garment layer.
  const graphicNoun = "(?:graphic|logo|print|motif|emblem)";
  const application = "(?: (?:printed|embossed)(?:/(?:printed|embossed))?)?";
  const chestEnd = "(?=[,.;]|$| and (?:a )?(?:front )?kangaroo pocket(?=[,.;]|$))";
  const match = new RegExp(`^ (?:with|featuring) (?:a |an )?(?:(?:large|small|stylized|centered)[, ]+){0,2}(?:(?:matte|tonal) )?(${COLOR_WORD}|dark) (?:(?:gothic )?(cross) ${graphicNoun}|${graphicNoun}( (?:of a (?:stylized )?)?cross)?)${application} on (?:the )?(?:center |central )?chest${chestEnd}`).exec(after);
  if (!match) return null;
  // Explicit achromatic "dark" ink uses the existing neutral dark palette;
  // it is not an unknown color and must not inherit a white shoe/accent swatch.
  return { kind: "center_graphic", ...(match[2] || match[3] ? { graphicShape: "cross" as const } : {}),
    color: match[1] === "dark" ? COLORS.black : color(match[1], COLORS.black), placement: "front", surfaceParts: ["body"], anchor: "center",
    frequency: 2, source: "observed", evidence: match[0] };
}

/** Bind prose to a garment before interpreting its pattern, palette or sleeve.
 * Coordinated colors stay together; another garment or layer ends ownership.
 */
function garmentEvidence(text: string, garmentWords: string): string {
  const wanted = new RegExp(`^(${garmentWords})$`);
  for (const clause of text.replace(/\bdress shoes\b/g, "shoes").split(/[.;\n]|\b(?:over|under)\b/)) {
    const items = [...garmentNounScanText(clause).matchAll(new RegExp(`\\b(?:${ALL_GARMENTS})\\b`, "g"))];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!wanted.test(item[0])) continue;
      // Keep the newly recognized noun as a color-ownership boundary, but do
      // not promote an ambiguous or layered sweatshirt to the dominant top.
      if (item[0] === "sweatshirt" && /\b(?:over|under|underneath|layered|no|not|without|possibly|maybe|uncertain|hidden|obscured|unknown|print|graphic|motif)\b/.test(text)) continue;
      const previousEnd = i ? items[i - 1].index! + items[i - 1][0].length : 0;
      let prefix = clause.slice(previousEnd, item.index);
      if (i) prefix = prefix.split(/,|\b(?:and|with)\b/).at(-1) ?? "";
      let suffix = clause.slice(item.index! + item[0].length, items[i + 1]?.index);
      if (items[i + 1]) suffix = suffix.split(/,|\b(?:and|with)\b/)[0];
      return `${prefix}${item[0]}${suffix}`.trim();
    }
  }
  return "";
}

function garmentColorFromText(text: string, garmentWords: string, fallback: string): string {
  const scoped = garmentEvidence(text, garmentWords) || text;
  const match = new RegExp(`\\b(?:(bright|dark|light|muted|soft|dusty)[- ])?(${COLOR_WORD})\\b`).exec(scoped);
  if (!match) return fallback;
  const modified = match[1] ? `${match[1]}-${match[2]}` : "";
  return COLORS[modified] ?? color(match[2], fallback);
}

/** A named stripe/check color belongs to the pattern, not to an inner layer,
 * sleeve, accessory or lower garment that happens to share the cached accent. */
function observedPatternPalette(text: string, fallback: string, material: string): string[] {
  if (/\b(?:no|not|without|possibly|maybe|hidden|occluded)\b/.test(text)) return [fallback];
  // These two names already share one palette entry. A slash alias must not
  // split an otherwise explicit coordinated list and discard earlier colors.
  text = text.replace(/\b(?:tan\s*\/\s*beige|beige\s*\/\s*tan)\b/g, "tan");
  // Keep compound navy blue as one existing palette value, not an extra blue
  // accent when the garment material is already navy.
  const token = `(?:teal(?:/green)?|navy[- ]blue|(?:(?:dark|light)[- ])?(?:${COLOR_WORD}|tan))`;
  const paletteColor = (list: string): string[] => {
    const palette = [...list.matchAll(new RegExp(token, "g"))].map(item => item[0] === "tan" ? COLORS.beige
      : /^teal(?:\/green)?$/.test(item[0]) ? "#2f7775"
      : /^navy[- ]blue$/.test(item[0]) ? COLORS.navy
      // Match garmentColorFromText: if a shade has no dedicated swatch, keep
      // its named base color ("dark navy"), not the unrelated garment material.
      : color(item[0], color(item[0].replace(/^(?:dark|light)[- ]/, ""), material)));
    const accents = [...new Set(palette.filter(value => value !== material))];
    return accents.length ? accents : [palette[0] ?? fallback];
  };
  // Preserve the entire coordinated palette before the pattern noun. Otherwise
  // the nearest-color shortcut promotes "thin yellow stripes" over the tan
  // in "blue, tan, and thin yellow stripes". Use the same palette priority as
  // the already-supported postposed "stripes in blue, tan and yellow" form.
  // Bare tonal descriptors can share the list without erasing named colors.
  // paletteColor intentionally extracts only color tokens: "dark"/"light"
  // alone do not establish black/white (or any other invented RGB).
  const member = `(?:thin[- ]+)?(?:${token}|dark|light)(?:/(?:dark|light))?`;
  // The same explicit palette can precede the pattern noun: "blue, tan,
  // and dark navy plaid/checkered pattern". It is already garment-scoped;
  // preserve the list without borrowing collar/lower-garment accent colors.
  // "Brown and beige plaid pleated skirt" owns the same cloth palette as
  // "skirt with a brown and beige plaid pattern". Keep requiring an attached
  // pattern/garment noun inside this garment's scope, not a global color list.
  const preposed = new RegExp(`\\b(${member}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${member})+)[- ]+(?:plaid(?:/checkered)?|checkered|checked)[- ]+(?:pattern|(?:pleated[- ]+)?(?:${UPPER_WORDS}|${LOWER_WORDS}))\\b`).exec(text)?.[1];
  if (preposed) return paletteColor(preposed);
  // A pattern's explicit "featuring" list carries all named colors, including
  // a thin white/light line. The tonal alias adds no invented color. Require
  // a pattern noun and list terminator so collar/shoe colors cannot leak in.
  const featuring = new RegExp(`\\b(?:plaid(?:/checkered)?|checkered) pattern featuring (${member}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${member})+)(?=\\s+(?:stripes?|lines?|checks?|bands?)\\b|\\s*[.;]|\\s*$)`).exec(text)?.[1];
  if (featuring) return paletteColor(featuring);
  const direction = `(?:(?:horizontal|vertical)(?:[- ]+(?:and|&)[- ]+(?:horizontal|vertical))?|plaid|checkered)`;
  const coordinated = new RegExp(`\\b(${member}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${member})+)[- ]+(?:${direction}[- ]+)?(?:stripes?|lines?|checks?|bands?)\\b`).exec(text)?.[1];
  if (coordinated) return paletteColor(coordinated);
  // Explicit check-square palettes can follow "consisting of". Keep their
  // ordered named colors (including slash descriptions), not a cached accent.
  // This parses palette evidence only; it does not invent crossed-band topology.
  const squares = new RegExp(`\\bcheckered pattern consisting of (${token}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*/\\s*)${token})+) squares\\b`).exec(text)?.[1];
  if (squares) return paletteColor(squares);
  const match = new RegExp(`\\b(${COLOR_WORD}|tan)[- ]+(?:${direction}[- ]+)?(?:stripes?|lines?|checks?|bands?)\\b`).exec(text);
  // Tan is represented by the existing warm neutral Minecraft palette entry.
  if (match) return [match[1] === "tan" ? COLORS.beige : color(match[1], fallback)];
  // A postposed palette belongs to the observed pattern, not the cached collar accent.
  // Accept only an explicit color list, within the already scoped garment.
  const list = new RegExp(`\\b(?:stripes?|lines?|checks?|bands?|(?:striped|plaid(?:/checkered)?|checkered) pattern) in (?:shades of )?(${token}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${token})*)\\b`).exec(text)?.[1];
  if (!list) return [fallback];
  return paletteColor(list);
}

function observedCrossedStripes(text: string): boolean {
  if (/\b(?:no|not|without|possibly|maybe|hidden|occluded)\b/.test(text)) return false;
  const axes = /\b(horizontal|vertical)(?: stripes?)?\s+(?:and|&)\s+(horizontal|vertical)\s+(?:stripes?|lines?|bands?)\b/.exec(text);
  return !!axes && axes[1] !== axes[2];
}

const CLOTH_SWATCHES: Record<string, string> = { ...COLORS, lavender: "#b6a2cc", lilac: "#b6a2cc", cyan: "#42b8b0", mint: "#8fc7af", "light blue": "#7fc3e8", "light-blue": "#7fc3e8", tan: COLORS.beige };
const CLOTH_COLOR_TOKEN = `(?:light[- ]blue|lavender|lilac|cyan|mint|tan|${COLOR_WORD})`;
const pastelClothPalette = (palette: string[]) => palette.map(hex => "#" + [1, 3, 5].map((i, ch) =>
  Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * 0.65 + [248, 246, 240][ch] * 0.35).toString(16).padStart(2, "0")).join(""));

/** Explicit whole-cloth gradient, not a checker print inferred from its colors.
 * Only a complete palette owned by the visible upper garment is accepted. */
function observedGradientPattern(text: string): OutfitPatternPlan | null {
  if (/\b(?:no|not|without|possibly|maybe|uncertain|unknown|unclear|hidden|occluded|absent|logo|graphic|scarf|hat|bag|depicting|front|back|diagonal|radial)\b/.test(text)) return null;
  const list = `${CLOTH_COLOR_TOKEN}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${CLOTH_COLOR_TOKEN})+`;
  // A parenthesized palette is the same explicit list, not permission to infer
  // rainbow colors. A closed construction-only sleeve suffix owns no pigment.
  const match = new RegExp(`\\b(?:with|featuring) (?:a )?(pastel )?(?:rainbow )?(?:(horizontal|vertical) )?(?:colou?r )?gradient(?: pattern)?(?: of (${list})| \\((${list})\\))(?: and (?:ruffled|puff) sleeves)?\\s*$`).exec(text);
  if (!match) return null;
  // Puff sleeves are garment construction in a preceding closed clause, not
  // authorization to borrow a gradient attached to a sleeve/trim/accessory.
  const owner = text.slice(0, match.index).replace(/ with puff sleeves,\s*$/, "")
    .replace(new RegExp(`\\bpuff-sleeve(?= (?:${UPPER_WORDS})\\b)`, "g"), "");
  if (/\b(?:sleeves?|cuffs?|collar|pocket|lining|hood|bow|ribbon|necklace|panel|motif|print|picture|depicts)\b/.test(owner)) return null;
  const palette = [...new Set((match[3] ?? match[4]).match(new RegExp(CLOTH_COLOR_TOKEN, "g"))!.map(name => CLOTH_SWATCHES[name]))];
  if (palette.length < 2 || palette.length > 5) return null;
  const gradientColors = match[1] ? pastelClothPalette(palette) : palette;
  return { kind: "color_panel", construction: "stepped_gradient", gradientColors,
    ...(match[2] ? { gradientDirection: match[2] as "horizontal" | "vertical" } : {}),
    color: gradientColors[0], placement: "wrap", anchor: "center", frequency: 2,
    source: "observed", evidence: text };
}

/** An explicit multicolor block print is distinct from knit texture and plaid.
 * Require a complete garment-owned palette; never borrow a cached accent,
 * hidden completion, logo color or another garment's ink. */
function observedBlockPattern(text: string): OutfitPatternPlan | null {
  const swatches = CLOTH_SWATCHES, token = CLOTH_COLOR_TOKEN;
  if (/\b(?:no|not|without|possibly|maybe|uncertain|unknown|unclear|hidden|occluded|absent)\b/.test(text)) return null;
  // Separate only complete, positive, terminal detail clauses. Their words
  // cannot supply the cloth palette; any unresolved ownership stays rejected.
  const withoutTrim = text.replace(new RegExp(`(?:, | with | and )${token} (?:ribbed )?cuffs$`), "");
  const graphic = new RegExp(`(?: and | with )(?:a )?(?:central|centered) (dark|light|${COLOR_WORD}) (?:pixel )?(?:face )?(?:graphic|logo)(?: on (?:the )?chest)?$`).exec(withoutTrim);
  const cloth = graphic ? withoutTrim.slice(0, graphic.index) : withoutTrim;
  // A whole-garment color-block modifier owns its palette independently of
  // accompanying details. Keep the legacy singular-cuff form here too.
  const colorBlockGarment = new RegExp(`^(?:(?:a|an|the) )?(?:(?:oversized|loose|fitted|pastel) )*colou?r[- ]block (?:${UPPER_WORDS})\\b`).exec(cloth);
  const scoped = colorBlockGarment ? cloth.replace(new RegExp(` with ${token} cuffs?$`), "") : cloth;
  if (/\b(?:no|not|without|possibly|maybe|uncertain|unknown|unclear|hidden|occluded|absent|logo|graphic|scarf|hat|bag|sleeve|sleeves|cuff|cuffs|chest|front|back)\b/.test(scoped)) return null;
  // Explicit checker squares use the same bounded tile palette as blocks.
  // Plaid/crossed-stripe evidence remains with the existing band construction.
  const checker = !/\b(?:plaid|tartan|crossed|stripes?|horizontal|vertical)\b/.test(text)
    ? "|(?:checkered|checked|checkerboard)(?:\\s*/\\s*pixelated)?" : "";
  const list = `${token}(?:(?:,\\s*(?:and\\s+)?|\\s+and\\s+)${token})+`;
  // A slash joins the same compound descriptor as a comma/space; retain its
  // directly attached pastel modifier instead of restarting at the second word.
  const construction = `(?:pixelated(?:(?:,?\\s+|\\s*/\\s*)(?:blocky|patchwork))?|blocky|pixel[- ]block|geometric block${checker})`;
  const paletteLink = "(?:in|consisting of|featuring)";
  // Palette carriers vary independently of construction. Require the entire
  // known-color list and its optional shape terminator to end this scope;
  // never skip unknown colors or trailing accessory/location descriptions.
  const match = new RegExp(`\\b(pastel )?${construction} pattern ${paletteLink} (pastel shades of |shades of )?(${list})(?: squares| blocks)?\\s*$`).exec(scoped);
  // Parentheses are an explicit complete palette carrier, not arbitrary prose
  // to search for scattered color words. Anchor it to the upper garment.
  const parenthesized = new RegExp(`^(?:(?:a|an|the) )?(?:(?:oversized|loose|fitted|long-sleeved|short-sleeved) )*(?:${UPPER_WORDS}) (?:with|featuring) (pastel )?${construction} blocks \\((${list})\\)$`).exec(scoped);
  const blocks = colorBlockGarment ? new RegExp(`\\bin (${list}) blocks\\s*$`).exec(scoped) : null;
  const paletteText = match?.[3] ?? blocks?.[1] ?? parenthesized?.[2];
  if (!paletteText) return null;
  const named = paletteText.match(new RegExp(token, "g"))!;
  const palette = [...new Set(named.map(name => swatches[name]))];
  // Preserve all five named colors when observed; never truncate a longer or
  // partly unknown list to manufacture a supported compact palette.
  if (palette.length < 2 || palette.length > 5) return null;
  const garment = new RegExp(`\\b(?:${UPPER_WORDS})\\b`).exec(text);
  const pastelGarment = !!garment && /^(?:(?:a|an|the) )?pastel[- ]colou?red (?:(?:oversized|loose|fitted|long|short)[- ]+)*$/.test(text.slice(0, garment.index));
  // Pastel is observed value/saturation evidence. This is a reusable compact
  // palette ramp, not photo sampling or a target-bitmap color lookup.
  const blockColors = match?.[1] || match?.[2]?.startsWith("pastel") || parenthesized?.[1] || pastelGarment || (blocks && /\bpastel\b/.test(colorBlockGarment![0])) ? pastelClothPalette(palette) : palette;
  return { kind: "checker_block", construction: "pixel_blocks", blockColors, color: blockColors[0],
    ...(graphic ? { frontGraphic: { color: graphic[1] === "dark" ? COLORS.black : graphic[1] === "light" ? COLORS.white : COLORS[graphic[1]],
      anchor: "center" as const, source: "observed" as const, evidence: graphic[0].trim() } } : {}),
    placement: "wrap", anchor: "center", frequency: 2, source: "observed", evidence: text };
}

function shirtCollarColor(text: string, material: string, accent: string): string {
  if (/\b(?:no|not|without|possibly|maybe|hidden|occluded)\b/.test(text)) return material;
  const match = new RegExp(`\\b(?:(dark|light)[- ])?(${COLOR_WORD}|tan)[- ]+(?:collar|collared)\\b`).exec(text);
  if (match) return match[2] === "tan" ? COLORS.beige : color(match[1] ? `${match[1]}-${match[2]}` : match[2], color(match[2], material));
  return /\bcontrast(?:ing)?[- ]collar\b/.test(text) ? accent : material;
}

function evidenceText(analysis: PhotoAnalysis): string {
  const design = analysis.inferred.lowerBodyDesign;
  return `${analysis.observed.clothing} ${analysis.observed.accessories} ${analysis.outfitPrompt} ${analysis.inferred.lowerBody?.value ?? ""} ${analysis.inferred.shoes?.value ?? ""} ${design ? `${design.bottomType} ${design.bottomPattern} ${design.bottomAccent} ${design.legwear} ${design.legwearAsymmetry} ${design.thighAccessory} ${design.thighAccessorySide} ${design.shoeStyle} ${design.rationale}` : ""}`.toLowerCase();
}

function upperType(analysis: PhotoAnalysis, text: string): UpperGarmentType {
  if (analysis.renderHints.outerGarment === "coat" || /\bcoat\b/.test(text)) return "coat";
  if (analysis.renderHints.outerGarment === "open_jacket" || /\b(?:jacket|cardigan)\b/.test(text)) return "jacket";
  if (analysis.renderHints.outerGarment === "vest" || /\bvest\b/.test(text)) return "vest";
  if (observedStandaloneSweatshirt(analysis)) return observedStandaloneHoodedSweatshirt(analysis) ? "hoodie" : "sweater";
  const value = analysis.fallbackFeatures.topType;
  // An explicit, visible standalone button shirt is stronger construction
  // evidence than a contradictory generic dress category. Do not reinterpret
  // shirt dresses, layered/hidden garments or inferred completion text.
  const observed = analysis.observed.clothing.toLowerCase();
  if (value === "dress" && analysis.visibleRegions.upperBody &&
    /\bbutton[- ](?:down|up) shirt\b/.test(observed) &&
    !/\b(?:dress|gown|tunic|sweater|hoodie|over|under|underneath|layered|no|not|without|possibly|maybe|uncertain|hidden|obscured)\b/.test(observed)) return "shirt";
  if (value === "dress") return "dress_upper";
  if (["tshirt", "shirt", "hoodie", "sweater", "jacket"].includes(value)) return value as UpperGarmentType;
  return "other";
}

function neckline(type: UpperGarmentType, text: string, neckAccessory: PhotoAnalysis["renderHints"]["neckAccessory"]): OutfitPlan["upper"]["neckline"] {
  let kind: OutfitNeckline = "crew";
  if (/\b(?:turtleneck|high[- ]neck|mock[- ]neck)\b/.test(text)) kind = "high_neck";
  else if (/\bv[- ]neck\b/.test(text)) kind = "v_neck";
  else if (/\b(?:open collar|open[- ]front|open [^.]{0,20}jacket|unbuttoned)\b/.test(text)) kind = "open_collar";
  else if (type === "hoodie") kind = "hood_opening";
  else if (neckAccessory === "collar" || type === "shirt") kind = "shirt_collar";
  else if (["jacket", "coat", "vest"].includes(type) || /\b(?:over|under|inner shirt|layered)\b/.test(text)) kind = "layered";
  return {
    kind,
    width: kind === "high_neck" ? 2 : kind === "crew" ? 4 : 5,
    depth: kind === "high_neck" ? 1 : kind === "crew" ? 2 : kind === "v_neck" ? 4 : 3,
    symmetric: !/asymmetr|one[- ]sided/.test(text),
    innerVisible: ["open_collar", "shirt_collar", "layered", "hood_opening"].includes(kind),
    source: kind === "crew" && !/\bcrew\b/.test(text) ? "strongly_implied" : "observed",
  };
}

function sleeveLength(base: string, text: string, side: "left" | "right"): OutfitSleeveLength {
  const sidePattern = new RegExp(`(?:${side}|viewer[- ]${side})[- ]+sleeve(?:s| is| are)?[- ]+(sleeveless|short|elbow|rolled|long|layered)`);
  const match = sidePattern.exec(text)?.[1];
  if (match && ["sleeveless", "short", "elbow", "rolled", "long", "layered"].includes(match)) return match as OutfitSleeveLength;
  if (/\b(?:sleeveless|tank top)\b/.test(text)) return "sleeveless";
  if (/\b(?:rolled sleeves?|rolled-up sleeves?)\b/.test(text)) return "rolled";
  if (/\b(?:elbow|three[- ]quarter|3\/4)[- ](?:length )?sleeves?\b/.test(text)) return "elbow";
  if (/\blayered sleeves?\b/.test(text)) return "layered";
  if (/\blong[- ]sleeved?\b|\blong sleeves?\b/.test(text)) return "long";
  if (/\bshort[- ]sleeved?\b|\bshort sleeves?\b/.test(text)) return "short";
  return base === "long" ? "long" : base === "sleeveless" ? "sleeveless" : "short";
}

function sleeveRows(length: OutfitSleeveLength): number {
  return { sleeveless: 0, short: 4, elbow: 7, rolled: 8, layered: 10, long: 11 }[length];
}

function pattern(text: string, texture: PhotoAnalysis["renderHints"]["garmentTexture"], accent: string, crossedStripes = false): OutfitPatternPlan {
  let kind: OutfitPatternKind = "none";
  let placement: OutfitPatternPlan["placement"] = "front";
  // Plaid is formed by crossing stripes. The component word must not erase
  // the explicitly named two-axis pattern belonging to this garment.
  const explicitPlaid = /\b(?:plaid|checkered|checked)\b/.test(text) &&
    !/\b(?:no|not|without)\b[^.;]{0,24}\b(?:plaid|checkered|checked)\b/.test(text);
  if (explicitPlaid || crossedStripes) {
    kind = "checker_block";
    placement = "wrap";
  } else if (/\b(?:horizontal|striped|stripes)\b/.test(text) || texture === "striped") {
    kind = /\bvertical(?:ly)?\b/.test(text) ? "vertical_stripe" : "horizontal_stripe";
    placement = "wrap";
  } else if (/\b(?:graphic|badge|marking|large logo|center logo)\b/.test(text)) {
    kind = "center_graphic";
  } else if (texture === "patterned" || /\b(?:floral|patterned|irregular)\b/.test(text)) {
    kind = "irregular_group";
  }
  const anchor = /viewer[- ]left|left chest/.test(text) ? "left" : /viewer[- ]right|right chest/.test(text) ? "right" : "center";
  return { kind, ...(crossedStripes || (explicitPlaid && /\bplaid\b/.test(text)) ? { construction: "crossed_bands" as const } : {}), color: accent, placement, anchor, frequency: kind === "horizontal_stripe" ? 3 : 2, source: kind === "none" ? "conservative" : "observed", evidence: text };
}

// Named roses are flower motifs, but the color names rose pink/gold/colored
// are not. Singular "rose" requires an explicit motif noun or placement.
const FLORAL_MOTIF_TERM = "(?:floral|flowers?|roses|rose(?=[- ]+(?:prints?|patterns?|motifs?|graphics?|embroidery|on)\\b))";
const floralMotif = new RegExp(`\\b${FLORAL_MOTIF_TERM}\\b`);

/** Local floral evidence, not a family-wide permission to decorate both limbs.
 * Prose has already been bound to one observed garment. Viewer sides invert;
 * unqualified left/right are the wearer's sides. A single unspecified limb is
 * deliberately not guessed. Unseen/rejected clauses never supply a motif. */
function observedFloralParts(text: string, upper: boolean): OutfitPatternPlan["surfaceParts"] {
  if (!floralMotif.test(text)) return undefined;
  const parts = new Set<NonNullable<OutfitPatternPlan["surfaceParts"]>[number]>();
  for (const clause of text.split(/[;,]|\b(?:and|but|while)\b/)) {
    if (!floralMotif.test(clause) || /\b(?:no|not|without|possibly|maybe|unclear|hidden|occluded)\b/.test(clause)) continue;
    const locations = [...clause.matchAll(/\b(?:(viewer|wearer|subject)(?:'s)?[- ]+)?(?:(left|right|both|one|single)[- ]+)?(?:(?:upper|lower)[- ]+)?(sleeves?|arms?|legs?|chest|torso|front|back)\b/g)];
    if (!locations.length) { if (upper) parts.add("body"); continue; }
    for (const location of locations) {
      const [, perspective, side, name] = location;
      if (/^(?:chest|torso|front)$/.test(name)) { if (upper) parts.add("body"); continue; }
      if (name === "back" || (upper ? !/^(?:sleeve|arm)/.test(name) : !/^leg/.test(name))) continue;
      const right = upper ? "rightArm" : "rightLeg", left = upper ? "leftArm" : "leftLeg";
      if (side === "both" || (!side && name.endsWith("s"))) { parts.add(right); parts.add(left); }
      else if (side === "left" || side === "right") parts.add((side === "right") !== (perspective === "viewer") ? right : left);
    }
  }
  return [...parts];
}

/** Family selection consumes the same visible, garment-bound motif evidence
 * as the plan. A rose accessory or an inferred hidden pattern is not clothing ink. */
export function hasObservedFloralGarment(analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">): boolean {
  const text = analysis.observed.clothing.toLowerCase();
  // The family can recognize a motif without guessing which single sleeve
  // owns it. Exact surfaceParts remain the separate rendering permission.
  const positive = (words: string) => garmentEvidence(text, words).split(/[;,]|\b(?:and|but|while)\b/)
    .some(clause => floralMotif.test(clause) && !/\b(?:no|not|without|possibly|maybe|unclear|hidden|occluded)\b/.test(clause));
  return (analysis.visibleRegions.upperBody && positive(UPPER_WORDS))
    || (analysis.visibleRegions.lowerBody && positive(LOWER_WORDS));
}

function scopeObservedFloral(plan: OutfitPatternPlan, text: string, upper: boolean): void {
  const surfaceParts = observedFloralParts(text, upper);
  if (surfaceParts === undefined) return;
  Object.assign(plan, { kind: surfaceParts.length ? "irregular_group" : "none", motif: "floral", surfaceParts,
    placement: "front", source: surfaceParts.length ? "observed" : "conservative", evidence: text });
  // A common topAccentColor can describe a collar or another garment. Bind
  // named ink to this garment's positive flower clause before falling back.
  if (!surfaceParts.length) return;
  const ink = new RegExp(`\\b(${COLOR_WORD}|tan)[- ]+${FLORAL_MOTIF_TERM}\\b|\\b${FLORAL_MOTIF_TERM}(?: (?:prints?|motifs?|graphics?))? in (${COLOR_WORD}|tan)\\b`);
  for (const clause of text.split(/[;,]|\b(?:and|but|while)\b/)) {
    if (/\b(?:no|not|without|possibly|maybe|unclear|hidden|occluded)\b/.test(clause)) continue;
    const match = ink.exec(clause), named = match?.[1] ?? match?.[2];
    if (named) { plan.color = named === "tan" ? COLORS.beige : color(named, plan.color); break; }
  }
}

/** Visible garment evidence only; callers retain the visibility gate. Pure so
 * stored plans can be replayed without reconstructing omitted provider prompts. */
export function resolveObservedFloralPattern(plan: OutfitPatternPlan, clothing: string, upper: boolean): OutfitPatternPlan {
  const result = { ...plan };
  scopeObservedFloral(result, garmentEvidence(clothing.toLowerCase(), upper ? UPPER_WORDS : LOWER_WORDS), upper);
  return result;
}

function lowerPattern(analysis: PhotoAnalysis, text: string, accent: string, material: string): OutfitPatternPlan {
  const structured = analysis.inferred.lowerBodyDesign?.bottomPattern;
  const value = /\b(?:plaid|checkered|checked)\b/.test(text) ? "plaid" : /\b(?:striped|stripes)\b/.test(text) ? "striped" : /\bpleated?\b/.test(text) ? "pleated" : analysis.renderHints.bottomPattern !== "plain" ? analysis.renderHints.bottomPattern : structured ?? "plain";
  const kind: OutfitPatternKind = value === "striped" ? "horizontal_stripe" : value === "plaid" ? "checker_block" : value === "pleated" ? "vertical_stripe" : value === "lace" ? "irregular_group" : "none";
  const observedLower = garmentEvidence(analysis.observed.clothing.toLowerCase(), LOWER_WORDS);
  // The upper accent can belong to a collar or inner shirt. Reuse the bounded
  // palette resolver only for positively observed lower-garment plaid; hidden,
  // prompt-only and accessory-local pigments retain the conservative accent.
  const patternColor = analysis.visibleRegions.lowerBody && kind === "checker_block" &&
    /\b(?:plaid|checkered|checked)\b/.test(observedLower) &&
    !/\b(?:scarf|bow|ribbon|belt|bag|accessory|logo|graphic)\b/.test(observedLower)
    ? observedPatternPalette(observedLower, accent, material)[0] : accent;
  return { kind, color: patternColor, placement: kind === "none" ? "front" : "wrap", anchor: "center", frequency: 2, source: analysis.visibleRegions.lowerBody && kind !== "none" ? "observed" : "conservative", evidence: analysis.observed.clothing };
}

function accessoryPlans(analysis: PhotoAnalysis, text: string, accent: string): OutfitAccessoryPlan[] {
  const result: OutfitAccessoryPlan[] = [];
  const add = (kind: OutfitAccessoryKind, side: OutfitAccessoryPlan["side"] = "center") => result.push({ kind, color: accent, side, source: "observed", evidence: text });
  if (/\b(?:crossbody|cross-body|diagonal bag|bag strap)\b/.test(text)) add("bag_strap", "crossbody");
  if (analysis.renderHints.neckAccessory === "tie") add("tie");
  if (analysis.renderHints.neckAccessory === "bow" || /\b(?:bow collar|neck bow)\b/.test(text)) add("bow");
  else if (analysis.renderHints.neckAccessory === "scarf" || /\bneck scarf\b/.test(text)) add("scarf");
  if (analysis.renderHints.necklace !== "none" || /\b(?:necklace|pendant|neck[- ]chain|chain necklace)\b/.test(text)) {
    const necklaceColor = /\bsilver\b/.test(text) || analysis.renderHints.necklace === "silver" ? COLORS.silver : /\bgold\b/.test(text) || analysis.renderHints.necklace === "gold" ? COLORS.gold : accent;
    result.push({ kind: "necklace", color: necklaceColor, side: "center", source: "observed", evidence: text });
  }
  if (/\bsuspenders?\b/.test(text)) add("suspenders");
  if (analysis.renderHints.bottomAccent === "belt" || analysis.inferred.lowerBodyDesign?.bottomAccent === "belt" || /\b(?:belt|waistband)\b/.test(text)) add("belt");
  if (/\b(?:large pocket|patch pocket)\b/.test(text)) add("large_pocket", /left/.test(text) ? "left" : /right/.test(text) ? "right" : "center");
  if (/\bhood strings?\b/.test(text)) add("hood_string");
  const designAccessory = analysis.inferred.lowerBodyDesign?.thighAccessory;
  const designSide = analysis.inferred.lowerBodyDesign?.thighAccessorySide;
  const hasThighAccessory = analysis.renderHints.thighAccessory !== "none" || (designAccessory && designAccessory !== "none") || /\b(?:thigh|leg)[- ]+(?:bow|ribbon)|(?:bow|ribbon)[^.]{0,20}\b(?:thigh|leg)\b/.test(text);
  if (hasThighAccessory) {
    const side = analysis.renderHints.thighAccessorySide !== "none" ? analysis.renderHints.thighAccessorySide : designSide !== "none" && designSide ? designSide : /viewer[- ]left/.test(text) ? "left" : /viewer[- ]right/.test(text) ? "right" : "center";
    result.push({ kind: "thigh_accessory", color: /\bwhite\b/.test(text) ? COLORS.white : accent, side: side === "both" ? "center" : side, source: analysis.visibleRegions.lowerBody ? "observed" : "strongly_implied", evidence: text });
  }
  return [...result, ...observedWearables(analysis)];
}

function lowerTypeFromText(analysis: PhotoAnalysis, text: string, upper: UpperGarmentType): OutfitPlan["lower"]["garmentType"] {
  if (upper === "dress_upper") return "dress_continuation";
  const structured = analysis.inferred.lowerBodyDesign?.bottomType;
  if (!analysis.visibleRegions.lowerBody && structured) {
    if (structured === "skirt") return "skirt";
    if (structured === "shorts") return "shorts";
    if (structured === "jeans") return "jeans";
    if (structured === "pants") return "pants";
  }
  if (/\bskort\b/.test(text)) return "skirt";
  if (/\b(?:skirt|maxi skirt|mini skirt)\b/.test(text)) return "skirt";
  if (/\bshorts\b/.test(text)) return "shorts";
  if (/\bjeans\b/.test(text)) return "jeans";
  if (/\bleggings\b/.test(text)) return "leggings";
  if (/\b(?:pants|trousers|chinos)\b/.test(text)) return "pants";
  const fallback = analysis.fallbackFeatures.bottomType;
  return fallback === "jeans" || fallback === "shorts" || fallback === "skirt" ? fallback : "pants";
}

function legwearFromText(analysis: PhotoAnalysis, text: string, fallbackColor: string): OutfitPlan["lower"]["legwear"] {
  let kind = analysis.renderHints.legwear !== "none" ? analysis.renderHints.legwear : analysis.inferred.lowerBodyDesign?.legwear ?? "none";
  if (/\bleg warmers?\b/.test(text)) kind = "leg_warmers";
  else if (/\bthigh[- ]highs?\b|\bthigh[- ]high (?:socks?|stockings?)\b|\bover[- ]knee socks?\b|\botk socks?\b/.test(text)) kind = "thigh_highs";
  else if (/\bstockings?\b/.test(text)) kind = "stockings";
  else if (/\bsocks?\b/.test(text)) kind = "socks";
  let asymmetry = analysis.renderHints.legwearAsymmetry !== "none" ? analysis.renderHints.legwearAsymmetry : analysis.inferred.lowerBodyDesign?.legwearAsymmetry ?? "none";
  if (/\b(?:on )?(?:viewer[- ])?left\b[^.]{0,50}\b(?:sock|stocking|leg warmer|thigh[- ]high|otk)/.test(text) || /\bone (?:viewer[- ])?left (?:leg warmer|sock|stocking)/.test(text)) asymmetry = "left";
  else if (/\b(?:on )?(?:viewer[- ])?right\b[^.]{0,50}\b(?:sock|stocking|leg warmer|thigh[- ]high|otk)/.test(text) || /\bone (?:viewer[- ])?right (?:leg warmer|sock|stocking)/.test(text)) asymmetry = "right";
  else if (kind !== "none" && asymmetry === "none") asymmetry = "both";
  const colorValue = garmentColorFromText(text, "leg warmers?|thigh[- ]highs?|socks?|stockings?", color(analysis.renderHints.legwearColor, fallbackColor));
  const observedLegwear = analysis.observed.clothing.toLowerCase().split(/[.;]/)
    .find(clause => /\b(?:tights?|stockings?)\b/.test(clause)) ?? "";
  const diagonalStripe = analysis.visibleRegions.lowerBody && kind !== "none" &&
    /\bdiagonal(?:ly)?[- ]+strip(?:ed|es?)(?:[- ]+pattern)?[- ]+(?:tights?|stockings?)\b/.test(observedLegwear);
  return { kind, color: colorValue, asymmetry, source: analysis.visibleRegions.lowerBody ? "observed" : "conservative",
    ...(diagonalStripe ? { pattern: "diagonal_stripe" as const } : {}) };
}

function saliencePlan(analysis: PhotoAnalysis, generated: OutfitIdentityCue[]): OutfitIdentitySaliencePlan {
  const canonical = analysis.canonicalIdentity.features
    .filter((feature) => feature.category === "outfit" || feature.category === "color" || feature.category === "accessory")
    .map((feature, index) => ({ id: `canonical_${index}`, salience: feature.priority / 5, evidence: feature.evidence, targets: feature.targetRegions }));
  const deduped = [...canonical, ...generated].filter((cue, index, all) => all.findIndex((item) => item.id === cue.id) === index).sort((a, b) => b.salience - a.salience);
  return {
    primary: deduped.filter((cue) => cue.salience >= 0.8).slice(0, 4),
    secondary: deduped.filter((cue) => cue.salience >= 0.5 && cue.salience < 0.8).slice(0, 5),
    tertiary: deduped.filter((cue) => cue.salience < 0.5).slice(0, 4),
    pixelBudget: { torsoShape: 28, sleeves: 24, neckline: 10, lowerGarment: 28, pattern: 14, accessories: 10 },
  };
}

function baseOutfitPlan(analysis: PhotoAnalysis): OutfitPlan {
  const text = evidenceText(analysis);
  const garmentType = upperType(analysis, text);
  const clothingText = `${analysis.observed.clothing} ${analysis.outfitPrompt}`.toLowerCase();
  const observedClothing = analysis.observed.clothing.toLowerCase();
  const upperText = garmentEvidence(observedClothing, UPPER_WORDS) || garmentEvidence(clothingText, UPPER_WORDS);
  const lowerText = analysis.visibleRegions.lowerBody
    ? garmentEvidence(clothingText, LOWER_WORDS)
    : garmentEvidence(analysis.inferred.lowerBody?.value.toLowerCase() ?? "", LOWER_WORDS);
  const topColor = garmentColorFromText(upperText, UPPER_WORDS, color(analysis.fallbackFeatures.topColor, "#516e91"));
  const accentColor = color(analysis.fallbackFeatures.topAccentColor, "#e7e2d7");
  const bottomColor = garmentColorFromText(lowerText, LOWER_WORDS, color(analysis.fallbackFeatures.bottomColor, "#39485f"));
  const shoeText = garmentEvidence(clothingText, FOOTWEAR_WORDS);
  const shoeColor = garmentColorFromText(shoeText, FOOTWEAR_WORDS, color(analysis.fallbackFeatures.shoesColor, "#383438"));
  const sweatshirt = observedStandaloneSweatshirt(analysis);
  // Match the existing FaceStyle pullover policy, but only for a visible,
  // unambiguous standalone garment. Explicit sleeve evidence still wins.
  const impliedLongSleeves = sweatshirt || (garmentType === "hoodie" && observedStandalonePullover(analysis, "hoodie"));
  const sleeveBase = impliedLongSleeves ? "long" : analysis.fallbackFeatures.sleeveLength;
  const leftLength = sleeveLength(sleeveBase, upperText, "left");
  const rightLength = sleeveLength(sleeveBase, upperText, "right");
  const sleeveEvidence: OutfitEvidence = impliedLongSleeves && !/\bsleeveless\b|\bsleeve(?:d|s)?\b/.test(upperText)
    ? "strongly_implied" : analysis.visibleRegions.upperBody ? "observed" : "conservative";
  const contrastingSleeves = /\b(?:contrasting|contrast|raglan|two[- ]tone) sleeves?\b/.test(text);
  const leftSleeveColor = contrastingSleeves || /\bleft sleeve[^.]{0,24}(?:contrasting|accent)\b/.test(text) ? accentColor : topColor;
  const rightSleeveColor = contrastingSleeves || /\bright sleeve[^.]{0,24}(?:contrasting|accent)\b/.test(text) ? accentColor : topColor;
  // A positively observed standalone pullover owns its neckline. Words like
  // "over the wrists" or "layered shading" in completion are not a second top.
  // Actual observed layering fails the standalone guard and keeps its path.
  const neck = neckline(garmentType, impliedLongSleeves ? upperText : text, analysis.renderHints.neckAccessory);
  const observedUpper = garmentEvidence(observedClothing, UPPER_WORDS);
  const observedPalette = analysis.visibleRegions.upperBody
    ? observedPatternPalette(observedUpper, accentColor, topColor) : [accentColor];
  let upperPattern = pattern(upperText, analysis.renderHints.garmentTexture, observedPalette[0],
    analysis.visibleRegions.upperBody && observedCrossedStripes(observedUpper));
  if (analysis.visibleRegions.upperBody) upperPattern = resolveObservedFloralPattern(upperPattern, observedClothing, true);
  else if (floralMotif.test(observedUpper)) Object.assign(upperPattern, { kind: "none", motif: "floral", surfaceParts: [], source: "conservative" });
  if (analysis.visibleRegions.upperBody) upperPattern = observedBlockPattern(observedUpper) ?? upperPattern;
  if (analysis.visibleRegions.upperBody) upperPattern = observedGradientPattern(observedUpper) ?? upperPattern;
  const attachedGraphic = observedAttachedChestGraphic(analysis);
  if (attachedGraphic && (upperPattern.kind === "none" || upperPattern.kind === "center_graphic")) upperPattern = attachedGraphic;
  if (upperPattern.kind === "horizontal_stripe" && observedPalette.length > 1)
    upperPattern.stripeColors = observedPalette.slice(0, 3);
  if (upperPattern.construction === "crossed_bands" && observedPalette.length > 1)
    upperPattern.crossedBandColors = observedPalette.slice(0, 3);
  const upperEvidence: OutfitEvidence = analysis.visibleRegions.upperBody ? "observed" : "conservative";
  const isOuter = ["jacket", "coat", "vest"].includes(garmentType) || analysis.renderHints.outerGarment !== "none";
  const observedWornOpen = !/\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded|unknown)\b/.test(observedUpper) &&
    /\b(?:jacket|blazer|cardigan|coat|vest) (?:is |was )?(?:worn |left )?open\b/.test(observedUpper);
  const openConstruction = observedWornOpen || /\b(?:open[- ]front|open [^.]{0,20}(?:jacket|cardigan|coat)|unbuttoned)\b/.test(clothingText);
  // A shirt collar is construction, not evidence of an exposed undershirt.
  // An observed inner top under outerwear remains visible unless the outerwear
  // is explicitly closed; it need not literally be described as "open".
  const observedInnerLayer = !/\b(?:no|not|without|possibly|maybe)\b/.test(observedClothing) &&
    /\b(?:inner (?:shirt|top)|undershirt|(?:t-?shirt|shirt|tee|blouse) underneath|over (?:a |an |the )?(?:[a-z-]+ ){0,3}(?:t-?shirt|shirt|tee|blouse|top))\b/.test(observedClothing);
  const closedOuter = /\b(?:closed|zipped|buttoned|fastened)[- ][^.]{0,24}\b(?:jacket|cardigan|coat|vest)\b|\b(?:jacket|cardigan|coat|vest)[- ]+(?:is |was )?(?:worn )?(?:closed|zipped|buttoned|fastened)\b/.test(observedClothing);
  const exposedInner = isOuter && observedInnerLayer && !closedOuter;
  const revealOuter = !closedOuter && (openConstruction || exposedInner);
  const innerVisible = neck.innerVisible && (!isOuter || revealOuter) &&
    (isOuter || !["shirt_collar", "hood_opening"].includes(neck.kind) || observedInnerLayer);
  const colorBlocks: OutfitColorBlock[] = [{ id: "upper_base", region: "all", color: topColor, source: upperEvidence, priority: 1 }];
  // A pullover hood opening exposes only the neckline, not an undershirt down
  // to the waist. Explicit open-front construction has its own open_collar
  // kind and retains the existing full panel behavior.
  if (innerVisible && neck.kind !== "hood_opening") colorBlocks.push({ id: "inner_panel", region: "front_center", color: accentColor, source: upperEvidence, priority: 0.95 });
  if (isOuter && revealOuter) colorBlocks.push({ id: "opening", region: "vertical_opening", color: accentColor, source: upperEvidence, priority: 0.9 });
  if (upperPattern.kind === "horizontal_stripe") colorBlocks.push({ id: "stripe_band", region: "horizontal_band", color: upperPattern.color, source: upperEvidence, priority: 0.88 });
  let lowerType = lowerTypeFromText(analysis, text, garmentType);
  const structuredLower = analysis.inferred.lowerBodyDesign;
  const preppyConservativeCompletion = !analysis.visibleRegions.lowerBody && isOuter && /\b(?:bow collar|neck bow)\b/.test(text) && structuredLower?.bottomType === "pants" && structuredLower.bottomPattern === "plain" && structuredLower.legwear === "none";
  if (preppyConservativeCompletion) lowerType = "skirt";
  const lowerSource: OutfitPlan["lowerBodySource"] = analysis.visibleRegions.lowerBody ? "observed" : "minimum_inference";
  const lowerEvidence: OutfitEvidence = analysis.visibleRegions.lowerBody ? "observed" : "conservative";
  const waistRow = garmentType === "dress_upper" ? 7 : garmentType === "coat" ? 9 : /\bcropped\b/.test(text) ? 8 : /\b(?:long top|long hoodie|untucked)\b/.test(text) ? 11 : 10;
  const garmentRows = lowerType === "shorts" ? 3 : lowerType === "skirt" ? (/\b(?:long|maxi)\b/.test(text) ? 9 : 3) : lowerType === "dress_continuation" ? (/\b(?:long|maxi)\b/.test(text) ? 9 : 5) : 9;
  const shoeRows = analysis.visibleRegions.feet || analysis.inferred.shoes ? 3 : 2;
  const skinExposureRows = ["shorts", "skirt", "dress_continuation"].includes(lowerType) ? Math.max(0, 12 - garmentRows - shoeRows) : 0;
  const accessories = accessoryPlans(analysis, text, accentColor);
  let lowerLegwear = legwearFromText(analysis, text, accentColor);
  let lowerPatternPlan = lowerPattern(analysis, lowerText, accentColor, bottomColor);
  if (analysis.visibleRegions.lowerBody) lowerPatternPlan = resolveObservedFloralPattern(lowerPatternPlan, observedClothing, false);
  let lowerAccent = analysis.renderHints.bottomAccent !== "none"
    ? analysis.renderHints.bottomAccent
    : analysis.inferred.lowerBodyDesign?.bottomAccent ?? "none";
  if (preppyConservativeCompletion) {
    lowerLegwear = { kind: "socks", color: COLORS.white, asymmetry: "both", source: "conservative" };
    lowerPatternPlan = { kind: "checker_block", color: accentColor, placement: "wrap", anchor: "center", frequency: 2, source: "conservative", evidence: "preppy cardigan-and-bow completion" };
    lowerAccent = "ribbon";
    if (!accessories.some((item) => item.kind === "thigh_accessory")) accessories.push({ kind: "thigh_accessory", color: accentColor, side: "left", source: "conservative", evidence: "preppy cardigan-and-bow completion" });
  }
  const collar: OutfitPlan["upper"]["collar"] = garmentType === "hoodie" ? "hood" : isOuter ? "lapel" : neck.kind === "shirt_collar" ? "paired" : "none";
  const outerRegions: OutfitPlan["outerLayer"]["regions"] = [];
  if (collar === "paired") outerRegions.push("collar");
  if (collar === "lapel") outerRegions.push("lapels");
  if (collar === "hood") outerRegions.push("hood_rim");
  if (isOuter || leftLength === "long" || rightLength === "long" || leftLength === "rolled" || rightLength === "rolled") outerRegions.push("cuffs");
  if (garmentType !== "tshirt" || analysis.renderHints.outerLayer !== "none") outerRegions.push("hem");
  if (["coat", "dress_upper"].includes(garmentType) || lowerType === "skirt") outerRegions.push(lowerType === "skirt" ? "skirt_pleats" : "hem");
  if (lowerLegwear.kind !== "none") outerRegions.push("legwear");
  if (lowerAccent !== "none") outerRegions.push("lower_accent");
  if (!isOuter && ["pants", "jeans", "leggings"].includes(lowerType)) outerRegions.push("lower_fold");
  if (lowerPatternPlan.kind !== "none" && lowerPatternPlan.motif !== "floral") outerRegions.push("pattern_depth");
  // A printed cross is flat ink, not an independently raised garment panel.
  if ((upperPattern.kind === "center_graphic" && !upperPattern.graphicShape) || upperPattern.frontGraphic) outerRegions.push("graphic_depth");
  if (accessories.some((item) => item.kind === "thigh_accessory")) outerRegions.push("thigh_accessory");
  if (accessories.some((item) => item.kind === "bag_strap")) outerRegions.push("strap");
  if (accessories.some((item) => item.kind === "large_pocket")) outerRegions.push("pocket");
  outerRegions.push("shoe_depth");
  const uniqueOuterRegions = [...new Set(outerRegions)];
  let expectedOuterPixels = 0;
  if (uniqueOuterRegions.includes("collar")) expectedOuterPixels += 6;
  if (uniqueOuterRegions.includes("lapels")) expectedOuterPixels += 2 * Math.min(8, waistRow) + 2 * Math.max(0, waistRow - 1) + 4;
  if (uniqueOuterRegions.includes("hood_rim")) expectedOuterPixels += 12;
  if (uniqueOuterRegions.includes("cuffs")) expectedOuterPixels += [leftLength, rightLength].filter((length) => length !== "sleeveless").length * 16;
  if (uniqueOuterRegions.includes("hem")) expectedOuterPixels += 24 + (uniqueOuterRegions.includes("lapels") ? 2 : 0);
  if (uniqueOuterRegions.includes("lower_fold")) expectedOuterPixels += 6;
  if (uniqueOuterRegions.includes("shoe_depth")) expectedOuterPixels += 8;
  if (uniqueOuterRegions.includes("graphic_depth")) expectedOuterPixels += 3;
  if (uniqueOuterRegions.includes("pocket")) expectedOuterPixels += 4;
  if (uniqueOuterRegions.includes("strap")) expectedOuterPixels += 36;
  if (uniqueOuterRegions.includes("thigh_accessory")) expectedOuterPixels += 3;
  expectedOuterPixels += accessories.reduce((sum, item) => sum + ({ bow: /\bbroad\b/.test(item.evidence) ? 12 : 9, scarf: 7, tie: 6, necklace: 7, suspenders: 18, belt: 24, hood_string: 4, bag_strap: 0, large_pocket: 0, thigh_accessory: 0, wrist_cuff: 32, choker:4, brooch:4, watch:36, bracelet:32, waist_chain:6 }[item.kind] ?? 0), 0);
  const cues: OutfitIdentityCue[] = [
    { id: `garment_${garmentType}`, salience: analysis.visibleRegions.upperBody ? 0.82 : 0.38, evidence: analysis.observed.clothing, targets: ["torso.front", "arm.left", "arm.right"] },
    { id: `color_${topColor}`, salience: analysis.visibleRegions.upperBody ? 0.92 : 0.42, evidence: analysis.observed.clothing, targets: ["torso.front", "arm.left", "arm.right"] },
    { id: `sleeves_${leftLength}_${rightLength}`, salience: analysis.visibleRegions.upperBody ? (leftLength === rightLength ? 0.72 : 0.9) : 0.32, evidence: analysis.observed.clothing, targets: ["arm.left", "arm.right"] },
    { id: `neckline_${neck.kind}`, salience: analysis.visibleRegions.upperBody ? 0.7 : 0.3, evidence: analysis.observed.clothing, targets: ["torso.front"] },
    ...(upperPattern.kind === "none" ? [] : [{ id: `pattern_${upperPattern.kind}`, salience: 0.86, evidence: upperPattern.evidence, targets: ["torso.front", "torso.side", "torso.back"] }]),
    ...accessories.map((item) => ({ id: `accessory_${item.kind}`, salience: 0.84, evidence: item.evidence, targets: ["torso.front", "torso.side", "torso.back"] })),
  ];
  const hiddenCompletion = analysis.visibleRegions.lowerBody
    ? analysis.observed.clothing
    : analysis.inferred.lowerBody?.value || analysis.inferred.lowerBodyDesign?.rationale || "continue visible materials without a new motif";
  const provenance: OutfitProvenance[] = [
    { target: "upper.garmentType", source: upperEvidence, evidence: analysis.observed.clothing, confidence: analysis.visibleRegions.upperBody ? 0.9 : 0.4 },
    { target: "upper.colorBlocks", source: upperEvidence, evidence: `${analysis.observed.clothing}; ${analysis.fallbackFeatures.topColor}`, confidence: analysis.visibleRegions.upperBody ? 0.9 : 0.4 },
    { target: "upper.sleeves", source: sleeveEvidence, evidence: analysis.observed.clothing, confidence: sleeveEvidence === "strongly_implied" ? 0.58 : analysis.visibleRegions.upperBody ? 0.85 : 0.4 },
    { target: "upper.neckline", source: neck.source, evidence: analysis.observed.clothing, confidence: neck.source === "observed" ? 0.82 : 0.58 },
    { target: "lower", source: lowerEvidence, evidence: hiddenCompletion, confidence: analysis.visibleRegions.lowerBody ? 0.86 : 0.42 },
    { target: "back", source: "conservative", evidence: "front structure continued only where garment construction implies continuity", confidence: 0.5 },
  ];
  return {
    coordinateSpace: "minecraft.classic.body_uv",
    upper: {
      garmentType, baseColor: topColor, accentColor,
      neckline: !isOuter && ["shirt_collar", "hood_opening"].includes(neck.kind) ? { ...neck, innerVisible } : neck, collar,
      // A named button shirt is the same material continuation as an explicit
      // collar. Pattern accent colors are not evidence of a contrast collar.
      ...(collar === "paired" && /\bcollar(?:ed)?\b|\bbutton[- ](?:down|up)\s+shirt\b/.test(garmentEvidence(observedClothing, UPPER_WORDS))
        ? { collarColor: shirtCollarColor(garmentEvidence(observedClothing, UPPER_WORDS), topColor, accentColor) } : {}),
      leftSleeve: { length: leftLength, terminationRow: sleeveRows(leftLength), color: leftSleeveColor, source: sleeveEvidence, evidence: analysis.observed.clothing },
      rightSleeve: { length: rightLength, terminationRow: sleeveRows(rightLength), color: rightSleeveColor, source: sleeveEvidence, evidence: analysis.observed.clothing },
      colorBlocks, pattern: upperPattern,
      backCompletion: upperPattern.placement === "wrap" ? "wrap_pattern" : analysis.visibleRegions.upperBody ? "continue_material" : "plain_conservative",
    },
    lower: {
      garmentType: lowerType,
      baseColor: bottomColor,
      waistRow,
      garmentRows,
      skinExposureRows,
      shoeRows,
      shoeColor,
      ...(analysis.inferred.lowerBodyDesign?.shoeStyle ? { shoeStyle: analysis.inferred.lowerBodyDesign.shoeStyle } : {}),
      pattern: lowerPatternPlan,
      accent: lowerAccent,
      legwear: lowerLegwear,
      source: lowerEvidence,
    },
    outerLayer: { regions: uniqueOuterRegions, purpose: "physical_depth_only", expectedPixels: expectedOuterPixels },
    accessories,
    salience: saliencePlan(analysis, cues), provenance,
    observedConstruction: analysis.observed.clothing,
    hiddenCompletion,
    lowerBodySource: lowerSource,
    outerLayerRegions: uniqueOuterRegions,
    inventionPolicy: "extend_existing_materials_only",
    candidate: { index: 0, axis: "baseline", cost: 0 },
  };
}

/** Carry the existing FaceStyle cardigan construction default into the plan
 * that actually paints the arms. This is conservative design, not an observed
 * sleeve endpoint. Explicit cuts, uncertainty and inner-layer sleeves win.
 */
export function preserveObservedCardiganSleeves(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  if (!analysis.visibleRegions.upperBody || plan.upper.garmentType !== "jacket") return plan;
  const observed = analysis.observed.clothing.toLowerCase();
  const firstGarment = new RegExp(`\\b(?:${UPPER_WORDS})\\b`).exec(garmentNounScanText(observed));
  if (firstGarment?.[0] !== "cardigan") return plan;
  const scoped = garmentEvidence(observed, "cardigan");
  if (!scoped || /\b(?:sleeveless|sleeves?|sleeved|strapless|no|not|without|possibly|maybe|uncertain|hidden|obscured|occluded|unknown|print|graphic|motif|depicting)\b/.test(scoped)) return plan;
  // A separate sleeve sentence may describe this cardigan. Do not discard it
  // just because garment scoping stops at punctuation. An explicitly named
  // inner shirt keeps its own sleeve ownership instead.
  if (observed.split(/[.;\n]/).some(clause => /\bsleeves?|sleeved\b/.test(clause)
    && !new RegExp(`\\b(?:${UPPER_WORDS})\\b`).test(clause))) return plan;
  const evidence = "conventional observed cardigan; sleeve endpoint not explicitly observed";
  const resolve = (sleeve: OutfitSleevePlan): OutfitSleevePlan => sleeve.length === "short"
    ? { ...sleeve, length: "long", terminationRow: sleeveRows("long"), source: "conservative", evidence } : sleeve;
  const leftSleeve = resolve(plan.upper.leftSleeve), rightSleeve = resolve(plan.upper.rightSleeve);
  if (leftSleeve === plan.upper.leftSleeve && rightSleeve === plan.upper.rightSleeve) return plan;
  const cue = (c: OutfitIdentityCue): OutfitIdentityCue => c.id.startsWith("sleeves_")
    ? { ...c, id: `sleeves_${leftSleeve.length}_${rightSleeve.length}`, evidence } : c;
  return { ...plan, upper: { ...plan.upper, leftSleeve, rightSleeve },
    salience: { ...plan.salience, primary: plan.salience.primary.map(cue),
      secondary: plan.salience.secondary.map(cue), tertiary: plan.salience.tertiary.map(cue) },
    provenance: [...plan.provenance.filter(p => p.target !== "upper.sleeves"),
      { target: "upper.sleeves", source: "conservative", evidence, confidence: 0.5 }],
  };
}

/** Only visible source evidence can opt into this construction. This boundary
 * is also replayable from saved plans without inventing omitted model prompts. */
/** Keep adjective-list commas inside an explicit tie modifier, but never
 * borrow a neighbouring garment's stripes. No inferred or prompt text. */
export function observedStripedTie(clothing: string): boolean {
  return clothing.toLowerCase().split(/[.;\n]/).some(sentence => {
    const items = [...sentence.matchAll(new RegExp(`\\b(?:${ALL_GARMENTS}|necktie|tie)\\b`, "g"))];
    return items.some((item, i) => {
      if (!/^(?:necktie|tie)$/.test(item[0])) return false;
      const start = i ? items[i - 1].index! + items[i - 1][0].length : 0;
      const prefix = sentence.slice(start, item.index).split(/[,;]|\b(?:and|but|while)\b/).at(-1) ?? "";
      const suffix = sentence.slice(item.index! + item[0].length, items[i + 1]?.index)
        .split(/;|\b(?:and|but|while)\b/)[0];
      if (/\b(?:plain|solid|no|not|without|possibly|maybe|uncertain|hidden|occluded)\b/.test(`${prefix} ${suffix}`)) return false;
      if (/\bstriped\b/.test(prefix)) return true;
      // Explicit attachment allows "featuring thin, light-colored diagonal
      // stripes" without treating "tie, striped socks" as tie evidence.
      return /^\s+(?:with|featuring|has|showing)\s+(?:(?:thin|fine|narrow|broad|light[- ]colored|dark[- ]colored|diagonal|horizontal|vertical|white|silver|gold|black|blue|red|navy)[,\s-]+){0,8}stripes?\b/.test(suffix)
        && !/\bstripes?\s+(?:on|of)\b/.test(suffix);
    });
  });
}

export function preserveObservedFormalSuit(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions" | "inferred">,
): OutfitPlan {
  const observed = analysis.observed.clothing.toLowerCase();
  const formalClause = observed.split(/[.;\n]/).find(clause =>
    /\b(?:formal (?:suit|jacket)|suit jacket|business suit|tuxedo)\b/.test(clause));
  if (!analysis.visibleRegions.upperBody || plan.upper.garmentType !== "jacket" || !formalClause ||
    /\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded)\b[^,;]{0,32}\b(?:formal|suit|tuxedo)\b/.test(formalClause)) return plan;

  // End material ownership at the next garment/accessory noun. In particular,
  // "white shirt and dark tie" must not lend the shirt's color to the tie.
  const nouns = `${ALL_GARMENTS}|necktie|tie`;
  const section = (text: string, words: string): string => {
    const items = [...text.matchAll(new RegExp(`\\b(?:${nouns})\\b`, "g"))];
    const i = items.findIndex(item => new RegExp(`^(?:${words})$`).test(item[0]));
    if (i < 0) return "";
    const start = i ? items[i - 1].index! + items[i - 1][0].length : 0;
    return text.slice(start, items[i + 1]?.index).split(/[.;\n]/).find(clause =>
      new RegExp(`\\b(?:${words})\\b`).test(clause)) ?? "";
  };
  const shirt = section(observed, "shirt|blouse");
  const unavailable = (text: string, words: string): boolean => new RegExp(
    `\\b(?:no|not|without|possibly|maybe|hidden|occluded)\\b[^,;]{0,24}\\b(?:${words})\\b|\\b(?:${words}) (?:is |was )?(?:hidden|occluded|absent)\\b`,
  ).test(text);
  if (!shirt || unavailable(shirt, "shirt|blouse") ||
    !/\b(?:over|underneath|under|with)\b/.test(observed)) return plan;
  // Formal material is not its trim or adjacent layer. Read color before the
  // garment (or an immediate postposed description), stopping at construction
  // connectors. "Dark tie with white stripes" is dark material + white trim,
  // not a white tie. Bare "dark" chooses the existing dark neutral value class,
  // not an asserted exact source hue. This is deliberately formal-only: generic
  // pattern palettes retain their existing named-color contract.
  const materialColor = (text: string, words: string, fallback: string): string => {
    const noun = new RegExp(`\\b(?:${words})\\b`).exec(text);
    if (!noun) return fallback;
    const prefix = text.slice(0, noun.index);
    const suffix = text.slice(noun.index + noun[0].length)
      .split(/[,;]|\b(?:with|featuring|over|under|underneath|and|adorned|decorated)\b/)[0];
    const material = `${prefix} ${noun[0]} ${suffix}`;
    if (/\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded)\b/.test(material)) return fallback;
    // Charcoal/dark gray is an observed dark neutral value class, not the
    // unmodified mid-gray swatch. Keep this formal material-only: another
    // garment or stripe/trim cannot recolor the suit, and ordinary gray stays gray.
    if (/\b(?:charcoal(?:[- ]gr[ae]y)?|dark[- ]gr[ae]y)\b/.test(material)) return COLORS.black;
    if (new RegExp(`\\b(?:${COLOR_WORD})\\b`).test(material))
      return garmentColorFromText(material, words, fallback);
    return /\bdark\b/.test(material) ? COLORS.black : fallback;
  };
  const jacketColor = materialColor(section(observed, "jacket|blazer|tuxedo"), "jacket|blazer|tuxedo", plan.upper.baseColor);
  const shirtColor = materialColor(shirt, "shirt|blouse", plan.upper.accentColor);
  const tie = section(observed, "tie|necktie");
  const hasTie = !!tie && !unavailable(tie, "tie|necktie");
  const tieColor = hasTie ? materialColor(tie, "tie|necktie",
    plan.accessories.find(a => a.kind === "tie")?.color ?? jacketColor) : null;
  // A generic "light-colored" line does not establish white RGB. Keep trim
  // absent unless a named color is actually attached to the observed stripes.
  const trim = hasTie ? new RegExp(`\\b(${COLOR_WORD})[- ]+(?:diagonal[- ]+)?(?:stripes?|lines?)\\b`).exec(tie) : null;
  const tieAccent = trim ? color(trim[1], shirtColor) : null;
  // A visible stripe is structure even when its hue is unresolved. Keep the
  // original null accent; a shirt/jacket stripe or uncertain prose is not tie ink.
  const stripedTie = hasTie && observedStripedTie(observed);
  const buttoned = /\b(?:buttoned|fastened|closed)[- ]+(?:[a-z-]+ ){0,3}(?:jacket|suit)\b|\b(?:jacket|suit) (?:is |was )?(?:buttoned|fastened|closed)\b/.test(observed);
  const panel = plan.upper.colorBlocks.filter(b => b.id !== "inner_panel" && b.id !== "opening")
    .map(b => b.id === "upper_base" ? { ...b, color: jacketColor } : b);
  panel.push({ id: "inner_panel", region: "front_center", color: shirtColor, source: "observed", priority: 0.95 });
  if (!buttoned) panel.push({ id: "opening", region: "vertical_opening", color: shirtColor, source: "observed", priority: 0.9 });
  const lowerEvidence = analysis.visibleRegions.lowerBody ? observed
    : `${analysis.inferred.lowerBody?.value ?? ""} ${analysis.inferred.lowerBodyDesign?.rationale ?? ""}`.toLowerCase();
  const trousers = section(lowerEvidence, "pants|trousers|chinos");
  const darkCompletion = !analysis.visibleRegions.lowerBody && /\bdark trousers?\b/.test(trousers);
  const lowerDesign = analysis.inferred.lowerBodyDesign;
  const suitContinuation = !analysis.visibleRegions.lowerBody && lowerDesign?.bottomType === "pants" &&
    lowerDesign.bottomPattern === "plain" && /\b(?:extending|continue|continuing|continuation)\b/.test(lowerEvidence) &&
    /\bformal suit\b/.test(lowerEvidence) &&
    !/\b(?:no|not|without|possibly|maybe|uncertain)\b/.test(lowerEvidence);
  const trouserColor = (analysis.visibleRegions.lowerBody ? materialColor : garmentColorFromText)(trousers, "pants|trousers|chinos",
    darkCompletion || suitContinuation ? jacketColor : plan.lower.baseColor);
  const accessories = plan.accessories.filter(a => a.kind !== "tie");
  if (tieColor) accessories.push({ kind: "tie", color: tieColor, side: "center", source: "observed", evidence: tie });
  // Match the existing face-style construction policy at the authoritative
  // OutfitPlan boundary. A generic short cache must not turn an observed
  // conventional suit jacket into a short-sleeved shirt. This is an explicit
  // conservative design default, NOT a recovered provider measurement.
  // Scope to the jacket: an inner sleeveless/short shirt does not describe it.
  // Any sleeve-specific or uncertain jacket prose retains the existing plan.
  const jacketConstruction = garmentEvidence(observed, "jacket|blazer|tuxedo");
  const conventionalSleeves = !!jacketConstruction &&
    !/\b(?:sleeveless|sleeves?|sleeved|no|not|without|possibly|maybe|uncertain|hidden|occluded)\b/.test(jacketConstruction);
  const sleeveConstructionEvidence = "conventional observed formal jacket; sleeve endpoint not explicitly observed";
  const resolveSleeve = (sleeve: OutfitSleevePlan): OutfitSleevePlan => conventionalSleeves && sleeve.length === "short"
    ? { ...sleeve, length: "long", terminationRow: sleeveRows("long"), source: "conservative", evidence: sleeveConstructionEvidence }
    : sleeve;
  const leftSleeve = resolveSleeve(plan.upper.leftSleeve), rightSleeve = resolveSleeve(plan.upper.rightSleeve);
  const sleevesChanged = leftSleeve !== plan.upper.leftSleeve || rightSleeve !== plan.upper.rightSleeve;
  const sleeveCue = (cue: OutfitIdentityCue): OutfitIdentityCue => sleevesChanged && cue.id.startsWith("sleeves_")
    ? { ...cue, id: `sleeves_${leftSleeve.length}_${rightSleeve.length}`, evidence: sleeveConstructionEvidence } : cue;
  return { ...plan,
    formalSuit: { family: "formal_suit", jacketColor, shirtColor, tieColor, tieAccent,
      construction: "connected_tie_tapered_front",
      frontDrape: /\b(?:open|unbuttoned)[- ]+(?:[a-z-]+ ){0,3}(?:jacket|blazer|suit)\b|\b(?:jacket|blazer|suit) (?:is |was )?(?:open|unbuttoned)\b/.test(observed) ? "straight_open" : "tapered",
      ...(stripedTie ? { tiePattern: "striped" as const } : {}),
      lapelStyle: /\bpeak(?:ed)? lapels?\b/.test(observed) ? "peak" : /\bshawl lapels?\b/.test(observed) ? "shawl" : "notch",
      shirtOpening: plan.upper.neckline.depth, jacketOpening: buttoned ? "buttoned" : "open",
      trouserColor, shoeColor: plan.lower.shoeColor },
    upper: { ...plan.upper, baseColor: jacketColor, accentColor: shirtColor, colorBlocks: panel,
      leftSleeve: { ...leftSleeve, color: leftSleeve.color === plan.upper.baseColor ? jacketColor : leftSleeve.color },
      rightSleeve: { ...rightSleeve, color: rightSleeve.color === plan.upper.baseColor ? jacketColor : rightSleeve.color },
      neckline: { ...plan.upper.neckline, innerVisible: true } },
    lower: { ...plan.lower, baseColor: trouserColor }, accessories,
    salience: { ...plan.salience, primary: plan.salience.primary.map(sleeveCue),
      secondary: plan.salience.secondary.map(sleeveCue), tertiary: plan.salience.tertiary.map(sleeveCue) },
    provenance: [...plan.provenance.filter(p => !sleevesChanged || p.target !== "upper.sleeves"),
      ...(sleevesChanged ? [{ target: "upper.sleeves", source: "conservative" as const,
        evidence: sleeveConstructionEvidence, confidence: 0.5 }] : []),
      { target: "formalSuit", source: "observed", evidence: formalClause, confidence: 0.9 },
      { target: "formalSuit.frontDrape", source: "conservative", evidence: "authored converging formal front unless explicitly observed open; not a button observation", confidence: 0.5 },
      { target: "formalSuit.lapelStyle", source: /\b(?:peak(?:ed)?|shawl|notch(?:ed)?) lapels?\b/.test(observed) ? "observed" : "conservative",
        evidence: "named lapel style or existing jacket notch construction", confidence: 0.5 },
      ...(darkCompletion || suitContinuation ? [{ target: "formalSuit.trouserColor", source: "conservative" as const,
        evidence: "unseen suit trousers continue the jacket material under the supplied completion evidence", confidence: 0.42 }] : [])],
  };
}

/** A neck/chest bow owns its observed color, not the shirt's generic accent.
 * Do not borrow a nearby hair/leg ribbon's palette or create a new accessory.
 */
export function preserveObservedNeckBowColor(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  if (!analysis.visibleRegions.upperBody || !plan.accessories.some(a => a.kind === "bow")) return plan;
  const observations = [analysis.observed.clothing, analysis.observed.accessories];
  const colors = new Set<string>();
  const evidence: string[] = [];
  for (const observation of observations) {
    // Leave multicolor bows unresolved rather than dropping one coordinated hue.
    if (new RegExp(`\\b(?:${COLOR_WORD})[- ]+(?:and[- ]+)?(?:${COLOR_WORD})\\b`).test(observation.toLowerCase())) continue;
    for (const clause of observation.toLowerCase().split(/[.;,\n]|\band\b/)) {
      if (!/\b(?:bow|ribbon)\b/.test(clause) || !/\b(?:chest|neck|neckline|collar)\b/.test(clause) ||
        /\b(?:hair|head|shoe|shoes|thigh|leg|legs|waist|belt)\b/.test(clause) ||
        /\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded|absent|unknown)\b/.test(clause)) continue;
      const prefix = new RegExp(`\\b(${COLOR_WORD}) (?:(?:small|large|satin|silk|neck|chest|collar) ){0,2}(?:bow|ribbon)\\b`, "g");
      const postfix = new RegExp(`\\b(?:bow|ribbon) (?:is |in )?(${COLOR_WORD})\\b`, "g");
      const matches = [...clause.matchAll(prefix), ...clause.matchAll(postfix)];
      for (const match of matches) colors.add(color(match[1], ""));
      if (matches.length) evidence.push(clause.trim());
    }
  }
  if (colors.size !== 1) return plan;
  const bowColor = [...colors][0];
  if (plan.accessories.filter(a => a.kind === "bow").every(a => a.color === bowColor)) return plan;
  return { ...plan,
    accessories: plan.accessories.map(a => a.kind === "bow" ? { ...a, color: bowColor } : a),
    provenance: [...plan.provenance, { target: "accessories.bow.color", source: "observed",
      evidence: evidence.join("; "), confidence: 0.9 }],
  };
}

/** Existing scarf/belt material belongs to that noun, not to the shared shirt
 * accent. Read visible observations only; do not create accessories or borrow
 * colors from adjacent clothes, head coverings, buckles or uncertain prose. */
export function preserveObservedScarfBeltColors(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  let result = plan;
  const token = `(?:off[- ]white|(?:(?:dark|light)[- ])?(?:${COLOR_WORD}|tan))`;
  const modifier = "(?:pale|soft|small|large|long|short|wide|narrow|thin|thick|knit|knitted|ribbed|fringed|wool|woolen|silk|satin|leather|fabric|neck|waist)";
  for (const kind of ["scarf", "belt"] as const) {
    if (!(kind === "scarf" ? analysis.visibleRegions.upperBody : analysis.visibleRegions.lowerBody) ||
      !result.accessories.some(a => a.kind === kind && a.source === "observed")) continue;
    const colors = new Set<string>(), evidence: string[] = [];
    let ambiguous = false;
    for (const observation of [analysis.observed.clothing, analysis.observed.accessories]) {
      for (const clause of observation.toLowerCase().split(/[.;\n]/)) {
        if (!new RegExp(`\\b${kind}\\b`).test(clause)) continue;
        // Keep coordinated colors intact before clause splitting. A single
        // material color is not a license to flatten a multicolor accessory.
        const join = "(?:,\\s*(?:and\\s+)?|\\s+(?:and|or)\\s+|\\s*[/&-]\\s*)";
        const multi = new RegExp(`\\b${token}${join}${token}[- ]+(?:${modifier}[- ]+){0,4}${kind}\\b|\\b${kind} (?:is |in )${token}${join}${token}\\b`);
        if (multi.test(clause)) { ambiguous = true; continue; }
        for (const part of clause.split(/,|\b(?:and|but|while)\b/)) {
          if (!new RegExp(`\\b${kind}\\b`).test(part)) continue;
          if (/\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded|absent|unknown|unclear|stripes?|striped|plaid|checkered|multicolor|patterns?|patterned|prints?|printed)\b/.test(part)) {
            ambiguous = true; continue;
          }
          if (kind === "scarf" && /\b(?:headscarf|hijab)|\b(?:around|over|covering|on) (?:the )?(?:head|hair)\b/.test(part)) continue;
          const prefix = new RegExp(`\\b(${token})[- ]+(?:${modifier}[- ]+){0,4}${kind}\\b(?![- ]+(?:buckle|loops?|print|motif)\\b)`, "g");
          const postfix = new RegExp(`\\b${kind} (?:is |in )(${token})\\b`, "g");
          const matches = [...part.matchAll(prefix), ...part.matchAll(postfix)];
          for (const match of matches) {
            const name = match[1];
            // Off-white shares the existing warm cream ramp; this is palette
            // quantization, not a provider-token or validation coercion.
            colors.add(/^off[- ]white$/.test(name) ? COLORS.cream : name === "tan" ? COLORS.beige
              : color(name, color(name.replace(/^(?:dark|light)[- ]/, ""), "")));
            evidence.push(match[0]);
          }
        }
      }
    }
    if (ambiguous || colors.size !== 1) continue;
    const resolved = [...colors][0];
    if (!resolved || result.accessories.filter(a => a.kind === kind && a.source === "observed").every(a => a.color === resolved)) continue;
    result = { ...result,
      accessories: result.accessories.map(a => a.kind === kind && a.source === "observed" ? { ...a, color: resolved } : a),
      provenance: [...result.provenance, { target: `accessories.${kind}.color`, source: "observed",
        evidence: [...new Set(evidence)].join("; "), confidence: 0.9 }],
    };
  }
  return result;
}

/** Bind an explicitly observed pair of solid sleeves to its own material.
 * A torso accent, cuff, pattern ink or another layer is not sleeve evidence.
 * This does not add sleeves, change their cut, or infer puff geometry.
 */
export function preserveObservedSleeveColor(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  if (!analysis.visibleRegions.upperBody ||
    [plan.upper.leftSleeve, plan.upper.rightSleeve].some(s => s.length === "sleeveless")) return plan;
  const observed = analysis.observed.clothing.toLowerCase();
  // Multiple upper garments require layer-specific ownership that this narrow
  // observation does not establish. Never borrow an inner shirt's sleeves.
  if ([...observed.matchAll(new RegExp(`\\b(?:${UPPER_WORDS})\\b`, "g"))].length !== 1) return plan;
  const scoped = garmentEvidence(observed, UPPER_WORDS);
  // Do not discard a later, potentially contradictory sleeve observation when
  // the garment scoper stops at a sentence or another garment.
  if ((observed.match(/\bsleeves?\b/g)?.length ?? 0) !== (scoped.match(/\bsleeves?\b/g)?.length ?? 0)) return plan;
  if (/\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded|unknown|left|right|one|single|striped|plaid|checkered|floral|patterned|printed)\b/.test(scoped)) return plan;
  if (new RegExp(`\\b(?:${COLOR_WORD})\\s*(?:and|/|,)\\s*(?:${COLOR_WORD})\\b`).test(scoped)) return plan;
  const token = `(?:(?:dark|light)[- ])?(?:${COLOR_WORD})`;
  const prefix = new RegExp(`\\b(${token})[- ]+(?:(?:short|long|puff|puffed|puffy|loose|wide|fitted|satin|silk)[- ]+){0,3}sleeves\\b`, "g");
  const postfix = new RegExp(`\\bsleeves (?:are |in )(${token})\\b`, "g");
  const matches = [...scoped.matchAll(prefix), ...scoped.matchAll(postfix)];
  const colors = new Set(matches.map(m => color(m[1], color(m[1].replace(/^(?:dark|light)[- ]/, ""), ""))));
  if (colors.size !== 1) return plan;
  const sleeveColor = [...colors][0];
  if (plan.upper.leftSleeve.color === sleeveColor && plan.upper.rightSleeve.color === sleeveColor) return plan;
  const evidence = matches.map(m => m[0]).join("; ");
  return { ...plan, upper: { ...plan.upper,
    leftSleeve: { ...plan.upper.leftSleeve, color: sleeveColor, source: "observed", evidence },
    rightSleeve: { ...plan.upper.rightSleeve, color: sleeveColor, source: "observed", evidence },
  }, provenance: [...plan.provenance, { target: "upper.sleeves.color", source: "observed", evidence, confidence: 0.9 }] };
}

/** Bind attached sleeve trim, not detached wrist accessories or trouser cuffs.
 * Only color existing paired long-sleeve hems; never create or lengthen them. */
export function preserveObservedSleeveCuffs(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  if (!analysis.visibleRegions.upperBody || !plan.outerLayer.regions.includes("cuffs") ||
    [plan.upper.leftSleeve, plan.upper.rightSleeve].some(s => s.length !== "long" || s.cuff)) return plan;
  const observed = analysis.observed.clothing.toLowerCase();
  if ([...observed.matchAll(new RegExp(`\\b(?:${UPPER_WORDS})\\b`, "g"))].length !== 1 ||
    (observed.match(/\bcuffs?\b/g)?.length ?? 0) !== 1) return plan;
  const scoped = garmentEvidence(observed, UPPER_WORDS);
  if (!/\bcuffs\b/.test(scoped) ||
    /\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded|unknown|absent|unclear|left|right|one|single|wrist|detached|gloves?|over|under|underneath|layered)\b/.test(observed) ||
    /\b(?:print|picture|depiction) of\b/.test(scoped)) return plan;
  const token = `(?:(?:dark|light)[- ])?(?:${COLOR_WORD})`;
  // Do not take the last member of a coordinated palette as a solid cuff.
  if (new RegExp(`\\b${token}\\s*(?:and|or|/|&|,)\\s*${token} (?:ribbed )?cuffs\\b`).test(scoped)) return plan;
  const match = new RegExp(`(?:, | with | and )(${token}) (?:ribbed )?cuffs$`).exec(scoped);
  if (!match) return plan;
  const cuff = { color: color(match[1], color(match[1].replace(/^(?:dark|light)[- ]/, ""), "")),
    source: "observed" as const, evidence: match[0].replace(/^(?:, | with | and )/, "") };
  return { ...plan, upper: { ...plan.upper,
    leftSleeve: { ...plan.upper.leftSleeve, cuff }, rightSleeve: { ...plan.upper.rightSleeve, cuff },
  }, provenance: [...plan.provenance, { target: "upper.sleeves.cuff", source: cuff.source, evidence: cuff.evidence, confidence: 0.9 }] };
}

/** Keep an observed standalone cropped upper garment finite. Layered or
 * uncertain construction stays unchanged; no source-specific anatomy guess. */
export function preserveObservedCroppedHem(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  if (!analysis.visibleRegions.upperBody || !analysis.visibleRegions.lowerBody || plan.formalSuit ||
    !["tshirt", "shirt", "sweater", "hoodie", "other"].includes(plan.upper.garmentType) ||
    ["other", "dress_continuation"].includes(plan.lower.garmentType) || plan.upper.neckline.innerVisible) return plan;
  const observed = analysis.observed.clothing.toLowerCase();
  if (/\b(?:over|under|underneath|layered)\b/.test(observed)) return plan;
  if ([...observed.matchAll(new RegExp(`\\b(?:${UPPER_WORDS})\\b`, "g"))].length !== 1) return plan;
  const scoped = garmentEvidence(observed, UPPER_WORDS);
  if (/\b(?:no|not|without|maybe|possibly|uncertain|hidden|occluded|layered|over|under|underneath|longline|untucked)\b/.test(scoped)) return plan;
  const crop = new RegExp(`\\b(?:cropped[- ]+(?:(?:${COLOR_WORD}|fitted|knit|ribbed|sleeveless)[- ]+){0,2}(?:top|shirt|t-shirt|tshirt|blouse|sweater|hoodie)|crop[- ]top)\\b`).exec(scoped);
  if (!crop) return plan;
  // One row is a restrained stylized gap, not measured body geometry. Require
  // affirmative source prose; cropped + high-waisted clothes may meet exactly.
  const gap = observed.split(/[.;]/).some(clause =>
    /\b(?:(?:bare|exposed|visible)[- ]+(?:midriff|belly|waist skin)|(?:midriff|belly|waist skin) (?:is )?(?:bare|exposed|visible))\b/.test(clause) &&
    !/\b(?:no|not|without|hidden|covered|uncertain|maybe|possibly)\b/.test(clause));
  const hem = { endRow: 8, skinGapRows: gap ? 1 : 0, source: "observed" as const,
    evidence: gap ? `${crop[0]}; explicitly observed exposed midriff` : `${crop[0]}; skin gap unobserved` };
  return { ...plan, upper: { ...plan.upper, hem }, lower: { ...plan.lower, waistRow: hem.endRow + hem.skinGapRows },
    provenance: [...plan.provenance, { target: "upper.hem", source: "observed", evidence: hem.evidence, confidence: 0.9 }] };
}

export function scoreOutfitPlan(plan: OutfitPlan): OutfitCandidateCost {
  const outerArea = plan.outerLayer.expectedPixels;
  const errors = {
    garmentStructureError: plan.upper.garmentType === "other" ? 0.35 : 0,
    dominantColorBlockError: plan.upper.colorBlocks.length === 0 ? 1 : 0,
    sleeveError: plan.upper.leftSleeve.terminationRow < 0 || plan.upper.rightSleeve.terminationRow < 0 ? 1 : 0,
    necklineError: plan.upper.neckline.kind === "unknown" ? 0.3 : 0,
    waistBoundaryError: plan.lower.waistRow < 7 || plan.lower.waistRow > 11 ? 0.5 : 0,
    patternLoss: plan.upper.pattern.kind !== "none" && plan.salience.pixelBudget.pattern < 6 ? 0.5 : 0,
    accessoryLoss: plan.accessories.length > 0 && plan.salience.pixelBudget.accessories < 4 ? 0.5 : 0,
    seamPenalty: plan.upper.pattern.placement === "front" && plan.upper.pattern.kind === "horizontal_stripe" ? 0.5 : 0,
    craftPenalty: plan.upper.colorBlocks.length > 6 ? 0.3 : 0,
    outerInflation: Math.max(0, (outerArea - 52) / 52),
  };
  const total = errors.garmentStructureError * 1.4 + errors.dominantColorBlockError * 1.7 + errors.sleeveError * 1.4 + errors.necklineError + errors.waistBoundaryError + errors.patternLoss * 1.2 + errors.accessoryLoss + errors.seamPenalty * 1.2 + errors.craftPenalty + errors.outerInflation * 1.5;
  return { ...errors, total };
}

/** Detached wrist cuffs are not sleeve hems. Only an explicitly observed pair
 * with one locally attached palette is eligible; do not create long sleeves,
 * infer a matching hidden cuff, or borrow a neck/leg accessory's color. */
export function preserveObservedWristCuffs(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  if (!analysis.visibleRegions.upperBody || plan.accessories.some(a => a.kind === "wrist_cuff")) return plan;
  const observations = [analysis.observed.clothing, analysis.observed.accessories].join(". ").toLowerCase();
  const clauses = observations.split(/[.;\n]/).filter(c => /\bwrists?\b/.test(c) && /\bcuffs?\b/.test(c));
  if (!clauses.length || clauses.some(c => /\b(?:no|not|without|possibly|maybe|uncertain|hidden|occluded|unknown|absent|left|right|one|single|stripes?|striped|pattern(?:ed)?|floral|print(?:ed)?|checks?|checkered)\b/.test(c))) return plan;
  const colors = new Set<string>(), evidence: string[] = [];
  for (const clause of clauses) {
    // Require every cuff mention to resolve; don't discard contradictions or
    // coordinated colors by taking only the last color before the noun.
    if (new RegExp(`\\b(?:${COLOR_WORD})\\s*(?:and|/|,)\\s*(?:${COLOR_WORD})\\b`).test(clause)) return plan;
    const token = `(?:(?:dark|light)[- ])?(?:${COLOR_WORD})`;
    // Equivalent explicit localization: "pink fabric cuffs on both wrists".
    // The post-noun form must name both wrists, never infer the hidden side.
    const pair = "(?:wrist[- ]cuffs|cuffs (?:on|around) (?:both|the two) wrists)";
    const prefix = new RegExp(`\\b(${token})[- ]+(?:(?:ruffled|frilled|satin|silk|fabric|detached)[- ]+){0,2}${pair}\\b`, "g");
    const postfix = new RegExp(`\\bwrist[- ]cuffs (?:are |in )(${token})\\b`, "g");
    const matches = [...clause.matchAll(prefix), ...clause.matchAll(postfix)];
    if (matches.length !== (clause.match(/\bcuffs?\b/g)?.length ?? 0)) return plan;
    for (const match of matches) {
      colors.add(color(match[1], color(match[1].replace(/^(?:dark|light)[- ]/, ""), "")));
      evidence.push(match[0]);
    }
  }
  if (colors.size !== 1) return plan;
  const proof = [...new Set(evidence)].join("; ");
  return { ...plan,
    accessories: [...plan.accessories, { kind: "wrist_cuff", color: [...colors][0], side: "center", source: "observed", evidence: proof }],
    outerLayer: { ...plan.outerLayer, expectedPixels: plan.outerLayer.expectedPixels + 32 },
    salience: { ...plan.salience, secondary: [...plan.salience.secondary,
      { id: "accessory_wrist_cuff", salience: 0.7, evidence: proof, targets: ["arm.left", "arm.right"] }] },
    provenance: [...plan.provenance, { target: "accessories.wrist_cuff", source: "observed", evidence: proof, confidence: 0.9 }],
  };
}

export function preserveObservedKneeDistressing(
  plan: OutfitPlan, analysis: Pick<PhotoAnalysis, "observed" | "visibleRegions">,
): OutfitPlan {
  if (!analysis.visibleRegions.lowerBody || plan.lower.garmentType !== "jeans" || plan.lower.source !== "observed"
    || plan.lower.garmentRows < 9 || plan.lower.shoeRows > 3 || plan.lower.legwear.kind !== "none"
    || plan.lower.pattern.kind !== "none" || plan.lower.kneeDistressing) return plan;
  const observed = analysis.observed.clothing.toLowerCase().replace(/’/g, "'");
  // A later denial without repeating "knee" must not be silently discarded.
  if (observed.split(/[.;\n]/).some(c => /\b(?:no|not|without|absent|uncertain|unclear|possibly|maybe)\b/.test(c)
    && /\b(?:rips?|ripped|torn|frayed|holes?|distressing)\b/.test(c))) return plan;
  const jeans = /\bjeans\b/.exec(observed);
  if (!jeans || [...observed.matchAll(/\bjeans\b/g)].length !== 1) return plan;
  // Preserve coordinated construction after the same garment ("wide-leg cut
  // and ripped distressing..."). The generic palette scoper stops at "and"
  // before a later shoe noun, which would discard this observed knee clause.
  const prefix = garmentEvidence(observed, "jeans").split(/\bjeans\b/)[0];
  const suffix = observed.slice(jeans.index + jeans[0].length).split(/[.;\n]/)[0]
    .split(new RegExp(`\\b(?:${ALL_GARMENTS})\\b`))[0];
  const scoped = `${prefix}jeans${suffix}`.trim();
  if (!scoped || /\b(?:no|not|without|or|possibly|maybe|uncertain|unknown|unclear|hidden|occluded|covered|patched|repaired|print|printed)\b/.test(scoped)
    || (observed.match(/\bknees?\b/g)?.length ?? 0) !== (scoped.match(/\bknees?\b/g)?.length ?? 0)) return plan;
  const parts = new Set<"leftLeg" | "rightLeg">();
  const location = "(?:(viewer|wearer|subject)(?:'s)?[- ]+)?(left|right|both)[- ]+knees?";
  const damage = "(?:ripped(?: distressing)?|torn|frayed|rips?|holes?)";
  const forward = new RegExp(`\\b${damage} (?:on|at|over) (?:the )?${location}\\b`, "g");
  const reverse = new RegExp(`\\b${location} (?:is |are |has |have )?${damage}\\b`, "g");
  const adjective = new RegExp(`\\b(?:ripped|torn|frayed) ${location}\\b`, "g");
  // The location may qualify the leg after an explicit damaged-knee detail.
  // A generic rip somewhere on a leg still does not establish a knee location.
  const kneeOnLeg = new RegExp("\\b(?:ripped|torn|frayed) knees? (?:details?|distressing) (?:on|at|over) (?:the )?(?:(viewer|wearer|subject)(?:'s)?[- ]+)?(left|right|both)[- ]+legs?\\b", "g");
  for (const m of [...scoped.matchAll(forward), ...scoped.matchAll(reverse), ...scoped.matchAll(adjective), ...scoped.matchAll(kneeOnLeg)]) {
    const [, perspective, side] = m;
    if (side === "both") { parts.add("leftLeg"); parts.add("rightLeg"); }
    else parts.add((side === "right") !== (perspective === "viewer") ? "rightLeg" : "leftLeg");
  }
  if (!parts.size) return plan;
  const exposedSkin = /\b(?:exposed|visible|bare) skin (?:through|inside|in) (?:the )?(?:knee )?(?:rips?|holes?|tears?)\b/.test(scoped);
  const kneeDistressing = { parts: [...parts].sort(), exposedSkin, source: "observed" as const, evidence: scoped };
  return { ...plan, lower: { ...plan.lower, kneeDistressing },
    provenance: [...plan.provenance, { target: "lower.kneeDistressing", source: "observed", evidence: scoped, confidence: 0.85 }] };
}

export function buildOutfitPlanCandidates(analysis: PhotoAnalysis, maxCandidates = 3): OutfitPlan[] {
  const cap = Math.max(1, Math.min(3, Math.floor(maxCandidates)));
  const observedBase = preserveObservedWristCuffs(preserveObservedCroppedHem(preserveObservedSleeveColor(preserveObservedNeckBowColor(preserveObservedFormalSuit(preserveObservedCardiganSleeves(baseOutfitPlan(analysis), analysis), analysis), analysis), analysis), analysis), analysis);
  const base = preserveObservedSleeveCuffs(preserveObservedKneeDistressing(preserveObservedScarfBeltColors(observedBase, analysis), analysis), analysis);
  const candidates = [base];
  if (cap > 1 && base.upper.neckline.source !== "observed") {
    candidates.push({ ...base, upper: { ...base.upper, neckline: { ...base.upper.neckline, depth: Math.max(1, base.upper.neckline.depth - 1) } }, candidate: { index: 1, axis: "neckline_boundary", cost: 0 } });
  }
  if (candidates.length < cap && base.lower.source !== "observed") {
    candidates.push({ ...base, lower: { ...base.lower, waistRow: Math.max(8, base.lower.waistRow - 1) }, candidate: { index: candidates.length, axis: "waist_boundary", cost: 0 } });
  }
  return candidates.map((candidate) => ({ ...candidate, candidate: { ...candidate.candidate, cost: scoreOutfitPlan(candidate).total } })).sort((a, b) => a.candidate.cost - b.candidate.cost || a.candidate.index - b.candidate.index);
}

export function buildOutfitPlan(analysis: PhotoAnalysis): OutfitPlan {
  return buildOutfitPlanCandidates(analysis, 3)[0];
}

export function outfitPlanSignature(plan: OutfitPlan): string {
  return [plan.upper.garmentType, plan.upper.neckline.kind, plan.upper.leftSleeve.terminationRow, plan.upper.rightSleeve.terminationRow, plan.upper.colorBlocks.map((block) => `${block.region}:${block.color}`).join("|"), plan.lower.garmentType, plan.lower.waistRow, plan.lower.garmentRows, plan.lower.accent, `${plan.lower.legwear.kind}:${plan.lower.legwear.asymmetry}`, plan.upper.pattern.kind, plan.accessories.map((item) => item.kind).join("+"), plan.outerLayer.regions.join("+"),
    ...(plan.upper.hem ? [`hem:${plan.upper.hem.endRow}:gap:${plan.upper.hem.skinGapRows}`] : []),
    ...(["leftSleeve", "rightSleeve"] as const).flatMap(side => plan.upper[side].cuff ? [`${side}.cuff:${plan.upper[side].cuff!.color}`] : []),
    ...(plan.upper.pattern.construction === "pixel_blocks" ? [`pixel_blocks:${plan.upper.pattern.blockColors?.join(",")}`] : []),
    ...(plan.upper.pattern.construction === "stepped_gradient" ? [`gradient:${plan.upper.pattern.gradientDirection ?? "designed_vertical"}:${plan.upper.pattern.gradientColors?.join(",")}`] : []),
    ...(plan.upper.pattern.frontGraphic ? [`front_graphic:${plan.upper.pattern.frontGraphic.anchor}:${plan.upper.pattern.frontGraphic.color}`] : []),
    ...(plan.lower.kneeDistressing ? [`knee:${plan.lower.kneeDistressing.parts.join("+")}:skin:${plan.lower.kneeDistressing.exposedSkin}`] : []),
  ].join(";");
}
