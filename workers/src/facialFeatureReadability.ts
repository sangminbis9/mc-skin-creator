import type { FacePixelPlan } from "./identityPlans";
import type { RawImage } from "./png";
import { facialColorDistance, type FacialRgb } from "./facialContrast";
import { extractRenderedHeadView, renderSkinViews } from "./skinRender";
import { CLASSIC_LAYOUT } from "./uvLayout";

export interface FeatureReadability {
  plannedCells: number;
  visibleCells: number;
  minimumLocalContrast: number;
  meanLocalContrast: number;
  readable: boolean;
}

export interface FacialFeatureReadability {
  eyes: FeatureReadability & { pairSeparated: boolean; darkMidGrammar: boolean };
  brows: FeatureReadability & { separatedFromEyes: boolean; tiltRequired: boolean; tiltReadable: boolean };
  mouth: FeatureReadability & { topologyReadable: boolean; widthReadable: boolean };
  nose: FeatureReadability & { optional: boolean };
  protectedPixelRetention: number;
  visualReadability: number;
}

export interface PreviewFeatureReadability {
  size: string;
  eyesRetained: number;
  browsRetained: number;
  mouthRetained: number;
  retainedFeatureColorRate: number;
  eyeContrast: number;
  browContrast: number;
  mouthContrast: number;
  eyeReadable: boolean;
  browReadable: boolean;
  mouthReadable: boolean;
}

export interface FaceFeatureSignature {
  eyePattern: string;
  browPattern: string;
  mouthPattern: string;
  eyeContrastBand: number;
  browContrastBand: number;
  mouthContrastBand: number;
}

const key = (x: number, y: number) => `${x},${y}`;
const rgbAt = (image: RawImage, x: number, y: number): FacialRgb => {
  const offset = (y * image.width + x) * 4;
  return [image.rgba[offset], image.rgba[offset + 1], image.rgba[offset + 2]];
};

function measure(
  atlas: RawImage,
  plan: FacePixelPlan,
  predicate: (pixel: FacePixelPlan["pixels"][number]) => boolean,
  threshold: number,
): FeatureReadability {
  const face = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const landmarks = new Set(plan.pixels.filter((pixel) => pixel.cluster !== "complexion" && pixel.cluster !== "fringe").map((pixel) => key(pixel.x, pixel.y)));
  const pixels = plan.pixels.filter(predicate);
  const contrasts: number[] = [];
  let visibleCells = 0;
  for (const pixel of pixels) {
    const overlayOffset = ((overlay.y + pixel.y) * atlas.width + overlay.x + pixel.x) * 4;
    if (atlas.rgba[overlayOffset + 3] !== 0 && !plan.glassesPlan.framePixels.some((frame) => frame.face === "front" && frame.x === pixel.x && frame.y === pixel.y)) continue;
    visibleCells++;
    const foreground = rgbAt(atlas, face.x + pixel.x, face.y + pixel.y);
    const neighbors: FacialRgb[] = [];
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = pixel.x + dx;
      const ny = pixel.y + dy;
      if (nx < 0 || nx > 7 || ny < 0 || ny > 7 || landmarks.has(key(nx, ny))) continue;
      neighbors.push(rgbAt(atlas, face.x + nx, face.y + ny));
    }
    const local = neighbors.length === 0 ? foreground : neighbors.reduce<FacialRgb>((sum, color) => [sum[0] + color[0], sum[1] + color[1], sum[2] + color[2]], [0, 0, 0]).map((value) => Math.round(value / neighbors.length)) as FacialRgb;
    contrasts.push(facialColorDistance(foreground, local));
  }
  const minimumLocalContrast = contrasts.length === 0 ? 0 : Math.min(...contrasts);
  const meanLocalContrast = contrasts.length === 0 ? 0 : contrasts.reduce((sum, value) => sum + value, 0) / contrasts.length;
  return {
    plannedCells: pixels.length,
    visibleCells,
    minimumLocalContrast,
    meanLocalContrast,
    readable: pixels.length === 0 || (visibleCells === pixels.length && meanLocalContrast >= threshold),
  };
}

