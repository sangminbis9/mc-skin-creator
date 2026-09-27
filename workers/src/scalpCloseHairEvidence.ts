import type { PhotoAnalysis } from "./analysis";

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
    .replace(/\b(?:(?:very|extremely)[-\s]+short\s*\/\s*bald|bald\s*\/\s*(?:very|extremely)[-\s]+short)\b/gi, " ");
  return !/\b(?:bald|balding|bare[-\s]+(?:scalp|crown)|smooth[-\s]+scalp|receding[-\s]+hairline)\b/i.test(remaining);
}
