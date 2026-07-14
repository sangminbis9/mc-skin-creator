/**
 * 이미지 생성 모델 출력 → 유효한 64x64 스킨 atlas 후처리 + 검증.
 *
 * - bilinear 없이 8x8(정확히는 size/64) 셀 단위 중앙값으로 축소해 픽셀아트 경계를 보존
 * - 공식 UV 영역 밖 alpha=0, base 레이어 완전 불투명, overlay는 이진 alpha
 * - 얼굴 비어있음 / 단색 면 / atlas가 아닌 일반 캐릭터 렌더 휴리스틱 검사
 */

import type { RawImage } from "./png";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  BASE_RECTS,
  CLASSIC_LAYOUT,
  HEAD_FRONT,
  buildZoneMap,
  getBoxUvSeams,
  type BodyPart,
  type Rect,
  type UvSeam,
} from "./uvLayout";

const ZONE_MAP = buildZoneMap();

/** 셀 중앙값 축소: 정사각형(64 이상) 입력 → 64x64 RGBA */
export function downscaleToAtlas(source: RawImage): RawImage {
  const { width, height, rgba } = source;
  if (width < ATLAS_SIZE || height < ATLAS_SIZE) {
    throw new Error(`입력이 너무 작습니다 (${width}x${height})`);
  }
  const out = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  const cellW = width / ATLAS_SIZE;
  const cellH = height / ATLAS_SIZE;

  const channel: number[] = [];
  for (let cy = 0; cy < ATLAS_SIZE; cy++) {
    const y0 = Math.floor(cy * cellH);
    const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellH));
    for (let cx = 0; cx < ATLAS_SIZE; cx++) {
      const x0 = Math.floor(cx * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellW));
      const d = (cy * ATLAS_SIZE + cx) * 4;
      for (let ch = 0; ch < 4; ch++) {
        channel.length = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            channel.push(rgba[(y * width + x) * 4 + ch]);
          }
        }
        channel.sort((a, b) => a - b);
        out[d + ch] = channel[channel.length >> 1];
      }
    }
  }
  return { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: out };
}

/** UV 마스크 적용: 영역 밖 투명 / base 불투명 / overlay 이진 alpha. 입력을 제자리 수정한다. */
export function applyUvMask(atlas: RawImage): RawImage {
  if (atlas.width !== ATLAS_SIZE || atlas.height !== ATLAS_SIZE) {
    throw new Error("64x64 atlas가 아닙니다");
  }
  const { rgba } = atlas;
  for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
    const a = i * 4 + 3;
    switch (ZONE_MAP[i]) {
      case "outside":
        rgba[i * 4] = 0;
        rgba[i * 4 + 1] = 0;
        rgba[i * 4 + 2] = 0;
        rgba[a] = 0;
        break;
      case "base":
        rgba[a] = 255;
        break;
      case "overlay":
        if (rgba[a] < 128) {
          rgba[i * 4] = 0;
          rgba[i * 4 + 1] = 0;
          rgba[i * 4 + 2] = 0;
          rgba[a] = 0;
        } else {
          rgba[a] = 255;
        }
        break;
    }
  }
  return atlas;
}

export interface AtlasValidation {
  ok: boolean;
  problems: string[];
}

/** 4bit/채널 양자화 색 키 (미세 노이즈 무시하고 "서로 다른 색" 개수를 센다) */
function quantKey(rgba: Uint8Array, i: number): number {
  return (
    ((rgba[i * 4] >> 4) << 8) |
    ((rgba[i * 4 + 1] >> 4) << 4) |
    (rgba[i * 4 + 2] >> 4)
  );
}

function distinctColorsIn(atlas: RawImage, rects: Rect[]): number {
  const seen = new Set<number>();
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        seen.add(quantKey(atlas.rgba, y * ATLAS_SIZE + x));
      }
    }
  }
  return seen.size;
}

