// Frozen pre-optimization oracle; original function slice SHA-256: a202dd03c76ad130e44ad277450f9e953a8dc13b657a513db43b9545a3412dee
import type { RawImage } from "../../src/png";
import type { AtlasCraftMetrics } from "../../src/skinPost";
import { ALL_PARTS, ATLAS_SIZE, CLASSIC_LAYOUT } from "../../src/uvLayout";

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
export function measureCraftTextureOracle(atlas: RawImage): Pick<
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
