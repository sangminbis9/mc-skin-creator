/**
 * 정면 캐릭터 뷰 → 64x64 스킨 atlas 결정적 pack (front_pack 전략).
 *
 * FLUX가 그린 "정면 전신 블록 캐릭터" 이미지를 배경 분리 → 부위 슬라이스 →
 * 셀 중앙값 축소로 각 front 면에 채우고, 보이지 않는 옆/뒤/위/아래 면은
 * front 면에서 파생(가장자리 확장·어둡게)해 UV 규칙을 코드로 보장한다.
 */

import type { RawImage } from "./png";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  type BoxUV,
  type Rect,
} from "./uvLayout";

export interface PackResult {
  atlas: RawImage;
  problems: string[];
  hasBackView: boolean;
}

/**
 * 얼굴 구조적 합성용 특징 (분석 단계 결과에서 전달).
 * 색상은 hex 문자열 (#rrggbb).
 */
export interface FaceStyle {
  eyeColor: string;
  glassesColor: string;
  eyebrowThickness: string; // thin | normal | thick
  expression: string; // smile | neutral | serious
  facialHair: string; // none | mustache | goatee | beard | stubble
  glasses: string; // none | regular | round | sunglasses
  /** bald | buzz | short | medium | long | ponytail | bun | twintails | curly | afro */
  hairstyle: string;
  hat: string; // none | cap | beanie | hood
  faceShape?: "round" | "oval" | "long" | "angular" | "square";
  eyeShape?: "narrow" | "almond" | "round";
  eyeSpacing?: "close" | "average" | "wide";
  eyebrowShape?: "straight" | "arched" | "slanted" | "soft";
  noseShape?: "small" | "straight" | "rounded" | "prominent";
  mouthShape?: "small" | "wide" | "full" | "thin";
  jawShape?: "rounded" | "pointed" | "square" | "soft";
  bangs?: "none" | "straight" | "side" | "curtain" | "wispy";
  bangsLength?: "none" | "short" | "brow" | "eye";
  hairTexture?: "straight" | "wavy" | "curly" | "coily";
  hairVolume?: "flat" | "normal" | "full";
  hairSilhouette?: "rounded" | "flat" | "swept" | "tousled" | "spiky";
  hairBackShape?: "tapered" | "rounded" | "long" | "tied" | "undercut";
  hairPart?: "none" | "center" | "left" | "right";
  sideHairLength?: "none" | "short" | "cheek" | "jaw" | "shoulder";
  garmentTexture?: "plain" | "knit" | "denim" | "leather" | "striped" | "patterned";
  outerLayer?: "none" | "light" | "heavy";
  outerGarment?: "none" | "cardigan" | "open_jacket" | "coat" | "vest";
  necklace?: "none" | "silver" | "gold" | "dark";
  hairAccessory?: "none" | "flower" | "bow" | "ribbon" | "clip";
  neckAccessory?: "none" | "bow" | "tie" | "scarf" | "collar";
  bottomPattern?: "plain" | "plaid" | "striped" | "pleated" | "lace";
  bottomAccent?: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
  legwear?: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
  legwearAsymmetry?: "none" | "left" | "right" | "both";
  topType?: string;
  sleeveLength?: string;
  bottomType?: string;
}

export const DEFAULT_FACE_STYLE: FaceStyle = {
  eyeColor: "#4a3728",
  glassesColor: "#22201e",
  eyebrowThickness: "normal",
  expression: "neutral",
  facialHair: "none",
  glasses: "none",
  hairstyle: "short",
  hat: "none",
  faceShape: "oval",
  eyeShape: "almond",
  eyeSpacing: "average",
  eyebrowShape: "straight",
  noseShape: "small",
  mouthShape: "small",
  jawShape: "soft",
  bangs: "none",
  bangsLength: "none",
  hairTexture: "straight",
  hairVolume: "normal",
  hairSilhouette: "rounded",
  hairBackShape: "tapered",
  hairPart: "none",
  sideHairLength: "short",
  garmentTexture: "plain",
  outerLayer: "none",
  outerGarment: "none",
  necklace: "none",
  hairAccessory: "none",
  neckAccessory: "none",
  bottomPattern: "plain",
  bottomAccent: "none",
  legwear: "none",
  legwearAsymmetry: "none",
  topType: "tshirt",
  sleeveLength: "short",
  bottomType: "pants",
};

type Rgb = [number, number, number];

