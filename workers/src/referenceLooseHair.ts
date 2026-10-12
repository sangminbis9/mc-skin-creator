/** Source-supported loose hair length on the inner torso, not a measurement.
 * Visible front locks require an observation and a real bottom-head root.
 * An unseen rear continuation retains its explicit completion provenance.
 * Length alone never authorizes hair over the front shoulders or arms.
 */
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";
import { sourceAccessoryStencils } from "./referenceOutfitRetention";
import { observedFrontHairDrape, type FrontHairDrapeEvidence } from "./observedFrontHairDrape";

export interface LooseHairPoint {
  face: "front" | "back";
  x: number;
  y: number;
  drapeGroup: "left_lock" | "right_lock" | "rear_curtain";
  shade: number;
}
export interface ReferenceLooseHair {
  provenance: "template_design";
  rows: number;
  frontEvidence: FrontHairDrapeEvidence | null;
  rearEvidence: "source_supported_unseen_completion" | null;
  roots: Array<{ face: "front" | "back"; x: number; y: 7; drapeGroup: LooseHairPoint["drapeGroup"] }>;
  points: LooseHairPoint[];
  /** Visibility loss, not a changed source length or a newly measured endpoint. */
  occlusion: { accessoryPixels: number; disconnectedPixels: number };
}

function positive(text: string, pattern: RegExp): boolean {
  return text.toLowerCase().split(/[.;\n]/).some(s => pattern.test(s) && !/\b(?:no|not|without|absent|unknown|unseen|hidden|occluded)\b/.test(s));
}

