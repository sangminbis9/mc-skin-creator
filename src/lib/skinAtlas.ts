/**
 * 마인크래프트 64x64 스킨 atlas 레이아웃 정의.
 * 모던 포맷(1.8+) 기준이며, 좌표는 모두 픽셀 단위 (x, y, w, h).
 */

import { ALL_PARTS, CLASSIC_LAYOUT as ENGINE_CLASSIC, SLIM_LAYOUT as ENGINE_SLIM, type BodyPart, type BoxUV, type Rect } from "../../shared/skinLayout";
export { ATLAS_SIZE, ALL_PARTS, MINECRAFT_BOX_FACE_ORDER } from "../../shared/skinLayout";
export type { BodyPart, BoxUV, Rect, SkinGeometry } from "../../shared/skinLayout";
import { ATLAS_SIZE } from "../../shared/skinLayout";

export interface PartLayout { size: { w: number; h: number; d: number }; base: BoxUV; overlay: BoxUV }
const withSize = (layout: typeof ENGINE_CLASSIC) => Object.fromEntries(ALL_PARTS.map(part => {
  const box = layout[part]; return [part, { ...box, size: { w: box.base.front.w, h: box.base.front.h, d: box.base.top.h } }];
})) as Record<BodyPart, PartLayout>;
export const CLASSIC_LAYOUT = withSize(ENGINE_CLASSIC);
export const SLIM_LAYOUT = withSize(ENGINE_SLIM);
export const SLIM_ARM_LAYOUT = { rightArm: SLIM_LAYOUT.rightArm, leftArm: SLIM_LAYOUT.leftArm };

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
  return (
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  );
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
