/** Missing optional category cache must not erase an explicitly observed hat.
 * `cap` is the existing bounded crown footprint (no synthesized brim), not a
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
