/** Bounded attachment footprint of skinPack's existing flower grammar.
 * Coordinates describe paint ownership only, never a source-specific bitmap.
 * Independent renderer replay tests constrain this contract against real paint.
 */
export interface HairFlowerCell {
  face: "front" | "left" | "right" | "top" | "back";
  x: number;
  y: number;
}

export function hairFlowerFootprint(side: "left" | "right" | "center", scale: "small" | "medium" | "large"): HairFlowerCell[] {
  const cells = new Map<string, HairFlowerCell>();
  const put = (face: HairFlowerCell["face"], x: number, y: number) => {
    if (x >= 0 && x < 8 && y >= 0 && y < 8) cells.set(`${face}:${x}:${y}`, { face, x, y });
  };
  const bloom = (face: HairFlowerCell["face"], x: number, y: number, mini = false) => {
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 0], ...(mini ? [] : [[0, 1]])]) put(face, x + dx, y + dy);
  };
  if (side === "center") {
    bloom("front", 3, 2, scale === "small");
    if (scale === "small") put("top", 3, 5);
    else {
      bloom("top", 3, 5);
      for (const x of [2, 4]) { put("front", x, 3); put("top", x, 6); }
      if (scale === "large") { put("front", 5, 2); put("front", 5, 3); put("top", 5, 5); }
    }
  } else {
    const mx = (x: number) => side === "right" ? 7 - x : x;
    const profile = side === "right" ? "left" : "right";
    bloom("front", mx(1), 2, scale === "small");
    bloom(profile, mx(6), 2, scale === "small");
    if (scale === "small") put("top", mx(2), 5);
    else {
      for (const [x, y] of [[2, 2], [2, 3], [2, scale === "large" ? 0 : 1], [0, 4]]) put("front", mx(x), y);
      for (const [x, y] of [[5, 1], [4, 1], [5, 4]]) put(profile, mx(x), y);
      for (const [x, y] of [[2, 5], [2, 4], [3, 6]]) put("top", mx(x), y);
      for (const [x, y] of [[0, 3], [1, 3], [0, 4]]) put("back", mx(x), y);
      if (scale === "large") {
        bloom(profile, mx(4), 4, true);
        put("top", mx(1), 3);
      }
    }
  }
  return [...cells.values()];
}
