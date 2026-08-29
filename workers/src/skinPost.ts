/**
 * 이미지 생성 모델 출력 → 유효한 64x64 스킨 atlas 후처리 + 검증.
 *
 * - bilinear 없이 8x8(정확히는 size/64) 셀 단위 중앙값으로 축소해 픽셀아트 경계를 보존
 * - 공식 UV 영역 밖 alpha=0, base 레이어 완전 불투명, overlay는 이진 alpha
 * - 얼굴 비어있음 / 단색 면 / atlas가 아닌 일반 캐릭터 렌더 휴리스틱 검사
 */

import type { RawImage } from "./png";
import type { FacePixelPlan } from "./identityPlans";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  BASE_RECTS,
  CLASSIC_LAYOUT,
  HEAD_FRONT,
  buildZoneMap,
  getBoxUvSeams,
  type BodyPart,
  type BoxUV,
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

type BoxFace = keyof BoxUV;

const BOX_FACES: BoxFace[] = [
  "top",
  "bottom",
  "right",
  "front",
  "left",
  "back",
];

function rgbDistance(rgba: Uint8Array, first: number, second: number): number {
  return (
    Math.abs(rgba[first] - rgba[second]) +
    Math.abs(rgba[first + 1] - rgba[second + 1]) +
    Math.abs(rgba[first + 2] - rgba[second + 2])
  );
}

