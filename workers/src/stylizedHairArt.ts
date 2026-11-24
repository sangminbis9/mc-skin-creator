/** Texture/relief finish, not a second haircut classifier. Use a few authored
 * highlight clusters and the physical cuboid coordinates shared by UV seams. */
import { type MaterialRamp, type MaterialRgb, photoMaterialRamp } from "./fixedMaterialPalette";
import { headMaterialPoint } from "./referenceMaterialDetail";
import type { PhotoHairProfile } from "./photoHairFinish";
import type { PhotoHeadCut, PhotoHeadGeometry } from "./photoHeadGeometry";
import type { SkinPresentation } from "./referenceStyleTemplates";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV } from "./uvLayout";

type Face = keyof BoxUV;
type Cell = readonly [Face, number, number];
type Treatment = "ribbon" | "sweep";
type Tone = 0 | 1 | 2 | 3 | 4;
const faces = Object.keys(CLASSIC_LAYOUT.head.overlay) as Face[];
const box = CLASSIC_LAYOUT.head.overlay;
const locate = ({x, y}: {x: number; y: number}): Cell => {
  const face = faces.find(f => x >= box[f].x && x < box[f].x + 8 && y >= box[f].y && y < box[f].y + 8)!;
  return [face, x - box[face].x, y - box[face].y];
};
const uvSeams = getBoxUvSeams(box);
const seamPairs = [...uvSeams.vertical, ...uvSeams.horizontal].flatMap(s => s.primary.map((p, i) => [locate(p), locate(s.adjacent[i])] as const));
const inMask = (mask: PhotoHeadGeometry["base"], [f, x, y]: Cell) => mask[f][y]?.[x] === "#";
const hasLength = (cut: PhotoHeadCut) => ["long", "wave", "bob", "shag", "braids", "locs"].includes(cut);
const compact = (cut: PhotoHeadCut) => ["bald", "buzz", "crew", "slick"].includes(cut);
const structured = (p: PhotoHairProfile) => ["braided", "locs", "tied", "curly", "coily"].includes(p.type);

export function hairTreatment(cut: PhotoHeadCut, p: PhotoHairProfile, preference: SkinPresentation): Treatment {
  if (preference !== "source") return preference === "feminine" ? "ribbon" : "sweep";
  return hasLength(cut) || p.type === "wavy" || p.type === "curly" || cut === "curtain" ? "ribbon" : "sweep";
}

function flow(p: PhotoHairProfile, x: number, y: number) {
  const root = p.part === "left" ? 2 : p.part === "right" ? 5 : 3.5;
  const sign = p.sweep === "left" || p.part === "right" ? -1 : 1;
  const fromRoot = Math.abs(x - root);
  const along = p.part === "center" ? fromRoot : p.part === "none" ? 3.5 + (x - 3.5) * sign : (x - root) * sign;
  const wave = p.type === "wavy" ? [0, 0, .6, .85, .4, -.25, -.6, -.5][y] : 0;
  return { fromRoot, along, wave };
}

/** Change only the raised volume. Hairline, anatomy, forehead gaps, tuck and
 * observed length always come from the unstyled base mask. Keep the shapes
 * for buzz cuts, coils, braids and tied hair rather than treating them as loose. */
export function sculptStylizedHair(g: PhotoHeadGeometry, p: PhotoHairProfile, preference: SkinPresentation): PhotoHeadGeometry {
  if (compact(g.cut) || structured(p)) return g;
  const ribbon = hairTreatment(g.cut, p, preference) === "ribbon";
  const overlay = Object.fromEntries(faces.map(f => [f, g.overlay[f].map(row => [...row])])) as Record<Face, string[][]>;
  const get = ([f, x, y]: Cell) => overlay[f][y]?.[x] === "#";
  const put = ([f, x, y]: Cell, raised: boolean) => { overlay[f][y][x] = raised ? "#" : "."; };
  for (const f of ["front", "top", "right", "left"] as const) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const c = [f, x, y] as const;
    if (!inMask(g.base, c)) continue;
    const [u, v, z] = headMaterialPoint(...c);
    const { along, fromRoot, wave } = flow(p, u, v);
    if (f === "front") {
      if (x === 0 || x === 7 || y > 3) continue; // preserve the temple/drape junction
      const opening = p.part !== "none" && fromRoot <= .5 && y <= 1;
      if (opening) { put(c, false); continue; }
      if (p.fringe === "wispy" && y >= 2 && !inMask(g.overlay, c)) continue;
      const atTip = g.base.front[y + 1]?.[x] !== "#";
      // Rounded groups descend in steps; directional fringes recess the
      // short side and concentrate relief on the longer sweep.
      const lobe = p.part === "none" ? Math.abs(x - 3.5) : fromRoot;
      const raised = ribbon ? y === 1 || y === 0 && lobe >= .9 && lobe <= 2.6
        || y >= 2 && (!atTip || lobe > 1.55 && !(p.fringe === "wispy" && x % 3 === 0))
        : y === 0 ? along >= .5 && along <= 2.7 : along >= (y === 1 ? -.25 : .65) && along <= 4.7
          || p.part === "center" && y === 2 && lobe >= 1.35;
      put(c, raised);
    } else if (f === "top" && x > 0 && x < 7 && z < 6) {
      const crest = ribbon ? fromRoot > (p.part === "none" ? -.1 : .5) && fromRoot < 3.2 - z * .13 + wave
        : along >= (p.part === "none" ? 1.15 : .35) + z * .14 && along <= (p.part === "center" ? 2.7 : 5) - z * .16;
      put(c, crest && (z > 0 || get(c)));
    } else if ((f === "right" || f === "left") && z > 0 && z < 4 && y >= 1) {
      if (ribbon && hasLength(g.cut) && y <= 5 && z === 1 + (p.type === "wavy" && y === 3 ? 1 : 0)) put(c, true);
      if (!ribbon && (y > 2 && z === 2 || !hasLength(g.cut) && y === 2 && z >= 2)) put(c, false);
    }
  }
  // A supported wrap shares occupancy across the same edge. Never extend a
  // texture over bare skin if either side of that edge belongs to the face.
  for (let pass = 0; pass < 3; pass++) for (const [a, b] of seamPairs) {
    if (inMask(g.base, a) && inMask(g.base, b) && (get(a) || get(b))) { put(a, true); put(b, true); }
  }
  return { ...g, overlay: Object.fromEntries(faces.map(f => [f, overlay[f].map(r => r.join(""))])) as PhotoHeadGeometry["overlay"] };
}

