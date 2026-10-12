/** Authored paired-hair construction, not continuous source geometry.
 * Only the unmeasured rear completion of an explicitly observed paired style
 * may become a nape window. Crown, frontal locks, source endpoints, measured
 * masks and P5/accessory reservations remain authoritative.
 */
import type { SkinPlan } from "./skinPlan";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";
import type { FaceStyle } from "./skinPack";
import { sourceAccessoryStencils } from "./referenceOutfitRetention";
import { facialHairBaseFootprint } from "./facialHairFootprint";

export interface PairedHairPoint { face: "back"; x: number; y: number; }
export interface ReferencePairedHair {
  provenance: "template_design";
  family: "twin_braids" | "twin_tails" | null;
  status: "authored" | "source_preserved";
  reason: "paired_semantic_completion" | "not_paired" | "observed_pair_missing" | "protected_source_mask" | "rear_foundation_incomplete" | "accessory_conflict";
  nape: PairedHairPoint[];
  /** Whole interior runs; no outer seam/cap or shoulder expansion. */
  accents: PairedHairPoint[];
}

export function buildReferencePairedHair(source: SkinPlan, design: ReferenceStylePlan): ReferencePairedHair {
  const family = design.hair.family === "twin_braids" || design.hair.family === "twin_tails" ? design.hair.family : null;
  const preserved = (reason: ReferencePairedHair["reason"]): ReferencePairedHair => ({ provenance: "template_design", family, status: "source_preserved", reason, nape: [], accents: [] });
  if (!family) return preserved("not_paired");
  const observed = [
    ...source.hiddenSurfaces.filter(s => s.part === "head" && s.confidence === "high").map(s => s.evidence),
    ...source.assignments.filter(s => s.category === "hair" && s.confidence === "high").map(s => `${s.feature}. ${s.evidence}`),
  ].join(". ").toLowerCase();
  const pattern = family === "twin_braids" ? /\b(?:twin|two|double|paired)\b[^.;]*\bbraids?\b/ : /\b(?:twin[- ]?tails|pigtails|two ponytails|paired ponytails)\b/;
  if (!observed.split(/[.;\n]/).some(s => pattern.test(s) && !/\b(?:no|not|without|absent|unknown|unseen)\b/.test(s))) return preserved("observed_pair_missing");
  const head = source.headIdentityPlan.ownership, hair = source.hairPlan;
  const pairedLength = hair.lengthClass === "long" || hair.lengthClass === "medium" && hair.headMask.semanticSilhouette?.endpointCue === "shoulder";
  if (!head || head.execution !== "resolved" || head.covering || head.tiedMass || hair.surfaceOnly || !pairedLength
    || hair.headMask.source !== "semantic_template" || hair.structure.source !== "semantic_analysis"
    || head.cells.some(c => c.provenance === "validated_derived")) return preserved("protected_source_mask");
  const nape: PairedHairPoint[] = [], accents: PairedHairPoint[] = [];
  // The braid is a narrow two-column rear lock. A tail fans to three columns
  // above a one-column taper. Their different negative spaces change the
  // actual base silhouette, rather than naming the same striped curtain twice.
  for (let y = 3; y <= 7; y++) for (let x = 1; x <= 6; x++) {
    const window = family === "twin_braids" ? y >= 4 && x >= 2 && x <= 5
      : (x === 3 || x === 4) || (y >= 6 && (x === 2 || x === 5));
    if (window) nape.push({ face: "back", x, y });
    const accent = family === "twin_braids" ? y >= 4 && y <= 6 && (x === 1 || x === 6)
      : y <= 5 && (x <= 2 || x >= 5);
    if (accent) accents.push({ face: "back", x, y });
  }
  const affected = [...nape, ...accents];
  if (affected.some(p => !head.cells.some(c => c.layer === "base" && c.owner === "hair_base" && c.face === p.face && c.x === p.x && c.y === p.y))) return preserved("rear_foundation_incomplete");
  if (affected.some(p => head.cells.some(c => c.layer === "outer" && c.face === p.face && c.x === p.x && c.y === p.y
    && (c.owner !== "clear" && c.owner !== "hair_outer" || c.owner === "clear" && c.provenance !== "inferred")))) return preserved("accessory_conflict");
  return { provenance: "template_design", family, status: "authored", reason: "paired_semantic_completion", nape, accents };
}

export interface PairedDrapePoint { x: number; y: number; drapeGroup: "left_lock" | "right_lock"; }
export interface ReferencePairedDrapePlan {
  points: PairedDrapePoint[];
  /** A source-supported one-cell inner junction, not a new observed measurement. */
  junctions: Array<PairedDrapePoint & { face: "front"; y: 7 }>;
}
/** A paired style alone is not evidence that hair reaches a shoulder. The two
 * bottom head foundations and positive drape evidence are both necessary.
 * Explicit long paired locks can complete a jaw-length loose-lock foundation
 * by one inner cell; they never lengthen the source face-framing parameter.
 */