function dominantOutsideColor(atlas: RawImage): [number, number, number] {
  const buckets = new Map<
    number,
    { count: number; r: number; g: number; b: number }
  >();
  for (let pixel = 0; pixel < ATLAS_SIZE * ATLAS_SIZE; pixel++) {
    if (ZONE_MAP[pixel] !== "outside") continue;
    const offset = pixel * 4;
    const key =
      ((atlas.rgba[offset] >> 4) << 8) |
      ((atlas.rgba[offset + 1] >> 4) << 4) |
      (atlas.rgba[offset + 2] >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++;
    bucket.r += atlas.rgba[offset];
    bucket.g += atlas.rgba[offset + 1];
    bucket.b += atlas.rgba[offset + 2];
    buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
  if (!dominant) return [0, 0, 0];
  return [
    Math.round(dominant.r / dominant.count),
    Math.round(dominant.g / dominant.count),
    Math.round(dominant.b / dominant.count),
  ];
}

/**
 * Image generators commonly return an opaque PNG even when the requested UV
 * atlas contains transparent second-layer pixels. Recover those cut-outs
 * before applying the strict UV mask:
 *
 * - pixels that still match the dominant outside background become transparent;
 * - a nearly solid overlay face is treated as a painted copy of its base face,
 *   and only materially different detail pixels are retained;
 * - head top/back faces are allowed to stay solid because they legitimately
 *   provide hair volume around the crown and rear silhouette.
 *
 * Sparse authored overlays are left alone, so collars, cuffs, hems, flowers,
 * side hair and shoe straps keep their intended shapes.
 */
export function restoreGeneratedOverlayAlpha(atlas: RawImage): RawImage {
  if (atlas.width !== ATLAS_SIZE || atlas.height !== ATLAS_SIZE) {
    throw new Error("64x64 atlas required");
  }
  const [backgroundR, backgroundG, backgroundB] = dominantOutsideColor(atlas);
  const backgroundDistance = (offset: number) =>
    Math.abs(atlas.rgba[offset] - backgroundR) +
    Math.abs(atlas.rgba[offset + 1] - backgroundG) +
    Math.abs(atlas.rgba[offset + 2] - backgroundB);

  for (const part of ALL_PARTS) {
    const layout = CLASSIC_LAYOUT[part];
    for (const face of BOX_FACES) {
      const overlay = layout.overlay[face];
      const base = layout.base[face];
      const pixels: Array<{ overlayOffset: number; baseOffset: number }> = [];
      let opaqueAfterBackground = 0;

      for (let y = 0; y < overlay.h; y++) {
        for (let x = 0; x < overlay.w; x++) {
          const overlayOffset =
            ((overlay.y + y) * ATLAS_SIZE + overlay.x + x) * 4;
          const baseOffset = ((base.y + y) * ATLAS_SIZE + base.x + x) * 4;
          pixels.push({ overlayOffset, baseOffset });
          if (
            atlas.rgba[overlayOffset + 3] < 128 ||
            backgroundDistance(overlayOffset) <= 9
          ) {
            atlas.rgba[overlayOffset + 3] = 0;
          } else {
            atlas.rgba[overlayOffset + 3] = 255;
            opaqueAfterBackground++;
          }
        }
      }

      const canBeSolidHairVolume =
        part === "head" && (face === "top" || face === "back");
      const nearlySolid = opaqueAfterBackground / pixels.length >= 0.9;
      if (!nearlySolid || canBeSolidHairVolume) continue;

      for (const { overlayOffset, baseOffset } of pixels) {
        if (
          atlas.rgba[overlayOffset + 3] !== 0 &&
          rgbDistance(atlas.rgba, overlayOffset, baseOffset) <= 30
        ) {
          atlas.rgba[overlayOffset + 3] = 0;
        }
      }
    }
  }
  return atlas;
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
  baseVerticalSeamColorDistance: number;
  baseVerticalSeamColorDistanceByPart: Record<BodyPart, number>;
  baseHorizontalSeamColorDistance: number;
  baseHorizontalSeamColorDistanceByPart: Record<BodyPart, number>;
  detailedBaseFaces: number;
  overlayPixelsByPart: Record<BodyPart, number>;
  overlayCoverageByPart: Record<BodyPart, number>;
  isolatedNoisePixels: number;
  isolatedNoiseRatio: number;
  maxLocalPaletteSize: number;
  meanLocalPaletteSize: number;
  connectedClusterCoherence: number;
  colorEntropy: number;
  edgeFrequency: number;
}

function perceptualKey(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const value = Math.round(max / 32);
  const chroma = Math.round((max - min) / 24);
  let hue = 0;
  if (max !== min) {
    if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
  }
  return `${Math.round(hue * 2)}:${chroma}:${value}`;
}

function measureCraftTexture(atlas: RawImage): Pick<
  AtlasCraftMetrics,
  | "isolatedNoisePixels"
  | "isolatedNoiseRatio"
  | "maxLocalPaletteSize"
  | "meanLocalPaletteSize"
  | "connectedClusterCoherence"
  | "colorEntropy"
  | "edgeFrequency"
> {
  const faces = ALL_PARTS.flatMap((part) => [
    ...Object.values(CLASSIC_LAYOUT[part].base),
    ...Object.values(CLASSIC_LAYOUT[part].overlay),
  ]);
  let isolatedNoisePixels = 0;
  let opaquePixels = 0;
  let edgePairs = 0;
  let neighborPairs = 0;
  let largestClusterMass = 0;
  let clusteredMass = 0;
  const localPalettes: number[] = [];
  const global = new Map<string, number>();
  const colorDistance = (first: number, second: number) =>
    Math.abs(atlas.rgba[first] - atlas.rgba[second]) +
    Math.abs(atlas.rgba[first + 1] - atlas.rgba[second + 1]) +
    Math.abs(atlas.rgba[first + 2] - atlas.rgba[second + 2]);

  for (const rect of faces) {
    const palette = new Set<string>();
    const present = new Set<number>();
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const absolute = (rect.y + y) * ATLAS_SIZE + rect.x + x;
        const offset = absolute * 4;
        if (atlas.rgba[offset + 3] === 0) continue;
        present.add(y * rect.w + x);
        opaquePixels++;
        const key = perceptualKey(atlas.rgba[offset], atlas.rgba[offset + 1], atlas.rgba[offset + 2]);
        palette.add(key);
        global.set(key, (global.get(key) ?? 0) + 1);
        const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const;
        const comparable = neighbors
          .filter(([nx, ny]) => nx >= 0 && nx < rect.w && ny >= 0 && ny < rect.h)
          .map(([nx, ny]) => ((rect.y + ny) * ATLAS_SIZE + rect.x + nx) * 4)
          .filter((neighbor) => atlas.rgba[neighbor + 3] !== 0);
        if (comparable.length >= 2 && comparable.every((neighbor) => colorDistance(offset, neighbor) > 72)) isolatedNoisePixels++;
        for (const [nx, ny] of [[x + 1, y], [x, y + 1]] as const) {
          if (nx >= rect.w || ny >= rect.h) continue;
          const neighbor = ((rect.y + ny) * ATLAS_SIZE + rect.x + nx) * 4;
          if (atlas.rgba[neighbor + 3] === 0) continue;
          neighborPairs++;
          if (colorDistance(offset, neighbor) > 54) edgePairs++;
        }
      }
    }
    if (present.size > 0) localPalettes.push(palette.size);
    const visited = new Set<number>();
    let faceLargest = 0;
    for (const seed of present) {
      if (visited.has(seed)) continue;
      const queue = [seed];
      visited.add(seed);
      let size = 0;
      while (queue.length > 0) {
        const current = queue.pop()!;
        size++;
        const x = current % rect.w;
        const y = Math.floor(current / rect.w);
        const currentOffset = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
          const next = ny * rect.w + nx;
          if (nx < 0 || nx >= rect.w || ny < 0 || ny >= rect.h || !present.has(next) || visited.has(next)) continue;
          const nextOffset = ((rect.y + ny) * ATLAS_SIZE + rect.x + nx) * 4;
          if (colorDistance(currentOffset, nextOffset) <= 72) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      faceLargest = Math.max(faceLargest, size);
    }
    largestClusterMass += faceLargest;
    clusteredMass += present.size;
  }
  let entropy = 0;
  for (const count of global.values()) {
    const probability = count / Math.max(1, opaquePixels);
    entropy -= probability * Math.log2(probability);
  }
  const normalizedEntropy = global.size <= 1 ? 0 : entropy / Math.log2(global.size);
  return {
    isolatedNoisePixels,
    isolatedNoiseRatio: isolatedNoisePixels / Math.max(1, opaquePixels),
    maxLocalPaletteSize: Math.max(0, ...localPalettes),
    meanLocalPaletteSize: localPalettes.reduce((sum, count) => sum + count, 0) / Math.max(1, localPalettes.length),
    connectedClusterCoherence: largestClusterMass / Math.max(1, clusteredMass),
    colorEntropy: normalizedEntropy,
    edgeFrequency: edgePairs / Math.max(1, neighborPairs),
  };
}

/** Analysis-derived expectations for rejecting flat default-looking skins. */
export interface AtlasCraftStyle {
  eyeSpacing?: string;
  eyeTilt?: string;
  glasses?: string;
  mouthShape?: string;
  bangs?: string;
  bangsLength?: string;
  fringeOpening?: string;
  hairstyle?: string;
  hairTexture?: string;
  hat?: string;
  sideHairLength?: string;
  sideHairShape?: string;
  hairAccessory?: string;
  garmentTexture?: string;
  outerLayer?: string;
  outerGarment?: string;
  neckAccessory?: string;
  bottomPattern?: string;
  bottomAccent?: string;
  legwear?: string;
  thighAccessory?: string;
}

/**
 * Broad envelopes measured from the bundled deterministic handcrafted-style
 * regression family. They are distribution guards, not a single-skin style
 * template; subjects may legitimately be sparse, bald, wrapped or layered.
 */
export const HANDCRAFTED_CRAFT_DISTRIBUTION = {
  maxLocalPaletteP95: 30,
  isolatedNoiseRatioP95: 0.1,
  minimumClusterCoherenceP05: 0.18,
  maximumNonWrappedOverlayCoverageP95: 0.8,
} as const;

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
  const overlayCapacityByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [
      part,
      Object.values(CLASSIC_LAYOUT[part].overlay).reduce((sum, rect) => sum + rect.w * rect.h, 0),
    ]),
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
  const baseVerticalSeamColorDistanceByPart = Object.fromEntries(
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
  let baseVerticalSeamColorDistanceSum = 0;
  let baseVerticalSeamOpaquePairs = 0;
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

    const baseSeams = getBoxUvSeams(CLASSIC_LAYOUT[part].base);
    const baseVerticalStats = measureSeams(atlas, baseSeams.vertical);
    baseVerticalSeamColorDistanceSum += baseVerticalStats.colorDistanceSum;
    baseVerticalSeamOpaquePairs += baseVerticalStats.opaquePairs;
    baseVerticalSeamColorDistanceByPart[part] =
      averageSeamColorDistance(baseVerticalStats);

    const baseHorizontalStats = measureSeams(atlas, baseSeams.horizontal);
    baseHorizontalSeamColorDistanceSum += baseHorizontalStats.colorDistanceSum;
    baseHorizontalSeamOpaquePairs += baseHorizontalStats.opaquePairs;
    baseHorizontalSeamColorDistanceByPart[part] =
      averageSeamColorDistance(baseHorizontalStats);
  }

  const overlayCoverageByPart = Object.fromEntries(
    ALL_PARTS.map((part) => [part, overlayPixelsByPart[part] / Math.max(1, overlayCapacityByPart[part])]),
  ) as Record<BodyPart, number>;
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
    baseVerticalSeamColorDistance:
      baseVerticalSeamOpaquePairs === 0
        ? 0
        : baseVerticalSeamColorDistanceSum / baseVerticalSeamOpaquePairs,
    baseVerticalSeamColorDistanceByPart,
    baseHorizontalSeamColorDistance:
      baseHorizontalSeamOpaquePairs === 0
        ? 0
        : baseHorizontalSeamColorDistanceSum / baseHorizontalSeamOpaquePairs,
    baseHorizontalSeamColorDistanceByPart,
    detailedBaseFaces,
    overlayPixelsByPart,
    overlayCoverageByPart,
    ...measureCraftTexture(atlas),
  };
}

