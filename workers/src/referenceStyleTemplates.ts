/** Reference-derived design choices, not new source measurements.
 * Pure and bounded: no provider call, inferred demographic, or fixture ID.
 * The existing measurement/layout contracts remain the coordinate authority.
 */
import type { PhotoAnalysis } from "./analysis";
import type { BodyPart } from "./uvLayout";
import { hasObservedFloralGarment } from "./outfitIdentity";
import { observedFrontHairDrape } from "./observedFrontHairDrape";

export const FACE_STYLE_TEMPLATES = {
  soft_feminine_calm: { eyeFinish: "soft", irisPigment: 1.55, irisGlint: 0.82, noseCells: 0, mouthCells: 0, complexionContrast: 0.08, lipContrast: 0.16, blush: false },
  soft_feminine_doll: { eyeFinish: "upper_lash", irisPigment: 1.65, irisGlint: 0.86, noseCells: 0, mouthCells: 2, complexionContrast: 0.07, lipContrast: 0.18, blush: true },
  cute_pastel: { eyeFinish: "bright", irisPigment: 1.7, irisGlint: 0.90, noseCells: 0, mouthCells: 2, complexionContrast: 0.06, lipContrast: 0.14, blush: true },
  clean_masculine_soft: { eyeFinish: "clean", irisPigment: 1.4, irisGlint: 0.68, noseCells: 1, mouthCells: 0, complexionContrast: 0.10, lipContrast: 0.12, blush: false },
  cool_androgynous: { eyeFinish: "clean", irisPigment: 1.5, irisGlint: 0.78, noseCells: 0, mouthCells: 2, complexionContrast: 0.09, lipContrast: 0.14, blush: false },
  dark_stylish: { eyeFinish: "upper_rim", irisPigment: 1.45, irisGlint: 0.72, noseCells: 0, mouthCells: 2, complexionContrast: 0.10, lipContrast: 0.16, blush: false },
} as const;

export type FaceStyleFamily = keyof typeof FACE_STYLE_TEMPLATES;
export type HairAccent = "fringe" | "temple" | "crown_edge" | "side_lock" | "braid_front" | "tied_section" | "accessory";
interface HairDesign {
  strandGrammar: "staggered" | "soft" | "layered" | "straight" | "wave" | "braid" | "paired_locks" | "covered";
  accents: readonly HairAccent[];
  outerHairRatio: number;
}
export const HAIR_STYLE_TEMPLATES = {
  short_shaggy_masculine: { strandGrammar: "staggered", accents: ["fringe", "temple", "crown_edge"], outerHairRatio: 0.24 },
  short_soft_feminine: { strandGrammar: "soft", accents: ["fringe", "temple"], outerHairRatio: 0.20 },
  medium_layered: { strandGrammar: "layered", accents: ["fringe", "side_lock", "crown_edge"], outerHairRatio: 0.28 },
  long_straight_with_bangs: { strandGrammar: "straight", accents: ["fringe", "side_lock"], outerHairRatio: 0.28 },
  long_wavy_with_bangs: { strandGrammar: "wave", accents: ["fringe", "side_lock", "crown_edge"], outerHairRatio: 0.30 },
  twin_braids: { strandGrammar: "braid", accents: ["fringe", "braid_front", "tied_section"], outerHairRatio: 0.30 },
  twin_tails: { strandGrammar: "paired_locks", accents: ["fringe", "tied_section", "accessory"], outerHairRatio: 0.30 },
  long_pastel_straight: { strandGrammar: "straight", accents: ["fringe", "side_lock", "accessory"], outerHairRatio: 0.25 },
  hoodie_beanie_compatible: { strandGrammar: "covered", accents: ["fringe", "side_lock"], outerHairRatio: 0.18 },
} as const satisfies Record<string, HairDesign>;
export type HairStyleFamily = keyof typeof HAIR_STYLE_TEMPLATES | "preserve_existing";

