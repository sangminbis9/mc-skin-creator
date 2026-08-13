/**
 * 정면 캐릭터 뷰 → 64x64 스킨 atlas 결정적 pack (front_pack 전략).
 *
 * Gemini가 그린 "정면 전신 블록 캐릭터" 이미지를 배경 분리 → 부위 슬라이스 →
 * 셀 중앙값 축소로 각 front 면에 채우고, 보이지 않는 옆/뒤/위/아래 면은
 * front 면에서 파생(가장자리 확장·어둡게)해 UV 규칙을 코드로 보장한다.
 */

import type { RawImage } from "./png";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  getBoxUvSeams,
  type BoxUV,
  type PixelPoint,
  type Rect,
} from "./uvLayout";

export interface PackResult {
  atlas: RawImage;
  problems: string[];
  hasBackView: boolean;
  hasSideViews: boolean;
  viewCount: number;
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
  glassesScale?: "normal" | "large";
  /** bald | buzz | short | medium | long | ponytail | bun | twintails | curly | afro */
  hairstyle: string;
  hat: string; // none | cap | beanie | hood | headscarf
  skinTone?: string;
  hairColor?: string;
  hatColor?: string;
  headCoveringPattern?:
    "plain" | "patterned" | "floral" | "paisley" | "geometric" | "striped";
  headCoveringPatternColor?: string;
  headCoveringAccentColor?: string;
  headCoveringAccentSide?: "viewer_left" | "viewer_right" | "center";
  faceShape?: "round" | "oval" | "long" | "angular" | "square";
  eyeShape?: "narrow" | "almond" | "round";
  eyeSize?: "small" | "average" | "large";
  irisLightness?: "dark" | "medium" | "light";
  eyeSpacing?: "close" | "average" | "wide";
  eyeTilt?: "upturned" | "level" | "downturned";
  eyebrowShape?: "straight" | "arched" | "slanted" | "soft";
  noseShape?: "small" | "straight" | "rounded" | "prominent";
  mouthShape?: "small" | "wide" | "full" | "thin";
  mouthOpening?: "closed" | "slightly_open" | "teeth_visible";
  lipFullness?: "thin" | "average" | "full";
  lipColor?: "natural" | "rose" | "red" | "berry" | "brown" | "coral";
  jawShape?: "rounded" | "pointed" | "square" | "soft";
  matureFeatures?: boolean;
  bangs?: "none" | "straight" | "side" | "curtain" | "wispy";
  bangsLength?: "none" | "short" | "brow" | "eye";
  bangsDensity?: "sparse" | "balanced" | "dense";
  fringeEdge?: "blunt" | "staggered" | "wispy";
  fringeOpening?: "none" | "left" | "center" | "right";
  hairTexture?: "straight" | "wavy" | "curly" | "coily";
  /** Extra deterministic contrast requested by a rendered-view critique. */
  hairDepthBoost?: boolean;
  /** Extra low-res facial landmark contrast requested by a likeness critique. */
  faceContrastBoost?: boolean;
  hairStructure?: "loose" | "locs" | "braids";
  hairVolume?: "flat" | "normal" | "full";
  hairSilhouette?: "rounded" | "flat" | "swept" | "tousled" | "spiky";
  hairBackShape?: "tapered" | "rounded" | "long" | "tied" | "undercut";
  overallHairLength?:
    "cropped" | "ear" | "jaw" | "shoulder" | "chest" | "waist" | "hip";
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
  hairAccessoryScale?: "small" | "medium" | "large";
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
  earrings?: "none" | "stud" | "hoop" | "drop" | "teardrop";
  earringColor?: string;
  earringSide?: "both" | "viewer_left" | "viewer_right";
  neckAccessory?: "none" | "bow" | "tie" | "scarf" | "collar";
  neckAccessoryColor?: string;
  neckAccessoryPattern?: "plain" | "striped";
  bottomPattern?: "plain" | "plaid" | "striped" | "pleated" | "lace";
  bottomAccent?: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
  legwear?: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
  legwearColor?: string;
  legwearAsymmetry?: "none" | "left" | "right" | "both";
  thighAccessory?: "none" | "bow" | "ribbon" | "garter";
  thighAccessorySide?: "none" | "left" | "right" | "both";
  shoeStyle?: "sneakers" | "dress_shoes" | "boots" | "loafers" | "sandals";
  topColor?: string;
  topAccentColor?: string;
  topGraphic?: boolean;
  topGraphicSide?: "viewer_left" | "center" | "viewer_right";
  bottomColor?: string;
  shoesColor?: string;
  topType?: string;
  sleeveLength?: string;
  bottomType?: string;
  bottomLength?: "short" | "knee" | "long";
}

export const DEFAULT_FACE_STYLE: FaceStyle = {
  eyeColor: "#4a3728",
  glassesColor: "#22201e",
  eyebrowThickness: "normal",
  expression: "neutral",
  facialHair: "none",
  glasses: "none",
  glassesScale: "normal",
  hairstyle: "short",
  hat: "none",
  skinTone: undefined,
  hairColor: undefined,
  hatColor: undefined,
  headCoveringPattern: "plain",
  headCoveringPatternColor: undefined,
  headCoveringAccentColor: undefined,
  headCoveringAccentSide: undefined,
  faceShape: "oval",
  eyeShape: "almond",
  eyeSize: "average",
  irisLightness: "medium",
  eyeSpacing: "average",
  eyeTilt: "level",
  eyebrowShape: "straight",
  noseShape: "small",
  mouthShape: "small",
  mouthOpening: "closed",
  lipFullness: "average",
  lipColor: "natural",
  jawShape: "soft",
  matureFeatures: false,
  bangs: "none",
  bangsLength: "none",
  bangsDensity: "balanced",
  fringeEdge: "staggered",
  fringeOpening: "none",
  hairTexture: "straight",
  hairDepthBoost: false,
  hairStructure: "loose",
  hairVolume: "normal",
  hairSilhouette: "rounded",
  hairBackShape: "tapered",
  overallHairLength: undefined,
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
  hairAccessoryScale: "medium",
  hairAccessorySide: "left",
  hairAccessoryColor: "pink",
  earrings: "none",
  earringColor: undefined,
  earringSide: "both",
  neckAccessory: "none",
  neckAccessoryPattern: "plain",
  bottomPattern: "plain",
  bottomAccent: "none",
  legwear: "none",
  legwearColor: undefined,
  legwearAsymmetry: "none",
  thighAccessory: "none",
  thighAccessorySide: "none",
  shoeStyle: undefined,
  topGraphic: false,
  topGraphicSide: "center",
  bottomColor: undefined,
  shoesColor: undefined,
  topType: "tshirt",
  sleeveLength: "short",
  bottomType: "pants",
  bottomLength: undefined,
};

type Rgb = [number, number, number];

type OverallHairLength = NonNullable<FaceStyle["overallHairLength"]>;

function resolveOverallHairLength(style: FaceStyle): OverallHairLength {
  if (style.overallHairLength) return style.overallHairLength;
  if (style.hairstyle === "bald" || style.hairstyle === "buzz")
    return "cropped";
  if (style.hairBackShape === "long") return "waist";
  if (style.hairstyle === "short") return "ear";
  if (style.hairstyle === "medium" || style.hairstyle === "curly")
    return "shoulder";
  if (style.hairstyle === "long" || style.hairstyle === "twintails")
    return "waist";
  return "jaw";
}

function hairBodyRows(style: FaceStyle): number {
  const rowsByLength: Record<OverallHairLength, number> = {
    cropped: 0,
    ear: 0,
    jaw: 0,
    shoulder: 4,
    chest: 8,
    waist: 12,
    hip: 12,
  };
  return Math.max(
    rowsByLength[resolveOverallHairLength(style)],
    style.sideHairLength === "shoulder" ? 4 : 0,
  );
}

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
 * Finish all twelve outer-layer cuboid edges after procedural details have
 * been composed. Authored vertical faces carry the semantic pattern; their
 * physically adjacent side/top/bottom edge inherits it. Vertical faces are
 * reconciled in both directions because the procedural author may place a
 * side-only lock or fold. Horizontal edges bridge in either direction only
 * for semantic structures (hair, shoulders, hems, cuffs, and soles), so a
 * deliberately isolated accessory pixel still keeps its authored silhouette.
 */
function reconcileOverlaySeams(
  atlas: RawImage,
  style: FaceStyle,
  hairColor: Rgb,
): void {
  const jerseyAccent =
    style.topType === "jersey" &&
    typeof style.topAccentColor === "string" &&
    /^#[0-9a-f]{6}$/i.test(style.topAccentColor)
      ? hexToRgb(style.topAccentColor, [0, 0, 0])
      : null;
  const colorDistance = (pixelIndex: number, color: Rgb) =>
    Math.abs(atlas.rgba[pixelIndex] - color[0]) +
    Math.abs(atlas.rgba[pixelIndex + 1] - color[1]) +
    Math.abs(atlas.rgba[pixelIndex + 2] - color[2]);
  const copyPixel = (source: PixelPoint, target: PixelPoint) => {
    const sourceIndex = (source.y * ATLAS_SIZE + source.x) * 4;
    const targetIndex = (target.y * ATLAS_SIZE + target.x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      atlas.rgba[targetIndex + channel] = atlas.rgba[sourceIndex + channel];
    }
  };
  const blendPixel = (
    source: PixelPoint,
    target: PixelPoint,
    amount: number,
  ) => {
    const sourceIndex = (source.y * ATLAS_SIZE + source.x) * 4;
    const targetIndex = (target.y * ATLAS_SIZE + target.x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      atlas.rgba[targetIndex + channel] = Math.round(
        atlas.rgba[targetIndex + channel] * (1 - amount) +
          atlas.rgba[sourceIndex + channel] * amount,
      );
    }
  };
  const shouldBridgeHorizontal = (
    part: (typeof ALL_PARTS)[number],
    seamIndex: number,
    sourceIndex: number,
  ) => {
    const hairDistance =
      Math.abs(atlas.rgba[sourceIndex] - hairColor[0]) +
      Math.abs(atlas.rgba[sourceIndex + 1] - hairColor[1]) +
      Math.abs(atlas.rgba[sourceIndex + 2] - hairColor[2]);
    const topSeam = seamIndex < 4;
    const bottomSeam = !topSeam;
    const longHair =
      style.hairstyle === "long" ||
      style.hairBackShape === "long" ||
      style.sideHairLength === "shoulder";
    const extendedSideHair = ["cheek", "jaw", "shoulder"].includes(
      style.sideHairLength ?? "none",
    );
    const hairTolerance =
      style.hairTexture === "curly" || style.hairTexture === "coily"
        ? 220
        : 150;
    const continuesHair =
      hairDistance <= hairTolerance &&
      ((longHair &&
        topSeam &&
        (part === "head" ||
          part === "body" ||
          part === "rightArm" ||
          part === "leftArm")) ||
        (bottomSeam && part === "head" && extendedSideHair));
    const styledHair = !["none", "bald", "buzz"].includes(
      style.hairstyle ?? "none",
    );
    const continuesCrown =
      topSeam && part === "head" && styledHair && hairDistance <= hairTolerance;
    const layeredGarment =
      (style.outerLayer ?? "none") !== "none" ||
      (style.outerGarment ?? "none") !== "none" ||
      ["sweater", "hoodie", "jacket"].includes(style.topType ?? "tshirt");
    const continuesShoulder =
      topSeam &&
      layeredGarment &&
      (part === "body" || part === "rightArm" || part === "leftArm");
    const continuesLowerBody =
      topSeam && (part === "rightLeg" || part === "leftLeg");
    const continuesCuff =
      bottomSeam &&
      (part === "rightArm" || part === "leftArm") &&
      ((style.outerGarment ?? "none") !== "none" ||
        style.sleeveLength === "long");
    const continuesHem = bottomSeam && part === "body" && layeredGarment;
    const continuesSole =
      bottomSeam && (part === "rightLeg" || part === "leftLeg");

    return (
      continuesHair ||
      continuesCrown ||
      continuesShoulder ||
      continuesLowerBody ||
      continuesCuff ||
      continuesHem ||
      continuesSole
    );
  };

  for (const part of ALL_PARTS) {
    const seams = getBoxUvSeams(CLASSIC_LAYOUT[part].overlay);
    for (const seam of seams.vertical) {
      for (let index = 0; index < seam.primary.length; index++) {
        const primary = seam.primary[index];
        const adjacent = seam.adjacent[index];
        const primaryIndex = (primary.y * ATLAS_SIZE + primary.x) * 4;
        const adjacentIndex = (adjacent.y * ATLAS_SIZE + adjacent.x) * 4;
        if (atlas.rgba[primaryIndex + 3] !== 0) {
          copyPixel(primary, adjacent);
        } else if (atlas.rgba[adjacentIndex + 3] !== 0) {
          copyPixel(adjacent, primary);
        }
      }
    }
    for (let seamIndex = 0; seamIndex < seams.horizontal.length; seamIndex++) {
      const seam = seams.horizontal[seamIndex];
      for (let index = 0; index < seam.primary.length; index++) {
        const primary = seam.primary[index];
        const adjacent = seam.adjacent[index];
        const primaryIndex = (primary.y * ATLAS_SIZE + primary.x) * 4;
        const adjacentIndex = (adjacent.y * ATLAS_SIZE + adjacent.x) * 4;
        const primaryOpaque = atlas.rgba[primaryIndex + 3] !== 0;
        const adjacentOpaque = atlas.rgba[adjacentIndex + 3] !== 0;
        if (!primaryOpaque) {
          if (
            adjacentOpaque &&
            shouldBridgeHorizontal(part, seamIndex, adjacentIndex)
          ) {
            copyPixel(adjacent, primary);
          }
          continue;
        }
        if (adjacentOpaque) {
          // A jersey's shoulder stripe or marking is an authored identity cue,
          // not generic cloth shading. When it reaches the top edge, carry the
          // accent around the physical shoulder instead of averaging it back
          // into the shirt colour during seam reconciliation.
          const jerseyShoulderSeam =
            jerseyAccent !== null &&
            seamIndex < 4 &&
            (part === "body" || part === "rightArm" || part === "leftArm");
          if (jerseyShoulderSeam) {
            const primaryIsAccent =
              colorDistance(primaryIndex, jerseyAccent) <= 84;
            const adjacentIsAccent =
              colorDistance(adjacentIndex, jerseyAccent) <= 84;
            if (primaryIsAccent !== adjacentIsAccent) {
              if (primaryIsAccent) copyPixel(primary, adjacent);
              else copyPixel(adjacent, primary);
              continue;
            }
          }
          const preservesAuthoredSole =
            seamIndex >= 4 && (part === "rightLeg" || part === "leftLeg");
          if (!preservesAuthoredSole) blendPixel(primary, adjacent, 0.65);
          continue;
        }
        if (shouldBridgeHorizontal(part, seamIndex, primaryIndex)) {
          copyPixel(primary, adjacent);
        }
      }
    }
  }
}

/**
 * Garment completion can replace edge rows after hidden top/bottom faces were
 * initially filled from an earlier sample. Re-author those perimeters from
 * the four visible vertical faces after final shading. Leg bottoms remain the
 * deliberately darker shoe soles; all top faces and the other undersides no
 * longer flash stale shirt/pants colours during rotation.
 */
