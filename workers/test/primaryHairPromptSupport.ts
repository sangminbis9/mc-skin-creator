// Exact authorized instruction delta, independent of production prompt construction.
export const HAIR_OBSERVATION_REINFORCEMENT = "- Before assigning hairPart and fringeOpening, inspect root/scalp direction and exposed forehead skin separately; do not copy the bangs type, length or density into either decision. Straight, dense or brow-length front locks can still separate around a visible forehead opening. Record the visible root direction in hairPart and the dominant skin gap in fringeOpening independently, describing the supporting observations in observed.hair; a bang-tip gap, highlight or shadow alone does not prove a root part, and hidden evidence must not be invented.";

/** Reproduce the historical contract in memory; never rewrite saved evidence. */
export function withoutHairObservationReinforcement(text: string): string {
  const line = `${HAIR_OBSERVATION_REINFORCEMENT}\n`;
  if (text.split(line).length !== 2) throw new Error("expected_exactly_one_hair_observation_instruction");
  return text.replace(line, "");
}
