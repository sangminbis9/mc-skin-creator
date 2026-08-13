/** Deterministic, region-limited atlas correction and seam preservation. */
import type { RawImage } from "./png";
import {
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  getBoxUvSeams,
  type BodyPart,
  type BoxUV,
  type PixelPoint,
  type Rect,
} from "./uvLayout";

export type SkinLayer = "base" | "overlay";
export type SkinFace = keyof BoxUV;

export interface CorrectionTarget {
  source: string;
  part: BodyPart;
  layer: SkinLayer;
  face: SkinFace;
  rect: Rect;
}

export interface CorrectionPlan {
  targets: CorrectionTarget[];
  unresolvedRegions: string[];
}

const FACES: SkinFace[] = ["top", "bottom", "right", "front", "left", "back"];

function parsePart(normalized: string): BodyPart | null {
  if (/(^|\.)head($|\.)/.test(normalized)) return "head";
  if (/(^|\.)(torso|body)($|\.)/.test(normalized)) return "body";
  if (/(arm\.left|left\.arm|leftarm)/.test(normalized)) return "leftArm";
  if (/(arm\.right|right\.arm|rightarm)/.test(normalized)) return "rightArm";
  if (/(leg\.left|left\.leg|leftleg)/.test(normalized)) return "leftLeg";
  if (/(leg\.right|right\.leg|rightleg)/.test(normalized)) return "rightLeg";
  return null;
}

function parseFaces(normalized: string, part: BodyPart): SkinFace[] {
  const tokens = normalized.split(".");
  const unambiguous = (["top", "bottom", "front", "back"] as SkinFace[]).find(
    (face) => tokens.includes(face),
  );
  if (unambiguous) return [unambiguous];
  if (tokens.includes("side")) return ["left", "right"];
  // In arm.left / leg.right the side token selects the body part, not its UV
  // face. A third token can still explicitly request arm.left.left.
  if (part !== "head" && part !== "body" && tokens.length < 3) return [];
  const side = (["left", "right"] as SkinFace[]).find((face) =>
    tokens.includes(face),
  );
  return side ? [side] : [];
}

function parseLayers(normalized: string): SkinLayer[] {
  if (/\b(overlay|outer|secondlayer)\b/.test(normalized)) return ["overlay"];
  if (/\bbase\b/.test(normalized)) return ["base"];
  // A visible feature normally spans its readable base and deliberate depth.
  return ["base", "overlay"];
}

function normalizeRegion(region: string): string {
  return region
    .trim()
    .toLowerCase()
    .replace(/[\s/_-]+/g, ".")
    .replace(/\.+/g, ".");
}

export function resolveCorrectionTargets(regions: string[]): CorrectionPlan {
  const targets: CorrectionTarget[] = [];
  const unresolvedRegions: string[] = [];
  const seen = new Set<string>();
  for (const source of regions) {
    const normalized = normalizeRegion(source);
    const part = parsePart(normalized);
    if (!part) {
      unresolvedRegions.push(source);
      continue;
    }
    const requestedFaces = parseFaces(normalized, part);
    const faces = requestedFaces.length > 0 ? requestedFaces : FACES;
    for (const layer of parseLayers(normalized)) {
      for (const face of faces) {
        const key = `${part}:${layer}:${face}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({
          source,
          part,
          layer,
          face,
          rect: CLASSIC_LAYOUT[part][layer][face],
        });
      }
    }
  }
  return { targets, unresolvedRegions };
}

function copyPixel(target: RawImage, source: RawImage, point: PixelPoint): void {
  const offset = (point.y * ATLAS_SIZE + point.x) * 4;
  target.rgba.set(source.rgba.subarray(offset, offset + 4), offset);
}

function copyRect(target: RawImage, source: RawImage, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const start = (y * ATLAS_SIZE + rect.x) * 4;
    const end = start + rect.w * 4;
    target.rgba.set(source.rgba.subarray(start, end), start);
  }
}

function pointInRect(point: PixelPoint, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.w &&
    point.y >= rect.y &&
    point.y < rect.y + rect.h
  );
}

function copyTouchingSeams(
  target: RawImage,
  source: RawImage,
  correctionTarget: CorrectionTarget,
): void {
  const box = CLASSIC_LAYOUT[correctionTarget.part][correctionTarget.layer];
  const seams = getBoxUvSeams(box);
  for (const seam of [...seams.vertical, ...seams.horizontal]) {
    const touches = [...seam.primary, ...seam.adjacent].some((point) =>
      pointInRect(point, correctionTarget.rect),
    );
    if (!touches) continue;
    for (const point of [...seam.primary, ...seam.adjacent]) {
      copyPixel(target, source, point);
    }
  }
}

export function mergeTargetedAtlas(
  acceptedBase: RawImage,
  correctedCandidate: RawImage,
  regions: string[],
): { atlas: RawImage; plan: CorrectionPlan } {
  if (
    acceptedBase.width !== ATLAS_SIZE ||
    acceptedBase.height !== ATLAS_SIZE ||
    correctedCandidate.width !== ATLAS_SIZE ||
    correctedCandidate.height !== ATLAS_SIZE
  ) {
    throw new Error("Targeted correction requires two 64x64 atlases");
  }
  const plan = resolveCorrectionTargets(regions);
  const atlas: RawImage = {
    width: ATLAS_SIZE,
    height: ATLAS_SIZE,
    rgba: acceptedBase.rgba.slice(),
  };
  for (const target of plan.targets) copyRect(atlas, correctedCandidate, target.rect);
  // Copy only one-pixel physical seam context from adjacent faces. This keeps
  // the rest of the previously correct atlas byte-for-byte stable.
  for (const target of plan.targets) {
    copyTouchingSeams(atlas, correctedCandidate, target);
  }
  return { atlas, plan };
}
