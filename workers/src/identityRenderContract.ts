import type { FacePixelPlan, HairPlan } from "./identityPlans";
import type { RawImage } from "./png";
import { ATLAS_SIZE, CLASSIC_LAYOUT, type Rect } from "./uvLayout";

export type ContractStatus = "satisfied" | "violated" | "not_applicable";

export interface FaceContractMeasurement {
  status: ContractStatus;
  violations: string[];
  mouthPresent: boolean;
  eyesPresent: boolean;
  glassesPresent: boolean | null;
  mouthWidth: number;
  teethPixels: number;
  mouthBoundaryPixels: number;
  glassesTopologyPixels: number;
  openLensPixels: number;
}

export interface HairContractMeasurement {
  status: ContractStatus;
  violations: string[];
  plannedPixels: number;
  presentPlannedPixels: number;
  coverageRatio: number;
  coverageByFace: Record<"front" | "top" | "left" | "right" | "back", number>;
  missingSilhouettePixels: number;
  unexpectedHairLikePixels: number;
  requiredStructureGroups: number;
  preservedStructureGroups: number;
  hairlineCoverage: number;
  partChannelPreserved: boolean | null;
  earExposurePreserved: boolean;
}

function offset(rect: Rect, x: number, y: number): number {
  return ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
}

function opaque(atlas: RawImage, rect: Rect, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < rect.w && y < rect.h && atlas.rgba[offset(rect, x, y) + 3] > 0;
}

function color(atlas: RawImage, rect: Rect, x: number, y: number): [number, number, number] {
  const at = offset(rect, x, y);
  return [atlas.rgba[at], atlas.rgba[at + 1], atlas.rgba[at + 2]];
}

function distance(first: readonly number[], second: readonly number[]): number {
  return Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
}

function locallyDistinct(atlas: RawImage, rect: Rect, x: number, y: number): boolean {
  const current = color(atlas, rect, x, y);
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => {
    const nextX = x + dx;
    const nextY = y + dy;
    return nextX >= 0 && nextY >= 0 && nextX < rect.w && nextY < rect.h && distance(current, color(atlas, rect, nextX, nextY)) >= 28;
  });
}

