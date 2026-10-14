import { ALL_PARTS, CLASSIC_LAYOUT as L, type Rect } from "./skinLayout";

/** Authored introduction example, not an output or quality claim of the AI pipeline.
 * All detail is painted on the standard 64x64 base/outer UV nets: no extra meshes.
 */
export function createShowcaseSkin(): Uint8Array {
  const data = new Uint8Array(64 * 64 * 4);
  type RGB = readonly [number, number, number];
  const skin: RGB = [244, 207, 187],
    ivory: RGB = [245, 240, 233];
  const hair: RGB = [44, 30, 26],
    pink: RGB = [233, 209, 204];
  const shade = (c: RGB, n: number): RGB => {
    const channel = (v: number) => Math.max(0, Math.min(255, v + n));
    return [channel(c[0]), channel(c[1]), channel(c[2])];
  };
  const put = (r: Rect, x: number, y: number, c: RGB) => {
    if (x < 0 || y < 0 || x >= r.w || y >= r.h)
      throw new Error("Showcase pixel outside UV face");
    data.set([...c, 255], ((r.y + y) * 64 + r.x + x) * 4);
  };
  const fill = (r: Rect, color: (x: number, y: number) => RGB) => {
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) put(r, x, y, color(x, y));
  };
  // Opaque base everywhere, including top/bottom faces hidden in this view.
  for (const part of ALL_PARTS)
    for (const r of Object.values(L[part].base)) fill(r, () => skin);
  for (const [face, r] of Object.entries(L.head.base)) {
    if (face === "front" || face === "bottom") continue;
    fill(r, (x, y) => {
      const sweep = (x + Math.floor(y / 3)) % 5;
      return shade(hair, [0, 8, 15, 7, -3][sweep] + (y < 2 ? 3 : -2));
    });
  }
  const palette: Record<string, RGB> = {
    h: hair,
    H: shade(hair, 13),
    s: skin,
    S: shade(skin, -12),
    W: [252, 243, 231],
    E: [65, 40, 34],
    B: [88, 56, 43],
    I: [114, 78, 58],
    b: [180, 140, 117],
    c: [238, 189, 177],
    l: [211, 158, 148],
    j: [235, 194, 174],
  };
  const faceRows = [
    "hhHHHhhh",
    "hHHhhHHh",
    "hHHssHHh",
    "hbssssbh",
    "hEBssBEh",
    "cWIssIWc",
    "cssllssc",
    "jssssssj",
  ];
  faceRows.forEach((row, y) =>
    [...row].forEach((c, x) => put(L.head.base.front, x, y, palette[c])),
  );
  // Asymmetric curtain fringe and long sides; raised shell uses only existing hat pixels.
  const fringe = [4, 2, 2, 0, 0, 2, 2, 5];
  for (const [face, r] of Object.entries(L.head.overlay)) {
    if (face === "bottom") continue;
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const visible =
          face === "front"
            ? y <= fringe[x]
            : face === "top"
              ? !(x === 0 && y === 0) && !(x === 7 && y === 7)
              : y <= [5, 6, 7, 6, 6, 7, 6, 5][x];
        if (visible)
          put(
            r,
            x,
            y,
            shade(hair, [4, 11, 17, 9, 1][(x + Math.floor(y / 3)) % 5]),
          );
      }
  }
  // Tailored ivory bodice: collarbones, softly rounded cloth highlights, under-bust
  // shadow and a narrow shaded waist. These are texels, never anatomical meshes.
  const bodicePalette: Record<string, RGB> = {
    S: skin,
    s: shade(skin, -9),
    W: [252, 249, 243],
    w: ivory,
    L: [231, 221, 210],
    C: [215, 201, 189],
    D: [194, 176, 164],
    r: [237, 225, 215],
  };
  const bodiceRows = [
    "CSSSSSSC",
    "WSSSSSSW",
    "WwSSSSwW",
    "WwWssWwW",
    "CWWrrWWC",
    "CLwrrwLC",
    "DCLrrLCD",
    "DCWrrWCD",
    "DCWrrWCD",
    "LWWWWWWL",
    "wLwLLwLw",
    "CwwwwwwC",
  ];
  for (const [face, r] of Object.entries(L.body.base)) {
    fill(r, (x, y) =>
      shade(
        ivory,
        (face === "left" || face === "right" ? -13 : -3) -
          (y >= 6 && y <= 8 ? 14 : 0) +
          (x % 3 === 1 ? 5 : 0),
      ),
    );
    if (face === "front") {
      bodiceRows.forEach((row, y) =>
        [...row].forEach((c, x) => put(r, x, y, bodicePalette[c])),
      );
      const o = L.body.overlay.front;
      // Disconnected embroidery accents sit on the cloth, not a solid inflated torso.
      for (const y of [4, 6, 8]) {
        put(o, 3, y, [255, 250, 244]);
        put(o, 4, y, [255, 250, 244]);
      }
      for (const x of [1, 2, 5, 6]) put(o, x, 3, shade(ivory, x % 2 ? 9 : -6));
    }
    if (face === "front" || face === "back") {
      const o = L.body.overlay[face];
      for (let x = 0; x < 8; x++) {
        put(o, x, 10, shade(ivory, x % 2 ? -8 : 9));
        if (x % 2 === 0) put(o, x, 11, shade(ivory, 5));
      }
      // Long hair rests on the torso, never on a custom hair mesh.
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 8; x++) {
          const lock =
            face === "back"
              ? y < 4 || (y < 6 ? x > 0 && x < 7 : x > 1 && x < 5)
              : (y < 4 ? x <= 1 : y < 6 ? x === 1 : x === 0) ||
                (y < 3 && x === 7);
          if (lock)
            put(
              o,
              x,
              y,
              shade(hair, [4, 15, 8, 0][(x + Math.floor(y / 3)) % 4]),
            );
        }
    }
  }
  // Blush cardigan draped down the arms over short ivory lace sleeves.
  for (const part of ["rightArm", "leftArm"] as const) {
    for (const [face, r] of Object.entries(L[part].base)) {
      fill(r, (x, y) =>
        face === "bottom" || y >= 10
          ? shade(skin, -4)
          : y < 2
            ? shade(ivory, x % 2 ? 7 : -9)
            : y === 2 && part === "leftArm"
              ? skin
              : shade(pink, (x % 3 === 0 ? -17 : 5) - (y === 9 ? 10 : 0)),
      );
    }
    for (const face of ["front", "back", "left", "right"] as const) {
      const r = L[part].overlay[face];
      for (let x = 0; x < r.w; x++) {
        put(r, x, part === "leftArm" ? 3 : 2, shade(pink, x % 2 ? 7 : -4));
        put(r, x, 8, shade(pink, x % 2 ? -8 : 3));
      }
    }
  }
  // Both leg nets form an ankle-length tiered skirt. No widening or joined-leg mesh.
  for (const part of ["rightLeg", "leftLeg"] as const) {
    for (const [face, r] of Object.entries(L[part].base)) {
      fill(r, (x, y) =>
        face === "bottom"
          ? [130, 116, 105]
          : y === 11
            ? shade(ivory, x === 0 || x === r.w - 1 ? -21 : -7)
            : y === 10
              ? face === "front" && x > 0 && x < r.w - 1
                ? [125, 102, 86]
                : shade(ivory, -17)
              : shade(
                  ivory,
                  [1, -17, -5, 7][x % 4] - ([2, 6, 9].includes(y) ? 9 : 0),
                ),
      );
    }
    for (const face of ["front", "back", "left", "right"] as const) {
      const r = L[part].overlay[face];
      for (const y of [2, 6, 9])
        for (let x = 0; x < r.w; x++) {
          put(r, x, y, shade(ivory, x % 2 ? -5 : 8));
          if (y === 9 && x % 2 === 0) put(r, x, 10, shade(ivory, 3));
        }
    }
  }
  return data;
}