export type GarmentAccent = "collar" | "cuff" | "hem" | "scarf" | "ribbon" | "hood_rim" | "pocket" | "pleat" | "belt" | "sleeve_graphic";
interface OutfitDesign { accents: readonly GarmentAccent[]; patternPolicy: "observed_only"; }
export const OUTFIT_STYLE_TEMPLATES = {
  casual_knit_cardigan: { accents: ["collar", "cuff", "hem", "scarf"], patternPolicy: "observed_only" },
  clean_sweatshirt_casual: { accents: ["cuff", "hem"], patternPolicy: "observed_only" },
  pastel_cute_top: { accents: ["collar", "cuff", "hem"], patternPolicy: "observed_only" },
  ribbon_top_skirt: { accents: ["ribbon", "cuff", "pleat", "belt"], patternPolicy: "observed_only" },
  school_cardigan_uniform: { accents: ["collar", "ribbon", "cuff", "pleat"], patternPolicy: "observed_only" },
  dark_hoodie_streetwear: { accents: ["hood_rim", "cuff", "hem", "pocket"], patternPolicy: "observed_only" },
  black_floral_streetwear: { accents: ["cuff", "hem", "sleeve_graphic"], patternPolicy: "observed_only" },
  pastel_hoodie_streetwear: { accents: ["hood_rim", "cuff", "hem", "pocket"], patternPolicy: "observed_only" },
} as const satisfies Record<string, OutfitDesign>;
export type OutfitStyleFamily = keyof typeof OUTFIT_STYLE_TEMPLATES | "preserve_existing";

/** Ratios use the entire legal outer cuboid, not its enclosing atlas rectangle.
 * These are proposed design budgets, not measured provider/calibration values.
 */
export const REFERENCE_OUTER_COVERAGE = {
  head: 0.38, body: 0.30, rightArm: 0.25, leftArm: 0.25, rightLeg: 0.22, leftLeg: 0.22,
} as const satisfies Record<BodyPart, number>;

export interface TemplateCandidate<T extends string> {
  family: T;
  cost: number;
  evidence: string[];
}
export interface ReferenceStylePlan {
  /** Internal presentation version, unrelated to provider Compact V3/V4. */
  version: "reference_style_v1" | "reference_style_v2";
  provenance: "template_design";
  /** Authored categorical presentation; absent on immutable historical plans. */
  eyeBoundaryPolicy?: "paired_lower_pigment";
  /** Authored display layout, not observed facial measurements. */
  faceLayoutPolicy?: "mouthless_lower_eyes";
  hairPalettePolicy?: "continuous_material";
  headProportionPolicy?: "reference_low_eyes_v1";
  /** Material-only authored finish; historical plans without it remain exact. */
  materialDetailPolicy?: "clustered_material_v1" | "tapered_material_v2";
  /** Source-supported crown/back relief; absent on immutable historical plans. */
  hairVolumePolicy?: "crown_relief_v1";
  headSeamPolicy?: "connected_outline_v1";
  face: TemplateCandidate<FaceStyleFamily>;
  hair: TemplateCandidate<HairStyleFamily>;
  outfit: TemplateCandidate<OutfitStyleFamily>;
  candidates: {
    face: TemplateCandidate<FaceStyleFamily>[];
    hair: TemplateCandidate<HairStyleFamily>[];
    outfit: TemplateCandidate<OutfitStyleFamily>[];
  };
  drape: { eligible: boolean; evidence: string[]; maxShoulderColumns: 0 | 1; rearCompletion?: "source_supported" };
  composition: "inner_first_selective_outer";
  preserve: readonly ["eye_geometry", "source_palette", "expression", "accessories", "facial_hair"];
}

function categoryEvidence(a: PhotoAnalysis, category: "hair" | "outfit" | "face" | "accessory"): string {
  const observed = category === "outfit" ? a.observed.clothing : category === "accessory" ? a.observed.accessories : a.observed[category];
  // Conservative canonical claims may select neither a new hairstyle nor a motif.
  return [observed, ...a.canonicalIdentity.features
    .filter(f => f.category === category && f.confidence === "high")
    .map(f => `${f.feature}. ${f.evidence}`)].join(". ").toLowerCase();
}

/** Clause-local negation: 'no braids; ...' cannot create braids. No claim that
 * arbitrary natural-language entailment is solved here; explicit clauses only.
 */
