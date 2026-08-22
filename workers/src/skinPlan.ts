/**
 * Canonical identity -> explicit Minecraft surface/layer plan.
 *
 * Gemini decides what matters and supplies evidence/priority. Deterministic
 * code turns that intent into legal body-part, face and layer destinations.
 */
import type {
  IdentityFeatureCategory,
  IdentityFeaturePriority,
  PhotoAnalysis,
} from "./analysis";
import {
  resolveCorrectionTargets,
  type SkinFace,
  type SkinLayer,
} from "./skinCorrection";
import type { BodyPart } from "./uvLayout";
import {
  buildIdentityPixelPlans,
  type FacePixelPlan,
  type HairPlan,
  type OutfitPlan,
  type PalettePlan,
} from "./identityPlans";

export interface SkinPlanAssignment {
  feature: string;
  category: IdentityFeatureCategory;
  priority: 1 | 2 | 3 | 4 | 5;
  confidence: "low" | "medium" | "high";
  part: BodyPart;
  faces: SkinFace[];
  layers: SkinLayer[];
  pixelStrategy: string;
  evidence: string;
}

export interface HiddenSurfacePlan {
  part: BodyPart;
  evidence: string;
  completion: string;
  confidence: "low" | "medium" | "high";
}

export interface SkinPlan {
  geometry: "classic";
  assignments: SkinPlanAssignment[];
  hiddenSurfaces: HiddenSurfacePlan[];
  palette: string[];
  invariants: string[];
  facePixelPlan: FacePixelPlan;
  hairPlan: HairPlan;
  palettePlan: PalettePlan;
  outfitPlan: OutfitPlan;
}

function pixelStrategy(feature: IdentityFeaturePriority): string {
  switch (feature.category) {
    case "face":
      return "Protect readable 1-2 pixel facial clusters on the base; use overlay only for physical hair or eyewear depth.";
    case "hair":
      return "Use a 3-6 shade base ramp plus irregular outer-layer fringe, side locks and silhouette mass; continue roots and strands across seams.";
    case "accessory":
      return "Use a high-contrast, at-least-two-source-pixel outer-layer cue with the correct physical side and a restrained base anchor.";
    case "outfit":
      return "Preserve the main base color block; use outer layer for collars, jacket edges, cuffs, hems, pockets and fabric overlap.";
    case "color":
      return "Reserve a compact material-specific shade ramp and keep its relative warmth/value stable across every connected face.";
    case "silhouette":
      return "Express the contour with coherent outer-layer edge mass without breaking the cubic Minecraft body geometry.";
  }
}

function assignmentsForFeature(
  feature: IdentityFeaturePriority,
): SkinPlanAssignment[] {
  const plan = resolveCorrectionTargets(feature.targetRegions);
  const groups = new Map<
    string,
    { part: BodyPart; faces: Set<SkinFace>; layers: Set<SkinLayer> }
  >();
  for (const target of plan.targets) {
    const key = target.part;
    const group = groups.get(key) ?? {
      part: target.part,
      faces: new Set<SkinFace>(),
      layers: new Set<SkinLayer>(),
    };
    group.faces.add(target.face);
    group.layers.add(target.layer);
    groups.set(key, group);
  }
  // Never silently drop a high-priority cue because a model used an unknown
  // region spelling. Route it to the most conservative semantic body part.
  if (groups.size === 0) {
    const part: BodyPart =
      feature.category === "outfit" || feature.category === "color"
        ? "body"
        : "head";
    groups.set(part, {
      part,
      faces: new Set<SkinFace>(["front", "left", "right", "back"]),
      layers: new Set<SkinLayer>(["base", "overlay"]),
    });
  }
  return [...groups.values()].map((group) => ({
    feature: feature.feature,
    category: feature.category,
    priority: feature.priority,
    confidence: feature.confidence,
    part: group.part,
    faces: [...group.faces],
    layers: [...group.layers],
    pixelStrategy: pixelStrategy(feature),
    evidence: feature.evidence,
  }));
}

function usableInference(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^(?:null|none|unknown|not[-\s]+visible|n\/?a)$/i.test(trimmed)
    ? null
    : trimmed;
}

