/**
 * 정면 캐릭터 뷰 → 64x64 스킨 atlas 결정적 pack (front_pack 전략).
 *
 * FLUX가 그린 "정면 전신 블록 캐릭터" 이미지를 배경 분리 → 부위 슬라이스 →
 * 셀 중앙값 축소로 각 front 면에 채우고, 보이지 않는 옆/뒤/위/아래 면은
 * front 면에서 파생(가장자리 확장·어둡게)해 UV 규칙을 코드로 보장한다.
 */

import type { RawImage } from "./png";
import { ATLAS_SIZE, CLASSIC_LAYOUT, type BoxUV, type Rect } from "./uvLayout";

export interface PackResult {
  atlas: RawImage;
  problems: string[];
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
 * front 면을 채운 뒤 나머지 면을 파생:
 * 옆면 = front 가장자리 열 확장, 뒷면 = front 좌우반전 + 어둡게, 위/아래 = 지정색.
 */
function completeBox(
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
  fillRectFromRect(atlas, box.back, box.front, 0.78, true);
  fillRectSolid(atlas, box.top, topColor);
  fillRectSolid(atlas, box.bottom, bottomColor, 0.82);
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
): number {
  const bboxH = maxY - minY + 1;
  const widths: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    let count = 0;
    for (let x = 0; x < src.width; x++) {
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
): { x0: number; x1: number } | null {
  const rows = Math.max(1, Math.ceil(y1) - Math.floor(y0));
  const counts = new Array<number>(src.width).fill(0);
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = 0; x < src.width; x++) {
      if (isCharacterPixel(src, x, y, bg)) {
        counts[x]++;
      }
    }
  }
  const threshold = Math.max(2, rows * 0.06);
  let x0 = -1;
  let x1 = -1;
  for (let x = 0; x < src.width; x++) {
    if (counts[x] >= threshold) {
      if (x0 === -1) x0 = x;
      x1 = x + 1;
    }
  }
  return x0 === -1 ? null : { x0, x1 };
}