function positive(text: string, pattern: RegExp): boolean {
  return text.split(/[.;\n]/).some(clause => pattern.test(clause) && !/\b(?:no|not|without|absent|unknown|unseen)\b/.test(clause));
}

/** A hooded garment is not evidence of a worn head covering. This only gates
 * the compatible hair grammar; existing source ownership still owns headwear. */
function positiveWornCovering(text: string, pattern: RegExp): boolean {
  return text.split(/[.;\n]/).some(clause => positive(clause, pattern)
    && !/\b(?:possibly|maybe|uncertain|hidden|obscured|picture|depicting|graphic|print|held|holding|carried|hand)\b/.test(clause));
}

function rank<T extends string>(values: TemplateCandidate<T>[]): TemplateCandidate<T>[] {
  // Stable tie-break independent of provider feature order and locale settings.
  return values.sort((a, b) => a.cost - b.cost || (a.family < b.family ? -1 : a.family > b.family ? 1 : 0)).slice(0, 3);
}

export function buildReferenceStylePlan(a: PhotoAnalysis): ReferenceStylePlan {
  const hair = categoryEvidence(a, "hair"), outfit = categoryEvidence(a, "outfit");
  const accessories = categoryEvidence(a, "accessory"), face = categoryEvidence(a, "face");
  const h = a.renderHints;
  const pastelOutfit = positive(outfit, /\b(?:pastel|pale pink|pale lilac|lavender|mint)\b/);
  const darkOutfit = positive(outfit, /\b(?:black|dark|charcoal)\b/);
  const hoodie = positive(outfit, /\bhood(?:ie|ed)\b/);
  const covered = positiveWornCovering(accessories, /\b(?:beanie|knit cap)\b/)
    || positiveWornCovering([hair, outfit, accessories].join(". "), /\bhood (?:is )?(?:up\b|(?:worn|pulled) (?:up )?over (?:the )?head\b)/);
  const bangs = h.bangs !== "none";
  const long = ["shoulder", "chest", "waist", "hip"].includes(h.overallHairLength);
  const short = ["cropped", "ear"].includes(h.overallHairLength);
  const candidates: ReferenceStylePlan["candidates"] = { face: [], hair: [], outfit: [] };
  const addFace = (family: FaceStyleFamily, cost: number, evidence: string) => candidates.face.push({ family, cost, evidence: [evidence] });
  // Aesthetic family names are not claims about a person's sex/gender.
  addFace("cool_androgynous", 10, "neutral clean design; no demographic inference");
  if (h.faceShape === "round" || h.faceShape === "oval") addFace("soft_feminine_calm", 7, "structured faceShape: soft contour");
  if (h.eyeShape === "round" && h.eyeSize === "large") addFace("soft_feminine_doll", 5, "structured eyes: round/large");
  if (pastelOutfit) addFace("cute_pastel", 3, "observed pastel garment palette");
  if (darkOutfit) addFace("dark_stylish", 6, "observed dark garment palette");
  if (positive(face, /\b(?:clean[- ]shaven|soft jaw(?:line)?|smooth complexion)\b/)) addFace("clean_masculine_soft", 6, "observed smooth/soft face construction");
  const addHair = (family: HairStyleFamily, cost: number, evidence: string) => candidates.hair.push({ family, cost, evidence: [evidence] });
  addHair("preserve_existing", 20, "existing source-derived hair mask remains authoritative");
  // Special styles require positive observed evidence; generic length cannot fabricate them.
  const specialMass = !a.visibleRegions.hair || positive(hair, /\b(?:bun|topknot|bald|shaved|buzz(?:ed)?|coily|curly|headscarf)\b/)
    || ["curly", "coily"].includes(h.hairTexture)
    || a.fallbackFeatures.hairstyle === "bald";
  // Coverings, buzz material, buns and curl topology must not become loose locks.
  if (!specialMass) {
    if (positive(hair, /\b(?:twin|two|double|paired)\b[^.;]*\bbraids?\b/)) addHair("twin_braids", 0, "observed paired braids");
    if (positive(hair, /\b(?:twin[- ]?tails|pigtails|two ponytails|paired ponytails)\b/)) addHair("twin_tails", 0, "observed paired tied sections");
    if (covered) addHair("hoodie_beanie_compatible", 1, "observed worn hood/beanie; keep source hair below covering");
    if (short) {
      addHair("short_shaggy_masculine", h.fringeEdge === "staggered" ? 4 : 9, "structured short length/fringe edge");
      addHair("short_soft_feminine", h.fringeEdge === "staggered" ? 8 : 4, "structured short length/soft edge");
    }
    if (h.overallHairLength === "jaw") addHair("medium_layered", 4, "structured jaw-length hair");
    if (long && bangs && h.hairTexture === "straight") addHair("long_straight_with_bangs", 4, "structured long straight hair with bangs");
    if (long && bangs && h.hairTexture === "wavy") addHair("long_wavy_with_bangs", 4, "structured long wavy hair with bangs");
    if (long && h.hairTexture === "straight" && positive(hair, /\b(?:pastel|pink|lavender|mint)\b/)) addHair("long_pastel_straight", 2, "observed pastel straight long hair");
  }
  const addOutfit = (family: OutfitStyleFamily, cost: number, evidence: string) => candidates.outfit.push({ family, cost, evidence: [evidence] });
  addOutfit("preserve_existing", 20, "existing source garment plan; never invent a signature motif");
  if (positive(outfit, /\b(?:knit|cardigan)\b/)) addOutfit("casual_knit_cardigan", 6, "observed knit/cardigan");
  if (positive(outfit, /\bsweatshirt\b/)) addOutfit("clean_sweatshirt_casual", 5, "observed sweatshirt");
  if (pastelOutfit) addOutfit("pastel_cute_top", 7, "observed pastel top");
  if (positive(outfit, /\b(?:ribbon|bow)\b/) && positive(outfit, /\bskirt\b/)) addOutfit("ribbon_top_skirt", 2, "observed ribbon and skirt");
  if (positive(outfit, /\b(?:uniform|school|lolita)\b/)) addOutfit("school_cardigan_uniform", 1, "observed uniform construction");
  if (hoodie && darkOutfit) addOutfit("dark_hoodie_streetwear", 1, "observed dark hoodie");
  if (hoodie && pastelOutfit) addOutfit("pastel_hoodie_streetwear", 1, "observed pastel hoodie");
  if (darkOutfit && hasObservedFloralGarment(a)) addOutfit("black_floral_streetwear", 1, "observed dark floral garment");
  candidates.face = rank(candidates.face); candidates.hair = rank(candidates.hair); candidates.outfit = rank(candidates.outfit);
  // Drape needs an explicit observation reaching the shoulder, not inferred back hair.
  const drapeEvidence = a.visibleRegions.hair && long ? observedFrontHairDrape(hair) : null;
  // Rear continuity is an explicitly inferred completion, not a front-drape
  // observation. Keep those two provenance classes separate in the design.
  const rearCompletion = a.visibleRegions.hair && ["chest", "waist", "hip"].includes(h.overallHairLength)
    && h.hairBackShape === "long" && !!a.inferred.hairBack.value.trim();
  return {
    version: "reference_style_v2", provenance: "template_design",
    eyeBoundaryPolicy: "paired_lower_pigment",
    faceLayoutPolicy: "mouthless_lower_eyes",
    headProportionPolicy: "reference_low_eyes_v1",
    materialDetailPolicy: "tapered_material_v2",
    hairVolumePolicy: "crown_relief_v1",
    headSeamPolicy: "connected_outline_v1",
    hairPalettePolicy: "continuous_material",
    face: candidates.face[0], hair: candidates.hair[0], outfit: candidates.outfit[0], candidates,
    drape: { eligible: drapeEvidence !== null, evidence: drapeEvidence ? [drapeEvidence === "observed_shoulder_drape"
      ? "observed long hair drapes over shoulder" : drapeEvidence === "observed_front_shoulder_endpoint"
        ? "observed front locks end at shoulders" : "observed front/side hair reaches torso"] : [], maxShoulderColumns: drapeEvidence ? 1 : 0,
      ...(rearCompletion ? { rearCompletion: "source_supported" as const } : {}) },
    composition: "inner_first_selective_outer",
    preserve: ["eye_geometry", "source_palette", "expression", "accessories", "facial_hair"],
  };
}
