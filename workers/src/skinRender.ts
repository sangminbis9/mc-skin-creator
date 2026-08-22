/**
 * Deterministic software renderer for Minecraft Java 64x64 skins.
 *
 * This intentionally has no canvas/WebGL dependency so the Worker can render
 * the exact uploaded atlas from six camera angles before accepting it or
 * sending it to Gemini for visual critique.
 */
import type { RawImage } from "./png";
import {
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  SLIM_LAYOUT,
  type BodyPart,
  type BoxUV,
  type Rect,
} from "./uvLayout";

export type SkinViewName =
  | "front"
  | "back"
  | "left"
  | "right"
  | "front_left_three_quarter"
  | "front_right_three_quarter";

export interface RenderedSkinView {
  name: SkinViewName;
  yawDegrees: number;
  image: RawImage;
  opaquePixels: number;
  distinctColors: number;
}

export interface RenderedSkinInspection {
  ok: boolean;
  problems: string[];
  views: Array<{
    name: SkinViewName;
    opaqueRatio: number;
    distinctColors: number;
  }>;
}

export type SkinGeometry = "classic" | "slim";

interface Box {
  part: BodyPart;
  min: [number, number, number];
  max: [number, number, number];
}

interface Hit {
  distance: number;
  face: keyof BoxUV;
  point: [number, number, number];
  box: Box;
}

const CLASSIC_BODY: Box[] = [
  { part: "head", min: [-4, 12, -4], max: [4, 20, 4] },
  { part: "body", min: [-4, 0, -2], max: [4, 12, 2] },
  { part: "rightArm", min: [-8, 0, -2], max: [-4, 12, 2] },
  { part: "leftArm", min: [4, 0, -2], max: [8, 12, 2] },
  { part: "rightLeg", min: [-4, -12, -2], max: [0, 0, 2] },
  { part: "leftLeg", min: [0, -12, -2], max: [4, 0, 2] },
];

const SLIM_BODY: Box[] = CLASSIC_BODY.map((box) => {
  if (box.part === "rightArm") {
    return { ...box, min: [-7, 0, -2], max: [-4, 12, 2] };
  }
  if (box.part === "leftArm") {
    return { ...box, min: [4, 0, -2], max: [7, 12, 2] };
  }
  return box;
});

const VIEWS: Array<{ name: SkinViewName; yawDegrees: number }> = [
  { name: "front", yawDegrees: 0 },
  { name: "back", yawDegrees: 180 },
  { name: "left", yawDegrees: 90 },
  { name: "right", yawDegrees: 270 },
  { name: "front_left_three_quarter", yawDegrees: 45 },
  { name: "front_right_three_quarter", yawDegrees: 315 },
];

function expanded(box: Box, amount: number): Box {
  return {
    part: box.part,
    min: [box.min[0] - amount, box.min[1] - amount, box.min[2] - amount],
    max: [box.max[0] + amount, box.max[1] + amount, box.max[2] + amount],
  };
}

function intersectBox(
  origin: [number, number, number],
  direction: [number, number, number],
  box: Box,
): Hit | null {
  let near = -Infinity;
  let far = Infinity;
  let nearAxis = 0;
  let nearPositive = false;
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis];
    if (Math.abs(d) < 1e-8) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) {
        return null;
      }
      continue;
    }
    const first = (box.min[axis] - origin[axis]) / d;
    const second = (box.max[axis] - origin[axis]) / d;
    const axisNear = Math.min(first, second);
    const axisFar = Math.max(first, second);
    if (axisNear > near) {
      near = axisNear;
      nearAxis = axis;
      nearPositive = second < first;
    }
    far = Math.min(far, axisFar);
    if (near > far) return null;
  }
  if (far < 0) return null;
  const distance = near >= 0 ? near : far;
  const point: [number, number, number] = [
    origin[0] + direction[0] * distance,
    origin[1] + direction[1] * distance,
    origin[2] + direction[2] * distance,
  ];
  const face: keyof BoxUV =
    nearAxis === 1
      ? nearPositive
        ? "top"
        : "bottom"
      : nearAxis === 0
        ? nearPositive
          ? "left"
          : "right"
        : nearPositive
          ? "front"
          : "back";
  return { distance, face, point, box };
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(0.999999, value));
}

function sampleFace(
  atlas: RawImage,
  uv: Rect,
  face: keyof BoxUV,
  hit: Hit,
): [number, number, number, number] {
  const [x, y, z] = hit.point;
  const [minX, minY, minZ] = hit.box.min;
  const [maxX, maxY, maxZ] = hit.box.max;
  let u = 0;
  let v = clampUnit((maxY - y) / (maxY - minY));
  if (face === "front") u = clampUnit((x - minX) / (maxX - minX));
  else if (face === "back") u = clampUnit((maxX - x) / (maxX - minX));
  else if (face === "right") u = clampUnit((maxZ - z) / (maxZ - minZ));
  else if (face === "left") u = clampUnit((z - minZ) / (maxZ - minZ));
  else {
    u = clampUnit((x - minX) / (maxX - minX));
    v = clampUnit((z - minZ) / (maxZ - minZ));
  }
  const px = uv.x + Math.floor(u * uv.w);
  const py = uv.y + Math.floor(v * uv.h);
  const offset = (py * ATLAS_SIZE + px) * 4;
  return [
    atlas.rgba[offset],
    atlas.rgba[offset + 1],
    atlas.rgba[offset + 2],
    atlas.rgba[offset + 3],
  ];
}

