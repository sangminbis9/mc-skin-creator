/** Offline diagnostic/annotation adapter. Never a simulated successful AI response. */
import type { PhotoAnalysis } from "../src/analysis";
import type { RawImage } from "../src/png";
import type { OutfitPlan } from "../src/outfitIdentity";
import type { SkinPlan } from "../src/skinPlan";
import { CLASSIC_LAYOUT, type Rect } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

export const FAILURE_CLASSES = ["SOURCE_LIMITATION", "CROP_FAILURE", "MEASUREMENT_FAILURE", "QUANTIZATION_COLLAPSE", "PLAN_GENERICIZATION", "RENDERER_LOSS", "UV_CONTINUITY", "UNSEEN_COMPLETION", "PALETTE_READABILITY", "OWNERSHIP_COLLISION"] as const;
export interface Failure { cue: string; category: typeof FAILURE_CLASSES[number]; severity: "critical" | "major" | "minor"; stage: "plan" | "renderer" | "completion" | "quantization"; detail: string }
export interface AnnotatedCase {
  id: string; existing?: boolean; photoId?: number; sourceUrl?: string; author?: string;
  framing: PhotoAnalysis["framing"]; pose: string; lighting: string;
  headBox: [number, number, number, number];
  clothing: string; hair: string; face: string; accessories: string;
  upperVisible: boolean; lowerVisible: boolean; feetVisible: boolean;
  features: Partial<PhotoAnalysis["fallbackFeatures"]>;
  hints: Partial<PhotoAnalysis["renderHints"]>;
  cues: string[];
  expected: { upperColor?: string; lowerColor?: string; innerColor?: string; sleeve?: string; upperPattern?: string; lowerPattern?: string; hiddenLowerPattern?: string };
}

export function validateManifest(cases: AnnotatedCase[], minimum = 12): void {
  if (cases.length < minimum) throw new Error("insufficient independent sources");
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("duplicate case");
  const people = cases.map(c => c.existing ? c.id : c.photoId);
  if (new Set(people).size !== cases.length || people.includes(undefined)) throw new Error("duplicate or missing source");
  for (const c of cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || !c.cues.length || c.cues.some(cue => typeof cue !== "string" || !cue.trim())) throw new Error("invalid visible cue annotation");
    if (!c.existing && (!c.sourceUrl?.startsWith("https://www.pexels.com/photo/") || !c.author)) throw new Error("missing source license origin");
    if (c.headBox.length !== 4 || c.headBox.some(n => !Number.isFinite(n) || n < 0 || n > 1) || c.headBox[2] <= 0 || c.headBox[3] <= 0 || c.headBox[0] + c.headBox[2] > 1.001 || c.headBox[1] + c.headBox[3] > 1.001) throw new Error("invalid crop annotation");
    if (!c.lowerVisible && c.expected.lowerColor) throw new Error("unobservable lower color expectation");
    if (!c.upperVisible && c.expected.upperColor) throw new Error("unobservable upper color expectation");
    if (JSON.stringify(c).match(/data:image|AIza[\w-]{30}/)) throw new Error("private payload in annotation");
  }
}

