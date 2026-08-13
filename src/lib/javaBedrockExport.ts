/**
 * Java(Classic/Slim) / Bedrock용 스킨 PNG 내보내기.
 *
 * - Java Classic: 64x64 모던 포맷 그대로
 * - Java Slim: 팔 영역을 4px → 3px 폭으로 변환 (Alex 모델)
 * - Bedrock: 64x64 표준 레이아웃을 그대로 사용 (Dressing Room 가져오기 호환)
 */

import { ATLAS_SIZE } from "./skinAtlas";
import { convertClassicRgbaToSlim } from "./slimSkin";

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

export function exportSkinPng(
  skin: HTMLCanvasElement,
  format: ExportFormat,
): string {
  if (format === "java-slim") {
    const { canvas, ctx } = cloneCanvas(skin);
    const image = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    image.data.set(convertClassicRgbaToSlim(image.data));
    ctx.putImageData(image, 0, 0);
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
