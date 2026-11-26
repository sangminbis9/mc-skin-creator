/** Explicit visible front-drape observations only; length is not placement.
 * Shared by design selection and paint authorization to avoid vocabulary drift.
 * This is a bounded language recognizer, not inferred geometry/completion.
 */
export type FrontHairDrapeEvidence = "observed_shoulder_drape" | "observed_front_lock_endpoint" | "observed_front_shoulder_endpoint";

type VisibleEndpoint = "shoulder" | "chest" | "waist";

function visibleTorsoEndpoint(text: string): VisibleEndpoint | undefined {
  if (/\b(?:to|at|below|reaching|past) (?:the )?(?:natural )?(?:waist|hips?)\b|\b(?:waist|hip)[- ]length\b/.test(text)) return "waist";
  if (/\b(?:chest|bust|torso)\b/.test(text)) return "chest";
  if (/\b(?:to|at|ending at) (?:the )?shoulders?\b/.test(text)) return "shoulder";
}

/** Front garment overlap gives each lock its own visible endpoint. */
export function observedFrontHairPlacement(text: string): Partial<Record<"left" | "right", VisibleEndpoint>> {
  const placement: Partial<Record<"left" | "right", VisibleEndpoint>> = {};
  const clauses = text.toLowerCase().split(/[.!?;\n]|\b(?:while|whereas)\b/)
    // Behind the ear can be the origin, not the destination. Leave other
    // behind/occluded phrases guarded, particularly behind the shoulder.
    .map(clause => clause.replace(/\s+from behind (?:(?:the|her|his|their) )?(?:(?:left|right) )?ear\b/g, ""))
    .filter(clause =>
    !/\b(?:no|not|without|absent|unknown|unseen|hidden|occluded|maybe|might|may|possibly|perhaps|imagined|inferred|behind|rear|back|printed|drawing|illustration)\b/.test(clause));
  // A separate endpoint sentence may still describe the same visible locks.
  // Require a continuous face-to-shoulder description and its own tips.
  const sharedEndpoint = clauses.filter(clause =>
    /\b(?:locks|strands|tresses) (?:frame|framing) (?:the|her|his|their) face\b/.test(clause)
    && /\b(?:over|across) (?:the |both )?shoulders?\b/.test(clause)
    && !/\b(?:left|right|scarf|necklace)\b/.test(clause))
    .map(clause => /\b(?:ends|tips) (?:reach(?:ing)?|end(?:ing)?|fall(?:ing)?|at)\b.*$/.exec(clause)?.[0])
    .filter((tips): tips is string => !!tips)
    .map(visibleTorsoEndpoint).find(endpoint => endpoint !== undefined);
  for (const clause of clauses) {
    const overlap = /\b(?:hair|locks?|strands?|tresses|braids?|ponytails?|pigtails?|curls?)(?: on (?:both sides|the viewer(?:'s)?[ -](?:left|right)))? (?:lies|lie|falls?|falling|hangs?|hanging|drapes?|draping|flows?|rests?|continues?|extends?)(?: down)? (?:over|across|onto|in front of|on top of|on|the front of)\b|\b(?:hair|locks?|strands?|tresses|braids?|ponytails?|pigtails?|curls?) (?:overlaps?|covers?)\b/.exec(clause);
    if (!overlap) continue;
    const landing = clause.slice(overlap.index + overlap[0].length);
    const onGarment = /^(?:\s+[\w'-]+){0,9}\s+\b(?:top|tee|shirt|hoodie|sweatshirt|jacket|cardigan|blouse|coat|garment|clothing|chest|torso)\b/.test(landing);
    const inFrontOfShoulders = /\bin front of$/.test(overlap[0]) && /^(?:\s+[\w'-]+){0,4}\s+shoulders?\b/.test(landing);
    if (!onGarment && !inFrontOfShoulders) continue;
    const both = /\b(?:both|each) (?:sides?|shoulders?)\b|\bon either side\b/.test(clause);
    const left = /\bviewer(?:'s)?[ -]left\b/.test(clause);
    const right = /\bviewer(?:'s)?[ -]right\b/.test(clause);
    if (!both && left === right) continue;
    const endpoint = visibleTorsoEndpoint(landing) ?? (both ? sharedEndpoint : undefined) ?? "shoulder";
    if (both || left) placement.left ??= endpoint;
    if (both || right) placement.right ??= endpoint;
  }
  return placement;
}

export function observedFrontHairDrape(text: string): FrontHairDrapeEvidence | null {
  const { left, right } = observedFrontHairPlacement(text);
  if (left || right) return (!left || left === "shoulder") && (!right || right === "shoulder")
    ? "observed_front_shoulder_endpoint" : "observed_front_lock_endpoint";
  for (const clause of text.toLowerCase().split(/[.;\n]/)) {
    if (/\b(?:no|not|without|absent|unknown|unseen|hidden|occluded|maybe|might|may|possibly|perhaps|imagined|inferred|completion)\b/.test(clause)) continue;
    if (/\b(?:drap(?:e|es|ing)|over (?:the )?shoulders?|across (?:the )?shoulders?)\b/.test(clause)
      && !/\b(?:back|rear|behind)\b/.test(clause)) return "observed_shoulder_drape";
    // A plural/front-side mass reaching the torso is stronger than overall
    // chest length. Do not turn one-sided, rear or depicted hair into two locks.
    if (/\b(?:left|right|single|one|only|back|rear|behind|printed|print|drawing|illustration)\b/.test(clause)) continue;
    // Bind the endpoint to plural front locks, not nearby rear hair or a scarf.
    // Keep a shoulder endpoint distinct so longer back hair cannot lengthen it.
    if (/\b(?:front|face[- ]framing)(?:\s+side)?\s+(?:locks|strands)\s+(?:that\s+)?reach(?:es|ing)?\s+(?:to\s+)?(?:the\s+)?shoulders?\b/.test(clause)) return "observed_front_shoulder_endpoint";
    // Same hair subject, explicit face framing AND a torso endpoint. Do not
    // combine a short face frame with a separate rear-hair/scarf observation.
    if (/\bhair\s+frames?\s+(?:the|her|his|their)\s+face\s+(?:on\s+both\s+sides\s+)?and\s+(?:falls?|extends?|reaches?)\s+(?:down\s+)?(?:past\s+(?:the\s+)?shoulders?\s+)?(?:down\s+)?to\s+(?:the\s+)?(?:chest|waist|hips?)\b/.test(clause)) return "observed_front_lock_endpoint";
    // Require a plural front-location noun and its own endpoint: a neighboring
    // scarf or unrelated overall/back-hair length cannot supply the endpoint.
    if (/\b(?:chest|waist|hip)[- ]length\s+(?:front|face[- ]framing)(?:\s+side)?\s+(?:locks|strands)\b/.test(clause)) return "observed_front_lock_endpoint";
    // Post-nominal face framing binds to the same plural, length-qualified
    // locks. Never borrow an endpoint from a neighboring scarf or rear mass.
    if (/\b(?:chest|waist|hip)[- ]length\s+(?:locks|strands)\s+(?:framing|that\s+frame)\s+(?:the|her|his|their)\s+face\b/.test(clause)) return "observed_front_lock_endpoint";
    if (/\b(?:side[- ]hair|front (?:hair|locks|strands)|face[- ]framing (?:side )?(?:locks|strands))\s+(?:that\s+)?(?:reach(?:es|ing)?\s+(?:(?:down\s+)?(?:to|past|below)\s+)?|(?:extend|fall)(?:s|ing)?\s+(?:down\s+)?(?:to|past|below)\s+)(?:the\s+)?(?:bust\/chest|chest|waist|hips?)\b/.test(clause)) return "observed_front_lock_endpoint";
  }
  return null;
}
