/** Offline/diagnostic only. No identity score or production acceptance changes. */
import type { HeadIdentityPlan, HairPlan } from "./identityPlans";
import type { HeadOwnedCell } from "./headOwnership";
import type { RawImage } from "./png";
import { CLASSIC_LAYOUT } from "./uvLayout";
import type { PhotoAnalysis } from "./analysis";
import { observedTiedHair } from "./headOwnership";

export interface HeadIdentityIntegrationTrace {
  interpretation: string;
  cues: Array<{
    cue: string; sourceEvidence: boolean; sourceProvenance: string;
    facePlan: boolean; hairPlan: boolean; headPlan: boolean;
    basePixels: number; outerPixels: number; finalPixels: number;
    expected: number; retained: number; overwritten: number; missing: number;
    ownership: string[]; seamParticipation: string[];
    lossStage?: "analysis" | "hair_plan" | "head_plan" | "renderer" | "postprocess" | "craft";
  }>;
  ownerDiffs: Array<{ stage: string; cell: string; plannedOwner: string; before: number[]; after: number[] }>;
}
export function headCellOffset(p: Pick<HeadOwnedCell, "face" | "layer" | "x" | "y">): number {
  const r = CLASSIC_LAYOUT.head[p.layer === "base" ? "base" : "overlay"][p.face];
  return ((r.y + p.y) * 64 + r.x + p.x) * 4;
}
export function traceHeadIntegration(plan: HeadIdentityPlan, hair: HairPlan, atlas: RawImage, stages: Record<string, RawImage>, source?: PhotoAnalysis): HeadIdentityIntegrationTrace {
  const authoritative = plan.ownership?.execution === "resolved" && stages.after_authoritative_head !== undefined;
  const reference = authoritative ? stages.after_authoritative_head : atlas;
  const declared: HeadOwnedCell[] = authoritative ? plan.ownership!.cells : [
    ...hair.structure.groups.flatMap(g => g.points.map(p => ({ ...p, owner: p.layer === "base" ? "hair_base" as const : "hair_outer" as const, sourceGroupId: g.id, provenance: "inferred" as const }))),
    ...plan.baseFace.pixels.filter(p => p.cluster !== "fringe").map(p => ({ x: p.x, y: p.y, face: "front" as const, layer: "base" as const, owner: "face" as const, sourceGroupId: p.cluster, provenance: "observed" as const })),
    ...[...plan.glasses.framePixels, ...plan.glasses.sideArms].map(p => ({ face: p.face, x: p.x, y: p.y, layer: "outer" as const, owner: "glasses" as const, sourceGroupId: "glasses-frame", provenance: "observed" as const })),
  ];
  const unique = [...new Map(declared.map(p => [`${p.layer}:${p.face}:${p.x},${p.y}`, p])).values()];
  const ownerDiffs: HeadIdentityIntegrationTrace["ownerDiffs"] = [];
  let previous: RawImage | undefined;
  for (const [stage, image] of [...Object.entries(stages), ["after_final_uv_mask", atlas] as const]) {
    if (previous) for (const p of unique.filter(p => p.owner !== "clear")) {
      const at = headCellOffset(p), before = [...previous.rgba.slice(at, at + 4)], after = [...image.rgba.slice(at, at + 4)];
      if (before.some((v, i) => v !== after[i])) ownerDiffs.push({ stage, cell: `${p.layer}:${p.face}:${p.x},${p.y}`, plannedOwner: p.owner, before, after });
    }
    previous = image;
  }
  const cues: HeadIdentityIntegrationTrace["cues"] = (["face", "hair_base", "hair_outer", "tied_hair", "glasses", "covering", "other_p5"] as const).map(owner => {
    const points = unique.filter(p => p.owner === owner && !p.retain);
    const expectedPoints = owner === "other_p5" ? points.filter(p => reference.rgba[headCellOffset(p) + 3]) : points;
    const missing = expectedPoints.filter(p => !atlas.rgba[headCellOffset(p) + 3]).length;
    const overwritten = expectedPoints.filter(p => { const at = headCellOffset(p); return reference.rgba[at + 3] && atlas.rgba[at + 3] && [0, 1, 2, 3].some(i => reference.rgba[at + i] !== atlas.rgba[at + i]); }).length;
    const finalPixels = points.filter(p => atlas.rgba[headCellOffset(p) + 3]).length;
    const headPlan = points.length > 0;
    return { cue: owner, sourceEvidence: owner === "tied_hair" ? Boolean(plan.ownership?.tiedMass) : owner === "covering" ? Boolean(plan.ownership?.covering) : headPlan, sourceProvenance: owner.startsWith("hair") ? hair.structure.source : "frozen semantic/plan evidence; not a new measurement", facePlan: ["face", "glasses"].includes(owner), hairPlan: ["hair_base", "hair_outer", "tied_hair"].includes(owner), headPlan, basePixels: points.filter(p => p.layer === "base" && atlas.rgba[headCellOffset(p) + 3]).length, outerPixels: points.filter(p => p.layer === "outer" && atlas.rgba[headCellOffset(p) + 3]).length, finalPixels, expected: expectedPoints.length, retained: expectedPoints.length - missing - overwritten, missing, overwritten, ownership: [owner], seamParticipation: [...new Set(points.flatMap(p => p.continuityGroupId ? [p.continuityGroupId] : []))], ...(missing || overwritten ? { lossStage: "postprocess" as const } : {}) };
  });
  if (source) for (const cue of cues) {
    if (cue.cue === "tied_hair") {
      cue.sourceEvidence = observedTiedHair(source);
      cue.hairPlan = hair.template === "tied_bun";
      cue.headPlan = Boolean(plan.ownership?.tiedMass);
      if (cue.sourceEvidence && !cue.hairPlan) cue.lossStage = "hair_plan";
    }
    if (cue.cue === "covering") {
      cue.sourceEvidence = source.fallbackFeatures.hat === "headscarf" || Boolean(source.identityGeometry?.headSilhouette.covering);
      cue.headPlan = Boolean(plan.ownership?.covering);
      if (cue.sourceEvidence && !cue.headPlan) cue.lossStage = "head_plan";
    }
    cue.sourceProvenance = "frozen analysis; source/analysis hashes checked independently; pixel coordinates are derived, not new observed measurements";
  }
  return { interpretation: authoritative ? "Exact RGBA retention from resolved execution checkpoint to final UV mask; does not measure photographic likeness. Pre-checkpoint diffs report changed planned cells, not guessed final owners." : "Legacy projection: occupancy only, NOT proof of material ownership or exact renderer retention.", cues, ownerDiffs };
}