/**
 * Style-aware quality gate. Format validation alone cannot distinguish a
 * detailed authored skin from a technically valid but flat template. These
 * conservative floors sit below the bundled handcrafted reference while
 * still requiring clustered shading, sparse second layers, and the regions
 * promised by the photo analysis.
 */
export function validateAtlasCraft(
  atlas: RawImage,
  style: AtlasCraftStyle,
  facePixelPlan?: FacePixelPlan,
): AtlasValidation {
  const problems: string[] = [];
  const metrics = measureAtlasCraft(atlas);
  const value = (candidate: string | undefined) => candidate ?? "none";
  const has = (candidate: string | undefined) => value(candidate) !== "none";
  const headScarf = style.hat === "headscarf";
  const longSideHair =
    !headScarf &&
    ["cheek", "jaw", "shoulder"].includes(value(style.sideHairLength));
  const styledHair =
    !headScarf && !["none", "bald", "buzz"].includes(value(style.hairstyle));
  // FaceStyle always supplies these fields in the live pipeline. Keeping
  // identity and cross-part hairstyle checks opt-in lets external reference
  // atlases use the general craft metrics without assuming our landmarks.
  const validateIdentity =
    style.eyeSpacing !== undefined ||
    style.eyeTilt !== undefined ||
    style.mouthShape !== undefined;
  const richStyle =
    style.outerLayer === "heavy" ||
    headScarf ||
    styledHair ||
    longSideHair ||
    has(style.hairAccessory) ||
    has(style.outerGarment) ||
    has(style.neckAccessory) ||
    has(style.legwear) ||
    has(style.thighAccessory) ||
    !["none", "plain"].includes(value(style.bottomPattern)) ||
    has(style.bottomAccent) ||
    !["none", "plain"].includes(value(style.garmentTexture));

  if (metrics.baseColorCount < 16)
    problems.push(`base palette too small (${metrics.baseColorCount})`);
  if (metrics.detailedBaseFaces < 18)
    problems.push(`too few shaded base faces (${metrics.detailedBaseFaces})`);
  if (metrics.overlayColorCount < 6)
    problems.push(
      `outer-layer palette too small (${metrics.overlayColorCount})`,
    );
  if (metrics.populatedOverlayFaces < 6)
    problems.push(
      `too few populated outer-layer faces (${metrics.populatedOverlayFaces})`,
    );
  if (metrics.shadedOverlayFaces < 6)
    problems.push(
      `too few shaded outer-layer faces (${metrics.shadedOverlayFaces})`,
    );
  // A wrapped head covering legitimately occupies the crown, back and both
  // side faces as one continuous cloth shell. Other styles must keep every
  // overlay face sparse so accidental opaque template cubes are still caught.
  if (metrics.solidOverlayFaces > (headScarf ? 4 : 0))
    problems.push(
      `solid outer-layer shells found (${metrics.solidOverlayFaces})`,
    );
  if (metrics.overlayVerticalSeamMismatches > 16)
    problems.push(
      `outer-layer vertical seams disconnected (${metrics.overlayVerticalSeamMismatches})`,
    );
  if (metrics.overlayVerticalSeamColorDistance > 8)
    problems.push(
      `outer-layer seam colours diverge (${metrics.overlayVerticalSeamColorDistance.toFixed(1)})`,
    );
  // Procedural skins intentionally leave a few open cuff/sole corners. The
  // representative default reaches 84 mismatches, while clearing the actual
  // top/bottom faces crosses 96. Keep that construction tolerance separate
  // from the exact head side-hair seam rule below.
  if (metrics.overlayHorizontalSeamMismatches > 96)
    problems.push(
      `outer-layer horizontal seams disconnected (${metrics.overlayHorizontalSeamMismatches})`,
    );
  if (metrics.overlayHorizontalSeamColorDistance > 80)
    problems.push(
      `outer-layer horizontal seam colours diverge (${metrics.overlayHorizontalSeamColorDistance.toFixed(1)})`,
    );
  if (metrics.baseVerticalSeamColorDistance > 200)
    problems.push(
      `base-layer vertical seam colours diverge (${metrics.baseVerticalSeamColorDistance.toFixed(1)})`,
    );
  if (metrics.baseHorizontalSeamColorDistance > 200)
    problems.push(
      `base-layer horizontal seam colours diverge (${metrics.baseHorizontalSeamColorDistance.toFixed(1)})`,
    );
  if (metrics.isolatedNoiseRatio > 0.12)
    problems.push(`isolated pixel noise too high (${metrics.isolatedNoiseRatio.toFixed(3)})`);
  if (metrics.maxLocalPaletteSize > HANDCRAFTED_CRAFT_DISTRIBUTION.maxLocalPaletteP95 + 2)
    problems.push(`local material palette too large (${metrics.maxLocalPaletteSize})`);
  if (metrics.connectedClusterCoherence < HANDCRAFTED_CRAFT_DISTRIBUTION.minimumClusterCoherenceP05 - 0.02)
    problems.push(`pixel clusters are too fragmented (${metrics.connectedClusterCoherence.toFixed(3)})`);
  if (metrics.colorEntropy > 0.94 && metrics.edgeFrequency > 0.62)
    problems.push(`high-entropy edge noise (${metrics.colorEntropy.toFixed(3)}/${metrics.edgeFrequency.toFixed(3)})`);
  for (const part of ALL_PARTS) {
    const maximumCoverage = headScarf && part === "head"
      ? 0.86
      : HANDCRAFTED_CRAFT_DISTRIBUTION.maximumNonWrappedOverlayCoverageP95;
    if (metrics.overlayCoverageByPart[part] > maximumCoverage) {
      problems.push(`${part} outer layer is over-covered (${metrics.overlayCoverageByPart[part].toFixed(3)})`);
    }
  }

  if (richStyle) {
    if (metrics.opaqueOverlayPixels < 120)
      problems.push(
        `rich style lacks outer-layer volume (${metrics.opaqueOverlayPixels})`,
      );
    if (metrics.overlayColorCount < 12)
      problems.push(
        `rich style palette too small (${metrics.overlayColorCount})`,
      );
    if (metrics.populatedOverlayFaces < 12)
      problems.push(
        `rich style misses connected faces (${metrics.populatedOverlayFaces})`,
      );
    if (metrics.shadedOverlayFaces < 10)
      problems.push(
        `rich style lacks face shading (${metrics.shadedOverlayFaces})`,
      );
  }

  if (
    (styledHair || longSideHair || has(style.hairAccessory)) &&
    metrics.overlayPixelsByPart.head < 50
  ) {
    problems.push(
      `hair silhouette lacks head outer-layer pixels (${metrics.overlayPixelsByPart.head})`,
    );
  }
  if (has(style.hairAccessory) && metrics.overlayPixelsByPart.head < 60) {
    problems.push(
      `hair accessory lacks a readable head cluster (${metrics.overlayPixelsByPart.head})`,
    );
  }
  if (
    style.sideHairLength === "shoulder" &&
    metrics.overlayPixelsByPart.body < 30
  ) {
    problems.push(
      `shoulder hair does not continue onto the torso (${metrics.overlayPixelsByPart.body})`,
    );
  }
  if (validateIdentity && style.sideHairLength === "shoulder") {
    const colorAt = (rect: Rect, x: number, y: number) => {
      const offset = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      return [
        atlas.rgba[offset],
        atlas.rgba[offset + 1],
        atlas.rgba[offset + 2],
        atlas.rgba[offset + 3],
      ] as const;
    };
    const scalpPalette: Array<readonly [number, number, number]> = [];
    const scalp = CLASSIC_LAYOUT.head.base.top;
    for (let y = 0; y < scalp.h; y++) {
      for (let x = 0; x < scalp.w; x++) {
        const pixel = colorAt(scalp, x, y);
        if (pixel[3] !== 0) scalpPalette.push([pixel[0], pixel[1], pixel[2]]);
      }
    }
    const resemblesScalp = (rect: Rect, x: number, y: number) => {
      const pixel = colorAt(rect, x, y);
      if (pixel[3] === 0) return false;
      return scalpPalette.some(
        (hair) =>
          Math.abs(pixel[0] - hair[0]) +
            Math.abs(pixel[1] - hair[1]) +
            Math.abs(pixel[2] - hair[2]) <=
          105,
      );
    };
    const torso = CLASSIC_LAYOUT.body.overlay;
    const torsoPath = [
      ...Array.from({ length: 7 }, (_, y) => [torso.front, 0, y] as const),
      ...Array.from(
        { length: 7 },
        (_, y) => [torso.front, torso.front.w - 1, y] as const,
      ),
      ...Array.from({ length: 8 }, (_, y) => [torso.right, 0, y] as const),
      ...Array.from(
        { length: 8 },
        (_, y) => [torso.left, torso.left.w - 1, y] as const,
      ),
    ];
    const torsoHairPixels = torsoPath.filter(([rect, x, y]) =>
      resemblesScalp(rect, x, y),
    ).length;
    const armHairPixels = (
      arm: typeof CLASSIC_LAYOUT.rightArm.overlay,
      side: Rect,
    ) => {
      const path = [
        ...Array.from({ length: 6 }, (_, y) => [arm.front, 0, y] as const),
        ...Array.from(
          { length: 6 },
          (_, y) => [arm.front, arm.front.w - 1, y] as const,
        ),
        ...Array.from({ length: 6 }, (_, y) => [side, 0, y] as const),
        ...Array.from({ length: 4 }, (_, y) => [side, 1, y] as const),
      ];
      return path.filter(([rect, x, y]) => resemblesScalp(rect, x, y)).length;
    };
    const rightShoulderHair = armHairPixels(
      CLASSIC_LAYOUT.rightArm.overlay,
      CLASSIC_LAYOUT.rightArm.overlay.right,
    );
    const leftShoulderHair = armHairPixels(
      CLASSIC_LAYOUT.leftArm.overlay,
      CLASSIC_LAYOUT.leftArm.overlay.left,
    );
    if (torsoHairPixels < 12 || rightShoulderHair < 5 || leftShoulderHair < 5) {
      problems.push(
        `shoulder hair is not colour-connected across head, torso and arms (torso ${torsoHairPixels}, right ${rightShoulderHair}, left ${leftShoulderHair})`,
      );
    }
  }
  if (has(style.outerGarment)) {
    if (metrics.overlayPixelsByPart.body < 40)
      problems.push(
        `outer garment lacks torso construction (${metrics.overlayPixelsByPart.body})`,
      );
    if (
      metrics.overlayPixelsByPart.rightArm < 16 ||
      metrics.overlayPixelsByPart.leftArm < 16
    ) {
      problems.push("outer garment does not continue across both sleeves");
    }
  }
  if (
    has(style.legwear) &&
    metrics.overlayPixelsByPart.rightLeg + metrics.overlayPixelsByPart.leftLeg <
      24
  ) {
    problems.push("legwear lacks a readable second-layer cluster");
  }

  if (validateIdentity) {
    const face = CLASSIC_LAYOUT.head.base.front;
    const faceOverlay = CLASSIC_LAYOUT.head.overlay.front;
    const defaultEyeRow = facePixelPlan?.layout.eyeRow ?? 4;
    const tiltOffset = facePixelPlan?.layout.eyeTiltOffset ?? (style.eyeTilt === "upturned" ? -1 : style.eyeTilt === "downturned" ? 1 : 0);
    const eyePairs: ReadonlyArray<{ outer: number; inner: number; row: number; outerRow: number }> = facePixelPlan
      ? [
          { outer: facePixelPlan.layout.leftEyeXs[0], inner: facePixelPlan.layout.leftEyeXs.at(-1)!, row: facePixelPlan.layout.leftEyeRow, outerRow: facePixelPlan.layout.leftEyeRow + tiltOffset },
          { outer: facePixelPlan.layout.rightEyeXs.at(-1)!, inner: facePixelPlan.layout.rightEyeXs[0], row: facePixelPlan.layout.rightEyeRow, outerRow: facePixelPlan.layout.rightEyeRow + tiltOffset },
        ]
      : style.eyeSpacing === "wide"
        ? ([
            { outer: 0, inner: 1, row: defaultEyeRow, outerRow: defaultEyeRow + tiltOffset },
            { outer: 7, inner: 6, row: defaultEyeRow, outerRow: defaultEyeRow + tiltOffset },
          ] as const)
        : style.eyeSpacing === "close"
          ? ([
              { outer: 1, inner: 2, row: defaultEyeRow, outerRow: defaultEyeRow + tiltOffset },
              { outer: 5, inner: 4, row: defaultEyeRow, outerRow: defaultEyeRow + tiltOffset },
            ] as const)
          : ([
              { outer: 1, inner: 2, row: defaultEyeRow, outerRow: defaultEyeRow + tiltOffset },
              { outer: 6, inner: 5, row: defaultEyeRow, outerRow: defaultEyeRow + tiltOffset },
            ] as const);
    const offsetAt = (rect: Rect, x: number, y: number) =>
      ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    const skinBuckets = new Map<
      number,
      { count: number; r: number; g: number; b: number }
    >();
    const excluded = new Set<string>();
    for (const { outer, inner, row, outerRow } of eyePairs) {
      excluded.add(`${outer},${outerRow}`);
      excluded.add(`${inner},${row}`);
    }
    const mouthRow = facePixelPlan?.layout.mouthRow ?? 6;
    const mouthWidth = facePixelPlan?.layout.mouthWidth ?? (style.mouthShape === "wide" ? 4 : 2);
    const mouthStart = facePixelPlan
      ? Math.max(0, Math.min(8 - mouthWidth, Math.round(facePixelPlan.layout.mouthCenterX - (mouthWidth - 1) / 2)))
      : Math.floor((8 - mouthWidth) / 2);
    const mouthCoordinates = facePixelPlan
      ? facePixelPlan.pixels.filter((pixel) => pixel.cluster === "mouth").map((pixel) => ({ x: pixel.x, y: pixel.y }))
      : Array.from({ length: mouthWidth }, (_, index) => ({ x: mouthStart + index, y: mouthRow }));
    for (const point of mouthCoordinates) excluded.add(`${point.x},${point.y}`);
    for (let y = 3; y <= 7; y++) {
      for (let x = 0; x < face.w; x++) {
        if (excluded.has(`${x},${y}`)) continue;
        const offset = offsetAt(face, x, y);
        const key =
          ((atlas.rgba[offset] >> 4) << 8) |
          ((atlas.rgba[offset + 1] >> 4) << 4) |
          (atlas.rgba[offset + 2] >> 4);
        const bucket = skinBuckets.get(key) ?? {
          count: 0,
          r: 0,
          g: 0,
          b: 0,
        };
        bucket.count++;
        bucket.r += atlas.rgba[offset];
        bucket.g += atlas.rgba[offset + 1];
        bucket.b += atlas.rgba[offset + 2];
        skinBuckets.set(key, bucket);
      }
    }
    const skinBucket = [...skinBuckets.values()].sort(
      (first, second) => second.count - first.count,
    )[0];
    // Estimate complexion from stable central cheek/nose anchors. A modal
    // colour bucket can accidentally choose the two matching lower-iris or
    // hair pixels when deliberate face shading makes every skin pixel a
    // slightly different tone, causing one real eye to be rejected.
    const skinAnchors = ([
      [3, 4],
      [4, 4],
      [3, 5],
      [4, 5],
      [1, 6],
      [6, 6],
      [1, 7],
      [6, 7],
    ] as const).filter(([x, y]) => !excluded.has(`${x},${y}`));
    const medianChannel = (channel: number) => {
      const values = skinAnchors
        .map(([x, y]) => atlas.rgba[offsetAt(face, x, y) + channel])
        .sort((first, second) => first - second);
      const middle = Math.floor(values.length / 2);
      return values.length % 2 === 0
        ? (values[middle - 1] + values[middle]) / 2
        : values[middle];
    };
    const skin: [number, number, number] = skinBucket
      ? [medianChannel(0), medianChannel(1), medianChannel(2)]
      : [0, 0, 0];
    const distanceFromSkin = (x: number, y: number) => {
      const offset = offsetAt(face, x, y);
      return (
        Math.abs(atlas.rgba[offset] - skin[0]) +
        Math.abs(atlas.rgba[offset + 1] - skin[1]) +
        Math.abs(atlas.rgba[offset + 2] - skin[2])
      );
    };

    let readableEyes = 0;
    const eyeDiagnostics: string[] = [];
    for (const { outer, inner, row, outerRow } of eyePairs) {
      const irisOffset = offsetAt(faceOverlay, inner, row);
      const outerOffset = offsetAt(faceOverlay, outer, outerRow);
      const intentionalCurtainOverlap =
        style.bangs === "curtain" &&
        style.bangsLength === "eye" &&
        outerRow === 4;
      const intentionalWideSideHairOverlap =
        style.eyeSpacing === "wide" &&
        !["none", "bald", "buzz"].includes(style.hairstyle ?? "none") &&
        ["cheek", "jaw", "shoulder"].includes(style.sideHairLength ?? "none");
      const irisVisible =
        style.glasses !== "none" ||
        (atlas.rgba[irisOffset + 3] === 0 &&
          (atlas.rgba[outerOffset + 3] === 0 ||
            intentionalCurtainOverlap ||
            intentionalWideSideHairOverlap));
      const contrast = distanceFromSkin(inner, row);
      if (irisVisible && contrast >= 45) readableEyes++;
      eyeDiagnostics.push(
        `${inner}:${irisVisible ? "visible" : "occluded"}/${Math.round(contrast)}`,
      );
    }
    if (readableEyes < 2)
      problems.push(
        `face has only ${readableEyes} readable eye(s) (${eyeDiagnostics.join(", ")})`,
      );

    const mouthPixels = mouthCoordinates.filter(
      ({ x, y }) => distanceFromSkin(x, y) >= 30,
    ).length;
    if (mouthPixels < Math.min(2, mouthCoordinates.length))
      problems.push(`mouth landmark is not readable (${mouthPixels} pixels)`);

    if (styledHair) {
      const rightSide = opaqueStatsIn(
        atlas,
        CLASSIC_LAYOUT.head.overlay.right,
      ).pixels;
      const leftSide = opaqueStatsIn(
        atlas,
        CLASSIC_LAYOUT.head.overlay.left,
      ).pixels;
      if (rightSide < 4 || leftSide < 4) {
        problems.push(
          `side hair is disconnected (right ${rightSide}, left ${leftSide})`,
        );
      }
      const headVerticalBreaks =
        metrics.overlayVerticalSeamMismatchesByPart.head;
      const headVerticalColorDistance =
        metrics.overlayVerticalSeamColorDistanceByPart.head;
      if (headVerticalBreaks > 0 || headVerticalColorDistance > 8) {
        problems.push(
          `head side-hair seams are not continuous (breaks ${headVerticalBreaks}, colour distance ${headVerticalColorDistance.toFixed(1)})`,
        );
      }
      // A few open underside pixels are valid around exposed ears/neck and a
      // sparse flower can add intentional top-face edges. Curly/coily locks
      // reaching the cheek or lower need the stricter limit because their
      // bottom row is visible as side volume; other styles retain a small
      // allowance for those authored cut-outs.
      const headHorizontalMismatchLimit =
        ["curly", "coily"].includes(value(style.hairTexture)) && longSideHair
          ? 8
          : 12;
      if (
        metrics.overlayHorizontalSeamMismatchesByPart.head >
        headHorizontalMismatchLimit
      ) {
        problems.push(
          `head crown and side hair are disconnected (${metrics.overlayHorizontalSeamMismatchesByPart.head})`,
        );
      }
    }

    if (
      style.bangs !== "none" &&
      style.fringeOpening !== "none" &&
      !has(style.hairAccessory)
    ) {
      const openingXs =
        style.fringeOpening === "center"
          ? [3, 4]
          : [style.fringeOpening === "left" ? 2 : 5];
      const openPixels = openingXs.filter((x) =>
        [1, 2, 3].some(
          (y) => atlas.rgba[offsetAt(faceOverlay, x, y) + 3] === 0,
        ),
      ).length;
      if (openPixels === 0)
        problems.push("fringe opening is hidden by the outer hair layer");
    }
  }

  return { ok: problems.length === 0, problems };
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
