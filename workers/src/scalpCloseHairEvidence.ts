import type { PhotoAnalysis } from "./analysis";

/** A shaved silhouette can be bald in the coarse enum while retaining visible
 * scalp hair pigment. Only direct, localized observation establishes that
 * material; baldness alone, lighting shadows and facial stubble do not. */
export function observedShavedScalpHairShadow(analysis: PhotoAnalysis): boolean {
  const hints = analysis.renderHints;
  if (!analysis.visibleRegions.hair || analysis.identityGeometry
    || analysis.fallbackFeatures.hat !== "none" || hints.hairAccessory !== "none"
    || hints.overallHairLength !== "cropped" || hints.hairVolume !== "flat"
    || hints.bangs !== "none" || hints.sideHairLength !== "none") return false;
  const observation = analysis.observed.hair;
  const evidence = [observation, analysis.canonicalIdentity.overallImpression,
    ...analysis.canonicalIdentity.mustPreserve,
    ...analysis.canonicalIdentity.features.filter(f => f.category === "hair").flatMap(f => [f.feature, f.evidence])].join("; ");
  // An independent absence-of-fringe clause does not negate scalp pigment.
  // Keep coordinated or otherwise ambiguous negation intact and fail closed.
  const materialObservation = observation.replace(/(?:^|[,;.!?])\s*no\s+(?:bangs|fringe)\s*(?=[,;.!?]|$)/gi, "; ");
  if (/\b(?:no\s+(?:visible\s+)?(?:hair|stubble)|bare[-\s]+(?:scalp|crown)|smooth[-\s]+scalp|balding|receding[-\s]+hairline)\b/i.test(evidence)) return false;
  // A direct high-confidence hair feature can carry the visible-scalp evidence
  // separately from an observed scalp-length cut. Do not use overall impression,
  // inferred hair, other categories or scalp visibility alone as a substitute.
  const scalpLengthObservation = observation
    .replace(/\band\s+no\s+(?:fringe|bangs)\s*(?=[,;.!?]|$)/gi, " ")
    // Absence of a part/fringe is independent of affirmative scalp evidence.
    // Only this closed pair is removed; scalp/hair negation remains a veto.
    .replace(/\bwith\s+no\s+(?:visible\s+)?(?:part(?:ing)?|fringe|bangs)\s+(?:or|and)\s+(?:part(?:ing)?|fringe|bangs)\s*(?=[,;.!?]|$)/gi, " ")
    .replace(/\bvisible\s+temple\s+contours\b/gi, " ");
  const confoundedScalp = /\b(?:possibly|maybe|uncertain|hidden|occluded|clipped|no|not|without|thinning|patch(?:y|es)?|sides?|temples?|part(?:ing)?|beard|facial|m(?:ou|u)stache|eyebrows?|chin|cheeks?|long|braids?|locs?|bun|ponytail)\b/i;
  if (/\b(?:very|extremely)[-\s]+short\b/i.test(scalpLengthObservation)
    && /\b(?:scalp[-\s]+length|cropped)\b/i.test(scalpLengthObservation)
    && /\b(?:hair|buzz[-\s]+cut)\b/i.test(scalpLengthObservation)
    && !confoundedScalp.test(scalpLengthObservation)
    && !analysis.canonicalIdentity.features.some(feature => feature.category === "hair"
      && confoundedScalp.test(`${feature.feature}; ${feature.evidence}`))
    && analysis.canonicalIdentity.features.some(feature => feature.category === "hair" && feature.confidence === "high"
      && (/\b(?:very|extremely)[-\s]+short\b/i.test(feature.feature)
        || (/\bshort\b/i.test(feature.feature) && /\bcropped\b/i.test(feature.feature)))
      && /\b(?:hair|buzz[-\s]+cut)\b/i.test(feature.feature)
      && /\bvisible\s+scalp\b|\bscalp\s+(?:is\s+)?visible\b/i.test(feature.evidence)
      && !confoundedScalp.test(`${feature.feature}; ${feature.evidence}`))) return true;
  if (/\b(?:possibly|maybe|uncertain|hidden|occluded|clipped|no|not|without)\b/i.test(materialObservation)) return false;
  if (/\bshaved(?:\s*\/\s*bald)?\s+(?:scalp|head)\s+with\s+visible\s+hair\s+shadow\b/i.test(observation)) return true;
  // Directly visible stubble on the shaved head is scalp pigment even when
  // the coarse silhouette says bald. Require a head-bound, very-short,
  // explicitly visible observation; facial/partial stubble is not evidence.
  if (/\bshaved(?:\s*\/\s*bald)?\s+(?:scalp|head)\s+with\s+(?:visible\s+very\s+short\s+stubble|very\s+short\s+(?:visible\s+stubble|stubble\s+visible))\b/i.test(observation)
    && !/\b(?:sides?|temples?|part(?:ing)?|beard|facial|m(?:ou|u)stache|eyebrows?|chin|cheeks?|thinning|patch(?:y|es)?|receding|long(?:er)?|braids?|locs?|bun|ponytail)\b/i.test(observation)) return true;
  // Skin explicitly visible under shaved/stubbly scalp hair is the same
  // bounded surface material, not opaque curl volume. Do not infer it from
  // shortness alone, facial stubble, a part, thinning, or only shaved sides.
  // "Mostly visible" still explicitly observes skin, not a numeric density.
  // The existing short-crop, absence, uncertainty and localization gates apply.
  const visibleScalp = /\bvisible\s+scalp\b|\bscalp\s+(?:is\s+)?(?:mostly\s+)?visible\b/i.test(observation);
  const shavedHair = /\bhair\b/i.test(observation)
    && (/\b(?:almost|nearly)[-\s]+shaved\b/i.test(observation)
      || (/\bclose(?:ly)?[-\s]+cropped\b/i.test(observation) && /\bstubble\b/i.test(observation)));
  // An explicitly very short buzz cut with visible scalp is the same existing
  // surface material. A buzz cut alone does not establish skin visibility.
  const scalpVisibleBuzz = /\b(?:very|extremely)[-\s]+short(?:\s+(?:dark|light|black|brown|blond|blonde|gray|grey|red)){0,2}\s+buzz[-\s]+cut\b/i.test(observation);
  // Equally explicit crop length plus directly visible skin does not require
  // the provider to also call the hair "shaved" or "stubble".
  const scalpVisibleCrop = /\b(?:very|extremely)[-\s]+short\b/i.test(observation)
    && /\bclose(?:ly)?[-\s]+cropped\b/i.test(observation) && /\bhair\b/i.test(observation);
  const localizedConfounder = /\b(?:thinning|patch(?:y|es)?|balding|receding)\b/i.test(evidence)
    || /\b(?:sides|temples|part(?:ing)?|beard|facial|m(?:ou|u)stache|eyebrows?|chin|cheeks?|long|braids?|locs?|bun|ponytail)\b/i.test(observation);
  // A corroborated near-bald crop with explicitly visible scalp has the same
  // existing surface material; qualified length without skin evidence does not.
  return visibleScalp && (shavedHair || scalpVisibleBuzz || scalpVisibleCrop || observedQualifiedScalpCloseHair(analysis)) && !localizedConfounder;
}