function hexToRgb(hex: string, fallback: Rgb): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    return fallback;
  }
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function shadeRgb(c: Rgb, f: number): Rgb {
  return [
    Math.max(0, Math.min(255, Math.round(c[0] * f))),
    Math.max(0, Math.min(255, Math.round(c[1] * f))),
    Math.max(0, Math.min(255, Math.round(c[2] * f))),
  ];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const BG_DIST_THRESHOLD = 72;

/** 네 모서리 중앙값으로 배경색 추정 */
function estimateBackground(src: RawImage): [number, number, number] {
  const s = Math.max(4, Math.floor(src.width / 32));
  const samples: number[][] = [[], [], []];
  const grab = (x0: number, y0: number) => {
    for (let y = y0; y < y0 + s; y++) {
      for (let x = x0; x < x0 + s; x++) {
        const d = (y * src.width + x) * 4;
        samples[0].push(src.rgba[d]);
        samples[1].push(src.rgba[d + 1]);
        samples[2].push(src.rgba[d + 2]);
      }
    }
  };
  grab(0, 0);
  grab(src.width - s, 0);
  grab(0, src.height - s);
  grab(src.width - s, src.height - s);
  return samples.map((arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  }) as [number, number, number];
}

function isCharacterPixel(
  src: RawImage,
  x: number,
  y: number,
  bg: [number, number, number],
): boolean {
  const d = (y * src.width + x) * 4;
  if (src.rgba[d + 3] < 128) {
    return false;
  }
  return (
    Math.abs(src.rgba[d] - bg[0]) +
      Math.abs(src.rgba[d + 1] - bg[1]) +
      Math.abs(src.rgba[d + 2] - bg[2]) >
    BG_DIST_THRESHOLD
  );
}

/** 소스 영역의 채널별 중앙값 색 (캐릭터 픽셀 우선, 없으면 전체) */
function medianColor(
  src: RawImage,
  region: Region,
  bg: [number, number, number] | null,
): [number, number, number] {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const push = (charOnly: boolean) => {
    for (let y = Math.floor(region.y0); y < Math.ceil(region.y1); y++) {
      for (let x = Math.floor(region.x0); x < Math.ceil(region.x1); x++) {
        if (x < 0 || y < 0 || x >= src.width || y >= src.height) continue;
        if (charOnly && bg && !isCharacterPixel(src, x, y, bg)) continue;
        const d = (y * src.width + x) * 4;
        r.push(src.rgba[d]);
        g.push(src.rgba[d + 1]);
        b.push(src.rgba[d + 2]);
      }
    }
  };
  push(true);
  if (r.length === 0) {
    push(false);
  }
  if (r.length === 0) {
    return [128, 128, 128];
  }
  const mid = (arr: number[]) => {
    arr.sort((x, y) => x - y);
    return arr[arr.length >> 1];
  };
  return [mid(r), mid(g), mid(b)];
}

/**
 * 얼굴용 특징 보존 색: 셀 안에 뚜렷한 어두운 무리(눈·안경·눈썹)가 있으면
 * 중앙값 대신 그 어두운 무리의 색을 쓴다 — 8x8 축소에서 이목구비가 살아남는다.
 */
function featureColor(
  src: RawImage,
  region: Region,
  bg: [number, number, number],
): [number, number, number] {
  const pixels: Array<[number, number, number, number]> = [];
  for (let y = Math.floor(region.y0); y < Math.ceil(region.y1); y++) {
    for (let x = Math.floor(region.x0); x < Math.ceil(region.x1); x++) {
      if (x < 0 || y < 0 || x >= src.width || y >= src.height) continue;
      if (!isCharacterPixel(src, x, y, bg)) continue;
      const d = (y * src.width + x) * 4;
      const lum =
        0.299 * src.rgba[d] + 0.587 * src.rgba[d + 1] + 0.114 * src.rgba[d + 2];
      pixels.push([src.rgba[d], src.rgba[d + 1], src.rgba[d + 2], lum]);
    }
  }
  if (pixels.length === 0) {
    return medianColor(src, region, bg);
  }
  pixels.sort((a, b) => a[3] - b[3]);
  const median = pixels[pixels.length >> 1];
  const darkCount = Math.max(1, Math.floor(pixels.length * 0.2));
  const dark = pixels[darkCount >> 1];
  // 어두운 무리가 셀의 18% 이상이고 중앙값보다 확실히 어두우면 특징으로 취급
  const darkFrac =
    pixels.filter((p) => p[3] <= dark[3] + 14).length / pixels.length;
  if (darkFrac >= 0.18 && dark[3] < median[3] * 0.62) {
    return [dark[0], dark[1], dark[2]];
  }
  return [median[0], median[1], median[2]];
}

/** 소스 region을 rect(w x h)로 셀 축소해 atlas에 기록. preserveFeatures는 얼굴 전용 */
function fillRectFromRegion(
  atlas: RawImage,
  rect: Rect,
  src: RawImage,
  region: Region,
  bg: [number, number, number] | null,
  preserveFeatures = false,
): void {
  const rw = region.x1 - region.x0;
  const rh = region.y1 - region.y0;
  for (let cy = 0; cy < rect.h; cy++) {
    for (let cx = 0; cx < rect.w; cx++) {
      const cell: Region = {
        x0: region.x0 + (cx / rect.w) * rw,
        x1: region.x0 + ((cx + 1) / rect.w) * rw,
        y0: region.y0 + (cy / rect.h) * rh,
        y1: region.y0 + ((cy + 1) / rect.h) * rh,
      };
      const [r, g, b] =
        preserveFeatures && bg
          ? featureColor(src, cell, bg)
          : medianColor(src, cell, bg);
      const d = ((rect.y + cy) * ATLAS_SIZE + rect.x + cx) * 4;
      atlas.rgba[d] = r;
      atlas.rgba[d + 1] = g;
      atlas.rgba[d + 2] = b;
      atlas.rgba[d + 3] = 255;
    }
  }
}

/** atlas 안에서 srcRect의 내용을 dstRect로 복사 (크기 다르면 nearest 스케일) + 명암 */
function fillRectFromRect(
  atlas: RawImage,
  dst: Rect,
  srcRect: Rect,
  shade: number,
  mirrorX = false,
): void {
  for (let cy = 0; cy < dst.h; cy++) {
    for (let cx = 0; cx < dst.w; cx++) {
      const sxRatio = mirrorX ? 1 - (cx + 0.5) / dst.w : (cx + 0.5) / dst.w;
      const sx = srcRect.x + Math.min(srcRect.w - 1, Math.floor(sxRatio * srcRect.w));
      const sy =
        srcRect.y + Math.min(srcRect.h - 1, Math.floor(((cy + 0.5) / dst.h) * srcRect.h));
      const s = (sy * ATLAS_SIZE + sx) * 4;
      const d = ((dst.y + cy) * ATLAS_SIZE + dst.x + cx) * 4;
      atlas.rgba[d] = Math.min(255, atlas.rgba[s] * shade);
      atlas.rgba[d + 1] = Math.min(255, atlas.rgba[s + 1] * shade);
      atlas.rgba[d + 2] = Math.min(255, atlas.rgba[s + 2] * shade);
      atlas.rgba[d + 3] = 255;
    }
  }
}

function fillRectSolid(
  atlas: RawImage,
  rect: Rect,
  [r, g, b]: [number, number, number],
  shade = 1,
): void {
  for (let cy = 0; cy < rect.h; cy++) {
    for (let cx = 0; cx < rect.w; cx++) {
      const d = ((rect.y + cy) * ATLAS_SIZE + rect.x + cx) * 4;
      atlas.rgba[d] = Math.min(255, r * shade);
      atlas.rgba[d + 1] = Math.min(255, g * shade);
      atlas.rgba[d + 2] = Math.min(255, b * shade);
      atlas.rgba[d + 3] = 255;
    }
  }
}

/**
 * front 면을 채운 뒤 옆/위/아래 면을 파생:
 * 옆면 = front 가장자리 열 확장, 위/아래 = 지정색.
 * 뒷면은 호출부에서 처리한다 (뒷면 뷰가 있으면 실제 렌더, 없으면 front 반전 파생).
 */
function completeSides(
  atlas: RawImage,
  box: BoxUV,
  topColor: [number, number, number],
  bottomColor: [number, number, number],
): void {
  const edgeLeft: Rect = { x: box.front.x, y: box.front.y, w: 1, h: box.front.h };
  const edgeRight: Rect = {
    x: box.front.x + box.front.w - 1,
    y: box.front.y,
    w: 1,
    h: box.front.h,
  };
  // 마인크래프트 표준: right 면이 전개도 왼쪽, left 면이 오른쪽
  fillRectFromRect(atlas, box.right, edgeLeft, 0.86);
  fillRectFromRect(atlas, box.left, edgeRight, 0.86);
  fillRectSolid(atlas, box.top, topColor);
  fillRectSolid(atlas, box.bottom, bottomColor, 0.82);
}

/**
 * 결정적 셰이딩 패스: 면별 상→하 명암 램프 + 가장자리 어둡게 + 좌표 해시 디더링.
 * 단색 덩어리를 픽셀아트다운 질감으로 만든다. 얼굴(머리 앞면)은 건드리지 않는다.
 */
function applyShading(atlas: RawImage): void {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  for (const part of ALL_PARTS) {
    for (const [faceName, rect] of Object.entries(CLASSIC_LAYOUT[part].base) as Array<
      [keyof BoxUV, Rect]
    >) {
      if (part === "head" && faceName === "front") {
        continue; // 이목구비 보호
      }
      for (let cy = 0; cy < rect.h; cy++) {
        const ramp = 1.05 - (cy / Math.max(1, rect.h - 1)) * 0.13; // 1.05 → 0.92
        for (let cx = 0; cx < rect.w; cx++) {
          let factor = ramp;
          if (rect.w >= 4 && (cx === 0 || cx === rect.w - 1)) {
            factor *= 0.95;
          }
          const hash =
            (((rect.x + cx) * 73856093) ^ ((rect.y + cy) * 19349663)) >>> 0;
          const jitter = (hash % 9) - 4; // ±4 결정적 디더링
          const d = ((rect.y + cy) * ATLAS_SIZE + rect.x + cx) * 4;
          for (let ch = 0; ch < 3; ch++) {
            atlas.rgba[d + ch] = clamp(atlas.rgba[d + ch] * factor + jitter);
          }
        }
      }
    }
  }
}

/**
 * 구조화된 저해상도 얼굴 합성.
 *
 * FLUX가 그린 작은 얼굴은 8x8 축소 시 검은 얼룩과 머리 가장자리 노이즈가 된다.
 * 생성 이미지에서는 피부/머리 팔레트만 가져오고, 형태는 분석 단계의 얼굴·눈·앞머리
 * 힌트로 다시 그린다. 모든 사람에게 같은 큰 흰자 템플릿을 쓰지 않고 눈 간격·눈매·
 * 눈썹 굵기·표정·앞머리 유형을 8x8 제약 안에서 구분한다.
 */
function composeFace(
  atlas: RawImage,
  hairColor: Rgb,
  skinColor: Rgb,
  style: FaceStyle,
): void {
  const face = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const put = (rect: Rect, x: number, y: number, c: Rgb) => {
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = c[0];
    atlas.rgba[d + 1] = c[1];
    atlas.rgba[d + 2] = c[2];
    atlas.rgba[d + 3] = 255;
  };
  const hair = (x: number, y: number, shade = 1) =>
    put(face, x, y, shadeRgb(hairPixel(hairColor, x, y, 0.07), shade));

  // 1) 피부 바탕: 얼굴형에 따른 가장자리/턱 명암만 적용한다.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const edge = Math.abs(x - 3.5) / 3.5;
      let factor = 1.035 - edge * 0.075 - (y / 7) * 0.035;
      if (
        y >= 6 &&
        (style.faceShape === "angular" || style.faceShape === "square")
      ) {
        factor *= 0.91;
      } else if (y === 7 && style.faceShape === "round") {
        factor *= x === 0 || x === 7 ? 0.88 : 0.95;
      } else if (y === 7 && style.faceShape === "long") {
        factor *= 0.9;
      }
      put(face, x, y, shadeRgb(skinColor, factor));
    }
  }

  // 2) base 앞머리: 얼굴 옆의 검은 노이즈를 버리고 명시적인 실루엣만 그린다.
  for (let x = 0; x < 8; x++) hair(x, 0);
  if (style.hairstyle !== "buzz") {
    for (let x = 0; x < 8; x++) hair(x, 1, x === 0 || x === 7 ? 0.92 : 1);
  }
  const bangs = style.bangs ?? "none";
  if (bangs === "straight") {
    for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) hair(x, 2);
    for (const x of [0, 2, 5, 7]) hair(x, 3, 0.96);
  } else if (bangs === "side") {
    for (const x of [0, 1, 2, 3, 4, 5]) hair(x, 2);
    for (const x of [0, 1, 2]) hair(x, 3, 0.96);
  } else if (bangs === "curtain") {
    for (const x of [0, 1, 2, 5, 6, 7]) hair(x, 2);
    hair(0, 3, 0.94);
    hair(7, 3, 0.94);
  } else if (bangs === "wispy") {
    for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) hair(x, 1);
    for (const x of [1, 3, 5, 7]) hair(x, 2, 0.96);
  } else {
    hair(0, 2, 0.94);
    hair(7, 2, 0.94);
  }

  // 3) 눈썹·눈·코·입: 1픽셀 검은 사각형으로 끝나지 않도록 작은 색 군집을 만든다.
  const browColor = shadeRgb(hairColor, 0.8);
  const eye = hexToRgb(style.eyeColor, [74, 55, 40]);
  const eyePairs =
    style.eyeSpacing === "wide"
      ? ([[0, 1], [6, 7]] as const)
      : style.eyeSpacing === "close"
        ? ([[1, 2], [4, 5]] as const)
        : ([[1, 2], [5, 6]] as const);
  const brow =
    style.eyebrowThickness === "thin"
      ? mixRgb(browColor, skinColor, 0.38)
      : browColor;
  const eyebrowShape = style.eyebrowShape ?? "straight";
  for (const [outer, inner] of eyePairs) {
    put(face, outer, 3, brow);
    put(face, inner, 3, brow);
    const sclera = mixRgb(skinColor, [238, 232, 222], 0.58);
    put(face, outer, 4, sclera);
    put(face, inner, 4, eye);
    if (style.eyeShape === "round") {
      put(face, inner, 5, shadeRgb(eye, 0.78));
    }
  }
  const browAccent =
    style.eyebrowThickness === "thin"
      ? mixRgb(brow, skinColor, 0.26)
      : shadeRgb(brow, 0.96);
  const browShadow = shadeRgb(brow, 0.74);
  const [[leftOuter, leftInner], [rightOuter, rightInner]] = eyePairs;
  if (eyebrowShape === "arched") {
    put(face, leftInner, 2, browAccent);
    put(face, rightOuter, 2, browAccent);
    put(overlay, leftOuter, 3, shadeRgb(brow, 0.9));
    put(overlay, rightInner, 3, shadeRgb(brow, 0.9));
  } else if (eyebrowShape === "slanted") {
    put(face, leftOuter, 2, browAccent);
    put(face, rightInner, 2, browAccent);
    put(overlay, leftInner, 3, browShadow);
    put(overlay, rightOuter, 3, browShadow);
  } else if (eyebrowShape === "soft") {
    const softBrow = mixRgb(brow, skinColor, 0.48);
    for (const [outer, inner] of eyePairs) {
      put(face, outer, 3, softBrow);
      put(face, inner, 3, mixRgb(softBrow, brow, 0.22));
    }
  } else if (style.eyebrowThickness === "thick") {
    put(face, leftOuter, 2, browAccent);
    put(face, rightInner, 2, browAccent);
  }

  const skinShadow = shadeRgb(skinColor, 0.82);
  const eyeHighlight = mixRgb(eye, [250, 244, 232], 0.58);
  const lowerEye = mixRgb(skinColor, shadeRgb(eye, 0.66), 0.24);
  const eyelid = mixRgb(skinColor, brow, style.eyeShape === "narrow" ? 0.48 : 0.34);
  const noseShape = style.noseShape ?? "small";
  const noseX = style.faceShape === "long" || noseShape === "prominent" ? 4 : 3;
  const noseBridge = mixRgb(skinColor, [255, 238, 224], 0.24);
  const noseSide = shadeRgb(skinColor, 0.9);

  if (style.glasses === "none") {
    for (const [outer, inner] of eyePairs) {
      if (style.eyeShape === "round") {
        put(overlay, inner, 4, eyeHighlight);
        put(overlay, outer, 5, lowerEye);
      } else if (style.eyeShape === "narrow") {
        put(overlay, outer, 3, eyelid);
        put(overlay, inner, 3, shadeRgb(eyelid, 0.86));
        put(overlay, inner, 4, shadeRgb(eye, 0.82));
      } else {
        put(overlay, inner, 4, eyeHighlight);
        put(overlay, inner, 5, lowerEye);
      }
    }
  }

  if (noseShape === "small") {
    put(face, noseX, 5, mixRgb(noseSide, skinColor, 0.38));
  } else if (noseShape === "straight") {
    put(face, noseX, 4, noseBridge);
    put(face, noseX, 5, skinShadow);
  } else if (noseShape === "rounded") {
    put(face, noseX, 5, skinShadow);
    put(overlay, noseX === 3 ? 4 : 3, 5, mixRgb(noseSide, skinColor, 0.24));
    put(overlay, noseX, 4, mixRgb(noseBridge, skinColor, 0.38));
  } else {
    put(face, noseX, 4, shadeRgb(noseBridge, 1.04));
    put(face, noseX, 5, shadeRgb(skinShadow, 0.92));
    put(face, noseX === 3 ? 4 : 3, 5, shadeRgb(noseSide, 0.86));
    put(overlay, noseX, 3, mixRgb(noseBridge, skinColor, 0.28));
  }

  const mouthColor = mixRgb(shadeRgb(skinColor, 0.62), [160, 74, 60], 0.5);
  const mouthShape = style.mouthShape ?? "small";
  const mouthDark = shadeRgb(mouthColor, style.expression === "serious" ? 0.76 : 0.88);
  const lipFull = mixRgb(mouthColor, [188, 92, 78], 0.36);
  const lipLight = mixRgb(lipFull, skinColor, 0.42);

  if (mouthShape === "wide" || (style.expression === "smile" && mouthShape === "small")) {
    put(face, 2, 6, style.expression === "smile" ? shadeRgb(mouthColor, 1.1) : mouthDark);
    put(face, 3, 6, mouthColor);
    put(face, 4, 6, mouthColor);
    put(face, 5, 6, style.expression === "smile" ? shadeRgb(mouthColor, 1.1) : mouthDark);
  } else if (mouthShape === "full") {
    put(face, 3, 6, lipFull);
    put(face, 4, 6, lipFull);
    put(overlay, 3, 7, lipLight);
    put(overlay, 4, 7, shadeRgb(lipFull, 0.9));
  } else if (mouthShape === "thin" || style.expression === "serious") {
    for (const x of [3, 4]) put(face, x, 6, mouthDark);
    if (mouthShape === "thin" && style.expression === "smile") {
      put(overlay, 2, 6, mixRgb(mouthDark, skinColor, 0.35));
      put(overlay, 5, 6, mixRgb(mouthDark, skinColor, 0.35));
    }
  } else {
    put(face, 3, 6, mouthColor);
    put(face, 4, 6, mouthColor);
  }

  // 4) 수염과 안경은 실제 돌출 요소이므로 overlay를 활용한다.
  if (style.facialHair !== "none") {
    const beard =
      style.facialHair === "stubble"
        ? mixRgb(skinColor, hairColor, 0.4)
        : shadeRgb(hairColor, 0.9);
    if (style.facialHair === "mustache" || style.facialHair === "beard") {
      put(face, 2, 5, beard);
      put(face, 5, 5, beard);
    }
    if (style.facialHair === "goatee") {
      put(face, 3, 7, beard);
      put(face, 4, 7, beard);
    }
    if (style.facialHair === "beard" || style.facialHair === "stubble") {
      for (let x = 0; x < 8; x++) {
        put(face, x, 7, beard);
      }
      put(face, 0, 6, beard);
      put(face, 7, 6, beard);
    }
  }

  // 볼·턱·관자놀이 라운딩: overlay는 부풀린 박스로 렌더되므로 얼굴이 둥글게 읽힌다.
  const cheek = shadeRgb(skinColor, 0.95);
  put(overlay, 0, 2, shadeRgb(skinColor, 0.97));
  put(overlay, 7, 2, shadeRgb(skinColor, 0.97));
  for (const y of [5, 6]) {
    put(overlay, 0, y, cheek);
    put(overlay, 7, y, cheek);
  }
  if (style.facialHair === "none") {
    const blush = mixRgb(
      skinColor,
      [222, 128, 116],
      style.expression === "smile" ? 0.17 : 0.1,
    );
    put(overlay, 1, 5, blush);
    put(overlay, 6, 5, shadeRgb(blush, 0.98));
  }
  if (style.faceShape === "angular" || style.faceShape === "square") {
    put(overlay, 1, 7, shadeRgb(skinColor, 0.88));
    put(overlay, 6, 7, shadeRgb(skinColor, 0.88));
  } else if (style.faceShape === "long") {
    put(overlay, 3, 7, shadeRgb(skinColor, 0.9));
    put(overlay, 4, 7, shadeRgb(skinColor, 0.9));
  } else if (style.faceShape === "round") {
    put(overlay, 1, 6, shadeRgb(skinColor, 0.97));
    put(overlay, 6, 6, shadeRgb(skinColor, 0.97));
  }
  const chin =
    style.facialHair === "beard" ||
    style.facialHair === "stubble" ||
    style.facialHair === "goatee"
      ? shadeRgb(hairColor, 0.9)
      : shadeRgb(skinColor, 0.94);
  for (const x of [2, 3, 4, 5]) {
    put(overlay, x, 7, chin);
  }
  const jawShape =
    style.jawShape ??
    (style.faceShape === "angular" || style.faceShape === "square"
      ? "square"
      : style.faceShape === "round"
        ? "rounded"
        : "soft");
  if (style.facialHair === "none") {
    if (jawShape === "square") {
      put(overlay, 1, 7, shadeRgb(skinColor, 0.86));
      put(overlay, 6, 7, shadeRgb(skinColor, 0.86));
      put(overlay, 2, 6, shadeRgb(skinColor, 0.92));
      put(overlay, 5, 6, shadeRgb(skinColor, 0.92));
    } else if (jawShape === "pointed") {
      put(overlay, 2, 7, shadeRgb(skinColor, 0.98));
      put(overlay, 5, 7, shadeRgb(skinColor, 0.98));
      put(overlay, 3, 7, shadeRgb(skinColor, 0.88));
      put(overlay, 4, 7, shadeRgb(skinColor, 0.88));
    } else if (jawShape === "rounded") {
      put(overlay, 1, 6, shadeRgb(skinColor, 0.98));
      put(overlay, 6, 6, shadeRgb(skinColor, 0.98));
      put(overlay, 2, 7, shadeRgb(skinColor, 0.96));
      put(overlay, 5, 7, shadeRgb(skinColor, 0.96));
    } else {
      put(overlay, 2, 7, shadeRgb(skinColor, 0.95));
      put(overlay, 5, 7, shadeRgb(skinColor, 0.95));
    }
  }

  // 앞머리 overlay는 듬성한 가닥만 사용해 헬멧 같은 판을 만들지 않는다.
  const fringe = (xs: number[], y: number) => {
    for (const x of xs) put(overlay, x, y, hairVolumePixel(hairColor, x, y));
  };
  if (style.bangs === "straight") {
    fringe([0, 2, 5, 7], 1);
    fringe([1, 3, 4, 6], 2);
  } else if (style.bangs === "side") {
    fringe([0, 2, 4, 6], 1);
    fringe([0, 1, 3], 2);
  } else if (style.bangs === "curtain") {
    fringe([0, 2, 5, 7], 1);
    fringe([1, 6], 2);
  } else if (style.bangs === "wispy") {
    fringe([1, 4, 7], 1);
    fringe([2, 5], 2);
  }

  if (style.glasses !== "none") {
    const rim = hexToRgb(style.glassesColor, [34, 32, 30]);
    const lens = style.glasses === "sunglasses" ? shadeRgb(rim, 0.55) : null;
    for (const x0 of [0, 5]) {
      if (style.glasses === "round") {
        put(overlay, x0 + 1, 2, rim);
        put(overlay, x0, 3, rim);
        put(overlay, x0 + 2, 3, rim);
        put(overlay, x0 + 1, 5, rim);
      } else {
        for (let x = x0; x < x0 + 3; x++) {
          put(overlay, x, 2, rim);
          put(overlay, x, 5, rim);
        }
        put(overlay, x0, 3, rim);
        put(overlay, x0 + 2, 3, rim);
        put(overlay, x0, 4, rim);
        put(overlay, x0 + 2, 4, rim);
      }
      if (lens) {
        put(overlay, x0 + 1, 3, lens);
        put(overlay, x0 + 1, 4, lens);
      }
    }
    put(overlay, 3, 3, rim);
    put(overlay, 4, 3, rim);
    // 안경 다리 (옆면 overlay)
    put(CLASSIC_LAYOUT.head.overlay.right, 7, 3, rim);
    put(CLASSIC_LAYOUT.head.overlay.right, 6, 3, rim);
    put(CLASSIC_LAYOUT.head.overlay.left, 0, 3, rim);
    put(CLASSIC_LAYOUT.head.overlay.left, 1, 3, rim);
  }
}

