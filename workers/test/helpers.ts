/** 테스트 공용 헬퍼: 유효한 PhotoAnalysis와 합성 atlas 생성 */

import type { PhotoAnalysis } from "../src/analysis";
import type { RawImage } from "../src/png";
import { ATLAS_SIZE, BASE_RECTS, OVERLAY_RECTS } from "../src/uvLayout";

export function makeAnalysis(
  overrides: Partial<PhotoAnalysis> = {},
): PhotoAnalysis {
  return {
    quality: "pass",
    failReason: null,
    framing: "upper_body",
    visibleRegions: {
      face: true,
      hair: true,
      upperBody: true,
      lowerBody: false,
      feet: false,
    },
    observed: {
      face: "round face, warm smile, thick eyebrows",
      hair: "short black hair with side-swept bangs",
      accessories: "thin silver-rimmed glasses",
      clothing: "mustard yellow knit sweater over white collared shirt",
      colorPalette: ["mustard yellow", "white", "black"],
    },
    inferred: {
      hairBack: {
        value: "short tapered back matching the sides",
        rationale: "visible sides are short and neat",
      },
      upperBody: null,
      lowerBody: {
        value: "dark navy chino pants",
        rationale: "matches the smart-casual sweater and shirt",
      },
      shoes: {
        value: "white low-top sneakers",
        rationale: "casual outfit pairs with simple sneakers",
      },
    },
    renderHints: {
      faceShape: "round",
      eyeShape: "round",
      eyeSize: "average",
      eyeSpacing: "average",
      eyeTilt: "level",
      eyebrowShape: "arched",
      noseShape: "rounded",
      mouthShape: "wide",
      jawShape: "rounded",
      bangs: "side",
      bangsLength: "brow",
      bangsDensity: "balanced",
      fringeEdge: "staggered",
      fringeOpening: "left",
      hairTexture: "straight",
      hairVolume: "normal",
      hairSilhouette: "rounded",
      hairBackShape: "tapered",
      hairPart: "right",
      sideHairLength: "short",
      sideHairShape: "tapered",
      sideHairAsymmetry: "none",
      earExposure: "partial",
      garmentTexture: "knit",
      outerLayer: "heavy",
      outerGarment: "none",
      necklace: "none",
      hairAccessory: "none",
      hairAccessorySide: "left",
      hairAccessoryColor: "pink",
      neckAccessory: "none",
      bottomPattern: "plain",
      bottomAccent: "none",
      legwear: "none",
      legwearAsymmetry: "none",
    },
    identityPrompt:
      "A person with a round face, short black hair with side-swept bangs, thick eyebrows and thin silver glasses, warm smile.",
    outfitPrompt:
      "Mustard yellow knit sweater over a white collared shirt, dark navy chinos, white sneakers.",
    negativePrompt: "no hat, no beard",
    fallbackFeatures: {
      skinTone: "light",
      hairColor: "black",
      hairstyle: "short",
      eyeColor: "dark-brown",
      eyebrowThickness: "thick",
      facialHair: "none",
      glasses: "regular",
      glassesColor: "gray",
      earrings: false,
      hat: "none",
      hatColor: "red",
      expression: "smile",
      topType: "sweater",
      topColor: "yellow",
      topAccentColor: "white",
      sleeveLength: "long",
      bottomType: "pants",
      bottomColor: "navy",
      shoesColor: "white",
    },
    ...overrides,
  };
}

/** 검증을 통과할 만한 합성 64x64 atlas (UV 영역에 다양한 색, 밖은 단색 배경) */
export function makeSyntheticAtlas(seed = 1): RawImage {
  const rgba = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  // 배경: 짙은 회색 (마스크 전 단계, atlas답게 단순한 배경)
  for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
    rgba.set([30, 30, 34, 255], i * 4);
  }
  let n = seed;
  const rand = () => {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    return n / 0x7fffffff;
  };
  for (const rect of [...BASE_RECTS, ...OVERLAY_RECTS]) {
    const base = [80 + rand() * 150, 80 + rand() * 150, 80 + rand() * 150];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const jitter = (rand() - 0.5) * 90;
        const d = (y * ATLAS_SIZE + x) * 4;
        rgba[d] = Math.max(0, Math.min(255, base[0] + jitter));
        rgba[d + 1] = Math.max(0, Math.min(255, base[1] + jitter));
        rgba[d + 2] = Math.max(0, Math.min(255, base[2] + jitter));
        rgba[d + 3] = 255;
      }
    }
  }
  return { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba };
}