export function buildReferenceLooseHair(source: SkinPlan, design: ReferenceStylePlan, style: FaceStyle): ReferenceLooseHair {
  const result: ReferenceLooseHair = { provenance: "template_design", rows: 0, frontEvidence: null, rearEvidence: null, roots: [], points: [], occlusion: { accessoryPixels: 0, disconnectedPixels: 0 } };
  const hair = source.hairPlan, head = source.headIdentityPlan.ownership;
  if (!head || head.execution !== "resolved" || head.covering || head.tiedMass || hair.surfaceOnly
    || !["medium", "long"].includes(hair.lengthClass)) return result;
  const observed = [...source.hiddenSurfaces.filter(s => s.part === "head" && s.confidence === "high").map(s => s.evidence),
    ...source.assignments.filter(s => s.category === "hair" && s.confidence === "high").map(s => `${s.feature}. ${s.evidence}`)].join(". ");
  // Paired/tied styles have their own silhouette contract, not a loose curtain.
  if (positive(observed, /\b(?:braids?|twintails|twin[- ]tails|pigtails|ponytails?|bun|topknot|locs|dreadlocks)\b/)
    || ["twin_braids", "twin_tails"].includes(design.hair.family)) return result;
  const rows = style.overallHairLength === "shoulder" ? 4 : style.overallHairLength === "chest" ? 8
    : style.overallHairLength === "waist" || style.overallHairLength === "hip" ? 12 : 0;
  if (!rows) return result;
  result.rows = rows;
  const ownsRoot = (face: "front" | "back", x: number) => head.cells.some(c => c.face === face && c.layer === "base" && c.owner === "hair_base" && c.x === x && c.y === 7);
  const frontEvidence = observedFrontHairDrape(observed);
  const frontRows = frontEvidence === "observed_front_shoulder_endpoint" ? Math.min(rows, 4) : rows;
  if (design.drape.eligible && design.drape.maxShoulderColumns === 1 && frontEvidence) {
    for (const [outer, inner, drapeGroup] of [[0, 1, "left_lock"], [7, 6, "right_lock"]] as const) {
      if (!ownsRoot("front", outer)) continue;
      result.frontEvidence = frontEvidence;
      result.roots.push({ face: "front", x: outer, y: 7, drapeGroup });
      for (let y = 0; y < frontRows; y++) {
        // Upper shoulders stay one column. Lower connected turns provide
        // wavy silhouette without an enlarged outer rail or random speckles.
        const wave = hair.texture === "wavy" || hair.texture === "curly";
        const x = wave && y >= 3 && y % 4 >= 2 ? inner : outer;
        const previous = wave && y > 3 && (y - 1) % 4 >= 2 ? inner : outer;
        const xs = x !== previous ? [previous, x] : [x];
        for (const column of xs) result.points.push({ face: "front", x: column, y, drapeGroup, shade: column === inner ? 0.84 : y === frontRows - 1 ? 0.88 : 1 });
      }
    }
  }
  const completion = source.hiddenSurfaces.find(s => s.part === "head" && s.confidence === "high");
  const completionUsable = !!completion?.completion.trim() && !/^(?:not visible|n\/a)$/i.test(completion.completion.trim())
    && !/\b(?:none|unknown|unavailable|occluded|short|cropped|bald|shaved|bun|ponytail|braid|undercut)\b/i.test(completion.completion)
    && !/\b(?:no|without)\b|\bnot (?:long|visible|present)\b/i.test(completion.completion);
  const rearRoots = [1, 2, 3, 4, 5, 6];
  if (design.drape.rearCompletion === "source_supported" && hair.lengthClass === "long" && hair.continuousFaces.includes("body.back") && style.hairBackShape === "long"
    && completionUsable && rearRoots.every(x => ownsRoot("back", x))) {
    result.rearEvidence = "source_supported_unseen_completion";
    for (const x of rearRoots) result.roots.push({ face: "back", x, y: 7, drapeGroup: "rear_curtain" });
    for (let y = 0; y < rows; y++) {
      const taper = y >= rows - 2;
      for (let x = taper ? 2 : 1; x <= (taper ? 5 : 6); x++) {
        const waveOffset = hair.texture === "wavy" || hair.texture === "curly" ? Math.floor(y / 3) % 2 : 0;
        const lit = x === 2 + waveOffset || x === 5 - waveOffset;
        result.points.push({ face: "back", x, y, drapeGroup: "rear_curtain", shade: taper ? lit ? 0.88 : 0.72 : lit ? 1.12 : x === 1 || x === 6 ? 0.72 : 0.92 });
      }
    }
  }
  // Accessory pixels keep ownership. A local overlap must not erase the whole
  // curtain. Retain only the surviving component reachable from an actual head
  // root; never paint detached fragments below an occluding band. Keep rows and
  // shading tied to the original length, not a fabricated shorter endpoint.
  const reserved = sourceAccessoryStencils(source.outfitPlan, style.skinTone ?? "#d39e80").flatMap(s => s.paints);
  const available = result.points.filter(p => !reserved.some(c => c.part === "body" && c.face === p.face && c.x === p.x && c.y === p.y));
  result.occlusion.accessoryPixels = result.points.length - available.length;
  const key = (p: Pick<LooseHairPoint, "face" | "drapeGroup" | "x" | "y">) => `${p.face}:${p.drapeGroup}:${p.x}:${p.y}`;
  const byPosition = new Map(available.map(p => [key(p), p]));
  const connected = new Set<string>();
  const queue = result.roots.map(r => byPosition.get(key({ ...r, y: 0 }))).filter((p): p is LooseHairPoint => !!p);
  for (let i = 0; i < queue.length; i++) {
    const point = queue[i], at = key(point);
    if (connected.has(at)) continue;
    connected.add(at);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const neighbor = byPosition.get(key({ ...point, x: point.x + dx, y: point.y + dy }));
      if (neighbor && !connected.has(key(neighbor))) queue.push(neighbor);
    }
  }
  result.occlusion.disconnectedPixels = available.length - connected.size;
  result.points = available.filter(p => connected.has(key(p)));
  result.roots = result.roots.filter(r => connected.has(key({ ...r, y: 0 })));
  if (!result.points.some(p => p.face === "front")) result.frontEvidence = null;
  if (!result.points.some(p => p.face === "back")) result.rearEvidence = null;
  return result;
}