function shade(
  color: [number, number, number, number],
  face: keyof BoxUV,
): [number, number, number, number] {
  const factor = face === "front" ? 1 : face === "back" ? 0.78 : 0.88;
  return [
    Math.round(color[0] * factor),
    Math.round(color[1] * factor),
    Math.round(color[2] * factor),
    color[3],
  ];
}

function renderView(
  atlas: RawImage,
  name: SkinViewName,
  yawDegrees: number,
  geometry: SkinGeometry,
  width = 96,
  height = 144,
): RenderedSkinView {
  const rgba = new Uint8Array(width * height * 4);
  const yaw = (yawDegrees * Math.PI) / 180;
  const view: [number, number, number] = [Math.sin(yaw), 0, Math.cos(yaw)];
  const right: [number, number, number] = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const scale = 28 / Math.min(width, height);
  const colors = new Set<string>();
  const body = geometry === "slim" ? SLIM_BODY : CLASSIC_BODY;
  const layout = geometry === "slim" ? SLIM_LAYOUT : CLASSIC_LAYOUT;
  let opaquePixels = 0;

  for (let py = 0; py < height; py++) {
    const worldY = 22 - (py + 0.5) * scale;
    for (let px = 0; px < width; px++) {
      const screenX = (px + 0.5 - width / 2) * scale;
      const origin: [number, number, number] = [
        right[0] * screenX + view[0] * 64,
        worldY,
        right[2] * screenX + view[2] * 64,
      ];
      const direction: [number, number, number] = [-view[0], 0, -view[2]];
      const hits: Array<{ hit: Hit; overlay: boolean }> = [];
      for (const box of body) {
        const overlay = intersectBox(origin, direction, expanded(box, 0.35));
        if (overlay) hits.push({ hit: overlay, overlay: true });
        const base = intersectBox(origin, direction, box);
        if (base) hits.push({ hit: base, overlay: false });
      }
      hits.sort((a, b) => a.hit.distance - b.hit.distance);
      let color: [number, number, number, number] | null = null;
      for (const candidate of hits) {
        const partLayout = layout[candidate.hit.box.part];
        const uv = (candidate.overlay ? partLayout.overlay : partLayout.base)[
          candidate.hit.face
        ];
        const sampled = sampleFace(
          atlas,
          uv,
          candidate.hit.face,
          candidate.hit,
        );
        if (sampled[3] === 0) continue;
        color = shade(sampled, candidate.hit.face);
        break;
      }
      const offset = (py * width + px) * 4;
      if (color) {
        rgba.set(color, offset);
        opaquePixels++;
        colors.add(`${color[0]},${color[1]},${color[2]},${color[3]}`);
      } else {
        // A uniform cool-neutral backdrop keeps gray clothing, transparent
        // overlay gaps and one-pixel silhouette steps readable to the VLM.
        // A transparency checkerboard visually competes with knit and curl
        // patterns at the enlarged nearest-neighbour scale.
        rgba.set([224, 232, 240, 255], offset);
      }
    }
  }
  return {
    name,
    yawDegrees,
    image: { width, height, rgba },
    opaquePixels,
    distinctColors: colors.size,
  };
}

export function renderSkinViews(
  atlas: RawImage,
  geometry: SkinGeometry = "classic",
): RenderedSkinView[] {
  if (atlas.width !== ATLAS_SIZE || atlas.height !== ATLAS_SIZE) {
    throw new Error("Skin renderer requires a 64x64 atlas");
  }
  return VIEWS.map((view) =>
    renderView(atlas, view.name, view.yawDegrees, geometry),
  );
}

