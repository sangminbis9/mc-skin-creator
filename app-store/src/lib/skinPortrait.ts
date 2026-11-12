/**
 * 스킨 정면 포트레이트: atlas의 정면 파츠를 합성해
 * 캐릭터 정면 모습(16x32)을 그린다. 샘플 팝업/공유 카드용.
 */

import { CLASSIC_LAYOUT, type Rect } from "./skinAtlas";

const W = 16;
const H = 32;

function blit(
  ctx: CanvasRenderingContext2D,
  skin: HTMLCanvasElement,
  rect: Rect,
  dx: number,
  dy: number,
): void {
  ctx.drawImage(skin, rect.x, rect.y, rect.w, rect.h, dx, dy, rect.w, rect.h);
}

/** 64x64 스킨 → 16x32 정면 포트레이트 캔버스 */
export function renderSkinPortrait(skin: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }
  ctx.imageSmoothingEnabled = false;

  const L = CLASSIC_LAYOUT;
  // 베이스
  blit(ctx, skin, L.head.base.front, 4, 0);
  blit(ctx, skin, L.body.base.front, 4, 8);
  blit(ctx, skin, L.rightArm.base.front, 0, 8);
  blit(ctx, skin, L.leftArm.base.front, 12, 8);
  blit(ctx, skin, L.rightLeg.base.front, 4, 20);
  blit(ctx, skin, L.leftLeg.base.front, 8, 20);
  // 오버레이
  blit(ctx, skin, L.head.overlay.front, 4, 0);
  blit(ctx, skin, L.body.overlay.front, 4, 8);
  blit(ctx, skin, L.rightArm.overlay.front, 0, 8);
  blit(ctx, skin, L.leftArm.overlay.front, 12, 8);
  blit(ctx, skin, L.rightLeg.overlay.front, 4, 20);
  blit(ctx, skin, L.leftLeg.overlay.front, 8, 20);

  return canvas;
}

/** 포트레이트를 확대한 data URL (픽셀 유지) */
export function portraitDataUrl(skin: HTMLCanvasElement, scale = 8): string {
  const portrait = renderSkinPortrait(skin);
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(portrait, 0, 0, canvas.width, canvas.height);
  }
  return canvas.toDataURL("image/png");
}
