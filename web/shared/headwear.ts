/** Shared, legal 8x8 headwear construction for the server and browser fallback.
 * The foundation carries the material; only seams, cuffs and rims are raised.
 * A vanilla skin cannot extrude a long cap brim beyond the second layer.
 */
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV } from "./skinLayout";

export const HAT_TYPES = ["none", "cap", "beanie", "hood", "headscarf", "hard_hat", "helmet", "full_helmet"] as const;
export type Hat = typeof HAT_TYPES[number];
export type HatVisor = "opaque" | "clear" | "raised";
export interface HeadwearCell { face: keyof BoxUV; x: number; y: number; shade: number }
export interface HeadwearPaint extends HeadwearCell { layer: "base" | "overlay"; color: [number, number, number] }
export function isStructuredHeadwear(hat: string): boolean {
  return ["cap", "beanie", "hard_hat", "helmet", "full_helmet"].includes(hat);
}
export function isHelmet(hat: string): boolean { return hat === "helmet" || hat === "full_helmet"; }

export function headwearFootprint(hat: string, visor: string = "opaque"): HeadwearCell[] {
  if (!isStructuredHeadwear(hat)) return [];
  const cells: HeadwearCell[] = [];
  for (const face of ["top", "bottom", "front", "right", "left", "back"] as const) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let covered = face === "top";
      if (face === "bottom") covered = hat === "full_helmet";
      else if (face !== "top") {
        if (hat === "full_helmet") covered = face !== "front" || visor === "opaque" || y < 2 || y >= 6 || x === 0 || x === 7;
        else if (hat === "helmet") covered = face === "front" ? y < 2 : face === "back" ? y < 7 : y < 6;
        else covered = y < (hat === "beanie" || hat === "hard_hat" || face === "front" ? 3 : 2);
      }
      if (covered) cells.push({ face, x, y, shade: face !== "top" && y === 2 ? 0.8 : 1 });
    }
  }
  return cells;
}

/** Occlusion belongs to material, not to the default face template. */
export function headwearFaceOcclusion(hat: string, visor?: string): Set<string> {
  return new Set(headwearFootprint(hat, visor).filter(c => c.face === "front").map(c => `${c.x}:${c.y}`));
}

const cellKey = (c: Pick<HeadwearCell, "face" | "x" | "y">) => `${c.face}:${c.x}:${c.y}`;
function rgb(hex: string): [number, number, number] {
  return /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number] : [48, 48, 48];
}
function mix(a: number[], b: number[], t: number): [number, number, number] {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t)) as [number, number, number];
}

