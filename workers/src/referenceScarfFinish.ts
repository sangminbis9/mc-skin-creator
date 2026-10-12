/** Source-supported scarf construction. Length is a categorical observation,
 * not measured geometry. Never promote the mixed inferred accessory.evidence
 * string to observed truth; only immutable observed construction/assignments
 * authorize this intentionally designed, inner-first continuation.
 */
import type { SkinPlan } from "./skinPlan";
import { applyOutfitPlan } from "./outfitRenderer";
import { CLASSIC_LAYOUT } from "./uvLayout";

export interface ReferenceScarfFinish {
  provenance: "template_design";
  status: "not_observed" | "source_unavailable" | "source_conflict" | "authored";
  observedFall: "long" | "waist" | null;
  paints: Array<{ part: "body"; face: "front"; x: number; y: number; color: [number, number, number] }>;
}

/** Explicit noun-bound phrases only. 'Long hair and a scarf', 'long cardigan
 * with scarf' and inferred/negated length must not manufacture scarf tails.
 * Unknown/ambiguous language deliberately remains the original neck cue.
 */
export function observedScarfFall(text: string): "long" | "waist" | null {
  let found: "long" | "waist" | null = null;
  const material = "(?:(?:white|cream|ivory|pink|blue|black|brown|red|green|wool|woolen|woollen|knit|knitted|neck)\\s+){0,3}";
  for (const clause of text.toLowerCase().split(/[.;\n]/)) {
    if (/\b(?:no|not|without|unknown|unseen|hidden|occluded|maybe|possibly|absent)\b/.test(clause)) continue;
    if (new RegExp(`\\bwaist[- ]length\\s+${material}scarf\\b`).test(clause)
      || /\bscarf\s+(?:(?:hangs?|drapes?|falls?|extends?)\s+)(?:down\s+)?(?:to|at)\s+(?:the\s+)?waist\b/.test(clause)) return "waist";
    if (new RegExp(`\\b(?:long|hanging|draping)\\s+${material}scarf\\b`).test(clause)
      || /\bscarf\s+(?:(?:hangs?|drapes?|falls?|extends?)\s+)(?:down\s+)?(?:to|over)\s+(?:the\s+)?chest\b/.test(clause)) found = "long";
    // A hanging end is also explicit construction, even when "long" does not
    // precede scarf. Bind it directly to that noun; do not bridge another
    // garment/hair clause or infer length merely from fringes. Head/bag scarves
    // remain out of this neck-accessory grammar. No measured length is implied.
    if (/\bscarf\s+(?:wrapped\s+around\s+(?:the\s+)?(?:neck|throat)\s+)?(?:with|has)\s+(?:(?:a|one|two)\s+)?(?:hanging|draping)\s+(?:tails?|ends?)\b/.test(clause)
      && !/\b(?:head[- ]?scarf|hijab|head|hair|bag|belt|wrist)\b/.test(clause)) found = "long";
  }
  return found;
}

export function buildReferenceScarfFinish(source: SkinPlan, skin: string): ReferenceScarfFinish {
  const plan = source.outfitPlan;
  const observed = [plan.observedConstruction, ...source.assignments
    .filter(a => ["outfit", "accessory"].includes(a.category) && a.confidence === "high")
    .map(a => `${a.feature}. ${a.evidence}`)].join(". ");
  const observedFall = observedScarfFall(observed);
  const result: ReferenceScarfFinish = { provenance: "template_design", status: "not_observed", observedFall, paints: [] };
  if (!observedFall) return result;
  const scarves = plan.accessories.filter(a => a.kind === "scarf" && a.source === "observed");
  if (scarves.length !== 1 || !/^#[0-9a-f]{6}$/i.test(scarves[0].color)) return { ...result, status: "source_unavailable" };
  const color = [1, 3, 5].map(i => Number.parseInt(scarves[0].color.slice(i, i + 2), 16));
  const end = Math.min(observedFall === "waist" ? 11 : 8, plan.lower.waistRow);
  if (!Number.isInteger(end) || end < 6) return { ...result, status: "source_unavailable" };
  const paints: ReferenceScarfFinish["paints"] = [];
  for (let y = 3; y < end; y++) for (const x of [3, 4]) {
    const factor = y === end - 1 ? 0.72 : x === 3 ? 0.90 : 0.84;
    paints.push({ part: "body", face: "front", x, y, color: color.map(v => Math.round(v * factor)) as [number, number, number] });
  }
  // An entire tail is omitted if it would hide another source accessory. No
  // partial pruning, fabricated length or disconnected fragments. Include the
  // neck attachment as well as the proposed extension in this conflict check.
  const reserved = [{ x: 3, y: 2 }, ...paints];
  for (const accessory of plan.accessories.filter(a => a !== scarves[0])) {
    const image = { width: 64, height: 64, rgba: new Uint8Array(16384) };
    applyOutfitPlan(image, { ...plan, accessories: [accessory], outerLayer: { ...plan.outerLayer, regions: accessory.kind === "large_pocket" ? ["pocket"] : [] } }, skin);
    const r = CLASSIC_LAYOUT.body.overlay.front;
    if (reserved.some(p => image.rgba[((r.y + p.y) * 64 + r.x + p.x) * 4 + 3] !== 0)) return { ...result, status: "source_conflict" };
  }
  return { ...result, status: "authored", paints };
}
