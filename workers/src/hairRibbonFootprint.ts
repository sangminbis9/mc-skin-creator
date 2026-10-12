/** Existing head ribbon grammar shared by paint and ownership (head-local UV).
 * This is an accessory footprint, not evidence of tied hair or braids.
 */
export interface HairRibbonCell {
  face: "front" | "left" | "right" | "top";
  x: number;
  y: number;
  pigment: "ribbon" | "knot" | "light" | "shade";
}

export function hairRibbonFootprint(
  side: "left" | "right" | "center",
  scale: "small" | "medium" | "large" = "medium",
): HairRibbonCell[] {
  const cells: HairRibbonCell[] = [];
  const ribbon = (face: HairRibbonCell["face"], cx: number) => {
    const points: Array<readonly [number, number, HairRibbonCell["pigment"]]> = [
      [-1, 2, "ribbon"], [1, 2, "ribbon"], [0, 2, "knot"],
    ];
    // Small bows keep the paired loops/knot but not the wide raised lobes.
    // Medium is the existing footprint; large adds connected upper loops,
    // never extra rows across the eyes or a second full crown shell.
    if (scale !== "small") points.push([-2, 1, "light"], [2, 1, "shade"]);
    if (scale === "large") points.push([-1, 1, "light"], [1, 1, "shade"]);
    for (const [dx, y, pigment] of points) {
      const x = cx + dx;
      if (x >= 0 && x < 8) cells.push({ face, x, y, pigment });
    }
  };
  if (side === "center") {
    ribbon("front", 3); cells.push({ face: "top", x: 3, y: 6, pigment: "ribbon" });
  } else {
    const right = side === "right";
    ribbon("front", right ? 6 : 1);
    ribbon(right ? "left" : "right", right ? 1 : 6);
    cells.push({ face: "top", x: right ? 6 : 1, y: 6, pigment: "ribbon" });
  }
  return cells;
}
