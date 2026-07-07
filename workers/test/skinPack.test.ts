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

    // 볼·턱 라운딩: 얼굴 overlay가 불투명 피부색으로 채워져 둥글게 렌더된다.
    const headOverlay = CLASSIC_LAYOUT.head.overlay.front;
    const cheekIdx = ((headOverlay.y + 5) * ATLAS_SIZE + headOverlay.x) * 4;
    const chinIdx = ((headOverlay.y + 7) * ATLAS_SIZE + headOverlay.x + 3) * 4;
    expect(atlas.rgba[cheekIdx + 3]).toBe(255);
    expect(atlas.rgba[cheekIdx]).toBeGreaterThan(100); // 피부 계열 (머리색 아님)
    expect(atlas.rgba[chinIdx + 3]).toBe(255);

    // 신발: 다리 overlay 발목/밑창이 채워져 발끝 두께를 만든다.
    const legOverlay = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const ankleIdx =
      ((legOverlay.y + legOverlay.h - 1) * ATLAS_SIZE + legOverlay.x) * 4;
    expect(atlas.rgba[ankleIdx + 3]).toBe(255);

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

    // 대신 모자 overlay가 정수리 전체와 앞면 챙을 만든다.
    const top = CLASSIC_LAYOUT.head.overlay.top;
    const topCorner = (top.y * 64 + top.x) * 4;
    expect(withHat.atlas.rgba[topCorner + 3]).toBe(255);
    const headOver = CLASSIC_LAYOUT.head.overlay.front;
    const brim = ((headOver.y + 2) * 64 + headOver.x + 3) * 4;
    expect(withHat.atlas.rgba[brim + 3]).toBe(255);
  });

  it("겉옷은 몸통 overlay 옆면까지 둘러 3/4 각도에서 이어진다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      outerLayer: "heavy",
      topType: "jacket",
    })!;
    const atlas = packed.atlas;
    const side = CLASSIC_LAYOUT.body.overlay.right;
    const mid = ((side.y + 5) * ATLAS_SIZE + side.x + 1) * 4;
    expect(atlas.rgba[mid + 3]).toBe(255);
    // 윗행(lit)이 밑단(hem)보다 밝다 — 그림자가 아니라 두께 큐
    const litRow = avgOfRect(atlas, { x: side.x, y: side.y, w: side.w, h: 1 });
    const hemRow = avgOfRect(atlas, {
      x: side.x,
      y: side.y + side.h - 1,
      w: side.w,
      h: 1,
    });
    expect(litRow[0]).toBeGreaterThan(hemRow[0]);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("outerGarment=cardigan keeps an open front and connected side/back/sleeve layers", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      outerGarment: "cardigan",
      topType: "shirt",
      sleeveLength: "long",
    })!;
    const atlas = packed.atlas;
    const bodyFront = CLASSIC_LAYOUT.body.overlay.front;
    const bodySide = CLASSIC_LAYOUT.body.overlay.right;
    const bodyBack = CLASSIC_LAYOUT.body.overlay.back;
    const armFront = CLASSIC_LAYOUT.rightArm.overlay.front;

    const panel = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const trim = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const openCenter = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const side = ((bodySide.y + 5) * ATLAS_SIZE + bodySide.x + 1) * 4;
    const back = ((bodyBack.y + 5) * ATLAS_SIZE + bodyBack.x + 4) * 4;
    const sleeve = ((armFront.y + 4) * ATLAS_SIZE + armFront.x + 1) * 4;

    expect(atlas.rgba[panel + 3]).toBe(255);
    expect(atlas.rgba[trim + 3]).toBe(255);
    expect(atlas.rgba[openCenter + 3]).toBe(0);
    expect(atlas.rgba[trim]).toBeLessThan(atlas.rgba[panel]);
    expect(atlas.rgba[side + 3]).toBe(255);
    expect(atlas.rgba[back + 3]).toBe(255);
    expect(atlas.rgba[sleeve + 3]).toBe(255);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("front/back views use the actual back view", () => {
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

  it("adds readable 8x8 face micro details on the overlay and base face", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      glasses: "none",
      facialHair: "none",
      faceShape: "round",
      eyeShape: "round",
      eyeSpacing: "average",
      expression: "smile",
    })!;
    const atlas = packed.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay.front;
    const idx = (rect: { x: number; y: number }, x: number, y: number) =>
      ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;

    const eyeHighlight = idx(over, 2, 4);
    const cheekBlush = idx(over, 1, 5);
    const noseBridge = idx(face, 3, 4);
    const noseShadow = idx(face, 3, 5);

    expect(atlas.rgba[eyeHighlight + 3]).toBe(255);
    expect(atlas.rgba[cheekBlush + 3]).toBe(255);
    expect(atlas.rgba[cheekBlush]).toBeGreaterThan(atlas.rgba[cheekBlush + 1]);
    expect(atlas.rgba[noseShadow]).toBeLessThan(atlas.rgba[noseBridge]);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("hair overlay side edges connect to adjacent head faces without transparent seams", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "straight",
      hairTexture: "straight",
      hairVolume: "normal",
    })!;
    const atlas = packed.atlas;
    const over = CLASSIC_LAYOUT.head.overlay;
    const alphaAt = (rect: { x: number; y: number }, x: number, y: number) =>
      atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 3];

    for (let y = 0; y < 5; y++) {
      expect(alphaAt(over.right, 7, y)).toBe(255);
      expect(alphaAt(over.left, 0, y)).toBe(255);
      expect(alphaAt(over.right, 0, y)).toBe(255);
      expect(alphaAt(over.left, 7, y)).toBe(255);
    }
    for (let y = 0; y < 4; y++) {
      expect(alphaAt(over.front, 0, y)).toBe(255);
      expect(alphaAt(over.front, 7, y)).toBe(255);
    }
    for (let y = 0; y < 5; y++) {
      expect(alphaAt(over.back, 0, y)).toBe(255);
      expect(alphaAt(over.back, 7, y)).toBe(255);
    }
    for (let x = 1; x < 7; x++) {
      expect(alphaAt(over.top, x, 0)).toBe(255);
      expect(alphaAt(over.top, x, 7)).toBe(255);
    }
  });

  it("hairPart and sideHairLength connect parting and jaw-length side hair across head overlay faces", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "curtain",
      hairPart: "center",
      sideHairLength: "jaw",
      hairVolume: "normal",
    })!;
    const atlas = packed.atlas;
    const over = CLASSIC_LAYOUT.head.overlay;
    const alphaAt = (rect: { x: number; y: number }, x: number, y: number) =>
      atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 3];
    const redAt = (rect: { x: number; y: number }, x: number, y: number) =>
      atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4];

    expect(alphaAt(over.top, 3, 3)).toBe(255);
    expect(alphaAt(over.front, 0, 5)).toBe(255);
    expect(alphaAt(over.front, 7, 5)).toBe(255);
    expect(alphaAt(over.right, 1, 5)).toBe(255);
    expect(alphaAt(over.left, 6, 5)).toBe(255);
    expect(alphaAt(over.back, 0, 5)).toBe(255);
    expect(alphaAt(over.back, 7, 5)).toBe(255);
    expect(alphaAt(over.top, 0, 5)).toBe(255);
    expect(alphaAt(over.top, 7, 5)).toBe(255);
    expect(redAt(over.front, 0, 5)).toBe(redAt(over.right, 0, 5));
    expect(redAt(over.front, 7, 5)).toBe(redAt(over.left, 7, 5));
    expect(redAt(over.top, 3, 3)).not.toBe(redAt(over.top, 2, 3));
  });

  it("hairTexture=wavy adds directional strand highlights on top, front and side overlays", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "side",
      hairTexture: "wavy",
      hairPart: "right",
      sideHairLength: "cheek",
      hairVolume: "full",
    })!;
    const atlas = packed.atlas;
    const over = CLASSIC_LAYOUT.head.overlay;
    const pixel = (rect: { x: number; y: number }, x: number, y: number) => {
      const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return [atlas.rgba[d], atlas.rgba[d + 1], atlas.rgba[d + 2], atlas.rgba[d + 3]];
    };

    expect(pixel(over.top, 5, 2)[3]).toBe(255);
    expect(pixel(over.front, 1, 2)[3]).toBe(255);
    expect(pixel(over.right, 2, 1)[3]).toBe(255);
    expect(pixel(over.right, 2, 1)[0]).not.toBe(pixel(over.right, 3, 2)[0]);
    expect(pixel(over.top, 5, 2)[0]).not.toBe(pixel(over.top, 5, 3)[0]);
  });

  it("straight bangs create layered front hair that wraps into temple side layers", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "straight",
      bangsLength: "brow",
      hairTexture: "straight",
      hairVolume: "full",
      sideHairLength: "cheek",
    })!;
    const atlas = packed.atlas;
    const over = CLASSIC_LAYOUT.head.overlay;
    const pixel = (rect: { x: number; y: number }, x: number, y: number) => {
      const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return [atlas.rgba[d], atlas.rgba[d + 1], atlas.rgba[d + 2], atlas.rgba[d + 3]];
    };

    expect(pixel(over.front, 3, 2)[3]).toBe(255);
    expect(pixel(over.front, 2, 3)[3]).toBe(255);
    expect(pixel(over.front, 0, 3)[0]).toBe(pixel(over.right, 0, 3)[0]);
    expect(pixel(over.front, 7, 3)[0]).toBe(pixel(over.left, 7, 3)[0]);
    expect(pixel(over.top, 0, 4)[3]).toBe(255);
    expect(pixel(over.front, 2, 3)[0]).not.toBe(pixel(over.front, 3, 2)[0]);
  });

  it("bangsLength=eye lets long fringe overlap the eye row on the head overlay", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "straight",
      bangsLength: "eye",
      hairTexture: "straight",
      hairVolume: "full",
      sideHairLength: "cheek",
    })!;
    const atlas = packed.atlas;
    const over = CLASSIC_LAYOUT.head.overlay.front;
    const alphaAt = (x: number, y: number) =>
      atlas.rgba[((over.y + y) * ATLAS_SIZE + over.x + x) * 4 + 3];
    const redAt = (x: number, y: number) =>
      atlas.rgba[((over.y + y) * ATLAS_SIZE + over.x + x) * 4];

    expect(alphaAt(2, 4)).toBe(255);
    expect(alphaAt(4, 4)).toBe(255);
    expect(redAt(4, 4)).toBeLessThan(redAt(3, 2));
  });

  it("hairSilhouette changes the outer hair outline on top, front and side overlays", () => {
    const rounded = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "none",
      hairVolume: "normal",
      hairSilhouette: "rounded",
    })!.atlas;
    const swept = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "none",
      hairVolume: "normal",
      hairSilhouette: "swept",
      hairPart: "left",
    })!.atlas;
    const over = CLASSIC_LAYOUT.head.overlay;
    const pixel = (
      atlas: RawImage,
      rect: { x: number; y: number },
      x: number,
      y: number,
    ) => {
      const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return [atlas.rgba[d], atlas.rgba[d + 1], atlas.rgba[d + 2], atlas.rgba[d + 3]];
    };

    expect(pixel(rounded, over.top, 2, 0)[3]).toBe(255);
    expect(pixel(rounded, over.right, 1, 1)[3]).toBe(255);
    expect(pixel(swept, over.top, 6, 4)[3]).toBe(255);
    expect(pixel(swept, over.front, 3, 2)[3]).toBe(255);
    expect(pixel(swept, over.top, 6, 4)[0]).not.toBe(pixel(rounded, over.top, 6, 4)[0]);
  });

  it("tiny character returns null", () => {
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

  it("bottomType=skirt이면 몸통 하단과 다리 상단 overlay로 치마 밑단과 주름을 만든다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "skirt",
    })!;
    const atlas = packed.atlas;
    const bodyFront = CLASSIC_LAYOUT.body.overlay.front;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;

    const bodyHem =
      ((bodyFront.y + bodyFront.h - 1) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const rightLegTop = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const leftLegTop = (leftLegFront.y * ATLAS_SIZE + leftLegFront.x + 1) * 4;

    expect(atlas.rgba[bodyHem + 3]).toBe(255);
    expect(atlas.rgba[rightLegTop + 3]).toBe(255);
    expect(atlas.rgba[leftLegTop + 3]).toBe(255);
    expect(atlas.rgba[bodyHem]).toBeLessThan(atlas.rgba[rightLegTop]);

    const shades = new Set<number>();
    for (let x = 0; x < bodyFront.w; x++) {
      const d =
        ((bodyFront.y + bodyFront.h - 2) * ATLAS_SIZE + bodyFront.x + x) * 4;
      shades.add(atlas.rgba[d]);
    }
    expect(shades.size).toBeGreaterThan(1);
  });

  it("bottomAccent adds inferred lower-body details even when the lower garment is plain", () => {
    const withBelt = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "pants",
      bottomAccent: "belt",
    })!;
    const beltBody = CLASSIC_LAYOUT.body.overlay.front;
    const beltPixel =
      ((beltBody.y + beltBody.h - 3) * ATLAS_SIZE + beltBody.x + 3) * 4;
    expect(withBelt.atlas.rgba[beltPixel + 3]).toBe(255);

    const withStripe = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "pants",
      bottomAccent: "side_stripe",
    })!;
    const leg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const stripePixel = ((leg.y + 4) * ATLAS_SIZE + leg.x) * 4;
    expect(withStripe.atlas.rgba[stripePixel + 3]).toBe(255);

    applyUvMask(withStripe.atlas);
    expect(validateFinalAtlas(withStripe.atlas).ok).toBe(true);
  });

  it("hairAccessory=flower이면 head overlay 앞/옆면에 꽃과 잎 디테일을 남긴다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairAccessory: "flower",
      hairstyle: "long",
      hairVolume: "full",
    })!;
    const atlas = packed.atlas;
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const side = CLASSIC_LAYOUT.head.overlay.right;
    const petal = ((front.y + 2) * ATLAS_SIZE + front.x + 1) * 4;
    const leaf = ((front.y + 1) * ATLAS_SIZE + front.x + 2) * 4;
    const sidePetal = ((side.y + 2) * ATLAS_SIZE + side.x + 6) * 4;

    expect(atlas.rgba[petal + 3]).toBe(255);
    expect(atlas.rgba[petal]).toBeGreaterThan(atlas.rgba[petal + 1]);
    expect(atlas.rgba[leaf + 1]).toBeGreaterThan(atlas.rgba[leaf]);
    expect(atlas.rgba[sidePetal + 3]).toBe(255);
  });

  it("legwear=leg_warmers와 한쪽 asymmetry이면 한쪽 다리 레그워머와 반대쪽 리본을 그린다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "skirt",
      legwear: "leg_warmers",
      legwearAsymmetry: "left",
    })!;
    const atlas = packed.atlas;
    const left = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const right = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const warmer = ((left.y + 4) * ATLAS_SIZE + left.x + 1) * 4;
    const bow = ((right.y + 2) * ATLAS_SIZE + right.x) * 4;
    const bareSameRow = ((right.y + 4) * ATLAS_SIZE + right.x + 1) * 4;

    expect(atlas.rgba[warmer + 3]).toBe(255);
    expect(atlas.rgba[bow + 3]).toBe(255);
    expect(atlas.rgba[bow]).toBeGreaterThan(220);
    expect(atlas.rgba[bareSameRow + 3]).toBe(0);
  });

  it("neckAccessory=bow와 bottomPattern=plaid이면 목 리본과 체크 하의를 overlay에 보존한다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "skirt",
      bottomPattern: "plaid",
      neckAccessory: "bow",
    })!;
    const atlas = packed.atlas;
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const bowLeft = ((body.y + 1) * ATLAS_SIZE + body.x + 2) * 4;
    const bowCenter = ((body.y + 1) * ATLAS_SIZE + body.x + 3) * 4;
    const plaidDark =
      ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 1) * 4;
    const plaidLight =
      ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 2) * 4;

    expect(atlas.rgba[bowLeft + 3]).toBe(255);
    expect(atlas.rgba[bowLeft]).toBeGreaterThan(atlas.rgba[bowCenter]);
    expect(atlas.rgba[plaidDark + 3]).toBe(255);
    expect(atlas.rgba[plaidDark]).toBeLessThan(atlas.rgba[plaidLight]);
  });
});
