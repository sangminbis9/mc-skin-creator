import type { PhotoAnalysis } from "./analysis";

/** Missing optional category cache must not erase an explicitly observed hat.
 * `cap` supplies a bounded crown and shallow rim, not a
 * claim that an unspecified hat is a baseball cap. Keep unknown shape detail
 * unknown; never turn a neck scarf or hooded garment into headwear here.
 */
export function observedGenericHatCategory(accessories: string): "cap" | null {
  const clauses = accessories.toLowerCase().split(/[.;!?\n]+/);
  const positive = clauses.filter(clause => /\bhat\b/.test(clause));
  if (!positive.length) return null;
  // Contradictory, uncertain, depicted or unworn items cannot establish a
  // head-owned material. Fail closed instead of choosing one mention by order.
  if (positive.some(clause => /\b(?:no|not|without|absent|missing|possibly|possible|maybe|might|uncertain|unknown|unclear|hidden|invisible|print|printed|pattern|motif|logo|graphic|drawing|picture|illustration|embroidered|holding|holds?|held|carrying|carries|carried|bag|hand|background|removed|off)\b|\bhat[- ](?:shaped|like)\b/.test(clause))) return null;
  return "cap";
}

/** Specific worn objects outrank an obsolete coarse cache. Reject held,
 * printed, uncertain and negated objects before choosing a head material. */
export function observedHeadwearCategory(accessories: string): "cap" | "beanie" | "hard_hat" | "helmet" | "full_helmet" | null {
  const clauses = accessories.toLowerCase().split(/[.;!?\n]+/);
  const candidates = new Set<"cap" | "beanie" | "hard_hat" | "helmet" | "full_helmet">();
  for (const clause of clauses) {
    if (!/\b(?:cap|beanie|helmet|hard[- ]?hat)\b/.test(clause)) continue;
    if (/\b(?:possibly|possible|maybe|might|uncertain|holding|holds?|held|carrying|carried|background|removed)\b/.test(clause)) continue;
    if (/\b(?:helmet|cap|beanie|hat)\s+(?:print|printed|motif|graphic|picture|logo)\b|\b(?:graphic|picture|drawing|logo|print)\s+(?:of\s+)?(?:a\s+)?(?:[a-z-]+\s+){0,2}(?:helmet|cap|beanie|hat)\b/.test(clause)) continue;
    if (/\b(?:no|without|not wearing)\s+(?:a\s+)?(?:[a-z-]+\s+){0,3}(?:cap|beanie|helmet|hard[- ]?hat)\b|\b(?:helmet|cap|beanie)\s+(?:is\s+)?(?:absent|off)\b/.test(clause)) continue;
    if (/\b(?:full[- ]face|closed[- ]face)\b[^.;]{0,35}\bhelmet\b|\bhelmet\b[^.;]{0,35}\b(?:full[- ]face|chin[- ](?:bar|guard))\b/.test(clause)) candidates.add("full_helmet");
    else if (/\bhard[- ]?hat\b|\b(?:safety|construction|industrial)\s+helmet\b/.test(clause)) candidates.add("hard_hat");
    else if (/\bhelmet\b/.test(clause)) candidates.add("helmet");
    else if (/\bbeanie\b/.test(clause)) candidates.add("beanie");
    else if (/\b(?:baseball\s+)?cap\b(?![- ]sleeves?|[- ]like|[- ]shaped)/.test(clause)) candidates.add("cap");
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function observedHelmetVisor(accessories: string): "opaque" | "clear" | "raised" | null {
  const clauses = accessories.toLowerCase().split(/[.;!?\n]+/).filter(c => /\b(?:visor|face[- ]shield)\b/.test(c)
    && !/\b(?:possibly|maybe|holding|printed)\b/.test(c));
  const text = clauses.join("; ");
  if (!/\bnot\s+(?:a\s+)?(?:raised|lifted|open)\b/.test(text)
    && /\b(?:raised|lifted|open)\s+(?:\w+\s+){0,2}(?:visor|face[- ]shield)\b|\bvisor\s+(?:is\s+)?(?:raised|lifted|open)\b/.test(text)) return "raised";
  const visorMaterial = (adjectives: string) => new RegExp(`\\b(?:${adjectives})\\s+(?:(?:black|gray|grey|glass|plastic|smoked|transparent)\\s+){0,2}(?:visor|face[- ]shield)\\b|\\b(?:visor|face[- ]shield)\\s+(?:is\\s+)?(?:${adjectives})\\b`).test(text);
  if (visorMaterial("opaque|smoked|dark|tinted|mirrored")) return "opaque";
  if (visorMaterial("clear|transparent") && !/\b(?:not|non)[- ](?:clear|transparent)\b/.test(text)) return "clear";
  return null;
}

export function normalizeHeadwearObservation(analysis: PhotoAnalysis): PhotoAnalysis {
  const hat = observedHeadwearCategory(analysis.observed.accessories) ?? analysis.fallbackFeatures.hat;
  const visor = hat === "full_helmet" ? observedHelmetVisor(analysis.observed.accessories) ?? analysis.fallbackFeatures.hatVisor ?? "opaque" : undefined;
  const hiddenFace = hat === "full_helmet" && visor === "opaque";
  const hiddenHair = hat === "full_helmet" && !analysis.visibleRegions.hair;
  return {
    ...analysis,
    visibleRegions: { ...analysis.visibleRegions, ...(hiddenFace ? { face: false } : {}) },
    fallbackFeatures: { ...analysis.fallbackFeatures, hat, ...(visor ? { hatVisor: visor } : {}),
      ...(hiddenFace ? { glasses: "none", facialHair: "none", earrings: false } : {}),
      ...(hiddenHair ? { hairstyle: "bald" } : {}),
    },
    renderHints: { ...analysis.renderHints, ...(hiddenHair ? { bangs: "none", bangsLength: "none", sideHairLength: "none", hairAccessory: "none" } : {}) },
  };
}