export function measureFacialFeatureReadability(atlas: RawImage, plan: FacePixelPlan): FacialFeatureReadability {
  const eyes = measure(atlas, plan, (pixel) => pixel.role === "iris" || pixel.role === "sclera", 64);
  const brows = measure(atlas, plan, (pixel) => pixel.role === "brow", 44);
  const mouth = measure(atlas, plan, (pixel) => pixel.cluster === "mouth", 44);
  const nose = measure(atlas, plan, (pixel) => pixel.cluster === "nose", 24);
  const eyePixels = plan.pixels.filter((pixel) => pixel.role === "iris" || pixel.role === "sclera");
  const left = eyePixels.filter((pixel) => pixel.cluster === "left_eye");
  const right = eyePixels.filter((pixel) => pixel.cluster === "right_eye");
  const eyeColors = new Set(eyePixels.map((pixel) => rgbAt(atlas, CLASSIC_LAYOUT.head.base.front.x + pixel.x, CLASSIC_LAYOUT.head.base.front.y + pixel.y).join(",")));
  const browPixels = plan.pixels.filter((pixel) => pixel.role === "brow");
  const browRows = new Set(browPixels.map((pixel) => pixel.y));
  const mouthPixels = plan.pixels.filter((pixel) => pixel.cluster === "mouth");
  const protectedPixels = plan.pixels.filter((pixel) => pixel.cluster !== "complexion" && pixel.cluster !== "fringe");
  const retained = eyes.visibleCells + brows.visibleCells + mouth.visibleCells + nose.visibleCells;
  const readableFeatures = [eyes, brows, mouth, nose].filter((feature) => feature.plannedCells === 0 || feature.readable).length;
  return {
    eyes: {
      ...eyes,
      pairSeparated: left.length > 0 && right.length > 0 && Math.max(...left.map((pixel) => pixel.x)) < Math.min(...right.map((pixel) => pixel.x)),
      darkMidGrammar: eyePixels.length <= 2 || eyeColors.size >= 2,
    },
    brows: {
      ...brows,
      separatedFromEyes: browPixels.every((brow) => eyePixels.every((eye) => brow.x !== eye.x || brow.y !== eye.y)),
      tiltRequired: plan.layout.browTiltOffset !== 0,
      tiltReadable: plan.layout.browTiltOffset === 0 || browRows.size >= 2,
    },
    mouth: {
      ...mouth,
      topologyReadable: mouthPixels.length > 0 && (plan.layout.mouthOpening === "closed" || new Set(mouthPixels.map((pixel) => pixel.role)).size >= 2),
      widthReadable: mouthPixels.length > 0 && Math.max(...mouthPixels.map((pixel) => pixel.x)) - Math.min(...mouthPixels.map((pixel) => pixel.x)) + 1 === plan.layout.mouthWidth,
    },
    nose: { ...nose, optional: plan.salience.pixelBudget.nose === 0 },
    protectedPixelRetention: protectedPixels.length === 0 ? 1 : retained / protectedPixels.length,
    visualReadability: readableFeatures / 4,
  };
}

export function measureFaceFeatureSeparability(readings: FacialFeatureReadability[]): { collisionRate: number; readableRate: number } {
  const featureResults = readings.flatMap((reading) => [reading.eyes, reading.brows, reading.mouth]);
  const collisions = readings.reduce((sum, reading) => sum + (reading.eyes.pairSeparated ? 0 : 1) + (reading.brows.separatedFromEyes ? 0 : 1), 0);
  return {
    collisionRate: readings.length === 0 ? 0 : collisions / (readings.length * 2),
    readableRate: featureResults.length === 0 ? 1 : featureResults.filter((feature) => feature.readable).length / featureResults.length,
  };
}

export function measureFaceFeatureSignature(atlas: RawImage, plan: FacePixelPlan): FaceFeatureSignature {
  const reading = measureFacialFeatureReadability(atlas, plan);
  const pattern = (predicate: (pixel: FacePixelPlan["pixels"][number]) => boolean) => plan.pixels
    .filter(predicate)
    .map((pixel) => `${pixel.x},${pixel.y}:${pixel.role}`)
    .sort()
    .join("|");
  return {
    eyePattern: pattern((pixel) => pixel.role === "iris" || pixel.role === "sclera"),
    browPattern: pattern((pixel) => pixel.role === "brow"),
    mouthPattern: pattern((pixel) => pixel.cluster === "mouth"),
    eyeContrastBand: Math.round(reading.eyes.meanLocalContrast / 32),
    browContrastBand: Math.round(reading.brows.meanLocalContrast / 32),
    mouthContrastBand: Math.round(reading.mouth.meanLocalContrast / 32),
  };
}

