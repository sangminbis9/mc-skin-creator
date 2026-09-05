import type { PhotoAnalysis } from "./analysis";

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
}

export interface OutfitPatternPlan {
  kind: OutfitPatternKind;
  color: string;
  placement: "front" | "wrap" | "front_and_sleeves";
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
    pattern: OutfitPatternPlan;
    accent: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
    legwear: {
      kind: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
      color: string;
      asymmetry: "none" | "left" | "right" | "both";
      source: OutfitEvidence;
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
  denim: "#49647d", purple: "#755386", pink: "#c8798c", brown: "#684b38",
  beige: "#c5aa82", cream: "#ded2b6", gold: "#c6a34b", silver: "#b9bec5",
};

function color(value: string | undefined, fallback: string): string {
  if (value && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const normalized = value?.trim().toLowerCase().replaceAll("_", "-") ?? "";
  return COLORS[normalized] ?? fallback;
}

const COLOR_WORD = "black|white|gray|grey|red|orange|yellow|green|blue|navy|denim|purple|pink|brown|beige|cream|gold|silver";

function garmentColorFromText(text: string, garmentWords: string, fallback: string): string {
  const direct = new RegExp(`\\b(?:bright|dark|light|muted|soft|dusty)?[- ]*(${COLOR_WORD})\\b[^.,;]{0,48}\\b(?:${garmentWords})\\b`).exec(text)?.[1];
  const reversed = new RegExp(`\\b(?:${garmentWords})\\b[^.,;]{0,28}\\b(${COLOR_WORD})\\b`).exec(text)?.[1];
  return color(direct ?? reversed, fallback);
}

function evidenceText(analysis: PhotoAnalysis): string {
  const design = analysis.inferred.lowerBodyDesign;
  return `${analysis.observed.clothing} ${analysis.observed.accessories} ${analysis.outfitPrompt} ${analysis.inferred.lowerBody?.value ?? ""} ${analysis.inferred.shoes?.value ?? ""} ${design ? `${design.bottomType} ${design.bottomPattern} ${design.bottomAccent} ${design.legwear} ${design.legwearAsymmetry} ${design.thighAccessory} ${design.thighAccessorySide} ${design.shoeStyle} ${design.rationale}` : ""}`.toLowerCase();
}

function upperType(analysis: PhotoAnalysis, text: string): UpperGarmentType {
  if (analysis.renderHints.outerGarment === "coat" || /\bcoat\b/.test(text)) return "coat";
  if (analysis.renderHints.outerGarment === "open_jacket" || /\b(?:jacket|cardigan)\b/.test(text)) return "jacket";
  if (analysis.renderHints.outerGarment === "vest" || /\bvest\b/.test(text)) return "vest";
  const value = analysis.fallbackFeatures.topType;
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

function pattern(text: string, texture: PhotoAnalysis["renderHints"]["garmentTexture"], accent: string): OutfitPatternPlan {
  let kind: OutfitPatternKind = "none";
  let placement: OutfitPatternPlan["placement"] = "front";
  if (/\b(?:horizontal|striped|stripes)\b/.test(text) || texture === "striped") {
    kind = /\bvertical\b/.test(text) ? "vertical_stripe" : "horizontal_stripe";
    placement = "wrap";
  } else if (/\b(?:plaid|checkered|checked)\b/.test(text)) {
    kind = "checker_block";
    placement = "wrap";
  } else if (/\b(?:graphic|badge|marking|large logo|center logo)\b/.test(text)) {
    kind = "center_graphic";
  } else if (texture === "patterned" || /\b(?:floral|patterned|irregular)\b/.test(text)) {
    kind = "irregular_group";
  }
  const anchor = /viewer[- ]left|left chest/.test(text) ? "left" : /viewer[- ]right|right chest/.test(text) ? "right" : "center";
  return { kind, color: accent, placement, anchor, frequency: kind === "horizontal_stripe" ? 3 : 2, source: kind === "none" ? "conservative" : "observed", evidence: text };
}

function lowerPattern(analysis: PhotoAnalysis, text: string, accent: string): OutfitPatternPlan {
  const structured = analysis.inferred.lowerBodyDesign?.bottomPattern;
  const value = /\b(?:plaid|checkered|checked)\b/.test(text) ? "plaid" : /\b(?:striped|stripes)\b/.test(text) ? "striped" : /\bpleated?\b/.test(text) ? "pleated" : analysis.renderHints.bottomPattern !== "plain" ? analysis.renderHints.bottomPattern : structured ?? "plain";
  const kind: OutfitPatternKind = value === "striped" ? "horizontal_stripe" : value === "plaid" ? "checker_block" : value === "pleated" ? "vertical_stripe" : value === "lace" ? "irregular_group" : "none";
  return { kind, color: accent, placement: kind === "none" ? "front" : "wrap", anchor: "center", frequency: 2, source: analysis.visibleRegions.lowerBody && kind !== "none" ? "observed" : "conservative", evidence: analysis.observed.clothing };
}

function accessoryPlans(analysis: PhotoAnalysis, text: string, accent: string): OutfitAccessoryPlan[] {
  const result: OutfitAccessoryPlan[] = [];
  const add = (kind: OutfitAccessoryKind, side: OutfitAccessoryPlan["side"] = "center") => result.push({ kind, color: accent, side, source: "observed", evidence: text });
  if (/\b(?:crossbody|cross-body|diagonal bag|bag strap)\b/.test(text)) add("bag_strap", "crossbody");
  if (analysis.renderHints.neckAccessory === "tie") add("tie");
  if (analysis.renderHints.neckAccessory === "bow" || /\b(?:bow collar|neck bow)\b/.test(text)) add("bow");
  else if (analysis.renderHints.neckAccessory === "scarf" || /\bneck scarf\b/.test(text)) add("scarf");
  if (analysis.renderHints.necklace !== "none" || /\b(?:necklace|chain|pendant)\b/.test(text)) {
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
  return result;
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
  return { kind, color: colorValue, asymmetry, source: analysis.visibleRegions.lowerBody ? "observed" : "conservative" };
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
  const upperTextSource = /\b(?:top|shirt|blouse|sweater|hoodie|jacket|cardigan|coat|vest|dress|jersey)\b/.test(observedClothing) ? observedClothing : clothingText;
  const upperText = upperTextSource.split(/\b(?:pants|trousers|jeans|shorts|skirt|leggings|skort)\b/, 1)[0];
  const topColor = garmentColorFromText(clothingText, "top|shirt|t-shirt|tshirt|blouse|sweater|hoodie|jacket|cardigan|coat|vest|dress|jersey", color(analysis.fallbackFeatures.topColor, "#516e91"));
  const accentColor = color(analysis.fallbackFeatures.topAccentColor, "#e7e2d7");
  const bottomColor = garmentColorFromText(clothingText, "pants|trousers|jeans|shorts|skirt|leggings|bottom", color(analysis.fallbackFeatures.bottomColor, "#39485f"));
  const shoeColor = garmentColorFromText(clothingText, "shoes|sneakers|boots|loafers|sandals|footwear", color(analysis.fallbackFeatures.shoesColor, "#383438"));
  const leftLength = sleeveLength(analysis.fallbackFeatures.sleeveLength, text, "left");
  const rightLength = sleeveLength(analysis.fallbackFeatures.sleeveLength, text, "right");
  const contrastingSleeves = /\b(?:contrasting|contrast|raglan|two[- ]tone) sleeves?\b/.test(text);
  const leftSleeveColor = contrastingSleeves || /\bleft sleeve[^.]{0,24}(?:contrasting|accent)\b/.test(text) ? accentColor : topColor;
  const rightSleeveColor = contrastingSleeves || /\bright sleeve[^.]{0,24}(?:contrasting|accent)\b/.test(text) ? accentColor : topColor;
  const neck = neckline(garmentType, text, analysis.renderHints.neckAccessory);
  const upperPattern = pattern(upperText, analysis.renderHints.garmentTexture, accentColor);
  const upperEvidence: OutfitEvidence = analysis.visibleRegions.upperBody ? "observed" : "conservative";
  const isOuter = ["jacket", "coat", "vest"].includes(garmentType) || analysis.renderHints.outerGarment !== "none";
  const openConstruction = /\b(?:open[- ]front|open [^.]{0,20}(?:jacket|cardigan|coat)|unbuttoned)\b/.test(clothingText);
  const innerVisible = neck.innerVisible && (!isOuter || openConstruction);
  const colorBlocks: OutfitColorBlock[] = [{ id: "upper_base", region: "all", color: topColor, source: upperEvidence, priority: 1 }];
  if (innerVisible) colorBlocks.push({ id: "inner_panel", region: "front_center", color: accentColor, source: upperEvidence, priority: 0.95 });
  if (isOuter && openConstruction) colorBlocks.push({ id: "opening", region: "vertical_opening", color: accentColor, source: upperEvidence, priority: 0.9 });
  if (upperPattern.kind === "horizontal_stripe") colorBlocks.push({ id: "stripe_band", region: "horizontal_band", color: accentColor, source: upperEvidence, priority: 0.88 });
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
  let lowerPatternPlan = lowerPattern(analysis, text, accentColor);
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
  if (lowerPatternPlan.kind !== "none") outerRegions.push("pattern_depth");
  if (upperPattern.kind === "center_graphic") outerRegions.push("graphic_depth");
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
  expectedOuterPixels += accessories.reduce((sum, item) => sum + ({ bow: /\bbroad\b/.test(item.evidence) ? 12 : 9, scarf: 7, tie: 6, necklace: 7, suspenders: 18, belt: 24, hood_string: 4, bag_strap: 0, large_pocket: 0, thigh_accessory: 0 }[item.kind] ?? 0), 0);
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
    { target: "upper.sleeves", source: upperEvidence, evidence: analysis.observed.clothing, confidence: analysis.visibleRegions.upperBody ? 0.85 : 0.4 },
    { target: "upper.neckline", source: neck.source, evidence: analysis.observed.clothing, confidence: neck.source === "observed" ? 0.82 : 0.58 },
    { target: "lower", source: lowerEvidence, evidence: hiddenCompletion, confidence: analysis.visibleRegions.lowerBody ? 0.86 : 0.42 },
    { target: "back", source: "conservative", evidence: "front structure continued only where garment construction implies continuity", confidence: 0.5 },
  ];
  return {
    coordinateSpace: "minecraft.classic.body_uv",
    upper: {
      garmentType, baseColor: topColor, accentColor,
      neckline: neck, collar,
      leftSleeve: { length: leftLength, terminationRow: sleeveRows(leftLength), color: leftSleeveColor, source: upperEvidence, evidence: analysis.observed.clothing },
      rightSleeve: { length: rightLength, terminationRow: sleeveRows(rightLength), color: rightSleeveColor, source: upperEvidence, evidence: analysis.observed.clothing },
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

export function buildOutfitPlanCandidates(analysis: PhotoAnalysis, maxCandidates = 3): OutfitPlan[] {
  const cap = Math.max(1, Math.min(3, Math.floor(maxCandidates)));
  const base = baseOutfitPlan(analysis);
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
  return [plan.upper.garmentType, plan.upper.neckline.kind, plan.upper.leftSleeve.terminationRow, plan.upper.rightSleeve.terminationRow, plan.upper.colorBlocks.map((block) => `${block.region}:${block.color}`).join("|"), plan.lower.garmentType, plan.lower.waistRow, plan.lower.garmentRows, plan.lower.accent, `${plan.lower.legwear.kind}:${plan.lower.legwear.asymmetry}`, plan.upper.pattern.kind, plan.accessories.map((item) => item.kind).join("+"), plan.outerLayer.regions.join("+")].join(";");
}
