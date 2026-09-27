/** Existing deterministic base-face facial-hair cells (8x8 local coordinates).
 * Shared by paint and complexion sampling; never inferred from pixel colours.
 */
export function facialHairBaseFootprint(style: { facialHair?: string; goateeHasMustache?: boolean }): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  if (style.facialHair === "mustache" || style.facialHair === "beard"
    || (style.facialHair === "goatee" && style.goateeHasMustache === true)) cells.push({ x: 2, y: 5 }, { x: 5, y: 5 });
  if (style.facialHair === "goatee") cells.push({ x: 3, y: 7 }, { x: 4, y: 7 });
  if (style.facialHair === "beard" || style.facialHair === "stubble") {
    for (let x = 0; x < 8; x++) cells.push({ x, y: 7 });
    cells.push({ x: 0, y: 6 }, { x: 7, y: 6 });
  }
  return cells;
}
