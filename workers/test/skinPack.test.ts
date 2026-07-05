import { describe, expect, it } from "vitest";
import type { RawImage } from "../src/png";
import { packFrontViewToAtlas } from "../src/skinPack";
import { applyUvMask, validateFinalAtlas } from "../src/skinPost";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";

import { makeFrontView } from "./helpers";

function avgOfRect(
  atlas: RawImage,
  rect: { x: number; y: number; w: number; h: number },
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const d = (y * ATLAS_SIZE + x) * 4;
      r += atlas.rgba[d];
      g += atlas.rgba[d + 1];
      b += atlas.rgba[d + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

describe("packFrontViewToAtlas", () => {
  it("정면 뷰를 유효한 64x64 atlas로 pack한다", () => {
    const packed = packFrontViewToAtlas(makeFrontView());
    expect(packed).not.toBeNull();
    const atlas = packed!.atlas;

    // 부위별 색이 올바른 rect에 들어갔는지
    const body = avgOfRect(atlas, CLASSIC_LAYOUT.body.base.front);
    expect(body[0]).toBeGreaterThan(180); // 노란 몸통 (R 높음)
    expect(body[2]).toBeLessThan(120);

    const leg = avgOfRect(atlas, CLASSIC_LAYOUT.rightLeg.base.front);
    expect(leg[2]).toBeGreaterThan(leg[0]); // 남색 다리 (B > R)

    const headTopHalf = avgOfRect(atlas, { x: 8, y: 8, w: 8, h: 3 });
    expect(headTopHalf[0]).toBeLessThan(90); // 위쪽은 머리카락 (어두움)

    // 눈(어두운 특징)이 얼굴 중단에 살아남았는지
    let darkPixels = 0;
    for (let y = 11; y < 14; y++) {
      for (let x = 8; x < 16; x++) {
        const d = (y * ATLAS_SIZE + x) * 4;
        if (atlas.rgba[d] < 60 && atlas.rgba[d + 1] < 60) darkPixels++;
      }
    }
    expect(darkPixels).toBeGreaterThan(0);

    // UV 규칙 준수
    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("빈 이미지(캐릭터 없음)는 null", () => {
    const blank: RawImage = {
      width: 256,
      height: 256,
      rgba: new Uint8Array(256 * 256 * 4).fill(230),
    };
    expect(packFrontViewToAtlas(blank)).toBeNull();
  });

  it("캐릭터가 너무 작으면 null", () => {
    const tiny: RawImage = {
      width: 256,
      height: 256,
      rgba: new Uint8Array(256 * 256 * 4).fill(230),
    };
    // 20x20 픽셀짜리 점 하나 (면적 0.6%)
    for (let y = 100; y < 120; y++) {
      for (let x = 100; x < 120; x++) {
        tiny.rgba.set([20, 20, 20, 255], (y * 256 + x) * 4);
      }
    }
    expect(packFrontViewToAtlas(tiny)).toBeNull();
  });

  it("서로 다른 색의 두 인물은 서로 다른 atlas가 된다 (프리셋 수렴 방지)", () => {
    const a = packFrontViewToAtlas(makeFrontView())!;
    const other = makeFrontView();
    // 몸통을 빨강으로 교체한 두 번째 인물
    for (let y = 180; y < 330; y++) {
      for (let x = 136; x < 376; x++) {
        other.rgba.set([180, 40, 40, 255], (y * 512 + x) * 4);
      }
    }
    const b = packFrontViewToAtlas(other)!;
    const bodyA = avgOfRect(a.atlas, CLASSIC_LAYOUT.body.base.front);
    const bodyB = avgOfRect(b.atlas, CLASSIC_LAYOUT.body.base.front);
    expect(Math.abs(bodyA[1] - bodyB[1])).toBeGreaterThan(50);
  });
});
