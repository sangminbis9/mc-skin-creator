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

function redAt(
  atlas: RawImage,
  rect: { x: number; y: number },
  x: number,
  y: number,
): number {
  return atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4];
}

function greenAt(
  atlas: RawImage,
  rect: { x: number; y: number },
  x: number,
  y: number,
): number {
  return atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 1];
}

function alphaAt(
  atlas: RawImage,
  rect: { x: number; y: number },
  x: number,
  y: number,
): number {
  return atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + 3];
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
    const armSide = CLASSIC_LAYOUT.rightArm.overlay.right;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const rightLegSide = CLASSIC_LAYOUT.rightLeg.overlay.right;
    const leftLegBack = CLASSIC_LAYOUT.leftLeg.overlay.back;

    const panel = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const trim = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const openCenter = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const side = ((bodySide.y + 5) * ATLAS_SIZE + bodySide.x + 1) * 4;
    const back = ((bodyBack.y + 5) * ATLAS_SIZE + bodyBack.x + 4) * 4;
    const sleeve = ((armFront.y + 4) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveFold = ((armFront.y + 3) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveSideFold = ((armSide.y + 6) * ATLAS_SIZE + armSide.x + 1) * 4;
    const lowerLeftPanel = ((bodyFront.y + bodyFront.h - 2) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const lowerTrim = ((bodyFront.y + bodyFront.h - 2) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const lowerOpenCenter = ((bodyFront.y + bodyFront.h - 2) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const sideLowerHem = ((bodySide.y + bodySide.h - 2) * ATLAS_SIZE + bodySide.x) * 4;
    const backCenterSeam = ((bodyBack.y + bodyBack.h - 2) * ATLAS_SIZE + bodyBack.x + 4) * 4;
    const buttonLight = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const buttonShadow = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 6) * 4;
    const pocketLight = ((bodyFront.y + 7) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const pocketShadow = ((bodyFront.y + 7) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const sidePocketLight = ((bodySide.y + 7) * ATLAS_SIZE + bodySide.x + 1) * 4;
    const sidePocketShadow = ((bodySide.y + 7) * ATLAS_SIZE + bodySide.x + 2) * 4;
    const sleeveCuffLight = ((armFront.y + armFront.h - 3) * ATLAS_SIZE + armFront.x) * 4;
    const sleeveCuffShadow = ((armFront.y + armFront.h - 3) * ATLAS_SIZE + armFront.x + 1) * 4;
    const rightTailPanel = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x) * 4;
    const rightTailTrim = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const leftTailTrim = (leftLegFront.y * ATLAS_SIZE + leftLegFront.x + 2) * 4;
    const openLegCenter = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 3) * 4;
    const rightTailFoldLight = ((rightLegFront.y + 1) * ATLAS_SIZE + rightLegFront.x) * 4;
    const rightTailFoldShadow = ((rightLegFront.y + 2) * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const leftTailFoldLight = ((leftLegFront.y + 1) * ATLAS_SIZE + leftLegFront.x + 3) * 4;
    const leftTailFoldShadow = ((leftLegFront.y + 2) * ATLAS_SIZE + leftLegFront.x + 2) * 4;
    const sideTail = ((rightLegSide.y + 1) * ATLAS_SIZE + rightLegSide.x + 1) * 4;
    const sideTailFold = ((rightLegSide.y + 2) * ATLAS_SIZE + rightLegSide.x) * 4;
    const backTail = ((leftLegBack.y + 2) * ATLAS_SIZE + leftLegBack.x + 3) * 4;
    const backTailHighlight = ((leftLegBack.y + 1) * ATLAS_SIZE + leftLegBack.x + leftLegBack.w - 2) * 4;

    expect(atlas.rgba[panel + 3]).toBe(255);
    expect(atlas.rgba[trim + 3]).toBe(255);
    expect(atlas.rgba[openCenter + 3]).toBe(0);
    expect(atlas.rgba[trim]).toBeLessThan(atlas.rgba[panel]);
    expect(atlas.rgba[side + 3]).toBe(255);
    expect(atlas.rgba[back + 3]).toBe(255);
    expect(atlas.rgba[sleeve + 3]).toBe(255);
    expect(atlas.rgba[sleeveFold + 3]).toBe(255);
    expect(atlas.rgba[sleeveSideFold + 3]).toBe(255);
    expect(atlas.rgba[sleeve]).toBeGreaterThan(atlas.rgba[sleeveFold]);
    expect(atlas.rgba[lowerLeftPanel + 3]).toBe(255);
    expect(atlas.rgba[lowerTrim + 3]).toBe(255);
    expect(atlas.rgba[lowerOpenCenter + 3]).toBe(0);
    expect(atlas.rgba[lowerTrim]).toBeLessThan(atlas.rgba[lowerLeftPanel]);
    expect(atlas.rgba[sideLowerHem + 3]).toBe(255);
    expect(atlas.rgba[backCenterSeam]).toBeLessThan(atlas.rgba[back]);
    expect(atlas.rgba[buttonLight + 3]).toBe(255);
    expect(atlas.rgba[buttonLight]).toBeGreaterThan(atlas.rgba[buttonShadow]);
    expect(atlas.rgba[pocketLight + 3]).toBe(255);
    expect(atlas.rgba[pocketLight]).toBeGreaterThan(atlas.rgba[pocketShadow]);
    expect(atlas.rgba[sidePocketLight + 3]).toBe(255);
    expect(atlas.rgba[sidePocketLight]).toBeGreaterThan(atlas.rgba[sidePocketShadow]);
    expect(atlas.rgba[sleeveCuffLight + 3]).toBe(255);
    expect(atlas.rgba[sleeveCuffLight]).toBeGreaterThan(atlas.rgba[sleeveCuffShadow]);
    expect(atlas.rgba[rightTailPanel + 3]).toBe(255);
    expect(atlas.rgba[rightTailTrim + 3]).toBe(255);
    expect(atlas.rgba[leftTailTrim + 3]).toBe(255);
    expect(atlas.rgba[openLegCenter]).not.toBe(atlas.rgba[rightTailPanel]);
    expect(atlas.rgba[rightTailTrim]).toBeLessThan(atlas.rgba[rightTailPanel]);
    expect(atlas.rgba[rightTailFoldLight]).toBeGreaterThan(atlas.rgba[rightTailFoldShadow]);
    expect(atlas.rgba[leftTailFoldLight]).toBeGreaterThan(atlas.rgba[leftTailFoldShadow]);
    expect(atlas.rgba[sideTail + 3]).toBe(255);
    expect(atlas.rgba[sideTailFold]).toBeLessThan(atlas.rgba[sideTail]);
    expect(atlas.rgba[backTail + 3]).toBe(255);
    expect(atlas.rgba[backTailHighlight]).toBeGreaterThan(atlas.rgba[backTail]);

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
      noseShape: "straight",
      expression: "smile",
    })!;
    const atlas = packed.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay.front;
    const idx = (rect: { x: number; y: number }, x: number, y: number) =>
      ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;

    const eyeHighlight = idx(over, 2, 4);
    const eyeCorner = idx(over, 1, 4);
    const cheekBlush = idx(over, 1, 5);
    const noseBridge = idx(face, 3, 4);
    const noseShadow = idx(face, 3, 5);

    expect(atlas.rgba[eyeHighlight + 3]).toBe(255);
    expect(atlas.rgba[eyeCorner + 3]).toBe(255);
    expect(atlas.rgba[eyeCorner]).toBeLessThan(atlas.rgba[eyeHighlight]);
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
    expect(alphaAt(over.front, 0, 6)).toBe(255);
    expect(alphaAt(over.front, 7, 6)).toBe(255);
    expect(alphaAt(over.right, 1, 6)).toBe(255);
    expect(alphaAt(over.left, 6, 6)).toBe(255);
    expect(alphaAt(over.back, 0, 5)).toBe(255);
    expect(alphaAt(over.back, 7, 5)).toBe(255);
    expect(alphaAt(over.back, 0, 6)).toBe(255);
    expect(alphaAt(over.back, 7, 6)).toBe(255);
    expect(alphaAt(over.top, 0, 5)).toBe(255);
    expect(alphaAt(over.top, 7, 5)).toBe(255);
    expect(alphaAt(over.top, 0, 6)).toBe(255);
    expect(alphaAt(over.top, 7, 6)).toBe(255);
    expect(redAt(over.front, 0, 5)).toBe(redAt(over.right, 0, 5));
    expect(redAt(over.front, 7, 5)).toBe(redAt(over.left, 7, 5));
    expect(redAt(over.right, 7, 6)).not.toBe(redAt(over.right, 3, 6));
    expect(redAt(over.left, 0, 6)).not.toBe(redAt(over.left, 4, 6));
    expect(redAt(over.top, 3, 3)).not.toBe(redAt(over.top, 2, 3));
  });

  it("jaw-length side hair fills the side overlay interior so front and rear locks read as one layer", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "straight",
      bangsLength: "brow",
      hairTexture: "straight",
      hairVolume: "full",
      hairBackShape: "rounded",
      sideHairLength: "jaw",
    })!.atlas;
    const over = CLASSIC_LAYOUT.head.overlay;

    expect(alphaAt(atlas, over.right, 3, 5)).toBe(255);
    expect(alphaAt(atlas, over.right, 5, 6)).toBe(255);
    expect(alphaAt(atlas, over.left, 4, 5)).toBe(255);
    expect(alphaAt(atlas, over.left, 2, 6)).toBe(255);
    expect(alphaAt(atlas, over.top, 1, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 2, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 5, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 6, 5)).toBe(255);
    expect(alphaAt(atlas, over.back, 6, 6)).toBe(255);
    expect(alphaAt(atlas, over.back, 1, 6)).toBe(255);
    expect(redAt(atlas, over.right, 3, 5)).not.toBe(redAt(atlas, over.right, 0, 5));
    expect(redAt(atlas, over.left, 4, 5)).not.toBe(redAt(atlas, over.left, 7, 5));
    expect(redAt(atlas, over.back, 6, 6)).not.toBe(redAt(atlas, over.back, 7, 6));
    expect(redAt(atlas, over.top, 2, 5)).not.toBe(redAt(atlas, over.top, 3, 5));
    expect(redAt(atlas, over.top, 5, 5)).not.toBe(redAt(atlas, over.top, 4, 5));
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
    expect(pixel(over.right, 2, 4)[3]).toBe(255);
    expect(pixel(over.left, 5, 4)[3]).toBe(255);
    expect(pixel(over.right, 1, 3)[0]).not.toBe(pixel(over.right, 2, 4)[0]);
  });

  it("short side hair adds ear-level outer layer locks that connect front, side and top faces", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "straight",
      bangsLength: "brow",
      hairTexture: "straight",
      hairVolume: "normal",
      sideHairLength: "short",
    })!.atlas;
    const over = CLASSIC_LAYOUT.head.overlay;

    expect(alphaAt(atlas, over.front, 0, 4)).toBe(255);
    expect(alphaAt(atlas, over.front, 7, 4)).toBe(255);
    expect(alphaAt(atlas, over.right, 0, 4)).toBe(255);
    expect(alphaAt(atlas, over.right, 1, 4)).toBe(255);
    expect(alphaAt(atlas, over.left, 7, 4)).toBe(255);
    expect(alphaAt(atlas, over.left, 6, 4)).toBe(255);
    expect(alphaAt(atlas, over.top, 0, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 7, 5)).toBe(255);
    expect(alphaAt(atlas, over.back, 7, 3)).toBe(255);
    expect(alphaAt(atlas, over.back, 0, 3)).toBe(255);
    expect(redAt(atlas, over.front, 0, 4)).toBe(redAt(atlas, over.right, 0, 4));
    expect(redAt(atlas, over.front, 7, 4)).toBe(redAt(atlas, over.left, 7, 4));
    expect(redAt(atlas, over.right, 1, 4)).toBeLessThanOrEqual(redAt(atlas, over.right, 0, 4));
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

  it("hairBackShape controls inferred rear hair and connects it to side rear edges", () => {
    const longBack = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      hairBackShape: "long",
      sideHairLength: "jaw",
    })!.atlas;
    const tiedBack = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      hairBackShape: "tied",
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

    expect(pixel(longBack, over.back, 3, 7)[3]).toBe(255);
    expect(pixel(longBack, over.back, 0, 5)[0]).toBe(pixel(longBack, over.right, 7, 5)[0]);
    expect(pixel(longBack, over.back, 7, 5)[0]).toBe(pixel(longBack, over.left, 0, 5)[0]);
    expect(pixel(tiedBack, over.back, 3, 6)[3]).toBe(255);
    expect(pixel(tiedBack, over.back, 3, 6)[0]).not.toBe(pixel(longBack, over.back, 3, 6)[0]);
  });

  it("shoulder-length side hair continues onto torso overlay as visible front and back strands", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      bangs: "curtain",
      hairTexture: "wavy",
      hairBackShape: "long",
      sideHairLength: "shoulder",
    })!.atlas;
    const body = CLASSIC_LAYOUT.body.overlay;
    const head = CLASSIC_LAYOUT.head.overlay;
    const rightArm = CLASSIC_LAYOUT.rightArm.overlay;
    const leftArm = CLASSIC_LAYOUT.leftArm.overlay;

    expect(alphaAt(atlas, head.right, 1, 2)).toBe(255);
    expect(alphaAt(atlas, head.right, 3, 7)).toBe(255);
    expect(alphaAt(atlas, head.left, 6, 2)).toBe(255);
    expect(alphaAt(atlas, head.back, 3, 7)).toBe(255);
    expect(redAt(atlas, head.right, 1, 2)).toBeGreaterThan(redAt(atlas, head.right, 3, 7));
    expect(redAt(atlas, head.left, 6, 2)).toBeGreaterThan(redAt(atlas, head.left, 4, 7));
    expect(alphaAt(atlas, body.front, 0, 6)).toBe(255);
    expect(alphaAt(atlas, body.front, 7, 6)).toBe(255);
    expect(alphaAt(atlas, body.front, 2, 4)).toBe(255);
    expect(alphaAt(atlas, body.front, 5, 4)).toBe(255);
    expect(alphaAt(atlas, body.right, 1, 5)).toBe(255);
    expect(alphaAt(atlas, body.left, 2, 5)).toBe(255);
    expect(alphaAt(atlas, body.right, 0, 7)).toBe(255);
    expect(alphaAt(atlas, body.left, body.left.w - 1, 7)).toBe(255);
    expect(alphaAt(atlas, body.back, 3, 7)).toBe(255);
    expect(alphaAt(atlas, body.back, 4, 7)).toBe(255);
    expect(redAt(atlas, body.front, 0, 6)).not.toBe(redAt(atlas, body.front, 3, 6));
    expect(alphaAt(atlas, body.front, 1, 2)).toBe(255);
    expect(alphaAt(atlas, body.front, 1, 5)).toBe(255);
    expect(alphaAt(atlas, body.front, 6, 6)).toBe(255);
    expect(redAt(atlas, body.front, 1, 2)).toBeGreaterThan(redAt(atlas, body.front, 1, 5));
    expect(redAt(atlas, body.front, 6, 2)).toBeGreaterThan(redAt(atlas, body.front, 6, 6));
    expect(alphaAt(atlas, body.right, 1, 3)).toBe(255);
    expect(alphaAt(atlas, body.left, 2, 3)).toBe(255);
    expect(redAt(atlas, body.back, 2, 4)).toBeGreaterThan(redAt(atlas, body.back, 4, 7));
    expect(alphaAt(atlas, rightArm.front, 0, 5)).toBe(255);
    expect(alphaAt(atlas, rightArm.front, rightArm.front.w - 1, 1)).toBe(255);
    expect(alphaAt(atlas, rightArm.right, 1, 3)).toBe(255);
    expect(alphaAt(atlas, rightArm.top, 0, 1)).toBe(255);
    expect(alphaAt(atlas, leftArm.front, leftArm.front.w - 1, 5)).toBe(255);
    expect(alphaAt(atlas, leftArm.front, 0, 1)).toBe(255);
    expect(alphaAt(atlas, leftArm.left, 1, 3)).toBe(255);
    expect(alphaAt(atlas, leftArm.top, leftArm.top.w - 1, 1)).toBe(255);
    expect(redAt(atlas, rightArm.front, 0, 0)).toBeGreaterThan(redAt(atlas, rightArm.front, 0, 5));
    expect(redAt(atlas, leftArm.front, leftArm.front.w - 1, 0)).toBeGreaterThan(
      redAt(atlas, leftArm.front, leftArm.front.w - 1, 5),
    );
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

  it("pants and jeans add connected knee folds and outer seams on leg overlays", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "pants",
    })!.atlas;
    const right = CLASSIC_LAYOUT.rightLeg.overlay;
    const left = CLASSIC_LAYOUT.leftLeg.overlay;
    const rightFrontFold = ((right.front.y + 4) * ATLAS_SIZE + right.front.x + 1) * 4;
    const rightSideFold = ((right.right.y + 4) * ATLAS_SIZE + right.right.x + 1) * 4;
    const rightSideSeam = ((right.right.y + 5) * ATLAS_SIZE + right.right.x) * 4;
    const leftSideSeam = ((left.left.y + 5) * ATLAS_SIZE + left.left.x + left.left.w - 1) * 4;
    const rightHighlight = ((right.front.y + 5) * ATLAS_SIZE + right.front.x + 1) * 4;

    expect(atlas.rgba[rightFrontFold + 3]).toBe(255);
    expect(atlas.rgba[rightSideFold + 3]).toBe(255);
    expect(atlas.rgba[rightSideSeam + 3]).toBe(255);
    expect(atlas.rgba[leftSideSeam + 3]).toBe(255);
    expect(atlas.rgba[rightHighlight]).toBeGreaterThan(atlas.rgba[rightFrontFold]);
    expect(atlas.rgba[rightSideSeam]).toBeLessThan(atlas.rgba[rightSideFold]);
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
    const top = CLASSIC_LAYOUT.head.overlay.top;
    const back = CLASSIC_LAYOUT.head.overlay.back;
    const petal = ((front.y + 2) * ATLAS_SIZE + front.x + 1) * 4;
    const leaf = ((front.y + 1) * ATLAS_SIZE + front.x + 2) * 4;
    const sidePetal = ((side.y + 2) * ATLAS_SIZE + side.x + 6) * 4;
    const sideLowerPetal = ((side.y + 4) * ATLAS_SIZE + side.x + 7) * 4;
    const topPetal = ((top.y + 5) * ATLAS_SIZE + top.x + 2) * 4;
    const topLeaf = ((top.y + 6) * ATLAS_SIZE + top.x + 3) * 4;
    const backPetal = ((back.y + 4) * ATLAS_SIZE + back.x) * 4;
    const backLeaf = ((back.y + 3) * ATLAS_SIZE + back.x + 1) * 4;
    const frontClusterPetal = ((front.y + 2) * ATLAS_SIZE + front.x + 3) * 4;
    const frontClusterLeaf = ((front.y + 1) * ATLAS_SIZE + front.x + 3) * 4;
    const frontOuterPetal = ((front.y + 1) * ATLAS_SIZE + front.x + 4) * 4;
    const frontStemLeaf = ((front.y + 3) * ATLAS_SIZE + front.x + 5) * 4;
    const sideClusterPetal = ((side.y + 3) * ATLAS_SIZE + side.x + 4) * 4;
    const sideClusterLeaf = ((side.y + 5) * ATLAS_SIZE + side.x + 4) * 4;
    const sideInnerFlower = ((side.y + 3) * ATLAS_SIZE + side.x + 3) * 4;
    const sideInnerLeaf = ((side.y + 2) * ATLAS_SIZE + side.x + 2) * 4;
    const topSecondFlower = ((top.y + 5) * ATLAS_SIZE + top.x + 4) * 4;
    const topDarkLeaf = ((top.y + 6) * ATLAS_SIZE + top.x + 5) * 4;
    const topOuterPetal = ((top.y + 4) * ATLAS_SIZE + top.x + 5) * 4;
    const topOuterLeaf = ((top.y + 6) * ATLAS_SIZE + top.x + 6) * 4;
    const backFlowerCenter = ((back.y + 4) * ATLAS_SIZE + back.x + 1) * 4;
    const backTrailingLeaf = ((back.y + 4) * ATLAS_SIZE + back.x + 3) * 4;

    expect(atlas.rgba[petal + 3]).toBe(255);
    expect(atlas.rgba[petal]).toBeGreaterThan(atlas.rgba[petal + 1]);
    expect(atlas.rgba[leaf + 1]).toBeGreaterThan(atlas.rgba[leaf]);
    expect(atlas.rgba[sidePetal + 3]).toBe(255);
    expect(atlas.rgba[sideLowerPetal + 3]).toBe(255);
    expect(atlas.rgba[topPetal + 3]).toBe(255);
    expect(atlas.rgba[topPetal]).toBeGreaterThan(atlas.rgba[topPetal + 1]);
    expect(atlas.rgba[topLeaf + 1]).toBeGreaterThan(atlas.rgba[topLeaf]);
    expect(atlas.rgba[backPetal + 3]).toBe(255);
    expect(atlas.rgba[backLeaf + 1]).toBeGreaterThan(atlas.rgba[backLeaf]);
    expect(atlas.rgba[frontClusterPetal + 3]).toBe(255);
    expect(atlas.rgba[frontClusterPetal]).toBeGreaterThan(atlas.rgba[frontClusterLeaf]);
    expect(atlas.rgba[frontOuterPetal + 3]).toBe(255);
    expect(atlas.rgba[frontOuterPetal]).toBeGreaterThan(atlas.rgba[frontStemLeaf]);
    expect(atlas.rgba[sideClusterPetal + 3]).toBe(255);
    expect(atlas.rgba[sideClusterLeaf + 1]).toBeGreaterThan(atlas.rgba[sideClusterLeaf]);
    expect(atlas.rgba[sideInnerFlower + 3]).toBe(255);
    expect(atlas.rgba[sideInnerLeaf + 1]).toBeGreaterThan(atlas.rgba[sideInnerLeaf]);
    expect(atlas.rgba[topSecondFlower + 3]).toBe(255);
    expect(atlas.rgba[topDarkLeaf + 1]).toBeGreaterThan(atlas.rgba[topDarkLeaf]);
    expect(atlas.rgba[topOuterPetal + 3]).toBe(255);
    expect(atlas.rgba[topOuterLeaf + 1]).toBeGreaterThan(atlas.rgba[topOuterLeaf]);
    expect(atlas.rgba[backFlowerCenter + 3]).toBe(255);
    expect(atlas.rgba[backTrailingLeaf + 1]).toBeGreaterThan(atlas.rgba[backTrailingLeaf]);
  });

  it("hairAccessorySide=right이면 꽃 장식을 반대쪽 head overlay 면으로 옮긴다", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairAccessory: "flower",
      hairAccessorySide: "right",
      hairstyle: "long",
      hairVolume: "full",
    })!.atlas;
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const side = CLASSIC_LAYOUT.head.overlay.left;
    const top = CLASSIC_LAYOUT.head.overlay.top;
    const back = CLASSIC_LAYOUT.head.overlay.back;

    const rightFrontPetal = ((front.y + 2) * ATLAS_SIZE + front.x + 6) * 4;
    const oldLeftFrontPetal = ((front.y + 2) * ATLAS_SIZE + front.x + 1) * 4;
    const rightSidePetal = ((side.y + 2) * ATLAS_SIZE + side.x + 1) * 4;
    const rightTopPetal = ((top.y + 5) * ATLAS_SIZE + top.x + 5) * 4;
    const rightBackPetal = ((back.y + 4) * ATLAS_SIZE + back.x + 7) * 4;

    expect(atlas.rgba[rightFrontPetal + 3]).toBe(255);
    expect(atlas.rgba[rightFrontPetal]).toBeGreaterThan(atlas.rgba[rightFrontPetal + 1]);
    expect(atlas.rgba[rightFrontPetal]).toBeGreaterThan(atlas.rgba[oldLeftFrontPetal]);
    expect(atlas.rgba[rightSidePetal + 3]).toBe(255);
    expect(atlas.rgba[rightSidePetal]).toBeGreaterThan(atlas.rgba[rightSidePetal + 1]);
    expect(atlas.rgba[rightTopPetal + 3]).toBe(255);
    expect(atlas.rgba[rightBackPetal + 3]).toBe(255);
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
    const leftSide = CLASSIC_LAYOUT.leftLeg.overlay.left;
    const leftBack = CLASSIC_LAYOUT.leftLeg.overlay.back;
    const right = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const rightSide = CLASSIC_LAYOUT.rightLeg.overlay.right;
    const rightBack = CLASSIC_LAYOUT.rightLeg.overlay.back;
    const warmer = ((left.y + 4) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerLace = ((left.y + 1) * ATLAS_SIZE + left.x) * 4;
    const warmerLaceShadow = ((left.y + 1) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerRidge = ((left.y + 3) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerLift = ((left.y + 4) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerScallopDrop = ((left.y + 3) * ATLAS_SIZE + left.x + 2) * 4;
    const warmerSideRidge = ((leftSide.y + 5) * ATLAS_SIZE + leftSide.x) * 4;
    const warmerSideLift = ((leftSide.y + 4) * ATLAS_SIZE + leftSide.x + 1) * 4;
    const warmerSideLace = ((leftSide.y + 1) * ATLAS_SIZE + leftSide.x) * 4;
    const warmerBackRidge = ((leftBack.y + 7) * ATLAS_SIZE + leftBack.x + 2) * 4;
    const warmerBackLift = ((leftBack.y + 6) * ATLAS_SIZE + leftBack.x + 2) * 4;
    const bow = ((right.y + 2) * ATLAS_SIZE + right.x) * 4;
    const bowTail = ((right.y + 4) * ATLAS_SIZE + right.x + 1) * 4;
    const bareLowerLeg = ((right.y + 5) * ATLAS_SIZE + right.x + 3) * 4;
    const sideBand = ((rightSide.y + 2) * ATLAS_SIZE + rightSide.x + 1) * 4;
    const sideTail = ((rightSide.y + 3) * ATLAS_SIZE + rightSide.x) * 4;
    const sideLongTail = ((rightSide.y + 4) * ATLAS_SIZE + rightSide.x) * 4;
    const backBand = ((rightBack.y + 2) * ATLAS_SIZE + rightBack.x + 2) * 4;

    expect(atlas.rgba[warmer + 3]).toBe(255);
    expect(atlas.rgba[warmerLace + 3]).toBe(255);
    expect(atlas.rgba[warmerLaceShadow + 3]).toBe(255);
    expect(atlas.rgba[warmerLace]).toBeGreaterThan(atlas.rgba[warmerLaceShadow]);
    expect(atlas.rgba[warmerScallopDrop + 3]).toBe(255);
    expect(atlas.rgba[warmerSideLace + 3]).toBe(255);
    expect(atlas.rgba[bow + 3]).toBe(255);
    expect(atlas.rgba[bow]).toBeGreaterThan(220);
    expect(atlas.rgba[bowTail + 3]).toBe(255);
    expect(atlas.rgba[bareLowerLeg + 3]).toBe(0);
    expect(atlas.rgba[sideBand + 3]).toBe(255);
    expect(atlas.rgba[sideTail + 3]).toBe(255);
    expect(atlas.rgba[sideLongTail + 3]).toBe(255);
    expect(atlas.rgba[backBand + 3]).toBe(255);
    expect(atlas.rgba[sideBand]).toBeGreaterThan(atlas.rgba[sideBand + 1]);
    expect(atlas.rgba[warmerRidge]).toBeLessThan(atlas.rgba[warmerLift]);
    expect(atlas.rgba[warmerSideRidge]).toBeLessThan(atlas.rgba[warmerSideLift]);
    expect(atlas.rgba[warmerBackRidge]).toBeLessThan(atlas.rgba[warmerBackLift]);
  });

  it("dressy skirt outfits add visible shoe straps across front and side foot overlays", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "skirt",
      outerGarment: "cardigan",
      neckAccessory: "bow",
      bottomAccent: "ribbon",
    })!.atlas;
    const right = CLASSIC_LAYOUT.rightLeg.overlay;
    const left = CLASSIC_LAYOUT.leftLeg.overlay;
    const rightFrontBow = ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x + 1) * 4;
    const rightFrontKnot = ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x + 2) * 4;
    const rightFrontStrap = ((right.front.y + right.front.h - 2) * ATLAS_SIZE + right.front.x + 1) * 4;
    const rightFrontToe = ((right.front.y + right.front.h - 1) * ATLAS_SIZE + right.front.x + 2) * 4;
    const rightSideStrap = ((right.right.y + right.right.h - 2) * ATLAS_SIZE + right.right.x) * 4;
    const rightSideBuckle = ((right.right.y + right.right.h - 3) * ATLAS_SIZE + right.right.x + right.right.w - 1) * 4;
    const leftSideStrap = ((left.left.y + left.left.h - 2) * ATLAS_SIZE + left.left.x + 1) * 4;
    const leftSideKnot = ((left.left.y + left.left.h - 3) * ATLAS_SIZE + left.left.x) * 4;
    const backStrap = ((left.back.y + left.back.h - 2) * ATLAS_SIZE + left.back.x + 2) * 4;
    const backHeelBow = ((left.back.y + left.back.h - 2) * ATLAS_SIZE + left.back.x) * 4;

    expect(atlas.rgba[rightFrontBow + 3]).toBe(255);
    expect(atlas.rgba[rightFrontKnot + 3]).toBe(255);
    expect(atlas.rgba[rightFrontBow]).toBeGreaterThan(atlas.rgba[rightFrontKnot]);
    expect(atlas.rgba[rightFrontStrap + 3]).toBe(255);
    expect(atlas.rgba[rightFrontToe + 3]).toBe(255);
    expect(atlas.rgba[rightSideStrap + 3]).toBe(255);
    expect(atlas.rgba[rightSideBuckle + 3]).toBe(255);
    expect(atlas.rgba[leftSideStrap + 3]).toBe(255);
    expect(atlas.rgba[leftSideKnot + 3]).toBe(255);
    expect(atlas.rgba[backStrap + 3]).toBe(255);
    expect(atlas.rgba[backHeelBow + 3]).toBe(255);
    expect(atlas.rgba[rightFrontStrap]).toBeGreaterThan(atlas.rgba[rightFrontToe]);
  });

  it("cardigan skirt outfits extend asymmetric long hems onto upper leg overlays", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "skirt",
      outerGarment: "cardigan",
      neckAccessory: "bow",
    })!.atlas;
    const right = CLASSIC_LAYOUT.rightLeg.overlay;
    const left = CLASSIC_LAYOUT.leftLeg.overlay;
    const rightLongHem = ((right.front.y + 3) * ATLAS_SIZE + right.front.x) * 4;
    const rightLongTrim = ((right.front.y + 4) * ATLAS_SIZE + right.front.x) * 4;
    const leftLongHem = ((left.front.y + 3) * ATLAS_SIZE + left.front.x + 3) * 4;
    const leftLongTrim = ((left.front.y + 4) * ATLAS_SIZE + left.front.x + 3) * 4;
    const rightSideHem = ((right.right.y + 3) * ATLAS_SIZE + right.right.x) * 4;
    const leftSideHem = ((left.left.y + 3) * ATLAS_SIZE + left.left.x + left.left.w - 1) * 4;

    expect(atlas.rgba[rightLongHem + 3]).toBe(255);
    expect(atlas.rgba[rightLongTrim + 3]).toBe(255);
    expect(atlas.rgba[leftLongHem + 3]).toBe(255);
    expect(atlas.rgba[leftLongTrim + 3]).toBe(255);
    expect(atlas.rgba[rightSideHem + 3]).toBe(255);
    expect(atlas.rgba[leftSideHem + 3]).toBe(255);
    expect(atlas.rgba[rightLongTrim]).toBeLessThan(atlas.rgba[rightLongHem]);
    expect(atlas.rgba[leftLongTrim]).toBeLessThan(atlas.rgba[leftLongHem]);
  });

  it("explicit shoeStyle=boots paints taller boot cuffs without a dressy outfit", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "pants",
      outerGarment: "none",
      neckAccessory: "none",
      bottomAccent: "none",
      shoeStyle: "boots",
    })!.atlas;
    const right = CLASSIC_LAYOUT.rightLeg.overlay;
    const frontUpperBoot =
      ((right.front.y + right.front.h - 4) * ATLAS_SIZE + right.front.x + 1) * 4;
    const frontBootEdge =
      ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x) * 4;
    const frontBootCenter =
      ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x + 1) * 4;
    const sideUpperBoot =
      ((right.right.y + right.right.h - 4) * ATLAS_SIZE + right.right.x + 1) * 4;
    const sideSole =
      ((right.right.y + right.right.h - 1) * ATLAS_SIZE + right.right.x + right.right.w - 1) * 4;

    expect(atlas.rgba[frontUpperBoot + 3]).toBe(255);
    expect(atlas.rgba[frontBootEdge + 3]).toBe(255);
    expect(atlas.rgba[sideUpperBoot + 3]).toBe(255);
    expect(atlas.rgba[sideSole + 3]).toBe(255);
    expect(atlas.rgba[frontBootEdge]).toBeLessThan(atlas.rgba[frontBootCenter]);
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
    const top = CLASSIC_LAYOUT.body.overlay.top;
    const side = CLASSIC_LAYOUT.body.overlay.right;
    const leftSide = CLASSIC_LAYOUT.body.overlay.left;
    const back = CLASSIC_LAYOUT.body.overlay.back;
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const rightLegSide = CLASSIC_LAYOUT.rightLeg.overlay.right;
    const bowLeft = ((body.y + 1) * ATLAS_SIZE + body.x + 2) * 4;
    const bowCenter = ((body.y + 1) * ATLAS_SIZE + body.x + 3) * 4;
    const bowTail = ((body.y + 5) * ATLAS_SIZE + body.x + 2) * 4;
    const bowTailShadow = ((body.y + 5) * ATLAS_SIZE + body.x + 4) * 4;
    const bowLongTail = ((body.y + 6) * ATLAS_SIZE + body.x + 3) * 4;
    const bowTop = ((top.y + top.h - 1) * ATLAS_SIZE + top.x + 3) * 4;
    const bowTopShadow = ((top.y + top.h - 1) * ATLAS_SIZE + top.x + 4) * 4;
    const sideBowWrap = ((side.y + 1) * ATLAS_SIZE + side.x) * 4;
    const sideBowTail = ((side.y + 3) * ATLAS_SIZE + side.x + 1) * 4;
    const leftSideBowWrap = ((leftSide.y + 1) * ATLAS_SIZE + leftSide.x + leftSide.w - 1) * 4;
    const leftSideBowTail = ((leftSide.y + 3) * ATLAS_SIZE + leftSide.x + leftSide.w - 2) * 4;
    const plaidDark =
      ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 1) * 4;
    const plaidLight =
      ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 2) * 4;
    const sidePlaidDark =
      ((side.y + side.h - 3) * ATLAS_SIZE + side.x + 1) * 4;
    const sidePlaidLight =
      ((side.y + side.h - 3) * ATLAS_SIZE + side.x) * 4;
    const backPlaidDark =
      ((back.y + back.h - 3) * ATLAS_SIZE + back.x + 1) * 4;
    const backPlaidLight =
      ((back.y + back.h - 3) * ATLAS_SIZE + back.x + 2) * 4;
    const legPlaidDark = ((rightLeg.y) * ATLAS_SIZE + rightLeg.x + 1) * 4;
    const legPlaidLight = ((rightLeg.y) * ATLAS_SIZE + rightLeg.x + 2) * 4;
    const legPlaidCross = ((rightLeg.y + 1) * ATLAS_SIZE + rightLeg.x + 1) * 4;
    const legPlaidSideLight = ((rightLegSide.y) * ATLAS_SIZE + rightLegSide.x) * 4;
    const legPlaidSideDark = ((rightLegSide.y + 1) * ATLAS_SIZE + rightLegSide.x + 1) * 4;

    expect(atlas.rgba[bowLeft + 3]).toBe(255);
    expect(atlas.rgba[bowLeft]).toBeGreaterThan(atlas.rgba[bowCenter]);
    expect(atlas.rgba[bowTail + 3]).toBe(255);
    expect(atlas.rgba[bowTailShadow + 3]).toBe(255);
    expect(atlas.rgba[bowTail]).toBeGreaterThan(atlas.rgba[bowTailShadow]);
    expect(atlas.rgba[bowLongTail + 3]).toBe(255);
    expect(atlas.rgba[bowTop + 3]).toBe(255);
    expect(atlas.rgba[bowTop]).toBeGreaterThan(atlas.rgba[bowTopShadow]);
    expect(atlas.rgba[sideBowWrap + 3]).toBe(255);
    expect(atlas.rgba[sideBowTail + 3]).toBe(255);
    expect(atlas.rgba[leftSideBowWrap + 3]).toBe(255);
    expect(atlas.rgba[leftSideBowTail + 3]).toBe(255);
    expect(atlas.rgba[plaidDark + 3]).toBe(255);
    expect(atlas.rgba[plaidDark]).toBeLessThan(atlas.rgba[plaidLight]);
    expect(atlas.rgba[sidePlaidDark + 3]).toBe(255);
    expect(atlas.rgba[sidePlaidDark]).toBeLessThan(atlas.rgba[sidePlaidLight]);
    expect(atlas.rgba[backPlaidDark + 3]).toBe(255);
    expect(atlas.rgba[backPlaidDark]).toBeLessThan(atlas.rgba[backPlaidLight]);
    expect(atlas.rgba[legPlaidDark + 3]).toBe(255);
    expect(atlas.rgba[legPlaidDark]).toBeLessThan(atlas.rgba[legPlaidLight]);
    expect(atlas.rgba[legPlaidCross]).toBeLessThan(atlas.rgba[legPlaidDark]);
    expect(atlas.rgba[legPlaidSideLight + 3]).toBe(255);
    expect(atlas.rgba[legPlaidSideDark]).toBeLessThan(atlas.rgba[legPlaidSideLight]);
  });

  it("eyebrowShape 힌트를 8x8 얼굴의 눈썹 각도 차이로 남긴다", () => {
    const baseStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none" as const,
      eyeShape: "almond" as const,
      eyeSpacing: "average" as const,
      eyebrowThickness: "thick",
      glasses: "none",
    };
    const arched = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      eyebrowShape: "arched",
    })!.atlas;
    const slanted = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      eyebrowShape: "slanted",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;

    expect(redAt(arched, face, 2, 2)).toBeLessThan(redAt(slanted, face, 2, 2));
    expect(redAt(arched, face, 5, 2)).toBeLessThan(redAt(slanted, face, 5, 2));
    expect(redAt(slanted, face, 1, 2)).toBeLessThan(redAt(arched, face, 1, 2));
    expect(redAt(slanted, face, 6, 2)).toBeLessThan(redAt(arched, face, 6, 2));
  });

  it("mouthShape 힌트를 8x8 얼굴의 입 폭과 입술 색 차이로 남긴다", () => {
    const baseStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none" as const,
      expression: "neutral",
      glasses: "none",
    };
    const small = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      mouthShape: "small",
    })!.atlas;
    const wide = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      mouthShape: "wide",
    })!.atlas;
    const full = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      mouthShape: "full",
    })!.atlas;
    const thin = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      mouthShape: "thin",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;

    expect(redAt(wide, face, 2, 6)).toBeLessThan(redAt(small, face, 2, 6));
    expect(redAt(wide, face, 5, 6)).toBeLessThan(redAt(small, face, 5, 6));
    expect(greenAt(full, face, 3, 6)).toBeGreaterThan(greenAt(thin, face, 3, 6));
    expect(redAt(thin, face, 2, 6)).toBe(redAt(small, face, 2, 6));
  });

  it("clean faces keep low-res landmark shadows for under-eye, philtrum, mouth corners and chin", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none",
      glasses: "none",
      facialHair: "none",
      eyeShape: "almond",
      mouthShape: "wide",
      noseShape: "straight",
      jawShape: "soft",
    })!.atlas;
    const over = CLASSIC_LAYOUT.head.overlay.front;

    expect(alphaAt(atlas, over, 1, 5)).toBe(255);
    expect(alphaAt(atlas, over, 3, 5)).toBe(255);
    expect(alphaAt(atlas, over, 4, 5)).toBe(255);
    expect(alphaAt(atlas, over, 2, 6)).toBe(255);
    expect(alphaAt(atlas, over, 5, 6)).toBe(255);
    expect(alphaAt(atlas, over, 3, 7)).toBe(255);
    expect(redAt(atlas, over, 3, 5)).toBeLessThan(redAt(atlas, over, 3, 7));
    expect(redAt(atlas, over, 5, 6)).toBeLessThan(redAt(atlas, over, 3, 7));
  });

  it("noseShape 힌트를 8x8 얼굴의 코 길이와 코끝 차이로 남긴다", () => {
    const baseStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none" as const,
      glasses: "none",
    };
    const small = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      noseShape: "small",
    })!.atlas;
    const prominent = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      noseShape: "prominent",
    })!.atlas;
    const rounded = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      noseShape: "rounded",
    })!.atlas;
    const straight = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      noseShape: "straight",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay.front;

    expect(redAt(prominent, face, 4, 4)).toBeGreaterThan(redAt(small, face, 4, 4));
    expect(redAt(straight, face, 3, 5)).toBeLessThan(redAt(small, face, 3, 5));
    expect(alphaAt(prominent, over, 4, 3)).toBe(255);
    expect(alphaAt(rounded, over, 4, 5)).toBe(255);
    expect(alphaAt(straight, over, 4, 5)).toBe(255);
    expect(redAt(rounded, over, 4, 5)).not.toBe(redAt(straight, over, 4, 5));
  });

  it("jawShape 힌트를 8x8 얼굴의 턱 모서리와 턱끝 차이로 남긴다", () => {
    const baseStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none" as const,
      facialHair: "none",
      glasses: "none",
      faceShape: "oval" as const,
    };
    const square = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      jawShape: "square",
    })!.atlas;
    const pointed = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      jawShape: "pointed",
    })!.atlas;
    const rounded = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      jawShape: "rounded",
    })!.atlas;
    const soft = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      jawShape: "soft",
    })!.atlas;
    const over = CLASSIC_LAYOUT.head.overlay.front;

    expect(alphaAt(square, over, 1, 7)).toBe(255);
    expect(alphaAt(pointed, over, 1, 7)).toBe(0);
    expect(redAt(pointed, over, 3, 7)).toBeLessThan(redAt(square, over, 3, 7));
    expect(alphaAt(rounded, over, 1, 6)).toBe(255);
    expect(alphaAt(soft, over, 1, 6)).toBe(0);
  });
});