function opaqueStatsIn(
  atlas: RawImage,
  rect: Rect,
): { pixels: number; colors: number } {
  let pixels = 0;
  const colors = new Set<number>();
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const pixel = y * ATLAS_SIZE + x;
      if (atlas.rgba[pixel * 4 + 3] === 0) continue;
      pixels++;
      colors.add(quantKey(atlas.rgba, pixel));
    }
  }
  return { pixels, colors: colors.size };
}

interface SeamStats {
  mismatches: number;
  samples: number;
  colorDistanceSum: number;
  opaquePairs: number;
}

function measureSeams(atlas: RawImage, seams: UvSeam[]): SeamStats {
  const stats: SeamStats = {
    mismatches: 0,
    samples: 0,
    colorDistanceSum: 0,
    opaquePairs: 0,
  };
  for (const seam of seams) {
    for (let index = 0; index < seam.primary.length; index++) {
      const first = seam.primary[index];
      const second = seam.adjacent[index];
      const firstPixel = first.y * ATLAS_SIZE + first.x;
      const secondPixel = second.y * ATLAS_SIZE + second.x;
      const firstOpaque = atlas.rgba[firstPixel * 4 + 3] !== 0;
      const secondOpaque = atlas.rgba[secondPixel * 4 + 3] !== 0;
      stats.samples++;
      if (firstOpaque !== secondOpaque) {
        stats.mismatches++;
        continue;
      }
      if (!firstOpaque) continue;
      stats.opaquePairs++;
      for (let channel = 0; channel < 3; channel++) {
        stats.colorDistanceSum += Math.abs(
          atlas.rgba[firstPixel * 4 + channel] -
            atlas.rgba[secondPixel * 4 + channel],
        );
      }
    }
  }
  return stats;
}

function averageSeamColorDistance(stats: SeamStats): number {
  return stats.opaquePairs === 0
    ? 0
    : stats.colorDistanceSum / stats.opaquePairs;
}

export interface AtlasCraftMetrics {
  baseColorCount: number;
  overlayColorCount: number;
  opaqueOverlayPixels: number;
  populatedOverlayFaces: number;
  shadedOverlayFaces: number;
  solidOverlayFaces: number;
  overlayVerticalSeamMismatches: number;
  overlayVerticalSeamSamples: number;
  overlayVerticalSeamColorDistance: number;
  overlayVerticalSeamMismatchesByPart: Record<BodyPart, number>;
  overlayVerticalSeamColorDistanceByPart: Record<BodyPart, number>;
  overlayHorizontalSeamMismatches: number;
  overlayHorizontalSeamSamples: number;
  overlayHorizontalSeamColorDistance: number;
  overlayHorizontalSeamMismatchesByPart: Record<BodyPart, number>;
  overlayHorizontalSeamColorDistanceByPart: Record<BodyPart, number>;
  baseHorizontalSeamColorDistance: number;
  baseHorizontalSeamColorDistanceByPart: Record<BodyPart, number>;
  detailedBaseFaces: number;
  overlayPixelsByPart: Record<BodyPart, number>;
}

/**
 * Measures hand-authored pixel-art signals without assuming every subject must
 * wear the same amount of outer-layer detail. Consumers can compare these
 * metrics against style-specific expectations or a reference skin; the core
 * format validator remains permissive for legitimately minimal/bald skins.
 */
