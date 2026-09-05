import type { RawImage } from "./png";
import type { OutfitPlan } from "./outfitIdentity";
import { outfitPlanSignature } from "./outfitIdentity";
import { CLASSIC_LAYOUT, type Rect } from "./uvLayout";

export interface OutfitAtlasSignature {
  plan: string;
  pixelHash: string;
  torsoDominantBlock: string;
  neckline: string;
  sleeveTermination: string;
  waistBoundary: string;
  lowerGarment: string;
  pattern: string;
  outerOccupancy: number;
  accessory: string;
}

export interface OutfitIdentityRetention {
  source: { observedConstruction: string; hiddenCompletion: string; provenance: OutfitPlan["provenance"] };
  analysis: { salience: OutfitPlan["salience"]; lowerBodySource: OutfitPlan["lowerBodySource"] };
  plan: OutfitPlan;
  atlas: OutfitAtlasSignature;
  garmentTypeRetention: number;
  necklineRetention: number;
  sleeveRetention: number;
  torsoColorBlockRetention: number;
  waistBoundaryRetention: number;
  lowerGarmentRetention: number;
  patternRetention: number;
  accessoryRetention: number;
  layerRetention: number;
  frontSideContinuity: number;
  sideBackContinuity: number;
  outerOccupancy: { expectedSourceDerived: number; retained: number; actual: number; genericOrDecorative: number };
  largestLossStage: "source_to_plan" | "plan_to_atlas" | "retained";
}

export interface OutfitPixelDifference {
  torso: number;
  arms: number;
  legs: number;
  outer: number;
  patternOnly: number;
  head: number;
}

function at(atlas: RawImage, rect: Rect, x: number, y: number): [number, number, number, number] {
  const index = ((rect.y + y) * atlas.width + rect.x + x) * 4;
  return [atlas.rgba[index], atlas.rgba[index + 1], atlas.rgba[index + 2], atlas.rgba[index + 3]];
}

function key(color: readonly number[]): string {
  return color.slice(0, 3).map((channel) => Math.round(channel / 32).toString(16)).join("");
}

function dominant(atlas: RawImage, rect: Rect): string {
  const counts = new Map<string, number>();
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const pixel = at(atlas, rect, x, y);
    if (pixel[3] === 0) continue;
    const pixelKey = key(pixel);
    counts.set(pixelKey, (counts.get(pixelKey) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "none";
}

function opaque(atlas: RawImage, rect: Rect): number {
  let count = 0;
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) if (at(atlas, rect, x, y)[3] > 0) count++;
  return count;
}

function bodyOuterOccupancy(atlas: RawImage): number {
  let count = 0;
  for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) count += opaque(atlas, rect);
  return count;
}

function bodyPixelHash(atlas: RawImage): string {
  let hash = 0x811c9dc5;
  for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
    for (const layer of ["base", "overlay"] as const) {
      for (const rect of Object.values(CLASSIC_LAYOUT[part][layer])) {
        for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
          for (const channel of at(atlas, rect, x, y)) {
            hash ^= channel;
            hash = Math.imul(hash, 0x01000193) >>> 0;
          }
        }
      }
    }
  }
  return hash.toString(16).padStart(8, "0");
}

function seamScore(atlas: RawImage, first: Rect, firstX: number, second: Rect, secondX: number, rows: number): number {
  let score = 0;
  for (let y = 0; y < Math.min(rows, first.h, second.h); y++) {
    const a = at(atlas, first, firstX, y);
    const b = at(atlas, second, secondX, y);
    const distance = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    score += Math.max(0, 1 - distance / 240);
  }
  return score / Math.max(1, Math.min(rows, first.h, second.h));
}

export function outfitAtlasSignature(plan: OutfitPlan, atlas: RawImage): OutfitAtlasSignature {
  const body = CLASSIC_LAYOUT.body;
  const rightArm = CLASSIC_LAYOUT.rightArm.base.front;
  const leftArm = CLASSIC_LAYOUT.leftArm.base.front;
  const sleeveEnd = (rect: Rect) => {
    const colors = Array.from({ length: rect.h }, (_, y) => dominant(atlas, { x: rect.x, y: rect.y + y, w: rect.w, h: 1 }));
    return colors.findIndex((value, index) => index > 0 && value !== colors[0]);
  };
  return {
    plan: outfitPlanSignature(plan),
    pixelHash: bodyPixelHash(atlas),
    torsoDominantBlock: dominant(atlas, body.base.front),
    neckline: Array.from({ length: 3 }, (_, y) => Array.from({ length: 4 }, (_, x) => key(at(atlas, body.base.front, x + 2, y))).join("")).join("/"),
    sleeveTermination: `${sleeveEnd(leftArm)}/${sleeveEnd(rightArm)}`,
    waistBoundary: Array.from({ length: body.base.front.w }, (_, x) => key(at(atlas, body.base.front, x, plan.lower.waistRow))).join(""),
    lowerGarment: `${dominant(atlas, CLASSIC_LAYOUT.leftLeg.base.front)}/${dominant(atlas, CLASSIC_LAYOUT.rightLeg.base.front)}/${plan.lower.garmentRows}`,
    pattern: `${plan.upper.pattern.kind}/${plan.lower.pattern.kind}`,
    outerOccupancy: bodyOuterOccupancy(atlas),
    accessory: plan.accessories.map((item) => item.kind).join("+") || "none",
  };
}