/** 좌표 해시 기반 결정적 지터 색 (머리카락 질감용) */
function hairPixel(color: Rgb, gx: number, gy: number, jitter: number): Rgb {
  const hash = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
  const f = 1 + (((hash % 200) - 100) / 100) * jitter;
  return shadeRgb(color, f);
}

/**
 * 외곽 머리 전용 4단계 색 램프.
 * 검은 머리는 단순 곱셈으로 명암을 줘도 모두 검게 뭉치므로, 따뜻한 중성색을
 * 소량 혼합해 base와 overlay의 높이 차가 3D 뷰에서 읽히게 한다.
 */
function hairVolumePixel(color: Rgb, gx: number, gy: number): Rgb {
  const hash = ((gx * 83492791) ^ (gy * 2971215073)) >>> 0;
  switch (hash % 7) {
    case 0:
      return mixRgb(shadeRgb(color, 0.76), [0, 0, 0], 0.12);
    case 1:
    case 2:
      return shadeRgb(color, 0.9);
    case 3:
    case 4:
      return mixRgb(color, [112, 104, 98], 0.09);
    default:
      return mixRgb(color, [132, 122, 114], 0.17);
  }
}

/**
 * 헤어스타일 구조적 합성 (클라이언트 절차 생성기의 검증된 구조 이식).
 *
 * 렌더가 실제로 보여주는 곳은 렌더를 우선한다:
 * - 앞머리 실루엣: composeFace가 렌더에서 가져옴 (여기서는 건드리지 않음)
 * - 뒤통수: 뒷면 뷰 렌더가 있으면 base를 유지
 * 렌더가 못 채우는 곳을 hairstyle 분류로 완성한다:
 * - 옆면 머리 길이, overlay 볼륨(정수리·이마 위), 장발의 어깨선(몸통 overlay),
 *   포니테일/번/양갈래/아프로·곱슬 볼륨
 * 모자를 쓴 인물은 렌더의 머리 영역이 이미 모자이므로 전부 생략한다.
 */
