/**
 * Java(Classic/Slim) / Bedrock용 스킨 PNG 내보내기.
 *
 * - Java Classic: 64x64 모던 포맷 그대로
 * - Java Slim: 팔 영역을 4px → 3px 폭으로 변환 (Alex 모델)
 * - Bedrock: 64x64 표준 레이아웃을 그대로 사용 (Dressing Room 가져오기 호환)
 */

import { ATLAS_SIZE, type Rect } from "./skinAtlas";

export type ExportFormat = "java-classic" | "java-slim" | "bedrock";

function cloneCanvas(source: HTMLCanvasElement): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D context unavailable");
  }
  ctx.drawImage(source, 0, 0);
  return { canvas, ctx };
}

/** 4px 폭 면 → 3px 폭 면: 안쪽 열(2번)을 버리고 0,1,3열을 복사 */
function blitShrunkFace(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  from: Rect,
  toX: number,
  toY: number,
): void {
  const keepColumns = [0, 1, 3];
  keepColumns.forEach((col, i) => {
    ctx.drawImage(
      source,
      from.x + col,
      from.y,
      1,
      from.h,
      toX + i,
      toY,
      1,
      from.h,
    );
  });
}

/** 4px 폭 면 → 그대로 복사 */
function blitFace(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  from: Rect,
  toX: number,
  toY: number,
): void {
  ctx.drawImage(source, from.x, from.y, from.w, from.h, toX, toY, from.w, from.h);
}

/**
 * 팔 전개도 하나(베이스 또는 오버레이, 좌상단 u,v)를 슬림으로 변환.
 * 클래식: top(u+4,v) bottom(u+8,v) right(u,v+4) front(u+4,v+4) left(u+8,v+4) back(u+12,v+4)
 * 슬림:   top(u+4,v) bottom(u+7,v) right(u,v+4) front(u+4,v+4) left(u+7,v+4) back(u+11,v+4)
 */
function convertArmToSlim(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  u: number,
  v: number,
): void {
  ctx.clearRect(u, v, 16, 16);
  blitShrunkFace(ctx, source, { x: u + 4, y: v, w: 4, h: 4 }, u + 4, v); // top
  blitShrunkFace(ctx, source, { x: u + 8, y: v, w: 4, h: 4 }, u + 7, v); // bottom
  blitFace(ctx, source, { x: u, y: v + 4, w: 4, h: 12 }, u, v + 4); // right
  blitShrunkFace(ctx, source, { x: u + 4, y: v + 4, w: 4, h: 12 }, u + 4, v + 4); // front
  blitFace(ctx, source, { x: u + 8, y: v + 4, w: 4, h: 12 }, u + 7, v + 4); // left
  blitShrunkFace(ctx, source, { x: u + 12, y: v + 4, w: 4, h: 12 }, u + 11, v + 4); // back
}

export function exportSkinPng(
  skin: HTMLCanvasElement,
  format: ExportFormat,
): string {
  if (format === "java-slim") {
    const { canvas, ctx } = cloneCanvas(skin);
    // 오른팔 base(40,16) / overlay(40,32), 왼팔 base(32,48) / overlay(48,48)
    convertArmToSlim(ctx, skin, 40, 16);
    convertArmToSlim(ctx, skin, 40, 32);
    convertArmToSlim(ctx, skin, 32, 48);
    convertArmToSlim(ctx, skin, 48, 48);
    return canvas.toDataURL("image/png");
  }
  // java-classic과 bedrock은 동일한 64x64 표준 레이아웃
  return skin.toDataURL("image/png");
}

export const EXPORT_FILENAMES: Record<ExportFormat, string> = {
  "java-classic": "mc-skin-java-classic.png",
  "java-slim": "mc-skin-java-slim.png",
  bedrock: "mc-skin-bedrock.png",
};
