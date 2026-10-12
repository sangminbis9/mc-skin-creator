import type { PhotoAnalysis } from "./analysis";

type FacialHairCategory = "goatee" | "beard" | "mustache" | "stubble";

/** Specific observed anatomy, not generic "facial hair", shadows or suggested styling. */
function supportedCategory(text: string): FacialHairCategory | undefined {
  // A separately bounded shaved head/scalp clause describes different anatomy.
  // Do not erase shaving with mixed/unlocalized facial scope ("head and face",
  // "shaved goatee"), or any facial negation/uncertainty in the remaining text.
  text = text.replace(/(^|[,;]|\band\s+)\s*(?:a\s+)?shaved\s+(?:head|scalp|crown)\s*(?=[,;.!?]|$)/gi, "$1");
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

/** A separate scalp-stubble cue is neither facial corroboration nor conflict.
 * Mixed facial/scalp or unlocalized stubble remains subject to the strict
 * conflict check below; never strip a facial negation from a combined entry. */
function scalpOnlyStubble(text: string): boolean {
  return /\bstubble\b/i.test(text)
    && /\b(?:scalp|crown|cropped[-\s]+hair)\b/i.test(text)
    && !/\b(?:face|facial|chin|jaw|jawline|cheeks?|lips?|goatee|beard(?:ed)?|m(?:ou|u)stache|clean[- ]shaven)\b/i.test(text);
}

/** Explicit scalp shaving does not negate a separately corroborated goatee.
 * Mixed facial anatomy or another unlocalized clean-shaven clause still veto. */
function scalpOnlyShaving(text: string): boolean {
  const scalp = /\bclean[- ]shaven\s+(?:scalp|crown)\b/gi;
  return scalp.test(text)
    && !/\b(?:face|facial|chin|jaw|jawline|neck|cheeks?|lips?|goatee|beard(?:ed)?|m(?:ou|u)stache|stubble)\b/i.test(text)
    && !/\bclean[- ]shaven\b/i.test(text.replace(scalp, " "));
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
  const relevant = mustPreserve.filter(text => !scalpOnlyStubble(text) && !scalpOnlyShaving(text)
    && /\b(?:goatee|beard(?:ed)?|m(?:ou|u)stache|stubble|facial hair|clean[- ]shaven)\b/i.test(text));
  if (!relevant.length || relevant.some(text => supportedCategory(text) !== observed)) return undefined;
  return observed;
}

/** Preserve an observed combination without adding a mustache to bare goatees. */
export function observedGoateeMustache(
  observedFace: string,
  mustPreserve: readonly string[],
  faceVisible: boolean,
  features: ReadonlyArray<PhotoAnalysis["canonicalIdentity"]["features"][number]> = [],
): boolean {
  if (observedFacialHairCategory("none", observedFace, mustPreserve, faceVisible) !== "goatee") return false;
  const mustache = /\bm(?:ou|u)stache\b/i;
  if (!mustache.test(observedFace)) return false;
  // The canonical feature's source evidence may preserve the combination even
  // when the shorter mustPreserve summary mentions only the goatee. Require
  // high-confidence front-face evidence and retain contradictions as vetoes.
  const featureEvidence = features.filter(feature => feature.category === "face"
    && feature.confidence === "high" && feature.targetRegions.includes("face.front"))
    .map(feature => `${feature.feature}; ${feature.evidence}`)
    .filter(text => mustache.test(text));
  if (featureEvidence.some(text => supportedCategory(text) !== "goatee")) return false;
  return [...mustPreserve, ...featureEvidence].some(text =>
    supportedCategory(text) === "goatee" && mustache.test(text));
}