function composeHair(
  atlas: RawImage,
  hairColor: Rgb,
  style: FaceStyle,
  hasBackView: boolean,
): void {
  if (style.hairstyle === "bald" || style.hat !== "none") {
    return;
  }
  const base = CLASSIC_LAYOUT.head.base;
  const over = CLASSIC_LAYOUT.head.overlay;
  const s = style.hairstyle;
  const textured =
    s === "curly" ||
    s === "afro" ||
    style.hairTexture === "curly" ||
    style.hairTexture === "coily";
  const jitter = textured ? 0.12 : style.hairTexture === "wavy" ? 0.085 : 0.06;

  const fill = (
    rect: Rect,
    x0: number,
    y0: number,
    w: number,
    h: number,
    volume = false,
  ) => {
    for (let y = y0; y < Math.min(rect.h, y0 + h); y++) {
      for (let x = x0; x < Math.min(rect.w, x0 + w); x++) {
        const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
        const c = volume
          ? hairVolumePixel(hairColor, rect.x + x, rect.y + y)
          : hairPixel(hairColor, rect.x + x, rect.y + y, jitter);
        atlas.rgba[d] = c[0];
        atlas.rgba[d + 1] = c[1];
        atlas.rgba[d + 2] = c[2];
        atlas.rgba[d + 3] = 255;
      }
    }
  };
  const volumeMask = (rect: Rect, rows: number[][]) => {
    for (let y = 0; y < Math.min(rect.h, rows.length); y++) {
      for (const x of rows[y]) {
        if (x >= 0 && x < rect.w) fill(rect, x, y, 1, 1, true);
      }
    }
  };
  const putColor = (rect: Rect, x: number, y: number, color: Rgb) => {
    if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return;
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = color[0];
    atlas.rgba[d + 1] = color[1];
    atlas.rgba[d + 2] = color[2];
    atlas.rgba[d + 3] = 255;
  };

  // 스타일별 옆/뒷머리 길이 (클라이언트와 동일 값)
  const baseSideRows =
    s === "buzz"
      ? 1
      : s === "short"
        ? 3
        : s === "medium" || s === "curly"
          ? 5
          : s === "bun" || s === "ponytail"
            ? 2
            : s === "afro"
              ? 3
              : 8; // long, twintails
  const sideHairRowsFromHint =
    style.sideHairLength === "none"
      ? 1
      : style.sideHairLength === "cheek"
        ? 4
        : style.sideHairLength === "jaw"
          ? 6
          : style.sideHairLength === "shoulder"
            ? 8
            : 3;
  const sideRows = Math.max(baseSideRows, sideHairRowsFromHint);
  const backRows =
    s === "buzz"
      ? 2
      : s === "short"
        ? 4
        : s === "medium" || s === "curly"
          ? 6
          : s === "bun" || s === "ponytail"
            ? 3
            : s === "afro"
              ? 4
              : 8;

  // 옆머리 (렌더는 가장자리 확장뿐이라 항상 카테고리로 채움)
  fill(base.right, 0, 0, 8, sideRows);
  fill(base.left, 0, 0, 8, sideRows);
  // 뒷머리: 뒷면 뷰 렌더가 있으면 실제 렌더 유지
  if (!hasBackView) {
    fill(base.back, 0, 0, 8, backRows);
  }
  // 정수리는 base가 이미 hairColor — overlay 볼륨만 추가

  // 긴 머리: 얼굴 옆 라인 (front 양끝 세로줄)
  if (s === "long" || s === "twintails") {
    fill(base.front, 0, 0, 1, 6);
    fill(base.front, 7, 0, 1, 6);
  }

  // ---- overlay 볼륨 ----
  // 정수리→관자놀이→뒤통수가 한 덩어리로 읽히도록 각 면의 경계 픽셀을 연결한다.
  // 모서리와 마지막 행은 비대칭 계단형으로 비워 블록형 헬멧 실루엣을 피한다.
  if (style.hairVolume === "full") {
    volumeMask(over.top, [
      [1, 2, 3, 4, 5, 6],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [1, 2, 3, 5, 6],
    ]);
  } else if (style.hairVolume === "flat") {
    volumeMask(over.top, [
      [],
      [],
      [2, 3, 4, 5],
      [1, 2, 3, 4, 5, 6],
      [1, 2, 3, 4, 5, 6],
      [2, 3, 4, 5],
    ]);
  } else {
    volumeMask(over.top, [
      [1, 2, 3, 4, 5, 6],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [0, 1, 2, 3, 4, 5, 6, 7],
      [1, 2, 4, 5, 6],
    ]);
  }
  volumeMask(over.front, [[1, 2, 3, 4, 5, 6]]);

  const sideVolumeRows =
    s === "buzz"
      ? 1
      : s === "short"
        ? 3
        : s === "medium" || s === "curly"
          ? 5
          : Math.min(7, sideRows);
  const sideMaskTemplate =
    style.hairVolume === "full"
      ? [
          [0, 1, 2, 3, 4, 5, 6, 7],
          [0, 1, 2, 3, 4, 5, 6, 7],
          [0, 1, 2, 3, 4, 5, 6, 7],
          [0, 1, 2, 3, 5, 6, 7],
          [0, 1, 2, 5, 6, 7],
          [0, 1, 6, 7],
          [0, 7],
        ]
      : style.hairVolume === "flat"
        ? [
            [1, 2, 3, 4, 5, 6],
            [0, 1, 2, 3, 4, 5, 6, 7],
          ]
        : [
            [0, 1, 2, 3, 4, 5, 6, 7],
            [0, 1, 2, 3, 4, 5, 6, 7],
            [0, 1, 2, 5, 6, 7],
            [0, 1, 2, 6, 7],
            [0, 1, 6, 7],
            [0, 7],
            [0, 7],
          ];
  const sideMask: number[][] = sideMaskTemplate.slice(0, sideVolumeRows);
  volumeMask(over.right, sideMask);
  volumeMask(
    over.left,
    sideMask.map((row) => row.map((x) => 7 - x)),
  );

  const backVolumeRows =
    s === "buzz"
      ? 2
      : s === "short"
        ? 4
        : s === "medium" || s === "curly"
          ? 6
          : Math.min(8, backRows);
  const backMask: number[][] = [];
  for (let y = 0; y < backVolumeRows; y++) {
    if (y === 0) backMask.push([1, 2, 3, 4, 5, 6]);
    else if (y === backVolumeRows - 1) backMask.push([1, 2, 3, 5, 6]);
    else backMask.push([0, 1, 2, 3, 4, 5, 6, 7]);
  }
  volumeMask(over.back, backMask);
  const hairBackShape =
    style.hairBackShape ??
    (s === "long" || s === "twintails"
      ? "long"
      : s === "ponytail" || s === "bun"
        ? "tied"
        : s === "buzz"
          ? "undercut"
          : "tapered");
  const backHairColor = (x: number, y: number, shade = 1) =>
    shadeRgb(hairVolumePixel(hairColor, over.back.x + x, over.back.y + y), shade);
  const connectBackEdge = (y: number) => {
    const leftBack = backHairColor(0, y, 0.92);
    const rightBack = backHairColor(7, y, 0.92);
    putColor(over.back, 0, y, leftBack);
    putColor(over.back, 7, y, rightBack);
    putColor(over.right, 7, y, leftBack);
    putColor(over.left, 0, y, rightBack);
  };
  if (hairBackShape === "rounded") {
    for (let y = 1; y < Math.min(7, backVolumeRows + 1); y++) {
      connectBackEdge(y);
      if (y >= 4) {
        putColor(over.back, 1, y, backHairColor(1, y, 0.86));
        putColor(over.back, 6, y, backHairColor(6, y, 0.86));
      }
    }
    for (const x of [2, 3, 4, 5]) putColor(over.back, x, 6, backHairColor(x, 6, 0.72));
  } else if (hairBackShape === "long") {
    for (let y = 2; y < 8; y++) {
      connectBackEdge(y);
      for (const x of [1, 2, 5, 6]) putColor(over.back, x, y, backHairColor(x, y, y >= 6 ? 0.68 : 0.9));
      if (y >= 4) {
        putColor(over.back, 3, y, backHairColor(3, y, 0.78));
        putColor(over.back, 4, y, backHairColor(4, y, 0.78));
      }
    }
  } else if (hairBackShape === "tied") {
    for (let y = 2; y < 8; y++) {
      putColor(over.back, 3, y, backHairColor(3, y, y === 4 ? 0.62 : 0.86));
      putColor(over.back, 4, y, backHairColor(4, y, y === 4 ? 0.62 : 0.86));
    }
    for (const [x, y] of [[2, 3], [5, 3], [2, 4], [5, 4]] as const) {
      putColor(over.back, x, y, backHairColor(x, y, 0.72));
    }
  } else if (hairBackShape === "undercut") {
    for (let y = 0; y < Math.min(4, over.back.h); y++) {
      for (let x = 0; x < over.back.w; x++) putColor(over.back, x, y, backHairColor(x, y, y === 3 ? 0.74 : 0.94));
    }
    for (const [x, y] of [[2, 4], [3, 4], [4, 4], [5, 4], [3, 5], [4, 5]] as const) {
      putColor(over.back, x, y, backHairColor(x, y, 0.58));
    }
  } else {
    for (let y = 2; y < Math.min(6, over.back.h); y++) connectBackEdge(y);
    for (const [x, y] of [[2, 5], [3, 5], [4, 5], [5, 5], [3, 6], [4, 6]] as const) {
      putColor(over.back, x, y, backHairColor(x, y, y === 6 ? 0.62 : 0.78));
    }
  }

  const sideEdgeRows =
    style.hairVolume === "flat"
      ? Math.min(2, sideVolumeRows)
      : Math.min(7, Math.max(sideVolumeRows, s === "medium" || s === "curly" ? 5 : sideRows));
  const templeRows =
    s === "buzz"
      ? 1
      : s === "short" || s === "bun" || s === "ponytail"
        ? 3
        : s === "medium" || s === "curly" || s === "afro"
          ? 4
          : 6;
  const frontSeamRows =
    style.hairVolume === "flat"
      ? Math.min(2, templeRows)
      : Math.min(6, Math.max(1, Math.min(templeRows, sideEdgeRows)));
  const backSeamRows = Math.min(backVolumeRows, Math.max(2, sideEdgeRows));

  // UV seam guard: the head overlay is rendered as a slightly larger cube.
  // If one face's edge is transparent while the adjacent face has hair,
  // the 3D preview shows a visible crack. Paint matching edge bands on
  // front/right/left/back/top so side hair reads as one continuous volume.
  for (let y = 0; y < sideEdgeRows; y++) {
    fill(over.right, 0, y, 1, 1, true);
    fill(over.right, 7, y, 1, 1, true);
    fill(over.left, 0, y, 1, 1, true);
    fill(over.left, 7, y, 1, 1, true);
  }
  for (let y = 0; y < frontSeamRows; y++) {
    fill(over.front, 0, y, 1, 1, true);
    fill(over.front, 7, y, 1, 1, true);
    if (y <= 1 && s !== "buzz") {
      fill(over.front, 1, y, 1, 1, true);
      fill(over.front, 6, y, 1, 1, true);
    }
  }
  for (let y = 0; y < backSeamRows; y++) {
    fill(over.back, 0, y, 1, 1, true);
    fill(over.back, 7, y, 1, 1, true);
  }
  for (let x = 1; x < 7; x++) {
    fill(over.top, x, 0, 1, 1, true);
    fill(over.top, x, 7, 1, 1, true);
  }
  for (let y = 1; y < 7; y++) {
    fill(over.top, 0, y, 1, 1, true);
    fill(over.top, 7, y, 1, 1, true);
  }

  const partAccent = mixRgb(hairColor, [238, 220, 198], 0.22);
  const partShadow = shadeRgb(hairColor, 0.66);
  const hairPart = style.hairPart ?? "none";
  if (hairPart === "center") {
    for (let y = 1; y < 6; y++) {
      putColor(over.top, 3, y, y % 2 === 0 ? partAccent : partShadow);
      putColor(over.top, 4, y, y % 2 === 0 ? partShadow : partAccent);
    }
    putColor(over.front, 3, 0, partAccent);
    putColor(over.front, 4, 0, partShadow);
  } else if (hairPart === "left" || hairPart === "right") {
    const mirror = hairPart === "right";
    const px = (x: number) => (mirror ? 7 - x : x);
    for (const [x, y, light] of [
      [2, 1, true],
      [3, 2, true],
      [3, 3, false],
      [4, 4, false],
    ] as const) {
      putColor(over.top, px(x), y, light ? partAccent : partShadow);
    }
    putColor(over.front, px(2), 0, partAccent);
    putColor(over.front, px(3), 1, partShadow);
  }

  const sideHairLength = style.sideHairLength ?? "short";
  if (sideHairLength === "cheek" || sideHairLength === "jaw" || sideHairLength === "shoulder") {
    const lastLockRow =
      sideHairLength === "cheek" ? 4 : sideHairLength === "jaw" ? 6 : 7;
    const maxDepth =
      sideHairLength === "cheek" ? 2 : sideHairLength === "jaw" ? 3 : 4;
    const sideLockColor = (seed: number, y: number, x = 0, shade = 1) =>
      shadeRgb(hairVolumePixel(hairColor, seed + x, over.front.y + y), shade);
    const sideDepthForRow = (y: number) => {
      if (sideHairLength === "cheek") return y <= 3 ? 2 : 1;
      const taper = y >= lastLockRow - 1 ? 1 : 0;
      return Math.max(1, maxDepth - taper);
    };

    for (let y = 2; y <= lastLockRow; y++) {
      const depth = sideDepthForRow(y);
      const leftLock = sideLockColor(1301, y);
      const rightLock = sideLockColor(1703, y);
      const leftShadow = shadeRgb(leftLock, 0.76);
      const rightShadow = shadeRgb(rightLock, 0.76);

      putColor(over.front, 0, y, leftLock);
      putColor(over.front, 7, y, rightLock);
      if (depth >= 3 && y >= 4) {
        putColor(over.front, 1, y, leftShadow);
        putColor(over.front, 6, y, rightShadow);
      }
      for (let x = 0; x < depth; x++) {
        const shade = x === 0 ? 1 : x === 1 ? 0.88 : 0.72;
        putColor(over.right, x, y, sideLockColor(1301, y, x, shade));
        putColor(over.left, 7 - x, y, sideLockColor(1703, y, x, shade));
      }
      putColor(over.right, 7, y, shadeRgb(leftLock, 0.7));
      putColor(over.left, 0, y, shadeRgb(rightLock, 0.7));
      putColor(over.back, 7, y, shadeRgb(leftLock, 0.72));
      putColor(over.back, 0, y, shadeRgb(rightLock, 0.72));
      putColor(over.top, 0, Math.min(7, y), shadeRgb(leftLock, 1.04));
      putColor(over.top, 7, Math.min(7, y), shadeRgb(rightLock, 1.04));
      if (y >= 4) {
        putColor(over.right, Math.min(depth, 3), y, shadeRgb(leftShadow, 0.82));
        putColor(over.left, Math.max(4, 7 - depth), y, shadeRgb(rightShadow, 0.82));
      }
    }
    if (sideHairLength === "shoulder") {
      const bodyOver = CLASSIC_LAYOUT.body.overlay;
      const bodyHair = (rect: Rect, x: number, y: number, shade = 1) =>
        shadeRgb(hairVolumePixel(hairColor, rect.x + x, rect.y + y), shade);
      for (let y = 0; y < 7; y++) {
        const leftX = y % 3 === 1 ? 1 : 0;
        const rightX = y % 3 === 1 ? 6 : 7;
        putColor(bodyOver.front, leftX, y, bodyHair(bodyOver.front, leftX, y, y >= 5 ? 0.72 : 0.94));
        putColor(bodyOver.front, rightX, y, bodyHair(bodyOver.front, rightX, y, y >= 5 ? 0.72 : 0.94));
        if (y <= 4 || y % 2 === 0) {
          putColor(bodyOver.front, Math.min(2, leftX + 1), y, bodyHair(bodyOver.front, Math.min(2, leftX + 1), y, 0.74));
          putColor(bodyOver.front, Math.max(5, rightX - 1), y, bodyHair(bodyOver.front, Math.max(5, rightX - 1), y, 0.74));
        }
        putColor(bodyOver.right, y % 2, y, bodyHair(bodyOver.right, y % 2, y, 0.82));
        putColor(bodyOver.left, 3 - (y % 2), y, bodyHair(bodyOver.left, 3 - (y % 2), y, 0.82));
      }
      for (let y = 0; y < 8; y++) {
        putColor(bodyOver.back, 0, y, bodyHair(bodyOver.back, 0, y, y >= 6 ? 0.62 : 0.86));
        putColor(bodyOver.back, 7, y, bodyHair(bodyOver.back, 7, y, y >= 6 ? 0.62 : 0.86));
        if (hairBackShape === "long" && y >= 2) {
          putColor(bodyOver.back, 3, y, bodyHair(bodyOver.back, 3, y, y >= 6 ? 0.6 : 0.78));
          putColor(bodyOver.back, 4, y, bodyHair(bodyOver.back, 4, y, y >= 6 ? 0.6 : 0.78));
        }
      }
    }
  }
  if (hairBackShape === "long" || hairBackShape === "rounded" || hairBackShape === "tapered") {
    const edgeRows =
      hairBackShape === "long" ? 8 : hairBackShape === "rounded" ? 7 : Math.min(6, over.back.h);
    for (let y = 2; y < edgeRows; y++) connectBackEdge(y);
  }

  const strandLight = mixRgb(
    hairColor,
    [242, 232, 220],
    style.hairTexture === "wavy" || style.hairTexture === "curly" ? 0.2 : 0.13,
  );
  const strandDark = shadeRgb(hairColor, 0.58);
  const strandMid = shadeRgb(hairColor, 0.82);
  const paintStrand = (rect: Rect, x: number, y: number, phase = 0) => {
    putColor(rect, x, y, (x + y + phase) % 3 === 0 ? strandLight : strandDark);
  };
  const hairSilhouette =
    style.hairSilhouette ?? (style.hairVolume === "flat" ? "flat" : "rounded");
  const outlineLight = mixRgb(hairColor, strandLight, 0.28);
  const outlineDark = shadeRgb(hairColor, 0.54);
  const outlineMid = shadeRgb(hairColor, 0.76);
  if (hairSilhouette === "rounded") {
    for (const [rect, points] of [
      [over.top, [[1, 1], [2, 0], [3, 0], [4, 0], [5, 0], [6, 1], [0, 2], [7, 2]]],
      [over.front, [[0, 0], [1, 0], [6, 0], [7, 0], [0, 1], [7, 1]]],
      [over.right, [[0, 0], [1, 0], [0, 1], [1, 1]]],
      [over.left, [[6, 0], [7, 0], [6, 1], [7, 1]]],
    ] as const) {
      for (const [x, y] of points) putColor(rect, x, y, outlineLight);
    }
  } else if (hairSilhouette === "flat") {
    for (let x = 1; x < 7; x++) {
      putColor(over.top, x, 1, x % 2 === 0 ? outlineMid : outlineDark);
      putColor(over.front, x, 0, outlineDark);
    }
  } else if (hairSilhouette === "swept") {
    const mirror = style.hairPart === "right";
    const px = (x: number) => (mirror ? 7 - x : x);
    for (const [x, y, color] of [
      [1, 1, outlineLight],
      [2, 1, outlineLight],
      [3, 2, outlineMid],
      [4, 2, outlineMid],
      [5, 3, outlineDark],
      [6, 4, outlineDark],
    ] as const) {
      putColor(over.top, px(x), y, color);
    }
    for (const [x, y] of [[0, 1], [1, 1], [2, 2], [3, 2]] as const) {
      putColor(over.front, px(x), y, x <= 1 ? outlineLight : outlineMid);
    }
    putColor(mirror ? over.left : over.right, mirror ? 7 : 0, 2, outlineDark);
    putColor(mirror ? over.left : over.right, mirror ? 6 : 1, 3, outlineDark);
  } else if (hairSilhouette === "tousled" || hairSilhouette === "spiky") {
    const tufts =
      hairSilhouette === "spiky"
        ? ([[1, 0], [2, 1], [4, 0], [5, 1], [6, 0]] as const)
        : ([[1, 1], [2, 0], [4, 1], [5, 0], [6, 2]] as const);
    for (const [x, y] of tufts) {
      putColor(over.top, x, y, (x + y) % 2 === 0 ? outlineLight : outlineDark);
      putColor(over.front, x, Math.min(2, y + 1), outlineMid);
    }
    putColor(over.right, 0, 1, outlineDark);
    putColor(over.left, 7, 1, outlineDark);
  }
  if (style.hairTexture === "wavy" || style.hairTexture === "curly") {
    for (const [rect, mirror] of [
      [over.right, false],
      [over.left, true],
      [over.back, false],
    ] as const) {
      for (let y = 1; y < Math.min(rect.h, sideEdgeRows + 1); y++) {
        const waveX = mirror ? 6 - (y % 3) : 1 + (y % 3);
        paintStrand(rect, waveX, y, mirror ? 1 : 0);
        if (y % 2 === 0) paintStrand(rect, mirror ? waveX - 1 : waveX + 1, y, 2);
      }
    }
  } else {
    for (const rect of [over.right, over.left, over.back]) {
      for (let y = 1; y < Math.min(rect.h, sideEdgeRows + 1); y += 2) {
        paintStrand(rect, 1, y);
        paintStrand(rect, rect.w - 2, y + 1 < rect.h ? y + 1 : y, 1);
      }
    }
  }
  if (hairPart === "center") {
    for (let y = 1; y < 6; y++) {
      putColor(over.top, 2, y, y % 2 === 0 ? strandMid : strandLight);
      putColor(over.top, 5, y, y % 2 === 0 ? strandLight : strandMid);
    }
  } else if (hairPart === "left" || hairPart === "right") {
    const mirror = hairPart === "right";
    for (let y = 1; y < 6; y++) {
      const x = mirror ? 6 - Math.floor(y / 2) : 1 + Math.floor(y / 2);
      putColor(over.top, x, y, y % 2 === 0 ? strandLight : strandMid);
    }
  }
  for (const [x, y, color] of [
    [1, 2, strandLight],
    [3, 2, strandMid],
    [5, 2, strandLight],
    [6, 3, strandDark],
  ] as const) {
    putColor(over.front, x, y, color);
  }

  const bangTone = (x: number, y: number) => {
    const baseTone = hairVolumePixel(hairColor, over.front.x + x, over.front.y + y);
    if ((x + y) % 4 === 0) return mixRgb(baseTone, strandLight, 0.32);
    if ((x + y) % 3 === 0) return shadeRgb(baseTone, 0.7);
    return baseTone;
  };
  const paintBang = (x: number, y: number, shade = 1) =>
    putColor(over.front, x, y, shadeRgb(bangTone(x, y), shade));
  const wrapTemple = (y: number, leftShade = 0.92, rightShade = 0.92) => {
    const left = shadeRgb(bangTone(0, y), leftShade);
    const right = shadeRgb(bangTone(7, y), rightShade);
    putColor(over.front, 0, y, left);
    putColor(over.front, 7, y, right);
    putColor(over.right, 0, y, left);
    putColor(over.left, 7, y, right);
    putColor(over.top, 0, Math.min(7, y + 1), shadeRgb(left, 1.04));
    putColor(over.top, 7, Math.min(7, y + 1), shadeRgb(right, 1.04));
  };
  if (style.bangs === "straight") {
    for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) paintBang(x, 1);
    for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) paintBang(x, 2, x === 3 || x === 4 ? 0.84 : 0.96);
    for (const x of [0, 2, 5, 7]) paintBang(x, 3, 0.74);
    wrapTemple(2);
    wrapTemple(3, 0.76, 0.76);
  } else if (style.bangs === "side") {
    const mirror = style.hairPart === "right";
    const px = (x: number) => (mirror ? 7 - x : x);
    for (const x of [0, 1, 2, 3, 4, 5, 6]) paintBang(px(x), 1, x < 3 ? 1.04 : 0.9);
    for (const x of [0, 1, 2, 3, 4]) paintBang(px(x), 2, x < 2 ? 0.86 : 0.98);
    for (const x of [0, 1, 2]) paintBang(px(x), 3, 0.72);
    wrapTemple(2, mirror ? 0.78 : 1, mirror ? 1 : 0.78);
  } else if (style.bangs === "curtain") {
    for (const x of [0, 1, 2, 5, 6, 7]) paintBang(x, 1);
    for (const x of [0, 1, 6, 7]) paintBang(x, 2, 0.88);
    for (const x of [0, 7]) paintBang(x, 3, 0.74);
    putColor(over.front, 3, 1, partAccent);
    putColor(over.front, 4, 1, partShadow);
    wrapTemple(2);
    wrapTemple(3, 0.78, 0.78);
  } else if (style.bangs === "wispy") {
    for (const x of [1, 3, 5, 7]) paintBang(x, 1, 1.06);
    for (const x of [2, 5]) paintBang(x, 2, 0.9);
    for (const x of [1, 4, 7]) paintBang(x, 3, 0.74);
    wrapTemple(2, 0.82, 0.82);
  }
  const bangsLength =
    style.bangs === "none" ? "none" : (style.bangsLength ?? "brow");
  if (bangsLength === "brow" || bangsLength === "eye") {
    if (style.bangs === "straight") {
      for (const x of [1, 3, 4, 6]) paintBang(x, 3, 0.66);
      wrapTemple(3, 0.72, 0.72);
      if (bangsLength === "eye") {
        for (const x of [2, 3, 5]) paintBang(x, 4, 0.58);
        putColor(over.front, 4, 4, shadeRgb(bangTone(4, 4), 0.52));
      }
    } else if (style.bangs === "side") {
      const mirror = style.hairPart === "right";
      const px = (x: number) => (mirror ? 7 - x : x);
      for (const x of [0, 1, 3]) paintBang(px(x), 3, x === 0 ? 0.62 : 0.78);
      if (bangsLength === "eye") {
        for (const x of [0, 2]) paintBang(px(x), 4, x === 0 ? 0.54 : 0.64);
      }
      wrapTemple(3, mirror ? 0.68 : 0.9, mirror ? 0.9 : 0.68);
    } else if (style.bangs === "curtain") {
      for (const x of [0, 1, 6, 7]) paintBang(x, 3, 0.66);
      if (bangsLength === "eye") {
        for (const x of [1, 6]) paintBang(x, 4, 0.56);
      }
      wrapTemple(3, 0.7, 0.7);
    } else if (style.bangs === "wispy") {
      for (const x of [1, 4, 7]) paintBang(x, 3, 0.62);
      if (bangsLength === "eye") {
        for (const x of [2, 5]) paintBang(x, 4, 0.56);
      }
    }
  }

  if (s === "afro" || s === "curly" || style.hairTexture === "coily") {
    const rows = s === "afro" ? 4 : 2;
    fill(over.front, 0, 0, 8, rows, true);
    fill(over.right, 0, 0, 8, rows + 1, true);
    fill(over.left, 0, 0, 8, rows + 1, true);
    fill(over.back, 0, 0, 8, rows + 1, true);
  }
  if (s === "long") {
    // 어깨까지 내려오는 뒷머리 (몸통 뒤 overlay) + 옆 볼륨
    fill(CLASSIC_LAYOUT.body.overlay.back, 0, 0, 8, 4, true);
    fill(CLASSIC_LAYOUT.body.overlay.back, 1, 4, 6, 1, true);
    fill(over.right, 0, 0, 8, 6, true);
    fill(over.left, 0, 0, 8, 6, true);
  }
  if (s === "ponytail") {
    fill(over.back, 2, 1, 4, 7, true);
    fill(CLASSIC_LAYOUT.body.overlay.back, 3, 0, 2, 4, true);
  }
  if (s === "bun") {
    fill(over.back, 2, 0, 4, 3, true);
    fill(over.top, 2, 5, 4, 3, true);
  }
  if (s === "twintails") {
    fill(over.right, 5, 0, 3, 8, true);
    fill(over.left, 0, 0, 3, 8, true);
    fill(CLASSIC_LAYOUT.body.overlay.right, 0, 0, 4, 4, true);
    fill(CLASSIC_LAYOUT.body.overlay.left, 0, 0, 4, 4, true);
  }

  const accessory = style.hairAccessory ?? "none";
  if (accessory !== "none") {
    const flowerPetal: Rgb = [236, 184, 192];
    const flowerShade: Rgb = [205, 138, 153];
    const flowerCenter: Rgb = [238, 213, 166];
    const leaf: Rgb = [126, 151, 126];
    const ribbon: Rgb = [228, 184, 198];
    const ribbonDark: Rgb = [174, 116, 134];
    const clip: Rgb = [220, 210, 196];
    const drawFlower = (rect: Rect, cx: number, cy: number) => {
      putColor(rect, cx, cy - 1, flowerPetal);
      putColor(rect, cx - 1, cy, flowerPetal);
      putColor(rect, cx + 1, cy, flowerShade);
      putColor(rect, cx, cy + 1, flowerShade);
      putColor(rect, cx, cy, flowerCenter);
    };
    const drawRibbon = (rect: Rect, cx: number, cy: number) => {
      putColor(rect, cx - 1, cy, ribbon);
      putColor(rect, cx + 1, cy, ribbon);
      putColor(rect, cx, cy, ribbonDark);
      putColor(rect, cx - 2, cy - 1, shadeRgb(ribbon, 1.06));
      putColor(rect, cx + 2, cy - 1, shadeRgb(ribbon, 0.92));
    };

    if (accessory === "flower") {
      drawFlower(over.front, 1, 2);
      drawFlower(over.front, 0, 4);
      putColor(over.front, 2, 1, leaf);
      putColor(over.front, 1, 4, leaf);
      drawFlower(over.right, 6, 2);
      drawFlower(over.right, 6, 4);
      putColor(over.right, 5, 1, leaf);
      putColor(over.right, 5, 3, leaf);
      putColor(over.right, 7, 4, flowerShade);
      drawFlower(over.top, 2, 5);
      putColor(over.top, 1, 4, leaf);
      putColor(over.top, 1, 6, flowerPetal);
      putColor(over.top, 2, 6, leaf);
      putColor(over.top, 3, 6, leaf);
      putColor(over.top, 2, 7, flowerShade);
      putColor(over.back, 0, 3, flowerPetal);
      putColor(over.back, 0, 4, flowerShade);
      putColor(over.back, 1, 3, leaf);
    } else if (accessory === "bow" || accessory === "ribbon") {
      drawRibbon(over.front, 1, 2);
      drawRibbon(over.right, 6, 2);
      putColor(over.top, 1, 6, ribbon);
    } else if (accessory === "clip") {
      for (const [x, y] of [[0, 2], [1, 2], [2, 2], [1, 3]] as const) {
        putColor(over.front, x, y, clip);
      }
      putColor(over.right, 6, 2, clip);
      putColor(over.right, 5, 2, shadeRgb(clip, 0.86));
    }
  }

  // 옆면 overlay를 머리로 채우며 안경 다리가 덮였을 수 있어 다시 그린다
  if (style.glasses !== "none") {
    const rim = hexToRgb(style.glassesColor, [34, 32, 30]);
    const put = (rect: Rect, x: number, y: number) => {
      const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      atlas.rgba[d] = rim[0];
      atlas.rgba[d + 1] = rim[1];
      atlas.rgba[d + 2] = rim[2];
      atlas.rgba[d + 3] = 255;
    };
    put(over.right, 7, 3);
    put(over.right, 6, 3);
    put(over.left, 0, 3);
    put(over.left, 1, 3);
  }
}

