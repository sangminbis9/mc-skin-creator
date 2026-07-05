/**
 * 마인크래프트 64x64 classic 스킨 UV 레이아웃 (모던 1.8+ 포맷).
 * src/lib/skinAtlas.ts와 동일한 좌표 체계 — 테스트에서 parity를 검증한다.
 */

export const ATLAS_SIZE = 64;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxUV {
  top: Rect;
  bottom: Rect;
  right: Rect;
  front: Rect;
  left: Rect;
  back: Rect;
}

/** 박스 전개도 좌표 계산: (u, v)는 전개도의 좌상단, (w, h, d)는 박스 크기 */
function boxUV(u: number, v: number, w: number, h: number, d: number): BoxUV {
  return {
    top: { x: u + d, y: v, w, h: d },
    bottom: { x: u + d + w, y: v, w, h: d },
    right: { x: u, y: v + d, w: d, h },
    front: { x: u + d, y: v + d, w, h },
    left: { x: u + d + w, y: v + d, w: d, h },
    back: { x: u + d + w + d, y: v + d, w, h },
  };
}

export type BodyPart =
  | "head"
  | "body"
  | "rightArm"
  | "leftArm"
  | "rightLeg"
  | "leftLeg";

export interface PartLayout {
  base: BoxUV;
  overlay: BoxUV;
}

export const CLASSIC_LAYOUT: Record<BodyPart, PartLayout> = {
  head: { base: boxUV(0, 0, 8, 8, 8), overlay: boxUV(32, 0, 8, 8, 8) },
  body: { base: boxUV(16, 16, 8, 12, 4), overlay: boxUV(16, 32, 8, 12, 4) },
  rightArm: { base: boxUV(40, 16, 4, 12, 4), overlay: boxUV(40, 32, 4, 12, 4) },
  leftArm: { base: boxUV(32, 48, 4, 12, 4), overlay: boxUV(48, 48, 4, 12, 4) },
  rightLeg: { base: boxUV(0, 16, 4, 12, 4), overlay: boxUV(0, 32, 4, 12, 4) },
  leftLeg: { base: boxUV(16, 48, 4, 12, 4), overlay: boxUV(0, 48, 4, 12, 4) },
};

export const ALL_PARTS: BodyPart[] = [
  "head",
  "body",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
];

export const BASE_RECTS: Rect[] = ALL_PARTS.flatMap((part) =>
  Object.values(CLASSIC_LAYOUT[part].base),
);

export const OVERLAY_RECTS: Rect[] = ALL_PARTS.flatMap((part) =>
  Object.values(CLASSIC_LAYOUT[part].overlay),
);

/** 얼굴(머리 앞면) 영역 — 검증에서 가장 중요한 면 */
export const HEAD_FRONT: Rect = CLASSIC_LAYOUT.head.base.front;

export type PixelZone = "base" | "overlay" | "outside";

/**
 * 64x64 각 픽셀이 base / overlay / UV 밖 중 어디에 속하는지 미리 계산한 맵.
 * base와 overlay가 겹치는 좌표는 없다 (공식 레이아웃 기준).
 */
export function buildZoneMap(): PixelZone[] {
  const zones: PixelZone[] = new Array(ATLAS_SIZE * ATLAS_SIZE).fill("outside");
  const mark = (rects: Rect[], zone: PixelZone) => {
    for (const r of rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          zones[y * ATLAS_SIZE + x] = zone;
        }
      }
    }
  };
  mark(BASE_RECTS, "base");
  mark(OVERLAY_RECTS, "overlay");
  return zones;
}
