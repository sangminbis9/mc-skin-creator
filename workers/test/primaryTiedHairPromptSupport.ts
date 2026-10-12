// Exact reviewed prompt delta for immutable historical evidence comparisons only.
export const TIED_HAIR_OBSERVATION = "- For observed.hair, inspect loose versus tied sections independently from straight/wavy/curly texture. Describe visible braiding or interwoven strands, the number and viewer-relative placement of visible braids or ponytails, and where those sections end or drape relative to the shoulders and chest. Preserve clearly observed structural cues in canonicalIdentity.features with category hair and confidence supported by the image. Do not infer a braid from waves, a ribbon, or two loose face-framing locks; do not invent a hidden matching section or raise confidence to fit a hairstyle.";

/** Removes one exact instruction, never arbitrary prompt/source differences. */
export function withoutTiedHairObservation(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${TIED_HAIR_OBSERVATION}${newline}`;
  if (text.split(line).length !== 2) throw new Error("expected_exactly_one_tied_hair_observation");
  return text.replace(line, "");
}