/**
 * 모자 overlay 볼륨 (클라이언트 절차 생성기 drawHat의 검증된 좌표 이식).
 * 모자 쓴 인물은 머리 상단 medianColor가 곧 모자 색이므로 hatColor로 그대로 쓴다.
 * base에는 렌더의 모자가 눌린 그림으로 남고, overlay가 챙/접힌 단의 두께를 만든다.
 */
function composeHat(atlas: RawImage, hatColor: Rgb, style: FaceStyle): void {
  if (style.hat === "none") {
    return;
  }
  const over = CLASSIC_LAYOUT.head.overlay;
  const put = (rect: Rect, x: number, y: number, c: Rgb) => {
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = c[0];
    atlas.rgba[d + 1] = c[1];
    atlas.rgba[d + 2] = c[2];
    atlas.rgba[d + 3] = 255;
  };
  const fill = (rect: Rect, y0: number, h: number, shade = 1) => {
    for (let y = y0; y < Math.min(rect.h, y0 + h); y++) {
      for (let x = 0; x < rect.w; x++) {
        put(rect, x, y, shadeRgb(hairPixel(hatColor, rect.x + x, rect.y + y, 0.04), shade));
      }
    }
  };
  const dark = 0.8;

  fill(over.top, 0, 8);
  if (style.hat === "cap") {
    fill(over.front, 0, 2);
    fill(over.front, 2, 1, dark); // 챙
    fill(over.right, 0, 2);
    fill(over.left, 0, 2);
    fill(over.back, 0, 2);
  } else if (style.hat === "beanie") {
    for (const rect of [over.front, over.right, over.left, over.back]) {
      fill(rect, 0, 2);
      fill(rect, 2, 1, dark); // 접힌 밑단
    }
  } else {
    // hood: 이마 + 옆/뒤 전체
    fill(over.front, 0, 2);
    fill(over.right, 0, 8);
    fill(over.left, 0, 8);
    fill(over.back, 0, 8);
    // 옆면을 전부 덮으므로 안경 다리를 다시 그린다
    if (style.glasses !== "none") {
      const rim = hexToRgb(style.glassesColor, [34, 32, 30]);
      put(over.right, 7, 3, rim);
      put(over.right, 6, 3, rim);
      put(over.left, 0, 3, rim);
      put(over.left, 1, 3, rim);
    }
  }
}

