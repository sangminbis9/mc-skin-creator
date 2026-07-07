import { describe, expect, it } from "vitest";
import type { RawImage } from "../src/png";
import { DEFAULT_FACE_STYLE, packFrontViewToAtlas } from "../src/skinPack";
import { applyUvMask, validateFinalAtlas } from "../src/skinPost";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";

import { makeFrontBackView, makeFrontView } from "./helpers";

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

    // 얼굴 라운딩: 가장자리 피부가 중앙 피부보다 어둡다
    // (4행: 눈은 1,2,5,6열이므로 0/7열=가장자리 피부, 3/4열=중앙 피부)
    const edge = (atlas.rgba[(12 * ATLAS_SIZE + 8) * 4] +
      atlas.rgba[(12 * ATLAS_SIZE + 15) * 4]) / 2;
    const center = (atlas.rgba[(12 * ATLAS_SIZE + 11) * 4] +
      atlas.rgba[(12 * ATLAS_SIZE + 12) * 4]) / 2;
    expect(edge).toBeLessThan(center);

    // 생성 렌더에 없던 고정 흰자 템플릿을 새로 만들지 않는다.
    let forcedWhitePixels = 0;
    for (let y = 11; y < 13; y++) {
      for (let x = 8; x < 16; x++) {
        const d = (y * ATLAS_SIZE + x) * 4;
        if (
          atlas.rgba[d] > 240 &&
          atlas.rgba[d + 1] > 240 &&
          atlas.rgba[d + 2] > 240
        ) {
          forcedWhitePixels++;
        }
      }
    }
    expect(forcedWhitePixels).toBe(0);

    // 옷 목선은 overlay에 분리되어 실제 두께를 갖는다.
    const bodyOverlay = CLASSIC_LAYOUT.body.overlay.front;
    const collarAlpha =
      atlas.rgba[(bodyOverlay.y * ATLAS_SIZE + bodyOverlay.x + 2) * 4 + 3];
    expect(collarAlpha).toBe(255);

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

  it("hairstyle=long이면 옆머리가 길고 몸통 뒤 overlay에 머리카락이 내려온다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      eyeColor: "#4a3728",
      glassesColor: "#22201e",
      eyebrowThickness: "normal",
      expression: "neutral",
      facialHair: "none",
      glasses: "none",
      hairstyle: "long",
      hat: "none",
    });
    expect(packed).not.toBeNull();
    const atlas = packed!.atlas;
    // 옆면(head.base.right = x0..7,y8..15) 아래쪽(7행)까지 머리색(어두움)
    const sideLow = avgOfRect(atlas, { x: 0, y: 15, w: 8, h: 1 });
    expect(sideLow[0]).toBeLessThan(120);
    // 몸통 뒤 overlay(boxUV(16,32).back = x32,y36)에 머리카락 존재
    const bodyBackOver = CLASSIC_LAYOUT.body.overlay.back;
    const d = (bodyBackOver.y * 64 + bodyBackOver.x) * 4;
    expect(atlas.rgba[d + 3]).toBe(255);
    expect(atlas.rgba[d]).toBeLessThan(120); // 어두운 머리색
  });

  it("hat이 있으면 카테고리 헤어를 덧그리지 않는다 (렌더의 모자 보존)", () => {
    const withHat = packFrontViewToAtlas(makeFrontView(), {
      eyeColor: "#4a3728",
      glassesColor: "#22201e",
      eyebrowThickness: "normal",
      expression: "neutral",
      facialHair: "none",
      glasses: "none",
      hairstyle: "long",
      hat: "cap",
    })!;
    // 몸통 뒤 overlay가 비어 있어야 함 (장발 합성 생략)
    const bodyBackOver = CLASSIC_LAYOUT.body.overlay.back;
    const d = (bodyBackOver.y * 64 + bodyBackOver.x) * 4;
    expect(withHat.atlas.rgba[d + 3]).toBe(0);
  });

  it("정면/뒷면 두 뷰를 구분하고 실제 뒤통수와 옷 뒷면을 사용한다", () => {
    const packed = packFrontViewToAtlas(makeFrontBackView())!;
    expect(packed.hasBackView).toBe(true);
    const back = avgOfRect(packed.atlas, CLASSIC_LAYOUT.head.base.back);
    expect(back[0]).toBeLessThan(80);
  });

  it("분석 힌트로 앞머리·니트·목걸이·소매를 overlay에 분리한다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bangs: "straight",
      hairTexture: "straight",
      hairVolume: "full",
      garmentTexture: "knit",
      outerLayer: "heavy",
      necklace: "silver",
      topType: "sweater",
      sleeveLength: "long",
      bottomType: "pants",
    })!;
    const atlas = packed.atlas;
    const headOver = CLASSIC_LAYOUT.head.overlay.front;
    const fringeAlpha =
      atlas.rgba[((headOver.y + 2) * ATLAS_SIZE + headOver.x + 3) * 4 + 3];
    expect(fringeAlpha).toBe(255);

    const bodyOver = CLASSIC_LAYOUT.body.overlay.front;
    const pendant =
      ((bodyOver.y + 4) * ATLAS_SIZE + bodyOver.x + 3) * 4;
    expect(atlas.rgba[pendant]).toBeGreaterThan(170);
    expect(atlas.rgba[pendant + 2]).toBeGreaterThan(170);

    const armOver = CLASSIC_LAYOUT.rightArm.overlay.front;
    const cuffAlpha =
      atlas.rgba[((armOver.y + armOver.h - 2) * ATLAS_SIZE + armOver.x) * 4 + 3];
    expect(cuffAlpha).toBe(255);
  });

  it("얼굴 옆 검은 기둥 없이 눈·코·입과 둥근 머리 볼륨을 만든다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      faceShape: "oval",
      eyeShape: "almond",
      eyeSpacing: "average",
      bangs: "straight",
      hairVolume: "normal",
      expression: "neutral",
    })!;
    const atlas = packed.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const leftCheek = ((face.y + 6) * ATLAS_SIZE + face.x) * 4;
    expect(atlas.rgba[leftCheek]).toBeGreaterThan(120);

    const mouth = ((face.y + 6) * ATLAS_SIZE + face.x + 3) * 4;
    expect(atlas.rgba[mouth]).toBeLessThan(atlas.rgba[leftCheek]);

    const top = CLASSIC_LAYOUT.head.overlay.top;
    const topCornerAlpha = atlas.rgba[(top.y * ATLAS_SIZE + top.x) * 4 + 3];
    const topCenterAlpha =
      atlas.rgba[((top.y + 3) * ATLAS_SIZE + top.x + 3) * 4 + 3];
    expect(topCornerAlpha).toBe(0);
    expect(topCenterAlpha).toBe(255);
  });

  it("중간 길이 머리는 외곽 레이어가 정수리·관자놀이·뒤통수로 이어지고 색 램프를 쓴다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "straight",
      hairTexture: "straight",
      hairVolume: "normal",
    })!;
    const atlas = packed.atlas;
    const right = CLASSIC_LAYOUT.head.overlay.right;
    const back = CLASSIC_LAYOUT.head.overlay.back;
    const templeAlpha =
      atlas.rgba[((right.y + 4) * ATLAS_SIZE + right.x) * 4 + 3];
    const backLowerAlpha =
      atlas.rgba[((back.y + 5) * ATLAS_SIZE + back.x + 2) * 4 + 3];
    expect(templeAlpha).toBe(255);
    expect(backLowerAlpha).toBe(255);

    const colors = new Set<string>();
    for (const rect of Object.values(CLASSIC_LAYOUT.head.overlay)) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const d = (y * ATLAS_SIZE + x) * 4;
          if (atlas.rgba[d + 3] === 0) continue;
          colors.add(`${atlas.rgba[d]},${atlas.rgba[d + 1]},${atlas.rgba[d + 2]}`);
        }
      }
    }
    expect(colors.size).toBeGreaterThan(3);
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