export function analysisFromAnnotation(c: AnnotatedCase): PhotoAnalysis {
  const seed = makeAnalysis();
  // Explicitly reset all visual defaults from the unrelated legacy fixture.
  const hints: PhotoAnalysis["renderHints"] = {
    skinUndertone: "neutral", faceShape: "oval", eyeShape: "almond", eyeSize: "average", irisLightness: "medium", eyeSpacing: "average", eyeTilt: "level", eyebrowShape: "soft", noseShape: "straight", mouthShape: "small", mouthOpening: "closed", lipFullness: "average", lipColor: "natural", jawShape: "soft",
    bangs: "none", bangsLength: "none", bangsDensity: "sparse", fringeEdge: "wispy", fringeOpening: "none", hairTexture: "straight", hairVolume: "normal", hairSilhouette: "rounded", hairBackShape: "tapered", overallHairLength: "ear", hairPart: "none", sideHairLength: "short", sideHairShape: "tapered", sideHairAsymmetry: "none", earExposure: "partial",
    garmentTexture: "plain", outerLayer: "none", outerGarment: "none", necklace: "none", hairAccessory: "none", hairAccessoryScale: "small", hairAccessorySide: "center", hairAccessoryColor: "black", neckAccessory: "none", bottomPattern: "plain", bottomAccent: "none", legwear: "none", legwearColor: "black", legwearAsymmetry: "none", thighAccessory: "none", thighAccessorySide: "none", ...c.hints,
  };
  const features = { skinTone: "light", hairColor: "brown", hairstyle: "short", eyeColor: "dark-brown", eyebrowThickness: "normal", facialHair: "none", glasses: "none", glassesColor: "gray", earrings: false, hat: "none", hatColor: "black", expression: "neutral", topType: "tshirt", topColor: "gray", topAccentColor: "white", sleeveLength: "short", bottomType: "pants", bottomColor: "navy", shoesColor: "black", ...c.features };
  const canonical: PhotoAnalysis["canonicalIdentity"]["features"] = [
    { feature: c.hair, category: "hair", priority: 5, confidence: "medium", evidence: "manual source annotation, not provider analysis", targetRegions: ["head.front", "head.side", "head.back"] },
    { feature: c.face, category: "face", priority: 5, confidence: "medium", evidence: "manual visible expression; precise geometry unmeasured", targetRegions: ["head.front"] },
    ...(c.upperVisible ? [{ feature: c.clothing, category: "outfit" as const, priority: 5 as const, confidence: "medium" as const, evidence: "manually observed garment", targetRegions: ["torso.front", "arm.left", "arm.right"] }] : []),
    ...(c.accessories === "none visible" ? [] : [{ feature: c.accessories, category: "accessory" as const, priority: 5 as const, confidence: "medium" as const, evidence: "manually observed accessory", targetRegions: /glasses|headscarf|earring/.test(c.accessories) ? ["head.front", "head.overlay"] : ["torso.front", "torso.overlay"] }]),
  ];
  return { ...seed, quality: "warn", framing: c.framing,
    visibleRegions: { face: true, hair: !/covered by/.test(c.hair), upperBody: c.upperVisible, lowerBody: c.lowerVisible, feet: c.feetVisible },
    sourceSelection: { portraitImageIndex: 0, outfitImageIndex: 0, generationImageIndex: 0, portraitEvidence: "manual adapter", outfitEvidence: "manual adapter", generationEvidence: "single photo" },
    observed: { face: c.face, hair: c.hair, clothing: c.clothing, accessories: c.accessories, colorPalette: [features.hairColor, features.topColor, features.bottomColor] },
    inferred: { hairBack: { value: "continue visible length and material", rationale: "unseen completion, not observed" }, upperBody: c.upperVisible ? null : { value: `plain ${features.topColor} ${features.topType}`, rationale: "minimum inference: garment not observable" }, lowerBody: c.lowerVisible ? null : { value: `plain ${features.bottomColor} pants`, rationale: "minimum inference: no lower-body evidence" }, shoes: c.feetVisible ? null : { value: "plain black shoes", rationale: "minimum inference" } },
    canonicalIdentity: { overallImpression: c.hair, mustPreserve: canonical.map(f => f.feature), features: canonical },
    renderHints: hints, fallbackFeatures: features, identityPrompt: `${c.hair}; ${c.face}`, outfitPrompt: c.clothing, negativePrompt: "no invented logos or asymmetric hidden details",
  };
}

export function crop(image: RawImage, box: readonly number[]): RawImage {
  const x = Math.floor(box[0] * image.width), y = Math.floor(box[1] * image.height);
  const width = Math.max(1, Math.min(image.width - x, Math.round(box[2] * image.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.round(box[3] * image.height)));
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) rgba.set(image.rgba.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4), row * width * 4);
  return { width, height, rgba };
}