/**
 * 합성 정면 캐릭터 (512x512, 밝은 배경):
 * 머리(어두운 머리카락 + 피부 + 눈), 노란 몸통, 좌우 팔, 남색 다리 + 갈색 신발.
 */
export function makeFrontView(): RawImage {
  const W = 512;
  const rgba = new Uint8Array(W * W * 4);
  const fill = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    c: number[],
  ) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        rgba.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
      }
    }
  };
  fill(0, 0, W, W, [232, 232, 236]); // 배경
  // 캐릭터: bbox 대략 (136,40)-(376,480), 높이 440
  fill(196, 40, 316, 180, [235, 190, 160]); // 머리(피부)
  fill(196, 40, 316, 100, [40, 30, 22]); // 머리카락
  fill(220, 120, 240, 140, [20, 18, 16]); // 왼눈
  fill(272, 120, 292, 140, [20, 18, 16]); // 오른눈
  fill(136, 180, 376, 330, [220, 175, 60]); // 몸통+팔 (노랑)
  fill(136, 180, 196, 330, [200, 158, 52]); // 왼팔(살짝 어둡게)
  fill(316, 180, 376, 330, [200, 158, 52]); // 오른팔
  fill(196, 330, 316, 480, [40, 50, 90]); // 다리 (남색)
  fill(196, 455, 316, 480, [110, 70, 40]); // 신발 (갈색)
  return { width: W, height: W, rgba };
}

/** 정면과 뒷면이 좌우로 분리된 1024x512 캐릭터 시트 */
export function makeFrontBackView(): RawImage {
  const front = makeFrontView();
  const width = front.width * 2;
  const rgba = new Uint8Array(width * front.height * 4);
  for (let y = 0; y < front.height; y++) {
    for (let x = 0; x < width; x++) {
      rgba.set([232, 232, 236, 255], (y * width + x) * 4);
    }
  }
  const copy = (offsetX: number) => {
    for (let y = 0; y < front.height; y++) {
      for (let x = 0; x < front.width; x++) {
        const s = (y * front.width + x) * 4;
        const d = (y * width + offsetX + x) * 4;
        rgba.set(front.rgba.subarray(s, s + 4), d);
      }
    }
  };
  copy(0);
  copy(front.width);
  // 뒷면 얼굴 영역은 뒤통수 머리카락으로 덮어 두 번째 front로 오인하지 않게 한다.
  for (let y = 40; y < 180; y++) {
    for (let x = front.width + 196; x < front.width + 316; x++) {
      rgba.set([38, 30, 24, 255], (y * width + x) * 4);
    }
  }
  return { width, height: front.height, rgba };
}

/** Four separated views; profile torso colors make left/right UV routing testable. */
export function makeFourViewSheet(): RawImage {
  const source = makeFrontView();
  const width = 1024;
  const height = 512;
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgba.set([232, 232, 236, 255], pixel * 4);
  }
  for (let view = 0; view < 4; view++) {
    const offsetX = view * 256;
    for (let y = 0; y < height; y++) {
      for (let x = 128; x < 384; x++) {
        const sourceOffset = (y * source.width + x) * 4;
        const targetX = offsetX + x - 128;
        const targetOffset = (y * width + targetX) * 4;
        rgba.set(
          source.rgba.subarray(sourceOffset, sourceOffset + 4),
          targetOffset,
        );
      }
    }
    if (view >= 2) {
      const color = view === 2 ? [42, 190, 72] : [52, 78, 218];
      for (let y = 180; y < 330; y++) {
        for (let x = offsetX + 8; x < offsetX + 248; x++) {
          const target = (y * width + x) * 4;
          const backgroundDistance =
            Math.abs(rgba[target] - 232) +
            Math.abs(rgba[target + 1] - 232) +
            Math.abs(rgba[target + 2] - 236);
          if (backgroundDistance > 72) {
            rgba.set([color[0], color[1], color[2], 255], target);
          }
        }
      }
    }
  }
  return { width, height, rgba };
}

/** 64x64 → scale배 nearest 확대 (FLUX 512 출력 흉내) */
export function upscale(image: RawImage, scale: number): RawImage {
  const w = image.width * scale;
  const h = image.height * scale;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s =
        (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
      out.set(image.rgba.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, rgba: out };
}