export function measureAtlasCraft(atlas: RawImage): AtlasCraftMetrics {
  if (atlas.width !== ATLAS_SIZE || atlas.height !== ATLAS_SIZE) {
    throw new Error("64x64 atlas가 아닙니다");
  }
  const overlayPixelsByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [part, 0]),
  ) as Record<BodyPart, number>;
  const overlayVerticalSeamMismatchesByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [part, 0]),
  ) as Record<BodyPart, number>;
  const overlayVerticalSeamColorDistanceByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [part, 0]),
  ) as Record<BodyPart, number>;
  const overlayHorizontalSeamMismatchesByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [part, 0]),
  ) as Record<BodyPart, number>;
  const overlayHorizontalSeamColorDistanceByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [part, 0]),
  ) as Record<BodyPart, number>;
  const baseHorizontalSeamColorDistanceByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [part, 0]),
  ) as Record<BodyPart, number>;
  let opaqueOverlayPixels = 0;
  let populatedOverlayFaces = 0;
  let shadedOverlayFaces = 0;
  let solidOverlayFaces = 0;
  let overlayVerticalSeamMismatches = 0;
  let overlayVerticalSeamSamples = 0;
  let overlayVerticalSeamColorDistanceSum = 0;
  let overlayVerticalSeamOpaquePairs = 0;
  let overlayHorizontalSeamMismatches = 0;
  let overlayHorizontalSeamSamples = 0;
  let overlayHorizontalSeamColorDistanceSum = 0;
  let overlayHorizontalSeamOpaquePairs = 0;
  let baseHorizontalSeamColorDistanceSum = 0;
  let baseHorizontalSeamOpaquePairs = 0;
  let detailedBaseFaces = 0;
  const overlayColors = new Set<number>();

  for (const part of ALL_PARTS) {
    for (const rect of Object.values(CLASSIC_LAYOUT[part].base)) {
      if (opaqueStatsIn(atlas, rect).colors >= 3) detailedBaseFaces++;
    }
    for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) {
      const stats = opaqueStatsIn(atlas, rect);
      overlayPixelsByPart[part] += stats.pixels;
      opaqueOverlayPixels += stats.pixels;
      if (stats.pixels >= 2) populatedOverlayFaces++;
      if (stats.pixels >= 4 && stats.colors >= 2) shadedOverlayFaces++;
      if (stats.pixels === rect.w * rect.h) solidOverlayFaces++;
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const pixel = y * ATLAS_SIZE + x;
          if (atlas.rgba[pixel * 4 + 3] !== 0)
            overlayColors.add(quantKey(atlas.rgba, pixel));
        }
      }
    }

    const overlaySeams = getBoxUvSeams(CLASSIC_LAYOUT[part].overlay);
    const verticalStats = measureSeams(atlas, overlaySeams.vertical);
    overlayVerticalSeamMismatches += verticalStats.mismatches;
    overlayVerticalSeamSamples += verticalStats.samples;
    overlayVerticalSeamColorDistanceSum += verticalStats.colorDistanceSum;
    overlayVerticalSeamOpaquePairs += verticalStats.opaquePairs;
    overlayVerticalSeamMismatchesByPart[part] = verticalStats.mismatches;
    overlayVerticalSeamColorDistanceByPart[part] =
      averageSeamColorDistance(verticalStats);

    const horizontalStats = measureSeams(atlas, overlaySeams.horizontal);
    overlayHorizontalSeamMismatches += horizontalStats.mismatches;
    overlayHorizontalSeamSamples += horizontalStats.samples;
    overlayHorizontalSeamColorDistanceSum += horizontalStats.colorDistanceSum;
    overlayHorizontalSeamOpaquePairs += horizontalStats.opaquePairs;
    overlayHorizontalSeamMismatchesByPart[part] = horizontalStats.mismatches;
    overlayHorizontalSeamColorDistanceByPart[part] =
      averageSeamColorDistance(horizontalStats);

    const baseHorizontalStats = measureSeams(
      atlas,
      getBoxUvSeams(CLASSIC_LAYOUT[part].base).horizontal,
    );
    baseHorizontalSeamColorDistanceSum += baseHorizontalStats.colorDistanceSum;
    baseHorizontalSeamOpaquePairs += baseHorizontalStats.opaquePairs;
    baseHorizontalSeamColorDistanceByPart[part] =
      averageSeamColorDistance(baseHorizontalStats);
  }

  return {
    baseColorCount: distinctColorsIn(atlas, BASE_RECTS),
    overlayColorCount: overlayColors.size,
    opaqueOverlayPixels,
    populatedOverlayFaces,
    shadedOverlayFaces,
    solidOverlayFaces,
    overlayVerticalSeamMismatches,
    overlayVerticalSeamSamples,
    overlayVerticalSeamColorDistance:
      overlayVerticalSeamOpaquePairs === 0
        ? 0
        : overlayVerticalSeamColorDistanceSum / overlayVerticalSeamOpaquePairs,
    overlayVerticalSeamMismatchesByPart,
    overlayVerticalSeamColorDistanceByPart,
    overlayHorizontalSeamMismatches,
    overlayHorizontalSeamSamples,
    overlayHorizontalSeamColorDistance:
      overlayHorizontalSeamOpaquePairs === 0
        ? 0
        : overlayHorizontalSeamColorDistanceSum /
          overlayHorizontalSeamOpaquePairs,
    overlayHorizontalSeamMismatchesByPart,
    overlayHorizontalSeamColorDistanceByPart,
    baseHorizontalSeamColorDistance:
      baseHorizontalSeamOpaquePairs === 0
        ? 0
        : baseHorizontalSeamColorDistanceSum / baseHorizontalSeamOpaquePairs,
    baseHorizontalSeamColorDistanceByPart,
    detailedBaseFaces,
    overlayPixelsByPart,
  };
}

