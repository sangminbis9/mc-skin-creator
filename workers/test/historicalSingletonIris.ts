/** Read-only migration assertion: historical PNGs/hashes are never rewritten. */
import { expect } from "vitest";
import type { RawImage } from "../src/png";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

export function assertSingletonPigmentBoundary(current: RawImage, historical: RawImage, plan: SkinPlan, style: FaceStyle) {
  const face = plan.facePixelPlan, front = CLASSIC_LAYOUT.head.base.front;
  const eyes = ["left_eye", "right_eye"].map(cluster => face.pixels.filter(p => p.cluster === cluster && p.role !== "brow"));
  const protectedCells = [...facialHairBaseFootprint(style), ...(plan.headIdentityPlan.ownership?.cells.filter(p =>
    p.layer === "base" && p.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(p.owner)) ?? []),
    ...face.pixels.filter(p => !["left_eye", "right_eye", "complexion"].includes(p.cluster))];
  const eligible = face.layout.eyeTopology === "readable_iris" && face.glassesPlan.topology === "none"
    && /^#[0-9a-f]{6}$/i.test(style.eyeColor ?? "")
    && eyes.every(points => points.length === 1 && points[0].role === "iris"
      && !protectedCells.some(c => c.x === points[0].x && c.y === points[0].y))
    && eyes[0][0].x < eyes[1][0].x && eyes[0][0].y === eyes[1][0].y;
  const allowed = new Set(eligible ? eyes.map(([p]) => ((front.y + p.y) * 64 + front.x + p.x) * 4) : []);
  const pigment = eligible ? [1, 3, 5].map(i => Number.parseInt(style.eyeColor!.slice(i, i + 2), 16)) : [];
  const changed = [];
  expect([current.width, current.height]).toEqual([historical.width, historical.height]);
  expect(current.rgba.length).toBe(historical.rgba.length);
  for (let i = 0; i < current.rgba.length; i += 4) {
    expect(current.rgba[i + 3], `iris alpha:${i}`).toBe(historical.rgba[i + 3]);
    if ([0, 1, 2].every(c => current.rgba[i + c] === historical.rgba[i + c])) continue;
    expect(allowed.has(i), `outside paired singleton iris:${i}`).toBe(true);
    expect([...current.rgba.slice(i, i + 3)], `source iris pigment:${i}`).toEqual(pigment);
    changed.push(i / 4);
  }
  return changed;
}
