/**
 * 서버가 생성한 스킨 PNG(base64) → 64x64 캔버스.
 * 크기가 64x64가 아니거나 디코딩에 실패하면 null을 반환해
 * 호출부가 절차적 생성기로 fallback하게 한다.
 */

import { ATLAS_SIZE, createSkinCanvas } from "./skinAtlas";

export function decodeSkinPng(
  base64: string,
): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      if (image.width !== ATLAS_SIZE || image.height !== ATLAS_SIZE) {
        resolve(null);
        return;
      }
      const canvas = createSkinCanvas();
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => resolve(null);
    image.src = `data:image/png;base64,${base64}`;
  });
}