function pixel(image: RawImage, r: Rect, x: number, y: number): number[] {
  const i = ((r.y + y) * image.width + r.x + x) * 4;
  return [...image.rgba.subarray(i, i + 4)];
}

function hexRgb(hex: string): number[] { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function distance(a: number[], b: number[]): number { return Math.max(...a.slice(0, 3).map((v, i) => Math.abs(v - b[i]))); }

export function colorSupport(atlas: RawImage, rect: Rect, hex: string): number {
  const expected = hexRgb(hex);
  let matched = 0;
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) { const p = pixel(atlas, rect, x, y); if (p[3] && distance(p, expected) <= 24) matched++; }
  return matched;
}

/** Palette-independent partition of visible pixel layout; not a source identity hash. */
export function structuralSignature(atlas: RawImage, parts: Array<keyof typeof CLASSIC_LAYOUT>): string {
  return parts.map(part => ["base", "overlay"].map(layer => Object.values(CLASSIC_LAYOUT[part][layer as "base" | "overlay"]).map(rect => {
    const centers: number[][] = [];
    const labels: number[] = [];
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const p = pixel(atlas, rect, x, y);
      if (!p[3]) { labels.push(0); continue; }
      let index = centers.findIndex(c => distance(c, p) <= 20);
      if (index < 0) { centers.push(p); index = centers.length - 1; }
      labels.push(index + 1);
    }
    return labels.join(",");
  }).join("/")).join("|")).join(";");
}