export function packFrontViewToAtlas(src: RawImage): PackResult | null {
  const bg = estimateBackground(src);

  // 캐릭터 전체 bbox
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (isCharacterPixel(src, x, y, bg)) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const area = src.width * src.height;
  if (count < area * 0.04 || count > area * 0.9) {
    return null; // 캐릭터를 분리하지 못함 (빈 이미지거나 배경 분리 실패)
  }
  const bboxH = maxY - minY + 1;
  const bboxW = maxX - minX + 1;
  if (bboxH < 64 || bboxW < 32) {
    return null;
  }

  // 세로 분할: 어깨선을 감지해 머리를 자르고, 남은 높이를 몸통/다리 반씩(12:12)
  const shoulderY = findShoulderRow(src, bg, minY, maxY);
  const headRows = { y0: minY, y1: shoulderY };
  const torsoRows = { y0: shoulderY, y1: shoulderY + (maxY + 1 - shoulderY) * 0.5 };
  const legRows = { y0: torsoRows.y1, y1: maxY + 1 };

  // 머리: 해당 행에서 실제 열 범위를 다시 측정 (머리가 몸보다 좁거나 넓을 수 있음)
  const headSpan = columnSpan(src, bg, headRows.y0, headRows.y1);
  const torsoSpan = columnSpan(src, bg, torsoRows.y0, torsoRows.y1);
  const legSpan = columnSpan(src, bg, legRows.y0, legRows.y1);
  if (!headSpan || !torsoSpan || !legSpan) {
    return null;
  }

  const problems: string[] = [];
  const atlas: RawImage = {
    width: ATLAS_SIZE,
    height: ATLAS_SIZE,
    rgba: new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4),
  };

  // ---------- 머리 ----------
  const head = CLASSIC_LAYOUT.head;
  const headRegion: Region = {
    x0: headSpan.x0,
    x1: headSpan.x1,
    y0: headRows.y0,
    y1: headRows.y1,
  };
  fillRectFromRegion(atlas, head.base.front, src, headRegion, bg, true);
  const hairColor = medianColor(
    src,
    { ...headRegion, y1: headRegion.y0 + (headRegion.y1 - headRegion.y0) * 0.22 },
    bg,
  );
  const skinColor = medianColor(
    src,
    {
      x0: headRegion.x0 + (headRegion.x1 - headRegion.x0) * 0.3,
      x1: headRegion.x1 - (headRegion.x1 - headRegion.x0) * 0.3,
      y0: headRegion.y0 + (headRegion.y1 - headRegion.y0) * 0.55,
      y1: headRegion.y1 - (headRegion.y1 - headRegion.y0) * 0.15,
    },
    bg,
  );
  // 옆면은 front 가장자리 확장, 뒷면은 머리카락색 기반 (얼굴 반전 금지)
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
  fillRectSolid(atlas, head.base.back, hairColor, 0.9);
  fillRectSolid(atlas, head.base.top, hairColor);
  fillRectSolid(atlas, head.base.bottom, skinColor, 0.85);

  // ---------- 몸통 ----------
  const torsoWidth = torsoSpan.x1 - torsoSpan.x0;
  // 팔이 몸에 붙어 있으므로 중앙 1/2이 몸통, 양끝 1/4씩이 팔 (마인크래프트 4-8-4 비율)
  const bodyRegion: Region = {
    x0: torsoSpan.x0 + torsoWidth * 0.25,
    x1: torsoSpan.x1 - torsoWidth * 0.25,
    y0: torsoRows.y0,
    y1: torsoRows.y1,
  };
  const body = CLASSIC_LAYOUT.body;
  fillRectFromRegion(atlas, body.base.front, src, bodyRegion, bg);
  const torsoTopColor = medianColor(
    src,
    { ...bodyRegion, y1: bodyRegion.y0 + (bodyRegion.y1 - bodyRegion.y0) * 0.15 },
    bg,
  );
  completeBox(atlas, body.base, torsoTopColor, torsoTopColor);

  // ---------- 팔 (화면 왼쪽 = 캐릭터의 오른팔) ----------
  const rightArmRegion: Region = {
    x0: torsoSpan.x0,
    x1: torsoSpan.x0 + torsoWidth * 0.25,
    y0: torsoRows.y0,
    y1: torsoRows.y1,
  };
  const leftArmRegion: Region = {
    x0: torsoSpan.x1 - torsoWidth * 0.25,
    x1: torsoSpan.x1,
    y0: torsoRows.y0,
    y1: torsoRows.y1,
  };
  for (const [part, region] of [
    ["rightArm", rightArmRegion],
    ["leftArm", leftArmRegion],
  ] as const) {
    const box = CLASSIC_LAYOUT[part].base;
    fillRectFromRegion(atlas, box.front, src, region, bg);
    const sleeveColor = medianColor(
      src,
      { ...region, y1: region.y0 + (region.y1 - region.y0) * 0.2 },
      bg,
    );
    completeBox(atlas, box, sleeveColor, skinColor); // 아래면 = 손 (피부색)
  }

  // ---------- 다리 (화면 왼쪽 = 캐릭터의 오른다리) ----------
  const legWidth = legSpan.x1 - legSpan.x0;
  const rightLegRegion: Region = {
    x0: legSpan.x0,
    x1: legSpan.x0 + legWidth * 0.5,
    y0: legRows.y0,
    y1: legRows.y1,
  };
  const leftLegRegion: Region = {
    x0: legSpan.x0 + legWidth * 0.5,
    x1: legSpan.x1,
    y0: legRows.y0,
    y1: legRows.y1,
  };
  for (const [part, region] of [
    ["rightLeg", rightLegRegion],
    ["leftLeg", leftLegRegion],
  ] as const) {
    const box = CLASSIC_LAYOUT[part].base;
    fillRectFromRegion(atlas, box.front, src, region, bg);
    const pantsColor = medianColor(
      src,
      { ...region, y1: region.y0 + (region.y1 - region.y0) * 0.2 },
      bg,
    );
    const shoeColor = medianColor(
      src,
      { ...region, y0: region.y1 - (region.y1 - region.y0) * 0.12 },
      bg,
    );
    completeBox(atlas, box, pantsColor, shoeColor);
  }

  // overlay 레이어는 비워둔다 (base가 모든 정보를 담는다) — applyUvMask가 투명 처리
  return { atlas, problems };
}