/**
 * base는 피부/옷의 실제 표면, overlay는 두께가 있는 요소만 담당한다.
 * 이미지 모델이 만든 색과 뒷면을 유지하면서 분석 힌트로 카라·겉옷 가장자리·
 * 소매 끝·목걸이·재질 패턴을 보강한다.
 */
function composeGarmentLayers(atlas: RawImage, style: FaceStyle): void {
  const sample = (rect: Rect, x: number, y: number): Rgb => {
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    return [atlas.rgba[d], atlas.rgba[d + 1], atlas.rgba[d + 2]];
  };
  const put = (rect: Rect, x: number, y: number, color: Rgb, alpha = 255) => {
    if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return;
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = color[0];
    atlas.rgba[d + 1] = color[1];
    atlas.rgba[d + 2] = color[2];
    atlas.rgba[d + 3] = alpha;
  };
  const copy = (
    src: Rect,
    dst: Rect,
    x: number,
    y: number,
    shade = 0.94,
  ) => put(dst, x, y, shadeRgb(sample(src, x, y), shade));
  const shadeBase = (rect: Rect, x: number, y: number, shade: number) => {
    put(rect, x, y, shadeRgb(sample(rect, x, y), shade));
  };
  const averageRect = (rect: Rect, y0 = 0, h = rect.h): Rgb => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(rect.h, y0 + h); y++) {
      for (let x = 0; x < rect.w; x++) {
        const c = sample(rect, x, y);
        r += c[0];
        g += c[1];
        b += c[2];
        n++;
      }
    }
    return n === 0
      ? [96, 88, 88]
      : [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  // 두께 큐: base를 어둡게만 복사하면 그림자로 읽힌다. 윗행(lit)은 빛을 받아
  // 밝게, 밑단(hem)만 어둡게 해서 overlay가 base 위의 옷감으로 분리돼 보이게 한다.
  const volumeCopy = (
    src: Rect,
    dst: Rect,
    x: number,
    y: number,
    tone: "lit" | "mid" | "hem",
  ) => {
    const hash = (((dst.x + x) * 83492791) ^ ((dst.y + y) * 2971215073)) >>> 0;
    const jitter = 1 + ((hash % 9) - 4) / 100;
    const f = tone === "lit" ? 1.09 : tone === "hem" ? 0.8 : 0.96;
    put(dst, x, y, shadeRgb(sample(src, x, y), f * jitter));
  };

  const body = CLASSIC_LAYOUT.body;
  const texture = style.garmentTexture ?? "plain";
  for (const rect of [body.base.front, body.base.back]) {
    if (texture === "knit") {
      for (let y = 1; y < rect.h - 1; y++) {
        for (const x of [1, 3, 4, 6]) {
          shadeBase(rect, x, y, (x + y) % 3 === 0 ? 1.09 : 0.91);
        }
      }
    } else if (texture === "striped") {
      for (let y = 2; y < rect.h; y += 3) {
        for (let x = 0; x < rect.w; x++) shadeBase(rect, x, y, 0.86);
      }
    } else if (texture === "denim" || texture === "leather") {
      for (let y = 0; y < rect.h; y++) {
        shadeBase(rect, 0, y, 0.84);
        shadeBase(rect, rect.w - 1, y, texture === "leather" ? 1.08 : 0.9);
      }
    } else if (texture === "patterned") {
      for (let y = 1; y < rect.h; y += 3) {
        for (let x = Math.floor(y / 3) % 2; x < rect.w; x += 3) {
          shadeBase(rect, x, y, 0.82);
        }
      }
    }
  }

  const front = body.overlay.front;
  const back = body.overlay.back;
  const baseFront = body.base.front;
  const baseBack = body.base.back;
  const layer = style.outerLayer ?? "none";
  const topType = style.topType ?? "tshirt";
  const outerGarment = style.outerGarment ?? "none";

  // 카라/목선: 가벼운 상의도 실제 옷 두께를 느낄 수 있는 최소 레이어.
  for (const [x, y] of [
    [2, 0],
    [3, 1],
    [4, 1],
    [5, 0],
  ] as const) {
    volumeCopy(baseFront, front, x, y, y === 0 ? "lit" : "mid");
  }

  if (layer !== "none" || ["sweater", "hoodie", "jacket"].includes(topType)) {
    // 어깨 솔기와 밑단
    for (let y = 0; y < front.h - 1; y++) {
      const tone = y === 0 ? "lit" : "mid";
      volumeCopy(baseFront, front, 0, y, tone);
      volumeCopy(baseFront, front, 7, y, tone);
      volumeCopy(baseBack, back, 0, y, tone);
      volumeCopy(baseBack, back, 7, y, tone);
    }
    for (let x = 0; x < front.w; x++) {
      volumeCopy(baseFront, front, x, front.h - 1, "hem");
      volumeCopy(baseBack, back, x, back.h - 1, "hem");
    }
    // 측면 연속성: 3/4 각도에서 겉옷이 앞뒤 스티커처럼 끊기지 않게 옆면도 채운다.
    for (const [srcRect, dstRect] of [
      [body.base.right, body.overlay.right],
      [body.base.left, body.overlay.left],
    ] as const) {
      for (let y = 0; y < dstRect.h - 1; y++) {
        for (let x = 0; x < dstRect.w; x++) {
          volumeCopy(srcRect, dstRect, x, y, y === 0 ? "lit" : "mid");
        }
      }
      for (let x = 0; x < dstRect.w; x++) {
        volumeCopy(srcRect, dstRect, x, dstRect.h - 1, "hem");
      }
    }
  }

  if (outerGarment !== "none") {
    const sideSample = mixRgb(sample(baseFront, 1, 5), sample(baseFront, 6, 5), 0.5);
    const backSample = averageRect(baseBack, 2, 6);
    const panelBase = mixRgb(sideSample, backSample, 0.42);
    const panelColor =
      outerGarment === "cardigan"
        ? mixRgb(panelBase, [236, 202, 204], 0.18)
        : outerGarment === "coat"
          ? shadeRgb(panelBase, 0.82)
          : outerGarment === "vest"
            ? shadeRgb(panelBase, 0.96)
            : shadeRgb(panelBase, 0.9);
    const trimColor = shadeRgb(panelColor, outerGarment === "cardigan" ? 0.74 : 0.68);
    const litPanel = shadeRgb(panelColor, 1.1);
    const hemPanel = shadeRgb(panelColor, 0.72);

    const panelXs = [0, 1, 2, 5, 6, 7] as const;
    for (let y = 0; y < front.h; y++) {
      for (const x of panelXs) {
        const edge = x === 0 || x === 7;
        const opening = x === 2 || x === 5;
        const shade =
          y === front.h - 1 ? 0.72 : y === 0 ? 1.08 : edge ? 0.86 : opening ? 0.78 : 0.98;
        put(front, x, y, shadeRgb(panelColor, shade));
      }
      put(front, 2, y, y % 3 === 0 ? trimColor : shadeRgb(trimColor, 1.08));
      put(front, 5, y, y % 3 === 0 ? shadeRgb(trimColor, 0.86) : trimColor);
    }
    for (const x of [0, 1, 2, 5, 6, 7] as const) {
      put(front, x, front.h - 1, hemPanel);
    }
    if (outerGarment === "cardigan" || outerGarment === "coat") {
      for (const [x, y] of [
        [1, 2],
        [6, 2],
        [1, 5],
        [6, 5],
        [1, 8],
        [6, 8],
      ] as const) {
        put(front, x, y, shadeRgb(panelColor, 0.82));
      }
      for (let y = front.h - 4; y < front.h; y++) {
        const lowerShade = y === front.h - 1 ? 0.62 : y % 2 === 0 ? 0.82 : 0.94;
        put(front, 0, y, shadeRgb(panelColor, lowerShade));
        put(front, 1, y, shadeRgb(panelColor, lowerShade + 0.08));
        put(front, 6, y, shadeRgb(panelColor, lowerShade + 0.04));
        put(front, 7, y, shadeRgb(panelColor, lowerShade - 0.04));
        put(front, 2, y, shadeRgb(trimColor, y === front.h - 1 ? 0.68 : 0.9));
        put(front, 5, y, shadeRgb(trimColor, y === front.h - 1 ? 0.62 : 0.84));
      }
    }

    for (let y = 0; y < back.h; y++) {
      for (let x = 0; x < back.w; x++) {
        const shade = y === back.h - 1 ? 0.72 : x === 0 || x === back.w - 1 ? 0.82 : 0.94;
        put(back, x, y, shadeRgb(panelColor, shade));
      }
      if (outerGarment === "cardigan" || outerGarment === "coat") {
        put(back, 3, y, shadeRgb(panelColor, y >= back.h - 3 ? 0.7 : 0.84));
        put(back, 4, y, shadeRgb(panelColor, y >= back.h - 3 ? 0.64 : 0.78));
      }
    }
    for (const rect of [body.overlay.right, body.overlay.left]) {
      for (let y = 0; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const shade = y === rect.h - 1 ? 0.72 : x === 0 || x === rect.w - 1 ? 0.82 : 0.96;
          put(rect, x, y, shadeRgb(panelColor, shade));
        }
        if ((outerGarment === "cardigan" || outerGarment === "coat") && y >= rect.h - 4) {
          put(rect, 0, y, shadeRgb(trimColor, y === rect.h - 1 ? 0.58 : 0.78));
          put(rect, rect.w - 1, y, shadeRgb(panelColor, y === rect.h - 1 ? 0.62 : 0.82));
        }
      }
      for (let x = 0; x < rect.w; x++) put(rect, x, 0, litPanel);
    }

    if (outerGarment !== "vest") {
      for (const part of ["rightArm", "leftArm"] as const) {
        const arm = CLASSIC_LAYOUT[part];
        for (const faceName of ["front", "back", "right", "left"] as const) {
          const dst = arm.overlay[faceName];
          for (let y = 0; y < dst.h; y++) {
            for (let x = 0; x < dst.w; x++) {
              const cuff = y >= dst.h - 2;
              const edge = x === 0 || x === dst.w - 1;
              const shade = cuff ? 0.72 : y === 0 ? 1.06 : edge ? 0.84 : 0.96;
              put(dst, x, y, shadeRgb(panelColor, shade));
            }
          }
        }
      }
    }
  }

  if (topType === "jacket" && outerGarment === "none") {
    for (let y = 0; y < front.h; y++) {
      copy(baseFront, front, 2, y, 0.78);
      copy(baseFront, front, 5, y, 0.78);
    }
  } else if (topType === "hoodie") {
    for (let x = 1; x < 7; x++) {
      volumeCopy(baseBack, back, x, 0, "lit");
      volumeCopy(baseBack, back, x, 1, "mid");
    }
    for (let x = 1; x < 7; x++) volumeCopy(baseFront, front, x, 9, "mid");
  } else if (topType === "sweater") {
    for (let x = 1; x < 7; x++) volumeCopy(baseFront, front, x, 0, "lit");
  }

  const neckAccessory = style.neckAccessory ?? "none";
  if (neckAccessory !== "none") {
    const paleAccent = mixRgb(averageRect(baseFront, 0, 2), [255, 250, 242], 0.72);
    const accentShadow = shadeRgb(paleAccent, 0.72);
    const darkAccent = shadeRgb(averageRect(baseFront, 2, 3), 0.48);
    if (neckAccessory === "bow") {
      put(front, 2, 1, paleAccent);
      put(front, 5, 1, paleAccent);
      put(front, 3, 1, accentShadow);
      put(front, 4, 1, accentShadow);
      put(front, 2, 2, shadeRgb(paleAccent, 0.92));
      put(front, 5, 2, shadeRgb(paleAccent, 0.86));
      put(front, 3, 3, paleAccent);
      put(front, 4, 3, shadeRgb(paleAccent, 0.9));
    } else if (neckAccessory === "tie") {
      put(front, 3, 1, darkAccent);
      put(front, 4, 1, darkAccent);
      put(front, 3, 2, shadeRgb(darkAccent, 1.08));
      put(front, 4, 2, darkAccent);
      put(front, 3, 3, darkAccent);
      put(front, 4, 3, shadeRgb(darkAccent, 0.82));
      put(front, 3, 4, shadeRgb(darkAccent, 0.72));
    } else if (neckAccessory === "scarf") {
      for (const [x, y] of [[2, 0], [3, 0], [4, 0], [5, 0], [2, 1], [5, 1]] as const) {
        put(front, x, y, paleAccent);
      }
      put(front, 3, 2, accentShadow);
      put(front, 4, 3, accentShadow);
    } else if (neckAccessory === "collar") {
      for (const [x, y] of [[1, 0], [2, 0], [5, 0], [6, 0], [2, 1], [5, 1]] as const) {
        put(front, x, y, paleAccent);
      }
    }
  }

  const necklace = style.necklace ?? "none";
  if (necklace !== "none") {
    const chain: Rgb =
      necklace === "silver"
        ? [205, 211, 218]
        : necklace === "gold"
          ? [224, 181, 67]
          : [65, 60, 58];
    for (const [x, y] of [
      [2, 1],
      [5, 1],
      [3, 2],
      [4, 2],
      [3, 3],
      [4, 3],
    ] as const) {
      put(front, x, y, chain);
    }
    put(front, 3, 4, shadeRgb(chain, 1.08));
    put(front, 4, 4, shadeRgb(chain, 0.82));
  }

  // 긴 소매의 커프는 팔 overlay로 분리해 몸통과 팔의 입체 경계를 만든다.
  if (
    style.sleeveLength === "long" ||
    ["sweater", "hoodie", "jacket"].includes(topType)
  ) {
    for (const part of ["rightArm", "leftArm"] as const) {
      const arm = CLASSIC_LAYOUT[part];
      for (const faceName of ["front", "back", "right", "left"] as const) {
        const src = arm.base[faceName];
        const dst = arm.overlay[faceName];
        for (let x = 0; x < dst.w; x++) {
          volumeCopy(src, dst, x, dst.h - 2, "lit");
          if (layer === "heavy") volumeCopy(src, dst, x, dst.h - 1, "hem");
        }
      }
    }
  }

  // 바지 허리단은 4면으로 둘러 3/4 각도에서도 이어진다.
  if (style.bottomType === "jeans" || style.bottomType === "pants") {
    for (const part of ["rightLeg", "leftLeg"] as const) {
      const leg = CLASSIC_LAYOUT[part];
      for (const faceName of ["front", "back", "right", "left"] as const) {
        for (let x = 0; x < leg.overlay[faceName].w; x++) {
          volumeCopy(leg.base[faceName], leg.overlay[faceName], x, 0, "lit");
        }
      }
      copy(leg.base.front, leg.overlay.front, part === "rightLeg" ? 0 : 3, 2, 0.74);
    }
  }

  if (style.bottomType === "skirt" || style.bottomType === "shorts") {
    const bottomPattern = style.bottomPattern ?? "plain";
    const rightLeg = CLASSIC_LAYOUT.rightLeg;
    const leftLeg = CLASSIC_LAYOUT.leftLeg;
    const rightLegTop = averageRect(rightLeg.base.front, 0, 2);
    const leftLegTop = averageRect(leftLeg.base.front, 0, 2);
    const legTop = mixRgb(rightLegTop, leftLegTop, 0.5);
    const bodyLower = mixRgb(
      averageRect(body.base.front, body.base.front.h - 2, 2),
      averageRect(body.base.back, body.base.back.h - 2, 2),
      0.5,
    );
    const bottomColor = mixRgb(legTop, bodyLower, style.bottomType === "skirt" ? 0.22 : 0.12);
    const hemColor = shadeRgb(bottomColor, 0.78);
    const litColor = shadeRgb(bottomColor, 1.08);

    const paintLowerTorso = (rect: Rect, rows: number) => {
      for (let y = rect.h - rows; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const localY = y - (rect.h - rows);
          const pleat =
            (style.bottomType === "skirt" || bottomPattern === "pleated") && x % 3 === 1
              ? 0.86
              : x % 4 === 0
                ? 1.06
                : 0.96;
          let color = shadeRgb(bottomColor, y === rect.h - 1 ? 0.72 : pleat);
          if (bottomPattern === "plaid") {
            if (x === 1 || x === 5) color = shadeRgb(bottomColor, 0.66);
            if (localY === 1 || localY === rows - 1) color = mixRgb(color, [238, 224, 214], 0.28);
            if ((x === 1 || x === 5) && localY === 1) color = shadeRgb(bottomColor, 0.5);
          } else if (bottomPattern === "striped" && localY % 2 === 1) {
            color = shadeRgb(bottomColor, 0.72);
          } else if (bottomPattern === "lace" && y === rect.h - 1 && x % 2 === 0) {
            color = mixRgb(bottomColor, [255, 248, 240], 0.55);
          }
          put(rect, x, y, color);
        }
      }
    };

    const torsoRows = style.bottomType === "skirt" ? 4 : 2;
    paintLowerTorso(front, torsoRows);
    paintLowerTorso(back, torsoRows);
    for (const rect of [body.overlay.right, body.overlay.left]) {
      for (let y = rect.h - torsoRows; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          put(rect, x, y, shadeRgb(bottomColor, y === rect.h - 1 ? 0.74 : 0.92));
        }
      }
    }

    for (const part of ["rightLeg", "leftLeg"] as const) {
      const leg = CLASSIC_LAYOUT[part];
      const coverRows = style.bottomType === "skirt" ? 3 : 2;
      for (const faceName of ["front", "back", "right", "left"] as const) {
        const dst = leg.overlay[faceName];
        for (let y = 0; y < coverRows; y++) {
          for (let x = 0; x < dst.w; x++) {
            const tone = y === 0 ? litColor : y === coverRows - 1 ? hemColor : bottomColor;
            let color = tone;
            if (bottomPattern === "plaid" && (x === 1 || y === 1)) {
              color = x === 1 && y === 1 ? shadeRgb(bottomColor, 0.52) : shadeRgb(tone, 0.72);
            } else if (bottomPattern === "pleated" && x % 2 === 1) {
              color = shadeRgb(tone, 0.76);
            } else if (bottomPattern === "lace" && y === coverRows - 1 && x % 2 === 0) {
              color = mixRgb(tone, [255, 248, 240], 0.55);
            }
            put(dst, x, y, color);
          }
        }
      }
      const frontLeg = leg.overlay.front;
      for (let y = 0; y < coverRows; y++) {
        const seamX = part === "rightLeg" ? frontLeg.w - 1 : 0;
        put(frontLeg, seamX, y, shadeRgb(bottomColor, 0.66));
      }
    }
  }

  const bottomAccent = style.bottomAccent ?? "none";
  if (bottomAccent !== "none") {
    const waistColor = shadeRgb(
      mixRgb(averageRect(body.base.front, body.base.front.h - 2, 2), averageRect(body.base.back, body.base.back.h - 2, 2), 0.5),
      0.48,
    );
    const accentLight = mixRgb(waistColor, [238, 230, 218], 0.34);
    const paintBelt = (rect: Rect) => {
      const y = Math.max(0, rect.h - 3);
      for (let x = 0; x < rect.w; x++) {
        put(rect, x, y, x === 3 || x === 4 ? accentLight : waistColor);
      }
      put(rect, 3, y + 1, accentLight);
      put(rect, 4, y + 1, shadeRgb(accentLight, 0.72));
    };
    if (bottomAccent === "belt") {
      paintBelt(front);
      paintBelt(back);
      for (const rect of [body.overlay.right, body.overlay.left]) {
        const y = Math.max(0, rect.h - 3);
        for (let x = 0; x < rect.w; x++) put(rect, x, y, waistColor);
      }
    } else if (bottomAccent === "side_stripe") {
      const stripe = mixRgb(accentLight, [255, 255, 255], 0.18);
      for (const part of ["rightLeg", "leftLeg"] as const) {
        const leg = CLASSIC_LAYOUT[part];
        const outerX = part === "rightLeg" ? 0 : leg.overlay.front.w - 1;
        for (let y = 1; y < leg.overlay.front.h - 2; y++) {
          put(leg.overlay.front, outerX, y, y % 3 === 0 ? shadeRgb(stripe, 0.78) : stripe);
        }
        for (const rect of [leg.overlay.right, leg.overlay.left]) {
          for (let y = 1; y < rect.h - 2; y++) put(rect, 0, y, stripe);
        }
      }
    } else if (bottomAccent === "cuffs") {
      for (const part of ["rightLeg", "leftLeg"] as const) {
        const leg = CLASSIC_LAYOUT[part];
        for (const faceName of ["front", "back", "right", "left"] as const) {
          const rect = leg.overlay[faceName];
          for (let y = rect.h - 4; y < rect.h - 2; y++) {
            for (let x = 0; x < rect.w; x++) {
              put(rect, x, y, y % 2 === 0 ? accentLight : shadeRgb(accentLight, 0.76));
            }
          }
        }
      }
    } else if (bottomAccent === "ribbon") {
      const ribbon: Rgb = [238, 204, 214];
      const ribbonDark = shadeRgb(ribbon, 0.72);
      for (const leg of [CLASSIC_LAYOUT.rightLeg, CLASSIC_LAYOUT.leftLeg]) {
        const rect = leg.overlay.front;
        for (const [x, y, color] of [
          [0, 2, ribbon],
          [1, 1, ribbon],
          [1, 2, ribbonDark],
          [2, 2, ribbon],
          [1, 3, ribbonDark],
        ] as const) {
          put(rect, x, y, color);
        }
      }
    }
  }

  // 신발: 발목 둘레와 밑창을 overlay로 올려 발끝 두께를 만든다 (하의 종류 무관).
  for (const part of ["rightLeg", "leftLeg"] as const) {
    const leg = CLASSIC_LAYOUT[part];
    for (const faceName of ["front", "back", "right", "left"] as const) {
      const src = leg.base[faceName];
      const dst = leg.overlay[faceName];
      for (let x = 0; x < dst.w; x++) {
        volumeCopy(src, dst, x, dst.h - 2, faceName === "front" ? "lit" : "mid");
        volumeCopy(src, dst, x, dst.h - 1, "mid");
      }
    }
    for (let y = 0; y < leg.overlay.bottom.h; y++) {
      for (let x = 0; x < leg.overlay.bottom.w; x++) {
        volumeCopy(leg.base.bottom, leg.overlay.bottom, x, y, "hem");
      }
    }
  }

  const legwear = style.legwear ?? "none";
  if (legwear !== "none") {
    const asym = style.legwearAsymmetry ?? "none";
    const targetParts =
      asym === "left"
        ? (["leftLeg"] as const)
        : asym === "right"
          ? (["rightLeg"] as const)
          : (["rightLeg", "leftLeg"] as const);
    const legwearRows =
      legwear === "socks"
        ? { start: 7, end: 9 }
        : legwear === "stockings"
          ? { start: 0, end: 9 }
          : legwear === "thigh_highs"
            ? { start: 0, end: 8 }
            : { start: 2, end: 9 };

    const drawLegwear = (part: "rightLeg" | "leftLeg") => {
      const leg = CLASSIC_LAYOUT[part];
      const skinish = averageRect(leg.base.front, 2, 5);
      const garment = mixRgb(
        averageRect(body.base.front, body.base.front.h - 3, 3),
        [238, 224, 218],
        0.45,
      );
      const baseColor =
        legwear === "stockings"
          ? mixRgb(skinish, [95, 72, 76], 0.52)
          : legwear === "leg_warmers"
            ? mixRgb(garment, [244, 232, 226], 0.38)
            : mixRgb(skinish, [246, 240, 232], 0.68);
      const topLace = shadeRgb(mixRgb(baseColor, [255, 250, 244], 0.55), 1.08);
      for (const faceName of ["front", "back", "right", "left"] as const) {
        const baseRect = leg.base[faceName];
        const overRect = leg.overlay[faceName];
        for (let y = legwearRows.start; y <= legwearRows.end; y++) {
          for (let x = 0; x < baseRect.w; x++) {
            const wrinkle =
              legwear === "leg_warmers" && y % 2 === 0
                ? 0.82
                : x === 0 || x === baseRect.w - 1
                  ? 0.9
                  : 1.02;
            put(baseRect, x, y, shadeRgb(baseColor, wrinkle));
            put(overRect, x, y, shadeRgb(baseColor, y % 2 === 0 ? 0.9 : 1.08));
          }
        }
        for (let x = 0; x < overRect.w; x++) {
          put(overRect, x, legwearRows.start, x % 2 === 0 ? topLace : shadeRgb(topLace, 0.82));
        }
      }
    };

    for (const part of targetParts) drawLegwear(part);

    if (asym === "left" || asym === "right") {
      const opposite = asym === "left" ? CLASSIC_LAYOUT.rightLeg : CLASSIC_LAYOUT.leftLeg;
      const bow: Rgb = [248, 242, 232];
      const bowShade: Rgb = [212, 192, 184];
      const frontLeg = opposite.overlay.front;
      for (const [x, y, color] of [
        [0, 2, bow],
        [1, 1, bow],
        [1, 2, bowShade],
        [2, 2, bow],
        [1, 3, bowShade],
      ] as const) {
        put(frontLeg, x, y, color);
      }
    }
  }
}