/** Nearest-neighbour head crop used for likeness ranking and eval artifacts. */
export function extractRenderedHeadView(
  view: RenderedSkinView,
  outputSize = 96,
): RawImage {
  const sourceSize = Math.floor(view.image.width / 3);
  const sourceX = Math.floor((view.image.width - sourceSize) / 2);
  const sourceY = Math.max(0, Math.floor(view.image.height / 12));
  const rgba = new Uint8Array(outputSize * outputSize * 4);
  for (let y = 0; y < outputSize; y++) {
    const sampleY = Math.min(view.image.height - 1, sourceY + Math.floor((y * sourceSize) / outputSize));
    for (let x = 0; x < outputSize; x++) {
      const sampleX = Math.min(view.image.width - 1, sourceX + Math.floor((x * sourceSize) / outputSize));
      const sourceOffset = (sampleY * view.image.width + sampleX) * 4;
      const targetOffset = (y * outputSize + x) * 4;
      rgba.set(view.image.rgba.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width: outputSize, height: outputSize, rgba };
}

/** Front, front-left 3/4 and front-right 3/4 under identical geometry. */
export function buildHeadViewMontage(views: RenderedSkinView[]): RawImage {
  const selected = ["front", "front_left_three_quarter", "front_right_three_quarter"].map((name) => {
    const view = views.find((candidate) => candidate.name === name);
    if (!view) throw new Error(`Missing rendered head view: ${name}`);
    return extractRenderedHeadView(view);
  });
  const size = selected[0].width;
  const rgba = new Uint8Array(size * 3 * size * 4);
  selected.forEach((source, index) => {
    for (let y = 0; y < size; y++) {
      const sourceStart = y * size * 4;
      const targetStart = (y * size * 3 + index * size) * 4;
      rgba.set(source.rgba.subarray(sourceStart, sourceStart + size * 4), targetStart);
    }
  });
  return { width: size * 3, height: size, rgba };
}

export function buildSkinViewMontage(views: RenderedSkinView[]): RawImage {
  if (views.length !== 6) throw new Error("Six rendered views are required");
  const tileWidth = views[0].image.width;
  const tileHeight = views[0].image.height;
  const width = tileWidth * 3;
  const closeupSize = tileWidth;
  const height = tileHeight * 2 + closeupSize * 2;
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < views.length; index++) {
    const source = views[index].image;
    const offsetX = (index % 3) * tileWidth;
    const offsetY = Math.floor(index / 3) * tileHeight;
    for (let y = 0; y < tileHeight; y++) {
      const sourceStart = y * tileWidth * 4;
      const targetStart = ((offsetY + y) * width + offsetX) * 4;
      rgba.set(
        source.rgba.subarray(sourceStart, sourceStart + tileWidth * 4),
        targetStart,
      );
    }
  }

  // Facial identity cues occupy only a few source pixels in a full-body tile.
  // Preserve all six required views above, then append nearest-neighbour head
  // close-ups for front and both three-quarter angles so glasses, fringe,
  // earrings, eyes, and loc structure remain inspectable by the VLM.
  const closeupSourceSize = Math.floor(tileWidth / 3);
  const closeupX = Math.floor((tileWidth - closeupSourceSize) / 2);
  const closeupY = Math.max(0, Math.floor(tileHeight / 12));
  const closeupViews = [views[0], views[4], views[5]];
  for (let index = 0; index < closeupViews.length; index++) {
    const source = closeupViews[index].image;
    const offsetX = index * closeupSize;
    const offsetY = tileHeight * 2;
    for (let y = 0; y < closeupSize; y++) {
      const sourceY = Math.min(
        source.height - 1,
        closeupY + Math.floor((y * closeupSourceSize) / closeupSize),
      );
      for (let x = 0; x < closeupSize; x++) {
        const sourceX = Math.min(
          source.width - 1,
          closeupX + Math.floor((x * closeupSourceSize) / closeupSize),
        );
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const targetOffset = ((offsetY + y) * width + offsetX + x) * 4;
        rgba.set(
          source.rgba.subarray(sourceOffset, sourceOffset + 4),
          targetOffset,
        );
      }
    }
  }
  // A second diagnostic row enlarges clothing construction and shoulder hair.
  // This keeps cable knit, lapels, collars, ties, jacket openings and draped
  // strands from being judged from a ~20-pixel full-body torso alone.
  const torsoSourceSize = Math.floor(tileWidth / 2);
  const torsoX = Math.floor((tileWidth - torsoSourceSize) / 2);
  const torsoY = Math.floor(tileHeight / 4);
  const torsoViews = [views[0], views[1], views[4]];
  for (let index = 0; index < torsoViews.length; index++) {
    const source = torsoViews[index].image;
    const offsetX = index * closeupSize;
    const offsetY = tileHeight * 2 + closeupSize;
    for (let y = 0; y < closeupSize; y++) {
      const sourceY = Math.min(
        source.height - 1,
        torsoY + Math.floor((y * torsoSourceSize) / closeupSize),
      );
      for (let x = 0; x < closeupSize; x++) {
        const sourceX = Math.min(
          source.width - 1,
          torsoX + Math.floor((x * torsoSourceSize) / closeupSize),
        );
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const targetOffset = ((offsetY + y) * width + offsetX + x) * 4;
        rgba.set(
          source.rgba.subarray(sourceOffset, sourceOffset + 4),
          targetOffset,
        );
      }
    }
  }
  return { width, height, rgba };
}

export function inspectRenderedSkin(
  views: RenderedSkinView[],
): RenderedSkinInspection {
  const problems: string[] = [];
  const summaries = views.map((view) => {
    const total = view.image.width * view.image.height;
    const opaqueRatio = view.opaquePixels / total;
    if (opaqueRatio < 0.12)
      problems.push(`${view.name}: rendered body is incomplete`);
    if (view.distinctColors < 6)
      problems.push(`${view.name}: too few readable colors`);
    return {
      name: view.name,
      opaqueRatio,
      distinctColors: view.distinctColors,
    };
  });
  return { ok: problems.length === 0, problems, views: summaries };
}