export function measureOutfitIdentityRetention(plan: OutfitPlan, atlas: RawImage): OutfitIdentityRetention {
  const signature = outfitAtlasSignature(plan, atlas);
  const observedProvenance = plan.provenance.filter((item) => item.source === "observed");
  const sourceToPlan = observedProvenance.length === 0 ? 0.5 : observedProvenance.reduce((sum, item) => sum + item.confidence, 0) / observedProvenance.length;
  const expected = plan.outerLayer.expectedPixels;
  const actual = signature.outerOccupancy;
  const retained = Math.min(expected, actual);
  const torso = CLASSIC_LAYOUT.body.base;
  const frontSideContinuity = (seamScore(atlas, torso.front, 0, torso.right, torso.right.w - 1, plan.lower.waistRow) + seamScore(atlas, torso.front, torso.front.w - 1, torso.left, 0, plan.lower.waistRow)) / 2;
  const sideBackContinuity = (seamScore(atlas, torso.right, 0, torso.back, torso.back.w - 1, plan.lower.waistRow) + seamScore(atlas, torso.left, torso.left.w - 1, torso.back, 0, plan.lower.waistRow)) / 2;
  const sleeveRetention = [plan.upper.leftSleeve, plan.upper.rightSleeve].reduce((score, sleeve, index) => {
    const rect = index === 0 ? CLASSIC_LAYOUT.leftArm.base.front : CLASSIC_LAYOUT.rightArm.base.front;
    const cloth = sleeve.terminationRow === 0 ? 1 : opaque(atlas, { x: rect.x, y: rect.y, w: rect.w, h: Math.min(rect.h, sleeve.terminationRow) }) / Math.max(1, rect.w * Math.min(rect.h, sleeve.terminationRow));
    return score + cloth;
  }, 0) / 2;
  const patternRetention = plan.upper.pattern.kind === "none" ? 1 : new Set(Array.from({ length: torso.front.w * Math.max(1, plan.lower.waistRow) }, (_, index) => key(at(atlas, torso.front, index % torso.front.w, Math.floor(index / torso.front.w))))).size >= 2 ? 1 : 0;
  const planToAtlas = (sleeveRetention + patternRetention + frontSideContinuity + sideBackContinuity + (actual > 0 ? 1 : 0)) / 5;
  return {
    source: { observedConstruction: plan.observedConstruction, hiddenCompletion: plan.hiddenCompletion, provenance: plan.provenance },
    analysis: { salience: plan.salience, lowerBodySource: plan.lowerBodySource },
    plan,
    atlas: signature,
    garmentTypeRetention: 1,
    necklineRetention: signature.neckline.length > 0 ? 1 : 0,
    sleeveRetention,
    torsoColorBlockRetention: signature.torsoDominantBlock === "none" ? 0 : 1,
    waistBoundaryRetention: signature.waistBoundary.length > 0 ? 1 : 0,
    lowerGarmentRetention: signature.lowerGarment.includes("none") ? 0 : 1,
    patternRetention,
    accessoryRetention: plan.accessories.length === 0 ? 1 : signature.accessory === "none" ? 0 : 1,
    layerRetention: expected === 0 ? (actual === 0 ? 1 : 0) : retained / expected,
    frontSideContinuity,
    sideBackContinuity,
    outerOccupancy: { expectedSourceDerived: expected, retained, actual, genericOrDecorative: Math.max(0, actual - expected) },
    largestLossStage: sourceToPlan < 0.72 ? "source_to_plan" : planToAtlas < 0.82 ? "plan_to_atlas" : "retained",
  };
}

function countChanged(before: RawImage, after: RawImage, rects: Rect[]): number {
  let count = 0;
  for (const rect of rects) for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const index = offset(before, rect, x, y);
    if ([0, 1, 2, 3].some((channel) => before.rgba[index + channel] !== after.rgba[index + channel])) count++;
  }
  return count;
}

function offset(atlas: RawImage, rect: Rect, x: number, y: number): number {
  return ((rect.y + y) * atlas.width + rect.x + x) * 4;
}

export function measureOutfitPixelDifference(before: RawImage, after: RawImage): OutfitPixelDifference {
  const rects = (part: "body" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg", layer?: "base" | "overlay") => layer ? Object.values(CLASSIC_LAYOUT[part][layer]) : [...Object.values(CLASSIC_LAYOUT[part].base), ...Object.values(CLASSIC_LAYOUT[part].overlay)];
  const torso = countChanged(before, after, rects("body"));
  const arms = countChanged(before, after, [...rects("rightArm"), ...rects("leftArm")]);
  const legs = countChanged(before, after, [...rects("rightLeg"), ...rects("leftLeg")]);
  const outer = countChanged(before, after, ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"].flatMap((part) => rects(part as "body", "overlay")));
  const head = countChanged(before, after, [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)]);
  return { torso, arms, legs, outer, patternOnly: Math.max(0, torso + arms + legs - outer), head };
}

export function headUvIsByteIdentical(before: RawImage, after: RawImage): boolean {
  return countChanged(before, after, [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)]) === 0;
}

export function outfitConvergence(plans: OutfitPlan[], atlases: RawImage[]): { unique: number; total: number; pairCollisions: number; pairCount: number; rate: number } {
  const signatures = plans.map((plan, index) => outfitAtlasSignature(plan, atlases[index]).pixelHash);
  let pairCollisions = 0;
  let pairCount = 0;
  for (let left = 0; left < signatures.length; left++) for (let right = left + 1; right < signatures.length; right++) {
    pairCount++;
    if (signatures[left] === signatures[right]) pairCollisions++;
  }
  return { unique: new Set(signatures).size, total: signatures.length, pairCollisions, pairCount, rate: pairCount === 0 ? 0 : pairCollisions / pairCount };
}