/**
 * 어깨선 감지: 위에서부터 행 너비가 머리 너비의 1.35배를 넘는 첫 행.
 * (FLUX가 그리는 캐릭터는 머리 비율이 25~35%로 들쑥날쑥해 고정 비율로 자르면
 *  얼굴 하단이 잘린다) 감지 실패 시 마인크래프트 표준 비율(8/32)로 fallback.
 */
function findShoulderRow(
  src: RawImage,
  bg: [number, number, number],
  minY: number,
  maxY: number,
  xr: { x0: number; x1: number },
): number {
  const bboxH = maxY - minY + 1;
  const widths: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    let count = 0;
    for (let x = xr.x0; x < xr.x1; x++) {
      if (isCharacterPixel(src, x, y, bg)) count++;
    }
    widths.push(count);
  }
  const headBand = widths
    .slice(Math.floor(bboxH * 0.05), Math.max(4, Math.floor(bboxH * 0.18)))
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  if (headBand.length === 0) {
    return minY + Math.floor(bboxH * (8 / 32));
  }
  const headWidth = headBand[headBand.length >> 1];
  for (let i = Math.floor(bboxH * 0.15); i < Math.floor(bboxH * 0.5); i++) {
    if (widths[i] > headWidth * 1.35) {
      return minY + i;
    }
  }
  return minY + Math.floor(bboxH * (8 / 32));
}

