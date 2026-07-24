import { describe, expect, it } from "vitest";
import type { RawImage } from "../src/png";
import {
  DEFAULT_FACE_STYLE,
  packFrontViewToAtlas,
  type FaceStyle,
} from "../src/skinPack";
import { applyUvMask, validateFinalAtlas } from "../src/skinPost";
import { ATLAS_SIZE, CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";

import { makeFourViewSheet, makeFrontBackView, makeFrontView } from "./helpers";

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

function rgbaAt(
  atlas: RawImage,
  rect: { x: number; y: number },
  x: number,
  y: number,
): number[] {
  const index = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
  return Array.from(atlas.rgba.slice(index, index + 4));
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
    const edge =
      (atlas.rgba[(12 * ATLAS_SIZE + 8) * 4] +
        atlas.rgba[(12 * ATLAS_SIZE + 15) * 4]) /
      2;
    const center =
      (atlas.rgba[(12 * ATLAS_SIZE + 11) * 4] +
        atlas.rgba[(12 * ATLAS_SIZE + 12) * 4]) /
      2;
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
    expect(atlas.rgba[cheekIdx + 3]).toBe(0);
    expect(atlas.rgba[chinIdx + 3]).toBe(0);

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
    const mid = ((side.y + 5) * ATLAS_SIZE + side.x) * 4;
    const openInterior = ((side.y + 5) * ATLAS_SIZE + side.x + 1) * 4;
    expect(atlas.rgba[mid + 3]).toBe(255);
    expect(atlas.rgba[openInterior + 3]).toBe(0);
    // 윗행(lit)이 밑단(hem)보다 밝다 — 그림자가 아니라 두께 큐
    const litCenter = (side.y * ATLAS_SIZE + side.x + 1) * 4;
    const hemCenter = ((side.y + side.h - 1) * ATLAS_SIZE + side.x + 1) * 4;
    expect(atlas.rgba[litCenter]).toBeGreaterThan(atlas.rgba[hemCenter]);

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
    const armTop = CLASSIC_LAYOUT.rightArm.overlay.top;
    const armBottom = CLASSIC_LAYOUT.rightArm.overlay.bottom;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const rightLegSide = CLASSIC_LAYOUT.rightLeg.overlay.right;
    const leftLegBack = CLASSIC_LAYOUT.leftLeg.overlay.back;

    const panel = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const trim = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const openCenter = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const side = ((bodySide.y + 5) * ATLAS_SIZE + bodySide.x) * 4;
    const back = ((bodyBack.y + 5) * ATLAS_SIZE + bodyBack.x) * 4;
    const sleeve = ((armFront.y + 4) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveFold = ((armFront.y + 3) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveSideFold = ((armSide.y + 5) * ATLAS_SIZE + armSide.x) * 4;
    const lowerLeftPanel =
      ((bodyFront.y + bodyFront.h - 2) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const lowerTrim =
      ((bodyFront.y + bodyFront.h - 2) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const lowerOpenCenter =
      ((bodyFront.y + bodyFront.h - 2) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const sideLowerHem =
      ((bodySide.y + bodySide.h - 2) * ATLAS_SIZE + bodySide.x) * 4;
    const backCenterSeam =
      ((bodyBack.y + bodyBack.h - 2) * ATLAS_SIZE + bodyBack.x + 4) * 4;
    const buttonLight = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const buttonShadow = ((bodyFront.y + 5) * ATLAS_SIZE + bodyFront.x + 6) * 4;
    const pocketLight = ((bodyFront.y + 7) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const pocketShadow = ((bodyFront.y + 7) * ATLAS_SIZE + bodyFront.x + 2) * 4;
    const sidePocketLight =
      ((bodySide.y + 7) * ATLAS_SIZE + bodySide.x + 1) * 4;
    const sidePocketShadow =
      ((bodySide.y + 7) * ATLAS_SIZE + bodySide.x + 2) * 4;
    const frontYarnLight =
      ((bodyFront.y + 4) * ATLAS_SIZE + bodyFront.x + 1) * 4;
    const frontYarnShadow =
      ((bodyFront.y + 4) * ATLAS_SIZE + bodyFront.x + 6) * 4;
    const sideYarnShadow = ((bodySide.y + 5) * ATLAS_SIZE + bodySide.x) * 4;
    const sideYarnLight =
      ((bodySide.y + 5) * ATLAS_SIZE + bodySide.x + bodySide.w - 1) * 4;
    const sleeveYarnLight =
      ((armFront.y + 5) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveYarnShadow =
      ((armFront.y + 7) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveCuffLight =
      ((armFront.y + armFront.h - 3) * ATLAS_SIZE + armFront.x) * 4;
    const sleeveCuffShadow =
      ((armFront.y + armFront.h - 3) * ATLAS_SIZE + armFront.x + 1) * 4;
    const sleeveTopShoulder = (armTop.y * ATLAS_SIZE + armTop.x + 1) * 4;
    const sleeveTopEdge = (armTop.y * ATLAS_SIZE + armTop.x) * 4;
    const sleeveBottomCuff =
      ((armBottom.y + armBottom.h - 1) * ATLAS_SIZE + armBottom.x + 1) * 4;
    const sleeveBottomEdge =
      ((armBottom.y + armBottom.h - 1) * ATLAS_SIZE + armBottom.x) * 4;
    const rightTailPanel = (rightLegFront.y * ATLAS_SIZE + rightLegFront.x) * 4;
    const rightTailTrim =
      (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const leftTailTrim = (leftLegFront.y * ATLAS_SIZE + leftLegFront.x + 2) * 4;
    const openLegCenter =
      (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 3) * 4;
    const rightTailFoldLight =
      ((rightLegFront.y + 1) * ATLAS_SIZE + rightLegFront.x) * 4;
    const rightTailFoldShadow =
      ((rightLegFront.y + 2) * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const leftTailFoldLight =
      ((leftLegFront.y + 1) * ATLAS_SIZE + leftLegFront.x + 3) * 4;
    const leftTailFoldShadow =
      ((leftLegFront.y + 2) * ATLAS_SIZE + leftLegFront.x + 2) * 4;
    const sideTail =
      ((rightLegSide.y + 1) * ATLAS_SIZE + rightLegSide.x + 1) * 4;
    const sideTailFold =
      ((rightLegSide.y + 2) * ATLAS_SIZE + rightLegSide.x) * 4;
    const backTail = ((leftLegBack.y + 2) * ATLAS_SIZE + leftLegBack.x + 3) * 4;
    const backTailHighlight =
      ((leftLegBack.y + 1) * ATLAS_SIZE + leftLegBack.x + leftLegBack.w - 2) *
      4;

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
    expect(atlas.rgba[sidePocketLight]).toBeGreaterThan(
      atlas.rgba[sidePocketShadow],
    );
    expect(atlas.rgba[frontYarnLight + 3]).toBe(255);
    expect(atlas.rgba[frontYarnLight]).toBeGreaterThan(
      atlas.rgba[frontYarnShadow],
    );
    expect(atlas.rgba[sideYarnLight + 3]).toBe(255);
    expect(atlas.rgba[sideYarnShadow]).toBeLessThan(atlas.rgba[sideYarnLight]);
    expect(atlas.rgba[sleeveYarnLight + 3]).toBe(255);
    expect(atlas.rgba[sleeveYarnLight]).toBeGreaterThan(
      atlas.rgba[sleeveYarnShadow],
    );
    expect(atlas.rgba[sleeveCuffLight + 3]).toBe(255);
    expect(atlas.rgba[sleeveCuffLight]).toBeGreaterThan(
      atlas.rgba[sleeveCuffShadow],
    );
    expect(atlas.rgba[sleeveTopShoulder + 3]).toBe(255);
    expect(atlas.rgba[sleeveTopEdge + 3]).toBe(255);
    expect(atlas.rgba[sleeveTopShoulder]).toBeGreaterThan(
      atlas.rgba[sleeveTopEdge],
    );
    expect(atlas.rgba[sleeveBottomCuff + 3]).toBe(255);
    expect(atlas.rgba[sleeveBottomEdge + 3]).toBe(255);
    expect(atlas.rgba[sleeveBottomCuff]).toBeGreaterThan(
      atlas.rgba[sleeveBottomEdge],
    );
    expect(atlas.rgba[rightTailPanel + 3]).toBe(255);
    expect(atlas.rgba[rightTailTrim + 3]).toBe(255);
    expect(atlas.rgba[leftTailTrim + 3]).toBe(255);
    expect(atlas.rgba[openLegCenter]).not.toBe(atlas.rgba[rightTailPanel]);
    expect(atlas.rgba[rightTailTrim]).toBeLessThan(atlas.rgba[rightTailPanel]);
    expect(atlas.rgba[rightTailFoldLight]).toBeGreaterThan(
      atlas.rgba[rightTailFoldShadow],
    );
    expect(atlas.rgba[leftTailFoldLight]).toBeGreaterThan(
      atlas.rgba[leftTailFoldShadow],
    );
    expect(atlas.rgba[sideTail + 3]).toBe(255);
    expect(atlas.rgba[sideTailFold]).toBeLessThan(atlas.rgba[sideTail]);
    expect(atlas.rgba[backTail + 3]).toBe(255);
    expect(atlas.rgba[backTailHighlight]).toBeGreaterThan(atlas.rgba[backTail]);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("cardigan with neck bow keeps a large pale bow connected through top and side overlays", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      outerGarment: "cardigan",
      topType: "shirt",
      sleeveLength: "long",
      neckAccessory: "bow",
    })!.atlas;
    const body = CLASSIC_LAYOUT.body.overlay;

    const bowLeftWing =
      ((body.front.y + 2) * ATLAS_SIZE + body.front.x + 1) * 4;
    const bowRightWing =
      ((body.front.y + 2) * ATLAS_SIZE + body.front.x + 6) * 4;
    const innerShirt = ((body.front.y + 3) * ATLAS_SIZE + body.front.x + 3) * 4;
    const bowTailLight =
      ((body.front.y + 4) * ATLAS_SIZE + body.front.x + 3) * 4;
    const bowTailDark =
      ((body.front.y + 4) * ATLAS_SIZE + body.front.x + 4) * 4;
    const longTail = ((body.front.y + 6) * ATLAS_SIZE + body.front.x + 3) * 4;
    const topEdge =
      ((body.top.y + body.top.h - 1) * ATLAS_SIZE + body.top.x + 1) * 4;
    const rightSideFold =
      ((body.right.y + 2) * ATLAS_SIZE + body.right.x + 1) * 4;
    const leftSideFold =
      ((body.left.y + 2) * ATLAS_SIZE + body.left.x + body.left.w - 2) * 4;

    expect(atlas.rgba[bowLeftWing + 3]).toBe(255);
    expect(atlas.rgba[bowRightWing + 3]).toBe(255);
    expect(atlas.rgba[innerShirt + 3]).toBe(255);
    expect(atlas.rgba[bowTailLight + 3]).toBe(255);
    expect(atlas.rgba[bowTailDark + 3]).toBe(255);
    expect(atlas.rgba[longTail + 3]).toBe(255);
    expect(atlas.rgba[topEdge + 3]).toBe(255);
    expect(atlas.rgba[rightSideFold + 3]).toBe(255);
    expect(atlas.rgba[leftSideFold + 3]).toBe(255);
    expect(atlas.rgba[bowLeftWing]).toBeGreaterThan(atlas.rgba[bowRightWing]);
    expect(atlas.rgba[bowTailLight]).toBeGreaterThan(atlas.rgba[bowTailDark]);
    expect(atlas.rgba[innerShirt]).toBeGreaterThan(atlas.rgba[longTail]);
    expect(atlas.rgba[rightSideFold]).toBeGreaterThan(atlas.rgba[leftSideFold]);
  });

  it("front/back views use the actual back view", () => {
    const packed = packFrontViewToAtlas(makeFrontBackView())!;
    expect(packed.hasBackView).toBe(true);
    const back = avgOfRect(packed.atlas, CLASSIC_LAYOUT.head.base.back);
    expect(back[0]).toBeLessThan(80);
  });

  it("harmonizes generated back-view garment hue with the observed front", () => {
    const source = makeFrontBackView();
    const paint = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      color: [number, number, number],
    ) => {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          source.rgba.set([...color, 255], (y * source.width + x) * 4);
        }
      }
    };
    // Same neutral sweater was reinterpreted as saturated navy in the back view.
    paint(136, 180, 376, 330, [55, 55, 55]);
    paint(512 + 136, 180, 512 + 376, 330, [30, 55, 95]);

    const atlas = packFrontViewToAtlas(source, {
      ...DEFAULT_FACE_STYLE,
      topColor: "#373737",
      topType: "sweater",
      sleeveLength: "long",
      outerLayer: "heavy",
    })!.atlas;
    const front = avgOfRect(atlas, CLASSIC_LAYOUT.body.base.front);
    const back = avgOfRect(atlas, CLASSIC_LAYOUT.body.base.back);
    const side = avgOfRect(atlas, CLASSIC_LAYOUT.body.base.right);
    const armBack = avgOfRect(atlas, {
      ...CLASSIC_LAYOUT.rightArm.base.back,
      h: CLASSIC_LAYOUT.rightArm.base.back.h - 2,
    });
    const channelSpread = (color: number[]) =>
      Math.max(...color) - Math.min(...color);
    const distance = (a: number[], b: number[]) =>
      a.reduce((sum, value, channel) => sum + Math.abs(value - b[channel]), 0);

    expect(channelSpread(back)).toBeLessThan(24);
    expect(channelSpread(armBack)).toBeLessThan(28);
    expect(distance(front, back)).toBeLessThan(45);
    expect(distance(side, back)).toBeLessThan(48);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
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
    const pendant = ((bodyOver.y + 4) * ATLAS_SIZE + bodyOver.x + 3) * 4;
    expect(atlas.rgba[pendant]).toBeGreaterThan(170);
    expect(atlas.rgba[pendant + 2]).toBeGreaterThan(170);

    const armOver = CLASSIC_LAYOUT.rightArm.overlay.front;
    const cuffAlpha =
      atlas.rgba[
        ((armOver.y + armOver.h - 2) * ATLAS_SIZE + armOver.x) * 4 + 3
      ];
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
          colors.add(
            `${atlas.rgba[d]},${atlas.rgba[d + 1]},${atlas.rgba[d + 2]}`,
          );
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
      expression: "neutral",
    })!;
    const atlas = packed.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay.front;
    const sideRight = CLASSIC_LAYOUT.head.overlay.right;
    const sideLeft = CLASSIC_LAYOUT.head.overlay.left;
    const idx = (rect: { x: number; y: number }, x: number, y: number) =>
      ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;

    const leftEyeWindow = idx(over, 2, 4);
    const rightEyeWindow = idx(over, 5, 4);
    const leftIris = idx(face, 2, 4);
    const rightIris = idx(face, 5, 4);
    const leftScleraWindow = idx(over, 1, 4);
    const rightScleraWindow = idx(over, 6, 4);
    const leftSclera = idx(face, 1, 4);
    const smallMouthDark = idx(face, 3, 6);
    const smallMouthLight = idx(face, 4, 6);
    const smallMouthOverlay = idx(over, 4, 6);
    const cheekBlush = idx(over, 1, 5);
    const noseBridge = idx(face, 3, 4);
    const noseShadow = idx(face, 3, 5);
    const clearSkin = idx(face, 4, 4);
    const sideEar = idx(sideRight, 7, 4);
    const sideEarInner = idx(sideRight, 6, 4);
    const sideCheek = idx(sideRight, 7, 5);
    const sideJaw = idx(sideRight, 6, 6);
    const leftSideEar = idx(sideLeft, 0, 4);

    expect(atlas.rgba[leftEyeWindow + 3]).toBe(0);
    expect(atlas.rgba[rightEyeWindow + 3]).toBe(0);
    expect(atlas.rgba[leftScleraWindow + 3]).toBe(0);
    expect(atlas.rgba[rightScleraWindow + 3]).toBe(0);
    expect(atlas.rgba[leftSclera]).toBeGreaterThan(atlas.rgba[leftIris] + 50);
    expect(
      Math.abs(atlas.rgba[leftSclera + 1] - atlas.rgba[clearSkin + 1]),
    ).toBeLessThan(25);
    expect(atlas.rgba[leftIris]).toBeLessThan(atlas.rgba[clearSkin] - 50);
    expect(atlas.rgba[rightIris]).toBeLessThan(atlas.rgba[clearSkin] - 50);
    expect(atlas.rgba[cheekBlush + 3]).toBe(0);
    expect(atlas.rgba[noseShadow]).toBeLessThan(atlas.rgba[noseBridge]);
    expect(atlas.rgba[sideEar + 3]).toBe(255);
    expect(atlas.rgba[sideEarInner + 3]).toBe(255);
    expect(atlas.rgba[sideEar]).toBeLessThan(100);
    expect(atlas.rgba[sideCheek + 3]).toBe(0);
    expect(atlas.rgba[sideJaw + 3]).toBe(0);
    expect(atlas.rgba[leftSideEar + 3]).toBe(255);
    expect(atlas.rgba[smallMouthDark]).toBeLessThan(
      atlas.rgba[smallMouthLight],
    );
    expect(atlas.rgba[smallMouthOverlay + 3]).toBe(0);

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

    for (let y = 0; y < 2; y++) {
      expect(alphaAt(over.right, 7, y)).toBe(0);
      expect(alphaAt(over.left, 0, y)).toBe(0);
      expect(alphaAt(over.right, 0, y)).toBe(0);
      expect(alphaAt(over.left, 7, y)).toBe(0);
      expect(alphaAt(over.front, 0, y)).toBe(0);
      expect(alphaAt(over.front, 7, y)).toBe(0);
      expect(alphaAt(over.back, 0, y)).toBe(0);
      expect(alphaAt(over.back, 7, y)).toBe(0);
    }
    for (let y = 2; y < 5; y++) {
      expect(alphaAt(over.right, 7, y)).toBe(255);
      expect(alphaAt(over.left, 0, y)).toBe(255);
      expect(alphaAt(over.right, 0, y)).toBe(255);
      expect(alphaAt(over.left, 7, y)).toBe(255);
    }
    for (let y = 2; y < 4; y++) {
      expect(alphaAt(over.front, 0, y)).toBe(255);
      expect(alphaAt(over.front, 7, y)).toBe(255);
    }
    for (let y = 2; y < 5; y++) {
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
    expect(redAt(over.front, 0, 5)).toBe(redAt(over.right, 7, 5));
    expect(redAt(over.front, 7, 5)).toBe(redAt(over.left, 0, 5));
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
    expect(redAt(atlas, over.right, 3, 5)).not.toBe(
      redAt(atlas, over.right, 0, 5),
    );
    expect(redAt(atlas, over.left, 4, 5)).not.toBe(
      redAt(atlas, over.left, 7, 5),
    );
    expect(redAt(atlas, over.back, 6, 6)).not.toBe(
      redAt(atlas, over.back, 7, 6),
    );
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
      return [
        atlas.rgba[d],
        atlas.rgba[d + 1],
        atlas.rgba[d + 2],
        atlas.rgba[d + 3],
      ];
    };

    expect(pixel(over.top, 5, 2)[3]).toBe(255);
    expect(pixel(over.front, 1, 2)[3]).toBe(255);
    expect(pixel(over.right, 2, 1)[3]).toBe(255);
    expect(pixel(over.right, 2, 1)[0]).not.toBe(pixel(over.right, 3, 2)[0]);
    expect(pixel(over.top, 5, 2)[0]).not.toBe(pixel(over.top, 5, 3)[0]);
  });

  it("long hair completion preserves wavy side-layer highlights instead of repainting them", () => {
    const makeLongHair = (hairTexture: "straight" | "wavy") =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        bangs: "curtain",
        bangsLength: "brow",
        hairTexture,
        hairVolume: "full",
        hairBackShape: "long",
        sideHairLength: "shoulder",
      })!.atlas;
    const straight = makeLongHair("straight");
    const wavy = makeLongHair("wavy");
    const side = CLASSIC_LAYOUT.head.overlay.right;

    expect(alphaAt(wavy, side, 1, 2)).toBe(255);
    expect(redAt(wavy, side, 1, 2)).not.toBe(redAt(straight, side, 1, 2));
    expect(redAt(wavy, side, 1, 2)).toBeGreaterThan(redAt(wavy, side, 3, 4));
  });

  it("long curtain hair and a flower leave both base-layer irises visible", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      bangs: "curtain",
      bangsLength: "brow",
      hairTexture: "wavy",
      hairVolume: "full",
      hairBackShape: "long",
      sideHairLength: "shoulder",
      hairAccessory: "flower",
      hairAccessorySide: "left",
      eyeColor: "#245a8d",
      eyeSpacing: "average",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay;

    expect(alphaAt(atlas, over.front, 2, 4)).toBe(0);
    expect(alphaAt(atlas, over.front, 5, 4)).toBe(0);
    expect(redAt(atlas, face, 2, 4)).toBe(0x24);
    expect(greenAt(atlas, face, 2, 4)).toBe(0x5a);
    expect(redAt(atlas, face, 5, 4)).toBe(0x24);
    expect(greenAt(atlas, face, 5, 4)).toBe(0x5a);
    expect(alphaAt(atlas, over.front, 1, 2)).toBe(255);
    expect(alphaAt(atlas, over.right, 6, 2)).toBe(255);
  });

  it("long face-framing hair keeps a continuous cheek and jaw window below both eyes", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      faceShape: "oval",
      jawShape: "soft",
      eyeShape: "round",
      eyeTilt: "downturned",
      bangs: "curtain",
      bangsLength: "brow",
      hairTexture: "wavy",
      hairVolume: "full",
      hairBackShape: "long",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
      hairAccessory: "flower",
      hairAccessorySide: "left",
    })!.atlas;
    const overlay = CLASSIC_LAYOUT.head.overlay.front;

    for (const y of [5, 6, 7]) {
      expect(alphaAt(atlas, overlay, 1, y)).toBe(0);
      expect(alphaAt(atlas, overlay, 6, y)).toBe(0);
    }
    for (const y of [6, 7]) {
      expect(alphaAt(atlas, overlay, 2, y)).toBe(0);
      expect(alphaAt(atlas, overlay, 5, y)).toBe(0);
    }
    // Wavy outer locks frame the cheeks but step back before the jaw corners,
    // avoiding a full-height rectangular outline around the face.
    expect(alphaAt(atlas, overlay, 0, 5)).toBe(255);
    expect(alphaAt(atlas, overlay, 7, 5)).toBe(255);
    expect(alphaAt(atlas, overlay, 0, 6)).toBe(0);
    expect(alphaAt(atlas, overlay, 7, 6)).toBe(0);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
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
      return [
        atlas.rgba[d],
        atlas.rgba[d + 1],
        atlas.rgba[d + 2],
        atlas.rgba[d + 3],
      ];
    };

    expect(pixel(over.front, 3, 2)[3]).toBe(255);
    expect(pixel(over.front, 2, 3)[3]).toBe(255);
    expect(pixel(over.front, 0, 3)[0]).toBe(pixel(over.right, 7, 3)[0]);
    expect(pixel(over.front, 7, 3)[0]).toBe(pixel(over.left, 0, 3)[0]);
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
    expect(alphaAt(atlas, over.right, 4, 4)).toBe(255);
    expect(alphaAt(atlas, over.right, 5, 4)).toBe(255);
    expect(alphaAt(atlas, over.right, 6, 4)).toBe(255);
    expect(alphaAt(atlas, over.right, 7, 4)).toBe(255);
    expect(alphaAt(atlas, over.right, 4, 5)).toBe(255);
    expect(alphaAt(atlas, over.right, 5, 5)).toBe(255);
    expect(alphaAt(atlas, over.left, 7, 4)).toBe(255);
    expect(alphaAt(atlas, over.left, 0, 4)).toBe(255);
    expect(alphaAt(atlas, over.left, 1, 4)).toBe(255);
    expect(alphaAt(atlas, over.left, 2, 4)).toBe(255);
    expect(alphaAt(atlas, over.left, 3, 4)).toBe(255);
    expect(alphaAt(atlas, over.left, 2, 5)).toBe(255);
    expect(alphaAt(atlas, over.left, 3, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 0, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 1, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 6, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 7, 5)).toBe(255);
    expect(alphaAt(atlas, over.top, 1, 6)).toBe(255);
    expect(alphaAt(atlas, over.top, 6, 6)).toBe(255);
    expect(alphaAt(atlas, over.back, 7, 3)).toBe(255);
    expect(alphaAt(atlas, over.back, 0, 3)).toBe(255);
    expect(alphaAt(atlas, over.back, 7, 4)).toBe(255);
    expect(alphaAt(atlas, over.back, 0, 4)).toBe(255);
    expect(alphaAt(atlas, over.back, 7, 5)).toBe(255);
    expect(alphaAt(atlas, over.back, 0, 5)).toBe(255);
    expect(redAt(atlas, over.front, 0, 4)).toBe(redAt(atlas, over.right, 7, 4));
    expect(redAt(atlas, over.front, 7, 4)).toBe(redAt(atlas, over.left, 0, 4));
    expect(redAt(atlas, over.right, 6, 4)).toBeLessThanOrEqual(
      redAt(atlas, over.right, 7, 4),
    );
    expect(redAt(atlas, over.right, 4, 4)).toBeLessThan(
      redAt(atlas, over.right, 6, 4),
    );
    expect(redAt(atlas, over.left, 3, 4)).toBeLessThan(
      redAt(atlas, over.left, 1, 4),
    );
  });

  it("centre-parted rounded short hair keeps a split fringe, readable eyes and deeper side volume", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "straight",
      bangsLength: "brow",
      hairTexture: "straight",
      hairVolume: "normal",
      hairSilhouette: "rounded",
      hairBackShape: "tapered",
      hairPart: "center",
      sideHairLength: "short",
      eyeShape: "almond",
      eyeSpacing: "average",
      glasses: "none",
    })!.atlas;
    const base = CLASSIC_LAYOUT.head.base;
    const over = CLASSIC_LAYOUT.head.overlay;

    // A visible centre part is expressed with hair-tone contrast, not an
    // unrealistic vertical strip of exposed scalp.
    expect(redAt(atlas, base.front, 3, 2)).toBeLessThan(
      redAt(atlas, base.front, 3, 4) - 50,
    );
    expect(redAt(atlas, base.front, 4, 2)).toBeLessThan(
      redAt(atlas, base.front, 4, 4) - 50,
    );
    expect(alphaAt(atlas, over.front, 3, 2)).toBe(255);
    expect(alphaAt(atlas, over.front, 4, 2)).toBe(255);
    expect(redAt(atlas, over.front, 3, 2)).not.toBe(
      redAt(atlas, over.front, 4, 2),
    );
    // Both pixels of each eye reveal the structured base face.
    for (const x of [1, 2, 5, 6]) {
      expect(alphaAt(atlas, over.front, x, 4)).toBe(0);
    }
    // Rounded brow-length short cuts receive one extra side/back volume row.
    expect(alphaAt(atlas, over.right, 0, 3)).toBe(255);
    expect(alphaAt(atlas, over.left, 7, 3)).toBe(255);
    expect(alphaAt(atlas, over.back, 0, 4)).toBe(255);
    expect(alphaAt(atlas, over.back, 7, 4)).toBe(255);
    expect(redAt(atlas, over.front, 3, 1)).not.toBe(
      redAt(atlas, over.front, 4, 1),
    );
    expect(alphaAt(atlas, over.front, 0, 7)).toBe(0);
    expect(alphaAt(atlas, over.front, 3, 7)).toBe(0);
    // Outer cut-outs reveal a hair-filled base top, while the lower side and
    // back edges taper into skin instead of forming a rectangular helmet.
    expect(redAt(atlas, base.top, 3, 3)).toBeLessThan(
      redAt(atlas, base.front, 3, 4) - 50,
    );
    expect(redAt(atlas, base.right, 3, 3)).toBeGreaterThan(
      redAt(atlas, base.right, 0, 3) + 50,
    );
    expect(redAt(atlas, base.back, 0, 4)).toBeGreaterThan(
      redAt(atlas, base.back, 3, 4) + 50,
    );

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("rounded short hair uses connected crown and temple shade clusters", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      hairColor: "#101010",
      skinTone: "#d0a078",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "staggered",
      hairTexture: "straight",
      hairVolume: "normal",
      hairSilhouette: "rounded",
      hairBackShape: "tapered",
      hairPart: "center",
      sideHairLength: "short",
      sideHairShape: "ear_hugging",
      earExposure: "partial",
      eyeShape: "almond",
      eyeSpacing: "average",
      glasses: "none",
      hairAccessory: "none",
    })!.atlas;
    const head = CLASSIC_LAYOUT.head;

    expect(alphaAt(atlas, head.overlay.top, 0, 0)).toBe(0);
    expect(alphaAt(atlas, head.overlay.front, 0, 0)).toBe(0);
    expect(redAt(atlas, head.overlay.top, 2, 1)).toBeGreaterThan(
      redAt(atlas, head.overlay.top, 5, 3),
    );
    expect(redAt(atlas, head.overlay.right, 6, 2)).not.toBe(
      redAt(atlas, head.overlay.right, 7, 2),
    );
    expect(rgbaAt(atlas, head.overlay.front, 0, 2)).toEqual(
      rgbaAt(atlas, head.overlay.right, 7, 2),
    );
    expect(rgbaAt(atlas, head.overlay.front, 7, 3)).toEqual(
      rgbaAt(atlas, head.overlay.left, 0, 3),
    );
    expect(rgbaAt(atlas, head.overlay.back, 7, 2)).toEqual(
      rgbaAt(atlas, head.overlay.right, 0, 2),
    );
    expect(rgbaAt(atlas, head.overlay.back, 0, 3)).toEqual(
      rgbaAt(atlas, head.overlay.left, 7, 3),
    );
    for (const x of [1, 2, 5, 6]) {
      expect(alphaAt(atlas, head.overlay.front, x, 4)).toBe(0);
    }
    const leftSclera = rgbaAt(atlas, head.base.front, 1, 4);
    const leftIris = rgbaAt(atlas, head.base.front, 2, 4);
    const cheek = rgbaAt(atlas, head.base.front, 0, 4);
    expect(leftSclera[0]).toBeGreaterThan(cheek[0] + 8);
    expect(leftSclera[0]).toBeGreaterThan(leftIris[0] + 100);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("left-parted brow-length straight bangs keep irregular tip gaps instead of a solid bar", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "straight",
      bangsLength: "brow",
      hairPart: "left",
      hairSilhouette: "rounded",
      sideHairLength: "short",
    })!.atlas;
    const over = CLASSIC_LAYOUT.head.overlay.front;
    const base = CLASSIC_LAYOUT.head.base.front;

    for (const x of [0, 2, 3, 6, 7]) {
      expect(alphaAt(atlas, over, x, 3)).toBe(255);
    }
    expect(alphaAt(atlas, over, 4, 3)).toBe(0);
    expect(alphaAt(atlas, over, 5, 3)).toBe(0);
    expect(redAt(atlas, over, 2, 3)).not.toBe(redAt(atlas, over, 3, 3));
    expect(redAt(atlas, base, 5, 3)).toBeGreaterThan(
      redAt(atlas, over, 6, 3) + 50,
    );

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("dense blunt fringe keeps natural gaps and partially exposed ears stay tapered", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "blunt",
      hairPart: "left",
      hairSilhouette: "rounded",
      hairBackShape: "tapered",
      sideHairLength: "short",
      sideHairShape: "ear_hugging",
      earExposure: "partial",
    })!.atlas;
    const head = CLASSIC_LAYOUT.head;

    for (const x of [0, 1, 3, 4, 6, 7]) {
      expect(alphaAt(atlas, head.overlay.front, x, 3)).toBe(255);
    }
    expect(alphaAt(atlas, head.overlay.front, 2, 3)).toBe(0);
    expect(alphaAt(atlas, head.overlay.front, 5, 3)).toBe(0);
    for (const rect of [head.overlay.right, head.overlay.left]) {
      expect(alphaAt(atlas, rect, 2, 3)).toBe(255);
      expect(alphaAt(atlas, rect, 5, 3)).toBe(255);
      expect(alphaAt(atlas, rect, 0, 4)).toBe(255);
      expect(alphaAt(atlas, rect, 7, 4)).toBe(255);
      for (const x of [1, 2, 3, 4, 5, 6])
        expect(alphaAt(atlas, rect, x, 4)).toBe(0);
      expect(alphaAt(atlas, rect, 3, 5)).toBe(0);
    }
    // The tapered nape may continue one row below the exposed ear, but only
    // on each side face's physical back edge.
    expect(alphaAt(atlas, head.overlay.right, 0, 5)).toBe(255);
    expect(alphaAt(atlas, head.overlay.right, 7, 5)).toBe(0);
    expect(alphaAt(atlas, head.overlay.left, 0, 5)).toBe(0);
    expect(alphaAt(atlas, head.overlay.left, 7, 5)).toBe(255);

    for (let y = 0; y < 8; y++) {
      expect(rgbaAt(atlas, head.overlay.front, 0, y)).toEqual(
        rgbaAt(atlas, head.overlay.right, 7, y),
      );
      expect(rgbaAt(atlas, head.overlay.front, 7, y)).toEqual(
        rgbaAt(atlas, head.overlay.left, 0, y),
      );
      expect(rgbaAt(atlas, head.overlay.back, 7, y)).toEqual(
        rgbaAt(atlas, head.overlay.right, 0, y),
      );
      expect(rgbaAt(atlas, head.overlay.back, 0, y)).toEqual(
        rgbaAt(atlas, head.overlay.left, 7, y),
      );
    }
    expect(redAt(atlas, head.base.right, 3, 2)).toBeGreaterThan(
      redAt(atlas, head.base.right, 2, 2) + 50,
    );
    expect(redAt(atlas, head.base.right, 3, 3)).toBeGreaterThan(
      redAt(atlas, head.base.right, 1, 3) + 50,
    );
    expect(redAt(atlas, head.base.left, 4, 3)).toBeGreaterThan(
      redAt(atlas, head.base.left, 6, 3) + 50,
    );
    // Temple hair must descend continuously to the ear bracket. A one-row
    // skin gap here makes the front fringe and side layer look disconnected
    // in exact side views even though the UV seam itself is colour-matched.
    for (const rect of [head.base.right, head.base.left]) {
      for (const x of [2, 5]) {
        expect(redAt(atlas, rect, x, 2)).toBeLessThan(
          redAt(atlas, rect, 3, 4) - 50,
        );
        expect(redAt(atlas, rect, x, 3)).toBeLessThan(
          redAt(atlas, rect, 3, 4) - 50,
        );
        expect(redAt(atlas, rect, x, 4)).toBeLessThan(
          redAt(atlas, rect, 3, 4) - 50,
        );
      }
    }
    // The base layer wraps around a two-pixel ear window instead of exposing
    // a broad rectangular side of the head under the second-layer hair cap.
    expect(redAt(atlas, head.base.right, 2, 4)).toBeLessThan(
      redAt(atlas, head.base.right, 3, 4) - 50,
    );
    expect(redAt(atlas, head.base.right, 5, 4)).toBeLessThan(
      redAt(atlas, head.base.right, 4, 4) - 50,
    );
    expect(redAt(atlas, head.base.left, 2, 4)).toBeLessThan(
      redAt(atlas, head.base.left, 3, 4) - 50,
    );
    expect(redAt(atlas, head.base.left, 5, 4)).toBeLessThan(
      redAt(atlas, head.base.left, 4, 4) - 50,
    );
    expect(
      Math.abs(
        redAt(atlas, head.base.right, 3, 4) -
          redAt(atlas, head.base.right, 4, 4),
      ),
    ).toBeGreaterThan(5);
    expect(
      Math.abs(
        redAt(atlas, head.base.left, 3, 4) - redAt(atlas, head.base.left, 4, 4),
      ),
    ).toBeGreaterThan(5);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("portrait-inferred tapered sides narrow across both layers and keep every physical seam connected", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "blunt",
      fringeOpening: "center",
      hairTexture: "straight",
      hairVolume: "normal",
      hairSilhouette: "rounded",
      hairBackShape: "tapered",
      hairPart: "left",
      sideHairLength: "short",
      sideHairShape: "tapered",
      sideHairAsymmetry: "none",
      earExposure: "partial",
    })!.atlas;
    const head = CLASSIC_LAYOUT.head;

    // The inner cube narrows before the ear instead of revealing a solid
    // rectangular cap through the transparent second-layer profile.
    for (const rect of [head.base.right, head.base.left]) {
      expect(redAt(atlas, rect, 2, 2)).toBeLessThan(
        redAt(atlas, rect, 3, 2) - 50,
      );
      expect(redAt(atlas, rect, 1, 3)).toBeLessThan(
        redAt(atlas, rect, 3, 3) - 50,
      );
      expect(redAt(atlas, rect, 0, 4)).toBeLessThan(
        redAt(atlas, rect, 3, 4) - 50,
      );
    }

    // The outer cube steps from temple width to two edge locks, leaving the
    // centre of the ear visible in an exact side view.
    for (const rect of [head.overlay.right, head.overlay.left]) {
      expect(alphaAt(atlas, rect, 2, 2)).toBe(255);
      expect(alphaAt(atlas, rect, 3, 2)).toBe(0);
      expect(alphaAt(atlas, rect, 1, 3)).toBe(255);
      expect(alphaAt(atlas, rect, 2, 3)).toBe(0);
      expect(alphaAt(atlas, rect, 3, 4)).toBe(0);
      expect(alphaAt(atlas, rect, 4, 4)).toBe(0);
    }

    // Front/side/back joins use the physical Minecraft UV neighbours, so the
    // tapered silhouette cannot break when the preview rotates.
    for (let y = 0; y < 8; y++) {
      expect(rgbaAt(atlas, head.overlay.front, 0, y)).toEqual(
        rgbaAt(atlas, head.overlay.right, 7, y),
      );
      expect(rgbaAt(atlas, head.overlay.front, 7, y)).toEqual(
        rgbaAt(atlas, head.overlay.left, 0, y),
      );
      expect(rgbaAt(atlas, head.overlay.back, 7, y)).toEqual(
        rgbaAt(atlas, head.overlay.right, 0, y),
      );
      expect(rgbaAt(atlas, head.overlay.back, 0, y)).toEqual(
        rgbaAt(atlas, head.overlay.left, 7, y),
      );
    }
    expect(alphaAt(atlas, head.overlay.front, 3, 2)).toBe(0);
    expect(alphaAt(atlas, head.overlay.front, 3, 3)).toBe(0);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("fringeOpening cuts a real forehead gap through both base and outer hair layers", () => {
    const shared: FaceStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "blunt",
      hairPart: "left",
      hairSilhouette: "rounded",
      sideHairLength: "short",
    };
    const closed = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      fringeOpening: "none",
    })!.atlas;
    const opened = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      fringeOpening: "left",
    })!.atlas;
    const base = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay.front;

    expect(alphaAt(closed, over, 2, 2)).toBe(255);
    expect(alphaAt(opened, over, 2, 2)).toBe(0);
    expect(alphaAt(opened, over, 2, 3)).toBe(0);
    expect(alphaAt(opened, over, 5, 2)).toBe(255);
    expect(redAt(opened, base, 2, 2)).toBeGreaterThan(
      redAt(closed, base, 2, 2) + 80,
    );

    applyUvMask(opened);
    expect(validateFinalAtlas(opened).ok).toBe(true);
  });

  it("bangsLength=eye keeps long fringe around two visible iris windows", () => {
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

    expect(alphaAt(2, 4)).toBe(0);
    expect(alphaAt(5, 4)).toBe(0);
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
      return [
        atlas.rgba[d],
        atlas.rgba[d + 1],
        atlas.rgba[d + 2],
        atlas.rgba[d + 3],
      ];
    };

    expect(pixel(rounded, over.top, 2, 0)[3]).toBe(255);
    expect(pixel(rounded, over.right, 1, 1)[3]).toBe(255);
    expect(pixel(rounded, over.front, 0, 0)[3]).toBe(0);
    expect(pixel(rounded, over.front, 7, 0)[3]).toBe(0);
    expect(pixel(rounded, over.right, 0, 0)[3]).toBe(0);
    expect(pixel(rounded, over.left, 7, 0)[3]).toBe(0);
    expect(pixel(rounded, over.top, 0, 0)[3]).toBe(0);
    expect(pixel(rounded, over.top, 7, 7)[3]).toBe(0);
    expect(pixel(swept, over.top, 6, 4)[3]).toBe(255);
    expect(pixel(swept, over.front, 3, 2)[3]).toBe(255);
    expect(pixel(swept, over.top, 6, 4)[0]).not.toBe(
      pixel(rounded, over.top, 6, 4)[0],
    );
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
      return [
        atlas.rgba[d],
        atlas.rgba[d + 1],
        atlas.rgba[d + 2],
        atlas.rgba[d + 3],
      ];
    };

    expect(pixel(longBack, over.back, 3, 7)[3]).toBe(255);
    expect(pixel(longBack, over.back, 0, 5)[0]).toBe(
      pixel(longBack, over.left, 7, 5)[0],
    );
    expect(pixel(longBack, over.back, 7, 5)[0]).toBe(
      pixel(longBack, over.right, 0, 5)[0],
    );
    expect(pixel(tiedBack, over.back, 3, 6)[3]).toBe(255);
    expect(pixel(tiedBack, over.back, 3, 6)[0]).not.toBe(
      pixel(longBack, over.back, 3, 6)[0],
    );
  });

  it("anchors a generated long-hair back view to the analysed hair hue", () => {
    const atlas = packFrontViewToAtlas(
      makeFourViewSheet(),
      {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        hairColor: "#765b57",
        hairBackShape: "long",
        overallHairLength: "waist",
        sideHairLength: "shoulder",
        sideHairShape: "face_framing",
      },
      4,
    )!.atlas;
    const [red, green, blue] = avgOfRect(atlas, CLASSIC_LAYOUT.head.base.back);

    expect(red - blue).toBeGreaterThan(15);
    expect(Math.abs(green - blue)).toBeLessThan(18);
    expect(red).toBeGreaterThan(green);
  });

  it("long inferred back hair continues onto torso overlay even when side hair is jaw length", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "medium",
      bangs: "curtain",
      hairTexture: "wavy",
      hairBackShape: "long",
      sideHairLength: "jaw",
    })!.atlas;
    const head = CLASSIC_LAYOUT.head.overlay;
    const body = CLASSIC_LAYOUT.body.overlay;

    expect(alphaAt(atlas, head.back, 3, 7)).toBe(255);
    expect(alphaAt(atlas, body.back, 2, 1)).toBe(255);
    expect(alphaAt(atlas, body.back, 3, 5)).toBe(255);
    expect(alphaAt(atlas, body.right, 0, 4)).toBe(255);
    expect(alphaAt(atlas, body.left, body.left.w - 1, 4)).toBe(255);
    expect(alphaAt(atlas, body.front, 0, 3)).toBe(255);
    expect(alphaAt(atlas, body.front, 7, 3)).toBe(255);
    expect(redAt(atlas, body.back, 2, 1)).toBeGreaterThan(
      redAt(atlas, body.back, 3, 5),
    );
    expect(redAt(atlas, body.right, 1, 2)).toBeGreaterThan(
      redAt(atlas, body.right, 0, 4),
    );
    expect(redAt(atlas, body.left, body.left.w - 2, 2)).toBeGreaterThan(
      redAt(atlas, body.left, body.left.w - 1, 4),
    );
  });

  it("overallHairLength gives shoulder, chest, waist and hip hair distinct connected endpoints", () => {
    const makeLength = (
      overallHairLength: NonNullable<FaceStyle["overallHairLength"]>,
    ) =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        hairColor: "#765b57",
        bangs: "curtain",
        hairTexture: "wavy",
        hairBackShape: "long",
        overallHairLength,
        sideHairLength: "shoulder",
        sideHairShape: "face_framing",
        outerLayer: "none",
        outerGarment: "none",
      })!.atlas;
    const shoulder = makeLength("shoulder");
    const chest = makeLength("chest");
    const waist = makeLength("waist");
    const hip = makeLength("hip");
    const body = CLASSIC_LAYOUT.body.overlay;
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay;
    const leftLeg = CLASSIC_LAYOUT.leftLeg.overlay;

    expect(alphaAt(shoulder, body.front, 1, 3)).toBe(255);
    expect(alphaAt(shoulder, body.front, 0, 6)).toBe(0);
    expect(alphaAt(chest, body.front, 1, 7)).toBe(255);
    expect(alphaAt(chest, body.front, 1, 9)).toBe(0);
    expect(alphaAt(waist, body.front, 3, 11)).toBe(255);
    expect(alphaAt(waist, body.back, 4, 11)).toBe(255);
    expect(alphaAt(waist, rightLeg.back, 2, 3)).toBe(0);
    expect(alphaAt(waist, leftLeg.back, 1, 3)).toBe(0);
    expect(alphaAt(hip, rightLeg.back, 2, 3)).toBe(255);
    expect(alphaAt(hip, leftLeg.back, 1, 3)).toBe(255);
    expect(alphaAt(hip, rightLeg.right, 0, 2)).toBe(255);
    expect(alphaAt(hip, leftLeg.left, 0, 2)).toBe(255);
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
    expect(redAt(atlas, head.right, 1, 2)).toBeGreaterThan(
      redAt(atlas, head.right, 3, 7),
    );
    expect(redAt(atlas, head.left, 6, 2)).toBeGreaterThan(
      redAt(atlas, head.left, 4, 7),
    );
    expect(alphaAt(atlas, body.front, 0, 6)).toBe(255);
    expect(alphaAt(atlas, body.front, 7, 6)).toBe(255);
    expect(alphaAt(atlas, body.front, 1, 7)).toBe(255);
    expect(alphaAt(atlas, body.front, 6, 7)).toBe(255);
    expect(alphaAt(atlas, body.front, 2, 8)).toBe(255);
    expect(alphaAt(atlas, body.front, 5, 8)).toBe(255);
    expect(alphaAt(atlas, body.right, 1, 5)).toBe(255);
    expect(alphaAt(atlas, body.left, 2, 5)).toBe(255);
    expect(alphaAt(atlas, body.right, 0, 7)).toBe(255);
    expect(alphaAt(atlas, body.left, body.left.w - 1, 7)).toBe(255);
    expect(alphaAt(atlas, body.top, 0, body.top.h - 1)).toBe(255);
    expect(alphaAt(atlas, body.top, 7, body.top.h - 1)).toBe(255);
    expect(alphaAt(atlas, body.top, 1, body.top.h - 1)).toBe(255);
    expect(alphaAt(atlas, body.back, 3, 7)).toBe(255);
    expect(alphaAt(atlas, body.back, 4, 7)).toBe(255);
    expect(redAt(atlas, body.front, 0, 6)).not.toBe(
      redAt(atlas, body.front, 3, 6),
    );
    expect(alphaAt(atlas, body.front, 1, 2)).toBe(255);
    expect(alphaAt(atlas, body.front, 1, 5)).toBe(0);
    expect(alphaAt(atlas, body.front, 7, 6)).toBe(255);
    expect(redAt(atlas, body.front, 1, 2)).toBeGreaterThan(
      redAt(atlas, body.front, 2, 8),
    );
    expect(
      Math.abs(
        redAt(atlas, body.front, 6, 2) -
          redAt(atlas, body.front, 5, 8),
      ),
    ).toBeLessThan(20);
    expect(alphaAt(atlas, body.right, 1, 3)).toBe(255);
    expect(alphaAt(atlas, body.left, 2, 3)).toBe(255);
    expect(redAt(atlas, body.back, 2, 4)).toBeGreaterThan(
      redAt(atlas, body.back, 4, 7),
    );
    expect(alphaAt(atlas, rightArm.front, 0, 5)).toBe(255);
    expect(alphaAt(atlas, rightArm.front, rightArm.front.w - 1, 1)).toBe(255);
    expect(alphaAt(atlas, rightArm.right, 1, 3)).toBe(255);
    expect(alphaAt(atlas, rightArm.top, 0, 1)).toBe(255);
    expect(alphaAt(atlas, leftArm.front, leftArm.front.w - 1, 5)).toBe(255);
    expect(alphaAt(atlas, leftArm.front, 0, 1)).toBe(255);
    expect(alphaAt(atlas, leftArm.left, 1, 3)).toBe(255);
    expect(alphaAt(atlas, leftArm.top, leftArm.top.w - 1, 1)).toBe(255);
    expect(redAt(atlas, rightArm.front, 0, 0)).toBeGreaterThan(
      redAt(atlas, rightArm.front, 0, 5),
    );
    expect(redAt(atlas, leftArm.front, leftArm.front.w - 1, 0)).toBeGreaterThan(
      redAt(atlas, leftArm.front, leftArm.front.w - 1, 5),
    );
    for (let y = 0; y < 10; y++) {
      const rightRow = [0, 1].filter(
        (x) => alphaAt(atlas, body.right, x, y) === 255,
      );
      const leftRow = [body.left.w - 2, body.left.w - 1].filter(
        (x) => alphaAt(atlas, body.left, x, y) === 255,
      );
      expect(rightRow.length).toBeGreaterThanOrEqual(1);
      expect(leftRow.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("wavy front drapes offset one lock instead of mirroring two rigid columns", () => {
    const makeTexture = (hairTexture: "straight" | "wavy") =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        hairColor: "#765b57",
        bangs: "curtain",
        hairTexture,
        hairSilhouette: hairTexture === "wavy" ? "tousled" : "rounded",
        hairBackShape: "long",
        overallHairLength: "waist",
        sideHairLength: "shoulder",
        sideHairShape: "face_framing",
        outerLayer: "none",
        outerGarment: "none",
        topType: "tshirt",
      })!.atlas;
    const straight = makeTexture("straight");
    const wavy = makeTexture("wavy");
    const front = CLASSIC_LAYOUT.body.overlay.front;

    expect(alphaAt(straight, front, 1, 4)).toBe(255);
    expect(alphaAt(straight, front, 6, 4)).toBe(255);

    expect(alphaAt(wavy, front, 1, 4)).toBe(255);
    expect(alphaAt(wavy, front, 6, 4)).toBe(0);
    expect(alphaAt(wavy, front, 7, 4)).toBe(255);
    expect(rgbaAt(wavy, front, 1, 4)).not.toEqual(rgbaAt(wavy, front, 7, 4));
    // Tapered waist-length locks should retain their brown hue instead of
    // collapsing into near-black vertical rods against pale garments.
    expect(redAt(wavy, front, 3, 11)).toBeGreaterThan(50);
    expect(redAt(wavy, front, 4, 11)).toBeGreaterThan(50);
  });

  it("shoulder hair drapes down arm side faces without checkerboard gaps", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      hairColor: "#765b57",
      bangs: "curtain",
      hairTexture: "wavy",
      hairVolume: "full",
      hairBackShape: "long",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
    })!.atlas;
    const sideFaces = [
      CLASSIC_LAYOUT.rightArm.overlay.right,
      CLASSIC_LAYOUT.leftArm.overlay.left,
    ];

    for (const side of sideFaces) {
      for (let y = 0; y <= 5; y++) {
        expect(alphaAt(atlas, side, 0, y)).toBe(255);
      }
      for (let y = 0; y <= 3; y++) {
        expect(alphaAt(atlas, side, 1, y)).toBe(255);
      }
      for (let y = 4; y <= 5; y++) {
        expect(alphaAt(atlas, side, 1, y)).toBe(0);
      }
    }
    const bodySides = [
      CLASSIC_LAYOUT.body.overlay.right,
      CLASSIC_LAYOUT.body.overlay.left,
    ];
    const headSides = [
      CLASSIC_LAYOUT.head.overlay.right,
      CLASSIC_LAYOUT.head.overlay.left,
    ];
    for (let sideIndex = 0; sideIndex < sideFaces.length; sideIndex++) {
      const bodyX = sideIndex === 0 ? 0 : bodySides[sideIndex].w - 1;
      const headX = sideIndex === 0 ? 0 : headSides[sideIndex].w - 1;
      const shoulderToArmDelta = Math.abs(
        redAt(atlas, bodySides[sideIndex], bodyX, 5) -
          redAt(atlas, sideFaces[sideIndex], 0, 5),
      );
      const headToShoulderDelta = Math.abs(
        redAt(atlas, headSides[sideIndex], headX, 7) -
          redAt(atlas, bodySides[sideIndex], bodyX, 0),
      );
      expect(shoulderToArmDelta).toBeLessThan(20);
      expect(headToShoulderDelta).toBeLessThan(25);
      expect(redAt(atlas, sideFaces[sideIndex], 0, 5)).toBeGreaterThan(65);
    }

    const rightFront = CLASSIC_LAYOUT.rightArm.overlay.front;
    const leftFront = CLASSIC_LAYOUT.leftArm.overlay.front;
    const rightOuter = rightFront.w - 1;

    for (const y of [0, 1, 2]) {
      expect(alphaAt(atlas, rightFront, rightOuter, y)).toBe(255);
    }
    for (const y of [3, 4, 5]) {
      expect(alphaAt(atlas, rightFront, rightOuter, y)).toBe(0);
    }
    for (const y of [0, 1, 3]) {
      expect(alphaAt(atlas, leftFront, 0, y)).toBe(255);
    }
    for (const y of [2, 4, 5]) {
      expect(alphaAt(atlas, leftFront, 0, y)).toBe(0);
    }
  });

  it("sideHairAsymmetry keeps the named viewer-side lock longer across head and shoulder layers", () => {
    const makeAsymmetric = (sideHairAsymmetry: "left" | "right") =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        bangs: "curtain",
        hairTexture: "wavy",
        hairBackShape: "rounded",
        sideHairLength: "shoulder",
        sideHairAsymmetry,
        outerLayer: "none",
        outerGarment: "none",
      })!.atlas;
    const leftLonger = makeAsymmetric("left");
    const rightLonger = makeAsymmetric("right");
    const head = CLASSIC_LAYOUT.head.overlay;
    const body = CLASSIC_LAYOUT.body.overlay;

    // Viewer-left maps to the head/body right UV face and front x=0 edge.
    expect(alphaAt(leftLonger, head.right, 3, 7)).toBe(255);
    expect(alphaAt(leftLonger, head.left, 3, 7)).toBe(0);
    expect(alphaAt(leftLonger, body.front, 0, 6)).toBe(255);
    expect(alphaAt(leftLonger, body.front, 7, 6)).toBe(0);
    expect(alphaAt(leftLonger, body.right, 0, 6)).toBe(255);
    expect(alphaAt(leftLonger, body.left, body.left.w - 1, 6)).toBe(0);

    expect(alphaAt(rightLonger, head.right, 3, 7)).toBe(0);
    expect(alphaAt(rightLonger, head.left, 3, 7)).toBe(255);
    expect(alphaAt(rightLonger, body.front, 0, 6)).toBe(0);
    expect(alphaAt(rightLonger, body.front, 7, 6)).toBe(255);
    expect(alphaAt(rightLonger, body.right, 0, 6)).toBe(0);
    expect(alphaAt(rightLonger, body.left, body.left.w - 1, 6)).toBe(255);

    applyUvMask(leftLonger);
    applyUvMask(rightLonger);
    expect(validateFinalAtlas(leftLonger).ok).toBe(true);
    expect(validateFinalAtlas(rightLonger).ok).toBe(true);
  });

  it("long back hair keeps a bilateral shoulder rail when one face-framing lock is shorter", () => {
    const makeAsymmetric = (sideHairAsymmetry: "left" | "right") =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        bangs: "curtain",
        hairTexture: "wavy",
        hairBackShape: "long",
        sideHairLength: "shoulder",
        sideHairAsymmetry,
        outerLayer: "none",
        outerGarment: "none",
      })!.atlas;
    const leftLonger = makeAsymmetric("left");
    const rightLonger = makeAsymmetric("right");
    const body = CLASSIC_LAYOUT.body.overlay;
    const rightArm = CLASSIC_LAYOUT.rightArm.overlay;
    const leftArm = CLASSIC_LAYOUT.leftArm.overlay;

    // Long back hair still reaches both shoulders, while the shorter side
    // loses its inner/lower pixels and bottom arm tip.
    expect(alphaAt(leftLonger, body.front, 0, 6)).toBe(255);
    expect(alphaAt(leftLonger, body.front, 7, 6)).toBe(255);
    expect(alphaAt(leftLonger, body.front, 6, 6)).toBe(0);
    expect(alphaAt(leftLonger, body.right, 0, 6)).toBe(255);
    expect(alphaAt(leftLonger, body.left, body.left.w - 1, 6)).toBe(255);
    expect(alphaAt(leftLonger, body.left, body.left.w - 2, 6)).toBe(0);
    expect(alphaAt(leftLonger, body.back, 0, 6)).toBe(255);
    expect(alphaAt(leftLonger, body.back, 1, 6)).toBe(0);
    expect(alphaAt(leftLonger, rightArm.front, 0, 5)).toBe(255);
    expect(alphaAt(leftLonger, leftArm.front, leftArm.front.w - 1, 5)).toBe(0);

    expect(alphaAt(rightLonger, body.front, 0, 6)).toBe(255);
    expect(alphaAt(rightLonger, body.front, 7, 6)).toBe(255);
    expect(alphaAt(rightLonger, body.front, 1, 6)).toBe(0);
    expect(alphaAt(rightLonger, body.right, 0, 6)).toBe(255);
    expect(alphaAt(rightLonger, body.left, body.left.w - 1, 6)).toBe(255);
    expect(alphaAt(rightLonger, body.right, 1, 6)).toBe(0);
    expect(alphaAt(rightLonger, body.back, 7, 6)).toBe(255);
    expect(alphaAt(rightLonger, body.back, 6, 6)).toBe(0);
    expect(alphaAt(rightLonger, rightArm.front, 0, 5)).toBe(0);
    expect(alphaAt(rightLonger, leftArm.front, leftArm.front.w - 1, 5)).toBe(
      255,
    );

    applyUvMask(leftLonger);
    applyUvMask(rightLonger);
    expect(validateFinalAtlas(leftLonger).ok).toBe(true);
    expect(validateFinalAtlas(rightLonger).ok).toBe(true);
  });

  it("keeps flower colours on the head while shoulder drapes remain hair-coloured", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      hairColor: "#765b57",
      bangs: "curtain",
      hairTexture: "wavy",
      hairBackShape: "long",
      sideHairLength: "shoulder",
      hairAccessory: "flower",
      hairAccessorySide: "left",
      hairAccessoryColor: "pink",
    })!.atlas;
    const head = CLASSIC_LAYOUT.head.overlay;
    const body = CLASSIC_LAYOUT.body.overlay;
    const arm = CLASSIC_LAYOUT.rightArm.overlay;

    expect(alphaAt(atlas, body.front, 1, 7)).toBe(255);
    expect(alphaAt(atlas, body.front, 1, 1)).toBe(255);
    expect(alphaAt(atlas, body.right, 0, 1)).toBe(255);
    expect(alphaAt(atlas, body.right, 1, 3)).toBe(255);
    expect(alphaAt(atlas, body.top, 0, body.top.h - 1)).toBe(255);
    expect(alphaAt(atlas, body.top, 1, body.top.h - 1)).toBe(255);
    expect(alphaAt(atlas, arm.front, 0, 1)).toBe(255);
    expect(alphaAt(atlas, arm.right, 1, 2)).toBe(255);
    expect(alphaAt(atlas, arm.top, 0, 1)).toBe(255);
    expect(alphaAt(atlas, arm.top, arm.top.w - 1, 2)).toBe(255);

    // The flower still crosses the head front/side seam.
    expect(greenAt(atlas, head.right, 5, 4)).toBeGreaterThan(
      redAt(atlas, head.right, 5, 4),
    );
    // Its leaf/petal colours must not leak onto the cardigan shoulder.
    for (const [rect, x, y] of [
      [body.front, 1, 1],
      [body.right, 1, 3],
      [arm.front, 0, 1],
      [arm.right, 1, 2],
    ] as const) {
      const [red, green, blue] = rgbaAt(atlas, rect, x, y);
      expect(red).toBeGreaterThan(green);
      expect(red).toBeGreaterThan(blue);
    }
  });

  it("long face-framing hair leaves a side-profile window inside sparse outer locks", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      hairTexture: "wavy",
      hairVolume: "full",
      hairSilhouette: "tousled",
      hairBackShape: "long",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
      earExposure: "covered",
      hairAccessory: "none",
    })!.atlas;
    const head = CLASSIC_LAYOUT.head;

    expect(redAt(atlas, head.base.right, 4, 4)).toBeGreaterThan(
      redAt(atlas, head.base.right, 1, 4) + 50,
    );
    expect(redAt(atlas, head.base.left, 3, 4)).toBeGreaterThan(
      redAt(atlas, head.base.left, 6, 4) + 50,
    );
    expect(redAt(atlas, head.base.right, 4, 2)).toBeLessThan(
      redAt(atlas, head.base.right, 4, 4) - 50,
    );
    expect(alphaAt(atlas, head.overlay.right, 3, 4)).toBe(0);
    expect(alphaAt(atlas, head.overlay.right, 4, 4)).toBe(0);
    expect(alphaAt(atlas, head.overlay.left, 3, 4)).toBe(0);
    expect(alphaAt(atlas, head.overlay.left, 4, 4)).toBe(0);
    expect(alphaAt(atlas, head.overlay.right, 0, 4)).toBe(255);
    expect(alphaAt(atlas, head.overlay.left, 7, 4)).toBe(255);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("wavy face-framing side layers taper as connected staggered locks instead of a rectangular frame", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      bangs: "curtain",
      bangsLength: "brow",
      hairTexture: "wavy",
      hairVolume: "full",
      hairSilhouette: "tousled",
      hairBackShape: "long",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
      earExposure: "covered",
    })!.atlas;
    const head = CLASSIC_LAYOUT.head.overlay;

    const transitions = (rect: Rect, x: number) => {
      let count = 0;
      for (let y = 1; y < rect.h; y++) {
        const previous = alphaAt(atlas, rect, x, y - 1) !== 0;
        const current = alphaAt(atlas, rect, x, y) !== 0;
        if (previous !== current) count++;
      }
      return count;
    };
    const reachesProfileSeam = (rect: Rect, startX: number, startY: number) => {
      const pending: Array<[number, number]> = [[startX, startY]];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const [x, y] = pending.pop()!;
        const key = `${x},${y}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (x === 0 || x === rect.w - 1) return true;
        for (const [nextX, nextY] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ] as const) {
          if (
            nextX >= 0 &&
            nextX < rect.w &&
            nextY >= 0 &&
            nextY < rect.h &&
            alphaAt(atlas, rect, nextX, nextY) !== 0
          ) {
            pending.push([nextX, nextY]);
          }
        }
      }
      return false;
    };

    for (const [rect, rearSeam, frontSeam] of [
      [head.right, 0, 7],
      [head.left, 7, 0],
    ] as const) {
      // Rear volume remains connected to the long back hair. The front
      // face-framing lock ends two rows earlier, so the enlarged layer steps
      // back toward the base cube instead of outlining the whole 8x8 profile.
      for (let y = 0; y < rect.h; y++) {
        expect(alphaAt(atlas, rect, rearSeam, y)).toBe(255);
      }
      for (let y = 0; y <= 5; y++) {
        expect(alphaAt(atlas, rect, frontSeam, y)).toBe(255);
      }
      for (let y = 6; y < rect.h; y++) {
        expect(alphaAt(atlas, rect, frontSeam, y)).toBe(0);
      }
      const rearInner = rearSeam === 0 ? 1 : 6;
      const frontInner = frontSeam === 0 ? 1 : 6;
      for (let y = 0; y <= 6; y++) {
        expect(alphaAt(atlas, rect, rearInner, y)).toBe(255);
      }
      expect(alphaAt(atlas, rect, rearInner, 7)).toBe(0);
      for (let y = 0; y <= 5; y++) {
        expect(alphaAt(atlas, rect, frontInner, y)).toBe(255);
      }
      for (let y = 6; y < rect.h; y++)
        expect(alphaAt(atlas, rect, frontInner, y)).toBe(0);
      // Inner contour pixels may taper and flare once, but must not jump
      // between alternating rows like disconnected checkerboard strands.
      for (const x of [2, 5]) {
        expect(transitions(rect, x)).toBeLessThanOrEqual(2);
      }
      for (const y of [4, 5]) {
        expect(alphaAt(atlas, rect, 3, y)).toBe(0);
        expect(alphaAt(atlas, rect, 4, y)).toBe(0);
      }
      for (let y = 0; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          if (alphaAt(atlas, rect, x, y) !== 0) {
            expect(reachesProfileSeam(rect, x, y)).toBe(true);
          }
        }
      }
    }

    const horizontalSeams = getBoxUvSeams(head).horizontal;
    for (const seam of horizontalSeams.slice(4)) {
      for (let index = 0; index < seam.primary.length; index++) {
        const primary = seam.primary[index];
        const adjacent = seam.adjacent[index];
        const primaryAlpha =
          atlas.rgba[(primary.y * ATLAS_SIZE + primary.x) * 4 + 3];
        if (primaryAlpha !== 0) {
          expect(
            atlas.rgba[(adjacent.y * ATLAS_SIZE + adjacent.x) * 4 + 3],
          ).toBe(255);
        }
      }
    }
    let bottomOuterPixels = 0;
    for (let y = 0; y < head.bottom.h; y++) {
      for (let x = 0; x < head.bottom.w; x++) {
        if (alphaAt(atlas, head.bottom, x, y) !== 0) bottomOuterPixels++;
      }
    }
    expect(bottomOuterPixels).toBeGreaterThanOrEqual(4);
    expect(bottomOuterPixels).toBeLessThanOrEqual(10);
  });

  const representativeHairStyles = [
    {
      hairstyle: "buzz",
      bangs: "none",
      bangsLength: "none",
      hairTexture: "straight",
      hairVolume: "flat",
      hairBackShape: "undercut",
      sideHairLength: "none",
    },
    {
      hairstyle: "short",
      bangs: "side",
      bangsLength: "eye",
      hairTexture: "straight",
      hairVolume: "normal",
      hairBackShape: "tapered",
      sideHairLength: "short",
    },
    {
      hairstyle: "medium",
      bangs: "straight",
      bangsLength: "brow",
      hairTexture: "straight",
      hairVolume: "full",
      hairBackShape: "rounded",
      sideHairLength: "jaw",
    },
    {
      hairstyle: "long",
      bangs: "curtain",
      bangsLength: "eye",
      hairTexture: "wavy",
      hairVolume: "full",
      hairBackShape: "long",
      sideHairLength: "shoulder",
    },
    {
      hairstyle: "curly",
      bangs: "wispy",
      bangsLength: "brow",
      hairTexture: "curly",
      hairVolume: "full",
      hairBackShape: "rounded",
      sideHairLength: "cheek",
    },
    {
      hairstyle: "afro",
      bangs: "none",
      bangsLength: "none",
      hairTexture: "coily",
      hairVolume: "full",
      hairBackShape: "rounded",
      sideHairLength: "short",
    },
    {
      hairstyle: "ponytail",
      bangs: "side",
      bangsLength: "brow",
      hairTexture: "straight",
      hairVolume: "normal",
      hairBackShape: "tied",
      sideHairLength: "short",
    },
    {
      hairstyle: "bun",
      bangs: "straight",
      bangsLength: "eye",
      hairTexture: "straight",
      hairVolume: "normal",
      hairBackShape: "tied",
      sideHairLength: "cheek",
    },
    {
      hairstyle: "twintails",
      bangs: "curtain",
      bangsLength: "brow",
      hairTexture: "wavy",
      hairVolume: "full",
      hairBackShape: "long",
      sideHairLength: "shoulder",
    },
  ] satisfies Array<Partial<FaceStyle>>;

  it.each(representativeHairStyles)(
    "keeps eyes and UV seams valid for $hairstyle/$bangs/$sideHairLength",
    (hairStyle) => {
      const atlas = packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        ...hairStyle,
        glasses: "none",
        eyeSpacing: "average",
      })!.atlas;
      const over = CLASSIC_LAYOUT.head.overlay;

      for (const x of [1, 2, 5, 6]) {
        expect(alphaAt(atlas, over.front, x, 4)).toBe(0);
      }
      if (hairStyle.hairSilhouette === "rounded") {
        expect(alphaAt(atlas, over.front, 0, 0)).toBe(0);
        expect(alphaAt(atlas, over.front, 7, 0)).toBe(0);
        expect(alphaAt(atlas, over.right, 0, 0)).toBe(0);
        expect(alphaAt(atlas, over.left, 7, 0)).toBe(0);
      }

      applyUvMask(atlas);
      expect(validateFinalAtlas(atlas).ok).toBe(true);
    },
  );

  it("keeps representative hairstyle families from collapsing into the same outer-layer silhouette", () => {
    const hairRects = [
      ...Object.values(CLASSIC_LAYOUT.head.overlay),
      CLASSIC_LAYOUT.body.overlay.front,
      CLASSIC_LAYOUT.body.overlay.back,
      CLASSIC_LAYOUT.body.overlay.right,
      CLASSIC_LAYOUT.body.overlay.left,
    ];
    const silhouette = (hairStyle: Partial<FaceStyle>) => {
      const atlas = packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        ...hairStyle,
        glasses: "none",
      })!.atlas;
      const mask: number[] = [];
      for (const rect of hairRects) {
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w; x++) {
            mask.push(alphaAt(atlas, rect, x, y) === 255 ? 1 : 0);
          }
        }
      }
      return mask;
    };
    const masks = representativeHairStyles.map((style) => ({
      hairstyle: style.hairstyle,
      mask: silhouette(style),
    }));

    for (let left = 0; left < masks.length; left++) {
      for (let right = left + 1; right < masks.length; right++) {
        const difference = masks[left].mask.reduce(
          (count, value, index) =>
            count + (value === masks[right].mask[index] ? 0 : 1),
          0,
        );
        expect(
          difference,
          `${masks[left].hairstyle} and ${masks[right].hairstyle} need distinct silhouettes`,
        ).toBeGreaterThanOrEqual(8);
      }
    }
  });

  const representativeOutfits = [
    {
      topType: "hoodie",
      outerGarment: "none",
      garmentTexture: "plain",
      bottomType: "pants",
      bottomPattern: "plain",
      bottomAccent: "side_stripe",
      legwear: "none",
      shoeStyle: "sneakers",
    },
    {
      topType: "sweater",
      outerGarment: "none",
      garmentTexture: "knit",
      necklace: "silver",
      bottomType: "pants",
      bottomPattern: "plain",
      bottomAccent: "belt",
      legwear: "none",
      shoeStyle: "dress_shoes",
    },
    {
      topType: "shirt",
      outerGarment: "vest",
      garmentTexture: "striped",
      neckAccessory: "collar",
      bottomType: "shorts",
      bottomPattern: "striped",
      bottomAccent: "cuffs",
      legwear: "socks",
      legwearAsymmetry: "both",
      shoeStyle: "loafers",
    },
    {
      topType: "dress",
      outerGarment: "none",
      garmentTexture: "patterned",
      bottomType: "skirt",
      bottomPattern: "pleated",
      bottomAccent: "ribbon",
      legwear: "stockings",
      legwearAsymmetry: "both",
      shoeStyle: "dress_shoes",
    },
    {
      topType: "jacket",
      outerGarment: "open_jacket",
      garmentTexture: "denim",
      bottomType: "jeans",
      bottomPattern: "plain",
      bottomAccent: "cuffs",
      legwear: "none",
      shoeStyle: "boots",
    },
    {
      topType: "sweater",
      outerGarment: "cardigan",
      garmentTexture: "knit",
      neckAccessory: "bow",
      bottomType: "skirt",
      bottomPattern: "plaid",
      bottomAccent: "ribbon",
      legwear: "leg_warmers",
      legwearAsymmetry: "left",
      thighAccessory: "bow",
      thighAccessorySide: "right",
      shoeStyle: "dress_shoes",
    },
  ] satisfies Array<Partial<FaceStyle>>;

  it("tapers heavy sweater outer-layer shoulders instead of completing a rigid rectangle", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      topType: "sweater",
      sleeveLength: "long",
      garmentTexture: "knit",
      outerLayer: "heavy",
      necklace: "silver",
    })!.atlas;
    const body = CLASSIC_LAYOUT.body.overlay;

    for (const rect of [body.front, body.back, body.right, body.left]) {
      expect(alphaAt(atlas, rect, 0, 0)).toBe(0);
      expect(alphaAt(atlas, rect, rect.w - 1, 0)).toBe(0);
      expect(alphaAt(atlas, rect, 0, 1)).toBe(0);
      expect(alphaAt(atlas, rect, rect.w - 1, 1)).toBe(0);
    }
    expect(alphaAt(atlas, body.front, 2, 0)).toBe(255);
    expect(alphaAt(atlas, body.front, body.front.w - 3, 0)).toBe(255);
    expect(alphaAt(atlas, body.front, 0, 2)).toBe(255);
    expect(alphaAt(atlas, body.front, body.front.w - 1, 2)).toBe(255);
    expect(alphaAt(atlas, body.top, 0, 0)).toBe(0);
    expect(alphaAt(atlas, body.top, body.top.w - 1, body.top.h - 1)).toBe(0);

    const base = CLASSIC_LAYOUT.body.base;
    const colorAt = (rect: { x: number; y: number }, x: number, y: number) => {
      const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return [atlas.rgba[d], atlas.rgba[d + 1], atlas.rgba[d + 2]];
    };
    for (const rect of [base.front, base.back, base.right, base.left]) {
      const corner = colorAt(rect, 0, 0);
      const interior = colorAt(rect, rect.w >= 6 ? 2 : 1, 3);
      const distance =
        Math.abs(corner[0] - interior[0]) +
        Math.abs(corner[1] - interior[1]) +
        Math.abs(corner[2] - interior[2]);
      expect(distance).toBeLessThan(35);
    }
    for (const arm of [CLASSIC_LAYOUT.rightArm, CLASSIC_LAYOUT.leftArm]) {
      const garment = colorAt(arm.base.front, 1, 3);
      for (const top of [arm.base.top, arm.overlay.top]) {
        let opaquePixels = 0;
        for (let y = 0; y < top.h; y++) {
          for (let x = 0; x < top.w; x++) {
            if (alphaAt(atlas, top, x, y) === 0) continue;
            opaquePixels++;
            const pixel = colorAt(top, x, y);
            const distance =
              Math.abs(pixel[0] - garment[0]) +
              Math.abs(pixel[1] - garment[1]) +
              Math.abs(pixel[2] - garment[2]);
            expect(distance).toBeLessThan(180);
            expect(pixel[2]).toBeLessThan(pixel[0]);
          }
        }
        expect(opaquePixels).toBeGreaterThan(0);
        if (top === arm.overlay.top)
          expect(opaquePixels).toBeLessThan(top.w * top.h);
      }
    }

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("uses analysed top colour to remove saturated guide noise from shoulder rims", () => {
    const guide = makeFrontView();
    for (let y = 180; y < 235; y++) {
      for (let x = 136; x < 376; x++) {
        const index = (y * guide.width + x) * 4;
        guide.rgba.set([28, 112, 224, 255], index);
      }
    }
    const atlas = packFrontViewToAtlas(guide, {
      ...DEFAULT_FACE_STYLE,
      topColor: "#585858",
      topType: "sweater",
      sleeveLength: "long",
      garmentTexture: "knit",
      outerLayer: "heavy",
      outerGarment: "none",
    })!.atlas;
    const declared = [0x58, 0x58, 0x58];
    const colorAt = (rect: { x: number; y: number }, x: number, y: number) => {
      const index = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return [atlas.rgba[index], atlas.rgba[index + 1], atlas.rgba[index + 2]];
    };
    const shoulderPixels = [
      colorAt(CLASSIC_LAYOUT.body.base.front, 1, 0),
      colorAt(CLASSIC_LAYOUT.body.base.front, 6, 1),
      colorAt(CLASSIC_LAYOUT.rightArm.base.front, 1, 0),
      colorAt(CLASSIC_LAYOUT.leftArm.base.front, 1, 1),
      colorAt(CLASSIC_LAYOUT.body.overlay.front, 1, 0),
      colorAt(CLASSIC_LAYOUT.body.overlay.front, 6, 0),
      colorAt(CLASSIC_LAYOUT.body.overlay.back, 1, 0),
      colorAt(CLASSIC_LAYOUT.body.overlay.back, 6, 0),
      colorAt(CLASSIC_LAYOUT.rightArm.overlay.top, 1, 1),
      colorAt(CLASSIC_LAYOUT.leftArm.overlay.top, 1, 1),
    ];
    for (const [shoulderIndex, pixel] of shoulderPixels.entries()) {
      const distance = pixel.reduce(
        (sum, channel, index) => sum + Math.abs(channel - declared[index]),
        0,
      );
      expect(
        distance,
        `shoulder ${shoulderIndex}: ${pixel.join(",")}`,
      ).toBeLessThan(150);
      expect(Math.max(...pixel) - Math.min(...pixel)).toBeLessThan(35);
      expect(pixel[2]).toBeLessThan(pixel[0] + 25);
    }

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("uses analysed skin and hair colours instead of intermediate guide colour drift", () => {
    const declaredHair = [0x56, 0x32, 0x1c];
    const declaredSkin = [0xc8, 0x8f, 0x72];
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none",
      hairColor: "#56321c",
      skinTone: "#c88f72",
    })!.atlas;
    const colorAt = (rect: { x: number; y: number }, x: number, y: number) => {
      const index = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return [atlas.rgba[index], atlas.rgba[index + 1], atlas.rgba[index + 2]];
    };
    const scalp = colorAt(CLASSIC_LAYOUT.head.base.top, 3, 3);
    const cheek = colorAt(CLASSIC_LAYOUT.head.base.front, 3, 4);
    const distance = (actual: number[], expected: number[]) =>
      actual.reduce(
        (sum, channel, index) => sum + Math.abs(channel - expected[index]),
        0,
      );

    expect(distance(scalp, declaredHair)).toBeLessThan(80);
    expect(scalp[0]).toBeGreaterThan(scalp[1] + 20);
    expect(distance(cheek, declaredSkin)).toBeLessThan(35);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("rebuilds plain trouser edge columns from garment pixels instead of a bright leg gap", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "pants",
      bottomPattern: "plain",
    })!.atlas;

    const luminance = (
      rect: { x: number; y: number },
      x: number,
      y: number,
    ) => {
      const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return atlas.rgba[d] + atlas.rgba[d + 1] + atlas.rgba[d + 2];
    };
    for (const part of [CLASSIC_LAYOUT.rightLeg, CLASSIC_LAYOUT.leftLeg]) {
      for (const rect of [part.base.front, part.base.back]) {
        for (const y of [1, 4, 7]) {
          const core = (luminance(rect, 1, y) + luminance(rect, 2, y)) / 2;
          expect(luminance(rect, 0, y)).toBeLessThanOrEqual(core);
          expect(luminance(rect, rect.w - 1, y)).toBeLessThanOrEqual(core);
        }
      }
    }

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it.each(representativeOutfits)(
    "keeps layered outfit UV valid for $topType/$bottomType/$shoeStyle",
    (outfit) => {
      const atlas = packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        ...outfit,
      })!.atlas;
      let opaqueOverlayPixels = 0;
      for (const part of Object.values(CLASSIC_LAYOUT)) {
        for (const rect of Object.values(part.overlay)) {
          for (let y = 0; y < rect.h; y++) {
            for (let x = 0; x < rect.w; x++) {
              if (alphaAt(atlas, rect, x, y) === 255) opaqueOverlayPixels++;
            }
          }
        }
      }

      expect(opaqueOverlayPixels).toBeGreaterThan(80);
      applyUvMask(atlas);
      expect(validateFinalAtlas(atlas).ok).toBe(true);
    },
  );

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
      skinTone: "#d9a385",
      bottomColor: "#b69c92",
      shoesColor: "#eee4da",
      bottomType: "skirt",
    })!;
    const atlas = packed.atlas;
    const bodyFront = CLASSIC_LAYOUT.body.overlay.front;
    const rightLegFront = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftLegFront = CLASSIC_LAYOUT.leftLeg.overlay.front;

    const bodyHem =
      ((bodyFront.y + bodyFront.h - 1) * ATLAS_SIZE + bodyFront.x + 3) * 4;
    const rightLegTop =
      (rightLegFront.y * ATLAS_SIZE + rightLegFront.x + 1) * 4;
    const leftLegTop = (leftLegFront.y * ATLAS_SIZE + leftLegFront.x + 1) * 4;

    expect(atlas.rgba[bodyHem + 3]).toBe(255);
    expect(atlas.rgba[rightLegTop + 3]).toBe(255);
    expect(atlas.rgba[leftLegTop + 3]).toBe(255);
    expect(atlas.rgba[bodyHem]).toBeLessThan(atlas.rgba[rightLegTop]);

    for (const leg of [
      CLASSIC_LAYOUT.rightLeg.base,
      CLASSIC_LAYOUT.leftLeg.base,
    ]) {
      for (const face of [leg.front, leg.back, leg.right, leg.left]) {
        const exposedLeg = ((face.y + 5) * ATLAS_SIZE + face.x + 1) * 4;
        expect(atlas.rgba[exposedLeg]).toBeGreaterThan(
          atlas.rgba[exposedLeg + 2] + 45,
        );
      }
    }

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
    const rightFrontFold =
      ((right.front.y + 4) * ATLAS_SIZE + right.front.x + 1) * 4;
    const rightSideFold =
      ((right.right.y + 4) * ATLAS_SIZE + right.right.x + 1) * 4;
    const rightSideSeam =
      ((right.right.y + 5) * ATLAS_SIZE + right.right.x) * 4;
    const leftSideSeam =
      ((left.left.y + 5) * ATLAS_SIZE + left.left.x + left.left.w - 1) * 4;
    const rightHighlight =
      ((right.front.y + 5) * ATLAS_SIZE + right.front.x + 1) * 4;

    expect(atlas.rgba[rightFrontFold + 3]).toBe(255);
    expect(atlas.rgba[rightSideFold + 3]).toBe(255);
    expect(atlas.rgba[rightSideSeam + 3]).toBe(255);
    expect(atlas.rgba[leftSideSeam + 3]).toBe(255);
    expect(atlas.rgba[rightHighlight]).toBeGreaterThan(
      atlas.rgba[rightFrontFold],
    );
    expect(atlas.rgba[rightSideSeam]).toBeLessThan(atlas.rgba[rightSideFold]);
  });

  it("hairAccessory=flower keeps a compact 3D cluster without masking the side profile", () => {
    const withoutAccessory = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      hairVolume: "full",
    })!.atlas;
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
    const topPetal = ((top.y + 5) * ATLAS_SIZE + top.x + 2) * 4;
    const topLeaf = ((top.y + 6) * ATLAS_SIZE + top.x + 3) * 4;
    const backPetal = ((back.y + 3) * ATLAS_SIZE + back.x) * 4;
    const backLeaf = ((back.y + 3) * ATLAS_SIZE + back.x + 1) * 4;

    expect(atlas.rgba[petal + 3]).toBe(255);
    expect(atlas.rgba[petal]).toBeGreaterThan(atlas.rgba[petal + 1]);
    expect(atlas.rgba[leaf + 1]).toBeGreaterThan(atlas.rgba[leaf]);
    expect(atlas.rgba[sidePetal + 3]).toBe(255);
    expect(atlas.rgba[topPetal + 3]).toBe(255);
    expect(atlas.rgba[topPetal]).toBeGreaterThan(atlas.rgba[topPetal + 1]);
    expect(atlas.rgba[topLeaf + 1]).toBeGreaterThan(atlas.rgba[topLeaf]);
    expect(atlas.rgba[backPetal + 3]).toBe(255);
    expect(atlas.rgba[backLeaf + 1]).toBeGreaterThan(atlas.rgba[backLeaf]);
    for (let y = 2; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) {
        const pixel = ((front.y + y) * ATLAS_SIZE + front.x + x) * 4;
        expect(Array.from(atlas.rgba.slice(pixel, pixel + 4))).toEqual(
          Array.from(withoutAccessory.rgba.slice(pixel, pixel + 4)),
        );
      }
    }
    for (const [x, y] of [
      [2, 3],
      [3, 3],
      [4, 3],
      [2, 4],
      [3, 4],
      [4, 4],
    ] as const) {
      expect(rgbaAt(atlas, side, x, y)).toEqual(
        rgbaAt(withoutAccessory, side, x, y),
      );
    }
    let changedSidePixels = 0;
    for (let y = 0; y < side.h; y++) {
      for (let x = 0; x < side.w; x++) {
        if (
          rgbaAt(atlas, side, x, y).some(
            (value, channel) =>
              value !== rgbaAt(withoutAccessory, side, x, y)[channel],
          )
        ) {
          changedSidePixels++;
        }
      }
    }
    expect(changedSidePixels).toBeLessThanOrEqual(9);
  });

  it("hairAccessoryColor preserves the dominant visible flower color", () => {
    const makeFlower = (hairAccessoryColor: "pink" | "blue") =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        hairAccessory: "flower",
        hairAccessorySide: "left",
        hairAccessoryColor,
      })!.atlas;
    const pink = makeFlower("pink");
    const blue = makeFlower("blue");
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const petal = ((front.y + 2) * ATLAS_SIZE + front.x) * 4;

    expect(pink.rgba[petal]).toBeGreaterThan(pink.rgba[petal + 2]);
    expect(blue.rgba[petal + 2]).toBeGreaterThan(blue.rgba[petal]);
    expect(blue.rgba[petal + 3]).toBe(255);
  });

  it("hairAccessoryScale distinguishes a subtle bloom from a large flower cluster", () => {
    const makeFlower = (hairAccessoryScale: "small" | "medium" | "large") =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "long",
        hairVolume: "full",
        hairAccessory: "flower",
        hairAccessoryScale,
        hairAccessorySide: "left",
        hairAccessoryColor: "pink",
      })!.atlas;
    const small = makeFlower("small");
    const medium = makeFlower("medium");
    const large = makeFlower("large");
    const front = CLASSIC_LAYOUT.head.overlay.front;
    const mediumLeaf = ((front.y + 1) * ATLAS_SIZE + front.x + 2) * 4;
    const largeCrownPetal = (front.y * ATLAS_SIZE + front.x + 2) * 4;

    expect(medium.rgba[mediumLeaf + 1]).toBeGreaterThan(
      small.rgba[mediumLeaf + 1] + 25,
    );
    expect(medium.rgba[mediumLeaf + 1]).toBeGreaterThan(
      medium.rgba[mediumLeaf],
    );
    expect(large.rgba[largeCrownPetal + 1]).toBeGreaterThan(
      medium.rgba[largeCrownPetal + 1] + 50,
    );
    expect(large.rgba[largeCrownPetal + 3]).toBe(255);
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
    const rightBackPetal = ((back.y + 3) * ATLAS_SIZE + back.x + 7) * 4;

    expect(atlas.rgba[rightFrontPetal + 3]).toBe(255);
    expect(atlas.rgba[rightFrontPetal]).toBeGreaterThan(
      atlas.rgba[rightFrontPetal + 1],
    );
    expect(atlas.rgba[rightFrontPetal]).toBeGreaterThan(
      atlas.rgba[oldLeftFrontPetal],
    );
    expect(atlas.rgba[rightSidePetal + 3]).toBe(255);
    expect(atlas.rgba[rightSidePetal]).toBeGreaterThan(
      atlas.rgba[rightSidePetal + 1],
    );
    expect(atlas.rgba[rightTopPetal + 3]).toBe(255);
    expect(atlas.rgba[rightBackPetal + 3]).toBe(255);
  });

  it("legwear=leg_warmers와 한쪽 asymmetry이면 한쪽 다리 레그워머와 반대쪽 리본을 그린다", () => {
    const packed = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "skirt",
      legwear: "leg_warmers",
      legwearAsymmetry: "left",
      thighAccessory: "bow",
      thighAccessorySide: "right",
    })!;
    const atlas = packed.atlas;
    const left = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const leftSide = CLASSIC_LAYOUT.leftLeg.overlay.left;
    const leftBack = CLASSIC_LAYOUT.leftLeg.overlay.back;
    const right = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const rightSide = CLASSIC_LAYOUT.rightLeg.overlay.right;
    const rightBack = CLASSIC_LAYOUT.rightLeg.overlay.back;
    const rightTop = CLASSIC_LAYOUT.rightLeg.overlay.top;
    const warmer = ((left.y + 4) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerLace = ((left.y + 1) * ATLAS_SIZE + left.x) * 4;
    const warmerLaceShadow = ((left.y + 1) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerRidge = ((left.y + 3) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerLift = ((left.y + 4) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerScallopDrop = ((left.y + 3) * ATLAS_SIZE + left.x + 2) * 4;
    const warmerSideRidge =
      ((leftSide.y + 5) * ATLAS_SIZE + leftSide.x + 3) * 4;
    const warmerSideLift = ((leftSide.y + 4) * ATLAS_SIZE + leftSide.x + 2) * 4;
    const warmerSideLace = ((leftSide.y + 1) * ATLAS_SIZE + leftSide.x) * 4;
    const warmerBackRidge =
      ((leftBack.y + 7) * ATLAS_SIZE + leftBack.x + 2) * 4;
    const warmerBackLift = ((leftBack.y + 6) * ATLAS_SIZE + leftBack.x + 2) * 4;
    const warmerExtraFold = ((left.y + 6) * ATLAS_SIZE + left.x + 2) * 4;
    const warmerExtraLift = ((left.y + 6) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerAnkleCuff = ((left.y + 9) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerAnkleFold = ((left.y + 8) * ATLAS_SIZE + left.x + 1) * 4;
    const warmerSideAnkle = ((leftSide.y + 9) * ATLAS_SIZE + leftSide.x) * 4;
    const warmerBackAnkleFold =
      ((leftBack.y + 8) * ATLAS_SIZE + leftBack.x + 1) * 4;
    const bow = ((right.y + 2) * ATLAS_SIZE + right.x) * 4;
    const bowTopBand = ((right.y + 1) * ATLAS_SIZE + right.x + 2) * 4;
    const bowOuterWing = ((right.y + 2) * ATLAS_SIZE + right.x + 3) * 4;
    const bowTail = ((right.y + 4) * ATLAS_SIZE + right.x + 1) * 4;
    const bareLowerLeg = ((right.y + 5) * ATLAS_SIZE + right.x + 3) * 4;
    const sideTopBand = ((rightSide.y + 1) * ATLAS_SIZE + rightSide.x) * 4;
    const sideBand = ((rightSide.y + 2) * ATLAS_SIZE + rightSide.x + 1) * 4;
    const sideTail = ((rightSide.y + 3) * ATLAS_SIZE + rightSide.x) * 4;
    const sideLongTail = ((rightSide.y + 4) * ATLAS_SIZE + rightSide.x) * 4;
    const backTopBand = ((rightBack.y + 1) * ATLAS_SIZE + rightBack.x + 2) * 4;
    const backBand = ((rightBack.y + 2) * ATLAS_SIZE + rightBack.x + 2) * 4;
    const topAttachment =
      ((rightTop.y + rightTop.h - 1) * ATLAS_SIZE + rightTop.x + 1) * 4;

    expect(atlas.rgba[warmer + 3]).toBe(255);
    expect(atlas.rgba[warmerLace + 3]).toBe(255);
    expect(atlas.rgba[warmerLaceShadow + 3]).toBe(255);
    expect(atlas.rgba[warmerLace]).toBeGreaterThan(
      atlas.rgba[warmerLaceShadow],
    );
    expect(atlas.rgba[warmerScallopDrop + 3]).toBe(255);
    expect(atlas.rgba[warmerSideLace + 3]).toBe(255);
    expect(atlas.rgba[bow + 3]).toBe(255);
    expect(atlas.rgba[bow]).toBeGreaterThan(220);
    expect(atlas.rgba[bowTail + 3]).toBe(255);
    expect(atlas.rgba[bareLowerLeg + 3]).toBe(0);
    expect(atlas.rgba[sideBand + 3]).toBe(255);
    expect(atlas.rgba[sideTail + 3]).toBe(255);
    expect(atlas.rgba[sideLongTail + 3]).toBe(255);
    expect(atlas.rgba[sideTopBand + 3]).toBe(255);
    expect(atlas.rgba[backTopBand + 3]).toBe(255);
    expect(atlas.rgba[backBand + 3]).toBe(255);
    expect(atlas.rgba[topAttachment + 3]).toBe(255);
    expect(atlas.rgba[sideBand]).toBeGreaterThan(atlas.rgba[sideBand + 1]);
    expect(atlas.rgba[bowTopBand + 3]).toBe(255);
    expect(atlas.rgba[bowOuterWing + 3]).toBe(255);
    expect(atlas.rgba[bowOuterWing]).toBeGreaterThan(atlas.rgba[bowTail]);
    expect(atlas.rgba[warmerRidge]).toBeLessThan(atlas.rgba[warmerLift]);
    expect(atlas.rgba[warmerSideRidge]).toBeLessThan(
      atlas.rgba[warmerSideLift],
    );
    expect(atlas.rgba[warmerBackRidge]).toBeLessThan(
      atlas.rgba[warmerBackLift],
    );
    expect(atlas.rgba[warmerExtraFold]).toBeLessThan(
      atlas.rgba[warmerExtraLift],
    );
    expect(atlas.rgba[warmerAnkleCuff + 3]).toBe(255);
    expect(atlas.rgba[warmerAnkleFold + 3]).toBe(255);
    expect(atlas.rgba[warmerSideAnkle + 3]).toBe(255);
    expect(atlas.rgba[warmerBackAnkleFold + 3]).toBe(255);
    expect(atlas.rgba[warmerAnkleFold]).toBeGreaterThan(
      atlas.rgba[warmerAnkleCuff],
    );
  });

  it("does not invent an opposite thigh bow from one-sided legwear alone", () => {
    const style: FaceStyle = {
      ...DEFAULT_FACE_STYLE,
      bottomType: "skirt",
      legwear: "leg_warmers",
      legwearAsymmetry: "left",
      thighAccessory: "none",
      thighAccessorySide: "none",
    };
    const atlas = packFrontViewToAtlas(makeFrontView(), style)!.atlas;
    const baseline = packFrontViewToAtlas(makeFrontView(), {
      ...style,
      legwear: "none",
      legwearAsymmetry: "none",
    })!.atlas;
    const left = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const right = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const warmer = ((left.y + 4) * ATLAS_SIZE + left.x + 1) * 4;

    expect(atlas.rgba[warmer + 3]).toBe(255);
    expect(rgbaAt(atlas, right, 0, 2)).toEqual(rgbaAt(baseline, right, 0, 2));
    expect(rgbaAt(atlas, right, 1, 4)).toEqual(rgbaAt(baseline, right, 1, 4));
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
    const rightFrontBow =
      ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x + 1) *
      4;
    const rightFrontKnot =
      ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x + 2) *
      4;
    const rightFrontStrap =
      ((right.front.y + right.front.h - 2) * ATLAS_SIZE + right.front.x + 1) *
      4;
    const rightFrontToe =
      ((right.front.y + right.front.h - 1) * ATLAS_SIZE + right.front.x + 2) *
      4;
    const rightSideStrap =
      ((right.right.y + right.right.h - 2) * ATLAS_SIZE + right.right.x) * 4;
    const rightSideBuckle =
      ((right.right.y + right.right.h - 3) * ATLAS_SIZE +
        right.right.x +
        right.right.w -
        1) *
      4;
    const leftSideStrap =
      ((left.left.y + left.left.h - 2) * ATLAS_SIZE + left.left.x + 1) * 4;
    const leftSideKnot =
      ((left.left.y + left.left.h - 3) * ATLAS_SIZE + left.left.x) * 4;
    const backStrap =
      ((left.back.y + left.back.h - 2) * ATLAS_SIZE + left.back.x + 2) * 4;
    const backHeelBow =
      ((left.back.y + left.back.h - 2) * ATLAS_SIZE + left.back.x) * 4;
    const rightSideSole =
      ((right.right.y + right.right.h - 1) * ATLAS_SIZE + right.right.x) * 4;
    const rightBackHeelStrap =
      ((right.back.y + right.back.h - 3) * ATLAS_SIZE + right.back.x + 1) * 4;
    const rightBackHeelLight =
      ((right.back.y + right.back.h - 3) * ATLAS_SIZE + right.back.x + 2) * 4;
    const rightBottomSole = (right.bottom.y * ATLAS_SIZE + right.bottom.x) * 4;
    const rightBottomShadow =
      ((right.bottom.y + right.bottom.h - 1) * ATLAS_SIZE + right.bottom.x) * 4;

    expect(atlas.rgba[rightFrontBow + 3]).toBe(255);
    expect(atlas.rgba[rightFrontKnot + 3]).toBe(255);
    expect(atlas.rgba[rightFrontBow]).toBeGreaterThan(
      atlas.rgba[rightFrontKnot],
    );
    expect(atlas.rgba[rightFrontStrap + 3]).toBe(255);
    expect(atlas.rgba[rightFrontToe + 3]).toBe(255);
    expect(atlas.rgba[rightSideStrap + 3]).toBe(255);
    expect(atlas.rgba[rightSideBuckle + 3]).toBe(255);
    expect(atlas.rgba[leftSideStrap + 3]).toBe(255);
    expect(atlas.rgba[leftSideKnot + 3]).toBe(255);
    expect(atlas.rgba[backStrap + 3]).toBe(255);
    expect(atlas.rgba[backHeelBow + 3]).toBe(255);
    expect(atlas.rgba[rightSideSole + 3]).toBe(255);
    expect(atlas.rgba[rightBackHeelStrap + 3]).toBe(255);
    expect(atlas.rgba[rightBackHeelLight + 3]).toBe(255);
    expect(atlas.rgba[rightBottomSole + 3]).toBe(255);
    expect(atlas.rgba[rightBottomShadow + 3]).toBe(255);
    expect(atlas.rgba[rightFrontStrap]).toBeGreaterThan(
      atlas.rgba[rightFrontToe],
    );
    expect(atlas.rgba[rightBackHeelLight]).toBeGreaterThan(
      atlas.rgba[rightBackHeelStrap],
    );
    expect(atlas.rgba[rightBottomSole]).toBeGreaterThan(
      atlas.rgba[rightBottomShadow],
    );
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
    const rightLongTrim =
      ((right.front.y + 4) * ATLAS_SIZE + right.front.x) * 4;
    const leftLongHem =
      ((left.front.y + 3) * ATLAS_SIZE + left.front.x + 3) * 4;
    const leftLongTrim =
      ((left.front.y + 4) * ATLAS_SIZE + left.front.x + 3) * 4;
    const rightSideHem = ((right.right.y + 3) * ATLAS_SIZE + right.right.x) * 4;
    const leftSideHem =
      ((left.left.y + 3) * ATLAS_SIZE + left.left.x + left.left.w - 1) * 4;

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
      ((right.front.y + right.front.h - 4) * ATLAS_SIZE + right.front.x + 1) *
      4;
    const frontBootEdge =
      ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x) * 4;
    const frontBootCenter =
      ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x + 1) *
      4;
    const sideUpperBoot =
      ((right.right.y + right.right.h - 4) * ATLAS_SIZE + right.right.x + 1) *
      4;
    const sideSole =
      ((right.right.y + right.right.h - 1) * ATLAS_SIZE +
        right.right.x +
        right.right.w -
        1) *
      4;

    expect(atlas.rgba[frontUpperBoot + 3]).toBe(255);
    expect(atlas.rgba[frontBootEdge + 3]).toBe(255);
    expect(atlas.rgba[sideUpperBoot + 3]).toBe(255);
    expect(atlas.rgba[sideSole + 3]).toBe(255);
    expect(atlas.rgba[frontBootEdge]).toBeLessThan(atlas.rgba[frontBootCenter]);
  });

  it("explicit sneakers keep laces and a side-wrapping sole readable", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      bottomType: "pants",
      bottomAccent: "cuffs",
      shoeStyle: "sneakers",
    })!.atlas;
    const right = CLASSIC_LAYOUT.rightLeg.overlay;
    const cuff =
      ((right.front.y + right.front.h - 4) * ATLAS_SIZE + right.front.x + 1) *
      4;
    const lace =
      ((right.front.y + right.front.h - 3) * ATLAS_SIZE + right.front.x + 1) *
      4;
    const toe =
      ((right.front.y + right.front.h - 2) * ATLAS_SIZE + right.front.x + 1) *
      4;
    const sideSole =
      ((right.right.y + right.right.h - 1) * ATLAS_SIZE +
        right.right.x +
        right.right.w -
        1) *
      4;

    expect(atlas.rgba[cuff + 3]).toBe(255);
    expect(atlas.rgba[lace + 3]).toBe(255);
    expect(atlas.rgba[toe + 3]).toBe(255);
    expect(atlas.rgba[sideSole + 3]).toBe(255);
    expect(atlas.rgba[lace]).not.toBe(atlas.rgba[toe]);
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
    const leftSideBowWrap =
      ((leftSide.y + 1) * ATLAS_SIZE + leftSide.x + leftSide.w - 1) * 4;
    const leftSideBowTail =
      ((leftSide.y + 3) * ATLAS_SIZE + leftSide.x + leftSide.w - 2) * 4;
    const plaidDark = ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 1) * 4;
    const plaidLight = ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 2) * 4;
    const sidePlaidDark = ((side.y + side.h - 3) * ATLAS_SIZE + side.x + 1) * 4;
    const sidePlaidLight = ((side.y + side.h - 3) * ATLAS_SIZE + side.x) * 4;
    const backPlaidDark = ((back.y + back.h - 3) * ATLAS_SIZE + back.x + 1) * 4;
    const backPlaidLight =
      ((back.y + back.h - 3) * ATLAS_SIZE + back.x + 2) * 4;
    const torsoPlaidLowThread =
      ((body.y + body.h - 2) * ATLAS_SIZE + body.x + 3) * 4;
    const leftSidePlaidWrap =
      ((leftSide.y + leftSide.h - 3) * ATLAS_SIZE +
        leftSide.x +
        leftSide.w -
        2) *
      4;
    const topPlaidFront = ((top.y + top.h - 1) * ATLAS_SIZE + top.x + 1) * 4;
    const topPlaidBack = (top.y * ATLAS_SIZE + top.x + 1) * 4;
    const topPlaidMid =
      ((top.y + Math.max(0, top.h - 2)) * ATLAS_SIZE + top.x + 3) * 4;
    const legPlaidDark = (rightLeg.y * ATLAS_SIZE + rightLeg.x + 1) * 4;
    const legPlaidLight = (rightLeg.y * ATLAS_SIZE + rightLeg.x + 2) * 4;
    const legPlaidCross = ((rightLeg.y + 1) * ATLAS_SIZE + rightLeg.x + 1) * 4;
    const legPlaidHorizontal = ((rightLeg.y + 1) * ATLAS_SIZE + rightLeg.x) * 4;
    const legPlaidSideLight =
      (rightLegSide.y * ATLAS_SIZE + rightLegSide.x) * 4;
    const legPlaidSideDark =
      ((rightLegSide.y + 1) * ATLAS_SIZE + rightLegSide.x + 1) * 4;

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
    expect(atlas.rgba[torsoPlaidLowThread + 3]).toBe(255);
    expect(atlas.rgba[torsoPlaidLowThread]).toBeGreaterThan(
      atlas.rgba[plaidDark],
    );
    expect(atlas.rgba[leftSidePlaidWrap + 3]).toBe(255);
    expect(atlas.rgba[leftSidePlaidWrap]).toBeLessThan(
      atlas.rgba[sidePlaidLight],
    );
    expect(atlas.rgba[topPlaidFront + 3]).toBe(255);
    expect(atlas.rgba[topPlaidBack + 3]).toBe(255);
    expect(atlas.rgba[topPlaidMid + 3]).toBe(255);
    expect(atlas.rgba[topPlaidFront]).toBeLessThan(atlas.rgba[topPlaidMid]);
    expect(atlas.rgba[legPlaidDark + 3]).toBe(255);
    expect(atlas.rgba[legPlaidDark]).toBeLessThan(atlas.rgba[legPlaidLight]);
    expect(atlas.rgba[legPlaidCross]).toBeLessThan(atlas.rgba[legPlaidDark]);
    expect(atlas.rgba[legPlaidHorizontal + 3]).toBe(255);
    expect(atlas.rgba[legPlaidHorizontal]).toBeGreaterThan(
      atlas.rgba[legPlaidCross],
    );
    expect(atlas.rgba[legPlaidSideLight + 3]).toBe(255);
    expect(atlas.rgba[legPlaidSideDark]).toBeLessThan(
      atlas.rgba[legPlaidSideLight],
    );
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
    expect(redAt(arched, face, 6, 2)).toBeLessThan(redAt(slanted, face, 6, 2));
    expect(redAt(slanted, face, 1, 2)).toBeLessThan(redAt(arched, face, 1, 2));
    expect(redAt(slanted, face, 5, 2)).toBeLessThan(redAt(arched, face, 5, 2));
  });

  it("eyeShape keeps narrow, almond and round eyes vertically distinct", () => {
    const shared: FaceStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none",
      eyeSpacing: "average",
      eyeTilt: "level",
      eyebrowShape: "straight",
      glasses: "none",
    };
    const narrow = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeShape: "narrow",
    })!.atlas;
    const almond = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeShape: "almond",
    })!.atlas;
    const round = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeShape: "round",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const signature = (atlas: RawImage) =>
      [1, 2, 5, 6]
        .flatMap((x) => [rgbaAt(atlas, face, x, 4), rgbaAt(atlas, face, x, 5)])
        .flat()
        .join(",");

    expect(new Set([narrow, almond, round].map(signature)).size).toBe(3);
    expect(redAt(narrow, face, 1, 4)).toBeLessThan(
      redAt(almond, face, 1, 4) - 20,
    );
    expect(redAt(round, face, 2, 5)).toBeLessThan(
      redAt(almond, face, 2, 5) - 25,
    );
    expect(redAt(almond, face, 2, 5)).toBeLessThan(
      redAt(narrow, face, 2, 5) - 25,
    );
    expect(redAt(round, face, 1, 5)).toBeLessThan(
      redAt(narrow, face, 1, 5) - 15,
    );
  });

  it("eyeSize preserves small, average and large eye apertures as distinct pixel clusters", () => {
    const shared: FaceStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none",
      eyeShape: "almond",
      eyeSpacing: "average",
      eyeTilt: "level",
      eyebrowShape: "straight",
      glasses: "none",
    };
    const small = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeSize: "small",
    })!.atlas;
    const average = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeSize: "average",
    })!.atlas;
    const large = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeSize: "large",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const signature = (atlas: RawImage) =>
      [1, 2, 5, 6]
        .flatMap((x) => [rgbaAt(atlas, face, x, 4), rgbaAt(atlas, face, x, 5)])
        .flat()
        .join(",");

    expect(new Set([small, average, large].map(signature)).size).toBe(3);
    expect(redAt(small, face, 1, 4)).toBeLessThan(
      redAt(average, face, 1, 4) - 15,
    );
    expect(redAt(small, face, 2, 5)).toBeGreaterThan(
      redAt(average, face, 2, 5) + 20,
    );
    expect(redAt(large, face, 2, 5)).toBeLessThan(
      redAt(average, face, 2, 5) - 45,
    );
    expect(redAt(large, face, 1, 5)).toBeLessThan(
      redAt(average, face, 1, 5) - 15,
    );
  });

  it("eyeTilt keeps both eye anchors level and shades an adjacent corner", () => {
    const shared: FaceStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "none",
      eyeShape: "almond",
      eyeSpacing: "average",
      eyebrowShape: "straight",
      glasses: "none",
    };
    const level = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeTilt: "level",
    })!.atlas;
    const upturned = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeTilt: "upturned",
    })!.atlas;
    const downturned = packFrontViewToAtlas(makeFrontView(), {
      ...shared,
      eyeTilt: "downturned",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;

    for (const atlas of [level, upturned, downturned]) {
      expect(rgbaAt(atlas, face, 1, 4)).not.toEqual(rgbaAt(atlas, face, 1, 6));
      expect(redAt(atlas, face, 2, 4)).toBeLessThan(
        redAt(atlas, face, 2, 6) - 35,
      );
      expect(rgbaAt(atlas, face, 6, 4)).not.toEqual(rgbaAt(atlas, face, 6, 6));
      expect(redAt(atlas, face, 5, 4)).toBeLessThan(
        redAt(atlas, face, 5, 6) - 35,
      );
    }
    expect(redAt(upturned, face, 1, 2)).toBeLessThan(
      redAt(level, face, 1, 2) - 60,
    );
    expect(redAt(downturned, face, 1, 5)).toBeLessThan(
      redAt(level, face, 1, 5) - 35,
    );
    expect(rgbaAt(upturned, face, 1, 3)).not.toEqual(rgbaAt(level, face, 1, 3));
    expect(rgbaAt(downturned, face, 6, 5)).not.toEqual(
      rgbaAt(level, face, 6, 5),
    );
    expect(rgbaAt(upturned, face, 1, 4)).not.toEqual(
      rgbaAt(upturned, face, 1, 3),
    );
    expect(rgbaAt(downturned, face, 1, 4)).not.toEqual(
      rgbaAt(downturned, face, 1, 5),
    );
  });

  it("large downturned almond eyes taper diagonally instead of becoming identical 2x2 blocks", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "staggered",
      fringeOpening: "center",
      eyeShape: "almond",
      eyeSize: "large",
      eyeSpacing: "average",
      eyeTilt: "downturned",
      glasses: "none",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay.front;

    for (const [outer, inner] of [
      [1, 2],
      [6, 5],
    ] as const) {
      expect(redAt(atlas, face, outer, 5)).toBeLessThan(
        redAt(atlas, face, inner, 5) - 5,
      );
      expect(redAt(atlas, face, inner, 4)).toBeLessThan(
        redAt(atlas, face, inner, 5) - 20,
      );
      expect(alphaAt(atlas, over, outer, 5)).toBe(0);
      expect(alphaAt(atlas, over, inner, 5)).toBe(0);
    }
  });

  it("upturned eye corners stay visible through a dense brow-length outer fringe", () => {
    const atlas = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "blunt",
      fringeOpening: "none",
      eyeShape: "almond",
      eyeSpacing: "average",
      eyeTilt: "upturned",
      glasses: "none",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const over = CLASSIC_LAYOUT.head.overlay.front;

    for (const outer of [1, 6]) {
      expect(alphaAt(atlas, over, outer, 3)).toBe(0);
      expect(redAt(atlas, face, outer, 3)).toBeLessThan(
        redAt(atlas, face, 3, 4) - 45,
      );
    }
    for (const inner of [2, 5]) {
      expect(alphaAt(atlas, over, inner, 4)).toBe(0);
    }
    expect(alphaAt(atlas, over, 3, 3)).toBe(255);

    applyUvMask(atlas);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
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
    const compactFull = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      mouthShape: "small",
      lipFullness: "full",
    })!.atlas;
    const thin = packFrontViewToAtlas(makeFrontView(), {
      ...baseStyle,
      mouthShape: "thin",
    })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;

    expect(redAt(wide, face, 2, 6)).toBeLessThan(redAt(small, face, 2, 6));
    expect(redAt(wide, face, 5, 6)).toBeLessThan(redAt(small, face, 5, 6));
    expect(greenAt(full, face, 3, 6)).toBeGreaterThan(
      greenAt(thin, face, 3, 6),
    );
    expect(redAt(thin, face, 2, 6)).toBe(redAt(small, face, 2, 6));
    expect(redAt(compactFull, face, 2, 6)).toBe(redAt(small, face, 2, 6));
    expect(redAt(compactFull, face, 5, 6)).toBe(redAt(small, face, 5, 6));
    expect(redAt(compactFull, face, 3, 6)).toBeGreaterThan(
      redAt(small, face, 3, 6) + 20,
    );
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
    const face = CLASSIC_LAYOUT.head.base.front;

    expect(alphaAt(atlas, over, 1, 5)).toBe(0);
    expect(alphaAt(atlas, over, 2, 4)).toBe(0);
    expect(alphaAt(atlas, over, 5, 4)).toBe(0);
    expect(alphaAt(atlas, over, 3, 5)).toBe(0);
    expect(alphaAt(atlas, over, 4, 5)).toBe(0);
    expect(alphaAt(atlas, over, 2, 6)).toBe(0);
    expect(alphaAt(atlas, over, 3, 6)).toBe(0);
    expect(alphaAt(atlas, over, 4, 6)).toBe(0);
    expect(alphaAt(atlas, over, 5, 6)).toBe(0);
    expect(alphaAt(atlas, over, 3, 7)).toBe(0);
    expect(redAt(atlas, face, 2, 4)).toBeLessThan(
      redAt(atlas, face, 4, 4) - 50,
    );
    expect(redAt(atlas, face, 5, 4)).toBeLessThan(
      redAt(atlas, face, 4, 4) - 50,
    );
    expect(redAt(atlas, face, 3, 5)).toBeLessThan(redAt(atlas, face, 4, 4));
    expect(redAt(atlas, face, 5, 6)).toBeLessThan(redAt(atlas, face, 4, 4));
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

    expect(redAt(prominent, face, 4, 4)).toBeGreaterThan(
      redAt(small, face, 4, 4),
    );
    expect(redAt(straight, face, 3, 5)).toBeLessThan(redAt(small, face, 3, 5));
    expect(alphaAt(prominent, over, 4, 3)).toBe(0);
    expect(alphaAt(rounded, over, 4, 5)).toBe(0);
    expect(alphaAt(straight, over, 4, 5)).toBe(0);
    expect(redAt(rounded, face, 4, 5)).not.toBe(redAt(straight, face, 4, 5));
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
    const face = CLASSIC_LAYOUT.head.base.front;

    expect(alphaAt(square, over, 1, 7)).toBe(0);
    expect(alphaAt(pointed, over, 1, 7)).toBe(0);
    expect(redAt(pointed, face, 3, 7)).toBeLessThan(redAt(square, face, 3, 7));
    expect(redAt(rounded, face, 1, 6)).not.toBe(redAt(soft, face, 1, 6));
  });

  it("five face shapes keep distinct cheek-to-chin contour signatures", () => {
    const makeFace = (faceShape: NonNullable<FaceStyle["faceShape"]>) =>
      packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        hairstyle: "short",
        bangs: "none",
        facialHair: "none",
        glasses: "none",
        faceShape,
        // Face shape and jaw shape are independent analysis outputs. Keep the
        // jaw constant here so each faceShape must contribute its own contour.
        jawShape: "soft",
      })!.atlas;
    const face = CLASSIC_LAYOUT.head.base.front;
    const shapes = {
      round: makeFace("round"),
      oval: makeFace("oval"),
      long: makeFace("long"),
      angular: makeFace("angular"),
      square: makeFace("square"),
    };
    const contour = (atlas: RawImage) =>
      [
        [0, 6],
        [1, 6],
        [6, 6],
        [7, 6],
        [0, 7],
        [1, 7],
        [2, 7],
        [3, 7],
        [4, 7],
        [5, 7],
        [6, 7],
        [7, 7],
      ]
        .map(([x, y]) => rgbaAt(atlas, face, x, y).slice(0, 3).join(","))
        .join("|");

    expect(new Set(Object.values(shapes).map(contour)).size).toBe(5);
    expect(redAt(shapes.round, face, 1, 7)).toBeGreaterThan(
      redAt(shapes.oval, face, 1, 7),
    );
    expect(redAt(shapes.long, face, 0, 7)).toBeLessThan(
      redAt(shapes.oval, face, 0, 7),
    );
    expect(contour(shapes.angular)).not.toBe(contour(shapes.square));
  });

  it("four-view sheets preserve distinct left and right profile colors", () => {
    const packed = packFrontViewToAtlas(
      makeFourViewSheet(),
      DEFAULT_FACE_STYLE,
      4,
    );
    expect(packed).not.toBeNull();
    expect(packed!.hasBackView).toBe(true);
    expect(packed!.hasSideViews).toBe(true);
    expect(packed!.viewCount).toBe(4);

    const left = avgOfRect(packed!.atlas, CLASSIC_LAYOUT.body.base.left);
    const right = avgOfRect(packed!.atlas, CLASSIC_LAYOUT.body.base.right);
    expect(left[1]).toBeGreaterThan(left[2]);
    expect(right[2]).toBeGreaterThan(right[1]);
  });
});