export function measureFaceRenderContract(atlas: RawImage, plan?: FacePixelPlan): FaceContractMeasurement {
  if (!plan) {
    return { status: "not_applicable", violations: [], mouthPresent: false, eyesPresent: false, glassesPresent: null, mouthWidth: 0, teethPixels: 0, mouthBoundaryPixels: 0, glassesTopologyPixels: 0, openLensPixels: 0 };
  }
  const face = CLASSIC_LAYOUT.head.base.front;
  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const mouth = plan.pixels.filter((pixel) => pixel.cluster === "mouth");
  const visibleMouth = mouth.filter((pixel) => opaque(atlas, face, pixel.x, pixel.y) && locallyDistinct(atlas, face, pixel.x, pixel.y));
  const mouthXs = visibleMouth.map((pixel) => pixel.x);
  const mouthWidth = mouthXs.length ? Math.max(...mouthXs) - Math.min(...mouthXs) + 1 : 0;
  const boundaryPoints = visibleMouth.filter((pixel) => pixel.role === "lip" || pixel.role === "mouth_shadow");
  const luma = (point: { x: number; y: number }) => {
    const [red, green, blue] = color(atlas, face, point.x, point.y);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const boundaryLuma = boundaryPoints.reduce((sum, point) => sum + luma(point), 0) / Math.max(1, boundaryPoints.length);
  const teethPixels = visibleMouth.filter((pixel) => pixel.role === "teeth" && luma(pixel) >= Math.max(115, boundaryLuma + 18)).length;
  const mouthBoundaryPixels = boundaryPoints.length;
  const leftEye = plan.pixels.filter((pixel) => pixel.cluster === "left_eye" && pixel.role !== "brow");
  const rightEye = plan.pixels.filter((pixel) => pixel.cluster === "right_eye" && pixel.role !== "brow");
  const eyePresent = (points: typeof leftEye) => points.some((pixel) => opaque(atlas, face, pixel.x, pixel.y) && locallyDistinct(atlas, face, pixel.x, pixel.y));
  const glasses = plan.glassesPlan;
  const glassesVisible = glasses.framePixels.filter((point) => {
    const rect = point.face === "front" ? overlay : CLASSIC_LAYOUT.head.overlay[point.face];
    return opaque(atlas, rect, point.x, point.y) && locallyDistinct(atlas, rect, point.x, point.y);
  });
  const visibleArms = glasses.sideArms.filter((point) => opaque(atlas, CLASSIC_LAYOUT.head.overlay[point.face], point.x, point.y));
  const openLensPixels = glasses.lensOpenings.filter((point) => !opaque(atlas, overlay, point.x, point.y)).length;
  const violations: string[] = [];
  const contract = plan.renderContract;
  if (contract.mouth) {
    if (visibleMouth.length < Math.min(2, mouth.length)) violations.push("mouth landmark missing");
    if (mouthWidth < contract.mouth.minimumPerceptualWidth) violations.push("mouth perceptual width contract violated");
    if (contract.mouth.teethReadable && teethPixels === 0) violations.push("teeth cluster contract violated");
    if (contract.mouth.teethReadable && mouthBoundaryPixels === 0) violations.push("mouth boundary contract violated");
    const flatWhiteBar = contract.mouth.teethReadable && teethPixels >= 3 && mouthBoundaryPixels === 0 && new Set(visibleMouth.map((pixel) => pixel.y)).size === 1;
    if (flatWhiteBar) violations.push("mouth is a flat white bar");
    if (contract.mouth.cornerDirection === "upward_or_level" && plan.layout.mouthCornerOffsets.some((value) => value > 0)) violations.push("smile corner direction contract violated");
    if (contract.mouth.preserveAsymmetry && plan.layout.mouthCornerOffsets[0] === plan.layout.mouthCornerOffsets[1]) violations.push("mouth asymmetry contract violated");
  }
  if (contract.eyes && (!eyePresent(leftEye) || !eyePresent(rightEye))) violations.push("eye topology contract violated");
  if (contract.glasses) {
    const leftLens = glassesVisible.some((point) => point.face === "front" && point.x <= 3);
    const rightLens = glassesVisible.some((point) => point.face === "front" && point.x >= 4);
    const bridge = glassesVisible.some((point) => point.role === "bridge");
    const minimum = Math.max(contract.glasses.minimumFootprint, glasses.minimumReadablePixels);
    if (!leftLens || !rightLens || !bridge || glassesVisible.length < minimum || visibleArms.length < Math.min(2, glasses.sideArms.length)) violations.push("glasses topology contract violated");
    if (glasses.preserveThinness && openLensPixels < glasses.lensOpenings.length) violations.push("thin glasses lens opening contract violated");
  }
  return {
    status: violations.length === 0 ? "satisfied" : "violated",
    violations,
    mouthPresent: visibleMouth.length >= Math.min(2, mouth.length),
    eyesPresent: eyePresent(leftEye) && eyePresent(rightEye),
    glassesPresent: contract.glasses ? !violations.some((problem) => /glasses/.test(problem)) : null,
    mouthWidth,
    teethPixels,
    mouthBoundaryPixels,
    glassesTopologyPixels: glassesVisible.length + visibleArms.length,
    openLensPixels,
  };
}

export function measureHairRenderContract(atlas: RawImage, plan?: HairPlan): HairContractMeasurement {
  const empty: HairContractMeasurement = {
    status: "not_applicable",
    violations: [],
    plannedPixels: 0,
    presentPlannedPixels: 0,
    coverageRatio: 1,
    coverageByFace: { front: 1, top: 1, left: 1, right: 1, back: 1 },
    missingSilhouettePixels: 0,
    unexpectedHairLikePixels: 0,
    requiredStructureGroups: 0,
    preservedStructureGroups: 0,
    hairlineCoverage: 1,
    partChannelPreserved: null,
    earExposurePreserved: true,
  };
  // Only normalized geometry produces an exact pixel ownership contract.
  // A semantic template is an input to the coarse hair renderer, not a
  // promise that every template coordinate will survive its authored
  // fringe/accessory composition.
  if (!plan || plan.lengthClass === "none" || plan.headMask.source !== "identity_geometry") return empty;
  const faces = ["front", "top", "left", "right", "back"] as const;
  let plannedPixels = 0;
  let presentPlannedPixels = 0;
  const coverageByFace = { front: 1, top: 1, left: 1, right: 1, back: 1 };
  const plannedKeys = new Set<string>();
  for (const faceName of faces) {
    const rect = CLASSIC_LAYOUT.head.overlay[faceName];
    const points = plan.headMask.faces[faceName];
    const present = points.filter((point) => opaque(atlas, rect, point.x, point.y)).length;
    plannedPixels += points.length;
    presentPlannedPixels += present;
    coverageByFace[faceName] = points.length === 0 ? 1 : present / points.length;
    for (const point of points) plannedKeys.add(`${faceName}:${point.x},${point.y}`);
  }
  const scalpSamples: Array<[number, number, number]> = [];
  const scalp = CLASSIC_LAYOUT.head.base.top;
  for (let y = 0; y < scalp.h; y++) for (let x = 0; x < scalp.w; x++) scalpSamples.push(color(atlas, scalp, x, y));
  let unexpectedHairLikePixels = 0;
  for (const faceName of faces) {
    const rect = CLASSIC_LAYOUT.head.overlay[faceName];
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      if (!opaque(atlas, rect, x, y) || plannedKeys.has(`${faceName}:${x},${y}`)) continue;
      const current = color(atlas, rect, x, y);
      if (scalpSamples.some((sample) => distance(sample, current) <= 105)) unexpectedHairLikePixels++;
    }
  }
  const coverageRatio = presentPlannedPixels / Math.max(1, plannedPixels);
  const violations: string[] = [];
  const requiredGroups = plan.structure.groups.filter((group) => plan.structure.requiredGroupIds.includes(group.id));
  const groupPreserved = (group: (typeof requiredGroups)[number]) => {
    const present = group.points.filter((point) => {
      const rect = point.layer === "base" ? CLASSIC_LAYOUT.head.base[point.face] : CLASSIC_LAYOUT.head.overlay[point.face];
      return opaque(atlas, rect, point.x, point.y) && (point.layer === "outer" || scalpSamples.some((sample) => distance(sample, color(atlas, rect, point.x, point.y)) <= 105));
    }).length;
    return present >= Math.max(1, Math.ceil(group.points.length * 0.5));
  };
  const preservedStructureGroups = requiredGroups.filter(groupPreserved).length;
  const fringePoints = plan.structure.groups.filter((group) => group.kind === "fringe").flatMap((group) => group.points);
  const visibleFringe = fringePoints.filter((point) => opaque(atlas, CLASSIC_LAYOUT.head.base.front, point.x, point.y) && scalpSamples.some((sample) => distance(sample, color(atlas, CLASSIC_LAYOUT.head.base.front, point.x, point.y)) <= 105)).length;
  const hairlineCoverage = fringePoints.length === 0 ? 1 : visibleFringe / fringePoints.length;
  const partPoints = plan.structure.partChannel.points;
  const partChannelPreserved = partPoints.length === 0 ? null : partPoints.filter((point) => locallyDistinct(atlas, CLASSIC_LAYOUT.head.base.top, point.x, point.y)).length >= Math.ceil(partPoints.length * 0.5);
  const earExposurePreserved = (["left", "right"] as const).every((faceName) => {
    if (plan.headMask.earExposure[faceName] < 0.35) return true;
    const rect = CLASSIC_LAYOUT.head.overlay[faceName];
    const endpoint = plan.headMask.endpointRows[faceName];
    let transparent = 0;
    let samples = 0;
    for (let y = Math.max(0, endpoint - 1); y < 8; y++) for (let x = 2; x < 6; x++) {
      samples++;
      if (!opaque(atlas, rect, x, y)) transparent++;
    }
    return transparent >= Math.ceil(samples * 0.25);
  });
  const fullSideVolume = plan.lengthClass === "long" || plan.template === "curly_volume" || plan.template === "coily_volume";
  const minimumOverall = fullSideVolume ? 0.58 : 0.35;
  const minimumSide = fullSideVolume ? 0.5 : 0.2;
  if (coverageRatio < minimumOverall) violations.push(`planned head mask coverage too low (${coverageRatio.toFixed(3)})`);
  if (coverageByFace.left < minimumSide || coverageByFace.right < minimumSide) violations.push(`planned side silhouette missing (left ${coverageByFace.left.toFixed(3)}, right ${coverageByFace.right.toFixed(3)})`);
  // Curl highlights, fringe tips and accessories deliberately sit just
  // outside the measured silhouette. Global overlay coverage still rejects
  // a second opaque cube; this local allowance only prevents those authored
  // accent pixels from being mistaken for missing mask fidelity.
  const unexpectedLimit = Math.max(16, Math.round(plannedPixels * 0.5));
  if (unexpectedHairLikePixels > unexpectedLimit) violations.push(`unexpected hair-like overlay exceeds plan (${unexpectedHairLikePixels})`);
  if (preservedStructureGroups < requiredGroups.length) violations.push(`required hair structure groups missing (${preservedStructureGroups}/${requiredGroups.length})`);
  if (hairlineCoverage < 0.5) violations.push(`planned hairline structure missing (${hairlineCoverage.toFixed(3)})`);
  if (partChannelPreserved === false) violations.push("planned part channel missing");
  if (!earExposurePreserved) violations.push("planned ear exposure occluded");
  return {
    status: violations.length === 0 ? "satisfied" : "violated",
    violations,
    plannedPixels,
    presentPlannedPixels,
    coverageRatio,
    coverageByFace,
    missingSilhouettePixels: plannedPixels - presentPlannedPixels,
    unexpectedHairLikePixels,
    requiredStructureGroups: requiredGroups.length,
    preservedStructureGroups,
    hairlineCoverage,
    partChannelPreserved,
    earExposurePreserved,
  };
}