/**
 * 마스크 적용 전의 64x64 atlas를 검사한다 (마스크 전이어야
 * "UV 밖에 디테일이 있다 = atlas가 아니라 캐릭터 렌더" 휴리스틱이 동작한다).
 */
export function validateAtlas(atlas: RawImage): AtlasValidation {
  const problems: string[] = [];
  if (atlas.width !== ATLAS_SIZE || atlas.height !== ATLAS_SIZE) {
    return {
      ok: false,
      problems: [`크기가 64x64가 아님 (${atlas.width}x${atlas.height})`],
    };
  }

  // 얼굴(머리 앞면)이 비어 있거나 단색이면 실패
  const faceColors = distinctColorsIn(atlas, [HEAD_FRONT]);
  if (faceColors < 3) {
    problems.push(`얼굴 면의 색 다양성이 부족 (${faceColors}종)`);
  }

  // base 전체가 사실상 단색이면 실패
  const baseColors = distinctColorsIn(atlas, BASE_RECTS);
  if (baseColors < 8) {
    problems.push(`base 레이어 전체 색 다양성이 부족 (${baseColors}종)`);
  }

  // UV 영역 밖에 디테일이 많으면 atlas가 아니라 일반 캐릭터 이미지일 가능성
  const outsideSeen = new Set<number>();
  for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
    if (ZONE_MAP[i] === "outside" && atlas.rgba[i * 4 + 3] >= 32) {
      outsideSeen.add(quantKey(atlas.rgba, i));
    }
  }
  if (outsideSeen.size > 48) {
    problems.push(
      `UV 밖 영역에 디테일 과다 (${outsideSeen.size}종) — atlas 형태가 아닐 수 있음`,
    );
  }

  return { ok: problems.length === 0, problems };
}

/** 최종 산출물 검증: 정확히 64x64 RGBA + base 불투명 + overlay/외부 이진 alpha */
export function validateFinalAtlas(atlas: RawImage): AtlasValidation {
  const problems: string[] = [];
  if (atlas.width !== ATLAS_SIZE || atlas.height !== ATLAS_SIZE) {
    problems.push(`크기가 64x64가 아님 (${atlas.width}x${atlas.height})`);
  }
  if (atlas.rgba.length !== ATLAS_SIZE * ATLAS_SIZE * 4) {
    problems.push("RGBA 버퍼 크기 불일치");
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
    const a = atlas.rgba[i * 4 + 3];
    const zone = ZONE_MAP[i];
    if (zone === "outside" && a !== 0) {
      problems.push(
        `UV 밖 픽셀이 불투명 (${i % ATLAS_SIZE},${Math.floor(i / ATLAS_SIZE)})`,
      );
      break;
    }
    if (zone === "base" && a !== 255) {
      problems.push(
        `base 픽셀이 투명 (${i % ATLAS_SIZE},${Math.floor(i / ATLAS_SIZE)})`,
      );
      break;
    }
    if (zone === "overlay" && a !== 0 && a !== 255) {
      problems.push(
        `overlay alpha가 이진이 아님 (${i % ATLAS_SIZE},${Math.floor(i / ATLAS_SIZE)})`,
      );
      break;
    }
  }
  return { ok: problems.length === 0, problems };
}
