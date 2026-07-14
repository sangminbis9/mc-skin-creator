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
  skinTone?: string;
  hairColor?: string;
  hatColor?: string;
  faceShape?: "round" | "oval" | "long" | "angular" | "square";
  eyeShape?: "narrow" | "almond" | "round";
  eyeSpacing?: "close" | "average" | "wide";
  eyeTilt?: "upturned" | "level" | "downturned";
  eyebrowShape?: "straight" | "arched" | "slanted" | "soft";
  noseShape?: "small" | "straight" | "rounded" | "prominent";
  mouthShape?: "small" | "wide" | "full" | "thin";
  jawShape?: "rounded" | "pointed" | "square" | "soft";
  bangs?: "none" | "straight" | "side" | "curtain" | "wispy";
  bangsLength?: "none" | "short" | "brow" | "eye";
  bangsDensity?: "sparse" | "balanced" | "dense";
  fringeEdge?: "blunt" | "staggered" | "wispy";
  fringeOpening?: "none" | "left" | "center" | "right";
  hairTexture?: "straight" | "wavy" | "curly" | "coily";
  hairVolume?: "flat" | "normal" | "full";
  hairSilhouette?: "rounded" | "flat" | "swept" | "tousled" | "spiky";
  hairBackShape?: "tapered" | "rounded" | "long" | "tied" | "undercut";
  hairPart?: "none" | "center" | "left" | "right";
  sideHairLength?: "none" | "short" | "cheek" | "jaw" | "shoulder";
  sideHairShape?:
    "tapered" | "ear_hugging" | "face_framing" | "flared" | "undercut";
  sideHairAsymmetry?: "none" | "left" | "right";
  earExposure?: "covered" | "partial" | "visible";
  garmentTexture?:
    "plain" | "knit" | "denim" | "leather" | "striped" | "patterned";
  outerLayer?: "none" | "light" | "heavy";
  outerGarment?: "none" | "cardigan" | "open_jacket" | "coat" | "vest";
  necklace?: "none" | "silver" | "gold" | "dark";
  hairAccessory?: "none" | "flower" | "bow" | "ribbon" | "clip";
  hairAccessorySide?: "left" | "right" | "center";
  hairAccessoryColor?:
    | "black"
    | "brown"
    | "white"
    | "gray"
    | "red"
    | "orange"
    | "yellow"
    | "green"
    | "blue"
    | "purple"
    | "pink";
  neckAccessory?: "none" | "bow" | "tie" | "scarf" | "collar";
  bottomPattern?: "plain" | "plaid" | "striped" | "pleated" | "lace";
  bottomAccent?: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
  legwear?: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
  legwearAsymmetry?: "none" | "left" | "right" | "both";
  shoeStyle?: "sneakers" | "dress_shoes" | "boots" | "loafers" | "sandals";
  topColor?: string;
  topAccentColor?: string;
  bottomColor?: string;
  shoesColor?: string;
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
  skinTone: undefined,
  hairColor: undefined,
  hatColor: undefined,
  faceShape: "oval",
  eyeShape: "almond",
  eyeSpacing: "average",
  eyeTilt: "level",
  eyebrowShape: "straight",
  noseShape: "small",
  mouthShape: "small",
  jawShape: "soft",
  bangs: "none",
  bangsLength: "none",
  bangsDensity: "balanced",
  fringeEdge: "staggered",
  fringeOpening: "none",
  hairTexture: "straight",
  hairVolume: "normal",
  hairSilhouette: "rounded",
  hairBackShape: "tapered",
  hairPart: "none",
  sideHairLength: "short",
  sideHairShape: "tapered",
  sideHairAsymmetry: "none",
  earExposure: "partial",
  garmentTexture: "plain",
  outerLayer: "none",
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
  shoeStyle: undefined,
  bottomColor: undefined,
  shoesColor: undefined,
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