export function buildHeadwearPaint(hat: string, color: string, visor?: string, visibleLandmarks: readonly Pick<HeadwearCell, "face" | "x" | "y">[] = []): HeadwearPaint[] {
  const footprint = headwearFootprint(hat, visor), pigment = rgb(color);
  const shadow = mix(pigment, [12, 15, 20], 0.30), light = mix(pigment, [245, 240, 225], 0.18);
  const deep = mix(pigment, [8, 10, 14], 0.60);
  const base = new Map<string, HeadwearPaint>(), raised = new Set<string>();
  for (const c of footprint) {
    const { face, x, y } = c;
    let ink = pigment, relief = false;
    const vertical = face !== "top" && face !== "bottom";
    // Broad clusters and short stitched ribs instead of per-pixel noise.
    if (face === "bottom") ink = deep;
    else if (face === "top") {
      ink = x >= 2 && x <= 5 && y >= 2 && y <= 5 ? light : pigment;
      relief = (hat === "hard_hat" || isHelmet(hat)) && (x === 3 || x === 4);
    } else {
      ink = x === 0 || x === 7 ? shadow : y === 0 ? light : pigment;
      if (hat === "beanie") {
        ink = y === 2 ? shadow : x % 3 === 1 ? light : pigment;
        relief = y === 2; // One continuous folded cuff, supported by base cloth.
      } else if (hat === "cap") {
        if (face === "front" && y === 2) { ink = deep; relief = true; }
        if (face === "front" && y < 2 && (x === 3 || x === 4)) ink = light;
        // The raised brim turns around both temples, ending in a short pair.
        if ((face === "right" && x >= 6 || face === "left" && x <= 1) && y === 1) relief = true;
      } else if (hat === "hard_hat") {
        if (y === 2) { ink = shadow; relief = true; }
        if (y <= 1 && (face === "front" || face === "back") && (x === 3 || x === 4)) { ink = light; relief = true; }
      } else if (isHelmet(hat)) {
        if (face === "front" && y < 2 && (x === 3 || x === 4)) ink = light;
        if (hat === "full_helmet" && face === "front") {
          if (y >= 2 && y <= 5 && x >= 1 && x <= 6) {
            ink = y === 2 ? [74, 91, 105] : y === 3 ? [36, 49, 60] : [18, 25, 33];
          }
          relief = y === 1 || y === 6 || (x === 0 || x === 7) && y >= 2 && y <= 5;
          if (y === 6 && x >= 2 && x <= 5) ink = deep; // Chin intake, not a mouth.
        }
        if ((face === "left" || face === "right") && y === 3 && (x === 3 || x === 4)) { ink = deep; relief = true; }
        if (face === "back" && y === 6) ink = shadow;
      }
    }
    if (vertical && y === 0 && (hat === "hard_hat" || isHelmet(hat)) && (face === "front" || face === "back") && (x === 3 || x === 4)) relief = true;
    base.set(cellKey(c), { ...c, layer: "base", color: [...ink] });
    if (relief) raised.add(cellKey(c));
  }
  // Join physical seam equivalence classes, including three-face corners.
  // Color and alpha are derived together, so no later seam repair can erase
  // a visor or replace a rim with neighboring hair.
  const parent = new Map<string, string>();
  const root = (key: string): string => { let r = key; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
  const local = (p: { x: number; y: number }): string => {
    for (const [face, r] of Object.entries(CLASSIC_LAYOUT.head.base)) if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return `${face}:${p.x - r.x}:${p.y - r.y}`;
    throw Error("headwear_seam_outside_head");
  };
  const seams = getBoxUvSeams(CLASSIC_LAYOUT.head.base);
  for (const seam of [...seams.vertical, ...seams.horizontal]) seam.primary.forEach((p, i) => {
    const a = local(p), b = local(seam.adjacent[i]); parent.set(root(a), root(b));
  });
  const groups = new Map<string, string[]>();
  for (const k of parent.keys()) { const r = root(k); groups.set(r, [...(groups.get(r) ?? []), k]); }
  for (const r of new Set([...parent.values()].map(root))) if (!groups.get(r)?.includes(r)) groups.set(r, [...(groups.get(r) ?? []), r]);
  for (const keys of groups.values()) {
    const cells = keys.map(k => base.get(k));
    const complete = cells.every((c): c is HeadwearPaint => Boolean(c));
    if (!complete) { keys.forEach(k => raised.delete(k)); continue; }
    const color = [0, 1, 2].map(ch => Math.round(cells.reduce((n, c) => n + c.color[ch], 0) / cells.length)) as [number, number, number];
    const lift = keys.some(k => raised.has(k));
    cells.forEach(c => { c.color = [...color]; if (lift) raised.add(cellKey(c)); });
  }
  const openings = new Set(isHelmet(hat) ? [] : visibleLandmarks.map(cellKey));
  return [...base.values(), ...[...raised].map(k => ({ ...base.get(k)!, layer: "overlay" as const }))].filter(c => !openings.has(cellKey(c)));
}

export function paintHeadwear(atlas: { rgba: Uint8Array | Uint8ClampedArray; width: number }, hat: string, color: string, visor?: string, visibleLandmarks?: readonly Pick<HeadwearCell, "face" | "x" | "y">[]): void {
  const paint = buildHeadwearPaint(hat, color, visor, visibleLandmarks);
  for (const c of paint.filter(c => c.layer === "base")) {
    const r = CLASSIC_LAYOUT.head.overlay[c.face], i = ((r.y + c.y) * atlas.width + r.x + c.x) * 4;
    atlas.rgba.fill(0, i, i + 4);
  }
  for (const c of paint) {
    const r = CLASSIC_LAYOUT.head[c.layer][c.face], i = ((r.y + c.y) * atlas.width + r.x + c.x) * 4;
    atlas.rgba.set([...c.color, 255], i);
  }
}