/**
 * 마스크 행 범위에서 캐릭터 열 범위 계산.
 * min/max가 아니라 "행의 6% 이상에서 등장하는 열"만 인정해
 * 떨어져 있는 잡티 픽셀이나 경계 침범(어깨 시작 행 등)에 흔들리지 않게 한다.
 */
function columnSpan(
  src: RawImage,
  bg: [number, number, number],
  y0: number,
  y1: number,
  xr: { x0: number; x1: number },
): { x0: number; x1: number } | null {
  const rows = Math.max(1, Math.ceil(y1) - Math.floor(y0));
  const counts = new Array<number>(src.width).fill(0);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = xr.x0; x < xr.x1; x++) {
      if (isCharacterPixel(src, x, y, bg)) {
        counts[x]++;
      }
    }
  }
  const threshold = Math.max(2, rows * 0.06);
  let x0 = -1;
  let x1 = -1;
  for (let x = xr.x0; x < xr.x1; x++) {
    if (counts[x] >= threshold) {
      if (x0 === -1) x0 = x;
      x1 = x + 1;
    }
  }
  return x0 === -1 ? null : { x0, x1 };
}

/**
 * 캐릭터 figure의 열 구간 탐지 (최대 2개: 정면 뷰 + 뒷면 뷰).
 * 열 히스토그램에서 캐릭터 열 run을 찾고, 충분히 큰 run이 2개면 두 뷰로 본다.
 */
function findFigureRanges(
  src: RawImage,
  bg: [number, number, number],
): Array<{ x0: number; x1: number }> {
  const counts = new Array<number>(src.width).fill(0);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (isCharacterPixel(src, x, y, bg)) counts[x]++;
    }
  }
  const threshold = Math.max(3, src.height * 0.03);
  const runs: Array<{ x0: number; x1: number }> = [];
  let start = -1;
  let gap = 0;
  const GAP_TOLERANCE = Math.max(4, Math.floor(src.width * 0.015));
  for (let x = 0; x <= src.width; x++) {
    const on = x < src.width && counts[x] >= threshold;
    if (on) {
      if (start === -1) start = x;
      gap = 0;
    } else if (start !== -1) {
      gap++;
      if (gap > GAP_TOLERANCE || x === src.width) {
        runs.push({ x0: start, x1: x - gap + 1 });
        start = -1;
        gap = 0;
      }
    }
  }
  const big = runs.filter((r) => r.x1 - r.x0 >= 32);
  if (big.length >= 2) {
    // 가장 넓은 두 run을 좌→우 순서로
    big.sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
    return big.slice(0, 2).sort((a, b) => a.x0 - b.x0);
  }
  return big.slice(0, 1);
}

/** 한 figure를 머리/몸통/팔/다리 소스 영역으로 슬라이스 */
interface FigureSlices {
  head: Region;
  body: Region;
  /** 화면(뷰어) 기준 왼쪽/오른쪽 팔·다리 */
  viewLeftArm: Region;
  viewRightArm: Region;
  viewLeftLeg: Region;
  viewRightLeg: Region;
}

function sliceFigure(
  src: RawImage,
  bg: [number, number, number],
  xr: { x0: number; x1: number },
): FigureSlices | null {
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = xr.x0; x < xr.x1; x++) {
      if (isCharacterPixel(src, x, y, bg)) {
        count++;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const area = (xr.x1 - xr.x0) * src.height;
  if (count < area * 0.04 || maxY - minY + 1 < 64) {
    return null;
  }

  const shoulderY = findShoulderRow(src, bg, minY, maxY, xr);
  const headRows = { y0: minY, y1: shoulderY };
  const torsoRows = { y0: shoulderY, y1: shoulderY + (maxY + 1 - shoulderY) * 0.5 };
  const legRows = { y0: torsoRows.y1, y1: maxY + 1 };

  const headSpan = columnSpan(src, bg, headRows.y0, headRows.y1, xr);
  const torsoSpan = columnSpan(src, bg, torsoRows.y0, torsoRows.y1, xr);
  const legSpan = columnSpan(src, bg, legRows.y0, legRows.y1, xr);
  if (!headSpan || !torsoSpan || !legSpan) {
    return null;
  }
  const torsoWidth = torsoSpan.x1 - torsoSpan.x0;
  const legWidth = legSpan.x1 - legSpan.x0;
  return {
    head: { x0: headSpan.x0, x1: headSpan.x1, y0: headRows.y0, y1: headRows.y1 },
    body: {
      x0: torsoSpan.x0 + torsoWidth * 0.25,
      x1: torsoSpan.x1 - torsoWidth * 0.25,
      y0: torsoRows.y0,
      y1: torsoRows.y1,
    },
    viewLeftArm: {
      x0: torsoSpan.x0,
      x1: torsoSpan.x0 + torsoWidth * 0.25,
      y0: torsoRows.y0,
      y1: torsoRows.y1,
    },
    viewRightArm: {
      x0: torsoSpan.x1 - torsoWidth * 0.25,
      x1: torsoSpan.x1,
      y0: torsoRows.y0,
      y1: torsoRows.y1,
    },
    viewLeftLeg: {
      x0: legSpan.x0,
      x1: legSpan.x0 + legWidth * 0.5,
      y0: legRows.y0,
      y1: legRows.y1,
    },
    viewRightLeg: {
      x0: legSpan.x0 + legWidth * 0.5,
      x1: legSpan.x1,
      y0: legRows.y0,
      y1: legRows.y1,
    },
  };
}

export function packFrontViewToAtlas(
  src: RawImage,
  faceStyle: FaceStyle = DEFAULT_FACE_STYLE,
): PackResult | null {
  const bg = estimateBackground(src);

  // 배경 분리 자체가 안 되는 입력(전면 노이즈 등) 방어
  let charCount = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (isCharacterPixel(src, x, y, bg)) charCount++;
    }
  }
  if (charCount > src.width * src.height * 0.9) {
    return null;
  }

  // figure 탐지: 1개면 정면만, 2개면 [정면, 뒷면]
  const ranges = findFigureRanges(src, bg);
  if (ranges.length === 0) {
    return null;
  }
  const front = sliceFigure(src, bg, ranges[0]);
  if (!front) {
    return null;
  }
  const back = ranges.length > 1 ? sliceFigure(src, bg, ranges[1]) : null;

  const problems: string[] = [];
  if (ranges.length > 1 && !back) {
    problems.push("뒷면 뷰 슬라이스 실패 — 정면 파생으로 대체");
  }
  const atlas: RawImage = {
    width: ATLAS_SIZE,
    height: ATLAS_SIZE,
    rgba: new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4),
  };

  // ---------- 머리 ----------
  const head = CLASSIC_LAYOUT.head;
  const hairColor = medianColor(
    src,
    { ...front.head, y1: front.head.y0 + (front.head.y1 - front.head.y0) * 0.22 },
    bg,
  );
  const skinColor = medianColor(
    src,
    {
      x0: front.head.x0 + (front.head.x1 - front.head.x0) * 0.3,
      x1: front.head.x1 - (front.head.x1 - front.head.x0) * 0.3,
      y0: front.head.y0 + (front.head.y1 - front.head.y0) * 0.55,
      y1: front.head.y1 - (front.head.y1 - front.head.y0) * 0.15,
    },
    bg,
  );
  // 얼굴: 렌더에서는 팔레트만 사용하고, 분석 힌트로 안정적인 8x8 구조를 합성
  composeFace(atlas, hairColor, skinColor, faceStyle);

  // 옆면은 front 가장자리 확장 (얼굴 반전 금지)
  fillRectFromRect(
    atlas,
    head.base.right,
    { x: head.base.front.x, y: head.base.front.y, w: 1, h: head.base.front.h },
    0.86,
  );
  fillRectFromRect(
    atlas,
    head.base.left,
    {
      x: head.base.front.x + head.base.front.w - 1,
      y: head.base.front.y,
      w: 1,
      h: head.base.front.h,
    },
    0.86,
  );
  // 뒷면: 뒷면 뷰가 있으면 실제 렌더(뒤통수), 없으면 머리카락색
  if (back) {
    fillRectFromRegion(atlas, head.base.back, src, back.head, bg);
  } else {
    fillRectSolid(atlas, head.base.back, hairColor, 0.9);
  }
  fillRectSolid(atlas, head.base.top, hairColor);
  fillRectSolid(atlas, head.base.bottom, skinColor, 0.85);

  // ---------- 몸통 ----------
  const body = CLASSIC_LAYOUT.body;
  fillRectFromRegion(atlas, body.base.front, src, front.body, bg);
  const torsoTopColor = medianColor(
    src,
    { ...front.body, y1: front.body.y0 + (front.body.y1 - front.body.y0) * 0.15 },
    bg,
  );
  completeSides(atlas, body.base, torsoTopColor, torsoTopColor);
  if (back) {
    fillRectFromRegion(atlas, body.base.back, src, back.body, bg);
  } else {
    fillRectFromRect(atlas, body.base.back, body.base.front, 0.78, true);
  }

  // ---------- 팔 ----------
  // 정면 뷰: 화면 왼쪽 = 캐릭터의 오른팔. 뒷면 뷰: 화면 왼쪽 = 캐릭터의 왼팔.
  const arms = [
    { part: "rightArm" as const, frontRegion: front.viewLeftArm, backRegion: back?.viewRightArm },
    { part: "leftArm" as const, frontRegion: front.viewRightArm, backRegion: back?.viewLeftArm },
  ];
  for (const { part, frontRegion, backRegion } of arms) {
    const box = CLASSIC_LAYOUT[part].base;
    fillRectFromRegion(atlas, box.front, src, frontRegion, bg);
    const sleeveColor = medianColor(
      src,
      { ...frontRegion, y1: frontRegion.y0 + (frontRegion.y1 - frontRegion.y0) * 0.2 },
      bg,
    );
    completeSides(atlas, box, sleeveColor, skinColor); // 아래면 = 손 (피부색)
    if (backRegion) {
      fillRectFromRegion(atlas, box.back, src, backRegion, bg);
    } else {
      fillRectFromRect(atlas, box.back, box.front, 0.78, true);
    }
  }

  // ---------- 다리 ----------
  const legs = [
    { part: "rightLeg" as const, frontRegion: front.viewLeftLeg, backRegion: back?.viewRightLeg },
    { part: "leftLeg" as const, frontRegion: front.viewRightLeg, backRegion: back?.viewLeftLeg },
  ];
  for (const { part, frontRegion, backRegion } of legs) {
    const box = CLASSIC_LAYOUT[part].base;
    fillRectFromRegion(atlas, box.front, src, frontRegion, bg);
    const pantsColor = medianColor(
      src,
      { ...frontRegion, y1: frontRegion.y0 + (frontRegion.y1 - frontRegion.y0) * 0.2 },
      bg,
    );
    const shoeColor = medianColor(
      src,
      { ...frontRegion, y0: frontRegion.y1 - (frontRegion.y1 - frontRegion.y0) * 0.12 },
      bg,
    );
    completeSides(atlas, box, pantsColor, shoeColor);
    if (backRegion) {
      fillRectFromRegion(atlas, box.back, src, backRegion, bg);
    } else {
      fillRectFromRect(atlas, box.back, box.front, 0.78, true);
    }
  }

  // ---------- 마감: 의상/액세서리 레이어 + 헤어/모자 구조 + 셰이딩 ----------
  composeGarmentLayers(atlas, faceStyle);
  composeHair(atlas, hairColor, faceStyle, back !== null);
  // 모자 쓴 인물은 머리 상단 medianColor(hairColor)가 곧 모자 색
  composeHat(atlas, hairColor, faceStyle);
  applyShading(atlas);

  return { atlas, problems, hasBackView: back !== null };
}