export function stylizedHairTone([x, y, z]: readonly [number, number, number], cut: PhotoHeadCut, p: PhotoHairProfile,
  treatment: Treatment, raised: boolean, original: Tone): Tone {
  if (cut === "buzz" || cut === "bald") return original;
  const { fromRoot, along, wave } = flow(p, x, y);
  if (p.part !== "none" && fromRoot <= .55 && y <= 2 && z <= 3) return 0;
  if (y === 7) return 2; // neck/torso locks meet their existing pigment
  if (y >= 5 && (z >= 4 || !hasLength(cut))) return y >= 6 ? 0 : 1;
  if (structured(p)) {
    // Keep each existing texture grammar, not a painted straight fringe.
    return original === 4 && !raised ? 3 : original;
  }
  if (treatment === "ribbon") {
    const arc = y * .94 + z * .50 - fromRoot * .48 - wave;
    const lobe = p.part === "none" ? Math.min(x, 7 - x) + z * .24 : fromRoot;
    if (y >= 3 && z <= 3 && lobe < .6) return 1;
    if (arc >= .65 && arc <= 2.65 && z <= 5 && lobe >= .65) {
      return raised && arc >= 1.1 && arc <= 2.15 && lobe <= 2.5 ? 4 : 3;
    }
    if (z >= 5) return y + z * .35 - fromRoot * .45 - wave < 3.75 ? 2 : 1;
    if (y >= 5 && !raised) return 1;
    return 2;
  }
  const sweep = along + y * .48 - z * .34;
  const tier = y + z * .48;
  const [start, end] = p.part === "center" ? [.95, 2.85] : p.part === "none" ? [2.6, 5.25] : [.8, 3.35];
  if (sweep >= start && sweep <= end && tier >= .5 && tier <= 3.6) {
    return raised && tier <= 2.4 && sweep >= start + .4 && sweep <= end - .35 ? 4 : 3;
  }
  // The front-facing ridge recedes to a short, darker reflection as it
  // turns over the temple, rather than leaving a hard flat side panel.
  if (Math.min(x, 7 - x) === 0 && z >= 1 && z <= 3 && tier >= .9 && tier <= 2.75 && sweep >= start - 1.4) return 3;
  if (z > 4 && tier <= 4.6 && sweep >= start + .25 && sweep <= end + .25) return 2;
  if (y >= 3 && (raised || sweep < start) || z > 4) return y >= 4 && z >= 3 ? 0 : 1;
  return 2;
}

export function stylizedHairRamp(pigment: MaterialRgb, treatment: Treatment): MaterialRamp {
  const baseline = photoMaterialRamp(pigment, "hair");
  const tune = (n: Tone, rgb: MaterialRgb, amount = 1): MaterialRgb => baseline[n].map((v, i) =>
    Math.max(0, Math.min(255, Math.round(v + rgb[i] * amount)))) as unknown as MaterialRgb;
  const headroom = Math.max(.2, Math.min(1, (255 - Math.max(...pigment)) / 62));
  return treatment === "ribbon"
    ? [tune(0, [1, 0, 1]), tune(1, [1, 1, 2]), pigment, tune(3, [5, 3, 2], headroom), tune(4, [9, 6, 4], headroom)]
    : [tune(0, [-5, -4, -2]), tune(1, [-4, -3, -1]), pigment, tune(3, [0, 2, 4], headroom), tune(4, [0, 4, 8], headroom)];
}
