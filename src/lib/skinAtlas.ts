/**
 * 마인크래프트 64x64 스킨 atlas 레이아웃 정의.
 * 모던 포맷(1.8+) 기준이며, 좌표는 모두 픽셀 단위 (x, y, w, h).
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
  /** 박스 크기 (게임 내 픽셀 단위) */
  size: { w: number; h: number; d: number };
  base: BoxUV;
  overlay: BoxUV;
}

/** 클래식(4px 팔) 레이아웃 */
export const CLASSIC_LAYOUT: Record<BodyPart, PartLayout> = {
  head: {
    size: { w: 8, h: 8, d: 8 },
    base: boxUV(0, 0, 8, 8, 8),
    overlay: boxUV(32, 0, 8, 8, 8),
  },
  body: {
    size: { w: 8, h: 12, d: 4 },
    base: boxUV(16, 16, 8, 12, 4),
    overlay: boxUV(16, 32, 8, 12, 4),
  },
  rightArm: {
    size: { w: 4, h: 12, d: 4 },
    base: boxUV(40, 16, 4, 12, 4),
    overlay: boxUV(40, 32, 4, 12, 4),
  },
  leftArm: {
    size: { w: 4, h: 12, d: 4 },
    base: boxUV(32, 48, 4, 12, 4),
    overlay: boxUV(48, 48, 4, 12, 4),
  },
  rightLeg: {
    size: { w: 4, h: 12, d: 4 },
    base: boxUV(0, 16, 4, 12, 4),
    overlay: boxUV(0, 32, 4, 12, 4),
  },
  leftLeg: {
    size: { w: 4, h: 12, d: 4 },
    base: boxUV(16, 48, 4, 12, 4),
    overlay: boxUV(0, 48, 4, 12, 4),
  },
};

/** 슬림(3px 팔) 레이아웃 — 팔만 다르다 */
export const SLIM_ARM_LAYOUT: Pick<
  Record<BodyPart, PartLayout>,
  "rightArm" | "leftArm"
> = {
  rightArm: {
    size: { w: 3, h: 12, d: 4 },
    base: boxUV(40, 16, 3, 12, 4),
    overlay: boxUV(40, 32, 3, 12, 4),
  },
  leftArm: {
    size: { w: 3, h: 12, d: 4 },
    base: boxUV(32, 48, 3, 12, 4),
    overlay: boxUV(48, 48, 3, 12, 4),
  },
};

export const ALL_PARTS: BodyPart[] = [
  "head",
  "body",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
];

/** 편집기 부위 필터 그룹 */
export type PartGroup = "all" | "head" | "body" | "arms" | "legs";

export const PART_GROUPS: Record<PartGroup, BodyPart[]> = {
  all: ALL_PARTS,
  head: ["head"],
  body: ["body"],
  arms: ["rightArm", "leftArm"],
  legs: ["rightLeg", "leftLeg"],
};

function rectsOfPart(part: BodyPart): Rect[] {
  const layout = CLASSIC_LAYOUT[part];
  return [...Object.values(layout.base), ...Object.values(layout.overlay)];
}

/** 특정 부위 그룹이 차지하는 atlas 영역 목록 */
export function rectsOfGroup(group: PartGroup): Rect[] {
  return PART_GROUPS[group].flatMap(rectsOfPart);
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** atlas 좌표가 어떤 부위에 속하는지 (없으면 null) */
export function partAt(x: number, y: number): BodyPart | null {
  for (const part of ALL_PARTS) {
    for (const rect of rectsOfPart(part)) {
      if (rectContains(rect, x, y)) {
        return part;
      }
    }
  }
  return null;
}

/** atlas 좌표가 부위 그룹에 속하는지 */
export function isInGroup(group: PartGroup, x: number, y: number): boolean {
  if (group === "all") {
    return partAt(x, y) !== null;
  }
  const part = partAt(x, y);
  return part !== null && PART_GROUPS[group].includes(part);
}

/** 빈 64x64 스킨 캔버스 생성 */
export function createSkinCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  return canvas;
}
