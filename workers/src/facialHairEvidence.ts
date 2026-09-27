type FacialHairCategory = "goatee" | "beard" | "mustache" | "stubble";

/** Specific observed anatomy, not generic "facial hair", shadows or suggested styling. */
function supportedCategory(text: string): FacialHairCategory | undefined {
  // Deliberately conservative: a qualified/conflicting description is not an
  // affirmative source observation. Do not mine positive tokens out of it.
  if (/\b(?:no|not|without|absent|lacks?|clean[- ]shaven|shaved|unclear|unknown|hidden|occluded|possibly|possible|perhaps|maybe|might|could|seems?|appears?|uncertain|shadow|shadows|like|suggested|add|remove)\b/i.test(text)) {
    return undefined;
  }
  // Goatee is more specific than beard; a goatee with a mustache retains the
  // existing goatee category. This does not invent a new combined renderer type.
  if (/\bgoatee\b/i.test(text)) return "goatee";
  if (/\bbeard(?:ed)?\b/i.test(text)) return "beard";
  if (/\bm(?:ou|u)stache\b/i.test(text)) return "mustache";
  if (/\bstubble\b/i.test(text)) return "stubble";
  return undefined;
}

/**
 * Restore only corroborated source evidence lost by an optional compact cache.
 * Explicit non-none categories and invalid values retain their existing handling.
 * No provider output coercion, validator bypass, prompt inference or identity-ID rule.
 */
export function observedFacialHairCategory(
  cached: unknown,
  observedFace: string,
  mustPreserve: readonly string[],
  faceVisible: boolean,
): FacialHairCategory | undefined {
  if (!faceVisible || (cached !== undefined && cached !== "none")) return undefined;
  const observed = supportedCategory(observedFace);
  if (!observed) return undefined;
  const relevant = mustPreserve.filter(text => /\b(?:goatee|beard(?:ed)?|m(?:ou|u)stache|stubble|facial hair|clean[- ]shaven)\b/i.test(text));
  if (!relevant.length || relevant.some(text => supportedCategory(text) !== observed)) return undefined;
  return observed;
}

/** Preserve an observed combination without adding a mustache to bare goatees. */
export function observedGoateeMustache(
  observedFace: string,
  mustPreserve: readonly string[],
  faceVisible: boolean,
): boolean {
  if (observedFacialHairCategory("none", observedFace, mustPreserve, faceVisible) !== "goatee") return false;
  const mustache = /\bm(?:ou|u)stache\b/i;
  return mustache.test(observedFace) && mustPreserve.some(text =>
    supportedCategory(text) === "goatee" && mustache.test(text));
}
