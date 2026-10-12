/** Explicit visible front-drape observations only; length is not placement.
 * Shared by design selection and paint authorization to avoid vocabulary drift.
 * This is a bounded language recognizer, not inferred geometry/completion.
 */
export type FrontHairDrapeEvidence = "observed_shoulder_drape" | "observed_front_lock_endpoint" | "observed_front_shoulder_endpoint";

export function observedFrontHairDrape(text: string): FrontHairDrapeEvidence | null {
  for (const clause of text.toLowerCase().split(/[.;\n]/)) {
    if (/\b(?:no|not|without|absent|unknown|unseen|hidden|occluded|maybe|might|may|possibly|perhaps|imagined|inferred|completion)\b/.test(clause)) continue;
    if (/\b(?:drap(?:e|es|ing)|over (?:the )?shoulders?|across (?:the )?shoulders?)\b/.test(clause)
      && (!/\bback\b/.test(clause) || /\bshoulders?\b/.test(clause))) return "observed_shoulder_drape";
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