export function signatures(atlas: RawImage) {
  const head = structuralSignature(atlas, ["head"]);
  const body = structuralSignature(atlas, ["body", "leftArm", "rightArm", "leftLeg", "rightLeg"]);
  return { head, body, whole: `${head}#${body}` };
}
export function convergence(values: string[]) {
  let exact = 0, near = 0;
  const cells = values.map(v => v.split(/[,/|;#]/));
  for (let a = 0; a < values.length; a++) for (let b = a + 1; b < values.length; b++) {
    if (values[a] === values[b]) exact++;
    const different = cells[a].filter((v, i) => cells[b][i] !== v).length;
    if (different / Math.max(cells[a].length, cells[b].length) <= 0.05) near++;
  }
  return { total: values.length, unique: new Set(values).size, pairs: values.length * (values.length - 1) / 2, exactPairs: exact, nearPairs: near, nearDefinition: "at most 5% label-layout differences; diagnostic only" };
}

/** Coarse planned geometry, separately from actual pixel partitions. No colors,
 * evidence prose, IDs, confidence or source names can make a plan unique here.
 * Equality means semantic convergence at this resolution, not proven visual loss.
 */
export function semanticSignatures(plan: SkinPlan) {
  const f = plan.facePixelPlan.layout, h = plan.hairPlan, o = plan.outfitPlan;
  const face = JSON.stringify([f.leftEyeRow, f.rightEyeRow, f.leftEyeXs, f.rightEyeXs,
    f.leftEyeWidth, f.rightEyeWidth, f.eyeTopology, f.leftBrowRow, f.rightBrowRow,
    f.browThickness, f.mouthRow, f.mouthWidth, f.mouthTopology, f.mouthCornerOffsets, f.faceShape]);
  const hair = JSON.stringify([h.template, h.lengthClass, h.texture, h.fringe, h.part,
    f.hairlineDepthByColumn, f.fringeOpening, f.templeGeometry, f.crownGeometry]);
  const head = JSON.stringify([face, hair, plan.facePixelPlan.glassesPlan.topology]);
  const body = JSON.stringify([o.upper.garmentType, o.upper.neckline.kind,
    o.upper.neckline.innerVisible, o.upper.collar,
    o.upper.leftSleeve.terminationRow, o.upper.rightSleeve.terminationRow,
    o.upper.pattern.kind, o.upper.pattern.placement, o.upper.pattern.anchor,
    o.upper.colorBlocks.map(b => b.region), o.lower.garmentType, o.lower.garmentRows,
    o.lower.skinExposureRows, o.lower.pattern.kind, o.lower.legwear.kind,
    o.outerLayer.regions, o.accessories.map(a => a.kind)]);
  return { face, hair, head, body, whole: JSON.stringify([head, body]) };
}

export function semanticConvergence(values: string[]) {
  let equalPairs = 0;
  for (let a = 0; a < values.length; a++) for (let b = a + 1; b < values.length; b++) if (values[a] === values[b]) equalPairs++;
  return { total: values.length, pairs: values.length * (values.length - 1) / 2, unique: new Set(values).size, equalPairs };
}

export function diagnose(c: AnnotatedCase, plan: OutfitPlan, atlas: RawImage) {
  const failures: Failure[] = [];
  const checks: Array<{ cue: string; retained: boolean; pixelSupport?: number }> = [];
  const checkColor = (cue: string, expected: string | undefined, actual: string, rect: Rect, min: number) => {
    if (!expected) return;
    const support = colorSupport(atlas, rect, expected);
    const retained = support >= min;
    checks.push({ cue, retained, pixelSupport: support });
    if (!retained) failures.push({ cue, category: actual !== expected ? "PLAN_GENERICIZATION" : "RENDERER_LOSS", severity: cue === "inner" ? "major" : "critical", stage: actual !== expected ? "plan" : "renderer", detail: `expected palette ${expected}; plan ${actual}; ${support} matching front pixels` });
  };
  checkColor("upper color", c.expected.upperColor, plan.upper.baseColor, CLASSIC_LAYOUT.body.base.front, 6);
  checkColor("lower color", c.expected.lowerColor, plan.lower.baseColor, CLASSIC_LAYOUT.leftLeg.base.front, 4);
  checkColor("inner", c.expected.innerColor, plan.upper.accentColor, CLASSIC_LAYOUT.body.base.front, 4);
  if (c.expected.sleeve) {
    const correct = [plan.upper.leftSleeve, plan.upper.rightSleeve].every(s => s.length === c.expected.sleeve);
    checks.push({ cue: "sleeve length plan", retained: correct });
    if (!correct) failures.push({ cue: "sleeve length", category: "PLAN_GENERICIZATION", severity: "critical", stage: "plan", detail: `expected ${c.expected.sleeve}; got ${plan.upper.leftSleeve.length}/${plan.upper.rightSleeve.length}` });
  }
  for (const region of ["upper", "lower"] as const) {
    const expected = region === "upper" ? c.expected.upperPattern : c.expected.lowerPattern ?? c.expected.hiddenLowerPattern;
    if (!expected) continue;
    const retained = plan[region].pattern.kind === expected;
    checks.push({ cue: `${region} pattern plan`, retained });
    if (!retained) failures.push({ cue: `${region} pattern`, category: region === "lower" && !c.lowerVisible ? "UNSEEN_COMPLETION" : "PLAN_GENERICIZATION", severity: "major", stage: region === "lower" && !c.lowerVisible ? "completion" : "plan", detail: `expected ${expected}; got ${plan[region].pattern.kind}` });
  }
  return { checks, failures, retained: checks.filter(c => c.retained).length, checked: checks.length,
    annotationCueCount: c.cues.length, unscoredVisualCues: "hair silhouette, exact face geometry, accessories and pattern readability require manual visual audit; plan checks do not prove rendered retention",
    completion: { lowerObservable: c.lowerVisible, inventedPattern: !c.lowerVisible && plan.lower.pattern.kind !== "none", provenance: plan.provenance.reduce((out, p) => { out[p.source] = (out[p.source] ?? 0) + 1; return out; }, {} as Record<string, number>) },
  };
}
