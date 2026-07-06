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
 * 얼굴 구조적 합성.
 *
 * 샘플링만으로 만든 8x8 얼굴은 코·입 그림자가 검은 얼룩으로 증폭되거나
 * 앞머리에 눈이 묻히는 문제가 있었다(실측). 대신:
 * - 렌더에서 가져오는 것: 앞머리 실루엣(열별 내려온 깊이)과 머리카락 질감, 피부색
 * - 분석 특징으로 그리는 것: 눈썹(2행)·눈(3-4행)·코(5행)·입(6행)·수염,
 *   안경은 overlay(2-5행) — 클라이언트 절차 생성기와 동일한 검증된 좌표
 * - 피부에는 이마→턱·중앙→가장자리 명암, overlay에 볼(5-6행)·턱(7행) 라운딩
 */
function composeFace(
  atlas: RawImage,
  src: RawImage,
  headRegion: Region,
  bg: [number, number, number],
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

  // 1) 8x8 셀 샘플 + 머리카락/피부 분류
  const rw = headRegion.x1 - headRegion.x0;
  const rh = headRegion.y1 - headRegion.y0;
  const cellColor: Rgb[] = [];
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      cellColor.push(
        featureColor(
          src,
          {
            x0: headRegion.x0 + (cx / 8) * rw,
            x1: headRegion.x0 + ((cx + 1) / 8) * rw,
            y0: headRegion.y0 + (cy / 8) * rh,
            y1: headRegion.y0 + ((cy + 1) / 8) * rh,
          },
          bg,
        ),
      );
    }
  }
  const dist = (a: Rgb, b: Rgb) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const isHairCell = (c: Rgb) =>
    dist(c, hairColor) < dist(c, skinColor) && dist(c, hairColor) < 160;

  // 앞머리 깊이: 열별로 위에서 연속된 머리카락 셀 수 (눈 행 보호를 위해 최대 3)
  const hairDepth: number[] = [];
  for (let cx = 0; cx < 8; cx++) {
    let depth = 0;
    while (depth < 3 && isHairCell(cellColor[depth * 8 + cx])) {
      depth++;
    }
    hairDepth.push(depth);
  }

  // 2) 바탕: 머리카락(렌더 질감 유지) + 피부(명암 그라데이션)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (y < hairDepth[x]) {
        const cell = cellColor[y * 8 + x];
        put(face, x, y, isHairCell(cell) ? cell : hairColor);
      } else {
        let factor = 1.04 - (y / 7) * 0.09; // 이마 밝게 → 턱 어둡게
        const centerDist = Math.abs(x - 3.5) / 3.5;
        factor *= 1.03 - centerDist * 0.08; // 중앙 밝게 → 가장자리 어둡게
        put(face, x, y, shadeRgb(skinColor, factor));
      }
    }
  }

  // 3) 이목구비 (클라이언트 절차 생성기의 검증된 좌표)
  const browColor = shadeRgb(hairColor, 0.8);
  if (style.eyebrowThickness === "thick") {
    for (const x of [0, 1, 2, 5, 6, 7]) {
      if (hairDepth[x] <= 2) put(face, x, 2, browColor);
    }
  } else {
    const c =
      style.eyebrowThickness === "thin"
        ? mixRgb(browColor, skinColor, 0.35)
        : browColor;
    for (const x of [1, 2, 5, 6]) {
      if (hairDepth[x] <= 2) put(face, x, 2, c);
    }
  }

  const white: Rgb = [245, 245, 240];
  const eye = hexToRgb(style.eyeColor, [74, 55, 40]);
  for (const [wx, ix] of [
    [1, 2],
    [6, 5],
  ] as const) {
    put(face, wx, 3, white);
    put(face, wx, 4, shadeRgb(white, 0.92));
    put(face, ix, 3, eye);
    put(face, ix, 4, shadeRgb(eye, 0.75));
  }

  const skinShadow = shadeRgb(skinColor, 0.82);
  put(face, 3, 5, skinShadow);
  put(face, 4, 5, skinShadow);

  const mouthColor = mixRgb(shadeRgb(skinColor, 0.62), [160, 74, 60], 0.5);
  if (style.expression === "smile") {
    put(face, 3, 6, mouthColor);
    put(face, 4, 6, mouthColor);
    put(face, 2, 6, shadeRgb(mouthColor, 1.15));
    put(face, 5, 6, shadeRgb(mouthColor, 1.15));
    const blush = mixRgb(skinColor, [255, 138, 128], 0.35);
    put(face, 0, 5, blush);
    put(face, 7, 5, blush);
  } else if (style.expression === "serious") {
    for (const x of [2, 3, 4, 5]) {
      put(face, x, 6, shadeRgb(mouthColor, 0.8));
    }
  } else {
    put(face, 3, 6, mouthColor);
    put(face, 4, 6, mouthColor);
  }

  // 수염
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

  // 4) overlay: 볼(5-6행)·턱(7행) 라운딩 — 안경보다 먼저 그린다 (안경이 위에 얹힘)
  const cheek = shadeRgb(skinColor, 0.92);
  for (const y of [5, 6]) {
    put(overlay, 0, y, cheek);
    put(overlay, 7, y, cheek);
  }
  if (style.facialHair === "none" || style.facialHair === "mustache") {
    for (const x of [2, 3, 4, 5]) {
      put(overlay, x, 7, cheek);
    }
  }

  // 5) 안경 (overlay, 클라이언트와 동일 좌표)
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
  const jitter = s === "curly" || s === "afro" ? 0.12 : 0.06;

  const fill = (rect: Rect, x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < Math.min(rect.h, y0 + h); y++) {
      for (let x = x0; x < Math.min(rect.w, x0 + w); x++) {
        const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
        const c = hairPixel(hairColor, rect.x + x, rect.y + y, jitter);
        atlas.rgba[d] = c[0];
        atlas.rgba[d + 1] = c[1];
        atlas.rgba[d + 2] = c[2];
        atlas.rgba[d + 3] = 255;
      }
    }
  };

  // 스타일별 옆/뒷머리 길이 (클라이언트와 동일 값)
  const sideRows =
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
  fill(over.top, 0, 0, 8, 8);
  fill(over.front, 0, 0, 8, 1);
  fill(over.right, 0, 0, 8, 1);
  fill(over.left, 0, 0, 8, 1);
  fill(over.back, 0, 0, 8, 1);

  if (s === "afro" || s === "curly") {
    const rows = s === "afro" ? 4 : 2;
    fill(over.front, 0, 0, 8, rows);
    fill(over.right, 0, 0, 8, rows + 1);
    fill(over.left, 0, 0, 8, rows + 1);
    fill(over.back, 0, 0, 8, rows + 1);
  }
  if (s === "long") {
    // 어깨까지 내려오는 뒷머리 (몸통 뒤 overlay) + 옆 볼륨
    fill(CLASSIC_LAYOUT.body.overlay.back, 0, 0, 8, 4);
    fill(CLASSIC_LAYOUT.body.overlay.back, 1, 4, 6, 1);
    fill(over.right, 0, 0, 8, 6);
    fill(over.left, 0, 0, 8, 6);
  }
  if (s === "ponytail") {
    fill(over.back, 2, 1, 4, 7);
    fill(CLASSIC_LAYOUT.body.overlay.back, 3, 0, 2, 4);
  }
  if (s === "bun") {
    fill(over.back, 2, 0, 4, 3);
    fill(over.top, 2, 5, 4, 3);
  }
  if (s === "twintails") {
    fill(over.right, 5, 0, 3, 8);
    fill(over.left, 0, 0, 3, 8);
    fill(CLASSIC_LAYOUT.body.overlay.right, 0, 0, 4, 4);
    fill(CLASSIC_LAYOUT.body.overlay.left, 0, 0, 4, 4);
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
  // 얼굴: 렌더의 앞머리 실루엣·색 + 분석 특징 기반 이목구비 구조적 합성
  composeFace(atlas, src, front.head, bg, hairColor, skinColor, faceStyle);

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

  // ---------- 마감: 헤어스타일 구조 + 셰이딩 ----------
  composeHair(atlas, hairColor, faceStyle, back !== null);
  applyShading(atlas);

  return { atlas, problems };
}