function alignRgbChroma(source: Rgb, target: Rgb, strength = 0.9): Rgb {
  const luminance = (rgb: Rgb) =>
    rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
  const sourceLuminance = luminance(source);
  const targetLuminance = Math.max(1, luminance(target));
  const scale = sourceLuminance / targetLuminance;
  const targetAtSourceLuminance = target.map((channel) =>
    Math.max(0, Math.min(255, Math.round(channel * scale))),
  ) as Rgb;
  return mixRgb(source, targetAtSourceLuminance, strength);
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
      const sx =
        srcRect.x + Math.min(srcRect.w - 1, Math.floor(sxRatio * srcRect.w));
      const sy =
        srcRect.y +
        Math.min(srcRect.h - 1, Math.floor(((cy + 0.5) / dst.h) * srcRect.h));
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
 * Finish every vertical outer-layer corner after all procedural details have
 * been composed. Front/back pixels are the semantic source of truth (they
 * carry photographed patterns and inferred rear construction); the adjacent
 * side edge inherits them. If only the side is populated, extend that pixel
 * back onto the empty front/back edge instead of leaving a one-pixel crack.
 */
function reconcileOverlayVerticalSeams(atlas: RawImage): void {
  const copyPixel = (
    source: Rect,
    sourceX: number,
    target: Rect,
    targetX: number,
    y: number,
  ) => {
    const sourceIndex = ((source.y + y) * ATLAS_SIZE + source.x + sourceX) * 4;
    const targetIndex = ((target.y + y) * ATLAS_SIZE + target.x + targetX) * 4;
    for (let channel = 0; channel < 4; channel++) {
      atlas.rgba[targetIndex + channel] = atlas.rgba[sourceIndex + channel];
    }
  };

  for (const part of ALL_PARTS) {
    const overlay = CLASSIC_LAYOUT[part].overlay;
    const seams = [
      [overlay.front, 0, overlay.right, overlay.right.w - 1],
      [overlay.front, overlay.front.w - 1, overlay.left, 0],
      [overlay.back, overlay.back.w - 1, overlay.right, 0],
      [overlay.back, 0, overlay.left, overlay.left.w - 1],
    ] as const;
    for (const [primary, primaryX, side, sideX] of seams) {
      for (let y = 0; y < Math.min(primary.h, side.h); y++) {
        const primaryIndex =
          ((primary.y + y) * ATLAS_SIZE + primary.x + primaryX) * 4;
        const sideIndex = ((side.y + y) * ATLAS_SIZE + side.x + sideX) * 4;
        const primaryOpaque = atlas.rgba[primaryIndex + 3] !== 0;
        const sideOpaque = atlas.rgba[sideIndex + 3] !== 0;
        if (primaryOpaque) {
          copyPixel(primary, primaryX, side, sideX, y);
        } else if (sideOpaque) {
          copyPixel(side, sideX, primary, primaryX, y);
        }
      }
    }
  }
}

function averageAtlasRect(
  atlas: RawImage,
  rect: Rect,
  y0 = 0,
  y1 = rect.h,
): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = Math.max(0, y0); y < Math.min(rect.h, y1); y++) {
    for (let x = 0; x < rect.w; x++) {
      const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      if (atlas.rgba[d + 3] < 128) continue;
      r += atlas.rgba[d];
      g += atlas.rgba[d + 1];
      b += atlas.rgba[d + 2];
      count++;
    }
  }
  return count === 0
    ? [0, 0, 0]
    : [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

function chroma(rgb: Rgb): Rgb {
  const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
  return [rgb[0] - luminance, rgb[1] - luminance, rgb[2] - luminance];
}

/**
 * A generated back view can reinterpret a neutral front garment as blue,
 * green or brown. Keep the back-view folds and luminance, but align its
 * chroma with the observed front and the analysed garment colour so cube
 * seams do not split one piece of clothing into unrelated palettes.
 */
function harmonizeGarmentChroma(
  atlas: RawImage,
  target: Rect,
  reference: Rect,
  declaredColor: Rgb | null,
  applyRows = target.h,
): void {
  const sampleStart = Math.min(2, Math.max(0, applyRows - 1));
  const sampleEnd = Math.max(
    sampleStart + 1,
    Math.min(applyRows, target.h - 2),
  );
  const sourceAverage = averageAtlasRect(atlas, target, sampleStart, sampleEnd);
  const observedAverage = averageAtlasRect(
    atlas,
    reference,
    sampleStart,
    sampleEnd,
  );
  const desiredAverage = declaredColor
    ? mixRgb(observedAverage, declaredColor, 0.35)
    : observedAverage;
  const sourceChroma = chroma(sourceAverage);
  const desiredChroma = chroma(desiredAverage);
  const delta = sourceChroma.map((value, channel) =>
    Math.max(-72, Math.min(72, (desiredChroma[channel] - value) * 0.88)),
  );
  if (delta.reduce((sum, value) => sum + Math.abs(value), 0) < 14) return;

  for (let y = 0; y < Math.min(applyRows, target.h); y++) {
    for (let x = 0; x < target.w; x++) {
      const d = ((target.y + y) * ATLAS_SIZE + target.x + x) * 4;
      if (atlas.rgba[d + 3] < 128) continue;
      for (let channel = 0; channel < 3; channel++) {
        atlas.rgba[d + channel] = Math.max(
          0,
          Math.min(255, Math.round(atlas.rgba[d + channel] + delta[channel])),
        );
      }
    }
  }
}

/**
 * Image-generation guides sometimes introduce a vivid shoulder or collar
 * colour that is absent from the photo analysis. Preserve every pixel's
 * luminance (and therefore folds/knit texture), while aligning garment hue to
 * the analysed colour before deriving the other cube faces.
 */
function alignGarmentRectToDeclaredColor(
  atlas: RawImage,
  target: Rect,
  declaredColor: Rgb | null,
  applyRows = target.h,
  startRow = 0,
): void {
  if (!declaredColor) return;
  for (
    let y = Math.max(0, startRow);
    y < Math.min(target.h, startRow + applyRows);
    y++
  ) {
    for (let x = 0; x < target.w; x++) {
      const d = ((target.y + y) * ATLAS_SIZE + target.x + x) * 4;
      if (atlas.rgba[d + 3] < 128) continue;
      const aligned = alignRgbChroma(
        [atlas.rgba[d], atlas.rgba[d + 1], atlas.rgba[d + 2]],
        declaredColor,
      );
      atlas.rgba[d] = aligned[0];
      atlas.rgba[d + 1] = aligned[1];
      atlas.rgba[d + 2] = aligned[2];
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
  const edgeLeft: Rect = {
    x: box.front.x,
    y: box.front.y,
    w: 1,
    h: box.front.h,
  };
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
    for (const [faceName, rect] of Object.entries(
      CLASSIC_LAYOUT[part].base,
    ) as Array<[keyof BoxUV, Rect]>) {
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
  const sideRight = CLASSIC_LAYOUT.head.overlay.right;
  const sideLeft = CLASSIC_LAYOUT.head.overlay.left;
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
  const bangsDensity = style.bangsDensity ?? "balanced";
  const fringeEdge = style.fringeEdge ?? "staggered";
  // A centre-parted straight fringe is not a solid horizontal helmet edge.
  // Keep the centre forehead open while retaining denser locks on both sides.
  // This is common in short bowl/two-block cuts and remains useful for any
  // centre-parted portrait rather than keying off a particular subject.
  const splitCenterFringe =
    bangs === "straight" &&
    style.hairPart === "center" &&
    bangsDensity !== "dense";
  if (bangs === "straight") {
    for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) {
      hair(x, 2);
    }
    const baseTipXs =
      bangsDensity === "dense"
        ? fringeEdge === "wispy"
          ? [0, 3, 6]
          : fringeEdge === "blunt"
            ? [0, 1, 3, 4, 6, 7]
            : [0, 2, 3, 5, 7]
        : bangsDensity === "sparse"
          ? [0, 3, 7]
          : splitCenterFringe
            ? [0, 1, 6, 7]
            : [0, 2, 5, 7];
    for (const x of baseTipXs) {
      hair(x, 3, 0.96);
    }
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

  // Root parting and the visible opening between fringe clusters are separate
  // cues. Re-open the dominant photographed gap on the base cube so clearing
  // the matching outer-layer pixels below reveals forehead instead of another
  // solid hair row.
  const fringeOpening = style.fringeOpening ?? "none";
  if (bangs !== "none" && fringeOpening !== "none") {
    const gapXs =
      fringeOpening === "center" && bangs === "curtain"
        ? [3, 4]
        : [fringeOpening === "left" ? 2 : fringeOpening === "right" ? 5 : 3];
    for (const x of gapXs) {
      put(face, x, 2, shadeRgb(skinColor, 1.01));
      put(face, x, 3, shadeRgb(skinColor, 0.98));
    }
  }

  // 3) 눈썹·눈·코·입: 1픽셀 검은 사각형으로 끝나지 않도록 작은 색 군집을 만든다.
  const browColor = shadeRgb(hairColor, 0.8);
  const eye = hexToRgb(style.eyeColor, [74, 55, 40]);
  const eyePairs =
    style.eyeSpacing === "wide"
      ? ([
          [0, 1],
          [7, 6],
        ] as const)
      : style.eyeSpacing === "close"
        ? ([
            [1, 2],
            [5, 4],
          ] as const)
        : ([
            [1, 2],
            [6, 5],
          ] as const);
  const brow =
    style.eyebrowThickness === "thin"
      ? mixRgb(browColor, skinColor, 0.38)
      : browColor;
  const browOccludedByFringe =
    bangs !== "none" &&
    (style.bangsLength === "brow" || style.bangsLength === "eye");
  const eyebrowShape = style.eyebrowShape ?? "straight";
  const eyeTilt = style.eyeTilt ?? "level";
  for (const [outer, inner] of eyePairs) {
    const outerBrowY = eyeTilt === "upturned" ? 2 : 3;
    put(
      face,
      outer,
      outerBrowY,
      browOccludedByFringe ? mixRgb(brow, skinColor, 0.72) : brow,
    );
    put(
      face,
      inner,
      3,
      browOccludedByFringe ? mixRgb(brow, skinColor, 0.58) : brow,
    );
    const sclera = mixRgb(
      skinColor,
      [238, 232, 222],
      style.eyeShape === "round"
        ? 0.36
        : style.eyeShape === "narrow"
          ? 0.12
          : 0.28,
    );
    const outerEyeY =
      eyeTilt === "upturned" ? 3 : eyeTilt === "downturned" ? 5 : 4;
    if (outerEyeY !== 4) {
      put(face, outer, 4, shadeRgb(skinColor, 0.98));
    }
    put(
      face,
      outer,
      outerEyeY,
      eyeTilt === "level" ? sclera : mixRgb(sclera, eye, 0.42),
    );
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
  // A whole overlay pixel is the smallest possible catchlight at 8x8. Mixing
  // it too far toward white hid the dark iris underneath, so generated faces
  // looked blank in the 3D preview. Keep the overlay visibly eye-coloured.
  const eyeHighlight = mixRgb(eye, [250, 244, 232], 0.26);
  const lowerEye = mixRgb(skinColor, shadeRgb(eye, 0.66), 0.24);
  const eyelid = mixRgb(
    skinColor,
    brow,
    style.eyeShape === "narrow" ? 0.48 : 0.34,
  );
  const eyeCorner = mixRgb(shadeRgb(eye, 0.62), skinColor, 0.18);
  const lowerLid = mixRgb(
    shadeRgb(skinColor, 0.78),
    eye,
    style.eyeShape === "round" ? 0.12 : 0.2,
  );
  const noseShape = style.noseShape ?? "small";
  const noseX = style.faceShape === "long" || noseShape === "prominent" ? 4 : 3;
  const noseBridge = mixRgb(skinColor, [255, 238, 224], 0.24);
  const noseSide = shadeRgb(skinColor, 0.9);

  if (style.glasses === "none") {
    for (const [outer, inner] of eyePairs) {
      if (style.eyeShape === "round") {
        put(overlay, inner, 4, eyeHighlight);
        put(overlay, outer, 4, mixRgb(eyeCorner, skinColor, 0.16));
        put(overlay, outer, 5, lowerEye);
      } else if (style.eyeShape === "narrow") {
        put(overlay, outer, 3, eyelid);
        put(overlay, inner, 3, shadeRgb(eyelid, 0.86));
        put(overlay, inner, 4, shadeRgb(eye, 0.82));
        put(overlay, outer, 4, eyeCorner);
      } else {
        put(overlay, outer, 3, shadeRgb(eyelid, 0.92));
        put(overlay, outer, 4, eyeCorner);
        put(overlay, inner, 4, eyeHighlight);
        put(overlay, inner, 5, lowerLid);
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
    put(face, noseX === 3 ? 4 : 3, 5, mixRgb(noseSide, skinColor, 0.24));
    put(face, noseX, 4, mixRgb(noseBridge, skinColor, 0.38));
  } else {
    put(face, noseX, 4, shadeRgb(noseBridge, 1.04));
    put(face, noseX, 5, shadeRgb(skinShadow, 0.92));
    put(face, noseX === 3 ? 4 : 3, 5, shadeRgb(noseSide, 0.86));
    put(face, noseX, 3, mixRgb(noseBridge, skinColor, 0.28));
  }

  const mouthColor = mixRgb(shadeRgb(skinColor, 0.62), [160, 74, 60], 0.5);
  const mouthShape = style.mouthShape ?? "small";
  const mouthDark = shadeRgb(
    mouthColor,
    style.expression === "serious" ? 0.76 : 0.88,
  );
  const lipFull = mixRgb(mouthColor, [188, 92, 78], 0.36);
  const lipLight = mixRgb(lipFull, skinColor, 0.42);

  if (
    mouthShape === "wide" ||
    (style.expression === "smile" && mouthShape === "small")
  ) {
    put(
      face,
      2,
      6,
      style.expression === "smile" ? shadeRgb(mouthColor, 1.1) : mouthDark,
    );
    put(face, 3, 6, mouthColor);
    put(face, 4, 6, mouthColor);
    put(
      face,
      5,
      6,
      style.expression === "smile" ? shadeRgb(mouthColor, 1.1) : mouthDark,
    );
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
    put(face, 3, 6, mouthDark);
    put(face, 4, 6, mixRgb(mouthColor, skinColor, 0.36));
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
      put(face, 1, 7, shadeRgb(skinColor, 0.86));
      put(face, 6, 7, shadeRgb(skinColor, 0.86));
      put(face, 2, 6, shadeRgb(skinColor, 0.92));
      put(face, 5, 6, shadeRgb(skinColor, 0.92));
    } else if (jawShape === "pointed") {
      put(face, 2, 7, shadeRgb(skinColor, 0.98));
      put(face, 5, 7, shadeRgb(skinColor, 0.98));
      put(face, 3, 7, shadeRgb(skinColor, 0.88));
      put(face, 4, 7, shadeRgb(skinColor, 0.88));
    } else if (jawShape === "rounded") {
      put(face, 1, 6, shadeRgb(skinColor, 0.98));
      put(face, 6, 6, shadeRgb(skinColor, 0.98));
      put(face, 2, 7, shadeRgb(skinColor, 0.96));
      put(face, 5, 7, shadeRgb(skinColor, 0.96));
    } else {
      put(face, 2, 7, shadeRgb(skinColor, 0.95));
      put(face, 5, 7, shadeRgb(skinColor, 0.95));
    }
  }
  if (
    style.facialHair === "none" &&
    (style.faceShape === "oval" || style.faceShape === "long")
  ) {
    const outerJaw = shadeRgb(
      skinColor,
      style.faceShape === "long" ? 0.78 : 0.82,
    );
    const innerJaw = shadeRgb(
      skinColor,
      style.faceShape === "long" ? 0.86 : 0.89,
    );
    put(face, 0, 7, outerJaw);
    put(face, 7, 7, shadeRgb(outerJaw, 0.97));
    if (jawShape === "soft") {
      put(face, 1, 7, innerJaw);
      put(face, 6, 7, shadeRgb(innerJaw, 0.98));
    }
  }

  // 앞머리 overlay는 듬성한 가닥만 사용해 헬멧 같은 판을 만들지 않는다.
  if (style.facialHair === "none" && style.glasses === "none") {
    const catchLight = mixRgb(eyeHighlight, [255, 255, 255], 0.1);
    if (style.eyeShape !== "narrow") {
      put(overlay, leftInner, 4, catchLight);
      put(overlay, rightInner, 4, shadeRgb(catchLight, 0.94));
    }

    const underEyeShade = mixRgb(
      shadeRgb(skinColor, style.eyeShape === "narrow" ? 0.78 : 0.84),
      eye,
      style.eyeShape === "round" ? 0.1 : 0.16,
    );
    put(overlay, leftOuter, 5, underEyeShade);
    put(overlay, rightOuter, 5, shadeRgb(underEyeShade, 0.98));

    const philtrum = mixRgb(shadeRgb(skinColor, 0.78), mouthDark, 0.18);
    put(overlay, noseX, 5, mixRgb(philtrum, skinColor, 0.28));
    if (noseShape !== "rounded") {
      put(overlay, noseX === 3 ? 4 : 3, 5, mixRgb(philtrum, skinColor, 0.46));
    }

    const mouthCorner = mixRgb(
      mouthDark,
      skinColor,
      mouthShape === "thin" ? 0.18 : 0.28,
    );
    if (mouthShape === "wide") {
      put(overlay, 2, 6, shadeRgb(mouthCorner, 0.86));
      put(overlay, 5, 6, shadeRgb(mouthCorner, 0.86));
      put(overlay, 3, 6, mixRgb(mouthColor, skinColor, 0.2));
      put(overlay, 4, 6, mixRgb(mouthColor, skinColor, 0.28));
    } else if (mouthShape === "full") {
      put(overlay, 2, 6, mixRgb(lipFull, skinColor, 0.2));
      put(overlay, 5, 6, shadeRgb(lipFull, 0.86));
      put(overlay, 3, 6, mixRgb(lipLight, lipFull, 0.26));
      put(overlay, 4, 6, shadeRgb(lipFull, 0.88));
    } else {
      put(overlay, 3, 6, mouthCorner);
    }

    const chinLight = mixRgb(skinColor, [255, 238, 226], 0.16);
    const chinShadow = shadeRgb(skinColor, jawShape === "pointed" ? 0.8 : 0.88);
    if (jawShape === "pointed") {
      put(overlay, 3, 7, chinShadow);
      put(overlay, 4, 7, shadeRgb(chinShadow, 0.96));
    } else {
      put(overlay, 3, 7, chinLight);
      put(overlay, 4, 7, chinShadow);
    }

    const earBase = mixRgb(skinColor, [226, 144, 128], 0.14);
    const earInner = mixRgb(skinColor, [204, 106, 98], 0.2);
    const sideCheek = mixRgb(
      skinColor,
      [232, 148, 132],
      style.expression === "smile" ? 0.12 : 0.08,
    );
    const sideJaw = shadeRgb(
      skinColor,
      jawShape === "square" ? 0.84 : jawShape === "pointed" ? 0.9 : 0.88,
    );
    const paintSideFace = (
      rect: Rect,
      outerX: number,
      innerX: number,
      mirrorShade: number,
    ) => {
      put(rect, outerX, 4, shadeRgb(earBase, mirrorShade));
      put(rect, innerX, 4, shadeRgb(earInner, mirrorShade));
      put(rect, outerX, 5, shadeRgb(sideCheek, mirrorShade));
      put(rect, innerX, 6, shadeRgb(sideJaw, mirrorShade));
      put(rect, outerX, 7, shadeRgb(sideJaw, mirrorShade * 0.94));
    };
    paintSideFace(sideRight, 0, 1, 1);
    paintSideFace(sideLeft, sideLeft.w - 1, sideLeft.w - 2, 0.98);
  }

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

/**
 * Keep the two base-layer irises visible after hair and accessories have been
 * composed onto the larger head overlay cube. At 8x8, one opaque hair pixel
 * over an iris removes the entire eye in the 3D viewer; colour contrast alone
 * cannot recover it. Glasses are excluded because their visible frame
 * intentionally occupies the eye row; bangs keep their surrounding pixels.
 */
function preserveFaceReadability(atlas: RawImage, style: FaceStyle): void {
  if (style.glasses !== "none") return;

  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const eyePairs =
    style.eyeSpacing === "wide"
      ? ([
          [0, 1],
          [7, 6],
        ] as const)
      : style.eyeSpacing === "close"
        ? ([
            [1, 2],
            [5, 4],
          ] as const)
        : ([
            [1, 2],
            [6, 5],
          ] as const);

  const clearOverlayPixel = (x: number, y: number) => {
    const d = ((overlay.y + y) * ATLAS_SIZE + overlay.x + x) * 4;
    atlas.rgba[d] = 0;
    atlas.rgba[d + 1] = 0;
    atlas.rgba[d + 2] = 0;
    atlas.rgba[d + 3] = 0;
  };

  // Reveal both the sclera/corner and the iris. Clearing only the iris pixel
  // left an opaque, near-black outer-layer corner beside it; at normal preview
  // scale that merged with the fringe and made the face look eyeless. A tilted
  // eye moves its outer corner off row 4, so open that exact row as well.
  const outerEyeY =
    style.eyeTilt === "upturned" ? 3 : style.eyeTilt === "downturned" ? 5 : 4;
  for (const [outer, inner] of eyePairs) {
    for (const x of [outer, inner]) {
      clearOverlayPixel(x, 4);
    }
    if (outerEyeY !== 4) {
      clearOverlayPixel(outer, outerEyeY);
    }
  }
}

/**
 * Facial shading belongs on the inner head cube. Skin-coloured pixels on the
 * outer cube protrude in the 3D viewer and turn the eyes, nose, mouth and jaw
 * into a noisy mosaic. Clear those temporary portrait details before the hair
 * pass rebuilds the outer layer with genuine fringe and temple pixels.
 */
function resetPortraitFaceOverlay(atlas: RawImage, style: FaceStyle): void {
  if (style.glasses !== "none" || style.facialHair !== "none") return;
  for (const rect of [
    CLASSIC_LAYOUT.head.overlay.front,
    CLASSIC_LAYOUT.head.overlay.right,
    CLASSIC_LAYOUT.head.overlay.left,
  ]) {
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
        atlas.rgba[d] = 0;
        atlas.rgba[d + 1] = 0;
        atlas.rgba[d + 2] = 0;
        atlas.rgba[d + 3] = 0;
      }
    }
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
      return mixRgb(shadeRgb(color, 0.84), [0, 0, 0], 0.06);
    case 1:
    case 2:
      return shadeRgb(color, 0.94);
    case 3:
    case 4:
      return mixRgb(color, [112, 104, 98], 0.05);
    default:
      return mixRgb(color, [132, 122, 114], 0.09);
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
  skinColor: Rgb,
  style: FaceStyle,
  hasBackView: boolean,
): void {
  if (style.hairstyle === "bald" || style.hat !== "none") {
    return;
  }
  // Hair is composed after clothing. Keeping a snapshot lets asymmetric side
  // locks reveal the original garment on the shorter side instead of clearing
  // the second layer to transparent and accidentally erasing a cardigan.
  const underHair = atlas.rgba.slice();
  const base = CLASSIC_LAYOUT.head.base;
  const over = CLASSIC_LAYOUT.head.overlay;
  const s = style.hairstyle;
  const roundedFringeCut =
    s === "short" &&
    style.hairSilhouette === "rounded" &&
    (style.bangsLength === "brow" || style.bangsLength === "eye");
  const bangsDensity = style.bangsDensity ?? "balanced";
  const fringeEdge = style.fringeEdge ?? "staggered";
  const sideHairShape =
    style.sideHairShape ??
    (style.hairBackShape === "undercut"
      ? "undercut"
      : s === "short" && style.hairSilhouette === "rounded"
        ? "ear_hugging"
        : "tapered");
  const earExposure = style.earExposure ?? "partial";
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
  const fillTransparent = (
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
        if (atlas.rgba[d + 3] !== 0) continue;
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
  const clearPixel = (rect: Rect, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return;
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = 0;
    atlas.rgba[d + 1] = 0;
    atlas.rgba[d + 2] = 0;
    atlas.rgba[d + 3] = 0;
  };

  // 스타일별 옆/뒷머리 길이 (클라이언트와 동일 값)
  const baseSideRows =
    s === "buzz"
      ? 1
      : s === "short"
        ? roundedFringeCut
          ? 4
          : 3
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
        ? roundedFringeCut
          ? 5
          : 4
        : s === "medium" || s === "curly"
          ? 6
          : s === "bun" || s === "ponytail"
            ? 3
            : s === "afro"
              ? 4
              : 8;

  // 옆머리 (렌더는 가장자리 확장뿐이라 항상 카테고리로 채움)
  // Rounded outer-layer cut-outs must reveal hair, not portrait skin.
  fill(base.top, 0, 0, 8, 8);
  if (roundedFringeCut) {
    const paintSideRow = (
      rect: Rect,
      y: number,
      hairXs: readonly number[],
      mirrored: boolean,
    ) => {
      const hairSet = new Set(hairXs);
      for (let x = 0; x < 8; x++) {
        if (hairSet.has(x)) {
          fill(rect, x, y, 1, 1);
        } else {
          const isFarHalf = mirrored ? x < 4 : x >= 4;
          putColor(rect, x, y, shadeRgb(skinColor, isFarHalf ? 0.87 : 0.9));
        }
      }
    };
    if (sideHairShape === "ear_hugging") {
      fill(base.right, 0, 0, 8, Math.max(0, sideRows - 2));
      fill(base.left, 0, 0, 8, Math.max(0, sideRows - 2));
      paintSideRow(base.right, sideRows - 2, [0, 1, 2, 5, 6, 7], false);
      paintSideRow(base.left, sideRows - 2, [0, 1, 2, 5, 6, 7], true);
      const bottomHairXs =
        earExposure === "covered"
          ? [0, 1, 2, 5, 6, 7]
          : earExposure === "visible"
            ? [0, 7]
            : [0, 1, 2, 5, 6, 7];
      paintSideRow(base.right, sideRows - 1, bottomHairXs, false);
      paintSideRow(base.left, sideRows - 1, bottomHairXs, true);
      if (earExposure === "partial" && sideRows < base.right.h) {
        // Carry the inner cube one row around the visible ear. Without this
        // bracket the exact side view exposes a broad skin rectangle beneath
        // a flat hair band, even though the outer layer contains temple locks.
        // The two centre cells remain a readable 2 px ear window.
        const earBracketXs = [0, 1, 2, 5, 6, 7] as const;
        paintSideRow(base.right, sideRows, earBracketXs, false);
        paintSideRow(base.left, sideRows, earBracketXs, true);
      }
    } else {
      fill(base.right, 0, 0, 8, Math.max(0, sideRows - 1));
      fill(base.left, 0, 0, 8, Math.max(0, sideRows - 1));
      paintSideRow(base.right, sideRows - 1, [0, 1, 6, 7], false);
      paintSideRow(base.left, sideRows - 1, [0, 1, 6, 7], true);
    }
  } else {
    fill(base.right, 0, 0, 8, sideRows);
    fill(base.left, 0, 0, 8, sideRows);
  }
  if (
    style.sideHairLength === "short" &&
    (earExposure === "partial" || earExposure === "visible")
  ) {
    const earShadow = mixRgb(shadeRgb(skinColor, 0.78), hairColor, 0.08);
    const earMid = shadeRgb(skinColor, 0.9);
    const earLight = mixRgb(skinColor, [246, 218, 196], 0.16);
    for (const [rect, mirror] of [
      [base.right, false],
      [base.left, true],
    ] as const) {
      const px = (x: number) => (mirror ? 7 - x : x);
      putColor(rect, px(3), 4, earShadow);
      putColor(rect, px(4), 4, earLight);
      putColor(rect, px(3), 5, earMid);
      putColor(rect, px(4), 5, shadeRgb(earShadow, 0.92));
    }
  }
  // 뒷머리: 뒷면 뷰 렌더가 있으면 실제 렌더 유지
  if (!hasBackView) {
    if (roundedFringeCut && backRows > 1) {
      fill(base.back, 0, 0, 8, backRows - 1);
      fill(base.back, 2, backRows - 1, 4, 1);
      for (const x of [0, 1, 6, 7]) {
        putColor(
          base.back,
          x,
          backRows - 1,
          shadeRgb(skinColor, x < 4 ? 0.84 : 0.82),
        );
      }
    } else {
      fill(base.back, 0, 0, 8, backRows);
    }
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
      [0, 1, 2, 5, 6, 7],
      [0, 1, 6, 7],
      [0, 2, 5, 7],
      [0, 1, 6, 7],
      [0, 2, 5, 7],
      [0, 1, 6, 7],
      [1, 2, 5, 6],
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
      [0, 1, 3, 4, 6, 7],
      [0, 2, 3, 4, 5, 7],
      [0, 1, 6, 7],
      [0, 2, 5, 7],
      [0, 1, 6, 7],
      [1, 2, 5, 6],
    ]);
  }
  volumeMask(over.front, [[1, 2, 3, 4, 5, 6]]);

  const sideVolumeRows =
    s === "buzz"
      ? 1
      : s === "short"
        ? roundedFringeCut
          ? 4
          : 3
        : s === "medium" || s === "curly"
          ? 5
          : Math.min(7, sideRows);
  const sideMaskTemplate =
    style.hairVolume === "full"
      ? [
          [0, 1, 2, 5, 6, 7],
          [0, 1, 3, 4, 6, 7],
          [0, 1, 2, 5, 6, 7],
          [0, 1, 6, 7],
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
    else if (y === backVolumeRows - 1) backMask.push([0, 1, 3, 5, 6, 7]);
    else if (y % 2 === 0) backMask.push([0, 1, 2, 5, 6, 7]);
    else backMask.push([0, 1, 3, 4, 6, 7]);
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
    shadeRgb(
      hairVolumePixel(hairColor, over.back.x + x, over.back.y + y),
      shade,
    );
  const connectBackEdge = (y: number) => {
    const backAtX0 = backHairColor(0, y, 0.92);
    const backAtX7 = backHairColor(7, y, 0.92);
    putColor(over.back, 0, y, backAtX0);
    putColor(over.back, 7, y, backAtX7);
    // Standard Minecraft UV orientation: back x7 meets right x0, while
    // back x0 meets left x7. The opposite pairings are the front seams.
    putColor(over.right, 0, y, backAtX7);
    putColor(over.left, 7, y, backAtX0);
  };
  if (hairBackShape === "rounded") {
    for (let y = 1; y < Math.min(7, backVolumeRows + 1); y++) {
      connectBackEdge(y);
      if (y >= 4) {
        putColor(over.back, 1, y, backHairColor(1, y, 0.86));
        putColor(over.back, 6, y, backHairColor(6, y, 0.86));
      }
    }
    for (const x of [2, 3, 4, 5])
      putColor(over.back, x, 6, backHairColor(x, 6, 0.72));
  } else if (hairBackShape === "long") {
    for (let y = 2; y < 8; y++) {
      connectBackEdge(y);
      const leftStrand = y % 2 === 0 ? 1 : 2;
      const rightStrand = y % 2 === 0 ? 6 : 5;
      putColor(
        over.back,
        leftStrand,
        y,
        backHairColor(leftStrand, y, y >= 6 ? 0.68 : 0.9),
      );
      putColor(
        over.back,
        rightStrand,
        y,
        backHairColor(rightStrand, y, y >= 6 ? 0.68 : 0.9),
      );
      if (y === 4 || y === 6 || y === 7) {
        const centerX = y === 6 ? 4 : 3;
        putColor(over.back, centerX, y, backHairColor(centerX, y, 0.78));
      }
    }
  } else if (hairBackShape === "tied") {
    for (let y = 2; y < 8; y++) {
      putColor(over.back, 3, y, backHairColor(3, y, y === 4 ? 0.62 : 0.86));
      putColor(over.back, 4, y, backHairColor(4, y, y === 4 ? 0.62 : 0.86));
    }
    for (const [x, y] of [
      [2, 3],
      [5, 3],
      [2, 4],
      [5, 4],
    ] as const) {
      putColor(over.back, x, y, backHairColor(x, y, 0.72));
    }
  } else if (hairBackShape === "undercut") {
    for (let y = 0; y < Math.min(4, over.back.h); y++) {
      for (let x = 0; x < over.back.w; x++)
        putColor(over.back, x, y, backHairColor(x, y, y === 3 ? 0.74 : 0.94));
    }
    for (const [x, y] of [
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
      [3, 5],
      [4, 5],
    ] as const) {
      putColor(over.back, x, y, backHairColor(x, y, 0.58));
    }
  } else {
    for (let y = 2; y < Math.min(6, over.back.h); y++) connectBackEdge(y);
    for (const [x, y] of [
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
      [3, 6],
      [4, 6],
    ] as const) {
      putColor(over.back, x, y, backHairColor(x, y, y === 6 ? 0.62 : 0.78));
    }
  }

  const sideEdgeRows =
    style.hairVolume === "flat"
      ? Math.min(2, sideVolumeRows)
      : Math.min(
          7,
          Math.max(
            sideVolumeRows,
            s === "medium" || s === "curly" ? 5 : sideRows,
          ),
        );
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
  if (
    sideHairLength === "cheek" ||
    sideHairLength === "jaw" ||
    sideHairLength === "shoulder"
  ) {
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
    const paintTopSideCap = (
      y: number,
      depth: number,
      leftLock: Rgb,
      rightLock: Rgb,
    ) => {
      const capY = Math.min(7, y);
      const capWidth =
        sideHairLength === "shoulder"
          ? Math.min(3, depth)
          : sideHairLength === "jaw"
            ? Math.min(2, depth)
            : 1;
      for (let x = 0; x <= capWidth; x++) {
        const shade = x === 0 ? 1.04 : x === capWidth ? 0.76 : 0.9;
        putColor(over.top, x, capY, shadeRgb(leftLock, shade));
        putColor(over.top, 7 - x, capY, shadeRgb(rightLock, shade));
      }
      if (sideHairLength !== "cheek" && y >= 4) {
        const rootY = Math.max(1, capY - 1);
        putColor(
          over.top,
          Math.min(3, capWidth + 1),
          rootY,
          shadeRgb(leftLock, 0.72),
        );
        putColor(
          over.top,
          Math.max(4, 6 - capWidth),
          rootY,
          shadeRgb(rightLock, 0.72),
        );
      }
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
      paintTopSideCap(y, depth, leftLock, rightLock);
      if (y >= 4) {
        putColor(over.right, Math.min(depth, 3), y, shadeRgb(leftShadow, 0.82));
        putColor(
          over.left,
          Math.max(4, 7 - depth),
          y,
          shadeRgb(rightShadow, 0.82),
        );
      }
    }
    if (sideHairLength === "jaw" || sideHairLength === "shoulder") {
      for (let y = 3; y <= lastLockRow; y++) {
        const bridgeDepth =
          sideHairLength === "shoulder" ? (y >= 5 ? 5 : 4) : y >= 5 ? 4 : 3;
        const leftBridge = sideLockColor(
          1901,
          y,
          0,
          y >= lastLockRow - 1 ? 0.66 : 0.78,
        );
        const rightBridge = sideLockColor(
          2309,
          y,
          0,
          y >= lastLockRow - 1 ? 0.66 : 0.78,
        );
        for (let x = 2; x <= bridgeDepth; x++) {
          const shade = x === bridgeDepth ? 0.64 : x % 2 === 0 ? 0.84 : 0.72;
          putColor(over.right, x, y, shadeRgb(leftBridge, shade));
          putColor(over.left, 7 - x, y, shadeRgb(rightBridge, shade));
        }
        putColor(
          over.right,
          Math.min(6, bridgeDepth + 1),
          y,
          shadeRgb(leftBridge, 0.7),
        );
        putColor(
          over.left,
          Math.max(1, 6 - bridgeDepth),
          y,
          shadeRgb(rightBridge, 0.7),
        );
        if (y >= 4) {
          putColor(over.top, 1, Math.min(7, y), shadeRgb(leftBridge, 0.9));
          putColor(over.top, 6, Math.min(7, y), shadeRgb(rightBridge, 0.9));
        }
      }
    }
    for (const y of [Math.max(3, lastLockRow - 1), lastLockRow] as const) {
      const depth = sideDepthForRow(y);
      const leftTip = sideLockColor(
        2503,
        y,
        0,
        y === lastLockRow ? 0.58 : 0.68,
      );
      const rightTip = sideLockColor(
        2909,
        y,
        0,
        y === lastLockRow ? 0.58 : 0.68,
      );
      const leftInnerX = Math.min(3, depth + 1);
      const rightInnerX = Math.max(4, 6 - depth);

      putColor(over.front, 0, y, leftTip);
      putColor(over.front, 7, y, rightTip);
      if (sideHairLength !== "cheek") {
        putColor(over.front, 1, y, shadeRgb(leftTip, 0.74));
        putColor(over.front, 6, y, shadeRgb(rightTip, 0.74));
      }
      putColor(over.right, 0, y, leftTip);
      putColor(over.right, leftInnerX, y, shadeRgb(leftTip, 0.78));
      putColor(over.left, 7, y, rightTip);
      putColor(over.left, rightInnerX, y, shadeRgb(rightTip, 0.78));
      if (y > 3) {
        putColor(over.right, 1, y - 1, sideLockColor(2519, y, 1, 1.12));
        putColor(over.left, 6, y - 1, sideLockColor(2917, y, 1, 1.12));
      }
      putColor(over.back, 7, y, shadeRgb(leftTip, 0.7));
      putColor(over.back, 0, y, shadeRgb(rightTip, 0.7));
      if (sideHairLength !== "cheek") {
        putColor(over.back, 6, y, shadeRgb(leftTip, 0.62));
        putColor(over.back, 1, y, shadeRgb(rightTip, 0.62));
      }
    }
    if (sideHairLength === "shoulder") {
      const bodyOver = CLASSIC_LAYOUT.body.overlay;
      const bodyHair = (rect: Rect, x: number, y: number, shade = 1) =>
        shadeRgb(hairVolumePixel(hairColor, rect.x + x, rect.y + y), shade);
      const torsoStrandLight = mixRgb(
        hairColor,
        [242, 226, 214],
        style.hairTexture === "wavy" ? 0.24 : 0.16,
      );
      const torsoStrandDark = shadeRgb(hairColor, 0.52);
      for (let y = 0; y < 7; y++) {
        const leftX = y % 3 === 1 ? 1 : 0;
        const rightX = y % 3 === 1 ? 6 : 7;
        putColor(
          bodyOver.front,
          leftX,
          y,
          bodyHair(bodyOver.front, leftX, y, y >= 5 ? 0.72 : 0.94),
        );
        putColor(
          bodyOver.front,
          rightX,
          y,
          bodyHair(bodyOver.front, rightX, y, y >= 5 ? 0.72 : 0.94),
        );
        if (y <= 4 || y % 2 === 0) {
          putColor(
            bodyOver.front,
            Math.min(2, leftX + 1),
            y,
            bodyHair(bodyOver.front, Math.min(2, leftX + 1), y, 0.74),
          );
          putColor(
            bodyOver.front,
            Math.max(5, rightX - 1),
            y,
            bodyHair(bodyOver.front, Math.max(5, rightX - 1), y, 0.74),
          );
        }
        // Keep shoulder locks continuous on the side faces. Alternating the
        // outer pixel between columns made long hair read as disconnected spots.
        const sideShade = y >= 6 ? 0.66 : y % 3 === 1 ? 0.9 : 0.78;
        putColor(
          bodyOver.right,
          0,
          y,
          bodyHair(bodyOver.right, 0, y, sideShade),
        );
        putColor(
          bodyOver.left,
          bodyOver.left.w - 1,
          y,
          bodyHair(bodyOver.left, bodyOver.left.w - 1, y, sideShade),
        );
        if (y <= 5 || y % 2 === 0) {
          putColor(
            bodyOver.right,
            1,
            y,
            bodyHair(bodyOver.right, 1, y, sideShade * 0.86),
          );
          putColor(
            bodyOver.left,
            bodyOver.left.w - 2,
            y,
            bodyHair(bodyOver.left, bodyOver.left.w - 2, y, sideShade * 0.86),
          );
        }
      }
      for (const [x, y, color] of [
        [1, 2, torsoStrandLight],
        [2, 3, shadeRgb(torsoStrandLight, 0.86)],
        [1, 5, torsoStrandDark],
        [0, 6, shadeRgb(torsoStrandDark, 0.86)],
        [6, 2, shadeRgb(torsoStrandLight, 0.94)],
        [5, 4, shadeRgb(torsoStrandLight, 0.82)],
        [6, 6, torsoStrandDark],
        [7, 5, shadeRgb(torsoStrandDark, 0.9)],
      ] as const) {
        putColor(bodyOver.front, x, y, color);
      }
      putColor(bodyOver.right, 1, 3, shadeRgb(torsoStrandLight, 0.82));
      putColor(bodyOver.right, 0, 6, torsoStrandDark);
      putColor(bodyOver.left, 2, 3, shadeRgb(torsoStrandLight, 0.82));
      putColor(bodyOver.left, 3, 6, torsoStrandDark);
      for (let y = 0; y < 8; y++) {
        putColor(
          bodyOver.back,
          0,
          y,
          bodyHair(bodyOver.back, 0, y, y >= 6 ? 0.62 : 0.86),
        );
        putColor(
          bodyOver.back,
          7,
          y,
          bodyHair(bodyOver.back, 7, y, y >= 6 ? 0.62 : 0.86),
        );
        if (hairBackShape === "long" && y >= 2) {
          putColor(
            bodyOver.back,
            3,
            y,
            bodyHair(bodyOver.back, 3, y, y >= 6 ? 0.6 : 0.78),
          );
          putColor(
            bodyOver.back,
            4,
            y,
            bodyHair(bodyOver.back, 4, y, y >= 6 ? 0.6 : 0.78),
          );
        }
      }
      putColor(bodyOver.back, 2, 4, shadeRgb(torsoStrandLight, 0.78));
      putColor(bodyOver.back, 5, 4, shadeRgb(torsoStrandLight, 0.78));
      putColor(bodyOver.back, 3, 7, shadeRgb(torsoStrandDark, 0.82));
      putColor(bodyOver.back, 4, 7, torsoStrandDark);

      const bodyTop = bodyOver.top;
      const topFrontY = Math.max(0, bodyTop.h - 1);
      const topBackY = 0;
      for (let y = 0; y < bodyTop.h; y++) {
        const edgeShade = y === topFrontY ? 0.62 : y % 2 === 0 ? 0.86 : 0.74;
        putColor(bodyTop, 0, y, bodyHair(bodyTop, 0, y, edgeShade));
        putColor(bodyTop, 7, y, bodyHair(bodyTop, 7, y, edgeShade));
        if (y >= 1) {
          putColor(bodyTop, 1, y, bodyHair(bodyTop, 1, y, edgeShade * 0.9));
          putColor(bodyTop, 6, y, bodyHair(bodyTop, 6, y, edgeShade * 0.9));
        }
      }
      putColor(bodyTop, 2, topFrontY, shadeRgb(torsoStrandLight, 0.84));
      putColor(bodyTop, 5, topFrontY, shadeRgb(torsoStrandLight, 0.78));
      putColor(bodyTop, 0, topBackY, shadeRgb(torsoStrandDark, 0.88));
      putColor(bodyTop, 7, topBackY, torsoStrandDark);

      const rightArmOver = CLASSIC_LAYOUT.rightArm.overlay;
      const leftArmOver = CLASSIC_LAYOUT.leftArm.overlay;
      const armHair = (rect: Rect, x: number, y: number, shade = 1) =>
        shadeRgb(hairVolumePixel(hairColor, rect.x + x, rect.y + y), shade);
      const paintShoulderDrape = (
        arm: typeof rightArmOver,
        innerX: number,
        outerX: number,
        sideFace: Rect,
        mirrorPhase: number,
      ) => {
        const topY = 0;
        const lastY = Math.min(5, arm.front.h - 1);
        for (let y = 0; y <= lastY; y++) {
          const shade = y >= 4 ? 0.58 : y % 2 === mirrorPhase ? 0.82 : 0.7;
          putColor(arm.front, innerX, y, armHair(arm.front, innerX, y, shade));
          if (y <= 3 || y % 2 === mirrorPhase) {
            putColor(
              arm.front,
              outerX,
              y,
              armHair(arm.front, outerX, y, shade * 0.92),
            );
          }
          putColor(
            sideFace,
            y % 2,
            y,
            armHair(sideFace, y % 2, y, shade * 0.9),
          );
        }
        for (const [x, y, color] of [
          [innerX, topY, torsoStrandLight],
          [outerX, topY + 1, shadeRgb(torsoStrandLight, 0.86)],
          [innerX, lastY, torsoStrandDark],
        ] as const) {
          putColor(arm.front, x, y, color);
        }
        if (arm.top.h > 0) {
          putColor(
            arm.top,
            innerX,
            Math.min(arm.top.h - 1, 1),
            shadeRgb(torsoStrandLight, 0.9),
          );
          putColor(
            arm.top,
            outerX,
            Math.min(arm.top.h - 1, 2),
            shadeRgb(torsoStrandDark, 0.88),
          );
        }
      };
      paintShoulderDrape(
        rightArmOver,
        0,
        rightArmOver.front.w - 1,
        rightArmOver.right,
        0,
      );
      paintShoulderDrape(
        leftArmOver,
        leftArmOver.front.w - 1,
        0,
        leftArmOver.left,
        1,
      );

      if (style.hairTexture === "wavy" || style.hairTexture === "curly") {
        const layerLight = mixRgb(hairColor, [246, 226, 214], 0.28);
        const layerMid = shadeRgb(hairColor, 0.72);
        const layerDark = shadeRgb(hairColor, 0.48);
        const paintLayerPixel = (
          rect: Rect,
          x: number,
          y: number,
          color: Rgb,
        ) => {
          if (x >= 0 && x < rect.w && y >= 0 && y < rect.h)
            putColor(rect, x, y, color);
        };
        const paintSideLayer = (rect: Rect, mirror: boolean) => {
          for (const [x, y, color] of [
            [mirror ? 6 : 1, 2, layerLight],
            [mirror ? 5 : 2, 3, layerMid],
            [mirror ? 4 : 3, 4, layerDark],
            [mirror ? 5 : 2, 5, shadeRgb(layerLight, 0.86)],
            [mirror ? 6 : 1, 6, layerMid],
            [mirror ? 4 : 3, 7, layerDark],
          ] as const) {
            paintLayerPixel(rect, x, y, color);
          }
        };
        paintSideLayer(over.right, false);
        paintSideLayer(over.left, true);
        for (const [x, y, color] of [
          [1, 5, layerLight],
          [2, 6, layerMid],
          [3, 7, layerDark],
          [6, 5, shadeRgb(layerLight, 0.92)],
          [5, 6, layerMid],
          [4, 7, layerDark],
        ] as const) {
          paintLayerPixel(over.back, x, y, color);
        }
        for (const [rect, edgeX, innerX] of [
          [bodyOver.right, 0, 1],
          [bodyOver.left, bodyOver.left.w - 1, bodyOver.left.w - 2],
        ] as const) {
          for (let y = 1; y < 8; y++) {
            const waveColor =
              y % 3 === 1 ? layerLight : y % 3 === 2 ? layerMid : layerDark;
            paintLayerPixel(rect, edgeX, y, waveColor);
            if (y >= 3 && y <= 6)
              paintLayerPixel(rect, innerX, y, shadeRgb(waveColor, 0.82));
          }
        }
      }

      if (
        (style.hairAccessory ?? "none") === "flower" &&
        (style.hairAccessorySide ?? "left") !== "center"
      ) {
        const accessoryOnRight =
          (style.hairAccessorySide ?? "left") === "right";
        const decoratedLight = mixRgb(hairColor, [248, 226, 216], 0.3);
        const decoratedMid = shadeRgb(hairColor, 0.72);
        const decoratedDark = shadeRgb(hairColor, 0.46);
        const accessoryLeaf: Rgb = [126, 151, 126];
        const accessoryLeafDark: Rgb = [86, 118, 96];
        const accessoryPetal: Rgb = [236, 184, 192];
        const headSide = accessoryOnRight ? over.left : over.right;
        const bodySide = accessoryOnRight ? bodyOver.left : bodyOver.right;
        const armOver = accessoryOnRight
          ? CLASSIC_LAYOUT.leftArm.overlay
          : CLASSIC_LAYOUT.rightArm.overlay;
        const armSide = accessoryOnRight ? armOver.left : armOver.right;
        const frontEdgeX = accessoryOnRight ? 7 : 0;
        const frontInnerX = accessoryOnRight ? 6 : 1;
        const sideOuterX = accessoryOnRight ? 1 : 6;
        const sideInnerX = accessoryOnRight ? 2 : 5;
        const bodySideOuterX = accessoryOnRight ? bodySide.w - 1 : 0;
        const bodySideInnerX = accessoryOnRight ? bodySide.w - 2 : 1;
        const armInnerX = accessoryOnRight ? armOver.front.w - 1 : 0;
        const armOuterX = accessoryOnRight ? 0 : armOver.front.w - 1;
        const bodyTop = bodyOver.top;
        const bodyTopOuterX = accessoryOnRight ? bodyTop.w - 1 : 0;
        const bodyTopInnerX = accessoryOnRight ? bodyTop.w - 2 : 1;
        const bodyTopAccentX = accessoryOnRight
          ? Math.max(0, bodyTop.w - 3)
          : Math.min(bodyTop.w - 1, 2);
        const bodyTopFrontY = Math.max(0, bodyTop.h - 1);
        const bodyTopMidY = Math.max(0, bodyTopFrontY - 1);

        for (let y = 4; y < 8; y++) {
          const color = y % 2 === 0 ? decoratedMid : decoratedDark;
          putColor(headSide, sideOuterX, y, color);
          putColor(
            headSide,
            sideInnerX,
            y,
            y >= 6 ? decoratedDark : decoratedLight,
          );
        }
        putColor(headSide, sideInnerX, 4, accessoryLeaf);
        putColor(headSide, sideOuterX, 5, accessoryPetal);
        putColor(over.front, frontEdgeX, 5, decoratedMid);
        putColor(over.front, frontInnerX, 6, decoratedDark);
        putColor(over.top, accessoryOnRight ? 6 : 1, 7, accessoryLeaf);
        putColor(over.top, accessoryOnRight ? 5 : 2, 7, decoratedDark);

        for (let y = 0; y < 8; y++) {
          const color =
            y <= 2 ? decoratedLight : y >= 6 ? decoratedDark : decoratedMid;
          putColor(bodyOver.front, frontEdgeX, y, color);
          if (y <= 5 || y % 2 === 0) {
            putColor(
              bodyOver.front,
              frontInnerX,
              y,
              y <= 2 ? accessoryLeaf : shadeRgb(color, 0.82),
            );
          }
          putColor(
            bodySide,
            bodySideOuterX,
            y,
            y >= 6 ? decoratedDark : decoratedMid,
          );
          if (y >= 2 && y <= 6) {
            putColor(
              bodySide,
              bodySideInnerX,
              y,
              y === 2 ? accessoryLeafDark : shadeRgb(decoratedMid, 0.8),
            );
          }
        }
        putColor(bodyOver.front, frontInnerX, 1, accessoryLeaf);
        putColor(bodyOver.front, frontInnerX, 2, accessoryPetal);
        putColor(bodyOver.front, frontEdgeX, 7, decoratedDark);
        putColor(bodySide, bodySideOuterX, 1, accessoryLeaf);
        putColor(bodySide, bodySideInnerX, 3, accessoryPetal);
        putColor(bodyTop, bodyTopOuterX, bodyTopFrontY, accessoryLeafDark);
        putColor(bodyTop, bodyTopInnerX, bodyTopFrontY, accessoryPetal);
        putColor(bodyTop, bodyTopAccentX, bodyTopMidY, accessoryLeaf);
        putColor(bodyTop, bodyTopOuterX, 0, shadeRgb(decoratedDark, 0.9));
        putColor(bodyTop, bodyTopInnerX, 0, decoratedMid);

        for (let y = 0; y <= 4; y++) {
          const color =
            y <= 1 ? decoratedLight : y >= 4 ? decoratedDark : decoratedMid;
          putColor(armOver.front, armInnerX, y, color);
          if (y <= 2 || y === 4)
            putColor(armOver.front, armOuterX, y, shadeRgb(color, 0.82));
          putColor(
            armSide,
            accessoryOnRight ? armSide.w - 1 : 0,
            y,
            shadeRgb(color, 0.88),
          );
        }
        putColor(armOver.front, armInnerX, 1, accessoryLeaf);
        putColor(
          armSide,
          accessoryOnRight ? Math.max(0, armSide.w - 2) : 1,
          2,
          accessoryPetal,
        );
        if (armOver.top.h > 0) {
          putColor(
            armOver.top,
            armInnerX,
            Math.min(armOver.top.h - 1, 1),
            accessoryLeaf,
          );
          putColor(
            armOver.top,
            armOuterX,
            Math.min(armOver.top.h - 1, 2),
            accessoryPetal,
          );
        }
      }
    }
  }
  if (hairBackShape === "long" && sideHairLength !== "shoulder") {
    const bodyOver = CLASSIC_LAYOUT.body.overlay;
    const backDrapeLight = mixRgb(
      hairColor,
      [242, 226, 214],
      style.hairTexture === "wavy" ? 0.22 : 0.14,
    );
    const backDrapeDark = shadeRgb(hairColor, 0.52);
    const bodyHair = (rect: Rect, x: number, y: number, shade = 1) =>
      shadeRgb(hairVolumePixel(hairColor, rect.x + x, rect.y + y), shade);

    for (let y = 0; y < 6; y++) {
      const row =
        y < 2
          ? ([2, 3, 4, 5] as const)
          : y < 4
            ? ([1, 2, 3, 4, 5, 6] as const)
            : ([2, 3, 4, 5] as const);
      for (const x of row) {
        const shade = y >= 4 ? 0.62 : x === 2 || x === 5 ? 0.82 : 0.72;
        putColor(bodyOver.back, x, y, bodyHair(bodyOver.back, x, y, shade));
      }
      putColor(
        bodyOver.right,
        0,
        y,
        bodyHair(bodyOver.right, 0, y, y >= 4 ? 0.58 : 0.78),
      );
      putColor(
        bodyOver.left,
        bodyOver.left.w - 1,
        y,
        bodyHair(bodyOver.left, bodyOver.left.w - 1, y, y >= 4 ? 0.58 : 0.78),
      );
      if (y <= 3 && sideHairLength === "jaw") {
        putColor(
          bodyOver.front,
          0,
          y,
          bodyHair(bodyOver.front, 0, y, y === 3 ? 0.64 : 0.82),
        );
        putColor(
          bodyOver.front,
          7,
          y,
          bodyHair(bodyOver.front, 7, y, y === 3 ? 0.64 : 0.82),
        );
      }
    }
    for (const [rect, x, y, color] of [
      [bodyOver.back, 2, 1, backDrapeLight],
      [bodyOver.back, 5, 2, shadeRgb(backDrapeLight, 0.9)],
      [bodyOver.back, 3, 5, backDrapeDark],
      [bodyOver.back, 4, 5, shadeRgb(backDrapeDark, 0.9)],
      [bodyOver.right, 1, 2, shadeRgb(backDrapeLight, 0.84)],
      [bodyOver.left, bodyOver.left.w - 2, 2, shadeRgb(backDrapeLight, 0.84)],
    ] as const) {
      putColor(rect, x, y, color);
    }
  }
  if (
    hairBackShape === "long" ||
    hairBackShape === "rounded" ||
    hairBackShape === "tapered"
  ) {
    const edgeRows =
      hairBackShape === "long"
        ? 8
        : hairBackShape === "rounded"
          ? 7
          : Math.min(6, over.back.h);
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
    // The larger second-layer cube becomes a square helmet when its corner
    // pixels are opaque. Remove matching corners on every adjacent face so
    // the smaller base cube peeks through as a two-step rounded silhouette,
    // without leaving a one-face-only UV crack.
    for (const rect of [over.front, over.back, over.right, over.left]) {
      for (const [x, y] of [
        [0, 0],
        [rect.w - 1, 0],
        [0, 1],
        [rect.w - 1, 1],
      ] as const) {
        clearPixel(rect, x, y);
      }
    }
    for (const [x, y] of [
      [0, 0],
      [over.top.w - 1, 0],
      [0, over.top.h - 1],
      [over.top.w - 1, over.top.h - 1],
    ] as const) {
      clearPixel(over.top, x, y);
    }
    for (const [rect, points] of [
      [
        over.top,
        [
          [1, 0],
          [2, 0],
          [3, 0],
          [4, 0],
          [5, 0],
          [6, 0],
          [0, 2],
          [7, 2],
        ],
      ],
      [
        over.front,
        [
          [1, 0],
          [2, 0],
          [5, 0],
          [6, 0],
          [1, 1],
          [6, 1],
        ],
      ],
      [
        over.right,
        [
          [1, 0],
          [2, 0],
          [1, 1],
          [2, 1],
        ],
      ],
      [
        over.left,
        [
          [5, 0],
          [6, 0],
          [5, 1],
          [6, 1],
        ],
      ],
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
    for (const [x, y] of [
      [0, 1],
      [1, 1],
      [2, 2],
      [3, 2],
    ] as const) {
      putColor(over.front, px(x), y, x <= 1 ? outlineLight : outlineMid);
    }
    putColor(mirror ? over.left : over.right, mirror ? 7 : 0, 2, outlineDark);
    putColor(mirror ? over.left : over.right, mirror ? 6 : 1, 3, outlineDark);
  } else if (hairSilhouette === "tousled" || hairSilhouette === "spiky") {
    const tufts =
      hairSilhouette === "spiky"
        ? ([
            [1, 0],
            [2, 1],
            [4, 0],
            [5, 1],
            [6, 0],
          ] as const)
        : ([
            [1, 1],
            [2, 0],
            [4, 1],
            [5, 0],
            [6, 2],
          ] as const);
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
        if (y % 2 === 0)
          paintStrand(rect, mirror ? waveX - 1 : waveX + 1, y, 2);
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
    const baseTone = hairVolumePixel(
      hairColor,
      over.front.x + x,
      over.front.y + y,
    );
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
    putColor(over.right, 7, y, left);
    putColor(over.left, 0, y, right);
    putColor(over.top, 0, Math.min(7, y + 1), shadeRgb(left, 1.04));
    putColor(over.top, 7, Math.min(7, y + 1), shadeRgb(right, 1.04));
  };
  const splitCenterFringe =
    style.bangs === "straight" &&
    hairPart === "center" &&
    bangsDensity !== "dense";
  const partedStraightFringe =
    style.bangs === "straight" && hairPart !== "none";
  if (style.bangs === "straight") {
    for (const x of splitCenterFringe
      ? [0, 1, 2, 5, 6, 7]
      : [0, 1, 2, 3, 4, 5, 6, 7]) {
      paintBang(x, 1);
    }
    for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) {
      paintBang(x, 2, x === 3 || x === 4 ? 0.84 : 0.96);
    }
    if (!partedStraightFringe || style.bangsLength === "short") {
      for (const x of [0, 2, 5, 7]) paintBang(x, 3, 0.74);
    }
    if (splitCenterFringe) {
      putColor(over.front, 3, 1, partAccent);
      putColor(over.front, 4, 1, partShadow);
      putColor(over.front, 3, 2, shadeRgb(partAccent, 0.78));
      putColor(over.front, 4, 2, shadeRgb(partShadow, 0.82));
    }
    wrapTemple(2);
    wrapTemple(3, 0.76, 0.76);
  } else if (style.bangs === "side") {
    const mirror = style.hairPart === "right";
    const px = (x: number) => (mirror ? 7 - x : x);
    for (const x of [0, 1, 2, 3, 4, 5, 6])
      paintBang(px(x), 1, x < 3 ? 1.04 : 0.9);
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
      const straightTipXs =
        bangsDensity === "dense"
          ? fringeEdge === "wispy"
            ? [0, 3, 6]
            : fringeEdge === "blunt"
              ? [0, 1, 3, 4, 6, 7]
              : [0, 2, 3, 5, 7]
          : bangsDensity === "sparse"
            ? hairPart === "right"
              ? [1, 5, 7]
              : [0, 2, 6]
            : hairPart === "left"
              ? [0, 2, 3, 6]
              : hairPart === "right"
                ? [1, 4, 5, 7]
                : splitCenterFringe
                  ? [0, 2, 5, 7]
                  : [1, 3, 4, 6];
      for (const x of straightTipXs) {
        paintBang(x, 3, 0.66);
      }
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
  if (
    sideHairLength === "short" &&
    s !== "buzz" &&
    s !== "afro" &&
    style.hairTexture !== "coily"
  ) {
    if (sideHairShape === "ear_hugging") {
      // The generic strand pass above can leave isolated pixels below the
      // intended ear opening. Rebuild both side overlays from a clean mask so
      // the silhouette, not texture noise, controls their visible length.
      for (const rect of [over.right, over.left]) {
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w; x++) clearPixel(rect, x, y);
        }
      }
      const profileRows: readonly (readonly number[])[] =
        earExposure === "covered"
          ? [
              [1, 2, 3, 4, 5, 6],
              [0, 1, 2, 3, 4, 5, 6, 7],
              [0, 1, 2, 5, 6, 7],
              [0, 1, 6, 7],
              [0, 7],
            ]
          : earExposure === "visible"
            ? [
                [1, 2, 3, 4, 5, 6],
                [0, 1, 6, 7],
                [0, 7],
              ]
            : [
                [1, 2, 3, 4, 5, 6],
                [0, 1, 2, 5, 6, 7],
                [0, 1, 2, 5, 6, 7],
                [0, 7],
              ];
      for (const [rect, phase] of [
        [over.right, 0],
        [over.left, 1],
      ] as const) {
        for (let row = 0; row < profileRows.length; row++) {
          const y = row + 1;
          for (const x of profileRows[row]) {
            putColor(
              rect,
              x,
              y,
              shadeRgb(
                bangTone(x, y),
                row >= 3 ? 0.58 : (x + row + phase) % 3 === 0 ? 0.78 : 0.9,
              ),
            );
          }
        }
      }
      const lastProfileY = profileRows.length;
      for (let y = 2; y <= lastProfileY; y++) {
        const tipShade =
          y === lastProfileY ? 0.58 : y === lastProfileY - 1 ? 0.74 : 0.9;
        const left = shadeRgb(bangTone(0, y), tipShade);
        const right = shadeRgb(bangTone(7, y), tipShade);
        putColor(over.front, 0, y, left);
        putColor(over.front, 7, y, right);
        putColor(over.right, 7, y, left);
        putColor(over.left, 0, y, right);
        if (y < lastProfileY) {
          const backAtX7 = shadeRgb(left, 0.76);
          const backAtX0 = shadeRgb(right, 0.76);
          putColor(over.back, 7, y, backAtX7);
          putColor(over.back, 0, y, backAtX0);
          putColor(over.right, 0, y, backAtX7);
          putColor(over.left, 7, y, backAtX0);
        }
      }
    } else {
      const lastTempleRow = bangsLength === "eye" ? 5 : 4;
      for (let y = 2; y <= lastTempleRow; y++) {
        const tip = y === lastTempleRow;
        const left = shadeRgb(
          bangTone(0, y),
          tip ? 0.58 : y === 3 ? 0.74 : 0.9,
        );
        const right = shadeRgb(
          bangTone(7, y),
          tip ? 0.58 : y === 3 ? 0.74 : 0.9,
        );
        const leftInner = shadeRgb(left, tip ? 0.76 : 0.86);
        const rightInner = shadeRgb(right, tip ? 0.76 : 0.86);
        const leftDepth = shadeRgb(left, tip ? 0.62 : 0.74);
        const rightDepth = shadeRgb(right, tip ? 0.62 : 0.74);

        putColor(over.front, 0, y, left);
        putColor(over.front, 7, y, right);
        putColor(over.right, 7, y, left);
        putColor(over.left, 0, y, right);
        putColor(over.right, 6, y, leftInner);
        putColor(over.left, 1, y, rightInner);
        if (y >= 3) {
          putColor(over.front, 1, y, leftInner);
          putColor(over.front, 6, y, rightInner);
          putColor(over.right, 5, y, leftDepth);
          putColor(over.left, 2, y, rightDepth);
        }
        if (y <= 3) {
          const backAtX7 = shadeRgb(left, 0.72);
          const backAtX0 = shadeRgb(right, 0.72);
          putColor(over.back, 7, y, backAtX7);
          putColor(over.back, 0, y, backAtX0);
          putColor(over.right, 0, y, backAtX7);
          putColor(over.left, 7, y, backAtX0);
        }
        if (tip) {
          putColor(over.back, 7, y, shadeRgb(left, 0.64));
          putColor(over.back, 0, y, shadeRgb(right, 0.64));
          putColor(over.right, 4, y, shadeRgb(left, 0.54));
          putColor(over.left, 3, y, shadeRgb(right, 0.54));
        }
        putColor(over.top, 0, Math.min(7, y + 1), shadeRgb(left, 1.04));
        putColor(over.top, 7, Math.min(7, y + 1), shadeRgb(right, 1.04));
        if (y >= 4) {
          putColor(over.top, 1, Math.min(7, y + 1), shadeRgb(leftInner, 0.92));
          putColor(over.top, 6, Math.min(7, y + 1), shadeRgb(rightInner, 0.92));
        }
      }
      const lowerTipRow = Math.min(6, lastTempleRow + 1);
      const leftLower = shadeRgb(bangTone(0, lowerTipRow), 0.5);
      const rightLower = shadeRgb(bangTone(7, lowerTipRow), 0.5);
      const leftLowerInner = shadeRgb(leftLower, 0.74);
      const rightLowerInner = shadeRgb(rightLower, 0.74);
      putColor(over.right, 5, lowerTipRow, leftLowerInner);
      putColor(over.right, 4, lowerTipRow, shadeRgb(leftLowerInner, 0.76));
      putColor(over.left, 2, lowerTipRow, rightLowerInner);
      putColor(over.left, 3, lowerTipRow, shadeRgb(rightLowerInner, 0.76));
      putColor(over.back, 7, lowerTipRow, shadeRgb(leftLower, 0.72));
      putColor(over.back, 0, lowerTipRow, shadeRgb(rightLower, 0.72));
      putColor(
        over.top,
        1,
        Math.min(7, lowerTipRow + 1),
        shadeRgb(leftLowerInner, 0.92),
      );
      putColor(
        over.top,
        6,
        Math.min(7, lowerTipRow + 1),
        shadeRgb(rightLowerInner, 0.92),
      );
    }
  }

  // Preserve the photographed break between fringe clusters on the second
  // layer as well. The base face already carries matching forehead pixels;
  // these transparent cells therefore read as a real opening with depth,
  // rather than a differently coloured stripe painted on top of the hair.
  const visibleFringeOpening = style.fringeOpening ?? "none";
  if (style.bangs !== "none" && visibleFringeOpening !== "none") {
    const gapXs =
      visibleFringeOpening === "center" && style.bangs === "curtain"
        ? [3, 4]
        : [
            visibleFringeOpening === "left"
              ? 2
              : visibleFringeOpening === "right"
                ? 5
                : 3,
          ];
    for (const x of gapXs) {
      clearPixel(over.front, x, 2);
      if (bangsLength === "brow" || bangsLength === "eye") {
        clearPixel(over.front, x, 3);
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
    // Complete long-hair coverage without erasing the directional waves,
    // seam shading and side-lock clusters already composed above.
    const backDrape = CLASSIC_LAYOUT.body.overlay.back;
    for (let y = 0; y < 5; y++) {
      const strandXs =
        y === 0
          ? [0, 1, 2, 5, 6, 7]
          : [0, y % 2 === 0 ? 2 : 3, y % 2 === 0 ? 5 : 4, 7];
      for (const x of strandXs) fillTransparent(backDrape, x, y, 1, 1, true);
    }
    for (const rect of [over.right, over.left]) {
      for (let y = 0; y < 6; y++) {
        const strandXs = y === 0 ? [1, 2, 5, 6] : y < 4 ? [0, 1, 6, 7] : [0, 7];
        for (const x of strandXs) fillTransparent(rect, x, y, 1, 1, true);
      }
    }
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

  if (s === "long") {
    // The base cube already supplies a continuous mass of hair. Retain only
    // connected rims and staggered strands on the enlarged cube so long hair
    // gains depth without becoming a second solid helmet.
    const retainRows = (rect: Rect, rows: readonly (readonly number[])[]) => {
      for (let y = 0; y < rect.h; y++) {
        const keep = new Set(rows[y] ?? []);
        for (let x = 0; x < rect.w; x++) {
          if (!keep.has(x)) clearPixel(rect, x, y);
        }
      }
    };
    retainRows(over.top, [
      [1, 2, 3, 4, 5, 6],
      [0, 1, 2, 5, 6, 7],
      [0, 1, 3, 6, 7],
      [0, 1, 4, 6, 7],
      [0, 1, 3, 6, 7],
      [0, 1, 4, 6, 7],
      [0, 1, 3, 6, 7],
      [1, 2, 5, 6],
    ]);
    const longSideRows = Array.from({ length: 8 }, (_, y) =>
      y === 0
        ? [0, 1, 2, 5, 6, 7]
        : y === 7
          ? [0, 1, 3, 4, 6, 7]
          : [0, 1, y % 2 === 0 ? 2 : 5, 6, 7],
    );
    retainRows(over.right, longSideRows);
    retainRows(
      over.left,
      longSideRows.map((row) => row.map((x) => 7 - x)),
    );
    retainRows(
      over.back,
      Array.from({ length: 8 }, (_, y) => [
        0,
        y % 2 === 0 ? 1 : 2,
        y === 4 || y === 7 ? 3 : y === 6 ? 4 : -1,
        y % 2 === 0 ? 6 : 5,
        7,
      ]),
    );
  }

  const longerSide = style.sideHairAsymmetry ?? "none";
  if (longerSide !== "none" && (style.sideHairLength ?? "short") !== "none") {
    const shorterSide = longerSide === "left" ? "right" : "left";
    const restore = (rect: Rect, x: number, y: number) => {
      if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return;
      const index = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        atlas.rgba[index + channel] = underHair[index + channel];
      }
    };
    const restoreRect = (
      rect: Rect,
      x0: number,
      y0: number,
      width: number,
      height: number,
    ) => {
      for (let y = y0; y < Math.min(rect.h, y0 + height); y++) {
        for (let x = x0; x < Math.min(rect.w, x0 + width); x++)
          restore(rect, x, y);
      }
    };
    const trimFrom =
      style.sideHairLength === "shoulder"
        ? 5
        : style.sideHairLength === "jaw"
          ? 5
          : style.sideHairLength === "cheek"
            ? 4
            : 3;
    const shortFrontX = shorterSide === "left" ? 0 : 6;
    const shortSide = shorterSide === "left" ? over.right : over.left;
    const shortBackX = shorterSide === "left" ? 6 : 0;
    const shortTopX = shorterSide === "left" ? 0 : 5;
    restoreRect(over.front, shortFrontX, trimFrom, 2, over.front.h - trimFrom);
    restoreRect(shortSide, 0, trimFrom, shortSide.w, shortSide.h - trimFrom);
    restoreRect(over.back, shortBackX, trimFrom, 2, over.back.h - trimFrom);
    restoreRect(over.top, shortTopX, trimFrom, 3, over.top.h - trimFrom);

    if (style.sideHairLength === "shoulder") {
      const body = CLASSIC_LAYOUT.body.overlay;
      const bodyFrontX = shorterSide === "left" ? 0 : body.front.w - 3;
      const bodySide = shorterSide === "left" ? body.right : body.left;
      const bodyBackX = shorterSide === "left" ? body.back.w - 3 : 0;
      restoreRect(body.front, bodyFrontX, 3, 3, body.front.h - 3);
      restoreRect(bodySide, 0, 3, bodySide.w, bodySide.h - 3);
      restoreRect(body.back, bodyBackX, 3, 3, body.back.h - 3);
      const arm =
        shorterSide === "left"
          ? CLASSIC_LAYOUT.rightArm.overlay
          : CLASSIC_LAYOUT.leftArm.overlay;
      for (const rect of [arm.front, arm.back, arm.right, arm.left]) {
        restoreRect(rect, 0, 3, rect.w, rect.h - 3);
      }
    }
  }

  const accessory = style.hairAccessory ?? "none";
  if (accessory !== "none") {
    const accessoryColors: Record<
      NonNullable<FaceStyle["hairAccessoryColor"]>,
      Rgb
    > = {
      black: [42, 40, 42],
      brown: [132, 86, 62],
      white: [238, 234, 228],
      gray: [146, 148, 154],
      red: [196, 72, 78],
      orange: [220, 132, 62],
      yellow: [226, 194, 82],
      green: [102, 158, 104],
      blue: [88, 132, 196],
      purple: [146, 104, 184],
      pink: [226, 150, 170],
    };
    const accessoryBase = accessoryColors[style.hairAccessoryColor ?? "pink"];
    const flowerPetal = mixRgb(accessoryBase, [255, 244, 240], 0.18);
    const flowerLight = mixRgb(accessoryBase, [255, 248, 244], 0.44);
    const flowerShade = shadeRgb(accessoryBase, 0.72);
    const flowerCenter: Rgb = [238, 213, 166];
    const leaf: Rgb = [126, 151, 126];
    const leafDark: Rgb = [86, 118, 96];
    const ribbon = mixRgb(accessoryBase, [255, 246, 242], 0.22);
    const ribbonDark = shadeRgb(accessoryBase, 0.62);
    const clip = mixRgb(accessoryBase, [235, 230, 220], 0.28);
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
    const accessorySide = style.hairAccessorySide ?? "left";
    const mirrorAccessory = accessorySide === "right";
    const sideFace = mirrorAccessory ? over.left : over.right;
    const mx = (x: number) => (mirrorAccessory ? 7 - x : x);
    const sx = (x: number) => (mirrorAccessory ? 7 - x : x);
    const putFrontAccessory = (x: number, y: number, color: Rgb) =>
      putColor(over.front, mx(x), y, color);
    const putSideAccessory = (x: number, y: number, color: Rgb) =>
      putColor(sideFace, sx(x), y, color);
    const putTopAccessory = (x: number, y: number, color: Rgb) =>
      putColor(over.top, mx(x), y, color);
    const putBackAccessory = (x: number, y: number, color: Rgb) =>
      putColor(over.back, mx(x), y, color);
    const drawFrontFlower = (cx: number, cy: number) =>
      drawFlower(over.front, mx(cx), cy);
    const drawSideFlower = (cx: number, cy: number) =>
      drawFlower(sideFace, sx(cx), cy);
    const drawTopFlower = (cx: number, cy: number) =>
      drawFlower(over.top, mx(cx), cy);
    const drawFrontRibbon = (cx: number, cy: number) =>
      drawRibbon(over.front, mx(cx), cy);
    const drawSideRibbon = (cx: number, cy: number) =>
      drawRibbon(sideFace, sx(cx), cy);

    if (accessory === "flower") {
      if (accessorySide === "center") {
        drawFlower(over.front, 3, 2);
        drawFlower(over.top, 3, 5);
        putColor(over.front, 2, 3, leaf);
        putColor(over.front, 4, 3, leafDark);
        putColor(over.top, 2, 6, flowerLight);
        putColor(over.top, 4, 6, flowerShade);
      } else {
        drawFrontFlower(1, 2);
        putFrontAccessory(2, 2, flowerLight);
        putFrontAccessory(2, 3, flowerShade);
        putFrontAccessory(2, 1, leaf);
        putFrontAccessory(1, 4, leafDark);
        // The side/top/back faces carry the flower volume. Keeping the front
        // cluster at the temple leaves both eyes and the mouth readable.
        drawSideFlower(6, 2);
        drawSideFlower(6, 4);
        drawSideFlower(3, 3);
        putSideAccessory(4, 2, flowerLight);
        putSideAccessory(4, 3, flowerPetal);
        putSideAccessory(5, 4, flowerCenter);
        putSideAccessory(5, 1, leaf);
        putSideAccessory(5, 3, leaf);
        putSideAccessory(7, 4, flowerShade);
        putSideAccessory(4, 1, leafDark);
        putSideAccessory(4, 5, leaf);
        putSideAccessory(3, 1, leafDark);
        putSideAccessory(2, 2, leaf);
        putSideAccessory(2, 4, flowerShade);
        putSideAccessory(3, 5, leaf);
        drawTopFlower(2, 5);
        drawTopFlower(4, 5);
        putTopAccessory(1, 4, leaf);
        putTopAccessory(1, 6, flowerPetal);
        putTopAccessory(2, 6, leaf);
        putTopAccessory(3, 6, leaf);
        putTopAccessory(4, 6, flowerLight);
        putTopAccessory(5, 6, leafDark);
        putTopAccessory(2, 7, flowerShade);
        putTopAccessory(3, 4, flowerLight);
        putTopAccessory(5, 4, flowerShade);
        putTopAccessory(6, 5, leaf);
        putTopAccessory(6, 6, leafDark);
        putBackAccessory(0, 3, flowerPetal);
        putBackAccessory(0, 4, flowerShade);
        putBackAccessory(1, 3, leaf);
        putBackAccessory(1, 4, flowerCenter);
        putBackAccessory(2, 4, leafDark);
        putBackAccessory(2, 3, leaf);
        putBackAccessory(3, 4, leafDark);
      }
    } else if (accessory === "bow" || accessory === "ribbon") {
      if (accessorySide === "center") {
        drawRibbon(over.front, 3, 2);
        putColor(over.top, 3, 6, ribbon);
      } else {
        drawFrontRibbon(1, 2);
        drawSideRibbon(6, 2);
        putTopAccessory(1, 6, ribbon);
      }
    } else if (accessory === "clip") {
      const clipPoints =
        accessorySide === "center"
          ? ([
              [3, 2],
              [4, 2],
              [3, 3],
              [4, 3],
            ] as const)
          : ([
              [0, 2],
              [1, 2],
              [2, 2],
              [1, 3],
            ] as const);
      for (const [x, y] of clipPoints) {
        putColor(over.front, accessorySide === "center" ? x : mx(x), y, clip);
      }
      if (accessorySide !== "center") {
        putSideAccessory(6, 2, clip);
        putSideAccessory(5, 2, shadeRgb(clip, 0.86));
      }
    }
  }

  // 옆면 overlay를 머리로 채우며 안경 다리가 덮였을 수 있어 다시 그린다
  // Bangs, side locks and accessories are composed after the silhouette pass.
  // Re-apply only the extreme rounded corners so later fringe painting cannot
  // accidentally restore the original full 8x8 square outline.
  if (hairSilhouette === "rounded") {
    for (const rect of [over.front, over.back, over.right, over.left]) {
      for (const [x, y] of [
        [0, 0],
        [rect.w - 1, 0],
        [0, 1],
        [rect.w - 1, 1],
      ] as const) {
        clearPixel(rect, x, y);
      }
    }
    for (const [x, y] of [
      [0, 0],
      [over.top.w - 1, 0],
      [0, over.top.h - 1],
      [over.top.w - 1, over.top.h - 1],
    ] as const) {
      clearPixel(over.top, x, y);
    }
  }

  if (roundedFringeCut && style.hairAccessory === "none") {
    // A short black cut otherwise collapses into one dark cuboid at preview
    // scale. Use connected, low-contrast clusters that follow the crown and
    // both temple seams; isolated bright pixels would read as noise or holes.
    const crownLight = mixRgb(hairColor, [162, 152, 142], 0.15);
    const crownMid = mixRgb(hairColor, [126, 118, 112], 0.11);
    const templeLight = mixRgb(hairColor, [142, 132, 124], 0.13);
    const templeMid = mixRgb(hairColor, [108, 100, 94], 0.08);
    const templeDark = shadeRgb(hairColor, 0.66);
    for (const [x, y, color] of [
      [2, 1, crownLight],
      [3, 1, crownLight],
      [4, 2, crownMid],
      [5, 2, crownMid],
      [2, 3, templeMid],
      [5, 3, templeDark],
    ] as const) {
      putColor(over.top, x, y, color);
    }

    for (const [y, seamColor, innerColor] of [
      [2, templeLight, crownMid],
      [3, templeMid, templeDark],
    ] as const) {
      // front x0 <-> right x7 and front x7 <-> left x0
      putColor(over.front, 0, y, seamColor);
      putColor(over.right, 7, y, seamColor);
      putColor(over.right, 6, y, innerColor);
      putColor(over.front, 7, y, shadeRgb(seamColor, 0.94));
      putColor(over.left, 0, y, shadeRgb(seamColor, 0.94));
      putColor(over.left, 1, y, shadeRgb(innerColor, 0.92));

      // back x7 <-> right x0 and back x0 <-> left x7
      const rearColor = shadeRgb(seamColor, 0.72);
      putColor(over.back, 7, y, rearColor);
      putColor(over.right, 0, y, rearColor);
      putColor(over.back, 0, y, shadeRgb(rearColor, 0.94));
      putColor(over.left, 7, y, shadeRgb(rearColor, 0.94));
    }
  }

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

  // Final vertical-seam guard. UV face x directions are not all the same:
  // front x0 <-> right x7, front x7 <-> left x0,
  // back x7 <-> right x0, and back x0 <-> left x7.
  // Keep both alpha and colour identical at each physical edge so a strand
  // cannot stop, change shade, or jump to the far edge when the cube rotates.
  const syncEdgePixel = (
    primary: Rect,
    primaryX: number,
    adjacent: Rect,
    adjacentX: number,
    y: number,
  ) => {
    const primaryIndex =
      ((primary.y + y) * ATLAS_SIZE + primary.x + primaryX) * 4;
    const adjacentIndex =
      ((adjacent.y + y) * ATLAS_SIZE + adjacent.x + adjacentX) * 4;
    const sourceIndex =
      atlas.rgba[primaryIndex + 3] !== 0
        ? primaryIndex
        : atlas.rgba[adjacentIndex + 3] !== 0
          ? adjacentIndex
          : -1;
    if (sourceIndex < 0) return;
    for (let channel = 0; channel < 4; channel++) {
      const value = atlas.rgba[sourceIndex + channel];
      atlas.rgba[primaryIndex + channel] = value;
      atlas.rgba[adjacentIndex + channel] = value;
    }
  };
  for (let y = 0; y < 8; y++) {
    syncEdgePixel(over.front, 0, over.right, 7, y);
    syncEdgePixel(over.front, 7, over.left, 0, y);
    syncEdgePixel(over.back, 7, over.right, 0, y);
    syncEdgePixel(over.back, 0, over.left, 7, y);
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
        put(
          rect,
          x,
          y,
          shadeRgb(hairPixel(hatColor, rect.x + x, rect.y + y, 0.04), shade),
        );
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
  const clear = (rect: Rect, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return;
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = 0;
    atlas.rgba[d + 1] = 0;
    atlas.rgba[d + 2] = 0;
    atlas.rgba[d + 3] = 0;
  };
  const copy = (src: Rect, dst: Rect, x: number, y: number, shade = 0.94) =>
    put(dst, x, y, shadeRgb(sample(src, x, y), shade));
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
  const declaredTopColor = style.topColor
    ? hexToRgb(style.topColor, [92, 92, 92])
    : null;
  const stabilizeGarmentColor = (sampled: Rgb, weight = 0.68) =>
    declaredTopColor
      ? alignRgbChroma(sampled, declaredTopColor, Math.max(0.86, weight))
      : sampled;
  const layeredTop =
    layer !== "none" || ["sweater", "hoodie", "jacket"].includes(topType);
  const paintGarmentTop = (
    baseTop: Rect,
    overlayTop: Rect,
    garmentColor: Rgb,
    raised: boolean,
  ) => {
    for (let y = 0; y < baseTop.h; y++) {
      for (let x = 0; x < baseTop.w; x++) {
        const edge = x === 0 || x === baseTop.w - 1 || y === 0;
        const fold = (x + y) % 3 === 0;
        put(
          baseTop,
          x,
          y,
          shadeRgb(garmentColor, edge ? 0.86 : fold ? 1.04 : 0.96),
        );
      }
    }
    if (!raised) return;
    for (let y = 0; y < overlayTop.h; y++) {
      for (let x = 0; x < overlayTop.w; x++) {
        const edge = x === 0 || x === overlayTop.w - 1 || y === 0;
        const fold =
          y === 1 &&
          (x === Math.floor(overlayTop.w / 2) - 1 ||
            x === Math.floor(overlayTop.w / 2));
        if (!edge && !fold) continue;
        put(
          overlayTop,
          x,
          y,
          shadeRgb(garmentColor, edge ? 0.76 : fold ? 1.06 : 0.92),
        );
      }
    }
  };
  const bodyShoulderColor = stabilizeGarmentColor(
    mixRgb(averageRect(baseFront, 2, 5), averageRect(baseBack, 2, 5), 0.34),
  );
  paintGarmentTop(
    body.base.top,
    body.overlay.top,
    bodyShoulderColor,
    layeredTop,
  );
  if (style.sleeveLength !== "sleeveless") {
    for (const part of ["rightArm", "leftArm"] as const) {
      const arm = CLASSIC_LAYOUT[part];
      const sleeveColor = stabilizeGarmentColor(
        mixRgb(
          averageRect(arm.base.front, 2, 5),
          averageRect(arm.base.back, 2, 5),
          0.3,
        ),
      );
      paintGarmentTop(arm.base.top, arm.overlay.top, sleeveColor, layeredTop);
    }
  }

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
      // Fabric volume belongs on the base. The raised layer marks only the
      // shoulder ridge, physical seams and hem so it does not become a box.
      for (let x = 0; x < dstRect.w; x++)
        volumeCopy(srcRect, dstRect, x, 0, "lit");
      for (let y = 1; y < dstRect.h - 1; y++) {
        volumeCopy(srcRect, dstRect, 0, y, "mid");
        if (y % 2 === 0) volumeCopy(srcRect, dstRect, dstRect.w - 1, y, "mid");
      }
      for (let x = 0; x < dstRect.w; x++) {
        volumeCopy(srcRect, dstRect, x, dstRect.h - 1, "hem");
      }
    }
  }

  if (outerGarment !== "none") {
    const sideSample = mixRgb(
      sample(baseFront, 1, 5),
      sample(baseFront, 6, 5),
      0.5,
    );
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
    const trimColor = shadeRgb(
      panelColor,
      outerGarment === "cardigan" ? 0.74 : 0.68,
    );
    const litPanel = shadeRgb(panelColor, 1.1);
    const hemPanel = shadeRgb(panelColor, 0.72);

    const panelXs = [0, 2, 5, 7] as const;
    for (let y = 0; y < front.h; y++) {
      for (const x of panelXs) {
        const edge = x === 0 || x === 7;
        const opening = x === 2 || x === 5;
        const shade =
          y === front.h - 1
            ? 0.72
            : y === 0
              ? 1.08
              : edge
                ? 0.86
                : opening
                  ? 0.78
                  : 0.98;
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
    if (outerGarment === "cardigan") {
      const pipingColor = mixRgb(panelColor, [255, 238, 232], 0.28);
      const pipingShadow = shadeRgb(trimColor, 0.72);
      const buttonColor = mixRgb(pipingColor, [238, 224, 216], 0.42);
      const pocketLight = shadeRgb(pipingColor, 0.94);
      const pocketShadow = shadeRgb(trimColor, 0.66);
      const yarnLight = mixRgb(panelColor, [255, 238, 232], 0.2);
      const yarnShadow = shadeRgb(panelColor, 0.62);

      for (const y of [2, 5, 8] as const) {
        put(front, 1, y, y === 5 ? buttonColor : shadeRgb(buttonColor, 0.94));
        put(
          front,
          6,
          y,
          y === 5 ? shadeRgb(buttonColor, 0.88) : shadeRgb(buttonColor, 0.78),
        );
      }
      for (const [x, y, color] of [
        [1, 7, pocketLight],
        [2, 7, pocketShadow],
        [1, 8, shadeRgb(pocketShadow, 0.84)],
        [6, 7, shadeRgb(pocketLight, 0.92)],
        [5, 7, pocketShadow],
        [6, 8, shadeRgb(pocketShadow, 0.78)],
      ] as const) {
        put(front, x, y, color);
      }
      for (let x = 0; x < front.w; x++) {
        if (x === 3 || x === 4) continue;
        put(
          front,
          x,
          front.h - 2,
          x % 2 === 0 ? pipingShadow : shadeRgb(pipingColor, 0.82),
        );
      }
      for (let y = 1; y < front.h - 2; y++) {
        put(front, 0, y, y % 2 === 0 ? shadeRgb(yarnLight, 0.94) : yarnShadow);
        put(
          front,
          7,
          y,
          y % 2 === 0 ? shadeRgb(yarnShadow, 0.88) : shadeRgb(yarnLight, 0.86),
        );
        if (y % 3 === 1) {
          put(front, 1, y, shadeRgb(yarnLight, 1.04));
          put(front, 6, y, shadeRgb(yarnShadow, 0.9));
        }
      }
    }

    for (let x = 0; x < back.w; x++) {
      put(
        back,
        x,
        0,
        shadeRgb(panelColor, x === 0 || x === back.w - 1 ? 0.82 : 1.02),
      );
      put(back, x, back.h - 1, hemPanel);
    }
    for (let y = 1; y < back.h - 1; y++) {
      put(back, 0, y, shadeRgb(panelColor, 0.82));
      if (y % 2 === 0) put(back, back.w - 1, y, shadeRgb(panelColor, 0.9));
      if (
        (outerGarment === "cardigan" || outerGarment === "coat") &&
        y % 3 === 1
      ) {
        put(back, 3, y, shadeRgb(panelColor, y >= back.h - 3 ? 0.7 : 0.84));
        put(back, 4, y, shadeRgb(panelColor, y >= back.h - 3 ? 0.64 : 0.78));
      }
    }
    for (const rect of [body.overlay.right, body.overlay.left]) {
      for (let x = 0; x < rect.w; x++) {
        put(rect, x, 0, litPanel);
        put(rect, x, rect.h - 1, hemPanel);
      }
      for (let y = 1; y < rect.h - 1; y++) {
        put(rect, 0, y, shadeRgb(panelColor, 0.82));
        if (y % 2 === 0) put(rect, rect.w - 1, y, shadeRgb(panelColor, 0.92));
        if (
          (outerGarment === "cardigan" || outerGarment === "coat") &&
          y >= rect.h - 4
        ) {
          put(rect, 0, y, shadeRgb(trimColor, y === rect.h - 1 ? 0.58 : 0.78));
          put(
            rect,
            rect.w - 1,
            y,
            shadeRgb(panelColor, y === rect.h - 1 ? 0.62 : 0.82),
          );
        }
      }
    }
    if (outerGarment === "cardigan") {
      const sidePocketLight = mixRgb(panelColor, [255, 238, 232], 0.24);
      const sidePocketShadow = shadeRgb(trimColor, 0.62);
      const sideYarnLight = mixRgb(panelColor, [255, 238, 232], 0.18);
      const sideYarnShadow = shadeRgb(panelColor, 0.6);
      for (const rect of [body.overlay.right, body.overlay.left]) {
        put(rect, 1, Math.min(rect.h - 3, 7), sidePocketLight);
        put(rect, 2, Math.min(rect.h - 3, 7), sidePocketShadow);
        put(rect, 0, rect.h - 2, sidePocketShadow);
        put(rect, rect.w - 1, rect.h - 2, shadeRgb(sidePocketLight, 0.78));
        for (let y = 1; y < rect.h - 2; y += 2) {
          put(rect, 0, y, sideYarnShadow);
          put(rect, rect.w - 1, y, shadeRgb(sideYarnLight, 0.9));
        }
      }
    }

    if (outerGarment !== "vest") {
      for (const part of ["rightArm", "leftArm"] as const) {
        const arm = CLASSIC_LAYOUT[part];
        for (const faceName of ["front", "back", "right", "left"] as const) {
          const dst = arm.overlay[faceName];
          const broadFace = faceName === "front" || faceName === "back";
          const shoulderXs = broadFace
            ? [0, dst.w - 1]
            : [part === "rightArm" ? 0 : dst.w - 1];
          for (const x of shoulderXs)
            put(dst, x, 0, shadeRgb(panelColor, 1.06));
          for (let x = 0; x < dst.w; x++)
            put(dst, x, dst.h - 1, shadeRgb(panelColor, 0.72));
          const seamX = part === "rightArm" ? 0 : dst.w - 1;
          for (let y = 1; y < dst.h - 1; y += 2) {
            put(dst, seamX, y, shadeRgb(panelColor, 0.84));
          }
          for (const foldY of [3, 6, 9] as const) {
            if (foldY >= dst.h - 2) continue;
            if (!broadFace) continue;
            const highlightX = part === "rightArm" ? 1 : dst.w - 2;
            put(dst, highlightX, foldY, shadeRgb(panelColor, 0.78));
            put(dst, highlightX, foldY + 1, shadeRgb(panelColor, 1.1));
          }
          if (outerGarment === "cardigan" && broadFace) {
            const cuffLight = mixRgb(panelColor, [255, 238, 232], 0.18);
            const cuffShadow = shadeRgb(panelColor, 0.58);
            const sleeveYarn = mixRgb(panelColor, [255, 238, 232], 0.14);
            for (let x = 0; x < dst.w; x++)
              put(
                dst,
                x,
                dst.h - 2,
                x === 0 || x === dst.w - 1
                  ? cuffShadow
                  : shadeRgb(cuffLight, 0.76),
              );
            for (let y = 1; y < dst.h - 3; y += 2) {
              const yarnX = part === "rightArm" ? 1 : Math.max(0, dst.w - 2);
              put(
                dst,
                yarnX,
                y,
                y % 4 === 1
                  ? shadeRgb(sleeveYarn, 1.08)
                  : shadeRgb(panelColor, 0.68),
              );
            }
          }
        }
        if (outerGarment === "cardigan") {
          const cuffLight = mixRgb(panelColor, [255, 238, 232], 0.18);
          const cuffShadow = shadeRgb(panelColor, 0.58);
          const shoulderLight = shadeRgb(panelColor, 1.08);
          const shoulderShadow = shadeRgb(panelColor, 0.74);
          for (let x = 0; x < arm.overlay.top.w; x++)
            put(
              arm.overlay.top,
              x,
              0,
              x === 0 || x === arm.overlay.top.w - 1
                ? shoulderShadow
                : shoulderLight,
            );
          for (let x = 0; x < arm.overlay.bottom.w; x++)
            put(
              arm.overlay.bottom,
              x,
              arm.overlay.bottom.h - 1,
              x === 0 || x === arm.overlay.bottom.w - 1
                ? cuffShadow
                : shadeRgb(cuffLight, 0.88),
            );
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
    const paleAccent = mixRgb(
      averageRect(baseFront, 0, 2),
      [255, 250, 242],
      0.72,
    );
    const accentShadow = shadeRgb(paleAccent, 0.72);
    const darkAccent = shadeRgb(averageRect(baseFront, 2, 3), 0.48);
    if (neckAccessory === "bow") {
      put(front, 2, 0, shadeRgb(paleAccent, 1.04));
      put(front, 5, 0, shadeRgb(paleAccent, 0.96));
      put(front, 2, 1, paleAccent);
      put(front, 5, 1, paleAccent);
      put(front, 3, 1, accentShadow);
      put(front, 4, 1, accentShadow);
      put(front, 1, 2, shadeRgb(paleAccent, 1.08));
      put(front, 6, 2, shadeRgb(paleAccent, 0.88));
      put(front, 2, 2, shadeRgb(paleAccent, 0.92));
      put(front, 5, 2, shadeRgb(paleAccent, 0.86));
      put(front, 3, 3, paleAccent);
      put(front, 4, 3, shadeRgb(paleAccent, 0.9));
      put(front, 1, 1, shadeRgb(paleAccent, 1.04));
      put(front, 6, 1, shadeRgb(paleAccent, 0.94));
      put(front, 3, 2, shadeRgb(paleAccent, 1.06));
      put(front, 4, 2, accentShadow);
      put(front, 3, 4, shadeRgb(paleAccent, 0.94));
      put(front, 4, 4, accentShadow);
      put(front, 2, 5, shadeRgb(paleAccent, 0.86));
      put(front, 4, 5, shadeRgb(accentShadow, 0.9));
      put(front, 3, 6, shadeRgb(paleAccent, 0.82));
      put(front, 4, 6, shadeRgb(accentShadow, 0.78));
      put(
        body.overlay.top,
        2,
        body.overlay.top.h - 1,
        shadeRgb(paleAccent, 1.04),
      );
      put(body.overlay.top, 3, body.overlay.top.h - 1, paleAccent);
      put(body.overlay.top, 4, body.overlay.top.h - 1, accentShadow);
      put(
        body.overlay.top,
        5,
        body.overlay.top.h - 1,
        shadeRgb(paleAccent, 0.94),
      );
      put(body.overlay.right, 0, 1, shadeRgb(paleAccent, 0.88));
      put(body.overlay.right, 1, 1, shadeRgb(paleAccent, 0.76));
      put(body.overlay.right, 0, 2, shadeRgb(paleAccent, 0.82));
      put(body.overlay.right, 1, 3, shadeRgb(accentShadow, 0.86));
      put(
        body.overlay.left,
        body.overlay.left.w - 1,
        1,
        shadeRgb(paleAccent, 0.88),
      );
      put(
        body.overlay.left,
        body.overlay.left.w - 2,
        1,
        shadeRgb(paleAccent, 0.76),
      );
      put(
        body.overlay.left,
        body.overlay.left.w - 1,
        2,
        shadeRgb(paleAccent, 0.82),
      );
      put(
        body.overlay.left,
        body.overlay.left.w - 2,
        3,
        shadeRgb(accentShadow, 0.86),
      );
      if (outerGarment === "cardigan") {
        const bowLight = mixRgb(paleAccent, [255, 255, 255], 0.18);
        const bowMid = shadeRgb(paleAccent, 0.86);
        const bowDeep = shadeRgb(accentShadow, 0.72);
        const shirtPanel = mixRgb(
          paleAccent,
          averageRect(baseFront, 2, 5),
          0.18,
        );
        put(front, 3, 0, bowLight);
        put(front, 4, 0, bowMid);
        put(front, 2, 1, bowLight);
        put(front, 5, 1, bowMid);
        put(front, 1, 2, bowLight);
        put(front, 2, 2, paleAccent);
        put(front, 5, 2, bowMid);
        put(front, 6, 2, bowDeep);
        put(front, 2, 3, bowLight);
        put(front, 3, 3, shirtPanel);
        put(front, 4, 3, shadeRgb(shirtPanel, 0.88));
        put(front, 5, 3, bowMid);
        put(front, 3, 4, paleAccent);
        put(front, 4, 4, bowDeep);
        put(front, 4, 5, bowDeep);
        put(front, 3, 6, shadeRgb(bowMid, 0.84));
        put(front, 4, 6, shadeRgb(bowDeep, 0.86));
        put(body.overlay.top, 1, body.overlay.top.h - 1, bowLight);
        put(body.overlay.top, 6, body.overlay.top.h - 1, bowDeep);
        put(body.overlay.right, 0, 0, bowLight);
        put(body.overlay.right, 1, 2, bowMid);
        put(body.overlay.left, body.overlay.left.w - 1, 0, bowMid);
        put(body.overlay.left, body.overlay.left.w - 2, 2, bowDeep);
      }
    } else if (neckAccessory === "tie") {
      put(front, 3, 1, darkAccent);
      put(front, 4, 1, darkAccent);
      put(front, 3, 2, shadeRgb(darkAccent, 1.08));
      put(front, 4, 2, darkAccent);
      put(front, 3, 3, darkAccent);
      put(front, 4, 3, shadeRgb(darkAccent, 0.82));
      put(front, 3, 4, shadeRgb(darkAccent, 0.72));
    } else if (neckAccessory === "scarf") {
      for (const [x, y] of [
        [2, 0],
        [3, 0],
        [4, 0],
        [5, 0],
        [2, 1],
        [5, 1],
      ] as const) {
        put(front, x, y, paleAccent);
      }
      put(front, 3, 2, accentShadow);
      put(front, 4, 3, accentShadow);
    } else if (neckAccessory === "collar") {
      for (const [x, y] of [
        [1, 0],
        [2, 0],
        [5, 0],
        [6, 0],
        [2, 1],
        [5, 1],
      ] as const) {
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
      if ((style.bottomPattern ?? "plain") === "plain") {
        // The gap between generated legs is often sampled into the outermost
        // front/back UV column as a bright background stripe. Rebuild those
        // edge columns from the two interior trouser columns before adding
        // folds, while leaving the bottom shoe rows untouched.
        for (const faceName of ["front", "back"] as const) {
          const baseRect = leg.base[faceName];
          for (let y = 0; y < baseRect.h - 3; y++) {
            const trouserCore = mixRgb(
              sample(baseRect, 1, y),
              sample(baseRect, baseRect.w - 2, y),
              0.5,
            );
            put(
              baseRect,
              0,
              y,
              shadeRgb(trouserCore, faceName === "front" ? 0.86 : 0.78),
            );
            put(
              baseRect,
              baseRect.w - 1,
              y,
              shadeRgb(trouserCore, faceName === "front" ? 0.8 : 0.72),
            );
          }
        }
      }
      for (const faceName of ["front", "back", "right", "left"] as const) {
        const src = leg.base[faceName];
        const dst = leg.overlay[faceName];
        const broadFace = faceName === "front" || faceName === "back";
        for (let x = 0; x < dst.w; x++) {
          if (broadFace || x === 0 || x === dst.w - 1)
            volumeCopy(src, dst, x, 0, "lit");
        }
        for (const foldY of [4, 7] as const) {
          const foldXs = broadFace
            ? [1, 2]
            : [part === "rightLeg" ? 1 : dst.w - 2];
          for (const x of foldXs) {
            const edge = !broadFace;
            put(
              dst,
              x,
              foldY,
              shadeRgb(
                sample(src, x, foldY),
                faceName === "front" ? (edge ? 0.78 : 0.86) : edge ? 0.7 : 0.8,
              ),
            );
          }
          const highlightX = part === "rightLeg" ? 1 : dst.w - 2;
          put(
            dst,
            highlightX,
            Math.min(dst.h - 1, foldY + 1),
            shadeRgb(sample(src, highlightX, foldY), 1.08),
          );
        }
      }
      copy(
        leg.base.front,
        leg.overlay.front,
        part === "rightLeg" ? 0 : 3,
        2,
        0.74,
      );
      const outerFace =
        part === "rightLeg" ? leg.overlay.right : leg.overlay.left;
      const outerBase = part === "rightLeg" ? leg.base.right : leg.base.left;
      const seamX = part === "rightLeg" ? 0 : outerFace.w - 1;
      for (let y = 1; y < outerFace.h - 2; y++) {
        put(
          outerFace,
          seamX,
          y,
          shadeRgb(sample(outerBase, seamX, y), y % 3 === 0 ? 0.56 : 0.62),
        );
      }
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
    const sampledBottomColor = mixRgb(
      legTop,
      bodyLower,
      style.bottomType === "skirt" ? 0.22 : 0.12,
    );
    const bottomColor = style.bottomColor
      ? alignRgbChroma(
          sampledBottomColor,
          hexToRgb(style.bottomColor, sampledBottomColor),
          0.94,
        )
      : sampledBottomColor;
    const hemColor = shadeRgb(bottomColor, 0.78);
    const litColor = shadeRgb(bottomColor, 1.08);
    const plaidThread = mixRgb(bottomColor, [244, 231, 218], 0.42);
    const plaidShadow = shadeRgb(bottomColor, 0.58);
    const plaidCross = shadeRgb(bottomColor, 0.46);

    const paintLowerTorso = (baseRect: Rect, rect: Rect, rows: number) => {
      for (let y = rect.h - rows; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const localY = y - (rect.h - rows);
          const pleat =
            (style.bottomType === "skirt" || bottomPattern === "pleated") &&
            x % 3 === 1
              ? 0.86
              : x % 4 === 0
                ? 1.06
                : 0.96;
          let color = shadeRgb(bottomColor, y === rect.h - 1 ? 0.72 : pleat);
          if (bottomPattern === "plaid") {
            if (x === 1 || x === 5) color = plaidShadow;
            if (x === 3 || x === 6) color = mixRgb(color, plaidThread, 0.42);
            if (localY === 1 || localY === rows - 1)
              color = mixRgb(color, plaidThread, 0.38);
            if ((x === 1 || x === 5) && localY === 1) color = plaidCross;
            if ((x === 3 || x === 6) && localY === rows - 1)
              color = shadeRgb(plaidThread, 0.82);
          } else if (bottomPattern === "striped" && localY % 2 === 1) {
            color = shadeRgb(bottomColor, 0.72);
          } else if (
            bottomPattern === "lace" &&
            y === rect.h - 1 &&
            x % 2 === 0
          ) {
            color = mixRgb(bottomColor, [255, 248, 240], 0.55);
          }
          put(baseRect, x, y, shadeRgb(color, 0.98));
          const raised =
            y === rect.h - 1 ||
            x === 0 ||
            x === rect.w - 1 ||
            (bottomPattern === "plaid" &&
              (x === 1 || x === 5 || localY === 1)) ||
            (bottomPattern === "pleated" && x % 3 === 1);
          if (raised) put(rect, x, y, color);
        }
      }
    };

    const torsoRows = style.bottomType === "skirt" ? 4 : 2;
    paintLowerTorso(body.base.front, front, torsoRows);
    paintLowerTorso(body.base.back, back, torsoRows);
    const paintSideLowerTorso = (baseRect: Rect, rect: Rect, rows: number) => {
      for (let y = rect.h - rows; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const localY = y - (rect.h - rows);
          const edgePleat = x === 0 || x === rect.w - 1;
          const centerPleat = x % 2 === 1;
          let color = shadeRgb(
            bottomColor,
            y === rect.h - 1
              ? 0.74
              : edgePleat
                ? 0.82
                : centerPleat
                  ? 0.94
                  : 1.04,
          );
          if (bottomPattern === "plaid") {
            if (x === 1 || x === rect.w - 2) color = plaidShadow;
            if (x === 0 || x === rect.w - 1)
              color = mixRgb(color, plaidThread, 0.34);
            if (localY === 1 || localY === rows - 1) {
              color = mixRgb(color, plaidThread, 0.36);
            }
            if ((x === 1 || x === rect.w - 2) && localY === 1) {
              color = plaidCross;
            }
          } else if (bottomPattern === "striped" && localY % 2 === 1) {
            color = shadeRgb(bottomColor, 0.72);
          } else if (bottomPattern === "pleated" && centerPleat) {
            color = shadeRgb(bottomColor, 0.74);
          } else if (
            bottomPattern === "lace" &&
            y === rect.h - 1 &&
            x % 2 === 0
          ) {
            color = mixRgb(bottomColor, [255, 248, 240], 0.55);
          }
          put(baseRect, x, y, shadeRgb(color, 0.98));
          const raised =
            y === rect.h - 1 ||
            x === 0 ||
            x === rect.w - 1 ||
            (bottomPattern === "plaid" &&
              (x === 1 || x === rect.w - 2 || localY === 1)) ||
            (bottomPattern === "pleated" && centerPleat);
          if (raised) put(rect, x, y, color);
        }
      }
    };
    paintSideLowerTorso(body.base.right, body.overlay.right, torsoRows);
    paintSideLowerTorso(body.base.left, body.overlay.left, torsoRows);

    for (const part of ["rightLeg", "leftLeg"] as const) {
      const leg = CLASSIC_LAYOUT[part];
      const coverRows = style.bottomType === "skirt" ? 3 : 2;
      for (const faceName of ["front", "back", "right", "left"] as const) {
        const dst = leg.overlay[faceName];
        for (let y = 0; y < coverRows; y++) {
          for (let x = 0; x < dst.w; x++) {
            const tone =
              y === 0 ? litColor : y === coverRows - 1 ? hemColor : bottomColor;
            let color = tone;
            if (bottomPattern === "plaid" && (x === 1 || y === 1)) {
              color = x === 1 && y === 1 ? plaidCross : shadeRgb(tone, 0.72);
            } else if (
              bottomPattern === "plaid" &&
              x === 2 &&
              (faceName === "front" || faceName === "back")
            ) {
              color = mixRgb(tone, plaidThread, 0.45);
            } else if (
              bottomPattern === "plaid" &&
              x === 0 &&
              (faceName === "right" || faceName === "left")
            ) {
              color = mixRgb(tone, plaidThread, 0.34);
            } else if (bottomPattern === "pleated" && x % 2 === 1) {
              color = shadeRgb(tone, 0.76);
            } else if (
              bottomPattern === "lace" &&
              y === coverRows - 1 &&
              x % 2 === 0
            ) {
              color = mixRgb(tone, [255, 248, 240], 0.55);
            }
            if (
              bottomPattern === "plaid" &&
              y === coverRows - 1 &&
              x % 2 === 0
            ) {
              color = mixRgb(color, plaidThread, 0.24);
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

    if (bottomPattern === "plaid") {
      const paintPlaidTorsoWrap = (rect: Rect) => {
        const startY = rect.h - torsoRows;
        const midY = Math.min(rect.h - 1, startY + 1);
        const lowY = Math.max(startY, rect.h - 2);
        for (let x = 0; x < rect.w; x++) {
          const thread =
            x % 2 === 0 ? plaidThread : shadeRgb(plaidThread, 0.82);
          put(rect, x, midY, x === 1 || x === rect.w - 2 ? plaidCross : thread);
          if (x % 3 === 0) put(rect, x, lowY, shadeRgb(plaidThread, 0.9));
        }
        for (const x of [1, Math.max(1, rect.w - 2)] as const) {
          for (let y = startY; y < rect.h; y++) {
            put(rect, x, y, y === midY ? plaidCross : plaidShadow);
          }
        }
      };
      paintPlaidTorsoWrap(front);
      paintPlaidTorsoWrap(back);
      paintPlaidTorsoWrap(body.overlay.right);
      paintPlaidTorsoWrap(body.overlay.left);
      const bodyTop = body.overlay.top;
      const topFrontY = Math.max(0, bodyTop.h - 1);
      const topBackY = 0;
      for (let x = 0; x < bodyTop.w; x++) {
        const edgeThread =
          x % 2 === 0 ? plaidThread : shadeRgb(plaidThread, 0.78);
        const preservesCenterBow =
          (style.neckAccessory ?? "none") === "bow" && (x === 3 || x === 4);
        if (!preservesCenterBow) {
          put(
            bodyTop,
            x,
            topFrontY,
            x === 1 || x === bodyTop.w - 2 ? plaidCross : edgeThread,
          );
        }
        put(
          bodyTop,
          x,
          topBackY,
          x === 1 || x === bodyTop.w - 2
            ? plaidShadow
            : shadeRgb(edgeThread, 0.84),
        );
      }
      for (const x of [1, Math.max(1, bodyTop.w - 2)] as const) {
        for (let y = 0; y < bodyTop.h; y++) {
          put(bodyTop, x, y, y === topFrontY ? plaidCross : plaidShadow);
        }
      }
      const topMidY = Math.max(0, topFrontY - 1);
      for (let x = 0; x < bodyTop.w; x += 3) {
        put(bodyTop, x, topMidY, shadeRgb(plaidThread, 0.9));
      }

      for (const part of ["rightLeg", "leftLeg"] as const) {
        const leg = CLASSIC_LAYOUT[part];
        for (const faceName of ["front", "back", "right", "left"] as const) {
          const dst = leg.overlay[faceName];
          const coverRows = style.bottomType === "skirt" ? 3 : 2;
          const verticalX = Math.min(
            dst.w - 1,
            faceName === "front" || faceName === "back" ? 2 : 1,
          );
          const shadowX = Math.min(dst.w - 1, 1);
          for (let y = 0; y < coverRows; y++) {
            put(
              dst,
              verticalX,
              y,
              y === 1 ? plaidCross : mixRgb(plaidThread, litColor, 0.18),
            );
            put(dst, shadowX, y, y === 1 ? plaidCross : plaidShadow);
          }
          if (coverRows > 1) {
            for (let x = 0; x < dst.w; x++) {
              put(
                dst,
                x,
                1,
                x === verticalX || x === shadowX
                  ? plaidCross
                  : shadeRgb(plaidThread, x % 2 === 0 ? 0.94 : 0.78),
              );
            }
          }
        }
      }
    }
  }

  const bottomAccent = style.bottomAccent ?? "none";
  if (bottomAccent !== "none") {
    const waistColor = shadeRgb(
      mixRgb(
        averageRect(body.base.front, body.base.front.h - 2, 2),
        averageRect(body.base.back, body.base.back.h - 2, 2),
        0.5,
      ),
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
          put(
            leg.overlay.front,
            outerX,
            y,
            y % 3 === 0 ? shadeRgb(stripe, 0.78) : stripe,
          );
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
              put(
                rect,
                x,
                y,
                y % 2 === 0 ? accentLight : shadeRgb(accentLight, 0.76),
              );
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

  // 긴 외투 tail: 치마/바지 위쪽 다리 overlay에 열린 앞판과 뒤판을 이어서 허리 아래로 내려온 실루엣을 만든다.
  if (
    outerGarment === "cardigan" ||
    outerGarment === "coat" ||
    outerGarment === "open_jacket"
  ) {
    const sideSample = mixRgb(
      sample(baseFront, 1, 5),
      sample(baseFront, 6, 5),
      0.5,
    );
    const backSample = averageRect(baseBack, 2, 6);
    const panelBase = mixRgb(sideSample, backSample, 0.42);
    const tailColor =
      outerGarment === "cardigan"
        ? mixRgb(panelBase, [236, 202, 204], 0.18)
        : outerGarment === "coat"
          ? shadeRgb(panelBase, 0.82)
          : shadeRgb(panelBase, 0.9);
    const tailRows =
      outerGarment === "coat" ? 4 : outerGarment === "cardigan" ? 3 : 2;
    const trimColor = shadeRgb(
      tailColor,
      outerGarment === "cardigan" ? 0.72 : 0.66,
    );
    const foldLight = shadeRgb(tailColor, 1.12);
    const foldShadow = shadeRgb(
      tailColor,
      outerGarment === "cardigan" ? 0.56 : 0.5,
    );
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay;
    const leftLeg = CLASSIC_LAYOUT.leftLeg.overlay;

    for (let y = 0; y < tailRows; y++) {
      const lower = y === tailRows - 1;
      const shade = lower ? 0.68 : y === 0 ? 1.02 : 0.88;
      put(rightLeg.front, 0, y, shadeRgb(tailColor, shade));
      put(
        rightLeg.front,
        1,
        y,
        y % 2 === 0 ? trimColor : shadeRgb(trimColor, 1.08),
      );
      put(
        leftLeg.front,
        2,
        y,
        y % 2 === 0 ? shadeRgb(trimColor, 0.88) : trimColor,
      );
      put(leftLeg.front, 3, y, shadeRgb(tailColor, shade - 0.02));

      for (const rect of [
        rightLeg.right,
        rightLeg.left,
        leftLeg.right,
        leftLeg.left,
      ]) {
        for (let x = 0; x < rect.w; x++) {
          const edge = x === 0 || x === rect.w - 1;
          put(
            rect,
            x,
            y,
            shadeRgb(tailColor, lower ? 0.68 : edge ? 0.78 : 0.9),
          );
        }
      }
      for (const rect of [rightLeg.back, leftLeg.back]) {
        for (let x = 0; x < rect.w; x++) {
          const edge = x === 0 || x === rect.w - 1;
          put(
            rect,
            x,
            y,
            shadeRgb(tailColor, lower ? 0.66 : edge ? 0.76 : 0.88),
          );
        }
        put(rect, rect.w - 1, y, shadeRgb(trimColor, lower ? 0.62 : 0.78));
      }
    }
    if (tailRows >= 3) {
      put(rightLeg.front, 0, 1, foldLight);
      put(rightLeg.front, 1, 2, foldShadow);
      put(leftLeg.front, 3, 1, shadeRgb(foldLight, 0.96));
      put(leftLeg.front, 2, 2, shadeRgb(foldShadow, 0.92));
      put(rightLeg.right, 0, 2, foldShadow);
      put(rightLeg.left, rightLeg.left.w - 1, 2, shadeRgb(foldShadow, 0.9));
      put(leftLeg.right, 0, 2, shadeRgb(foldShadow, 0.9));
      put(leftLeg.left, leftLeg.left.w - 1, 2, foldShadow);
      put(rightLeg.back, 0, 2, shadeRgb(foldShadow, 0.86));
      put(leftLeg.back, leftLeg.back.w - 1, 2, shadeRgb(foldShadow, 0.86));
      put(rightLeg.back, 1, 1, shadeRgb(foldLight, 0.9));
      put(leftLeg.back, leftLeg.back.w - 2, 1, shadeRgb(foldLight, 0.9));

      if (
        outerGarment === "cardigan" &&
        (style.bottomType === "skirt" || style.bottomType === "shorts")
      ) {
        const longHemLight = mixRgb(tailColor, [255, 234, 230], 0.18);
        const longHemShadow = shadeRgb(trimColor, 0.58);
        put(rightLeg.front, 0, 3, shadeRgb(tailColor, 0.64));
        put(rightLeg.front, 1, 3, longHemShadow);
        put(rightLeg.front, 0, 4, shadeRgb(longHemShadow, 0.86));
        put(leftLeg.front, 3, 3, shadeRgb(tailColor, 0.6));
        put(leftLeg.front, 2, 3, shadeRgb(longHemLight, 0.78));
        put(leftLeg.front, 3, 4, shadeRgb(longHemShadow, 0.82));
        put(rightLeg.right, 0, 3, longHemShadow);
        put(rightLeg.right, 1, 3, shadeRgb(longHemLight, 0.78));
        put(leftLeg.left, leftLeg.left.w - 1, 3, longHemShadow);
        put(leftLeg.left, leftLeg.left.w - 2, 3, shadeRgb(longHemLight, 0.74));
        put(rightLeg.back, 0, 3, shadeRgb(longHemShadow, 0.86));
        put(leftLeg.back, leftLeg.back.w - 1, 3, shadeRgb(longHemShadow, 0.82));
      }
    }
  }

  // 신발: 발목 둘레와 밑창을 overlay로 올려 발끝 두께를 만든다 (하의 종류 무관).
  for (const part of ["rightLeg", "leftLeg"] as const) {
    const leg = CLASSIC_LAYOUT[part];
    for (const faceName of ["front", "back", "right", "left"] as const) {
      const src = leg.base[faceName];
      const dst = leg.overlay[faceName];
      const raisedXs =
        faceName === "front"
          ? [0, 1, 2, 3]
          : faceName === "back"
            ? [1, 2]
            : faceName === "right"
              ? [0, 1]
              : [2, 3];
      for (const x of raisedXs) {
        volumeCopy(
          src,
          dst,
          x,
          dst.h - 2,
          faceName === "front" ? "lit" : "mid",
        );
      }
      for (const x of raisedXs.filter(
        (x) => x === 0 || x === dst.w - 1 || faceName === "front",
      ))
        volumeCopy(src, dst, x, dst.h - 1, "mid");
    }
    for (let y = 0; y < leg.overlay.bottom.h; y++) {
      for (let x = 0; x < leg.overlay.bottom.w; x++) {
        if (
          x === 0 ||
          y === 0 ||
          x === leg.overlay.bottom.w - 1 ||
          y === leg.overlay.bottom.h - 1
        )
          volumeCopy(leg.base.bottom, leg.overlay.bottom, x, y, "hem");
      }
    }
  }

  const dressyShoes =
    style.bottomType === "skirt" ||
    style.bottomType === "shorts" ||
    outerGarment === "cardigan" ||
    style.neckAccessory === "bow" ||
    style.bottomAccent === "ribbon";
  const explicitShoeStyle = style.shoeStyle;
  const shoeStyle =
    explicitShoeStyle ?? (dressyShoes ? "dress_shoes" : "sneakers");
  if (explicitShoeStyle || dressyShoes) {
    for (const part of ["rightLeg", "leftLeg"] as const) {
      const leg = CLASSIC_LAYOUT[part];
      const shoeBase = mixRgb(
        averageRect(leg.base.front, leg.base.front.h - 2, 2),
        [255, 244, 226],
        0.42,
      );
      const shoeAccent = mixRgb(shoeBase, [255, 250, 238], 0.52);
      const shoeShadow = shadeRgb(shoeBase, 0.72);
      const shoeBright = mixRgb(shoeAccent, [255, 255, 255], 0.3);
      const bowShadow = shadeRgb(shoeAccent, 0.64);
      const front = leg.overlay.front;

      if (shoeStyle === "boots") {
        const boot = shadeRgb(mixRgb(shoeBase, [42, 35, 32], 0.5), 0.78);
        const bootLight = mixRgb(boot, [136, 112, 90], 0.34);
        const bootDeep = shadeRgb(boot, 0.58);
        for (const faceName of ["front", "back", "right", "left"] as const) {
          const rect = leg.overlay[faceName];
          for (let y = rect.h - 4; y < rect.h; y++) {
            for (let x = 0; x < rect.w; x++) {
              const edge = x === 0 || x === rect.w - 1;
              const ankle = y === rect.h - 4;
              put(rect, x, y, ankle ? bootLight : edge ? bootDeep : boot);
            }
          }
        }
        put(front, 1, front.h - 1, bootDeep);
        put(front, 2, front.h - 1, shadeRgb(bootDeep, 0.86));
        put(front, 1, front.h - 3, bootLight);
        put(front, 2, front.h - 3, shadeRgb(bootLight, 0.88));
      } else if (shoeStyle === "loafers") {
        const leather = shadeRgb(mixRgb(shoeBase, [58, 42, 34], 0.46), 0.72);
        const leatherLight = mixRgb(leather, [164, 126, 86], 0.34);
        const strap = shadeRgb(leather, 0.52);
        put(front, 0, front.h - 2, leatherLight);
        put(front, 1, front.h - 2, leather);
        put(front, 2, front.h - 2, leather);
        put(front, 3, front.h - 2, shadeRgb(leather, 0.84));
        put(front, 1, front.h - 3, leatherLight);
        put(front, 2, front.h - 3, strap);
        put(front, 1, front.h - 1, strap);
        put(front, 2, front.h - 1, shadeRgb(strap, 0.84));
        for (const side of [leg.overlay.right, leg.overlay.left]) {
          put(side, 0, side.h - 2, leatherLight);
          put(side, 1, side.h - 2, leather);
          put(side, side.w - 1, side.h - 2, strap);
          put(side, side.w - 1, side.h - 1, shadeRgb(strap, 0.82));
        }
        for (const x of [1, 2])
          put(leg.overlay.back, x, leg.overlay.back.h - 2, leather);
      } else if (shoeStyle === "sandals") {
        const strap = shadeRgb(mixRgb(shoeBase, [92, 64, 44], 0.42), 0.76);
        const sole = mixRgb(shoeBase, [232, 208, 178], 0.5);
        for (const x of [0, 3]) put(front, x, front.h - 2, strap);
        put(front, 1, front.h - 1, sole);
        put(front, 2, front.h - 1, shadeRgb(sole, 0.88));
        put(front, 1, front.h - 3, strap);
        put(front, 2, front.h - 3, strap);
        for (const side of [leg.overlay.right, leg.overlay.left]) {
          put(side, 0, side.h - 2, strap);
          put(side, 1, side.h - 1, sole);
          put(side, side.w - 1, side.h - 3, strap);
        }
      } else if (shoeStyle === "sneakers") {
        const lace = mixRgb(shoeAccent, [255, 255, 255], 0.62);
        const sole = shadeRgb(mixRgb(shoeBase, [245, 245, 238], 0.5), 0.86);
        put(front, 0, front.h - 2, shoeBright);
        put(front, 1, front.h - 2, shoeAccent);
        put(front, 2, front.h - 2, shoeAccent);
        put(front, 3, front.h - 2, shadeRgb(shoeAccent, 0.82));
        put(front, 1, front.h - 3, lace);
        put(front, 2, front.h - 3, shadeRgb(lace, 0.86));
        put(front, 1, front.h - 1, sole);
        put(front, 2, front.h - 1, shadeRgb(sole, 0.84));
        for (const side of [leg.overlay.right, leg.overlay.left]) {
          put(side, 0, side.h - 2, shoeAccent);
          put(side, 1, side.h - 2, shadeRgb(shoeAccent, 0.88));
          put(side, side.w - 1, side.h - 1, sole);
          put(side, side.w - 1, side.h - 3, lace);
        }
        for (const x of [1, 2])
          put(
            leg.overlay.back,
            x,
            leg.overlay.back.h - 2,
            shadeRgb(shoeAccent, 0.88),
          );
      } else {
        const sole = shadeRgb(mixRgb(shoeBase, [255, 252, 244], 0.62), 0.82);
        const soleShadow = shadeRgb(sole, 0.72);
        const strapDeep = shadeRgb(bowShadow, 0.72);
        put(front, 1, front.h - 2, shoeAccent);
        put(front, 2, front.h - 2, shadeRgb(shoeAccent, 0.88));
        put(front, 0, front.h - 1, sole);
        put(front, 1, front.h - 1, shadeRgb(shoeAccent, 0.96));
        put(front, 2, front.h - 1, shoeShadow);
        put(front, 3, front.h - 1, soleShadow);
        put(front, 0, front.h - 2, shoeBright);
        put(front, 3, front.h - 2, shadeRgb(shoeBright, 0.88));
        put(front, 1, front.h - 3, shoeBright);
        put(front, 2, front.h - 3, bowShadow);
        for (const side of [leg.overlay.right, leg.overlay.left]) {
          put(side, 0, side.h - 1, sole);
          put(side, 1, side.h - 1, shadeRgb(sole, 0.88));
          put(side, 0, side.h - 2, shoeAccent);
          put(side, 1, side.h - 2, shadeRgb(shoeAccent, 0.88));
          put(side, side.w - 1, side.h - 1, shoeShadow);
          put(side, side.w - 2, side.h - 1, soleShadow);
          put(side, side.w - 1, side.h - 3, shoeBright);
          put(side, 0, side.h - 3, bowShadow);
          put(side, 1, side.h - 3, strapDeep);
          put(side, side.w - 2, side.h - 3, shadeRgb(shoeBright, 0.86));
        }
        for (let x = 0; x < leg.overlay.bottom.w; x++) {
          put(leg.overlay.bottom, x, 0, x % 2 === 0 ? sole : soleShadow);
          put(
            leg.overlay.bottom,
            x,
            leg.overlay.bottom.h - 1,
            x % 2 === 0 ? soleShadow : shadeRgb(sole, 0.9),
          );
        }
        for (const x of [1, 2])
          put(
            leg.overlay.back,
            x,
            leg.overlay.back.h - 2,
            shadeRgb(shoeAccent, 0.9),
          );
        put(leg.overlay.back, 0, leg.overlay.back.h - 2, shoeBright);
        put(leg.overlay.back, 3, leg.overlay.back.h - 2, bowShadow);
        put(leg.overlay.back, 1, leg.overlay.back.h - 3, strapDeep);
        put(leg.overlay.back, 2, leg.overlay.back.h - 3, shoeBright);
        put(leg.overlay.back, 0, leg.overlay.back.h - 1, sole);
        put(leg.overlay.back, 3, leg.overlay.back.h - 1, soleShadow);
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
      const ribLight = shadeRgb(mixRgb(baseColor, [255, 248, 240], 0.45), 1.08);
      const ribShadow = shadeRgb(baseColor, 0.66);
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
          }
          if (legwear !== "leg_warmers") {
            // A single raised rib keeps long socks readable in profile while
            // the base layer carries the continuous fabric colour.
            const ribX =
              faceName === "left"
                ? overRect.w - 1
                : faceName === "right"
                  ? 0
                  : 1;
            put(
              overRect,
              ribX,
              y,
              shadeRgb(baseColor, y % 3 === 0 ? 0.76 : 0.94),
            );
            if ((faceName === "front" || faceName === "back") && y % 3 === 0) {
              put(
                overRect,
                Math.min(overRect.w - 1, ribX + 1),
                y,
                shadeRgb(baseColor, 1.08),
              );
            }
          }
          if (legwear === "leg_warmers") {
            const ribbed = y % 2 === 1 || y === legwearRows.end;
            if (ribbed) {
              const ribXs =
                faceName === "front" || faceName === "back"
                  ? [0, 1, 2, 3]
                  : faceName === "right"
                    ? [0, 1]
                    : [2, 3];
              for (const x of ribXs) {
                const sideEdge = x === 0 || x === overRect.w - 1;
                put(
                  overRect,
                  x,
                  y,
                  sideEdge ? shadeRgb(ribShadow, 0.9) : ribShadow,
                );
              }
            } else if (faceName === "front" || faceName === "back") {
              for (const x of [1, 2]) put(overRect, x, y, ribLight);
            } else {
              put(
                overRect,
                faceName === "right" ? 0 : overRect.w - 1,
                y,
                ribLight,
              );
              put(
                overRect,
                faceName === "right" ? 1 : overRect.w - 2,
                y,
                shadeRgb(ribLight, 0.9),
              );
            }
            if (faceName === "front" || faceName === "back") {
              const foldX = y % 2 === 0 ? 2 : 1;
              const liftX = foldX === 1 ? 2 : 1;
              put(
                overRect,
                foldX,
                y,
                ribbed ? shadeRgb(ribShadow, 0.82) : shadeRgb(ribLight, 0.96),
              );
              put(
                overRect,
                liftX,
                y,
                ribbed ? shadeRgb(ribLight, 0.72) : shadeRgb(ribLight, 1.12),
              );
            } else {
              const outerX = faceName === "right" ? 0 : overRect.w - 1;
              const innerX = faceName === "right" ? 1 : overRect.w - 2;
              put(
                overRect,
                outerX,
                y,
                ribbed ? shadeRgb(ribShadow, 0.72) : ribLight,
              );
              put(
                overRect,
                innerX,
                y,
                ribbed ? shadeRgb(ribShadow, 0.9) : shadeRgb(ribLight, 0.94),
              );
            }
          }
        }
        const rimXs =
          faceName === "front" || faceName === "back"
            ? [0, 1, 2, 3]
            : faceName === "right"
              ? [0, 1]
              : [2, 3];
        for (const x of rimXs) {
          put(
            overRect,
            x,
            legwearRows.start,
            x % 2 === 0 ? topLace : shadeRgb(topLace, 0.82),
          );
        }
        if (legwear === "leg_warmers") {
          const laceY = Math.max(0, legwearRows.start - 1);
          const ankleCuffY = Math.min(overRect.h - 1, legwearRows.end);
          const ankleFoldY = Math.max(legwearRows.start, ankleCuffY - 1);
          const scallopA = shadeRgb(topLace, 1.08);
          const scallopB = shadeRgb(topLace, 0.76);
          const cuffLight = shadeRgb(
            mixRgb(baseColor, [255, 250, 244], 0.42),
            1.04,
          );
          const cuffDark = shadeRgb(baseColor, 0.48);
          for (const x of rimXs) {
            const edge = x === 0 || x === overRect.w - 1;
            put(overRect, x, laceY, x % 2 === 0 ? scallopA : scallopB);
            if (!edge && (faceName === "front" || faceName === "back")) {
              put(
                overRect,
                x,
                legwearRows.start + 1,
                x % 2 === 0 ? shadeRgb(scallopA, 0.94) : ribShadow,
              );
            }
            put(
              baseRect,
              x,
              ankleCuffY,
              x % 2 === 0
                ? shadeRgb(baseColor, 0.62)
                : shadeRgb(baseColor, 0.76),
            );
            put(
              overRect,
              x,
              ankleCuffY,
              x % 2 === 0 ? cuffDark : shadeRgb(cuffDark, 0.82),
            );
            if (!edge) {
              put(
                overRect,
                x,
                ankleFoldY,
                x % 2 === 0 ? cuffLight : shadeRgb(cuffDark, 0.9),
              );
            }
          }
          if (faceName === "right" || faceName === "left") {
            const outerX = faceName === "right" ? 0 : overRect.w - 1;
            const innerX = faceName === "right" ? 1 : overRect.w - 2;
            put(overRect, outerX, laceY, scallopA);
            put(overRect, innerX, laceY, scallopB);
            put(
              overRect,
              outerX,
              legwearRows.start + 1,
              shadeRgb(scallopB, 0.82),
            );
            put(overRect, outerX, ankleCuffY, cuffDark);
            put(overRect, innerX, ankleFoldY, shadeRgb(cuffLight, 0.9));
          } else {
            put(overRect, 1, ankleFoldY, cuffLight);
            put(overRect, 2, ankleFoldY, shadeRgb(cuffLight, 0.84));
            put(overRect, 1, ankleCuffY, cuffDark);
            put(overRect, 2, ankleCuffY, shadeRgb(cuffDark, 0.78));
          }
          for (let y = legwearRows.start + 1; y <= legwearRows.end; y += 2) {
            put(overRect, 0, y, shadeRgb(ribShadow, 0.74));
            put(overRect, overRect.w - 1, y, shadeRgb(ribShadow, 0.74));
          }
        }
      }
    };

    for (const part of targetParts) drawLegwear(part);

    if (asym === "left" || asym === "right") {
      const opposite =
        asym === "left" ? CLASSIC_LAYOUT.rightLeg : CLASSIC_LAYOUT.leftLeg;
      const bow: Rgb = [248, 242, 232];
      const bowLight = shadeRgb(bow, 1.06);
      const bowShade: Rgb = [212, 192, 184];
      const bowDeep = shadeRgb(bowShade, 0.72);
      const frontLeg = opposite.overlay.front;
      for (const [x, y, color] of [
        [0, 1, bowShade],
        [0, 2, bowLight],
        [1, 1, bow],
        [1, 2, bowDeep],
        [2, 1, bowLight],
        [2, 2, bowLight],
        [3, 2, bow],
        [0, 3, bowShade],
        [1, 3, bow],
        [2, 3, bowShade],
        [3, 3, bowShade],
        [1, 4, bowDeep],
        [2, 4, bowShade],
      ] as const) {
        put(frontLeg, x, y, color);
      }
      for (const rect of [
        opposite.overlay.right,
        opposite.overlay.left,
        opposite.overlay.back,
      ]) {
        for (let x = 0; x < rect.w; x++) {
          put(rect, x, 1, x % 2 === 0 ? bowLight : shadeRgb(bow, 0.9));
        }
        for (let x = 0; x < rect.w; x++) {
          put(rect, x, 2, x % 2 === 0 ? bow : bowShade);
        }
        put(rect, 0, 3, bowShade);
        put(rect, rect.w - 1, 3, bowDeep);
      }
      const outerSide =
        asym === "left" ? opposite.overlay.right : opposite.overlay.left;
      for (const [x, y, color] of [
        [0, 1, bowLight],
        [1, 1, bow],
        [1, 2, bowDeep],
        [0, 3, bowShade],
        [1, 3, bow],
        [0, 4, bowDeep],
      ] as const) {
        put(outerSide, x, y, color);
      }
    }
  }

  // Break the perfectly rectangular outer torso at all four shoulder
  // corners. The base layer remains intact, while the raised garment layer
  // steps inward for one row and reads as fabric drape instead of a rigid box.
  if (layeredTop) {
    if (outerGarment === "none") {
      // A single closed top should not inherit saturated segmentation noise
      // from the generated guide at its shoulder rim. Keep the two raised
      // shoulder rows in the analysed garment colour before tapering corners.
      for (const rect of [body.overlay.front, body.overlay.back]) {
        for (let y = 0; y <= 1; y++) {
          for (const x of [0, 1, rect.w - 2, rect.w - 1]) {
            const edgeDistance = Math.min(x, rect.w - 1 - x);
            put(
              rect,
              x,
              y,
              shadeRgb(
                bodyShoulderColor,
                edgeDistance === 0 ? 0.82 : y === 0 ? 0.98 : 0.9,
              ),
            );
          }
        }
      }
      for (const rect of [body.overlay.right, body.overlay.left]) {
        for (let y = 0; y <= 1; y++) {
          for (let x = 0; x < rect.w; x++) {
            put(rect, x, y, shadeRgb(bodyShoulderColor, y === 0 ? 0.9 : 0.84));
          }
        }
      }
    }
    const taperShoulder = (baseRect: Rect, overlayRect: Rect) => {
      const sampleY = Math.min(baseRect.h - 1, 3);
      const inset = baseRect.w >= 6 ? 2 : 1;
      const leftGarment = stabilizeGarmentColor(
        sample(baseRect, inset, sampleY),
        0.74,
      );
      const rightGarment = stabilizeGarmentColor(
        sample(baseRect, baseRect.w - 1 - inset, sampleY),
        0.74,
      );
      for (const y of [0, 1]) {
        // Underpaint the revealed base pixels first. Generated front views
        // often have background-coloured shoulder corners because the source
        // silhouette slopes inward; transparent outer pixels must never expose
        // those segmentation remnants.
        put(baseRect, 0, y, shadeRgb(leftGarment, y === 0 ? 1.02 : 0.96));
        put(
          baseRect,
          baseRect.w - 1,
          y,
          shadeRgb(rightGarment, y === 0 ? 0.94 : 0.9),
        );
        clear(overlayRect, 0, y);
        clear(overlayRect, overlayRect.w - 1, y);
      }
    };
    taperShoulder(body.base.front, body.overlay.front);
    taperShoulder(body.base.back, body.overlay.back);
    taperShoulder(body.base.right, body.overlay.right);
    taperShoulder(body.base.left, body.overlay.left);

    const topBase = body.base.top;
    const topSampleY = Math.min(topBase.h - 1, 1);
    const topGarment = mixRgb(
      sample(topBase, Math.max(0, Math.floor(topBase.w / 2) - 1), topSampleY),
      sample(
        topBase,
        Math.min(topBase.w - 1, Math.floor(topBase.w / 2)),
        topSampleY,
      ),
      0.5,
    );
    for (const [x, y, shade] of [
      [0, 0, 1.02],
      [topBase.w - 1, 0, 0.94],
      [0, topBase.h - 1, 0.96],
      [topBase.w - 1, topBase.h - 1, 0.9],
    ] as const) {
      put(topBase, x, y, shadeRgb(topGarment, shade));
    }
    for (const [x, y] of [
      [0, 0],
      [body.overlay.top.w - 1, 0],
      [0, body.overlay.top.h - 1],
      [body.overlay.top.w - 1, body.overlay.top.h - 1],
    ] as const) {
      clear(body.overlay.top, x, y);
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
  const torsoRows = {
    y0: shoulderY,
    y1: shoulderY + (maxY + 1 - shoulderY) * 0.5,
  };
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
    head: {
      x0: headSpan.x0,
      x1: headSpan.x1,
      y0: headRows.y0,
      y1: headRows.y1,
    },
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
  const sampledHairColor = medianColor(
    src,
    {
      ...front.head,
      y1: front.head.y0 + (front.head.y1 - front.head.y0) * 0.22,
    },
    bg,
  );
  const sampledSkinColor = medianColor(
    src,
    {
      x0: front.head.x0 + (front.head.x1 - front.head.x0) * 0.3,
      x1: front.head.x1 - (front.head.x1 - front.head.x0) * 0.3,
      y0: front.head.y0 + (front.head.y1 - front.head.y0) * 0.55,
      y1: front.head.y1 - (front.head.y1 - front.head.y0) * 0.15,
    },
    bg,
  );
  // The vision analysis has already classified identity colours into stable
  // palettes. Prefer those declared colours over re-sampling the intermediate
  // image-generation guide, which can shift black hair toward brown or alter
  // skin tone. Sampling remains the backward-compatible fallback.
  const hairColor = hexToRgb(faceStyle.hairColor ?? "", sampledHairColor);
  const skinColor = hexToRgb(faceStyle.skinTone ?? "", sampledSkinColor);
  const hatColor = hexToRgb(faceStyle.hatColor ?? "", sampledHairColor);
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
  const declaredTopColor = faceStyle.topColor
    ? hexToRgb(faceStyle.topColor, [92, 92, 92])
    : null;
  fillRectFromRegion(atlas, body.base.front, src, front.body, bg);
  alignGarmentRectToDeclaredColor(atlas, body.base.front, declaredTopColor);
  const sampledTorsoTopColor = medianColor(
    src,
    {
      ...front.body,
      y1: front.body.y0 + (front.body.y1 - front.body.y0) * 0.15,
    },
    bg,
  );
  const torsoTopColor = declaredTopColor
    ? alignRgbChroma(sampledTorsoTopColor, declaredTopColor)
    : sampledTorsoTopColor;
  completeSides(atlas, body.base, torsoTopColor, torsoTopColor);
  if (back) {
    fillRectFromRegion(atlas, body.base.back, src, back.body, bg);
    harmonizeGarmentChroma(
      atlas,
      body.base.back,
      body.base.front,
      declaredTopColor,
    );
    alignGarmentRectToDeclaredColor(atlas, body.base.back, declaredTopColor);
  } else {
    fillRectFromRect(atlas, body.base.back, body.base.front, 0.78, true);
  }

  // ---------- 팔 ----------
  // 정면 뷰: 화면 왼쪽 = 캐릭터의 오른팔. 뒷면 뷰: 화면 왼쪽 = 캐릭터의 왼팔.
  const arms = [
    {
      part: "rightArm" as const,
      frontRegion: front.viewLeftArm,
      backRegion: back?.viewRightArm,
    },
    {
      part: "leftArm" as const,
      frontRegion: front.viewRightArm,
      backRegion: back?.viewLeftArm,
    },
  ];
  for (const { part, frontRegion, backRegion } of arms) {
    const box = CLASSIC_LAYOUT[part].base;
    fillRectFromRegion(atlas, box.front, src, frontRegion, bg);
    const sleeveRows =
      faceStyle.sleeveLength === "long"
        ? box.front.h - 1
        : Math.min(5, box.front.h);
    alignGarmentRectToDeclaredColor(
      atlas,
      box.front,
      declaredTopColor,
      sleeveRows,
    );
    const sampledSleeveColor = medianColor(
      src,
      {
        ...frontRegion,
        y1: frontRegion.y0 + (frontRegion.y1 - frontRegion.y0) * 0.2,
      },
      bg,
    );
    const sleeveColor = declaredTopColor
      ? alignRgbChroma(sampledSleeveColor, declaredTopColor)
      : sampledSleeveColor;
    completeSides(atlas, box, sleeveColor, skinColor); // 아래면 = 손 (피부색)
    if (backRegion) {
      fillRectFromRegion(atlas, box.back, src, backRegion, bg);
      harmonizeGarmentChroma(
        atlas,
        box.back,
        box.front,
        declaredTopColor,
        sleeveRows,
      );
      alignGarmentRectToDeclaredColor(
        atlas,
        box.back,
        declaredTopColor,
        sleeveRows,
      );
    } else {
      fillRectFromRect(atlas, box.back, box.front, 0.78, true);
    }
  }

  // ---------- 다리 ----------
  const legs = [
    {
      part: "rightLeg" as const,
      frontRegion: front.viewLeftLeg,
      backRegion: back?.viewRightLeg,
    },
    {
      part: "leftLeg" as const,
      frontRegion: front.viewRightLeg,
      backRegion: back?.viewLeftLeg,
    },
  ];
  const declaredBottomColor = faceStyle.bottomColor
    ? hexToRgb(faceStyle.bottomColor, [64, 64, 64])
    : null;
  const declaredShoesColor = faceStyle.shoesColor
    ? hexToRgb(faceStyle.shoesColor, [48, 48, 48])
    : null;
  for (const { part, frontRegion, backRegion } of legs) {
    const box = CLASSIC_LAYOUT[part].base;
    fillRectFromRegion(atlas, box.front, src, frontRegion, bg);
    const shoeRows = Math.min(3, box.front.h);
    const garmentRows =
      faceStyle.bottomType === "pants" || faceStyle.bottomType === "jeans"
        ? box.front.h - shoeRows
        : faceStyle.bottomType === "shorts"
          ? Math.min(3, box.front.h - shoeRows)
          : 0;
    const exposedSkinRows =
      faceStyle.bottomType === "skirt" || faceStyle.bottomType === "shorts"
        ? box.front.h - shoeRows - garmentRows
        : 0;
    alignGarmentRectToDeclaredColor(
      atlas,
      box.front,
      declaredBottomColor,
      garmentRows,
    );
    if (exposedSkinRows > 0) {
      fillRectSolid(
        atlas,
        {
          x: box.front.x,
          y: box.front.y + garmentRows,
          w: box.front.w,
          h: exposedSkinRows,
        },
        skinColor,
      );
    }
    alignGarmentRectToDeclaredColor(
      atlas,
      box.front,
      declaredShoesColor,
      shoeRows,
      box.front.h - shoeRows,
    );
    const sampledPantsColor = medianColor(
      src,
      {
        ...frontRegion,
        y1: frontRegion.y0 + (frontRegion.y1 - frontRegion.y0) * 0.2,
      },
      bg,
    );
    const sampledShoeColor = medianColor(
      src,
      {
        ...frontRegion,
        y0: frontRegion.y1 - (frontRegion.y1 - frontRegion.y0) * 0.12,
      },
      bg,
    );
    const pantsColor = declaredBottomColor
      ? alignRgbChroma(sampledPantsColor, declaredBottomColor)
      : sampledPantsColor;
    const shoeColor = declaredShoesColor
      ? alignRgbChroma(sampledShoeColor, declaredShoesColor)
      : sampledShoeColor;
    completeSides(atlas, box, pantsColor, shoeColor);
    if (backRegion) {
      fillRectFromRegion(atlas, box.back, src, backRegion, bg);
      alignGarmentRectToDeclaredColor(
        atlas,
        box.back,
        declaredBottomColor,
        garmentRows,
      );
      if (exposedSkinRows > 0) {
        fillRectSolid(
          atlas,
          {
            x: box.back.x,
            y: box.back.y + garmentRows,
            w: box.back.w,
            h: exposedSkinRows,
          },
          skinColor,
        );
      }
      alignGarmentRectToDeclaredColor(
        atlas,
        box.back,
        declaredShoesColor,
        shoeRows,
        box.back.h - shoeRows,
      );
    } else {
      fillRectFromRect(atlas, box.back, box.front, 0.78, true);
    }
  }

  // ---------- 마감: 의상/액세서리 레이어 + 헤어/모자 구조 + 셰이딩 ----------
  composeGarmentLayers(atlas, faceStyle);
  resetPortraitFaceOverlay(atlas, faceStyle);
  composeHair(atlas, hairColor, skinColor, faceStyle, back !== null);
  preserveFaceReadability(atlas, faceStyle);
  composeHat(atlas, hatColor, faceStyle);
  reconcileOverlayVerticalSeams(atlas);
  applyShading(atlas);

  return { atlas, problems, hasBackView: back !== null };
}