export function buildReferencePairedDrapePlan(source: SkinPlan, design: ReferenceStylePlan, style: Pick<FaceStyle, "skinTone" | "facialHair" | "goateeHasMustache">): ReferencePairedDrapePlan {
  const empty = (): ReferencePairedDrapePlan => ({ points: [], junctions: [] });
  const paired = buildReferencePairedHair(source, design);
  if (paired.status !== "authored" || !design.drape.eligible || design.drape.maxShoulderColumns !== 1) return empty();
  const evidence = source.hiddenSurfaces.filter(s => s.part === "head" && s.confidence === "high").map(s => s.evidence)
    .concat(source.assignments.filter(s => s.category === "hair" && s.confidence === "high").map(s => `${s.feature}. ${s.evidence}`)).join(". ").toLowerCase();
  if (!evidence.split(/[.;\n]/).some(s => /\b(?:drap(?:e|es|ing)|over (?:the )?shoulders?|across (?:the )?shoulders?)\b/.test(s)
    && !/\b(?:no|not|without|absent|unknown|unseen)\b/.test(s))) return empty();
  // The source categorical endpoint survives in the immutable HairPlan. These
  // are authored grid lengths, not continuous coordinates or guessed legacy
  // defaults. Unknown/legacy endpoints cannot authorize a six-row body lock.
  const endpoint = source.hairPlan.headMask.semanticSilhouette?.endpointCue;
  const rows = endpoint === "shoulder" ? 4 : endpoint === "chest" ? 8 : endpoint === "waist" || endpoint === "hip" ? 12 : 0;
  if (!rows) return empty();
  const head = source.headIdentityPlan.ownership!;
  const owns = (x: number, y: number) => head.cells.some(c => c.face === "front" && c.layer === "base" && c.owner === "hair_base" && c.x === x && c.y === y);
  const junctions: ReferencePairedDrapePlan["junctions"] = [];
  const pairPattern = paired.family === "twin_braids" ? /\b(?:two|twin|double|paired)\s+(?:[a-z]+[- ]+){0,3}braids?\b/
    : /\b(?:twin[- ]?tails|pigtails|two ponytails|paired ponytails)\b/;
  const explicitEndpoint = new RegExp(`\\b${endpoint === "shoulder" ? "shoulders?" : endpoint === "hip" ? "hips?" : endpoint}\\b`);
  const pairedReach = evidence.split(/[.;\n]/).some(s => pairPattern.test(s) && explicitEndpoint.test(s)
    && /\b(?:drap(?:e|es|ing)|over|across)\b/.test(s)
    && !/\b(?:no|not|without|absent|unknown|unseen|hidden|occluded|possibly|perhaps|maybe|uncertain|back|behind)\b/.test(s));
  for (const [x, drapeGroup] of [[0, "left_lock"], [7, "right_lock"]] as const) {
    if (owns(x, 7)) continue;
    // Only the single categorical jaw-to-body gap is authored. Missing roots
    // farther up the face, measured masks and explicit windows remain closed.
    if (!pairedReach || source.hairPlan.headMask.semanticSilhouette?.sideEndpointCue !== "jaw" || !owns(x, 6)
      || source.facePixelPlan.pixels.some(p => p.x === x && p.y === 7)
      || facialHairBaseFootprint(style).some(p => p.x === x && p.y === 7)
      || head.cells.some(c => c.face === "front" && c.x === x && c.y === 7
        && !(c.layer === "outer" && c.owner === "clear" && c.provenance === "inferred"))) return empty();
    junctions.push({ face: "front", x, y: 7, drapeGroup });
  }
  const cells: PairedDrapePoint[] = [];
  for (const [outer, inner, drapeGroup] of [[0, 1, "left_lock"], [7, 6, "right_lock"]] as const) for (let y = 0; y < rows; y++) {
    const xs = y < 2 ? [outer] : paired.family === "twin_braids" ? y % 2 === 0 ? [outer, inner] : [y === 3 ? inner : outer]
      : y < rows - 1 ? [outer, inner] : [outer];
    for (const x of xs) cells.push({ x, y, drapeGroup });
  }
  // Preserve the whole source accessory and whole surviving lock. Clipping
  // only the overlap would leave a detached braid or invent a shorter endpoint.
  const reserved = sourceAccessoryStencils(source.outfitPlan, style.skinTone ?? "#d39e80").flatMap(s => s.paints);
  const conflicts = new Set(cells.filter(p => reserved.some(c => c.part === "body" && c.face === "front" && c.x === p.x && c.y === p.y)).map(p => p.drapeGroup));
  return { points: cells.filter(p => !conflicts.has(p.drapeGroup)), junctions: junctions.filter(p => !conflicts.has(p.drapeGroup)) };
}

export function buildReferencePairedDrape(source: SkinPlan, design: ReferenceStylePlan, style: Pick<FaceStyle, "skinTone" | "facialHair" | "goateeHasMustache">): PairedDrapePoint[] {
  return buildReferencePairedDrapePlan(source, design, style).points;
}