export function measureFaceFeatureSignatureSeparability(signatures: FaceFeatureSignature[]): { pairCount: number; identicalPairs: number; collisionRate: number } {
  let pairCount = 0;
  let identicalPairs = 0;
  for (let left = 0; left < signatures.length; left++) for (let right = left + 1; right < signatures.length; right++) {
    pairCount++;
    if (JSON.stringify(signatures[left]) === JSON.stringify(signatures[right])) identicalPairs++;
  }
  return { pairCount, identicalPairs, collisionRate: pairCount === 0 ? 0 : identicalPairs / pairCount };
}

/** Confirms that actual front-view rasterization retains the planned feature colours at display size. */
export function measurePreviewFeatureReadability(preview: RawImage, atlas: RawImage, plan: FacePixelPlan): PreviewFeatureReadability {
  const face = CLASSIC_LAYOUT.head.base.front;
  const markerAtlas: RawImage = { ...atlas, rgba: atlas.rgba.slice() };
  const facialPixels = plan.pixels.filter((pixel) => pixel.cluster !== "complexion" && pixel.cluster !== "fringe");
  const markers = facialPixels.map((pixel, index) => ({
    pixel,
    color: [17 + (index * 53) % 211, 19 + (index * 97) % 211, 23 + (index * 149) % 211] as FacialRgb,
  }));
  for (const marker of markers) {
    const offset = ((face.y + marker.pixel.y) * markerAtlas.width + face.x + marker.pixel.x) * 4;
    markerAtlas.rgba.set([...marker.color, 255], offset);
  }
  const markerPreview = extractRenderedHeadView(renderSkinViews(markerAtlas).find((view) => view.name === "front")!, preview.width);
  const markerIndices = markers.map((marker) => {
    const indices: number[] = [];
    for (let pixel = 0; pixel < markerPreview.width * markerPreview.height; pixel++) {
      const offset = pixel * 4;
      if (markerPreview.rgba[offset] === marker.color[0] && markerPreview.rgba[offset + 1] === marker.color[1] && markerPreview.rgba[offset + 2] === marker.color[2]) indices.push(pixel);
    }
    return indices;
  });
  const retained = (predicate: (pixel: FacePixelPlan["pixels"][number]) => boolean) => {
    const selected = markers.map((marker, index) => ({ ...marker, indices: markerIndices[index] })).filter((marker) => predicate(marker.pixel));
    if (selected.length === 0) return { rate: 1, contrast: 0 };
    const visible = selected.filter((marker) => marker.indices.length > 0);
    const cellContrasts = visible.map((marker) => {
      let maximum = 0;
      for (const index of marker.indices) {
        const x = index % preview.width;
        const y = Math.floor(index / preview.width);
        const foreground = rgbAt(preview, x, y);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= preview.width || ny < 0 || ny >= preview.height || marker.indices.includes(ny * preview.width + nx)) continue;
          maximum = Math.max(maximum, facialColorDistance(foreground, rgbAt(preview, nx, ny)));
        }
      }
      return maximum;
    });
    return { rate: visible.length / selected.length, contrast: cellContrasts.reduce((sum, value) => sum + value, 0) / Math.max(1, cellContrasts.length) };
  };
  const eyes = retained((pixel) => pixel.role === "iris" || pixel.role === "sclera");
  const brows = retained((pixel) => pixel.role === "brow");
  const mouth = retained((pixel) => pixel.cluster === "mouth");
  return {
    size: `${preview.width}x${preview.height}`,
    eyesRetained: eyes.rate,
    browsRetained: brows.rate,
    mouthRetained: mouth.rate,
    retainedFeatureColorRate: (eyes.rate + brows.rate + mouth.rate) / 3,
    eyeContrast: eyes.contrast,
    browContrast: brows.contrast,
    mouthContrast: mouth.contrast,
    // Thin frames may legitimately own one edge cell of each two-cell eye;
    // the remaining paired anchors are still readable through the lenses.
    eyeReadable: eyes.rate >= 0.5 && eyes.contrast >= 58,
    browReadable: brows.rate === 1 && brows.contrast >= 42,
    mouthReadable: mouth.rate === 1 && mouth.contrast >= 42,
  };
}