function describeStructuredLowerBody(analysis: PhotoAnalysis): string | null {
  const design = analysis.inferred.lowerBodyDesign;
  if (!design) return null;
  const accent =
    design.bottomAccent === "none" ? "" : ` with ${design.bottomAccent}`;
  const legwear =
    design.legwear === "none"
      ? "no separate legwear"
      : `${design.legwearAsymmetry} ${design.legwear}`;
  return `${design.bottomPattern} ${design.bottomType}${accent}, ${legwear}, and ${design.shoeStyle}; ${design.rationale}`;
}

export function buildSkinPlan(analysis: PhotoAnalysis): SkinPlan {
  const pixelPlans = buildIdentityPixelPlans(analysis);
  const assignments = analysis.canonicalIdentity.features
    .slice()
    .sort((a, b) => b.priority - a.priority)
    .flatMap(assignmentsForFeature);
  const lower =
    usableInference(analysis.inferred.lowerBody?.value) ||
    describeStructuredLowerBody(analysis) ||
    analysis.inferred.lowerBodyDesign?.rationale ||
    analysis.outfitPrompt;
  const hiddenSurfaces: HiddenSurfacePlan[] = [
    {
      part: "head",
      evidence: analysis.observed.hair,
      completion: analysis.inferred.hairBack.value,
      confidence: analysis.visibleRegions.hair ? "high" : "medium",
    },
    {
      part: "body",
      evidence: analysis.observed.clothing,
      completion: analysis.inferred.upperBody?.value || analysis.outfitPrompt,
      confidence: analysis.visibleRegions.upperBody ? "high" : "medium",
    },
    {
      part: "rightArm",
      evidence: analysis.observed.clothing,
      completion: `Continue the same sleeve, material and outer-garment construction around the right arm: ${analysis.outfitPrompt}`,
      confidence: analysis.visibleRegions.upperBody ? "medium" : "low",
    },
    {
      part: "leftArm",
      evidence: analysis.observed.clothing,
      completion: `Continue the same sleeve, material and outer-garment construction around the left arm: ${analysis.outfitPrompt}`,
      confidence: analysis.visibleRegions.upperBody ? "medium" : "low",
    },
    {
      part: "rightLeg",
      evidence: analysis.observed.clothing,
      completion: `Continue the lower garment, legwear and shoe construction around the right leg: ${lower}`,
      confidence: analysis.visibleRegions.lowerBody ? "medium" : "low",
    },
    {
      part: "leftLeg",
      evidence: analysis.observed.clothing,
      completion: `Continue the lower garment, legwear and shoe construction around the left leg: ${lower}`,
      confidence: analysis.visibleRegions.lowerBody ? "medium" : "low",
    },
  ];
  return {
    geometry: "classic",
    assignments,
    hiddenSurfaces,
    palette: analysis.observed.colorPalette.slice(0, 12),
    invariants: [
      "Keep the exact Java 64x64 body-part coordinates and cubic geometry.",
      "Every base face must remain readable without its overlay.",
      "Outer layers must add information, never become opaque rectangular shells.",
      "Hair, cuffs, hems, waistlines, patterns, legwear and shoes must continue across physical seams.",
      "Unobserved surfaces must extend observed construction without inventing a new motif.",
    ],
    ...pixelPlans,
  };
}

export function formatSkinPlanForPrompt(plan: SkinPlan): string {
  const assignments = plan.assignments
    .map(
      (assignment) =>
        `P${assignment.priority} ${assignment.feature} -> ${assignment.part} ${assignment.faces.join("/")} ${assignment.layers.join("+")}: ${assignment.pixelStrategy}`,
    )
    .join("; ");
  const hidden = plan.hiddenSurfaces
    .map((surface) => `${surface.part}: ${surface.completion}`)
    .join("; ");
  return `Explicit surface plan: ${assignments}. Face pixels use named palette roles at fixed 8x8 coordinates (${plan.facePixelPlan.pixels.length} planned cells). Hair template: ${plan.hairPlan.template}, continuous over ${plan.hairPlan.continuousFaces.join("/")}. Palette policy: at most ${plan.palettePlan.maxGlobalColors} global colours with connected local ramps. Hidden-surface completion: ${hidden}. Outfit invention policy: ${plan.outfitPlan.inventionPolicy}. Invariants: ${plan.invariants.join(" ")}`;
}