function reconcileBaseHorizontalSeams(atlas: RawImage): void {
  for (const part of ALL_PARTS) {
    const horizontalSeams = getBoxUvSeams(CLASSIC_LAYOUT[part].base).horizontal;
    const authoredSeams =
      part === "rightLeg" || part === "leftLeg"
        ? horizontalSeams.slice(0, 4)
        : horizontalSeams;
    for (const seam of authoredSeams) {
      for (let index = 0; index < seam.primary.length; index++) {
        const source = seam.primary[index];
        const target = seam.adjacent[index];
        const sourceOffset = (source.y * ATLAS_SIZE + source.x) * 4;
        const targetOffset = (target.y * ATLAS_SIZE + target.x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          atlas.rgba[targetOffset + channel] =
            atlas.rgba[sourceOffset + channel];
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
  const faceContrastBoost = style.faceContrastBoost === true;

  // 1) 피부 바탕: 얼굴형에 따른 가장자리/턱 명암만 적용한다.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const edge = Math.abs(x - 3.5) / 3.5;
      // Hand-authored skins rarely shade a portrait as a perfectly mirrored
      // mask. A restrained viewer-left key light gives the cheeks, eyes and
      // mouth a coherent three-to-five shade ramp without changing the
      // analysed facial geometry or skin tone.
      const lateralLight = 1.018 - (x / 7) * 0.036;
      let factor = (1.035 - edge * 0.075 - (y / 7) * 0.035) * lateralLight;
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
    // The visible fringe mass falls opposite the root part. A viewer-left
    // part therefore sweeps across the forehead toward viewer-right.
    const mirror = style.hairPart === "left";
    const px = (x: number) => (mirror ? 7 - x : x);
    for (const x of [0, 1, 2, 3, 4, 5]) hair(px(x), 2);
    for (const x of [0, 1, 2]) hair(px(x), 3, 0.96);
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
    const shallowDenseCenterGap =
      bangs === "straight" &&
      bangsDensity === "dense" &&
      fringeOpening === "center";
    for (const x of gapXs) {
      put(face, x, 2, shadeRgb(skinColor, 1.01));
      // A dense straight fringe can have a small central break without being
      // centre-parted. Carving through both low-res fringe rows exaggerated
      // that break into a deep scalp channel in the 3D preview.
      if (!shallowDenseCenterGap) {
        put(face, x, 3, shadeRgb(skinColor, 0.98));
      }
    }
  }

  // 3) 눈썹·눈·코·입: 1픽셀 검은 사각형으로 끝나지 않도록 작은 색 군집을 만든다.
  const browColor = shadeRgb(hairColor, faceContrastBoost ? 0.68 : 0.8);
  const eyeBase = hexToRgb(style.eyeColor, [74, 55, 40]);
  const irisLightness = style.irisLightness ?? "medium";
  const eye =
    irisLightness === "dark"
      ? shadeRgb(eyeBase, faceContrastBoost ? 0.6 : 0.72)
      : irisLightness === "light"
        ? mixRgb(
            shadeRgb(eyeBase, faceContrastBoost ? 1.1 : 1.18),
            [232, 220, 194],
            faceContrastBoost ? 0.08 : 0.12,
          )
        : faceContrastBoost
          ? shadeRgb(eyeBase, 0.84)
          : eyeBase;
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
  const browStronglyOccludedByFringe =
    bangs !== "none" &&
    style.bangsLength === "eye" &&
    style.bangsDensity === "dense";
  const eyebrowShape = style.eyebrowShape ?? "straight";
  const eyeTilt = style.eyeTilt ?? "level";
  const eyeSize = style.eyeSize ?? "average";
  for (const [outer, inner] of eyePairs) {
    const outerBrowY = eyeTilt === "upturned" ? 2 : 3;
    put(
      face,
      outer,
      outerBrowY,
      browStronglyOccludedByFringe
        ? mixRgb(brow, skinColor, 0.94)
        : browOccludedByFringe
          ? mixRgb(brow, skinColor, 0.72)
          : brow,
    );
    put(
      face,
      inner,
      3,
      browStronglyOccludedByFringe
        ? mixRgb(brow, skinColor, 0.9)
        : browOccludedByFringe
          ? mixRgb(brow, skinColor, 0.58)
          : brow,
    );
    const baseScleraMix =
      style.eyeShape === "round"
        ? 0.36
        : style.eyeShape === "narrow"
          ? 0.12
          : 0.28;
    const irisScleraAdjustment =
      irisLightness === "dark" ? -0.08 : irisLightness === "light" ? 0.04 : 0;
    const largeEyeScleraBoost =
      eyeSize === "large" ? (style.eyeShape === "round" ? 0.1 : 0.02) : 0;
    const sclera = mixRgb(
      skinColor,
      [238, 232, 222],
      Math.max(
        0.08,
        Math.min(
          0.56,
          baseScleraMix +
            irisScleraAdjustment +
            largeEyeScleraBoost +
            (eyeSize === "small" ? -0.08 : 0),
        ),
      ),
    );
    // Both eye anchors stay on the same row. At 8x8 resolution, moving the
    // whole outer eye pixel up or down reads as a stray brow/cheek mark.
    // Direction is expressed by a smaller adjacent eyelid accent instead.
    const outerEye =
      eyeSize === "small"
        ? mixRgb(skinColor, eye, 0.2)
        : style.eyeShape === "narrow"
          ? mixRgb(sclera, eye, 0.46)
          : style.eyeShape === "almond" && eyeTilt === "level"
            ? mixRgb(sclera, eye, eyeSize === "large" ? 0.14 : 0.08)
            : eyeTilt === "level"
              ? sclera
              : mixRgb(sclera, eye, eyeSize === "large" ? 0.1 : 0.2);
    const iris = style.eyeShape === "narrow" ? shadeRgb(eye, 0.86) : eye;
    const litIris = shadeRgb(iris, inner < 4 ? 1.06 : 0.88);
    const litOuterEye = shadeRgb(outerEye, inner < 4 ? 1.02 : 0.99);
    put(face, outer, 4, litOuterEye);
    put(face, inner, 4, litIris);
    if (eyeTilt === "upturned") {
      put(face, outer, 3, mixRgb(eye, skinColor, 0.36));
    } else if (eyeTilt === "downturned") {
      put(face, outer, 5, mixRgb(eye, skinColor, 0.42));
    }
    if (eyeSize === "small") {
      // A single dark iris plus a skin-mixed corner is the smallest readable
      // eye at 8x8. Avoid a second row, which would make every eye look large.
    } else if (eyeSize === "large") {
      // Large eyes need a true two-row footprint, but a uniformly dark 2x2
      // block turns every photographed eye into the same round square. Keep
      // round eyes deep at the lower iris, taper almond/narrow eyes toward
      // skin, and move the darkest lower emphasis to the outer corner for a
      // downturned eye. This preserves both aperture size and directional
      // identity at 8x8.
      const lowerInner =
        style.eyeShape === "round"
          ? shadeRgb(eye, 0.76)
          : mixRgb(skinColor, eye, style.eyeShape === "almond" ? 0.62 : 0.46);
      const lowerOuterMix =
        eyeTilt === "downturned"
          ? style.eyeShape === "almond"
            ? 0.72
            : 0.58
          : style.eyeShape === "round"
            ? 0.22
            : style.eyeShape === "almond"
              ? 0.2
              : 0.18;
      put(face, inner, 5, lowerInner);
      put(face, outer, 5, mixRgb(skinColor, eye, lowerOuterMix));
    } else if (style.eyeShape === "round") {
      put(face, inner, 5, shadeRgb(eye, 0.78));
      if (eyeTilt !== "downturned") {
        put(face, outer, 5, mixRgb(skinColor, eye, 0.18));
      }
    } else if (style.eyeShape === "almond") {
      // A muted lower-inner taper distinguishes almond eyes from a one-pixel
      // narrow line without turning them into the two-pixel-tall round shape.
      put(face, inner, 5, mixRgb(skinColor, eye, 0.28));
    }
  }
  const browAccent =
    style.eyebrowThickness === "thin"
      ? mixRgb(brow, skinColor, 0.26)
      : shadeRgb(brow, 0.96);
  const browShadow = shadeRgb(brow, 0.74);
  const [[leftOuter, leftInner], [rightOuter, rightInner]] = eyePairs;
  if (!browStronglyOccludedByFringe && eyebrowShape === "arched") {
    put(face, leftInner, 2, browAccent);
    put(face, rightOuter, 2, browAccent);
    put(overlay, leftOuter, 3, shadeRgb(brow, 0.9));
    put(overlay, rightInner, 3, shadeRgb(brow, 0.9));
  } else if (!browStronglyOccludedByFringe && eyebrowShape === "slanted") {
    put(face, leftOuter, 2, browAccent);
    put(face, rightInner, 2, browAccent);
    put(overlay, leftInner, 3, browShadow);
    put(overlay, rightOuter, 3, browShadow);
  } else if (!browStronglyOccludedByFringe && eyebrowShape === "soft") {
    const softBrow = mixRgb(brow, skinColor, 0.48);
    for (const [outer, inner] of eyePairs) {
      put(face, outer, 3, softBrow);
      put(face, inner, 3, mixRgb(softBrow, brow, 0.22));
    }
  } else if (
    !browStronglyOccludedByFringe &&
    style.eyebrowThickness === "thick"
  ) {
    put(face, leftOuter, 2, browAccent);
    put(face, rightInner, 2, browAccent);
  }

  const skinShadow = shadeRgb(skinColor, faceContrastBoost ? 0.72 : 0.82);
  // A whole overlay pixel is the smallest possible catchlight at 8x8. Mixing
  // it too far toward white hid the dark iris underneath, so generated faces
  // looked blank in the 3D preview. Keep the overlay visibly eye-coloured.
  const eyeHighlight = mixRgb(
    eye,
    [250, 244, 232],
    irisLightness === "dark" ? 0.12 : irisLightness === "light" ? 0.32 : 0.22,
  );
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
  // Close-set eyes use x=2 and x=4 as their two iris anchors, leaving only
  // x=3 for the bridge. The former generic x=4 prominent/long nose placement
  // repainted the right iris with a bright skin pixel and made the final face
  // visibly one-eyed despite a correct analysis result.
  const noseX =
    style.eyeSpacing === "close"
      ? 3
      : style.faceShape === "long" || noseShape === "prominent"
        ? 4
        : 3;
  const noseBridge = mixRgb(skinColor, [255, 238, 224], 0.24);
  const noseSide = shadeRgb(skinColor, faceContrastBoost ? 0.82 : 0.9);

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
    if (style.eyeSpacing !== "close") {
      put(face, noseX === 3 ? 4 : 3, 5, mixRgb(noseSide, skinColor, 0.24));
    }
    put(face, noseX, 4, mixRgb(noseBridge, skinColor, 0.38));
  } else {
    put(face, noseX, 4, shadeRgb(noseBridge, 1.04));
    put(face, noseX, 5, shadeRgb(skinShadow, 0.92));
    if (style.eyeSpacing !== "close") {
      put(face, noseX === 3 ? 4 : 3, 5, shadeRgb(noseSide, 0.86));
    }
    put(face, noseX, 3, mixRgb(noseBridge, skinColor, 0.28));
  }

  const mouthShape = style.mouthShape ?? "small";
  const mouthOpening = style.mouthOpening ?? "closed";
  const lipFullness =
    style.lipFullness ??
    (mouthShape === "full"
      ? "full"
      : mouthShape === "thin"
        ? "thin"
        : "average");
  const lipColor = style.lipColor ?? "natural";
  const lipPigment: Record<NonNullable<FaceStyle["lipColor"]>, Rgb> = {
    natural: [160, 74, 60],
    rose: [181, 92, 108],
    red: [196, 54, 60],
    berry: [139, 54, 91],
    brown: [133, 77, 62],
    coral: [207, 96, 78],
  };
  const baseMouthColor =
    lipColor === "natural"
      ? mixRgb(shadeRgb(skinColor, 0.62), lipPigment.natural, 0.5)
      : mixRgb(shadeRgb(skinColor, 0.7), lipPigment[lipColor], 0.72);
  const unboostedMouthColor =
    style.expression === "smile"
      ? mixRgb(baseMouthColor, [196, 92, 104], 0.5)
      : lipFullness === "full"
        ? mixRgb(baseMouthColor, [184, 78, 78], 0.34)
        : lipFullness === "thin"
          ? mixRgb(baseMouthColor, skinColor, 0.24)
          : baseMouthColor;
  const mouthColor = faceContrastBoost
    ? shadeRgb(unboostedMouthColor, 0.88)
    : unboostedMouthColor;
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
    const smiling = style.expression === "smile";
    const teethVisible = mouthOpening === "teeth_visible";
    const slightlyOpen = mouthOpening === "slightly_open";
    const teeth = mixRgb([246, 239, 218], skinColor, 0.12);
    put(face, 2, 6, smiling ? shadeRgb(mouthColor, 1.1) : mouthDark);
    put(
      face,
      3,
      6,
      teethVisible
        ? teeth
        : slightlyOpen
          ? mouthDark
          : lipFullness === "full"
            ? lipFull
            : mouthColor,
    );
    put(
      face,
      4,
      6,
      teethVisible
        ? mixRgb(mouthColor, teeth, 0.58)
        : slightlyOpen
          ? shadeRgb(mouthDark, 0.82)
          : lipFullness === "full"
            ? lipLight
            : shadeRgb(mouthColor, 0.92),
    );
    put(face, 5, 6, smiling ? shadeRgb(mouthColor, 1.1) : mouthDark);
    if (teethVisible) {
      // A broad photographed grin needs a readable tooth row and raised
      // corners at 8x8. Keep the visible tooth cue compact and lift the dark
      // corners one row above it; a broad horizontal white bar reads as an
      // aggressive or sharp-toothed grimace.
      const smileCorner = mixRgb(mouthColor, skinColor, 0.5);
      put(face, 2, 5, smileCorner);
      put(face, 5, 5, shadeRgb(smileCorner, 0.96));
      put(face, 2, 6, mixRgb(mouthColor, skinColor, 0.42));
      for (let x = 3; x <= 4; x++) {
        const softenedTeeth = mixRgb(teeth, skinColor, x === 3 ? 0.08 : 0.2);
        put(face, x, 6, softenedTeeth);
      }
      put(face, 5, 6, mixRgb(mouthColor, skinColor, 0.46));
      put(face, 3, 7, mixRgb(mouthColor, skinColor, 0.32));
      put(face, 4, 7, mixRgb(mouthDark, skinColor, 0.4));
    } else if (slightlyOpen) {
      put(face, 3, 7, mixRgb(lipFull, skinColor, 0.3));
      put(face, 4, 7, mixRgb(lipLight, skinColor, 0.36));
    }
  } else if (mouthShape === "full" || lipFullness === "full") {
    put(face, 3, 6, lipFull);
    put(face, 4, 6, shadeRgb(lipLight, 0.94));
  } else if (
    mouthShape === "thin" ||
    lipFullness === "thin" ||
    style.expression === "serious"
  ) {
    put(face, 3, 6, shadeRgb(mouthDark, 1.04));
    put(face, 4, 6, shadeRgb(mouthDark, 0.86));
    if (mouthShape === "thin" && style.expression === "smile") {
      put(overlay, 2, 6, mixRgb(mouthDark, skinColor, 0.35));
      put(overlay, 5, 6, mixRgb(mouthDark, skinColor, 0.35));
    }
  } else {
    put(face, 3, 6, mouthDark);
    put(face, 4, 6, mixRgb(mouthColor, skinColor, 0.36));
  }

  if (style.matureFeatures) {
    const expressionLine = shadeRgb(skinColor, 0.6);
    const softLine = mixRgb(expressionLine, skinColor, 0.22);
    put(face, 0, 3, softLine);
    put(face, 7, 3, shadeRgb(softLine, 0.96));
    put(face, 0, 4, softLine);
    put(face, 7, 4, shadeRgb(softLine, 0.96));
    put(face, 0, 5, expressionLine);
    put(face, 7, 5, shadeRgb(expressionLine, 0.94));
    put(face, 1, 5, expressionLine);
    put(face, 6, 5, shadeRgb(expressionLine, 0.94));
    put(face, 1, 6, softLine);
    put(face, 6, 6, shadeRgb(softLine, 0.92));
  }
  if (style.faceShape === "angular" || style.jawShape === "square") {
    put(face, 0, 5, shadeRgb(skinColor, 0.7));
    put(face, 7, 5, shadeRgb(skinColor, 0.66));
    put(face, 1, 6, shadeRgb(skinColor, 0.76));
    put(face, 6, 6, shadeRgb(skinColor, 0.72));
    put(face, 2, 7, shadeRgb(skinColor, 0.84));
    put(face, 5, 7, shadeRgb(skinColor, 0.8));
    put(face, 3, 7, shadeRgb(skinColor, 0.98));
    put(face, 4, 7, shadeRgb(skinColor, 0.94));
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
    const contourPair = (x: number, y: number, shade: number) => {
      put(face, x, y, shadeRgb(skinColor, shade));
      put(face, 7 - x, y, shadeRgb(skinColor, shade * 0.98));
    };
    // faceShape controls the broad cheek-to-chin route; jawShape below adds
    // the local corner or chin treatment. Keeping them independent prevents
    // angular and square analyses from collapsing into the same 8x8 face.
    if (style.faceShape === "round") {
      contourPair(0, 6, 0.92);
      contourPair(0, 7, 0.84);
      contourPair(1, 7, 0.94);
    } else if (style.faceShape === "oval") {
      contourPair(0, 6, 0.86);
      contourPair(0, 7, 0.78);
      contourPair(1, 7, 0.87);
    } else if (style.faceShape === "long") {
      contourPair(0, 6, 0.78);
      contourPair(1, 6, 0.86);
      contourPair(0, 7, 0.7);
      contourPair(1, 7, 0.81);
    } else if (style.faceShape === "angular") {
      contourPair(0, 6, 0.87);
      contourPair(1, 6, 0.8);
      contourPair(0, 7, 0.72);
      contourPair(1, 7, 0.83);
      contourPair(2, 7, 0.9);
    } else if (style.faceShape === "square") {
      contourPair(0, 6, 0.79);
      contourPair(1, 6, 0.84);
      contourPair(0, 7, 0.75);
      contourPair(1, 7, 0.76);
      contourPair(2, 7, 0.84);
    }

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
      if (mouthOpening === "teeth_visible") {
        const teeth = mixRgb([246, 239, 218], skinColor, 0.12);
        const smileCorner = mixRgb(mouthColor, skinColor, 0.5);
        put(overlay, 2, 5, smileCorner);
        put(overlay, 5, 5, shadeRgb(smileCorner, 0.96));
        put(overlay, 2, 6, mixRgb(mouthCorner, skinColor, 0.48));
        for (let x = 3; x <= 4; x++) {
          const softenedTeeth = mixRgb(teeth, skinColor, x === 3 ? 0.08 : 0.2);
          put(overlay, x, 6, softenedTeeth);
        }
        put(overlay, 5, 6, mixRgb(mouthCorner, skinColor, 0.5));
      } else if (mouthOpening === "slightly_open") {
        put(overlay, 3, 6, mouthDark);
        put(overlay, 4, 6, shadeRgb(mouthDark, 0.82));
      } else {
        put(overlay, 3, 6, mixRgb(mouthColor, skinColor, 0.2));
        put(overlay, 4, 6, mixRgb(mouthColor, skinColor, 0.28));
      }
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
    const mirror = style.hairPart === "left";
    const px = (x: number) => (mirror ? 7 - x : x);
    fringe([0, 2, 4, 6].map(px), 1);
    fringe([0, 1, 3].map(px), 2);
  } else if (style.bangs === "curtain") {
    fringe([0, 2, 5, 7], 1);
    fringe([1, 6], 2);
  } else if (style.bangs === "wispy") {
    fringe([1, 4, 7], 1);
    fringe([2, 5], 2);
  }
}

/**
 * Keep the two base-layer irises visible after hair and accessories have been
 * composed onto the larger head overlay cube. At 8x8, one opaque hair pixel
 * over an iris removes the entire eye in the 3D viewer; colour contrast alone
 * cannot recover it. Glasses are excluded because their visible frame
 * intentionally occupies the eye row; bangs keep their surrounding pixels.
 */
function preserveFaceReadability(
  atlas: RawImage,
  style: FaceStyle,
  hairColor: Rgb,
): void {
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
  // scale that merged with the fringe and made the face look eyeless. Tilt now
  // keeps both anchors on row 4 and uses a neighboring base-layer accent, so
  // open that optional accent position through a dense fringe as well.
  const tiltAccentY =
    style.eyeTilt === "upturned"
      ? 3
      : style.eyeTilt === "downturned"
        ? 5
        : null;
  const eyeLengthCurtainFringe =
    style.bangs === "curtain" && style.bangsLength === "eye";
  const curtainOuterCorners = new Set<number>();
  if (eyeLengthCurtainFringe) {
    // Keep the iris openings readable, but let the photographed curtain
    // fringe overlap an outer eye corner. Clearing all four eye-row pixels
    // made eye-length bangs indistinguishable from brow-length bangs in 3D.
    // A side part keeps only its heavier side; a centred/unspecified curtain
    // naturally frames both outer corners.
    if (style.hairPart === "left") {
      curtainOuterCorners.add(eyePairs[1][0]);
    } else if (style.hairPart === "right") {
      curtainOuterCorners.add(eyePairs[0][0]);
    } else {
      curtainOuterCorners.add(eyePairs[0][0]);
      curtainOuterCorners.add(eyePairs[1][0]);
    }
  }
  for (const [outer, inner] of eyePairs) {
    clearOverlayPixel(inner, 4);
    if (!curtainOuterCorners.has(outer)) clearOverlayPixel(outer, 4);
    if (tiltAccentY !== null) {
      clearOverlayPixel(outer, tiltAccentY);
    }
    if (style.eyeSize === "large") {
      clearOverlayPixel(outer, 5);
      clearOverlayPixel(inner, 5);
    }
  }

  const longFaceFramingHair =
    style.sideHairShape === "face_framing" &&
    (style.sideHairLength === "jaw" || style.sideHairLength === "shoulder");
  if (longFaceFramingHair) {
    // Long locks belong on the extreme edge of the enlarged head cube. When
    // their inner columns remain opaque below the eyes, the visible face
    // collapses into a narrow vertical strip even though both irises pass the
    // quality gate. Open a continuous cheek-to-jaw window while keeping x=0
    // and x=7 as the two dimensional face-framing locks.
    for (const y of [5, 6]) {
      clearOverlayPixel(1, y);
      clearOverlayPixel(6, y);
    }
    clearOverlayPixel(2, 6);
    clearOverlayPixel(5, 6);

    // Use the last row of the raised face-framing layer as a real jaw mask.
    // Previously every oval/soft face cleared the same six-pixel opening, so
    // a pointed chin and a broad square jaw became identical once long side
    // hair covered the base cube. Keep each opening contiguous: broad jaws
    // expose six pixels, soft/oval jaws taper to four, and pointed jaws leave
    // the two centre pixels visible without isolated skin cells behind hair.
    const jawShape =
      style.jawShape ??
      (style.faceShape === "square" || style.faceShape === "angular"
        ? "square"
        : style.faceShape === "round"
          ? "rounded"
          : "soft");
    const broadJaw = jawShape === "square" || jawShape === "rounded";
    if (broadJaw) {
      for (const x of [1, 2, 5, 6]) clearOverlayPixel(x, 7);
    } else if (jawShape === "pointed") {
      for (const x of [2, 5]) {
        const d = ((overlay.y + 7) * ATLAS_SIZE + overlay.x + x) * 4;
        const color = shadeRgb(
          hairVolumePixel(hairColor, overlay.x + x, overlay.y + 7),
          x < 4 ? 0.82 : 0.76,
        );
        atlas.rgba[d] = color[0];
        atlas.rgba[d + 1] = color[1];
        atlas.rgba[d + 2] = color[2];
        atlas.rgba[d + 3] = 255;
      }
    } else {
      clearOverlayPixel(2, 7);
      clearOverlayPixel(5, 7);
    }
  }
}

/**
 * Facial shading belongs on the inner head cube. Skin-coloured pixels on the
 * outer cube protrude in the 3D viewer and turn the eyes, nose, mouth and jaw
 * into a noisy mosaic. Clear those temporary portrait details before the hair
 * pass rebuilds the outer layer with genuine fringe and temple pixels.
 */
function resetPortraitFaceOverlay(atlas: RawImage): void {
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

/**
 * Draw glasses as a genuine second-layer accessory after temporary portrait
 * pixels have been cleared. This keeps the frame raised without also raising
 * the mouth, cheeks and chin. Hair is composed afterwards so photographed
 * bangs can naturally occlude the frame while the side-hair pass restores the
 * visible temple arms where appropriate.
 */
function composeGlassesOverlay(atlas: RawImage, style: FaceStyle): void {
  if (style.glasses === "none") return;

  const overlay = CLASSIC_LAYOUT.head.overlay.front;
  const rim = hexToRgb(style.glassesColor, [34, 32, 30]);
  const rimHighlight = mixRgb(
    rim,
    [224, 222, 216],
    style.glassesScale === "large" ? 0.24 : 0.14,
  );
  const lens = style.glasses === "sunglasses" ? shadeRgb(rim, 0.55) : null;
  const put = (rect: Rect, x: number, y: number, color: Rgb) => {
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = color[0];
    atlas.rgba[d + 1] = color[1];
    atlas.rgba[d + 2] = color[2];
    atlas.rgba[d + 3] = 255;
  };
  const clear = (rect: Rect, x: number, y: number) => {
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[d] = 0;
    atlas.rgba[d + 1] = 0;
    atlas.rgba[d + 2] = 0;
    atlas.rgba[d + 3] = 0;
  };

  // Round frames are centred on Minecraft's two canonical eye pixels (2, 5).
  // Regular rectangular frames retain the established wider placement.
  const frameStarts = style.glasses === "round" ? [1, 4] : [0, 5];
  for (const x0 of frameStarts) {
    // Prescription lenses remain transparent. This matters when prominent
    // frames are reasserted after hair/headwear: clearing the two-pixel lens
    // window prevents an older hair pixel from hiding the eye underneath.
    if (!lens) {
      clear(overlay, x0 + 1, 3);
      clear(overlay, x0 + 1, 4);
    }
    if (style.glasses === "round") {
      const outerSide = x0 < 4 ? x0 : x0 + 2;
      const innerSide = x0 < 4 ? x0 + 2 : x0;
      put(overlay, x0 + 1, 2, rimHighlight);
      // One diagonal corner on each row turns the sparse six-pixel outline
      // into a readable oval at preview scale without covering the iris.
      put(overlay, x0 < 4 ? x0 : x0 + 2, 2, rimHighlight);
      put(overlay, outerSide, 3, rimHighlight);
      put(overlay, innerSide, 3, rim);
      put(overlay, outerSide, 4, rimHighlight);
      put(overlay, innerSide, 4, rim);
      put(overlay, x0 + 1, 5, rim);
      put(overlay, x0 < 4 ? x0 + 2 : x0, 5, rim);
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
  if (style.glassesScale === "large") put(overlay, 3, 3, rimHighlight);
  put(CLASSIC_LAYOUT.head.overlay.right, 7, 3, rim);
  put(CLASSIC_LAYOUT.head.overlay.right, 6, 3, rim);
  put(CLASSIC_LAYOUT.head.overlay.left, 0, 3, rim);
  put(CLASSIC_LAYOUT.head.overlay.left, 1, 3, rim);
  if (style.glassesScale === "large") {
    put(CLASSIC_LAYOUT.head.overlay.right, 7, 4, rimHighlight);
    put(CLASSIC_LAYOUT.head.overlay.right, 6, 4, rim);
    put(CLASSIC_LAYOUT.head.overlay.left, 0, 4, rimHighlight);
    put(CLASSIC_LAYOUT.head.overlay.left, 1, 4, rim);
  }
}

/** Small but high-salience earrings authored on the head outer layer. */
function composeEarrings(atlas: RawImage, style: FaceStyle): void {
  const earring = style.earrings ?? "none";
  if (earring === "none") return;
  const color = hexToRgb(style.earringColor ?? "", [62, 176, 169]);
  const highlight = mixRgb(color, [255, 255, 255], 0.28);
  const shadow = shadeRgb(color, 0.7);
  const put = (rect: Rect, x: number, y: number, value: Rgb) => {
    if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return;
    const offset = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    atlas.rgba[offset] = value[0];
    atlas.rgba[offset + 1] = value[1];
    atlas.rgba[offset + 2] = value[2];
    atlas.rgba[offset + 3] = 255;
  };
  const paint = (frontX: number, side: Rect, sideX: number) => {
    const front = CLASSIC_LAYOUT.head.overlay.front;
    if (earring === "stud") {
      put(front, frontX, 6, highlight);
      put(side, sideX, 6, highlight);
      return;
    }
    if (earring === "hoop") {
      put(front, frontX, 5, highlight);
      put(front, frontX, 7, color);
      put(side, sideX, 5, highlight);
      put(side, sideX, 7, color);
      return;
    }
    // Drop and teardrop silhouettes need a connected 1x2 vertical cluster;
    // teardrops use the darker lower pixel to read as a weighted pendant.
    put(front, frontX, 6, highlight);
    put(front, frontX, 7, earring === "teardrop" ? shadow : color);
    put(side, sideX, 6, highlight);
    put(side, sideX, 7, earring === "teardrop" ? shadow : color);
  };

  const side = style.earringSide ?? "both";
  if (side === "both" || side === "viewer_left") {
    paint(0, CLASSIC_LAYOUT.head.overlay.right, 7);
  }
  if (side === "both" || side === "viewer_right") {
    paint(7, CLASSIC_LAYOUT.head.overlay.left, 0);
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
export function hairVolumePixel(color: Rgb, gx: number, gy: number): Rgb {
  // Shade in small connected clusters instead of hashing every pixel
  // independently. The surrounding silhouette/strand passes already add
  // single-pixel accents; a stable 2x2 ramp underneath reads like deliberate
  // Minecraft pixel art rather than salt-and-pepper image-model noise.
  const clusterX = Math.floor(gx / 2);
  const clusterY = Math.floor(gy / 2);
  const hash = ((clusterX * 83492791) ^ (clusterY * 2971215073)) >>> 0;
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
  const readColor = (rect: Rect, x: number, y: number): Rgb | null => {
    if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return null;
    const d = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    return atlas.rgba[d + 3] >= 128
      ? [atlas.rgba[d], atlas.rgba[d + 1], atlas.rgba[d + 2]]
      : null;
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
  if (
    (s === "curly" || style.hairTexture === "curly") &&
    (sideHairShape === "face_framing" || sideHairShape === "flared")
  ) {
    const paintCurlySideRow = (
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
          putColor(rect, x, y, shadeRgb(skinColor, isFarHalf ? 0.87 : 0.92));
        }
      }
    };
    // Curly volume surrounds a visible profile; it must not turn the inner
    // head cube into an opaque hair block. Keep crown/back mass and a narrow
    // front ringlet while opening the eye, cheek and ear area on both sides.
    fill(base.right, 0, 0, 8, Math.min(3, sideRows));
    fill(base.left, 0, 0, 8, Math.min(3, sideRows));
    const rightRows = [
      [0, 1, 2, 7],
      [0, 1, 7],
      [0, 1, 2, 7],
      [0, 1, 7],
      [0, 7],
    ] as const;
    for (let y = 3; y < Math.min(base.right.h, sideRows); y++) {
      const hairXs = rightRows[Math.min(rightRows.length - 1, y - 3)];
      paintCurlySideRow(base.right, y, hairXs, false);
      paintCurlySideRow(
        base.left,
        y,
        hairXs.map((x) => 7 - x),
        true,
      );
    }
  } else if (
    s === "long" &&
    (sideHairShape === "face_framing" || sideHairShape === "flared")
  ) {
    const paintLongSideRow = (
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
    // Long face-framing or flared hair still exposes a cheek/profile window
    // on the inner head cube. Filling all 8x8 side pixels produces a
    // rectangular helmet that no sparse second-layer silhouette can correct.
    fill(base.right, 0, 0, 8, 3);
    fill(base.left, 0, 0, 8, 3);
    const rightRows =
      sideHairShape === "flared"
        ? ([
            [0, 1, 2, 6, 7],
            [0, 1, 2, 6, 7],
            [0, 1, 2, 6, 7],
            [0, 1, 7],
            [0, 7],
          ] as const)
        : ([
            [0, 1, 2, 3, 7],
            [0, 1, 2, 7],
            [0, 1, 2, 7],
            [0, 1, 7],
            [0, 1, 7],
          ] as const);
    for (let row = 0; row < rightRows.length; row++) {
      const y = row + 3;
      const rightXs = rightRows[row];
      paintLongSideRow(base.right, y, rightXs, false);
      paintLongSideRow(
        base.left,
        y,
        rightXs.map((x) => 7 - x),
        true,
      );
    }
  } else if (roundedFringeCut) {
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
    } else if (sideHairShape === "tapered") {
      // A tapered short cut must narrow on the inner cube as well as on the
      // outer layer. Leaving the first three rows solid makes transparent
      // overlay cut-outs reveal a square hair cap instead of the ear/temple
      // contour inferred from the portrait.
      fill(base.right, 0, 0, 8, Math.max(0, sideRows - 2));
      fill(base.left, 0, 0, 8, Math.max(0, sideRows - 2));
      paintSideRow(base.right, sideRows - 2, [0, 1, 2, 5, 6, 7], false);
      paintSideRow(base.left, sideRows - 2, [0, 1, 2, 5, 6, 7], true);
      paintSideRow(base.right, sideRows - 1, [0, 1, 6, 7], false);
      paintSideRow(base.left, sideRows - 1, [0, 1, 6, 7], true);
      if (earExposure === "partial" && sideRows < base.right.h) {
        paintSideRow(base.right, sideRows, [0, 7], false);
        paintSideRow(base.left, sideRows, [0, 7], true);
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
  // A generated rear view is useful for luminance variation, but image
  // models can shift the same person's hair hue between views. Long hair
  // covers the whole rear head, so keep only the sampled light/dark pattern
  // while anchoring every pixel to the analysed hair colour.
  const fullRearHair =
    s === "long" ||
    s === "twintails" ||
    s === "afro" ||
    style.hairBackShape === "long";
  const anchoredBackHair = (x: number, y: number): Rgb => {
    const offset = ((base.back.y + y) * ATLAS_SIZE + base.back.x + x) * 4;
    const sampledLuminance =
      atlas.rgba[offset] * 0.299 +
      atlas.rgba[offset + 1] * 0.587 +
      atlas.rgba[offset + 2] * 0.114;
    const luminanceShade = Math.max(
      0.62,
      Math.min(1.12, sampledLuminance / 145),
    );
    return shadeRgb(
      hairPixel(hairColor, base.back.x + x, base.back.y + y, jitter),
      luminanceShade,
    );
  };
  if (fullRearHair) {
    for (let y = 0; y < backRows; y++) {
      for (let x = 0; x < base.back.w; x++) {
        putColor(base.back, x, y, anchoredBackHair(x, y));
      }
    }
  } else {
    // A generated rear guide may leave its blue/white studio background in
    // the uncovered nape rows. Reconstruct compact rear hair from its analysed
    // colour and explicitly paint the exposed skin instead of trusting those
    // unseen/background pixels.
    for (let y = 0; y < backRows; y++) {
      for (let x = 0; x < base.back.w; x++) {
        const taperedSkinEdge =
          roundedFringeCut && y === backRows - 1 && (x < 2 || x > 5);
        putColor(
          base.back,
          x,
          y,
          taperedSkinEdge
            ? shadeRgb(skinColor, x < 4 ? 0.84 : 0.82)
            : anchoredBackHair(x, y),
        );
      }
    }
    for (let y = backRows; y < base.back.h; y++) {
      const rowShade = 0.88 - (y - backRows) * 0.025;
      for (let x = 0; x < base.back.w; x++) {
        const sideShade = x === 0 || x === base.back.w - 1 ? 0.96 : 1;
        putColor(base.back, x, y, shadeRgb(skinColor, rowShade * sideShade));
      }
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
  const overallHairLength = resolveOverallHairLength(style);
  const torsoHairRows = hairBodyRows(style);
  if (
    sideHairShape === "face_framing" &&
    (sideHairLength === "cheek" ||
      sideHairLength === "jaw" ||
      sideHairLength === "shoulder")
  ) {
    const lastBaseLockRow =
      sideHairLength === "cheek" ? 4 : sideHairLength === "jaw" ? 6 : 7;
    const heavyViewerSide =
      hairPart === "right" ? "left" : hairPart === "left" ? "right" : "both";
    const baseLockColor = (seed: number, y: number, shade: number) =>
      shadeRgb(hairVolumePixel(hairColor, seed, base.front.y + y), shade);

    // A long style needs mass on the inner cube as well as raised strands.
    // Leaving the base face skin-coloured from x=1..6 made the exact front
    // view read as the same wide square face for every portrait, even when
    // the analysis specified an oval/pointed face framed by long curtain
    // locks. Two connected temple columns narrow the cheek silhouette while
    // preserving the iris anchors at x=2 and x=5. They taper back to one edge
    // pixel at the jaw so the result is not another rectangular hair frame.
    for (let y = 3; y <= lastBaseLockRow; y++) {
      const leftEdge = baseLockColor(3109 + y, y, y >= 6 ? 0.72 : 0.88);
      const rightEdge = baseLockColor(3527 + y, y, y >= 6 ? 0.68 : 0.84);
      putColor(base.front, 0, y, leftEdge);
      putColor(base.right, base.right.w - 1, y, leftEdge);
      putColor(base.front, base.front.w - 1, y, rightEdge);
      putColor(base.left, 0, y, rightEdge);

      const sharedCheekMass = y <= 5;
      const leftHeavyTaper =
        y === 6 &&
        sideHairLength !== "cheek" &&
        (heavyViewerSide === "left" || heavyViewerSide === "both");
      const rightHeavyTaper =
        y === 6 &&
        sideHairLength !== "cheek" &&
        (heavyViewerSide === "right" || heavyViewerSide === "both");
      if (sharedCheekMass || leftHeavyTaper) {
        putColor(base.front, 1, y, shadeRgb(leftEdge, y >= 5 ? 0.82 : 0.94));
      }
      if (sharedCheekMass || rightHeavyTaper) {
        putColor(
          base.front,
          base.front.w - 2,
          y,
          shadeRgb(rightEdge, y >= 5 ? 0.8 : 0.92),
        );
      }
    }
  }
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
    if (torsoHairRows > 0) {
      const bodyOver = CLASSIC_LAYOUT.body.overlay;
      const bodyBase = CLASSIC_LAYOUT.body.base;
      const bodyHair = (rect: Rect, x: number, y: number, shade = 1) =>
        shadeRgb(hairVolumePixel(hairColor, rect.x + x, rect.y + y), shade);
      const torsoStrandLight = mixRgb(
        hairColor,
        [242, 226, 214],
        style.hairTexture === "wavy" ? 0.24 : 0.16,
      );
      // Long locks occupy only one or two pixels in width. Very deep shadow
      // values made those sparse paths read as black rigid rods against a
      // pastel cardigan, even when the analysed hair was medium brown. Keep
      // enough value range for depth while preserving the declared hair hue.
      const torsoStrandDark = shadeRgb(hairColor, 0.7);
      const leftFrontPath = [1, 1, 0, 1, 1, 0, 0, 1, 2, 1, 2, 2] as const;
      const organicFrontDrape =
        style.hairTexture === "wavy" ||
        style.hairTexture === "curly" ||
        style.hairSilhouette === "tousled";
      // Straight hair can keep a tidy mirrored fall. Wavy/curly locks need a
      // one-row phase offset on one side; exact mirroring made the two front
      // locks read as rigid parallel columns even when their colours varied.
      // Both paths still finish at x=2/x=5: converging at x=3/x=4 fused the
      // waist-length tips into one central outer-layer plate.
      const rightFrontPath = organicFrontDrape
        ? ([6, 7, 7, 6, 7, 7, 7, 6, 5, 5, 5, 5] as const)
        : ([6, 6, 7, 6, 6, 7, 7, 6, 5, 6, 5, 5] as const);
      for (let y = 0; y < Math.min(torsoHairRows, leftFrontPath.length); y++) {
        const taperShade =
          y >= 10 ? 0.72 : y >= 8 ? 0.76 : y >= 6 ? 0.82 : 0.96;
        const leftX = leftFrontPath[y];
        const rightX = rightFrontPath[y];
        // The continuous lock mass belongs to the inner cube. Keeping the
        // whole path on the enlarged layer made two long locks look like
        // rigid brown columns hovering in front of the cardigan. The outer
        // cube below now carries only separated highlights, bends and tips.
        putColor(
          bodyBase.front,
          leftX,
          y,
          bodyHair(bodyBase.front, leftX, y, taperShade),
        );
        putColor(
          bodyBase.front,
          rightX,
          y,
          bodyHair(bodyBase.front, rightX, y, taperShade * 0.98),
        );

        // The inner mass is two pixels wide for only the first three shoulder
        // rows, then immediately narrows. Volume lower down is expressed by
        // the sparse outer-layer clusters rather than a second solid rail.
        if (y <= 2) {
          const leftInner = Math.min(bodyBase.front.w - 1, leftX + 1);
          const rightInner = Math.max(0, rightX - 1);
          putColor(
            bodyBase.front,
            leftInner,
            y,
            bodyHair(bodyBase.front, leftInner, y, taperShade * 0.78),
          );
          putColor(
            bodyBase.front,
            rightInner,
            y,
            bodyHair(bodyBase.front, rightInner, y, taperShade * 0.78),
          );
        }

        // Turn any edge-reaching base strand onto the physically adjacent
        // profile face. This keeps the thinner mass continuous without asking
        // the outer-layer seam reconciler to inflate it again.
        if (leftX === 0) {
          const edge = readColor(bodyBase.front, 0, y);
          if (edge) putColor(bodyBase.right, bodyBase.right.w - 1, y, edge);
        }
        if (rightX === bodyBase.front.w - 1) {
          const edge = readColor(bodyBase.front, rightX, y);
          if (edge) putColor(bodyBase.left, 0, y, edge);
        }
      }
      for (const [x, y, color] of (
        [
          [1, 1, torsoStrandLight],
          [0, 3, shadeRgb(torsoStrandLight, 0.86)],
          [1, 6, torsoStrandDark],
          [2, 8, shadeRgb(torsoStrandDark, 0.82)],
          [6, 1, shadeRgb(torsoStrandLight, 0.94)],
          [7, 4, shadeRgb(torsoStrandLight, 0.8)],
          [6, 6, torsoStrandDark],
          [5, 9, shadeRgb(torsoStrandDark, 0.78)],
          [2, 10, shadeRgb(torsoStrandLight, 0.66)],
          [5, 11, shadeRgb(torsoStrandDark, 0.68)],
        ] as const
      ).filter(([, y]) => y < torsoHairRows)) {
        putColor(bodyOver.front, x, y, color);
      }

      const leftSideRows = [
        [0, 1],
        [0, 1],
        [0],
        [0, 1],
        [1],
        [1],
        [0, 1],
        [0],
        [0, 1],
        [1],
        [1, 2],
        [2],
      ] as const;
      for (let y = 0; y < Math.min(torsoHairRows, leftSideRows.length); y++) {
        const shade = y >= 10 ? 0.7 : y >= 8 ? 0.74 : y >= 6 ? 0.78 : 0.86;
        for (const x of leftSideRows[y]) {
          putColor(
            bodyBase.right,
            x,
            y,
            bodyHair(bodyBase.right, x, y, x === 0 ? shade : shade * 0.84),
          );
          const mirroredX = bodyBase.left.w - 1 - x;
          putColor(
            bodyBase.left,
            mirroredX,
            y,
            bodyHair(
              bodyBase.left,
              mirroredX,
              y,
              x === 0 ? shade * 0.98 : shade * 0.82,
            ),
          );
        }
      }
      if (torsoHairRows > 3) {
        putColor(bodyOver.right, 1, 3, shadeRgb(torsoStrandLight, 0.82));
        putColor(bodyOver.left, 2, 3, shadeRgb(torsoStrandLight, 0.82));
      }
      if (torsoHairRows > 8) {
        putColor(bodyOver.right, 0, 8, torsoStrandDark);
        putColor(bodyOver.left, 3, 8, torsoStrandDark);
      }

      const longBackBaseRows = [
        [0, 1, 2, 3, 4, 5, 6, 7],
        [0, 1, 2, 3, 4, 5, 6, 7],
        [1, 2, 3, 4, 5, 6],
        [1, 2, 3, 4, 5, 6],
        [1, 2, 3, 4, 5],
        [2, 3, 4, 5, 6],
        [1, 2, 3, 4, 5, 6],
        [1, 2, 3, 4, 5],
        [2, 3, 4, 5, 6],
        [2, 3, 4, 5],
        [2, 3, 4],
        [3, 4],
      ] as const;
      const longBackOuterRows = [
        [0, 1, 6, 7],
        [2],
        [3],
        [2],
        [2],
        [4],
        [1],
        [3, 4],
        [2, 4],
        [2, 5],
        [3],
        [3, 4],
      ] as const;
      const compactBackRows = [
        [0, 7],
        [0, 7],
        [0, 3, 4, 7],
        [0, 3, 4, 7],
        [0, 2, 5, 7],
        [0, 2, 5, 7],
        [0, 3, 4, 7],
        [0, 3, 4, 7],
      ] as const;
      if (hairBackShape === "long") {
        // A handcrafted long-hair back uses the torso base for a connected,
        // tapered mass and reserves the raised layer for sparse shade ribbons.
        // Keep the first two shoulder rows broad, then expose alternating
        // garment margins so waist-length hair does not become another flat
        // 8x8 rectangle. Every successive row still overlaps the previous one,
        // preserving one continuous rear flow into the two-pixel tip.
        for (let y = 0; y < Math.min(torsoHairRows, bodyBase.back.h); y++) {
          const baseRow: readonly number[] = longBackBaseRows[y] ?? [];
          for (let x = 0; x < bodyOver.back.w; x++)
            clearPixel(bodyOver.back, x, y);
          for (const x of baseRow) {
            const edge = x === 0 || x === bodyBase.back.w - 1;
            const highlight = x === 2 || x === 5;
            const shade =
              y >= 10
                ? highlight
                  ? 0.78
                  : 0.68
                : y >= 8
                  ? highlight
                    ? 0.86
                    : 0.74
                  : edge
                    ? 0.78
                    : highlight
                      ? 0.96
                      : 0.86;
            putColor(bodyBase.back, x, y, bodyHair(bodyBase.back, x, y, shade));
          }
          if (baseRow.includes(0)) {
            const edge = readColor(bodyBase.back, 0, y);
            if (edge) putColor(bodyBase.left, bodyBase.left.w - 1, y, edge);
          }
          if (baseRow.includes(bodyBase.back.w - 1)) {
            const edge = readColor(bodyBase.back, bodyBase.back.w - 1, y);
            if (edge) putColor(bodyBase.right, 0, y, edge);
          }
        }
      }
      const backRows = (
        hairBackShape === "long" ? longBackOuterRows : compactBackRows
      ).slice(0, torsoHairRows);
      for (let y = 0; y < backRows.length; y++) {
        for (const x of backRows[y]) {
          const edge = x === 0 || x === bodyOver.back.w - 1;
          const highlight = x === 2 || x === 5;
          const shade =
            y >= 8
              ? highlight
                ? 0.82
                : 0.72
              : y >= 6
                ? highlight
                  ? 0.88
                  : 0.76
                : edge
                  ? 0.8
                  : highlight
                    ? 0.94
                    : 0.86;
          putColor(bodyOver.back, x, y, bodyHair(bodyOver.back, x, y, shade));
        }
      }
      for (const [x, y, color] of (
        [
          [2, 2, torsoStrandLight],
          [5, 5, shadeRgb(torsoStrandLight, 0.78)],
          [3, 8, shadeRgb(torsoStrandDark, 0.82)],
          [5, 9, torsoStrandDark],
          [2, 10, shadeRgb(torsoStrandLight, 0.64)],
          [4, 11, shadeRgb(torsoStrandDark, 0.7)],
        ] as const
      ).filter(([, y]) => y < torsoHairRows)) {
        putColor(bodyOver.back, x, y, color);
      }

      // Keep the sparse torso-side waves above, but make every occupied
      // front/back edge use the exact same colour on its adjacent side face.
      // Adding an opaque side core here overfilled the second layer while the
      // arm cube hides most of that surface in a true ninety-degree view.
      for (let y = 0; y < torsoHairRows; y++) {
        const rightFront = readColor(bodyOver.front, 0, y);
        const leftFront = readColor(bodyOver.front, bodyOver.front.w - 1, y);
        const rightBack = readColor(bodyOver.back, bodyOver.back.w - 1, y);
        const leftBack = readColor(bodyOver.back, 0, y);
        if (rightFront)
          putColor(bodyOver.right, bodyOver.right.w - 1, y, rightFront);
        if (leftFront) putColor(bodyOver.left, 0, y, leftFront);
        if (rightBack) putColor(bodyOver.right, 0, y, rightBack);
        if (leftBack) putColor(bodyOver.left, bodyOver.left.w - 1, y, leftBack);
      }

      const bodyTop = bodyOver.top;
      const topFrontY = Math.max(0, bodyTop.h - 1);
      const topBackY = 0;
      const topRows = [
        [0, 1, 2, 3, 4, 5, 6, 7],
        [0, 1, 2, 5, 6, 7],
        [0, 1, 6, 7],
        [0, 1, 6, 7],
      ] as const;
      for (let y = 0; y < bodyTop.h; y++) {
        const row = topRows[Math.min(topRows.length - 1, y)];
        for (const x of row) {
          const edgeShade =
            y === topFrontY ? 0.62 : y === topBackY ? 0.78 : 0.7;
          putColor(bodyTop, x, y, bodyHair(bodyTop, x, y, edgeShade));
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
        innerSideFace: Rect,
        outerSideFace: Rect,
        mirrorPhase: number,
      ) => {
        const topY = 0;
        const shoulderLastY = Math.min(
          torsoHairRows <= 4 ? 3 : 5,
          arm.front.h - 1,
        );
        // Hair can bridge onto the enlarged arm cube at the shoulder, but its
        // long endpoint belongs on the torso/back layers. Extending a solid
        // profile rail to the wrist made waist-length hair merge with the
        // sleeve into a dark rectangular side panel. Keep one staggered step
        // below the shoulder cluster, then continue the lock on the torso.
        const outerLastY = Math.min(shoulderLastY + 1, arm.front.h - 1);
        for (let y = 0; y <= outerLastY; y++) {
          // Keep the lower shoulder lock in the same value family as the
          // torso-side wave. A 0.58 factor turned medium-brown hair almost
          // black exactly where the body and arm cubes meet, so the side lock
          // looked cut in two when the model rotated.
          const shade =
            y >= 8
              ? 0.7
              : y >= 4
                ? Math.floor(y / 3) % 2 === mirrorPhase
                  ? 0.76
                  : 0.72
                : y === 0
                  ? 0.86
                  : y === 1
                    ? 0.82
                    : y === 2
                      ? 0.78
                      : 0.74;
          if (y <= shoulderLastY) {
            putColor(
              arm.front,
              innerX,
              y,
              armHair(arm.front, innerX, y, shade),
            );
          }
          // The inner rail visually joins the torso lock. Keep the far arm
          // column only at the shoulder plus one staggered wave step; filling
          // half of each arm front down to the elbow hid photographed sleeves
          // and made long hair look like a pair of dark armour panels.
          if (y <= shoulderLastY && (y <= 1 || y === 2 + mirrorPhase)) {
            putColor(
              arm.front,
              outerX,
              y,
              armHair(arm.front, outerX, y, shade * 0.92),
            );
          }
          // A side-view drape needs a continuous outer rail. Shift the strand
          // only after a three-row vertical run; alternating columns every
          // row made the narrow arm face read as horizontal brown stripes.
          if (y <= shoulderLastY) {
            putColor(
              innerSideFace,
              0,
              y,
              armHair(innerSideFace, 0, y, shade * 0.9),
            );
          }
          const bendsInProfile =
            style.hairTexture === "wavy" ||
            style.hairTexture === "curly" ||
            style.hairTexture === "coily" ||
            s === "curly";
          const waveSegment = bendsInProfile ? Math.floor(y / 3) : 0;
          const outerWaveX = (waveSegment + mirrorPhase) % 2 === 0 ? 1 : 2;
          const outerSecondX = outerWaveX === 1 ? 2 : 1;
          putColor(
            outerSideFace,
            outerWaveX,
            y,
            armHair(outerSideFace, outerWaveX, y, shade * 1.02),
          );
          if (y <= Math.min(3, shoulderLastY)) {
            putColor(
              innerSideFace,
              1,
              y,
              armHair(innerSideFace, 1, y, shade * 0.78),
            );
          }
          if (y === 1 || y === 3) {
            putColor(
              outerSideFace,
              outerSecondX,
              y,
              armHair(outerSideFace, outerSecondX, y, shade * 0.82),
            );
          }
        }
        for (const [x, y, color] of [
          [innerX, topY, torsoStrandLight],
          [outerX, topY + 1, shadeRgb(torsoStrandLight, 0.86)],
          [innerX, shoulderLastY, torsoStrandDark],
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
        rightArmOver.left,
        0,
      );
      paintShoulderDrape(
        leftArmOver,
        leftArmOver.front.w - 1,
        0,
        leftArmOver.left,
        leftArmOver.right,
        1,
      );

      if (style.hairTexture === "wavy" || style.hairTexture === "curly") {
        const layerLight = mixRgb(hairColor, [246, 226, 214], 0.28);
        const layerMid = shadeRgb(hairColor, 0.72);
        const layerDark = shadeRgb(hairColor, 0.68);
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
          for (let y = 1; y < Math.min(8, torsoHairRows); y++) {
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
        const accessoryPetal: Rgb = [236, 184, 192];
        const headSide = accessoryOnRight ? over.left : over.right;
        const frontEdgeX = accessoryOnRight ? 7 : 0;
        const frontInnerX = accessoryOnRight ? 6 : 1;
        const sideOuterX = accessoryOnRight ? 1 : 6;
        const sideInnerX = accessoryOnRight ? 2 : 5;

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
      }
    }
  }
  if (
    hairBackShape === "long" &&
    sideHairLength !== "shoulder" &&
    torsoHairRows > 0
  ) {
    const bodyOver = CLASSIC_LAYOUT.body.overlay;
    const backDrapeLight = mixRgb(
      hairColor,
      [242, 226, 214],
      style.hairTexture === "wavy" ? 0.22 : 0.14,
    );
    const backDrapeDark = shadeRgb(hairColor, 0.7);
    const bodyHair = (rect: Rect, x: number, y: number, shade = 1) =>
      shadeRgb(hairVolumePixel(hairColor, rect.x + x, rect.y + y), shade);

    for (let y = 0; y < torsoHairRows; y++) {
      const row =
        y < 2
          ? ([2, 3, 4, 5] as const)
          : y < torsoHairRows - 2
            ? ([1, 2, 3, 4, 5, 6] as const)
            : y === torsoHairRows - 1
              ? ([3, 4] as const)
              : ([2, 3, 4, 5] as const);
      for (const x of row) {
        const shade =
          y >= torsoHairRows - 2 ? 0.72 : x === 2 || x === 5 ? 0.88 : 0.8;
        putColor(bodyOver.back, x, y, bodyHair(bodyOver.back, x, y, shade));
      }
      putColor(
        bodyOver.right,
        0,
        y,
        bodyHair(bodyOver.right, 0, y, y >= torsoHairRows - 2 ? 0.72 : 0.84),
      );
      putColor(
        bodyOver.left,
        bodyOver.left.w - 1,
        y,
        bodyHair(
          bodyOver.left,
          bodyOver.left.w - 1,
          y,
          y >= torsoHairRows - 2 ? 0.72 : 0.84,
        ),
      );
      if (y <= 3 && sideHairLength === "jaw") {
        putColor(
          bodyOver.front,
          0,
          y,
          bodyHair(bodyOver.front, 0, y, y === 3 ? 0.7 : 0.84),
        );
        putColor(
          bodyOver.front,
          7,
          y,
          bodyHair(bodyOver.front, 7, y, y === 3 ? 0.7 : 0.84),
        );
      }
    }
    for (const [rect, x, y, color] of (
      [
        [bodyOver.back, 2, 1, backDrapeLight],
        [bodyOver.back, 5, 2, shadeRgb(backDrapeLight, 0.9)],
        [bodyOver.back, 3, Math.max(2, torsoHairRows - 1), backDrapeDark],
        [
          bodyOver.back,
          4,
          Math.max(2, torsoHairRows - 1),
          shadeRgb(backDrapeDark, 0.9),
        ],
        [bodyOver.right, 1, 2, shadeRgb(backDrapeLight, 0.84)],
        [bodyOver.left, bodyOver.left.w - 2, 2, shadeRgb(backDrapeLight, 0.84)],
      ] as const
    ).filter(([, , y]) => y < torsoHairRows)) {
      putColor(rect, x, y, color);
    }
  }
  if (
    overallHairLength === "hip" &&
    (s === "long" || hairBackShape === "long")
  ) {
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay;
    const leftLeg = CLASSIC_LAYOUT.leftLeg.overlay;
    const legHair = (rect: Rect, x: number, y: number, shade = 1) =>
      shadeRgb(hairVolumePixel(hairColor, rect.x + x, rect.y + y), shade);
    const paintHipTail = (
      leg: typeof rightLeg,
      outerSide: Rect,
      frontEdgeX: number,
      mirror: boolean,
    ) => {
      const backRows = [
        [0, 1, 2, 3],
        mirror ? [0, 1, 2] : [1, 2, 3],
        [1, 2],
        [mirror ? 1 : 2],
      ] as const;
      for (let y = 0; y < backRows.length; y++) {
        for (const x of backRows[y]) {
          putColor(
            leg.back,
            x,
            y,
            legHair(leg.back, x, y, y >= 2 ? 0.54 : x === 1 ? 0.84 : 0.7),
          );
        }
        if (y < 3) {
          putColor(
            leg.front,
            frontEdgeX,
            y,
            legHair(leg.front, frontEdgeX, y, y === 2 ? 0.56 : 0.76),
          );
          putColor(
            outerSide,
            0,
            y,
            legHair(outerSide, 0, y, y === 2 ? 0.52 : 0.7),
          );
        }
      }
      for (let x = 0; x < leg.top.w; x++) {
        putColor(
          leg.top,
          x,
          leg.top.h - 1,
          legHair(leg.top, x, leg.top.h - 1, x === 1 || x === 2 ? 0.8 : 0.62),
        );
      }
    };
    paintHipTail(rightLeg, rightLeg.right, 0, false);
    paintHipTail(leftLeg, leftLeg.left, leftLeg.front.w - 1, true);
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

  const hairLuminance =
    hairColor[0] * 0.299 + hairColor[1] * 0.587 + hairColor[2] * 0.114;
  // Multiplicative shading barely changes near-black hair. Lift only its
  // authored highlights/midtones so overlay cut-outs and connected strand
  // clusters remain visible in 3D while the overall colour still reads black.
  const darkHairBoost = Math.max(0, Math.min(1, (72 - hairLuminance) / 56));
  const critiqueDepthBoost = style.hairDepthBoost === true ? 1 : 0;
  const strandLight = mixRgb(
    hairColor,
    [210, 204, 198],
    (style.hairTexture === "wavy" || style.hairTexture === "curly"
      ? 0.2
      : 0.13) +
      darkHairBoost * 0.1 +
      critiqueDepthBoost * 0.12,
  );
  const strandDark = shadeRgb(hairColor, critiqueDepthBoost ? 0.46 : 0.58);
  const strandMid = shadeRgb(hairColor, critiqueDepthBoost ? 0.74 : 0.82);
  const paintStrand = (rect: Rect, x: number, y: number, phase = 0) => {
    putColor(rect, x, y, (x + y + phase) % 3 === 0 ? strandLight : strandDark);
  };
  const hairSilhouette =
    style.hairSilhouette ?? (style.hairVolume === "flat" ? "flat" : "rounded");
  const outlineLight = mixRgb(
    hairColor,
    strandLight,
    0.28 + darkHairBoost * 0.34,
  );
  const outlineDark = shadeRgb(hairColor, critiqueDepthBoost ? 0.42 : 0.54);
  const outlineMid = mixRgb(
    shadeRgb(hairColor, 0.76),
    mixRgb(hairColor, [140, 136, 132], 0.17),
    darkHairBoost,
  );
  if (hairSilhouette === "rounded") {
    // The larger second-layer cube becomes a square helmet when its corner
    // pixels are opaque. Remove matching corners on every adjacent face so
    // the smaller base cube peeks through as a stepped rounded silhouette,
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
      if (s === "short") {
        clearPixel(rect, 1, 0);
        clearPixel(rect, rect.w - 2, 0);
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
    if (s === "short") {
      for (const [x, y] of [
        [1, 0],
        [over.top.w - 2, 0],
        [0, 1],
        [over.top.w - 1, 1],
        [0, over.top.h - 2],
        [over.top.w - 1, over.top.h - 2],
        [1, over.top.h - 1],
        [over.top.w - 2, over.top.h - 1],
      ] as const) {
        clearPixel(over.top, x, y);
      }
    }
    for (const [rect, points] of [
      [
        over.top,
        [
          [2, 0],
          [3, 0],
          [4, 0],
          [5, 0],
          [1, 1],
          [6, 1],
          [0, 2],
          [7, 2],
        ],
      ],
      [
        over.front,
        [
          [2, 0],
          [5, 0],
          [1, 1],
          [2, 1],
          [5, 1],
          [6, 1],
        ],
      ],
      [
        over.right,
        [
          [2, 0],
          [5, 0],
          [1, 1],
          [2, 1],
        ],
      ],
      [
        over.left,
        [
          [2, 0],
          [5, 0],
          [5, 1],
          [6, 1],
        ],
      ],
    ] as const) {
      for (const [x, y] of points) putColor(rect, x, y, outlineLight);
    }
    if (s !== "short") {
      for (const [rect, points] of [
        [
          over.top,
          [
            [1, 0],
            [6, 0],
          ],
        ],
        [
          over.front,
          [
            [1, 0],
            [6, 0],
          ],
        ],
        [over.right, [[1, 0]]],
        [over.left, [[6, 0]]],
      ] as const) {
        for (const [x, y] of points) putColor(rect, x, y, outlineLight);
      }
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
    // The outer head layer is a larger cube. Merely drawing brighter pixels
    // on its fully opaque top rim still produces a square helmet silhouette,
    // so carve matching alpha gaps across each physical top seam and retain
    // only a few connected roots. The complete base layer remains underneath.
    if (hairSilhouette === "spiky" || s === "short") {
      const frontRoots = new Set([1, 4, 6]);
      const backRoots = new Set([1, 4, 6]);
      const sideRoots = new Set([2, 5]);
      for (let x = 0; x < 8; x++) {
        if (!frontRoots.has(x)) {
          clearPixel(over.front, x, 0);
          clearPixel(over.top, x, over.top.h - 1);
        }
        if (!backRoots.has(x)) {
          clearPixel(over.back, x, 0);
          clearPixel(over.top, 7 - x, 0);
        }
        if (!sideRoots.has(x)) {
          clearPixel(over.right, x, 0);
          clearPixel(over.top, 0, x);
          clearPixel(over.left, x, 0);
          clearPixel(over.top, over.top.w - 1, 7 - x);
        }
      }
      for (const x of frontRoots) {
        putColor(over.front, x, 0, x % 2 === 0 ? outlineLight : outlineMid);
        putColor(over.top, x, over.top.h - 1, outlineMid);
      }
      for (const x of backRoots) {
        putColor(over.back, x, 0, x % 2 === 0 ? outlineMid : outlineDark);
        putColor(over.top, 7 - x, 0, outlineDark);
      }
      for (const x of sideRoots) {
        putColor(over.right, x, 0, x % 2 === 0 ? outlineMid : outlineDark);
        putColor(over.top, 0, x, outlineDark);
        putColor(over.left, x, 0, x % 2 === 0 ? outlineDark : outlineMid);
        putColor(over.top, over.top.w - 1, 7 - x, outlineMid);
      }
    }
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
  // hairPart is the visible root/scalp side. A curtain lock normally falls
  // away from that root, so the heavier low strand occupies the opposite
  // viewer side. Centre/hidden roots retain two balanced curtains.
  const curtainHeavySide =
    hairPart === "right" ? "left" : hairPart === "left" ? "right" : "both";
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
    const mirror = style.hairPart === "left";
    const px = (x: number) => (mirror ? 7 - x : x);
    for (const x of [0, 1, 2, 3, 4, 5, 6])
      paintBang(px(x), 1, x < 3 ? 1.04 : 0.9);
    for (const x of [0, 1, 2, 3, 4]) paintBang(px(x), 2, x < 2 ? 0.86 : 0.98);
    for (const x of [0, 1, 2]) paintBang(px(x), 3, 0.72);
    wrapTemple(2, mirror ? 0.78 : 1, mirror ? 1 : 0.78);
  } else if (style.bangs === "curtain") {
    // Rebuild these rows rather than layering more pixels over composeFace's
    // symmetric placeholder. Otherwise a correctly analysed side part still
    // rendered as the same centred fringe for every portrait.
    for (let y = 1; y <= 3; y++) {
      for (let x = 0; x < over.front.w; x++) clearPixel(over.front, x, y);
    }
    for (const x of [0, 1, 2])
      paintBang(x, 1, curtainHeavySide === "left" ? 1.04 : 0.9);
    for (const x of [5, 6, 7])
      paintBang(x, 1, curtainHeavySide === "right" ? 1.04 : 0.9);
    for (const x of [0, 1]) paintBang(x, 2, 0.84);
    for (const x of [6, 7]) paintBang(x, 2, 0.8);
    if (curtainHeavySide === "left" || curtainHeavySide === "both")
      paintBang(2, 2, 0.92);
    if (curtainHeavySide === "right" || curtainHeavySide === "both")
      paintBang(5, 2, 0.9);
    for (const x of [0, 7]) paintBang(x, 3, 0.74);
    if (hairPart === "center" || hairPart === "none") {
      putColor(over.front, 3, 1, partAccent);
      putColor(over.front, 4, 1, partShadow);
    } else {
      const rootX = hairPart === "left" ? 3 : 4;
      putColor(over.front, rootX, 1, partShadow);
    }
    wrapTemple(
      2,
      curtainHeavySide === "left" ? 1 : 0.82,
      curtainHeavySide === "right" ? 1 : 0.82,
    );
    wrapTemple(
      3,
      curtainHeavySide === "left" ? 0.78 : 0.64,
      curtainHeavySide === "right" ? 0.78 : 0.64,
    );
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
      const mirror = style.hairPart === "left";
      const px = (x: number) => (mirror ? 7 - x : x);
      for (const x of [0, 1, 3]) paintBang(px(x), 3, x === 0 ? 0.62 : 0.78);
      if (bangsLength === "eye") {
        for (const x of [0, 2]) paintBang(px(x), 4, x === 0 ? 0.54 : 0.64);
      }
      wrapTemple(3, mirror ? 0.68 : 0.9, mirror ? 0.9 : 0.68);
    } else if (style.bangs === "curtain") {
      paintBang(0, 3, 0.62);
      paintBang(7, 3, 0.6);
      if (curtainHeavySide === "left" || curtainHeavySide === "both")
        paintBang(1, 3, 0.7);
      if (curtainHeavySide === "right" || curtainHeavySide === "both")
        paintBang(6, 3, 0.68);
      if (bangsLength === "eye") {
        if (curtainHeavySide === "left" || curtainHeavySide === "both")
          paintBang(1, 4, 0.56);
        if (curtainHeavySide === "right" || curtainHeavySide === "both")
          paintBang(6, 4, 0.54);
      }
      wrapTemple(
        3,
        curtainHeavySide === "left" ? 0.74 : 0.6,
        curtainHeavySide === "right" ? 0.74 : 0.6,
      );
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
    if (
      sideHairShape === "ear_hugging" ||
      (sideHairShape === "tapered" && roundedFringeCut)
    ) {
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
            : sideHairShape === "tapered"
              ? [
                  [1, 2, 3, 4, 5, 6],
                  [0, 1, 2, 5, 6, 7],
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

  if (sideHairLength === "short" && s !== "buzz" && s !== "afro") {
    if (sideHairShape === "face_framing") {
      // Short face-framing cuts have a distinct pair of forward locks below
      // the temple. Carry their outer pixels around the physical front/side
      // seams and keep the inner pixels off the seam so they read as tapered
      // strands rather than another full side band.
      for (const [x, mirrorX] of [
        [0, 7],
        [1, 6],
      ] as const) {
        putColor(
          over.front,
          x,
          5,
          shadeRgb(bangTone(x, 5), x === 0 ? 0.62 : 0.54),
        );
        putColor(
          over.front,
          mirrorX,
          5,
          shadeRgb(bangTone(mirrorX, 5), mirrorX === 7 ? 0.58 : 0.5),
        );
      }
      putColor(over.right, 7, 5, readColor(over.front, 0, 5) ?? hairColor);
      putColor(over.left, 0, 5, readColor(over.front, 7, 5) ?? hairColor);
      putColor(over.right, 6, 5, shadeRgb(bangTone(1, 5), 0.5));
      putColor(over.left, 1, 5, shadeRgb(bangTone(6, 5), 0.48));
    } else if (sideHairShape === "flared") {
      // A flared profile spreads through the middle of the raised side face
      // before tapering at the lower edge. Mirrored clusters make both sides
      // read consistently when the model rotates.
      for (const [rect, mirror] of [
        [over.right, false],
        [over.left, true],
      ] as const) {
        const px = (x: number) => (mirror ? 7 - x : x);
        for (const [x, y, shade] of [
          [2, 3, 0.84],
          [3, 4, 0.68],
          [4, 4, 0.76],
          [4, 5, 0.58],
        ] as const) {
          putColor(rect, px(x), y, shadeRgb(bangTone(px(x), y), shade));
        }
      }
    } else if (sideHairShape === "undercut") {
      // Close-cut sides should not inherit the same lower outer-layer rails
      // as face-framing or flared hair. Clear all adjacent faces together so
      // the transparent taper remains a valid UV seam instead of a crack.
      for (let y = 3; y < over.front.h; y++) {
        clearPixel(over.front, 0, y);
        clearPixel(over.front, 7, y);
        clearPixel(over.back, 0, y);
        clearPixel(over.back, 7, y);
        for (let x = 0; x < over.right.w; x++) {
          clearPixel(over.right, x, y);
          clearPixel(over.left, x, y);
        }
      }
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
    const shallowDenseCenterGap =
      style.bangs === "straight" &&
      bangsDensity === "dense" &&
      visibleFringeOpening === "center";
    for (const x of gapXs) {
      clearPixel(over.front, x, 2);
      if (
        !shallowDenseCenterGap &&
        (bangsLength === "brow" || bangsLength === "eye")
      ) {
        clearPixel(over.front, x, 3);
      }
    }
  }

  if (s === "afro" || style.hairTexture === "coily") {
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
    const mirrorCrownRows = (rows: readonly (readonly number[])[]) =>
      rows.map((row) => row.map((x) => over.top.w - 1 - x));
    const sweptCrownRows = [
      [2, 3, 4, 5],
      [1, 2, 4, 5],
      [1, 3, 5],
      [2, 4, 6],
      [2, 3, 5, 6],
      [3, 4, 6],
      [4, 5, 6],
      [3, 4],
    ] as const;
    const tousledCrownRows = [
      [2, 3, 4, 5],
      [1, 2, 5, 6],
      [2, 4, 6],
      [1, 3, 5],
      [2, 4, 6],
      [1, 3, 5],
      [2, 4, 6],
      [3, 4],
    ] as const;
    const longTopRows =
      style.hairVolume === "flat"
        ? // Long hair used to overwrite the earlier flat-volume mask with
          // the normal crown. Keep only a restrained central highlight
          // cluster; the base cube still supplies the continuous hair mass.
          [[], [], [3, 4], [2, 3, 4, 5], [2, 3, 4, 5], [3, 4], [], []]
        : hairSilhouette === "swept"
          ? style.hairPart === "right"
            ? mirrorCrownRows(sweptCrownRows)
            : sweptCrownRows
          : hairSilhouette === "tousled" || hairSilhouette === "spiky"
            ? tousledCrownRows
            : style.hairVolume === "full"
              ? [[2, 3, 4, 5], [1, 6], [3, 4], [2, 5], [], [], [1, 6], [3, 4]]
              : [
                  [1, 2, 5, 6],
                  [0, 1, 2, 5, 6, 7],
                  [0, 1, 3, 6, 7],
                  [0, 4, 7],
                  [0, 2, 5, 7],
                  [0, 1, 6, 7],
                  [1, 2, 5, 6],
                  [2, 5],
                ];
    retainRows(over.top, longTopRows);
    const roundedFaceFramingRows = [
      [1, 6],
      [0, 1, 2, 5, 6, 7],
      [0, 1, 2, 5, 6, 7],
      [0, 1, 6, 7],
      [0, 1, 6, 7],
      [0, 7],
      [0],
      [],
    ] as const;
    const tousledFaceFramingRows = [
      [1, 6],
      [0, 1, 6, 7],
      [0, 1, 6, 7],
      [0, 1, 6, 7],
      [0, 1, 6, 7],
      [0, 1, 6, 7],
      [0, 1],
      [0],
    ] as const;
    const sweptFullSideRows = roundedFaceFramingRows;
    const sweptLightSideRows = [
      [1, 6],
      [0, 1, 6, 7],
      [0, 1, 6, 7],
      [0, 1, 7],
      [0, 7],
      [0, 7],
      [0],
      [],
    ] as const;
    const straightFaceFramingRows = [
      [0, 1, 2, 5, 6, 7],
      [0, 1, 2, 5, 6, 7],
      [0, 1, 2, 5, 6, 7],
      [0, 1, 2, 6, 7],
      [0, 7],
      [0, 7],
      [0, 7],
      [0, 7],
    ] as const;
    const sharedLongSideRows =
      sideHairShape === "face_framing"
        ? hairSilhouette === "rounded"
          ? roundedFaceFramingRows
          : hairSilhouette === "tousled" || hairSilhouette === "spiky"
            ? tousledFaceFramingRows
            : hairSilhouette === "swept"
              ? sweptLightSideRows
              : straightFaceFramingRows
        : sideHairShape === "flared"
          ? [
              [1, 2, 5, 6],
              [0, 1, 2, 5, 6, 7],
              [0, 1, 2, 3, 4, 5, 6, 7],
              [0, 1, 2, 3, 5, 6, 7],
              [0, 1, 2, 5, 6, 7],
              [0, 1, 2, 5, 6, 7],
              [0, 1, 6, 7],
              [0, 7],
            ]
          : Array.from({ length: 8 }, (_, y) =>
              y === 0
                ? [0, 1, 2, 5, 6, 7]
                : y === 7
                  ? [0, 1, 3, 4, 6, 7]
                  : [0, 1, y % 2 === 0 ? 2 : 5, 6, 7],
            );
    const sweptHeavyViewerSide =
      hairPart === "right" ? "left" : hairPart === "left" ? "right" : "both";
    const rightLongSideRows =
      sideHairShape === "face_framing" && hairSilhouette === "swept"
        ? sweptHeavyViewerSide === "left" || sweptHeavyViewerSide === "both"
          ? sweptFullSideRows
          : sweptLightSideRows
        : sharedLongSideRows;
    const leftLongSideRows =
      sideHairShape === "face_framing" && hairSilhouette === "swept"
        ? sweptHeavyViewerSide === "right" || sweptHeavyViewerSide === "both"
          ? sweptFullSideRows
          : sweptLightSideRows
        : sharedLongSideRows;
    if (sideHairShape === "face_framing" || sideHairShape === "flared") {
      // Earlier detail passes intentionally leave holes for texture. On an
      // exact profile those holes became alternating isolated pixels, so
      // complete the intended rails before applying the sparse silhouette.
      for (let y = 0; y < rightLongSideRows.length; y++) {
        for (const x of rightLongSideRows[y]) {
          fillTransparent(over.right, x, y, 1, 1, true);
        }
        for (const x of leftLongSideRows[y]) {
          fillTransparent(over.left, 7 - x, y, 1, 1, true);
        }
      }
    }
    retainRows(over.right, rightLongSideRows);
    retainRows(
      over.left,
      leftLongSideRows.map((row) => row.map((x) => 7 - x)),
    );
    if (
      sideHairShape === "face_framing" &&
      (style.hairTexture === "wavy" ||
        style.hairTexture === "curly" ||
        style.hairSilhouette === "tousled")
    ) {
      // These two front-edge cells are the physical neighbours of the side
      // profile tips removed above. Clear both faces together so the final UV
      // seam synchronizer preserves a deliberate taper instead of restoring
      // a full-height rectangular rail from the still-opaque front face.
      for (const y of [6, 7]) {
        clearPixel(over.front, 0, y);
        clearPixel(over.front, 7, y);
      }
    }
    retainRows(over.back, [
      [1, 6],
      [0, 2, 7],
      [0, 1, 7],
      [0, 5, 7],
      [0, 3, 7],
      [0, 2, 7],
      [0, 4, 7],
      [0, 3, 4, 7],
    ]);
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
      const bodyBase = CLASSIC_LAYOUT.body.base;
      const bodyFrontX = shorterSide === "left" ? 0 : body.front.w - 3;
      const bodySide = shorterSide === "left" ? body.right : body.left;
      const bodyBaseSide =
        shorterSide === "left" ? bodyBase.right : bodyBase.left;
      const bodyBackX = shorterSide === "left" ? body.back.w - 3 : 0;
      const arm =
        shorterSide === "left"
          ? CLASSIC_LAYOUT.rightArm.overlay
          : CLASSIC_LAYOUT.leftArm.overlay;

      if (hairBackShape === "long") {
        // A shorter face-framing lock does not mean that the long back hair
        // disappears from the same shoulder. Keep a one-pixel outer rail on
        // both sides and taper only the inner/lower pixels. Removing the whole
        // torso and arm drape made slightly turned portraits produce a
        // one-sided hairstyle even when the source had long hair on both
        // shoulders.
        const frontInnerX =
          shorterSide === "left" ? bodyFrontX + 1 : bodyFrontX;
        restoreRect(body.front, frontInnerX, 5, 2, body.front.h - 5);
        // The connected face-framing mass now lives on the base cube. Trim
        // all three lower front columns on the shorter viewer side, while the
        // separate rear base mass remains bilateral.
        restoreRect(bodyBase.front, bodyFrontX, 5, 3, bodyBase.front.h - 5);

        if (shorterSide === "left") {
          restoreRect(
            bodySide,
            1,
            5,
            Math.max(0, bodySide.w - 1),
            bodySide.h - 5,
          );
          // Keep x=0 as the rear-hair rail and remove the shortened front
          // lock from the rest of the side face.
          restoreRect(
            bodyBaseSide,
            1,
            5,
            Math.max(0, bodyBaseSide.w - 1),
            bodyBaseSide.h - 5,
          );
        } else {
          restoreRect(
            bodySide,
            0,
            5,
            Math.max(0, bodySide.w - 1),
            bodySide.h - 5,
          );
          restoreRect(
            bodyBaseSide,
            0,
            5,
            Math.max(0, bodyBaseSide.w - 1),
            bodyBaseSide.h - 5,
          );
        }

        const backInnerX = shorterSide === "left" ? bodyBackX : bodyBackX + 1;
        restoreRect(body.back, backInnerX, 5, 2, body.back.h - 5);
        for (const rect of [arm.front, arm.back, arm.right, arm.left]) {
          restoreRect(rect, 0, 5, rect.w, rect.h - 5);
        }
      } else {
        restoreRect(body.front, bodyFrontX, 3, 3, body.front.h - 3);
        restoreRect(bodySide, 0, 3, bodySide.w, bodySide.h - 3);
        restoreRect(body.back, bodyBackX, 3, 3, body.back.h - 3);
        restoreRect(bodyBase.front, bodyFrontX, 3, 3, bodyBase.front.h - 3);
        restoreRect(bodyBaseSide, 0, 3, bodyBaseSide.w, bodyBaseSide.h - 3);
        for (const rect of [arm.front, arm.back, arm.right, arm.left]) {
          restoreRect(rect, 0, 3, rect.w, rect.h - 3);
        }
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
      pink: [242, 138, 172],
    };
    const accessoryBase = accessoryColors[style.hairAccessoryColor ?? "pink"];
    const flowerPetal = mixRgb(accessoryBase, [255, 244, 240], 0.18);
    const flowerLight = mixRgb(accessoryBase, [255, 248, 244], 0.44);
    const flowerShade = shadeRgb(accessoryBase, 0.72);
    // Keep the warm centre visibly brighter than reddish-brown hair after the
    // final directional shading pass. It is the one-pixel focal point of a
    // side flower in front view, so losing it into the hair makes the entire
    // asymmetric accessory read as an undifferentiated patch.
    const flowerCenter: Rgb = [255, 224, 174];
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
    const drawMiniFlower = (rect: Rect, cx: number, cy: number) => {
      putColor(rect, cx, cy, flowerCenter);
      putColor(rect, cx - 1, cy, flowerPetal);
      putColor(rect, cx + 1, cy, flowerShade);
      putColor(rect, cx, cy - 1, flowerLight);
    };
    const drawRibbon = (rect: Rect, cx: number, cy: number) => {
      putColor(rect, cx - 1, cy, ribbon);
      putColor(rect, cx + 1, cy, ribbon);
      putColor(rect, cx, cy, ribbonDark);
      putColor(rect, cx - 2, cy - 1, shadeRgb(ribbon, 1.06));
      putColor(rect, cx + 2, cy - 1, shadeRgb(ribbon, 0.92));
    };
    const accessorySide = style.hairAccessorySide ?? "left";
    const accessoryScale = style.hairAccessoryScale ?? "medium";
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
    const drawFrontMiniFlower = (cx: number, cy: number) =>
      drawMiniFlower(over.front, mx(cx), cy);
    const drawSideMiniFlower = (cx: number, cy: number) =>
      drawMiniFlower(sideFace, sx(cx), cy);
    const drawFrontRibbon = (cx: number, cy: number) =>
      drawRibbon(over.front, mx(cx), cy);
    const drawSideRibbon = (cx: number, cy: number) =>
      drawRibbon(sideFace, sx(cx), cy);

    if (accessory === "flower") {
      if (accessorySide === "center") {
        if (accessoryScale === "small") {
          drawMiniFlower(over.front, 3, 2);
          putColor(over.top, 3, 5, leaf);
        } else {
          drawFlower(over.front, 3, 2);
          drawFlower(over.top, 3, 5);
          putColor(over.front, 2, 3, leaf);
          putColor(over.front, 4, 3, leafDark);
          putColor(over.top, 2, 6, flowerLight);
          putColor(over.top, 4, 6, flowerShade);
          if (accessoryScale === "large") {
            putColor(over.front, 5, 2, flowerPetal);
            putColor(over.front, 5, 3, flowerCenter);
            putColor(over.top, 5, 5, flowerLight);
          }
        }
      } else {
        if (accessoryScale === "small") {
          drawFrontMiniFlower(1, 2);
          drawSideMiniFlower(6, 2);
          putTopAccessory(2, 5, leaf);
        } else {
          drawFrontFlower(1, 2);
          putFrontAccessory(2, 2, flowerLight);
          putFrontAccessory(2, 3, flowerShade);
          // Large flowers need a dark hair gap between blooms. Filling this
          // coordinate with a leaf joined every pink/green pixel into a
          // rectangular badge instead of a cluster of separate petals.
          if (accessoryScale === "large") {
            putFrontAccessory(2, 0, leaf);
          } else {
            putFrontAccessory(2, 1, leaf);
          }
          // Keep the lower leaf on the temple seam. At (1, 4) it sat on the
          // outer eye anchor, so eye-length curtain bangs caused the green
          // accessory pixel to be preserved as if it were a fringe lock.
          putFrontAccessory(0, 4, leafDark);
          // Keep the profile readable. A previous three-flower side cluster
          // occupied most of the 8x8 face in exact side views and made the
          // accessory look like a mask. One seam-connected bloom plus a few
          // leaves is enough to create second-layer volume.
          drawSideFlower(6, 2);
          putSideAccessory(5, 1, leaf);
          putSideAccessory(4, 1, leafDark);
          putSideAccessory(5, 4, leaf);
          // The base crown already supplies the continuous hair mass. Three
          // staggered pixels continue the flower and leaf over the crown;
          // drawing complete flowers here made the top read as a flat floral
          // headband and hid the authored hair silhouette.
          putTopAccessory(2, 5, flowerCenter);
          putTopAccessory(2, 4, flowerLight);
          putTopAccessory(3, 6, leaf);
          putBackAccessory(0, 3, flowerPetal);
          putBackAccessory(1, 3, leaf);
          putBackAccessory(0, 4, leafDark);
          if (accessoryScale === "large") {
            // Keep the second bloom on the same physical temple instead of
            // stretching it across the front face. A front mini-flower at
            // x=4 connected the left bloom to the centre fringe and turned a
            // one-sided hairpiece into a wide pink forehead band. Four side
            // pixels make the larger cluster readable from its owning profile
            // and three-quarter view while the opposite view remains hair.
            putSideAccessory(4, 4, flowerCenter);
            putSideAccessory(3, 4, flowerPetal);
            putSideAccessory(5, 4, flowerShade);
            putSideAccessory(4, 3, flowerLight);
            // Continue only the owning-side edge over the crown. Keeping this
            // accent beside the existing x=2 cluster avoids a floral headband.
            putTopAccessory(1, 3, flowerPetal);
          }
        }
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

  if (
    roundedFringeCut &&
    style.hairAccessory === "none" &&
    sideHairShape !== "undercut"
  ) {
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

  if (
    style.hairStructure !== "locs" &&
    (s === "curly" || style.hairTexture === "curly")
  ) {
    const curlLight = mixRgb(hairColor, [250, 240, 214], 0.66);
    const curlMid = mixRgb(hairColor, [154, 116, 66], 0.2);
    const curlDark = shadeRgb(hairColor, 0.46);
    const clearLowerShell = (rect: Rect) => {
      for (let y = 2; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) clearPixel(rect, x, y);
      }
    };
    const restoreUnder = (rect: Rect, x: number, y: number) => {
      const offset = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        atlas.rgba[offset + channel] = underHair[offset + channel];
      }
    };
    const deepenBase = (rect: Rect, rows: number, shade: number) => {
      for (let y = 0; y < Math.min(rect.h, rows); y++) {
        for (let x = 0; x < rect.w; x++) {
          const offset = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
          const source: Rgb = [
            atlas.rgba[offset],
            atlas.rgba[offset + 1],
            atlas.rgba[offset + 2],
          ];
          putColor(rect, x, y, shadeRgb(source, shade));
        }
      }
    };
    const paintCurl = (rect: Rect, x: number, y: number, mirror = false) => {
      const points = mirror
        ? ([
            [x + 1, y, curlLight],
            [x, y, curlMid],
            [x + 1, y + 1, curlDark],
            [x + 1, y + 2, curlMid],
            [x, y + 2, curlLight],
          ] as const)
        : ([
            [x, y, curlLight],
            [x + 1, y, curlMid],
            [x, y + 1, curlDark],
            [x, y + 2, curlMid],
            [x + 1, y + 2, curlLight],
          ] as const);
      for (const [px, py, color] of points) {
        if (px >= 0 && py >= 0 && px < rect.w && py < rect.h) {
          putColor(rect, px, py, color);
        }
      }
      const cavityX = mirror ? x : x + 1;
      const cavityY = y + 1;
      if (
        cavityX >= 0 &&
        cavityY >= 0 &&
        cavityX < rect.w &&
        cavityY < rect.h
      ) {
        // A transparent C-loop still looks solid when it reveals an equally
        // bright base hair pixel. Keep the base complete, but darken the exact
        // cell behind the opening so the raised ring reads from every angle.
        clearPixel(rect, cavityX, cavityY);
        const baseRect =
          rect === over.front
            ? base.front
            : rect === over.back
              ? base.back
              : rect === over.right
                ? base.right
                : rect === over.left
                  ? base.left
                  : rect === over.top
                    ? base.top
                    : null;
        if (baseRect) {
          putColor(baseRect, cavityX, cavityY, shadeRgb(hairColor, 0.38));
        }
      }
    };

    for (const rect of [over.front, over.back, over.right, over.left]) {
      clearLowerShell(rect);
    }
    // Keep a visibly darker inner hair mass below the bright raised curl
    // clusters. Similar base/overlay colours visually collapse into one flat
    // cube even when alpha geometry is correct.
    deepenBase(base.top, base.top.h, 0.84);
    deepenBase(base.front, 3, 0.88);
    deepenBase(base.right, base.right.h, 0.86);
    deepenBase(base.left, base.left.h, 0.86);
    deepenBase(base.back, base.back.h, 0.84);
    const curlyBaseRamp: readonly Rgb[] = [
      mixRgb(hairColor, [255, 244, 214], 0.52),
      mixRgb(hairColor, [196, 154, 92], 0.24),
      shadeRgb(hairColor, 0.88),
      shadeRgb(hairColor, 0.68),
      shadeRgb(hairColor, 0.5),
    ];
    const colorDistance = (a: Rgb, b: Rgb) =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    const textureCurlyBase = (rect: Rect, rows: number) => {
      for (let y = 0; y < Math.min(rect.h, rows); y++) {
        for (let x = 0; x < rect.w; x++) {
          const current = readColor(rect, x, y);
          if (!current) continue;
          // Preserve the profile window: only recolour pixels whose current
          // tone is closer to the analysed hair than to the analysed skin.
          if (
            colorDistance(current, shadeRgb(hairColor, 0.84)) >
            colorDistance(current, shadeRgb(skinColor, 0.88))
          )
            continue;
          const phase = (x * 3 + y * 5 + Math.floor(x / 2)) % 9;
          const rampIndex =
            phase === 0
              ? 0
              : phase === 2 || phase === 7
                ? 1
                : phase === 4
                  ? 3
                  : phase === 6
                    ? 4
                    : 2;
          putColor(rect, x, y, curlyBaseRamp[rampIndex]);
        }
      }
    };
    textureCurlyBase(base.top, base.top.h);
    textureCurlyBase(base.back, backRows);
    textureCurlyBase(base.right, sideRows);
    textureCurlyBase(base.left, sideRows);
    // Face-framing curls leave a broad, unobstructed identity window.
    paintCurl(over.front, 0, 1);
    paintCurl(over.front, 6, 3, true);
    paintCurl(over.front, 0, 5, true);
    paintCurl(over.front, 6, 4);
    for (const [rect, clusters] of [
      [
        over.back,
        [
          [0, 2, false],
          [3, 2, true],
          [6, 3, true],
          [1, 5, true],
          [4, 5, false],
        ],
      ],
      [
        over.right,
        [
          [0, 2, false],
          [3, 3, true],
          [1, 6, false],
          [5, 5, true],
        ],
      ],
      [
        over.left,
        [
          [3, 2, true],
          [6, 2, true],
          [1, 5, true],
          [5, 6, false],
        ],
      ],
    ] as const) {
      for (const [x, y, mirror] of clusters) paintCurl(rect, x, y, mirror);
    }
    for (const [x, y, mirror] of [
      [1, 0, false],
      [4, 0, true],
      [2, 2, true],
      [5, 3, false],
      [0, 5, false],
      [6, 5, true],
    ] as const) {
      paintCurl(over.top, x, y, mirror);
    }

    const body = CLASSIC_LAYOUT.body.overlay;
    const bodyRows = Math.min(body.front.h, hairBodyRows(style));
    for (const rect of [body.front, body.back]) {
      for (let y = 0; y < bodyRows; y++) {
        for (let x = 0; x < rect.w; x++) restoreUnder(rect, x, y);
      }
    }
    if (bodyRows > 0) {
      paintCurl(body.front, 0, 0);
      paintCurl(body.front, 6, 1, true);
      paintCurl(body.front, 0, Math.min(bodyRows - 1, 2), true);
      paintCurl(body.front, 6, Math.min(bodyRows - 1, 3));
      for (const [x, y, mirror] of [
        [0, 0, false],
        [3, 0, true],
        [6, 1, true],
        [1, 2, true],
        [4, 2, false],
      ] as const) {
        if (y < bodyRows) paintCurl(body.back, x, y, mirror);
      }
    }

    // Carve paired crown notches on both faces sharing each physical edge.
    // Reconciliation therefore preserves the gaps instead of filling them,
    // producing a scalloped outer silhouette around the smaller base cube.
    const clearPair = (
      first: Rect,
      firstX: number,
      firstY: number,
      second: Rect,
      secondX: number,
      secondY: number,
    ) => {
      clearPixel(first, firstX, firstY);
      clearPixel(second, secondX, secondY);
    };
    for (const x of [3, 4]) {
      clearPair(over.front, x, 0, over.top, x, over.top.h - 1);
      clearPixel(over.front, x, 1);
    }
    for (const x of [2, 5]) {
      clearPair(over.back, x, 0, over.top, 7 - x, 0);
      clearPixel(over.back, x, 1);
      clearPair(over.right, x, 0, over.top, 0, x);
      clearPixel(over.right, x, 1);
      clearPair(over.left, x, 0, over.top, over.top.w - 1, 7 - x);
      clearPixel(over.left, x, 1);
    }
    clearPixel(over.top, 2, 3);
    clearPixel(over.top, 5, 4);
    for (const y of [4, 7]) {
      clearPair(over.front, 0, y, over.right, over.right.w - 1, y);
      clearPair(over.front, over.front.w - 1, y, over.left, 0, y);
    }
    for (const y of [3, 6]) {
      clearPair(over.back, 0, y, over.left, over.left.w - 1, y);
      clearPair(over.back, over.back.w - 1, y, over.right, 0, y);
    }
  }

  if (style.hairStructure === "locs") {
    const locGlint = mixRgb(hairColor, [158, 150, 142], 0.36);
    const locLight = mixRgb(hairColor, [128, 116, 104], 0.25);
    const locMid = mixRgb(hairColor, [92, 86, 80], 0.14);
    const locDark = shadeRgb(hairColor, 0.62);
    const paintLoc = (
      rect: Rect,
      x: number,
      y0: number,
      y1: number,
      phase: number,
    ) => {
      for (let y = y0; y < Math.min(rect.h, y1); y++) {
        const color =
          (y + phase) % 7 === 0
            ? locGlint
            : (y + phase) % 4 === 0
              ? locLight
              : (y + phase) % 3 === 0
                ? locDark
                : locMid;
        putColor(rect, x, y, color);
      }
    };

    // The generic long-hair pass intentionally builds a connected outer
    // shell. Locs need the opposite lower silhouette: separated projected
    // rails. Carve that shell back before authoring thick, staggered clusters
    // so front, profile, and rear views show individual locks instead of a
    // flat brown helmet. The base layer remains complete underneath.
    for (const rect of [over.front, over.back, over.right, over.left]) {
      for (let y = 2; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) clearPixel(rect, x, y);
      }
    }
    clearPixel(over.front, 3, 0);
    clearPixel(over.front, 4, 0);
    clearPixel(over.front, 3, 1);
    clearPixel(over.front, 4, 1);

    // Distinct connected vertical clusters read as individual locs rather than
    // generic curly noise. Staggered endpoints preserve a full silhouette
    // without turning the complete head overlay into an opaque helmet.
    for (const [rect, xs] of [
      [over.back, [0, 1, 3, 5, 6, 7]],
      [over.right, [0, 1, 3, 5, 6, 7]],
      [over.left, [0, 1, 3, 5, 6, 7]],
    ] as const) {
      xs.forEach((x, index) =>
        paintLoc(rect, x, index % 2, 8 - (index % 3), index),
      );
    }
    paintLoc(over.front, 0, 1, 8, 0);
    paintLoc(over.front, 1, 2, 7, 1);
    paintLoc(over.front, 6, 1, 8, 3);
    paintLoc(over.front, 7, 0, 7, 2);
    paintLoc(over.front, 2, 0, 3, 1);
    paintLoc(over.front, 5, 0, 2, 3);

    const body = CLASSIC_LAYOUT.body.overlay;
    for (const [x, end] of [
      [0, 9],
      [2, 7],
      [5, 8],
      [7, 10],
    ] as const) {
      paintLoc(body.back, x, 0, end, x);
    }
    paintLoc(body.front, 0, 0, 7, 1);
    paintLoc(body.front, body.front.w - 1, 0, 8, 3);
    paintLoc(body.front, 2, 0, 4, 0);
    paintLoc(body.front, 5, 0, 5, 2);
    for (const rect of [body.right, body.left]) {
      paintLoc(rect, 0, 0, 7, 0);
      paintLoc(rect, rect.w - 1, 0, 9, 2);
    }
  }

  if (
    s === "short" &&
    !roundedFringeCut &&
    hairSilhouette !== "spiky" &&
    hairSilhouette !== "tousled"
  ) {
    const shortGlint = mixRgb(hairColor, [196, 184, 168], 0.52);
    const shortMid = mixRgb(hairColor, [112, 100, 88], 0.38);
    const shortDark = shadeRgb(hairColor, 0.46);
    // A compact haircut still needs raised, directional clumps. These sparse
    // clusters preserve the cropped silhouette without becoming a solid cap.
    for (const [rect, points] of [
      [
        over.top,
        [
          [1, 1, shortGlint],
          [3, 2, shortDark],
          [5, 1, shortMid],
          [6, 3, shortGlint],
        ],
      ],
      [
        over.front,
        [
          [0, 1, shortDark],
          [1, 2, shortGlint],
          [3, 1, shortDark],
          [4, 2, shortMid],
          [5, 0, shortMid],
          [6, 2, shortGlint],
          [7, 1, shortDark],
        ],
      ],
      [
        over.back,
        [
          [1, 1, shortMid],
          [6, 1, shortDark],
        ],
      ],
    ] as const) {
      for (const [x, y, color] of points) putColor(rect, x, y, color);
    }
    putColor(over.right, 1, 1, shortGlint);
    putColor(over.right, 2, 2, shortDark);
    putColor(over.left, 6, 1, shortMid);
    putColor(over.left, 5, 2, shortGlint);
  }

  if (
    (hairSilhouette === "spiky" ||
      (s === "short" && hairSilhouette === "tousled")) &&
    style.bangs === "none"
  ) {
    // A lifted crown must expose forehead rather than leaving the generic
    // two-row overlay fringe that reads as a bowl cut. Keep isolated raised
    // tufts above and clear the central lower fringe on the enlarged cube.
    for (const y of [2, 3]) {
      for (let x = 1; x <= 6; x++) clearPixel(over.front, x, y);
    }
    clearPixel(over.front, 3, 1);
    clearPixel(over.front, 4, 1);
    const spikeHighlight = mixRgb(hairColor, [238, 224, 204], 0.48);
    const spikeLight = mixRgb(hairColor, [226, 216, 204], 0.34);
    const spikeDark = shadeRgb(hairColor, 0.5);
    for (const [x, y, color] of [
      [1, 0, spikeLight],
      [2, 1, spikeDark],
      [4, 0, spikeLight],
      [5, 1, spikeDark],
      [6, 0, spikeLight],
    ] as const) {
      putColor(over.front, x, y, color);
    }
    const clearCrownPair = (x: number) => {
      clearPixel(over.front, x, 0);
      clearPixel(over.top, x, over.top.h - 1);
    };
    clearCrownPair(2);
    clearCrownPair(5);
    clearPixel(over.front, 0, 0);
    clearPixel(over.right, over.right.w - 1, 0);
    clearPixel(over.front, over.front.w - 1, 0);
    clearPixel(over.left, 0, 0);
    // High-contrast, staggered crown streaks make the raised pixels read as
    // individual tousled spikes instead of one uniformly shaded helmet.
    for (const [x, y, color] of [
      [0, 1, spikeDark],
      [1, 2, spikeHighlight],
      [2, 3, spikeLight],
      [3, 1, spikeDark],
      [4, 2, spikeHighlight],
      [5, 3, spikeDark],
      [6, 2, spikeLight],
      [7, 1, spikeDark],
    ] as const) {
      putColor(over.top, x, y, color);
    }
    putColor(over.right, 1, 1, spikeHighlight);
    putColor(over.right, 2, 2, spikeDark);
    putColor(over.left, 6, 1, shadeRgb(spikeHighlight, 0.9));
    putColor(over.left, 5, 2, shadeRgb(spikeDark, 0.84));
    putColor(over.back, 1, 1, spikeLight);
    putColor(over.back, 4, 2, spikeHighlight);
    putColor(over.back, 6, 1, spikeDark);
    putColor(base.front, 1, 0, spikeLight);
    putColor(base.front, 2, 1, spikeDark);
    putColor(base.front, 4, 0, shadeRgb(spikeLight, 0.9));
    putColor(base.front, 5, 1, shadeRgb(spikeDark, 0.84));
    putColor(base.front, 6, 0, spikeLight);
  }

  if (style.hairDepthBoost === true) {
    // A rendered-view critique may find that correct geometry still reads as
    // a flat colour mass. Strengthen only pixels that are chromatically closer
    // to hair than skin, leaving flowers, scarves, ears and face openings
    // untouched. The seam guard below re-synchronizes every physical edge.
    const rgbDistance = (a: Rgb, b: Rgb) =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    for (const rect of [
      over.top,
      over.front,
      over.back,
      over.right,
      over.left,
    ]) {
      for (let y = 0; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const current = readColor(rect, x, y);
          if (
            !current ||
            rgbDistance(current, hairColor) > rgbDistance(current, skinColor)
          ) {
            continue;
          }
          const adjusted =
            (x + y) % 3 === 0
              ? mixRgb(current, [236, 228, 218], 0.18)
              : shadeRgb(current, 0.78);
          putColor(rect, x, y, adjusted);
        }
      }
    }
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

  if (
    hairSilhouette === "tousled" ||
    (s === "short" && hairSilhouette === "rounded")
  ) {
    // Apply the bevel after fringe, accessory and seam passes. Long,
    // full-volume masks intentionally retain more mass than rounded hair,
    // but an opaque pixel on all three faces of each upper cube vertex makes
    // wavy hair read as a rectangular helmet. Clear every physical corner
    // together while preserving the irregular central tufts authored above.
    for (const rect of [over.front, over.back, over.right, over.left]) {
      clearPixel(rect, 0, 0);
      clearPixel(rect, rect.w - 1, 0);
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

  if (
    hairSilhouette === "spiky" ||
    (hairSilhouette === "tousled" && s === "short")
  ) {
    // Re-assert the crown cut-outs after strand, fringe, accessory and seam
    // passes, any of which may legitimately paint a neighbouring edge while
    // composing the rest of the hairstyle.
    const frontRoots = new Set([1, 4, 6]);
    const backRoots = new Set([1, 4, 6]);
    const sideRoots = new Set([2, 5]);
    const rootColor = mixRgb(hairColor, [232, 222, 208], 0.28);
    for (let x = 0; x < 8; x++) {
      if (frontRoots.has(x)) {
        putColor(over.front, x, 0, rootColor);
        putColor(over.top, x, 7, shadeRgb(rootColor, 0.9));
      } else {
        clearPixel(over.front, x, 0);
        clearPixel(over.top, x, 7);
      }
      if (backRoots.has(x)) {
        putColor(over.back, x, 0, shadeRgb(rootColor, 0.76));
        putColor(over.top, 7 - x, 0, shadeRgb(rootColor, 0.72));
      } else {
        clearPixel(over.back, x, 0);
        clearPixel(over.top, 7 - x, 0);
      }
      if (sideRoots.has(x)) {
        putColor(over.right, x, 0, shadeRgb(rootColor, 0.8));
        putColor(over.top, 0, x, shadeRgb(rootColor, 0.76));
        putColor(over.left, x, 0, shadeRgb(rootColor, 0.86));
        putColor(over.top, 7, 7 - x, shadeRgb(rootColor, 0.82));
      } else {
        clearPixel(over.right, x, 0);
        clearPixel(over.top, 0, x);
        clearPixel(over.left, x, 0);
        clearPixel(over.top, 7, 7 - x);
      }
    }
    const secondRowNotches =
      hairSilhouette === "spiky" ? ([2, 5] as const) : ([3] as const);
    for (const x of secondRowNotches) {
      clearPixel(over.front, x, 1);
      clearPixel(over.back, 7 - x, 1);
      putColor(base.front, x, 1, shadeRgb(hairColor, 0.42));
      putColor(base.back, 7 - x, 1, shadeRgb(hairColor, 0.38));
    }
    const sideNotch = hairSilhouette === "spiky" ? 3 : 4;
    clearPixel(over.right, sideNotch, 1);
    clearPixel(over.left, 7 - sideNotch, 1);
    putColor(base.right, sideNotch, 1, shadeRgb(hairColor, 0.4));
    putColor(base.left, 7 - sideNotch, 1, shadeRgb(hairColor, 0.4));
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

  if (style.hat === "headscarf") {
    const base = CLASSIC_LAYOUT.head.base;
    const patternColor = hexToRgb(
      style.headCoveringPatternColor ?? "",
      mixRgb(hatColor, [238, 226, 210], 0.42),
    );
    const blockAccent = style.headCoveringAccentColor
      ? hexToRgb(style.headCoveringAccentColor, patternColor)
      : null;
    const patterned = (style.headCoveringPattern ?? "plain") !== "plain";
    const scarfColor = (rect: Rect, x: number, y: number, shade = 1): Rgb => {
      // Two-pixel weave clusters keep cloth shading intentional and avoid the
      // salt-and-pepper noise that strict visual critique reads as randomness.
      const weave =
        (Math.floor((rect.x + x) / 2) + Math.floor((rect.y + y) / 2)) % 3;
      return shadeRgb(
        hatColor,
        shade * (weave === 0 ? 0.97 : weave === 1 ? 1.01 : 1),
      );
    };
    const paintAll = (rect: Rect, shade = 1) => {
      for (let y = 0; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          put(rect, x, y, scarfColor(rect, x, y, shade));
        }
      }
    };
    const paintFrame = (rect: Rect, overlay: boolean) => {
      for (let y = 0; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const edge = x === 0 || x === rect.w - 1;
          const crown = y === 0 || (overlay && y === 1 && (x <= 1 || x >= 6));
          const jawWrap = y === rect.h - 1 && (x <= 1 || x >= rect.w - 2);
          if (edge || crown || jawWrap) {
            put(rect, x, y, scarfColor(rect, x, y, overlay ? 1.02 : 0.96));
          }
        }
      }
    };

    // The base layer is the cloth touching the head; the overlay supplies its
    // visible thickness. Keeping the central face window open preserves eyes,
    // brows, nose and mouth while replacing fallback hair on every hidden side.
    paintAll(base.top, 1.04);
    paintAll(base.back, 0.84);
    paintAll(base.right, 0.9);
    paintAll(base.left, 0.94);
    paintAll(base.bottom, 0.76);
    paintFrame(base.front, false);
    paintAll(over.top, 1.08);
    paintAll(over.back, 0.88);
    paintAll(over.right, 0.92);
    paintAll(over.left, 0.96);
    paintFrame(over.front, true);

    if (patterned) {
      const motifColor = (shade: number) => shadeRgb(patternColor, shade);
      const paintMotif = (
        rect: Rect,
        anchorX: number,
        anchorY: number,
        shade: number,
      ) => {
        const points =
          style.headCoveringPattern === "striped"
            ? Array.from(
                { length: Math.min(4, rect.w - anchorX) },
                (_, x) => [x, 0] as const,
              )
            : style.headCoveringPattern === "floral"
              ? ([
                  [1, 0],
                  [0, 1],
                  [1, 1],
                  [2, 1],
                  [1, 2],
                ] as const)
              : style.headCoveringPattern === "geometric"
                ? ([
                    [1, 0],
                    [0, 1],
                    [2, 1],
                    [1, 2],
                  ] as const)
                : ([
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [1, 2],
                    [0, 2],
                  ] as const);
        for (const [dx, dy] of points) {
          const x = anchorX + dx;
          const y = anchorY + dy;
          if (x >= 0 && y >= 0 && x < rect.w && y < rect.h) {
            put(rect, x, y, motifColor(shade));
          }
        }
      };
      // Repeating connected hooks/diamonds are legible as a textile motif at
      // 64x64 and remain consistent across the crown, side and back views.
      for (const [rect, shade] of [
        [over.top, 1.02],
        [over.back, 0.82],
        [over.right, 0.88],
        [over.left, 0.92],
      ] as const) {
        paintMotif(rect, 1, 1, shade);
        paintMotif(rect, 5, 4, shade);
      }
      put(over.front, 1, 0, motifColor(0.94));
      put(over.front, 6, 0, motifColor(0.98));
      put(over.front, 0, 5, motifColor(0.9));
      put(over.front, 7, 3, motifColor(0.94));
    }

    // A headscarf is not a helmet: carry the fabric down onto the shoulder and
    // upper-back outer layers so all six rendered views show one connected
    // drape instead of a detached head cube.
    const body = CLASSIC_LAYOUT.body.overlay;
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < body.back.w; x++) {
        const inset = y;
        if (x >= inset && x < body.back.w - inset) {
          put(body.back, x, y, scarfColor(body.back, x, y, 0.86));
        }
      }
    }
    for (let y = 0; y < 3; y++) {
      const width = y === 0 ? 2 : 1;
      for (let x = 0; x < width; x++) {
        put(body.front, x, y, scarfColor(body.front, x, y, 0.94));
        put(
          body.front,
          body.front.w - 1 - x,
          y,
          scarfColor(body.front, body.front.w - 1 - x, y, 0.98),
        );
      }
    }
    for (const side of [body.right, body.left]) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < side.w; x++) {
          if (y === 0 || x === side.w - 1) {
            put(side, x, y, scarfColor(side, x, y, 0.9));
          }
        }
      }
    }

    if (blockAccent) {
      const accentSide = style.headCoveringAccentSide ?? "center";
      const viewerRight = accentSide === "viewer_right";
      const viewerLeft = accentSide === "viewer_left";
      if (viewerRight || viewerLeft) {
        const frontXs = viewerRight ? [6, 7] : [0, 1];
        for (let y = 0; y < over.front.h; y++) {
          for (const x of frontXs) {
            const innerFrameColumn = viewerRight ? x === 6 : x === 1;
            // Preserve the outer-eye overlay window at rows 3-5 while keeping
            // a connected two-pixel accent block around the crown and jaw.
            if (innerFrameColumn && y >= 3 && y <= 5) continue;
            put(over.front, x, y, blockAccent);
          }
        }
        const sideFace = viewerRight ? over.left : over.right;
        for (let y = 0; y < sideFace.h; y++) {
          for (let x = 0; x < Math.ceil(sideFace.w / 2); x++) {
            put(sideFace, x, y, shadeRgb(blockAccent, 0.92));
          }
        }
        const bodyEdgeXs = viewerRight
          ? [body.front.w - 2, body.front.w - 1]
          : [0, 1];
        for (let y = 0; y < 3; y++) {
          for (const x of bodyEdgeXs) {
            put(body.front, x, y, shadeRgb(blockAccent, 0.9));
          }
        }
        const bodySide = viewerRight ? body.left : body.right;
        for (let y = 0; y < 3; y++) {
          for (let x = 0; x < bodySide.w; x++) {
            put(bodySide, x, y, shadeRgb(blockAccent, 0.86));
          }
        }
      } else {
        for (const x of [3, 4]) {
          put(over.front, x, 0, blockAccent);
          put(over.top, x, over.top.h - 1, shadeRgb(blockAccent, 1.04));
        }
      }
    }

    if (style.glasses !== "none") {
      const rim = hexToRgb(style.glassesColor, [34, 32, 30]);
      put(over.right, 7, 3, rim);
      put(over.left, 0, 3, rim);
    }
    return;
  }

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
          shadeBase(rect, x, y, (x + y) % 3 === 0 ? 1.18 : 0.78);
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
  if (topType === "jersey") {
    // Athletic fabric needs a restrained woven/vented base cue in addition
    // to the raised neckline and hem. Keep it deterministic and continuous on
    // all four torso faces so it reads as material rather than random noise.
    for (const rect of [
      body.base.front,
      body.base.back,
      body.base.right,
      body.base.left,
    ]) {
      for (let y = 2; y < rect.h - 1; y++) {
        for (let x = 1; x < rect.w - 1; x++) {
          const phase = (x + y + rect.x) % 4;
          if (phase === 0) shadeBase(rect, x, y, 1.08);
          else if (phase === 2) shadeBase(rect, x, y, 0.88);
        }
      }
    }
  }
  const outerGarment = style.outerGarment ?? "none";
  const shoulderHairRows = hairBodyRows(style);
  const shoulderHairLayer = shoulderHairRows > 0;
  const armHairRows =
    shoulderHairRows === 0 ? 0 : shoulderHairRows <= 4 ? 4 : 6;
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
    layeredTop && !shoulderHairLayer,
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
      paintGarmentTop(
        arm.base.top,
        arm.overlay.top,
        sleeveColor,
        layeredTop && !shoulderHairLayer,
      );
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

  if (topType === "jersey") {
    const jersey = declaredTopColor ?? averageRect(baseFront, 2, 6);
    const jerseyLight = mixRgb(jersey, [255, 230, 220], 0.2);
    const jerseyDark = shadeRgb(jersey, 0.66);
    const jerseyAccent = hexToRgb(style.topAccentColor ?? "", jerseyLight);
    const accentDistance =
      Math.abs(jerseyAccent[0] - jersey[0]) +
      Math.abs(jerseyAccent[1] - jersey[1]) +
      Math.abs(jerseyAccent[2] - jersey[2]);
    put(front, 2, 0, jerseyLight);
    put(front, 5, 0, shadeRgb(jerseyLight, 0.92));
    put(front, 3, 1, jerseyDark);
    put(front, 4, 1, shadeRgb(jerseyDark, 0.9));
    put(front, 2, 2, shadeRgb(jerseyLight, 0.88));
    put(front, 5, 2, shadeRgb(jerseyLight, 0.8));
    if (accentDistance >= 36) {
      put(front, 1, 0, jerseyAccent);
      put(front, front.w - 2, 0, shadeRgb(jerseyAccent, 0.9));
      put(front, 0, 2, shadeRgb(jerseyAccent, 0.94));
      put(front, front.w - 1, 2, shadeRgb(jerseyAccent, 0.84));
      for (const part of ["rightArm", "leftArm"] as const) {
        const sleeve = CLASSIC_LAYOUT[part].overlay.front;
        put(sleeve, 1, 0, jerseyAccent);
        put(sleeve, sleeve.w - 2, 0, shadeRgb(jerseyAccent, 0.86));
      }
    }
    if (style.topGraphic) {
      const graphicX =
        style.topGraphicSide === "viewer_left"
          ? 1
          : style.topGraphicSide === "viewer_right"
            ? 5
            : 3;
      const graphicColor =
        accentDistance >= 36
          ? jerseyAccent
          : mixRgb(jersey, [255, 245, 210], 0.72);
      // Three connected raised pixels survive normal preview scale as a
      // compact badge/crest instead of becoming unstructured shirt noise.
      put(front, graphicX, 3, graphicColor);
      put(front, graphicX + 1, 3, shadeRgb(graphicColor, 0.82));
      put(front, graphicX, 4, shadeRgb(graphicColor, 0.68));
    }
    for (const y of [1, 4, 7] as const) {
      put(front, 0, y, y === 4 ? jerseyLight : jerseyDark);
      put(
        front,
        front.w - 1,
        y,
        shadeRgb(y === 4 ? jerseyLight : jerseyDark, 0.86),
      );
    }
    for (let x = 1; x < front.w - 1; x++) {
      put(
        front,
        x,
        front.h - 1,
        x % 2 === 0 ? jerseyDark : shadeRgb(jerseyDark, 0.88),
      );
    }
    for (const part of ["rightArm", "leftArm"] as const) {
      const cuff = CLASSIC_LAYOUT[part].overlay.front;
      for (let x = 0; x < cuff.w; x++) {
        put(cuff, x, cuff.h - 1, x % 2 === 0 ? jerseyDark : jerseyLight);
      }
    }
  }

  if (texture === "knit") {
    const knitBase = declaredTopColor ?? averageRect(baseFront, 2, 6);
    const cableLight = mixRgb(knitBase, [250, 244, 232], 0.34);
    const cableDark = shadeRgb(knitBase, 0.66);
    // Raised ribbing around the neckline anchors the cable pattern to a
    // recognisable sweater construction instead of isolated torso speckles.
    for (const [x, y, color] of [
      [2, 0, cableDark],
      [3, 1, cableLight],
      [4, 1, shadeRgb(cableLight, 0.86)],
      [5, 0, shadeRgb(cableDark, 0.86)],
      [2, 1, shadeRgb(cableLight, 0.78)],
      [5, 1, shadeRgb(cableDark, 0.92)],
    ] as const) {
      put(front, x, y, color);
    }
    const startY = Math.max(2, shoulderHairRows);
    for (let y = startY; y < front.h - 1; y++) {
      const leftX = y % 2 === 0 ? 2 : 3;
      const rightX = 7 - leftX;
      put(front, leftX, y, y % 3 === 0 ? cableDark : cableLight);
      put(
        front,
        rightX,
        y,
        y % 3 === 0 ? shadeRgb(cableDark, 0.9) : shadeRgb(cableLight, 0.88),
      );
      if (y % 2 === 0) {
        put(back, 3, y, shadeRgb(cableLight, 0.82));
        put(back, 4, y, cableDark);
      }
    }
    for (const part of ["rightArm", "leftArm"] as const) {
      const sleeve = CLASSIC_LAYOUT[part].overlay.front;
      for (let y = Math.max(2, armHairRows); y < sleeve.h - 1; y += 2) {
        put(
          sleeve,
          y % 4 === 0 ? 1 : 2,
          y,
          y % 4 === 0 ? cableLight : cableDark,
        );
      }
    }
  }

  if (layer !== "none" || ["sweater", "hoodie", "jacket"].includes(topType)) {
    // 어깨 솔기와 밑단
    for (let y = 0; y < front.h - 1; y++) {
      if (y < shoulderHairRows) continue;
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
      if (shoulderHairRows === 0) {
        for (let x = 0; x < dstRect.w; x++)
          volumeCopy(srcRect, dstRect, x, 0, "lit");
      }
      for (let y = 1; y < dstRect.h - 1; y++) {
        if (y < shoulderHairRows) continue;
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
        const panelTone = shadeRgb(panelColor, shade);
        // The base cube carries the continuous cardigan fabric. The enlarged
        // cube keeps the opening trim and intermittent edge clusters, avoiding
        // four uninterrupted raised columns that read as a rigid breastplate.
        put(baseFront, x, y, shadeRgb(panelTone, 0.98));
        const reservedForShoulderHair = y < shoulderHairRows;
        if (
          !reservedForShoulderHair &&
          (x === 2 ||
            x === 5 ||
            y === 0 ||
            y === front.h - 1 ||
            ((x === 0 || x === 7) && y % 2 === 0))
        ) {
          put(front, x, y, panelTone);
        }
      }
      if (y >= shoulderHairRows) {
        put(front, 2, y, y % 3 === 0 ? trimColor : shadeRgb(trimColor, 1.08));
        put(front, 5, y, y % 3 === 0 ? shadeRgb(trimColor, 0.86) : trimColor);
      }
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
        if (y < shoulderHairRows) continue;
        put(front, x, y, shadeRgb(panelColor, 0.82));
      }
      for (let y = front.h - 4; y < front.h; y++) {
        if (y < shoulderHairRows) continue;
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
        if (y < shoulderHairRows) continue;
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
        if (y < shoulderHairRows) continue;
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
        if (y < shoulderHairRows) continue;
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
    if (outerGarment === "open_jacket") {
      const lapelLight = mixRgb(panelColor, [224, 226, 230], 0.38);
      const lapelMid = mixRgb(panelColor, [176, 180, 186], 0.22);
      const lapelDark = shadeRgb(panelColor, 0.54);
      // An open tailored jacket needs to occupy a meaningful part of the
      // enlarged torso cube. Sparse piping alone reads as a flat dark shirt
      // in a six-view render, so build two raised front panels while leaving
      // the central shirt-and-tie opening unobstructed.
      for (let y = 1; y < front.h - 1; y++) {
        if (y < shoulderHairRows) continue;
        for (const x of [0, 1, 6, 7] as const) {
          const outerEdge = x === 0 || x === 7;
          const fold = (x + y) % 4 === 0;
          put(
            front,
            x,
            y,
            fold ? lapelMid : shadeRgb(panelColor, outerEdge ? 0.8 : 0.94),
          );
        }
      }
      for (const [x, y, color] of [
        [2, 0, lapelLight],
        [5, 0, shadeRgb(lapelLight, 0.9)],
        [2, 1, lapelLight],
        [5, 1, shadeRgb(lapelLight, 0.84)],
        [2, 2, lapelMid],
        [5, 2, lapelDark],
        [1, 3, shadeRgb(lapelLight, 0.78)],
        [6, 3, shadeRgb(lapelLight, 0.7)],
        [1, 4, lapelMid],
        [6, 4, shadeRgb(lapelMid, 0.82)],
        [2, 5, lapelDark],
        [5, 5, shadeRgb(lapelDark, 0.86)],
        [1, 7, shadeRgb(lapelLight, 0.7)],
        [6, 7, shadeRgb(lapelLight, 0.64)],
      ] as const) {
        if (y >= shoulderHairRows) put(front, x, y, color);
      }
    }

    for (let x = 0; x < back.w; x++) {
      if (!shoulderHairLayer) {
        put(
          back,
          x,
          0,
          shadeRgb(panelColor, x === 0 || x === back.w - 1 ? 0.82 : 1.02),
        );
      }
      put(back, x, back.h - 1, hemPanel);
    }
    for (let y = 1; y < back.h - 1; y++) {
      const reservedForShoulderHair = y < shoulderHairRows;
      if (!reservedForShoulderHair) {
        put(back, 0, y, shadeRgb(panelColor, 0.82));
        if (y % 2 === 0) put(back, back.w - 1, y, shadeRgb(panelColor, 0.9));
      }
      if (
        !reservedForShoulderHair &&
        (outerGarment === "cardigan" || outerGarment === "coat") &&
        y % 3 === 1
      ) {
        put(back, 3, y, shadeRgb(panelColor, y >= back.h - 3 ? 0.7 : 0.84));
        put(back, 4, y, shadeRgb(panelColor, y >= back.h - 3 ? 0.64 : 0.78));
      }
    }
    for (const rect of [body.overlay.right, body.overlay.left]) {
      for (let x = 0; x < rect.w; x++) {
        if (!shoulderHairLayer) put(rect, x, 0, litPanel);
        put(rect, x, rect.h - 1, hemPanel);
      }
      for (let y = 1; y < rect.h - 1; y++) {
        const reservedForShoulderHair = y < shoulderHairRows;
        if (!reservedForShoulderHair) {
          put(rect, 0, y, shadeRgb(panelColor, 0.82));
          if (y % 2 === 0) put(rect, rect.w - 1, y, shadeRgb(panelColor, 0.92));
        }
        if (
          !reservedForShoulderHair &&
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
        const pocketY = Math.min(rect.h - 3, 7);
        if (pocketY >= shoulderHairRows) {
          put(rect, 1, pocketY, sidePocketLight);
          put(rect, 2, pocketY, sidePocketShadow);
        }
        put(rect, 0, rect.h - 2, sidePocketShadow);
        put(rect, rect.w - 1, rect.h - 2, shadeRgb(sidePocketLight, 0.78));
        for (let y = 1; y < rect.h - 2; y += 2) {
          if (y < shoulderHairRows) continue;
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
          const seamX = part === "rightArm" ? 0 : dst.w - 1;
          if (armHairRows === 0) {
            for (const x of shoulderXs)
              put(dst, x, 0, shadeRgb(panelColor, 1.06));
          }
          for (let x = 0; x < dst.w; x++) {
            const cuffEdge = x === seamX;
            if (cuffEdge) put(dst, x, dst.h - 1, shadeRgb(panelColor, 0.72));
          }
          for (const y of [1, 5, 9] as const) {
            if (y >= dst.h - 1) continue;
            if (y < armHairRows) continue;
            put(dst, seamX, y, shadeRgb(panelColor, 0.84));
          }
          for (const foldY of [3, 6] as const) {
            if (foldY >= dst.h - 2) continue;
            if (foldY < armHairRows) continue;
            if (!broadFace) continue;
            const highlightX = part === "rightArm" ? 1 : dst.w - 2;
            put(dst, highlightX, foldY, shadeRgb(panelColor, 0.78));
            put(dst, highlightX, foldY + 1, shadeRgb(panelColor, 1.1));
          }
          if (outerGarment === "cardigan" && broadFace) {
            const cuffLight = mixRgb(panelColor, [255, 238, 232], 0.18);
            const cuffShadow = shadeRgb(panelColor, 0.58);
            const sleeveYarn = mixRgb(panelColor, [255, 238, 232], 0.14);
            const cuffXs =
              part === "rightArm" ? [0, 1] : [dst.w - 2, dst.w - 1];
            for (const x of cuffXs)
              put(
                dst,
                x,
                dst.h - 2,
                x === 0 || x === dst.w - 1
                  ? cuffShadow
                  : shadeRgb(cuffLight, 0.76),
              );
            for (let y = 1; y < dst.h - 3; y += 2) {
              if (y < armHairRows) continue;
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
          if (armHairRows === 0) {
            for (let x = 0; x < arm.overlay.top.w; x++)
              put(
                arm.overlay.top,
                x,
                0,
                x === 0 || x === arm.overlay.top.w - 1
                  ? shoulderShadow
                  : shoulderLight,
              );
          }
          const bottomCuffXs =
            part === "rightArm"
              ? [0, 1]
              : [arm.overlay.bottom.w - 2, arm.overlay.bottom.w - 1];
          for (const x of bottomCuffXs)
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
    for (let x = 1; x < 7; x++) {
      if (shoulderHairLayer && (x === 1 || x === 6)) continue;
      volumeCopy(baseFront, front, x, 0, "lit");
    }
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
      if (!shoulderHairLayer) {
        put(front, 1, 2, shadeRgb(paleAccent, 1.08));
        put(front, 6, 2, shadeRgb(paleAccent, 0.88));
      }
      put(front, 2, 2, shadeRgb(paleAccent, 0.92));
      put(front, 5, 2, shadeRgb(paleAccent, 0.86));
      put(front, 3, 3, paleAccent);
      put(front, 4, 3, shadeRgb(paleAccent, 0.9));
      if (!shoulderHairLayer) {
        put(front, 1, 1, shadeRgb(paleAccent, 1.04));
        put(front, 6, 1, shadeRgb(paleAccent, 0.94));
      }
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
      if (!shoulderHairLayer) {
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
      }
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
        if (!shoulderHairLayer) put(front, 1, 2, bowLight);
        put(front, 2, 2, paleAccent);
        put(front, 5, 2, bowMid);
        if (!shoulderHairLayer) put(front, 6, 2, bowDeep);
        put(front, 2, 3, bowLight);
        put(front, 3, 3, shirtPanel);
        put(front, 4, 3, shadeRgb(shirtPanel, 0.88));
        put(front, 5, 3, bowMid);
        put(front, 3, 4, paleAccent);
        put(front, 4, 4, bowDeep);
        put(front, 4, 5, bowDeep);
        put(front, 3, 6, shadeRgb(bowMid, 0.84));
        put(front, 4, 6, shadeRgb(bowDeep, 0.86));
        if (!shoulderHairLayer) {
          put(body.overlay.top, 1, body.overlay.top.h - 1, bowLight);
          put(body.overlay.top, 6, body.overlay.top.h - 1, bowDeep);
          put(body.overlay.right, 0, 0, bowLight);
          put(body.overlay.right, 1, 2, bowMid);
          put(body.overlay.left, body.overlay.left.w - 1, 0, bowMid);
          put(body.overlay.left, body.overlay.left.w - 2, 2, bowDeep);
        }
      }
    } else if (neckAccessory === "tie") {
      const tie = hexToRgb(style.neckAccessoryColor ?? "", darkAccent);
      const tieStripe = mixRgb(tie, paleAccent, 0.65);
      // Crisp shirt collar remains visible around the raised tie and jacket.
      for (const [x, y] of [
        [1, 0],
        [2, 0],
        [5, 0],
        [6, 0],
        [2, 1],
        [5, 1],
      ] as const) {
        put(front, x, y, x < 4 ? paleAccent : accentShadow);
      }
      put(front, 3, 1, tie);
      put(front, 4, 1, shadeRgb(tie, 0.9));
      put(
        front,
        3,
        2,
        style.neckAccessoryPattern === "striped"
          ? tieStripe
          : shadeRgb(tie, 1.08),
      );
      put(front, 4, 2, tie);
      put(front, 3, 3, tie);
      put(
        front,
        4,
        3,
        style.neckAccessoryPattern === "striped"
          ? shadeRgb(tieStripe, 0.84)
          : shadeRgb(tie, 0.82),
      );
      put(front, 3, 4, shadeRgb(tie, 0.72));
      if (style.neckAccessoryPattern === "striped") {
        put(front, 3, 4, shadeRgb(tieStripe, 0.78));
        put(front, 4, 4, shadeRgb(tie, 0.68));
        put(front, 3, 5, shadeRgb(tie, 0.64));
        put(front, 4, 5, shadeRgb(tieStripe, 0.7));
      }
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
    outerGarment === "none" &&
    (style.sleeveLength === "long" ||
      ["sweater", "hoodie", "jacket"].includes(topType))
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
    const declaredBottomColor = style.bottomColor
      ? hexToRgb(style.bottomColor, sampledBottomColor)
      : null;
    const chromaAlignedBottom = declaredBottomColor
      ? alignRgbChroma(sampledBottomColor, declaredBottomColor, 0.94)
      : sampledBottomColor;
    const declaredBottomLuminance = declaredBottomColor
      ? declaredBottomColor[0] * 0.299 +
        declaredBottomColor[1] * 0.587 +
        declaredBottomColor[2] * 0.114
      : 255;
    // Chroma-only alignment turns a declared black skirt into light gray when
    // the procedural guide exposed bare skin below a short fallback enum.
    // Honor explicit very-dark garment luminance while retaining enough of the
    // sampled value for folds and subsequent shading to remain readable.
    const bottomColor =
      declaredBottomColor && declaredBottomLuminance < 70
        ? mixRgb(chromaAlignedBottom, declaredBottomColor, 0.8)
        : chromaAlignedBottom;
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
            (y === rect.h - 1 &&
              (x === 0 ||
                x === rect.w - 1 ||
                x % 2 === 0 ||
                x === Math.floor(rect.w / 2) - 1 ||
                x === Math.floor(rect.w / 2))) ||
            x === 0 ||
            x === rect.w - 1 ||
            (bottomPattern === "plaid" &&
              (x === 1 ||
                x === 5 ||
                (localY === 1 && (x <= 2 || x === rect.w - 2)))) ||
            (bottomPattern === "pleated" && x % 3 === 1);
          if (raised) put(rect, x, y, color);
        }
      }
    };

    const longSkirt =
      style.bottomType === "skirt" && style.bottomLength === "long";
    const torsoRows = style.bottomType === "skirt" ? 4 : 2;
    paintLowerTorso(body.base.front, front, torsoRows);
    paintLowerTorso(body.base.back, back, torsoRows);
    if (longSkirt) {
      const waist = mixRgb(bottomColor, [132, 132, 132], 0.24);
      const waistY = front.h - torsoRows;
      for (let x = 0; x < front.w; x++) {
        put(front, x, waistY, x % 2 === 0 ? waist : shadeRgb(waist, 0.78));
        put(back, x, waistY, shadeRgb(waist, 0.82));
      }
    }
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
            (y === rect.h - 1 &&
              (x === 0 ||
                x === rect.w - 1 ||
                x % 2 === 0 ||
                x === Math.floor(rect.w / 2) - 1 ||
                x === Math.floor(rect.w / 2))) ||
            x === 0 ||
            x === rect.w - 1 ||
            (bottomPattern === "plaid" &&
              (x === 1 || x === rect.w - 2 || (localY === 1 && x <= 1))) ||
            (bottomPattern === "pleated" && centerPleat);
          if (raised) put(rect, x, y, color);
        }
      }
    };
    paintSideLowerTorso(body.base.right, body.overlay.right, torsoRows);
    paintSideLowerTorso(body.base.left, body.overlay.left, torsoRows);

    for (const part of ["rightLeg", "leftLeg"] as const) {
      const leg = CLASSIC_LAYOUT[part];
      // Long/maxi skirts continue down both leg cuboids while leaving the last
      // rows available for shoes. This is the Minecraft-compatible way to keep
      // a full-length silhouette without inventing geometry outside the atlas.
      const coverRows = longSkirt ? 9 : style.bottomType === "skirt" ? 3 : 2;
      for (const faceName of ["front", "back", "right", "left"] as const) {
        const baseRect = leg.base[faceName];
        const dst = leg.overlay[faceName];
        for (let y = 0; y < coverRows; y++) {
          for (let x = 0; x < dst.w; x++) {
            const tone =
              y === 0 ? litColor : y === coverRows - 1 ? hemColor : bottomColor;
            let color = tone;
            if (
              longSkirt &&
              y > 0 &&
              y < coverRows - 1 &&
              (faceName === "front" || faceName === "back")
            ) {
              const pleatHighlight = mixRgb(bottomColor, [126, 126, 126], 0.28);
              color = x % 2 === 0 ? pleatHighlight : shadeRgb(bottomColor, 0.7);
            }
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
            // The leg base carries the continuous skirt/short fabric. The
            // outer layer keeps only the pleat ridges, crossing threads and
            // stepped hem, so gaps read as depth instead of missing clothing.
            put(baseRect, x, y, shadeRgb(color, 0.98));
            const raised = longSkirt
              ? faceName === "front" || faceName === "back"
                ? true
                : x === 0 || x === dst.w - 1 || y === coverRows - 1
              : bottomPattern === "plaid"
                ? (y === 0 &&
                    (faceName === "front" || faceName === "back"
                      ? x === 1 || x === 2
                      : x === 0 || x === 1)) ||
                  (y === 1 && x <= 2) ||
                  (y === coverRows - 1 && x % 2 === 0)
                : bottomPattern === "pleated"
                  ? x === 1 || (y === coverRows - 1 && x % 2 === 0)
                  : bottomPattern === "lace"
                    ? y === coverRows - 1 && x % 2 === 0
                    : (y === 0 && x === 1) ||
                      (y === coverRows - 1 && x % 2 === 0);
            if (raised) put(dst, x, y, color);
          }
        }
      }
      const frontLeg = leg.overlay.front;
      const seamX = part === "rightLeg" ? frontLeg.w - 1 : 0;
      put(frontLeg, seamX, coverRows - 1, shadeRgb(bottomColor, 0.66));
    }

    if (bottomPattern === "plaid") {
      const paintPlaidTorsoWrap = (rect: Rect) => {
        const startY = rect.h - torsoRows;
        const midY = Math.min(rect.h - 1, startY + 1);
        const lowY = Math.max(startY, rect.h - 2);
        for (let x = 0; x < rect.w; x++) {
          const thread =
            x % 2 === 0 ? plaidThread : shadeRgb(plaidThread, 0.82);
          if (x <= 2 || x >= rect.w - 2 || (rect.w <= 4 && x === rect.w - 2)) {
            put(
              rect,
              x,
              midY,
              x === 1 || x === rect.w - 2 ? plaidCross : thread,
            );
          }
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
      // Track-pant stripes must remain visibly lighter than dark inferred
      // trousers after renderer lighting; a small neutral blend turns muddy.
      const stripe = mixRgb(waistColor, [246, 246, 242], 0.76);
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
      const ribbonLight = shadeRgb(ribbon, 1.08);
      for (const rect of [
        body.overlay.front,
        body.overlay.back,
        body.overlay.right,
        body.overlay.left,
      ]) {
        const y = Math.max(0, rect.h - 3);
        for (let x = 0; x < rect.w; x++) {
          put(rect, x, y, x % 2 === 0 ? ribbon : ribbonDark);
        }
      }
      const y = Math.max(0, front.h - 4);
      for (const [x, dy, color] of [
        [2, 0, ribbonLight],
        [3, 1, ribbonDark],
        [4, 1, ribbonLight],
        [5, 0, ribbon],
        [2, 2, ribbonDark],
        [5, 2, ribbonDark],
      ] as const) {
        put(front, x, y + dy, color);
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
      if (y === 0) {
        put(rightLeg.front, 0, y, shadeRgb(tailColor, shade));
        put(rightLeg.front, 1, y, trimColor);
        put(leftLeg.front, 2, y, shadeRgb(trimColor, 0.88));
        put(leftLeg.front, 3, y, shadeRgb(tailColor, shade - 0.02));
      } else if (y === 1) {
        put(rightLeg.front, 0, y, shadeRgb(tailColor, 1.02));
        put(leftLeg.front, 3, y, shadeRgb(tailColor, 1));
      } else {
        put(rightLeg.front, 1, y, trimColor);
        put(leftLeg.front, 2, y, shadeRgb(trimColor, 0.88));
      }

      // Side and rear tails are narrow turning clusters, not four complete
      // panels on every leg face. Their staggered inner pixel communicates a
      // fold while the transparent neighbours keep the hem from becoming a
      // rigid skirt-shaped box.
      for (const [rect, edgeX, foldX] of [
        [rightLeg.right, 0, 1],
        [leftLeg.left, leftLeg.left.w - 1, leftLeg.left.w - 2],
      ] as const) {
        if (y === 0) continue;
        const x = y === 1 ? foldX : edgeX;
        put(
          rect,
          x,
          y,
          shadeRgb(tailColor, lower ? 0.68 : y === 1 ? 0.9 : 0.78),
        );
      }
      for (const [rect, edgeX, foldX] of [
        [rightLeg.back, 0, 1],
        [leftLeg.back, leftLeg.back.w - 1, leftLeg.back.w - 2],
      ] as const) {
        if (y === 0) continue;
        const x = y === 1 ? foldX : edgeX;
        put(
          rect,
          x,
          y,
          y === 1
            ? shadeRgb(foldLight, 0.9)
            : shadeRgb(trimColor, lower ? 0.62 : 0.78),
        );
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

  // Keep the always-present shoe lift deliberately tiny. The base layer
  // already carries the complete shoe; lifting two full rows on all four
  // faces plus the whole sole made every footwear style a rectangular shell
  // before its actual straps/laces were even authored below.
  for (const part of ["rightLeg", "leftLeg"] as const) {
    const leg = CLASSIC_LAYOUT[part];
    const front = leg.overlay.front;
    const outerToeX = part === "rightLeg" ? 0 : front.w - 1;
    volumeCopy(leg.base.front, front, outerToeX, front.h - 1, "mid");
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
        // Mary Janes read from the bow, instep strap, toe corners and heel
        // anchors. Leave the remaining base pixels visible instead of adding
        // a second complete shoe cuboid.
        put(front, 1, front.h - 2, shoeAccent);
        put(front, 2, front.h - 2, shadeRgb(shoeAccent, 0.88));
        put(front, 0, front.h - 1, sole);
        put(front, 2, front.h - 1, shoeShadow);
        put(front, 1, front.h - 3, shoeBright);
        put(front, 2, front.h - 3, bowShadow);
        const rightSide = leg.overlay.right;
        const leftSide = leg.overlay.left;
        put(rightSide, 0, rightSide.h - 2, shoeAccent);
        put(rightSide, rightSide.w - 1, rightSide.h - 3, shoeBright);
        put(rightSide, 0, rightSide.h - 1, sole);
        put(leftSide, 1, leftSide.h - 2, shadeRgb(shoeAccent, 0.88));
        put(leftSide, 0, leftSide.h - 3, bowShadow);
        put(leg.overlay.bottom, 0, 0, sole);
        put(leg.overlay.bottom, 0, leg.overlay.bottom.h - 1, soleShadow);
        put(
          leg.overlay.back,
          2,
          leg.overlay.back.h - 2,
          shadeRgb(shoeAccent, 0.9),
        );
        put(leg.overlay.back, 0, leg.overlay.back.h - 2, shoeBright);
        put(leg.overlay.back, 1, leg.overlay.back.h - 3, strapDeep);
        put(leg.overlay.back, 2, leg.overlay.back.h - 3, shoeBright);
      }
    }
  }

  const legwear = style.legwear ?? "none";
  if (legwear !== "none") {
    const asym = style.legwearAsymmetry ?? "none";
    // Analysis side labels are always from the viewer's perspective. In a
    // front-facing Minecraft model, viewer-left is the character's right leg
    // and viewer-right is the character's left leg.
    const targetParts =
      asym === "left"
        ? (["rightLeg"] as const)
        : asym === "right"
          ? (["leftLeg"] as const)
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
      const inferredBaseColor =
        legwear === "stockings"
          ? mixRgb(skinish, [95, 72, 76], 0.52)
          : legwear === "leg_warmers"
            ? mixRgb(garment, [244, 232, 226], 0.38)
            : mixRgb(skinish, [246, 240, 232], 0.68);
      const declaredLegwearColor = style.legwearColor
        ? hexToRgb(style.legwearColor, inferredBaseColor)
        : null;
      const baseColor = declaredLegwearColor
        ? mixRgb(
            declaredLegwearColor,
            legwear === "stockings" ? skinish : [250, 242, 234],
            legwear === "stockings" ? 0.08 : 0.14,
          )
        : inferredBaseColor;
      const topLace = shadeRgb(mixRgb(baseColor, [255, 250, 244], 0.55), 1.08);
      const ribLight = mixRgb(baseColor, [255, 248, 240], 0.22);
      const ribShadow = shadeRgb(baseColor, 0.96);

      if (legwear === "leg_warmers") {
        const laceY = Math.max(0, legwearRows.start - 1);
        const cuffY = legwearRows.end;
        const cuffLight = shadeRgb(
          mixRgb(baseColor, [255, 250, 244], 0.42),
          1.04,
        );
        const cuffDark = shadeRgb(baseColor, 0.78);
        const scallopLight = shadeRgb(topLace, 1.08);
        const scallopShadow = shadeRgb(topLace, 0.86);

        // The continuous knitted tube belongs on the base layer. Reset only
        // its occupied outer-layer rows, then author isolated slouch folds,
        // lace and cuff anchors. This preserves a readable fabric silhouette
        // without turning all four leg faces into a second solid cuboid.
        for (const faceName of ["front", "back", "right", "left"] as const) {
          const baseRect = leg.base[faceName];
          const overRect = leg.overlay[faceName];
          for (let y = legwearRows.start; y <= legwearRows.end; y++) {
            for (let x = 0; x < baseRect.w; x++) {
              const edge = x === 0 || x === baseRect.w - 1;
              const wrinkle = edge ? 0.9 : y % 2 === 0 ? 0.94 : 1.02;
              put(baseRect, x, y, shadeRgb(baseColor, wrinkle));
            }
          }
          for (let y = laceY; y <= cuffY; y++) {
            for (let x = 0; x < overRect.w; x++) clear(overRect, x, y);
          }
        }

        const paint = (
          rect: Rect,
          points: readonly (readonly [number, number, Rgb])[],
        ) => {
          for (const [x, y, color] of points) put(rect, x, y, color);
        };
        const front = leg.overlay.front;
        const back = leg.overlay.back;
        const right = leg.overlay.right;
        const left = leg.overlay.left;

        paint(front, [
          [0, laceY, scallopLight],
          [1, laceY, scallopShadow],
          [2, laceY, scallopLight],
          [3, laceY, scallopShadow],
          [0, legwearRows.start, topLace],
          [1, legwearRows.start, shadeRgb(topLace, 0.82)],
          [2, legwearRows.start, topLace],
          [3, legwearRows.start, shadeRgb(topLace, 0.82)],
          [1, 3, shadeRgb(ribShadow, 0.86)],
          [2, 3, scallopShadow],
          [1, 4, ribLight],
          [2, 5, shadeRgb(ribShadow, 0.9)],
          [1, 6, ribLight],
          [2, 6, shadeRgb(ribShadow, 0.84)],
          [1, 7, shadeRgb(ribShadow, 0.88)],
          [1, cuffY - 1, cuffLight],
          [2, cuffY - 1, shadeRgb(cuffLight, 0.92)],
          [1, cuffY, cuffDark],
          [2, cuffY, shadeRgb(cuffDark, 0.92)],
        ]);
        paint(back, [
          [1, laceY, scallopShadow],
          [2, laceY, scallopLight],
          [0, legwearRows.start, shadeRgb(topLace, 0.82)],
          [1, legwearRows.start, topLace],
          [2, legwearRows.start, shadeRgb(topLace, 0.82)],
          [3, legwearRows.start, topLace],
          [1, 3, ribLight],
          [2, 3, shadeRgb(ribShadow, 0.88)],
          [1, 5, shadeRgb(ribShadow, 0.9)],
          [2, 6, ribLight],
          [2, 7, shadeRgb(ribShadow, 0.84)],
          [1, cuffY - 1, cuffLight],
          [1, cuffY, cuffDark],
          [2, cuffY, shadeRgb(cuffDark, 0.92)],
        ]);
        paint(right, [
          [0, laceY, scallopLight],
          [1, laceY, scallopShadow],
          [0, legwearRows.start, topLace],
          [1, legwearRows.start, shadeRgb(topLace, 0.82)],
          [1, 4, ribLight],
          [0, 5, shadeRgb(ribShadow, 0.86)],
          [1, 7, shadeRgb(ribShadow, 0.9)],
          [1, cuffY - 1, cuffLight],
          [0, cuffY, cuffDark],
        ]);
        paint(left, [
          [0, laceY, scallopLight],
          [3, laceY, scallopShadow],
          [2, legwearRows.start, shadeRgb(topLace, 0.82)],
          [3, legwearRows.start, topLace],
          [2, 4, ribLight],
          [3, 5, shadeRgb(ribShadow, 0.84)],
          [2, 7, shadeRgb(ribShadow, 0.9)],
          [2, cuffY - 1, cuffLight],
          [0, cuffY, cuffDark],
          [3, cuffY, shadeRgb(cuffDark, 0.9)],
        ]);

        return;
      }

      for (const faceName of ["front", "back", "right", "left"] as const) {
        const baseRect = leg.base[faceName];
        const overRect = leg.overlay[faceName];
        for (let y = legwearRows.start; y <= legwearRows.end; y++) {
          for (let x = 0; x < baseRect.w; x++) {
            const wrinkle = x === 0 || x === baseRect.w - 1 ? 0.9 : 1.02;
            put(baseRect, x, y, shadeRgb(baseColor, wrinkle));
          }
          // A single raised rib keeps long socks readable in profile while
          // the base layer carries the continuous fabric colour.
          const ribX =
            faceName === "left" ? overRect.w - 1 : faceName === "right" ? 0 : 1;
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
      }
    };

    for (const part of targetParts) drawLegwear(part);
  }

  const thighAccessory = style.thighAccessory ?? "none";
  const thighAccessorySide = style.thighAccessorySide ?? "none";
  if (thighAccessory !== "none" && thighAccessorySide !== "none") {
    const targetParts =
      thighAccessorySide === "left"
        ? (["rightLeg"] as const)
        : thighAccessorySide === "right"
          ? (["leftLeg"] as const)
          : (["rightLeg", "leftLeg"] as const);
    const accent = hexToRgb(style.topAccentColor ?? "", [248, 242, 232]);
    const light = shadeRgb(mixRgb(accent, [255, 250, 244], 0.36), 1.04);
    const mid = shadeRgb(accent, 0.88);
    const shade = shadeRgb(accent, 0.68);
    const deep = shadeRgb(accent, 0.48);
    const bowKnot = shadeRgb(accent, 0.72);

    const drawThighAccessory = (part: "rightLeg" | "leftLeg") => {
      const leg = CLASSIC_LAYOUT[part].overlay;
      const outerSide = part === "rightLeg" ? leg.right : leg.left;
      const frontX = (x: number) =>
        part === "rightLeg" ? x : leg.front.w - 1 - x;

      if (thighAccessory === "bow") {
        // Keep only a single continuous strap around the thigh. Filling two
        // complete rows made a small bow read as a rigid dark cuff in 3D.
        for (const rect of [leg.front, leg.right, leg.left, leg.back]) {
          for (let x = 0; x < rect.w; x++) {
            put(rect, x, 2, x % 2 === 0 ? accent : shade);
          }
        }

        // A compact front-facing silhouette: two raised loops, a shaded knot,
        // and separated tails. Transparent corners preserve the leg contour.
        for (const [x, y, color] of [
          [0, 1, light],
          [2, 1, light],
          [0, 2, light],
          [1, 2, bowKnot],
          [2, 2, accent],
          [0, 3, mid],
        ] as const) {
          // Mirror the front cluster so a one-sided bow always grows toward
          // the selected viewer-outer edge, not toward the gap between legs.
          put(leg.front, frontX(x), y, color);
        }

        // Let the outer loop turn the corner without duplicating the bow on
        // every face. This makes the chosen side legible from a three-quarter
        // view while the back and inner side remain a clean one-pixel strap.
        for (const [x, y, color] of [
          [0, 1, light],
          [0, 2, bowKnot],
          [0, 3, mid],
          [1, 4, shade],
        ] as const) {
          put(outerSide, x, y, color);
        }
      } else if (thighAccessory === "ribbon") {
        for (const rect of [leg.front, leg.back, leg.right, leg.left]) {
          for (let x = 0; x < rect.w; x++) {
            put(rect, x, 2, x % 2 === 0 ? accent : shade);
          }
        }
        put(leg.front, frontX(1), 1, light);
        put(leg.front, frontX(2), 1, mid);
        put(outerSide, 0, 3, mid);
        put(outerSide, 1, 4, deep);
      } else {
        for (const rect of [leg.front, leg.back, leg.right, leg.left]) {
          for (let x = 0; x < rect.w; x++) {
            put(rect, x, 1, x % 2 === 0 ? mid : shade);
            put(rect, x, 2, x % 2 === 0 ? deep : mid);
          }
        }
        put(outerSide, 0, 1, light);
        put(outerSide, 1, 2, deep);
      }

      // Continue the raised attachment onto the top face so the accessory
      // does not terminate as a floating front-only decal at the UV fold.
      put(leg.top, 1, leg.top.h - 1, light);
    };

    for (const part of targetParts) drawThighAccessory(part);
  }

  // Break the perfectly rectangular outer torso at all four shoulder
  // corners. The base layer remains intact, while the raised garment layer
  // steps inward for one row and reads as fabric drape instead of a rigid box.
  if (layeredTop) {
    if (outerGarment === "none") {
      // A single closed top should not inherit saturated segmentation noise
      // from the generated guide at its shoulder rim. Keep the two raised
      // shoulder rows in the analysed garment colour before tapering corners.
      const raisedJerseyAccent =
        topType === "jersey" && style.topAccentColor
          ? hexToRgb(style.topAccentColor, bodyShoulderColor)
          : null;
      const distinctJerseyAccent =
        raisedJerseyAccent !== null &&
        Math.abs(raisedJerseyAccent[0] - bodyShoulderColor[0]) +
          Math.abs(raisedJerseyAccent[1] - bodyShoulderColor[1]) +
          Math.abs(raisedJerseyAccent[2] - bodyShoulderColor[2]) >=
          36;
      for (const rect of [body.overlay.front, body.overlay.back]) {
        for (let y = 0; y <= 1; y++) {
          for (const x of [0, 1, rect.w - 2, rect.w - 1]) {
            const edgeDistance = Math.min(x, rect.w - 1 - x);
            const keepsJerseyShoulderMark =
              distinctJerseyAccent && y === 0 && edgeDistance === 1;
            put(
              rect,
              x,
              y,
              keepsJerseyShoulderMark
                ? shadeRgb(raisedJerseyAccent, x < rect.w / 2 ? 1 : 0.9)
                : shadeRgb(
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

  if (outerGarment === "cardigan" && texture === "knit") {
    // The cardigan and knit passes both add sleeve folds. Remove three
    // overlapping interior highlights per arm so the raised sleeve remains
    // textured without crossing the handcrafted density ceiling.
    for (const part of ["rightArm", "leftArm"] as const) {
      const sleeve = CLASSIC_LAYOUT[part].overlay.front;
      const x = part === "rightArm" ? 1 : sleeve.w - 2;
      for (const y of [6, 7, 9, 10] as const) clear(sleeve, x, y);
    }
  }

  if (outerGarment === "none" && topType === "sweater" && texture === "knit") {
    // A single knit sweater should expose the continuous base fabric between
    // raised cable ribs. Keep the sparse alternating front/back cables—their
    // physical depth is the primary cue that distinguishes knit from a flat
    // grey shirt—while carving paired UV seam gaps around the shell.
    for (const y of [3, 6, 9] as const) {
      clear(body.overlay.front, 0, y);
      clear(body.overlay.right, body.overlay.right.w - 1, y);
      clear(body.overlay.front, body.overlay.front.w - 1, y);
      clear(body.overlay.left, 0, y);
    }
    // Preserve the full front zig-zag cable—the most readable knit cue—while
    // thinning repeated back and sleeve ribs. These coordinates are authored
    // by the knit pass above, unlike generic shell gaps which may already be
    // transparent and therefore do not actually reduce layer density.
    for (const y of [2, 4, 6, 8, 10] as const) {
      clear(body.overlay.back, 3, y);
      clear(body.overlay.back, 4, y);
    }
    // One uninterrupted front cable is sufficient to carry the knit read at
    // normal preview scale. Thin the mirrored rib through the middle rows so
    // the sweater remains layered without turning most of the torso into a
    // second opaque shell.
    for (let y = 2; y <= 9; y++) {
      const leftX = y % 2 === 0 ? 2 : 3;
      clear(body.overlay.front, 7 - leftX, y);
    }
    for (const part of ["rightArm", "leftArm"] as const) {
      const sleeveFront = CLASSIC_LAYOUT[part].overlay.front;
      for (const y of [4, 8, 10] as const) {
        clear(sleeveFront, y % 4 === 0 ? 1 : 2, y);
      }
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
  maxFigures = 2,
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
    return big.slice(0, maxFigures).sort((a, b) => a.x0 - b.x0);
  }
  return big.slice(0, 1);
}

/**
 * The four-view composition guide reserves one quarter of the output for each
 * orthographic view. Prefer those stable slots over a global gap histogram:
 * a loose sleeve, long hair tip, antialiasing or a faint generation artifact
 * can narrow the inter-view gap enough to merge otherwise usable figures.
 *
 * Each slot still has to contain a tall, substantial foreground subject. This
 * prevents four empty/noisy quarters from being accepted merely because the
 * expected layout was requested.
 */
function findFourViewSlotRanges(
  src: RawImage,
  bg: [number, number, number],
): Array<{ x0: number; x1: number }> {
  const ranges: Array<{ x0: number; x1: number }> = [];
  for (let slot = 0; slot < 4; slot++) {
    const slotX0 = Math.floor((src.width * slot) / 4);
    const slotX1 = Math.floor((src.width * (slot + 1)) / 4);
    const columnCounts = new Array<number>(slotX1 - slotX0).fill(0);
    let foregroundCount = 0;
    let minY = src.height;
    let maxY = -1;
    for (let y = 0; y < src.height; y++) {
      for (let x = slotX0; x < slotX1; x++) {
        if (!isCharacterPixel(src, x, y, bg)) continue;
        foregroundCount++;
        columnCounts[x - slotX0]++;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }

    const slotArea = (slotX1 - slotX0) * src.height;
    const subjectHeight = maxY - minY + 1;
    if (
      foregroundCount < slotArea * 0.025 ||
      subjectHeight < Math.max(64, src.height * 0.45)
    ) {
      return [];
    }

    // Ignore isolated one-pixel noise at slot edges while retaining narrow
    // profile views. Eight vertical pixels at 512px output is enough evidence
    // for a real garment/hair edge but rejects stray speckles.
    const columnThreshold = Math.max(3, src.height * 0.015);
    let x0 = -1;
    let x1 = -1;
    for (let localX = 0; localX < columnCounts.length; localX++) {
      if (columnCounts[localX] < columnThreshold) continue;
      if (x0 === -1) x0 = slotX0 + localX;
      x1 = slotX0 + localX + 1;
    }
    if (x0 < 0 || x1 - x0 < Math.max(16, Math.floor(src.width * 0.018))) {
      return [];
    }
    ranges.push({ x0, x1 });
  }
  return ranges;
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

interface SideFigureSlices {
  head: Region;
  body: Region;
  arm: Region;
  leg: Region;
}

function sliceSideFigure(
  src: RawImage,
  bg: [number, number, number],
  xr: { x0: number; x1: number },
): SideFigureSlices | null {
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = xr.x0; x < xr.x1; x++) {
      if (!isCharacterPixel(src, x, y, bg)) continue;
      count++;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const height = maxY - minY + 1;
  if (count < (xr.x1 - xr.x0) * src.height * 0.025 || height < 64) {
    return null;
  }

  const headRows = { y0: minY, y1: minY + height * 0.25 };
  const torsoRows = { y0: headRows.y1, y1: minY + height * 0.625 };
  const legRows = { y0: torsoRows.y1, y1: maxY + 1 };
  const headSpan = columnSpan(src, bg, headRows.y0, headRows.y1, xr);
  const torsoSpan = columnSpan(src, bg, torsoRows.y0, torsoRows.y1, xr);
  const legSpan = columnSpan(src, bg, legRows.y0, legRows.y1, xr);
  if (!headSpan || !torsoSpan || !legSpan) return null;

  const inset = (span: { x0: number; x1: number }, ratio: number): Region => {
    const width = span.x1 - span.x0;
    return {
      x0: span.x0 + width * ratio,
      x1: span.x1 - width * ratio,
      y0: 0,
      y1: 0,
    };
  };
  const body = inset(torsoSpan, 0.18);
  body.y0 = torsoRows.y0;
  body.y1 = torsoRows.y1;
  const arm = inset(torsoSpan, 0.05);
  arm.y0 = torsoRows.y0;
  arm.y1 = torsoRows.y1;
  const leg = inset(legSpan, 0.12);
  leg.y0 = legRows.y0;
  leg.y1 = legRows.y1;
  return {
    head: { ...headSpan, y0: headRows.y0, y1: headRows.y1 },
    body,
    arm,
    leg,
  };
}

export function packFrontViewToAtlas(
  src: RawImage,
  faceStyle: FaceStyle = DEFAULT_FACE_STYLE,
  expectedViews: 2 | 4 = 2,
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

  // Two-view sheets use the free-form histogram. Four-view sheets first use
  // the guide's fixed slots, then fall back to histogram ranges if a slot is
  // genuinely missing.
  const histogramRanges = findFigureRanges(src, bg, expectedViews);
  const slotRanges = expectedViews === 4 ? findFourViewSlotRanges(src, bg) : [];
  const ranges = slotRanges.length === 4 ? slotRanges : histogramRanges;
  if (ranges.length === 0) {
    return null;
  }
  const front = sliceFigure(src, bg, ranges[0]);
  if (!front) {
    return null;
  }
  const back = ranges.length > 1 ? sliceFigure(src, bg, ranges[1]) : null;
  const leftProfile =
    expectedViews === 4 && ranges.length > 2
      ? sliceSideFigure(src, bg, ranges[2])
      : null;
  const rightProfile =
    expectedViews === 4 && ranges.length > 3
      ? sliceSideFigure(src, bg, ranges[3])
      : null;

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
  if (leftProfile) {
    fillRectFromRegion(atlas, head.base.left, src, leftProfile.head, bg, true);
  }
  if (rightProfile) {
    fillRectFromRegion(
      atlas,
      head.base.right,
      src,
      rightProfile.head,
      bg,
      true,
    );
  }
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
  if (leftProfile) {
    fillRectFromRegion(atlas, body.base.left, src, leftProfile.body, bg);
    alignGarmentRectToDeclaredColor(atlas, body.base.left, declaredTopColor);
  }
  if (rightProfile) {
    fillRectFromRegion(atlas, body.base.right, src, rightProfile.body, bg);
    alignGarmentRectToDeclaredColor(atlas, body.base.right, declaredTopColor);
  }
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
    if (leftProfile) {
      fillRectFromRegion(atlas, box.left, src, leftProfile.arm, bg);
      alignGarmentRectToDeclaredColor(
        atlas,
        box.left,
        declaredTopColor,
        sleeveRows,
      );
    }
    if (rightProfile) {
      fillRectFromRegion(atlas, box.right, src, rightProfile.arm, bg);
      alignGarmentRectToDeclaredColor(
        atlas,
        box.right,
        declaredTopColor,
        sleeveRows,
      );
    }
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

    // `completeSides` has no knowledge of short hems: it fills both profile
    // faces with the sampled trouser colour.  With the common single-front
    // portrait input there is no real side view to replace those pixels, so a
    // skirt/shorts outfit used to have skin-coloured shins on the front and a
    // grey cloth slab on either side.  Re-establish the exposed leg interval
    // on every vertical face before optional profile/back samples and
    // legwear overlays are composed.  The selected asymmetric legwear can
    // then deliberately replace these base pixels, while the opposite leg
    // remains continuous skin around the whole cuboid.
    if (exposedSkinRows > 0) {
      for (const rect of [box.right, box.left, box.back]) {
        fillRectSolid(
          atlas,
          {
            x: rect.x,
            y: rect.y + garmentRows,
            w: rect.w,
            h: exposedSkinRows,
          },
          skinColor,
        );
      }
    }
    for (const [profile, side] of [
      [leftProfile, box.left],
      [rightProfile, box.right],
    ] as const) {
      if (!profile) continue;
      fillRectFromRegion(atlas, side, src, profile.leg, bg);
      alignGarmentRectToDeclaredColor(
        atlas,
        side,
        declaredBottomColor,
        garmentRows,
      );
      if (exposedSkinRows > 0) {
        fillRectSolid(
          atlas,
          {
            x: side.x,
            y: side.y + garmentRows,
            w: side.w,
            h: exposedSkinRows,
          },
          skinColor,
        );
      }
      alignGarmentRectToDeclaredColor(
        atlas,
        side,
        declaredShoesColor,
        shoeRows,
        side.h - shoeRows,
      );
    }
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
  resetPortraitFaceOverlay(atlas);
  composeGlassesOverlay(atlas, faceStyle);
  composeHair(atlas, hairColor, skinColor, faceStyle);
  preserveFaceReadability(atlas, faceStyle, hairColor);
  composeHat(atlas, hatColor, faceStyle);
  // Large statement frames are a primary identity cue. Reassert them after
  // hair and headwear so long fringe, locs, or a close-fitting scarf cannot
  // erase the circular silhouette in the final 3D render. Normal frames keep
  // the earlier ordering and can still be naturally occluded by hair.
  if (faceStyle.glassesScale === "large") {
    composeGlassesOverlay(atlas, faceStyle);
  }
  applyShading(atlas);
  reconcileBaseHorizontalSeams(atlas);
  // Reconcile last so directional face shading cannot reopen a color break at
  // a physically shared edge. Only seam-edge pixels are affected.
  reconcileOverlaySeams(atlas, faceStyle, hairColor);
  // Tiny jewelry is intentionally authored after seam reconciliation so it is
  // not mistaken for hair/cloth continuity and remains readable in front and
  // profile renders.
  composeEarrings(atlas, faceStyle);

  return {
    atlas,
    problems,
    hasBackView: back !== null,
    hasSideViews: leftProfile !== null && rightProfile !== null,
    viewCount: ranges.length,
  };
}