/** Qualified baldness describes crop length, not an absent crown, only when
 * visible hair and the existing cropped/flat contract corroborate it. */
export function observedQualifiedScalpCloseHair(analysis: PhotoAnalysis): boolean {
  const hints = analysis.renderHints;
  if (!analysis.visibleRegions.hair || analysis.identityGeometry
    || analysis.fallbackFeatures.hairstyle === "bald" || analysis.fallbackFeatures.hat !== "none"
    || hints.hairAccessory !== "none" || hints.overallHairLength !== "cropped"
    || hints.hairVolume !== "flat" || hints.bangs !== "none" || hints.sideHairLength !== "none") return false;
  const observation = analysis.observed.hair;
  if (/\b(?:no|not|without|possibly|maybe|hidden|occluded|clipped)\b/i.test(observation)
    || !/\b(?:almost|nearly)[-\s]+bald\b/i.test(observation)
    || !/\b(?:hair|buzz(?:ed| cut)?)\b/i.test(observation)
    || !/\b(?:(?:very|extremely)[-\s]+short|close(?:ly)?[-\s]+cropped|buzz(?:ed| cut)?)\b/i.test(observation)) return false;
  const evidence = [observation, analysis.canonicalIdentity.overallImpression,
    ...analysis.canonicalIdentity.mustPreserve,
    ...analysis.canonicalIdentity.features.filter(f => f.category === "hair").flatMap(f => [f.feature, f.evidence])].join("; ");
  // These are comparative/alternative descriptions, not affirmative bare scalp.
  // Leave any independent bald/crown/recession cue intact so it can veto.
  const remaining = evidence
    .replace(/\b(?:almost|nearly)[-\s]+bald\b/gi, " ")
    // A corroborated crop/bald hair alternative summarizes near-bald length,
    // not an independent bare crown. Keep other bald/crown clauses as vetoes.
    .replace(/\b(?:close(?:ly)?[-\s]+cropped\s*\/\s*bald|bald\s*\/\s*close(?:ly)?[-\s]+cropped)\b(?=\s+(?:hair|hairstyle|silhouette)\b)/gi, " ")
    .replace(/\b(?:(?:very|extremely)[-\s]+short\s*\/\s*bald|bald\s*\/\s*(?:very|extremely)[-\s]+short)\b/gi, " ");
  return !/\b(?:bald|balding|bare[-\s]+(?:scalp|crown)|smooth[-\s]+scalp|receding[-\s]+hairline)\b/i.test(remaining);
}
