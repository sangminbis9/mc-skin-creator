/**
 * 사진 분석 단계: llama-4-scout로 품질 검사 + observed/inferred 구조의
 * PhotoAnalysis를 뽑는다. 이 결과는 이미지 생성 프롬프트와
 * 절차적 fallback(팔레트 특징) 양쪽의 입력이 된다.
 *
 * observed = 사진에서 실제로 보이는 것, inferred = 보이지 않아 추론한 것.
 * 이 구분을 스키마 수준에서 강제해 환각을 관찰 결과로 취급하지 않게 한다.
 */

import type { Env } from "./types";

const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export type Framing = "face" | "upper_body" | "three_quarter" | "full_body";

export interface InferredItem {
  value: string;
  rationale: string;
}

export interface InferredLowerBodyDesign {
  bottomType: "pants" | "jeans" | "shorts" | "skirt";
  bottomPattern: "plain" | "plaid" | "striped" | "pleated" | "lace";
  bottomAccent: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
  legwear: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
  legwearAsymmetry: "none" | "left" | "right" | "both";
  shoeStyle: "sneakers" | "dress_shoes" | "boots" | "loafers" | "sandals";
  rationale: string;
}

/**
 * 64x64 스킨으로 축약할 때도 정체성을 보존하기 위한 저해상도 렌더 힌트.
 * 자유 서술(identityPrompt)은 이미지 모델에, 이 구조화 값은 결정적 packer에 사용한다.
 */
export interface PixelRenderHints {
  faceShape: "round" | "oval" | "long" | "angular" | "square";
  eyeShape: "narrow" | "almond" | "round";
  eyeSpacing: "close" | "average" | "wide";
  eyebrowShape: "straight" | "arched" | "slanted" | "soft";
  noseShape: "small" | "straight" | "rounded" | "prominent";
  mouthShape: "small" | "wide" | "full" | "thin";
  jawShape: "rounded" | "pointed" | "square" | "soft";
  bangs: "none" | "straight" | "side" | "curtain" | "wispy";
  bangsLength: "none" | "short" | "brow" | "eye";
  hairTexture: "straight" | "wavy" | "curly" | "coily";
  hairVolume: "flat" | "normal" | "full";
  hairSilhouette: "rounded" | "flat" | "swept" | "tousled" | "spiky";
  hairBackShape: "tapered" | "rounded" | "long" | "tied" | "undercut";
  hairPart: "none" | "center" | "left" | "right";
  sideHairLength: "none" | "short" | "cheek" | "jaw" | "shoulder";
  garmentTexture:
    | "plain"
    | "knit"
    | "denim"
    | "leather"
    | "striped"
    | "patterned";
  outerLayer: "none" | "light" | "heavy";
  outerGarment: "none" | "cardigan" | "open_jacket" | "coat" | "vest";
  necklace: "none" | "silver" | "gold" | "dark";
  hairAccessory: "none" | "flower" | "bow" | "ribbon" | "clip";
  hairAccessorySide: "left" | "right" | "center";
  neckAccessory: "none" | "bow" | "tie" | "scarf" | "collar";
  bottomPattern: "plain" | "plaid" | "striped" | "pleated" | "lace";
  bottomAccent: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
  legwear: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
  legwearAsymmetry: "none" | "left" | "right" | "both";
}

/** 절차적 fallback 생성기용 팔레트 분류 (기존 계약 유지) */
export interface FallbackFeatures {
  skinTone: string;
  hairColor: string;
  hairstyle: string;
  eyeColor: string;
  eyebrowThickness: string;
  facialHair: string;
  glasses: string;
  glassesColor: string;
  earrings: boolean;
  hat: string;
  hatColor: string;
  expression: string;
  topType: string;
  topColor: string;
  topAccentColor: string;
  sleeveLength: string;
  bottomType: string;
  bottomColor: string;
  shoesColor: string;
}

export interface PhotoAnalysis {
  quality: "pass" | "warn" | "fail";
  failReason: "no_face" | "blurry" | "too_small" | null;
  framing: Framing;
  visibleRegions: {
    face: boolean;
    hair: boolean;
    upperBody: boolean;
    lowerBody: boolean;
    feet: boolean;
  };
  observed: {
    face: string;
    hair: string;
    accessories: string;
    clothing: string;
    colorPalette: string[];
  };
  inferred: {
    hairBack: InferredItem;
    upperBody: InferredItem | null;
    lowerBody: InferredItem | null;
    lowerBodyDesign?: InferredLowerBodyDesign | null;
    shoes: InferredItem | null;
  };
  renderHints: PixelRenderHints;
  identityPrompt: string;
  outfitPrompt: string;
  negativePrompt: string;
  fallbackFeatures: FallbackFeatures;
}

const CLOTHING_COLOR_ENUM =
  '"black" | "white" | "gray" | "light-gray" | "red" | "orange" | "yellow" | "green" | "dark-green" | "blue" | "navy" | "sky-blue" | "purple" | "pink" | "brown" | "beige" | "denim" | "khaki"';

export const ANALYSIS_PROMPT = `You are a character designer analyzing a photo to build a Minecraft-style avatar that closely resembles the person in it.

STEP 1 — photo quality:
- "fail" + failReason "no_face" if there is no real human face clearly visible (this includes blank images, objects, landscapes, drawings without a real person).
- "fail" + failReason "blurry" if the photo is too blurry to see facial features.
- "fail" + failReason "too_small" if the person is too small in the frame.
- "warn" if usable but not ideal, "pass" if good.
A photo showing only a face IS acceptable — never fail a photo just because the body is not visible.
If multiple people appear, analyze only the most prominent/central person.

STEP 2 — framing: how much of the person is visible: "face" (head only), "upper_body" (head + torso), "three_quarter" (down to thighs/knees), "full_body".

STEP 3 — observed: describe ONLY what is actually visible in the photo. Be specific and concrete (colors, shapes, textures). Never invent details you cannot see. For observed.clothing, describe garment type, colors and general patterns (stripes, plain, graphic) — never brand names or logos.
- If lower body or feet are visible, observed.clothing MUST explicitly name the lower garment type (skirt/shorts/pants/jeans; describe skorts, pleated shorts or skirt-like culottes as skirt-like for low-resolution rendering), pattern or construction (plaid/checkered/pleated/lace/striped/plain), visible legwear (socks/stockings/leg warmers/thigh-highs), legwear asymmetry from the viewer's perspective, and shoe type/color.
- Preserve side-specific details using viewer-left/viewer-right wording for one-sided flowers, bows, leg warmers, thigh bows, side stripes, straps or shoe details.
- When a one-sided accessory or legwear exists, repeat the exact side in observed/inferred text and in renderHints/structured fields. Do not summarize it as simply "asymmetric".

STEP 4 — inferred: for body parts and clothing NOT visible, design choices that stay coherent with the observed colors, style and mood. Each inferred item needs a short rationale grounded in observed evidence. Rules:
- Never base clothing choices on gender presentation or facial stereotypes; use only visible clothing cues, colors and mood.
- If there are no clothing cues at all, choose neutral casual wear that harmonizes with skin/hair colors. Vary between shirt, knit, hoodie or light jacket depending on the photo's mood — do not always default to a plain t-shirt.
- If a region IS visible in the photo, set its inferred entry to null.
- If the lower body is NOT visible, also fill inferred.lowerBodyDesign with concrete Minecraft-ready choices for bottomType, pattern, accent, legwear, asymmetry and shoe style. If the lower body IS visible, set inferred.lowerBodyDesign to null. Prefer a detailed but coherent design over a generic plain lower half.
- For inferred lower-body designs with one-sided legwear or ribbons, use legwearAsymmetry "left" or "right" from the viewer's perspective and repeat that side in outfitPrompt.

STEP 5 — prompts for an image generation model:
- identityPrompt: 2-4 sentences capturing the recognizable identity, as SPECIFIC as possible: face shape (round/oval/angular), skin tone, hair (exact color shade, parting direction, bangs style, length, texture like straight/wavy/curly), eye shape and color, eyebrow shape, nose/mouth impression, facial hair, glasses shape/color, hat, earrings, and any distinctive features. Avoid generic phrases — describe what makes THIS person recognizable.
- outfitPrompt: 1-3 sentences describing the COMPLETE head-to-toe outfit: visible garments first (preserve them faithfully), then inferred garments. When lower body or feet are visible, explicitly include the lower garment, legwear/asymmetry and shoe details instead of summarizing them as "bottoms" or omitting them.
- negativePrompt: things to avoid for this specific person (e.g. "no beard" if clean-shaven, "no hat" if bare-headed).

STEP 6 — renderHints for a very low-resolution 8x8 face and layered Minecraft skin:
- Classify the visible face geometry, eye geometry, eyebrow shape, nose shape, mouth shape, jaw shape, bangs, bangs length, hair texture/volume, hair silhouette, back-hair shape, hair parting, side-hair length, garment texture, outer-layer thickness, and necklace.
- eyebrowShape means the visible brow impression: straight/horizontal, arched/raised center, slanted/serious angled, or soft/low-contrast.
- noseShape means the visible low-res nose impression: small/subtle, straight/vertical, rounded/soft tip, or prominent/strong bridge.
- mouthShape means the visible mouth/lip impression: small/compact, wide, full/darker lips, or thin/subtle.
- jawShape means the visible lower-face contour: rounded/full jaw, pointed/narrow chin, square/strong jaw corners, or soft/low-contrast jaw.
- bangsLength means how far the front fringe visually falls: none, short/upper-forehead, brow/eyebrow-level, or eye/partly covering the eyes.
- hairSilhouette means the visible outer outline of the hair: rounded/dome-like, flat/sleek, swept/asymmetric, tousled/soft irregular, or spiky/sharp tufts.
- hairBackShape is the inferred rear construction: tapered neat nape, rounded full back, long hair down the back, tied ponytail/bun, or undercut close nape. Use visible side/top hair and inferred.hairBack rationale.
- hairPart is the visible parting direction from the viewer's perspective: center, left, right, or none.
- sideHairLength is how far the side hair visually falls: none, short/ear-level, cheek, jaw, or shoulder.
- necklace means a clearly visible necklace/chain/pendant; otherwise "none".
- hairAccessory means a visible hair flower, bow, ribbon or clip that should survive at 64x64; otherwise "none". hairAccessorySide is the accessory position from the viewer's perspective: left, right, or center.
- neckAccessory means a visible bow, necktie, scarf or distinct collar at the throat/chest that should be rendered as a bold low-res cue.
- bottomPattern captures visible plaid/checks, stripes, pleats or lace on the lower garment. If the lower body is not visible, choose a coherent inferred pattern only when it fits the visible top; otherwise "plain".
- bottomAccent captures a bold low-res lower-body detail: belt, cuffs, side stripe or ribbon. If the lower body is not visible, infer one from the visible top's formality and color harmony when useful; otherwise "none".
- legwear captures visible socks, stockings, leg warmers or thigh-highs. legwearAsymmetry is "left" or "right" when only one leg has the distinctive legwear, "both" when both legs do, and "none" when no legwear is visible.
- For full_body photos, renderHints.bottomPattern, bottomAccent, legwear and legwearAsymmetry must be based on the visible lower body whenever visible; do not default to plain/none if plaid, pleats, lace, ribbons, socks, stockings, leg warmers or asymmetric details are visible.
- outerLayer means whether clothing should visibly use Minecraft's second skin layer for volume (jacket/hoodie/heavy knit = heavy, shirt/light knit = light).
- outerGarment captures a visible open cardigan, open jacket, coat, or vest silhouette. Use "none" for a single closed top.

STEP 7 — fallbackFeatures: classify into these fixed palettes (pick the CLOSEST option, never invent values):
{
  "skinTone": "pale" | "light" | "medium" | "tan" | "brown" | "dark",
  "hairColor": "black" | "dark-brown" | "brown" | "light-brown" | "blonde" | "platinum" | "red" | "auburn" | "gray" | "white" | "dyed-blue" | "dyed-pink" | "dyed-purple" | "dyed-green",
  "hairstyle": "bald" | "buzz" | "short" | "medium" | "long" | "ponytail" | "bun" | "twintails" | "curly" | "afro",
  "eyeColor": "black" | "dark-brown" | "brown" | "hazel" | "green" | "blue" | "gray",
  "eyebrowThickness": "thin" | "normal" | "thick",
  "facialHair": "none" | "mustache" | "goatee" | "beard" | "stubble",
  "glasses": "none" | "regular" | "round" | "sunglasses",
  "glassesColor": CLOTHING_COLOR,
  "earrings": true | false,
  "hat": "none" | "cap" | "beanie" | "hood",
  "hatColor": CLOTHING_COLOR,
  "expression": "smile" | "neutral" | "serious",
  "topType": "tshirt" | "shirt" | "hoodie" | "jacket" | "sweater" | "dress" | "tank",
  "topColor": CLOTHING_COLOR,
  "topAccentColor": CLOTHING_COLOR,
  "sleeveLength": "short" | "long",
  "bottomType": "pants" | "jeans" | "shorts" | "skirt",
  "bottomColor": CLOTHING_COLOR,
  "shoesColor": CLOTHING_COLOR
}
For fallbackFeatures.bottomType, use the visible lower garment when it is visible; never default to "pants" for a visible skirt, skort, skirt-like culottes or shorts.
CLOTHING_COLOR must be one of: ${CLOTHING_COLOR_ENUM}

Respond with ONLY a JSON object matching this shape:
{
  "quality": "pass" | "warn" | "fail",
  "failReason": "no_face" | "blurry" | "too_small" | null,
  "framing": "face" | "upper_body" | "three_quarter" | "full_body",
  "visibleRegions": { "face": bool, "hair": bool, "upperBody": bool, "lowerBody": bool, "feet": bool },
  "observed": { "face": str, "hair": str, "accessories": str, "clothing": str, "colorPalette": [str] },
  "inferred": {
    "hairBack": { "value": str, "rationale": str },
    "upperBody": { "value": str, "rationale": str } | null,
    "lowerBody": { "value": str, "rationale": str } | null,
    "lowerBodyDesign": {
      "bottomType": "pants" | "jeans" | "shorts" | "skirt",
      "bottomPattern": "plain" | "plaid" | "striped" | "pleated" | "lace",
      "bottomAccent": "none" | "belt" | "cuffs" | "side_stripe" | "ribbon",
      "legwear": "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs",
      "legwearAsymmetry": "none" | "left" | "right" | "both",
      "shoeStyle": "sneakers" | "dress_shoes" | "boots" | "loafers" | "sandals",
      "rationale": str
    } | null,
    "shoes": { "value": str, "rationale": str } | null
  },
  "renderHints": {
    "faceShape": "round" | "oval" | "long" | "angular" | "square",
    "eyeShape": "narrow" | "almond" | "round",
    "eyeSpacing": "close" | "average" | "wide",
    "eyebrowShape": "straight" | "arched" | "slanted" | "soft",
    "noseShape": "small" | "straight" | "rounded" | "prominent",
    "mouthShape": "small" | "wide" | "full" | "thin",
    "jawShape": "rounded" | "pointed" | "square" | "soft",
    "bangs": "none" | "straight" | "side" | "curtain" | "wispy",
    "bangsLength": "none" | "short" | "brow" | "eye",
    "hairTexture": "straight" | "wavy" | "curly" | "coily",
    "hairVolume": "flat" | "normal" | "full",
    "hairSilhouette": "rounded" | "flat" | "swept" | "tousled" | "spiky",
    "hairBackShape": "tapered" | "rounded" | "long" | "tied" | "undercut",
    "hairPart": "none" | "center" | "left" | "right",
    "sideHairLength": "none" | "short" | "cheek" | "jaw" | "shoulder",
    "garmentTexture": "plain" | "knit" | "denim" | "leather" | "striped" | "patterned",
    "outerLayer": "none" | "light" | "heavy",
    "outerGarment": "none" | "cardigan" | "open_jacket" | "coat" | "vest",
    "necklace": "none" | "silver" | "gold" | "dark",
    "hairAccessory": "none" | "flower" | "bow" | "ribbon" | "clip",
    "hairAccessorySide": "left" | "right" | "center",
    "neckAccessory": "none" | "bow" | "tie" | "scarf" | "collar",
    "bottomPattern": "plain" | "plaid" | "striped" | "pleated" | "lace",
    "bottomAccent": "none" | "belt" | "cuffs" | "side_stripe" | "ribbon",
    "legwear": "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs",
    "legwearAsymmetry": "none" | "left" | "right" | "both"
  },
  "identityPrompt": str,
  "outfitPrompt": str,
  "negativePrompt": str,
  "fallbackFeatures": { ...as specified above }
}`;

/** response_format용 JSON Schema — 모델 출력 유도용. 최종 판정은 validatePhotoAnalysis가 한다. */
const INFERRED_ITEM_SCHEMA = {
  type: ["object", "null"],
  properties: {
    value: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["value", "rationale"],
};

const LOWER_BODY_DESIGN_SCHEMA = {
  type: ["object", "null"],
  properties: {
    bottomType: {
      type: "string",
      enum: ["pants", "jeans", "shorts", "skirt"],
    },
    bottomPattern: {
      type: "string",
      enum: ["plain", "plaid", "striped", "pleated", "lace"],
    },
    bottomAccent: {
      type: "string",
      enum: ["none", "belt", "cuffs", "side_stripe", "ribbon"],
    },
    legwear: {
      type: "string",
      enum: ["none", "socks", "stockings", "leg_warmers", "thigh_highs"],
    },
    legwearAsymmetry: {
      type: "string",
      enum: ["none", "left", "right", "both"],
    },
    shoeStyle: {
      type: "string",
      enum: ["sneakers", "dress_shoes", "boots", "loafers", "sandals"],
    },
    rationale: { type: "string" },
  },
  required: [
    "bottomType",
    "bottomPattern",
    "bottomAccent",
    "legwear",
    "legwearAsymmetry",
    "shoeStyle",
    "rationale",
  ],
};

export const PHOTO_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    quality: { type: "string", enum: ["pass", "warn", "fail"] },
    failReason: {
      type: ["string", "null"],
      enum: ["no_face", "blurry", "too_small", null],
    },
    framing: {
      type: "string",
      enum: ["face", "upper_body", "three_quarter", "full_body"],
    },
    visibleRegions: {
      type: "object",
      properties: {
        face: { type: "boolean" },
        hair: { type: "boolean" },
        upperBody: { type: "boolean" },
        lowerBody: { type: "boolean" },
        feet: { type: "boolean" },
      },
      required: ["face", "hair", "upperBody", "lowerBody", "feet"],
    },
    observed: {
      type: "object",
      properties: {
        face: { type: "string" },
        hair: { type: "string" },
        accessories: { type: "string" },
        clothing: { type: "string" },
        colorPalette: { type: "array", items: { type: "string" } },
      },
      required: ["face", "hair", "accessories", "clothing", "colorPalette"],
    },
    inferred: {
      type: "object",
      properties: {
        hairBack: {
          type: "object",
          properties: INFERRED_ITEM_SCHEMA.properties,
          required: INFERRED_ITEM_SCHEMA.required,
        },
        upperBody: INFERRED_ITEM_SCHEMA,
        lowerBody: INFERRED_ITEM_SCHEMA,
        lowerBodyDesign: LOWER_BODY_DESIGN_SCHEMA,
        shoes: INFERRED_ITEM_SCHEMA,
      },
      required: ["hairBack", "upperBody", "lowerBody", "lowerBodyDesign", "shoes"],
    },
    renderHints: {
      type: "object",
      properties: {
        faceShape: {
          type: "string",
          enum: ["round", "oval", "long", "angular", "square"],
        },
        eyeShape: { type: "string", enum: ["narrow", "almond", "round"] },
        eyeSpacing: { type: "string", enum: ["close", "average", "wide"] },
        eyebrowShape: {
          type: "string",
          enum: ["straight", "arched", "slanted", "soft"],
        },
        noseShape: {
          type: "string",
          enum: ["small", "straight", "rounded", "prominent"],
        },
        mouthShape: {
          type: "string",
          enum: ["small", "wide", "full", "thin"],
        },
        jawShape: {
          type: "string",
          enum: ["rounded", "pointed", "square", "soft"],
        },
        bangs: {
          type: "string",
          enum: ["none", "straight", "side", "curtain", "wispy"],
        },
        bangsLength: {
          type: "string",
          enum: ["none", "short", "brow", "eye"],
        },
        hairTexture: {
          type: "string",
          enum: ["straight", "wavy", "curly", "coily"],
        },
        hairVolume: { type: "string", enum: ["flat", "normal", "full"] },
        hairSilhouette: {
          type: "string",
          enum: ["rounded", "flat", "swept", "tousled", "spiky"],
        },
        hairBackShape: {
          type: "string",
          enum: ["tapered", "rounded", "long", "tied", "undercut"],
        },
        hairPart: {
          type: "string",
          enum: ["none", "center", "left", "right"],
        },
        sideHairLength: {
          type: "string",
          enum: ["none", "short", "cheek", "jaw", "shoulder"],
        },
        garmentTexture: {
          type: "string",
          enum: ["plain", "knit", "denim", "leather", "striped", "patterned"],
        },
        outerLayer: { type: "string", enum: ["none", "light", "heavy"] },
        outerGarment: {
          type: "string",
          enum: ["none", "cardigan", "open_jacket", "coat", "vest"],
        },
        necklace: { type: "string", enum: ["none", "silver", "gold", "dark"] },
        hairAccessory: {
          type: "string",
          enum: ["none", "flower", "bow", "ribbon", "clip"],
        },
        hairAccessorySide: {
          type: "string",
          enum: ["left", "right", "center"],
        },
        neckAccessory: {
          type: "string",
          enum: ["none", "bow", "tie", "scarf", "collar"],
        },
        bottomPattern: {
          type: "string",
          enum: ["plain", "plaid", "striped", "pleated", "lace"],
        },
        bottomAccent: {
          type: "string",
          enum: ["none", "belt", "cuffs", "side_stripe", "ribbon"],
        },
        legwear: {
          type: "string",
          enum: ["none", "socks", "stockings", "leg_warmers", "thigh_highs"],
        },
        legwearAsymmetry: {
          type: "string",
          enum: ["none", "left", "right", "both"],
        },
      },
      required: [
        "faceShape",
        "eyeShape",
        "eyeSpacing",
        "eyebrowShape",
        "noseShape",
        "mouthShape",
        "jawShape",
        "bangs",
        "bangsLength",
        "hairTexture",
        "hairVolume",
        "hairSilhouette",
        "hairBackShape",
        "hairPart",
        "sideHairLength",
        "garmentTexture",
        "outerLayer",
        "outerGarment",
        "necklace",
        "hairAccessory",
        "hairAccessorySide",
        "neckAccessory",
        "bottomPattern",
        "bottomAccent",
        "legwear",
        "legwearAsymmetry",
      ],
    },
    identityPrompt: { type: "string" },
    outfitPrompt: { type: "string" },
    negativePrompt: { type: "string" },
    fallbackFeatures: { type: "object" },
  },
  required: [
    "quality",
    "failReason",
    "framing",
    "visibleRegions",
    "observed",
    "inferred",
    "renderHints",
    "identityPrompt",
    "outfitPrompt",
    "negativePrompt",
    "fallbackFeatures",
  ],
} as const;

// ---------- 런타임 검증 ----------

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export type ValidationResult = { ok: true; analysis: PhotoAnalysis } | ValidationFailure;

const FRAMINGS: Framing[] = ["face", "upper_body", "three_quarter", "full_body"];

/**
 * 모델 응답을 명시적으로 검증한다.
 * 실패 시 기본값으로 조용히 덮지 않고 어떤 필드가 왜 틀렸는지 반환한다.
 * (fallbackFeatures의 팔레트 값만은 뒤에서 paletteHex가 관용적으로 처리한다 —
 *  fallback 경로 전용 데이터라 생성 품질 판단에 영향이 없기 때문)
 */
export function validatePhotoAnalysis(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["응답이 객체가 아님"] };
  }
  const obj = raw as Record<string, unknown>;

  const str = (path: string, value: unknown): string => {
    if (typeof value !== "string") {
      errors.push(`${path}: 문자열이 아님`);
      return "";
    }
    return value;
  };
  const bool = (path: string, value: unknown): boolean => {
    if (typeof value !== "boolean") {
      errors.push(`${path}: boolean이 아님`);
      return false;
    }
    return value;
  };

  const quality = str("quality", obj.quality);
  if (!["pass", "warn", "fail"].includes(quality)) {
    errors.push(`quality: 허용되지 않은 값 "${quality}"`);
  }

  let failReason: PhotoAnalysis["failReason"] = null;
  if (obj.failReason !== null && obj.failReason !== undefined) {
    if (
      typeof obj.failReason === "string" &&
      ["no_face", "blurry", "too_small"].includes(obj.failReason)
    ) {
      failReason = obj.failReason as PhotoAnalysis["failReason"];
    } else if (quality === "fail") {
      errors.push(`failReason: 허용되지 않은 값 ${JSON.stringify(obj.failReason)}`);
    }
  }

  // quality가 fail이면 나머지 필드는 검증할 필요가 없다 (사진 거부 경로)
  if (quality === "fail" && errors.length === 0) {
    return {
      ok: true,
      analysis: {
        quality: "fail",
        failReason: failReason ?? "no_face",
        framing: "face",
        visibleRegions: {
          face: false,
          hair: false,
          upperBody: false,
          lowerBody: false,
          feet: false,
        },
        observed: { face: "", hair: "", accessories: "", clothing: "", colorPalette: [] },
        inferred: {
          hairBack: { value: "", rationale: "" },
          upperBody: null,
          lowerBody: null,
          lowerBodyDesign: null,
          shoes: null,
        },
        renderHints: {
          faceShape: "oval",
          eyeShape: "almond",
          eyeSpacing: "average",
          eyebrowShape: "straight",
          noseShape: "small",
          mouthShape: "small",
          jawShape: "soft",
          bangs: "none",
          bangsLength: "none",
          hairTexture: "straight",
          hairVolume: "normal",
          hairSilhouette: "rounded",
          hairBackShape: "tapered",
          hairPart: "none",
          sideHairLength: "short",
          garmentTexture: "plain",
          outerLayer: "none",
          outerGarment: "none",
          necklace: "none",
          hairAccessory: "none",
          hairAccessorySide: "left",
          neckAccessory: "none",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
        },
        identityPrompt: "",
        outfitPrompt: "",
        negativePrompt: "",
        fallbackFeatures: {} as FallbackFeatures,
      },
    };
  }

  const framing = str("framing", obj.framing) as Framing;
  if (!FRAMINGS.includes(framing)) {
    errors.push(`framing: 허용되지 않은 값 "${framing}"`);
  }

  const vr = (obj.visibleRegions ?? {}) as Record<string, unknown>;
  const visibleRegions = {
    face: bool("visibleRegions.face", vr.face),
    hair: bool("visibleRegions.hair", vr.hair),
    upperBody: bool("visibleRegions.upperBody", vr.upperBody),
    lowerBody: bool("visibleRegions.lowerBody", vr.lowerBody),
    feet: bool("visibleRegions.feet", vr.feet),
  };

  const ob = (obj.observed ?? {}) as Record<string, unknown>;
  const observed = {
    face: str("observed.face", ob.face),
    hair: str("observed.hair", ob.hair),
    accessories: str("observed.accessories", ob.accessories),
    clothing: str("observed.clothing", ob.clothing),
    colorPalette: Array.isArray(ob.colorPalette)
      ? ob.colorPalette.filter((c): c is string => typeof c === "string")
      : (errors.push("observed.colorPalette: 배열이 아님"), []),
  };

  const parseInferredItem = (
    path: string,
    value: unknown,
    nullable: boolean,
  ): InferredItem | null => {
    if (value === null || value === undefined) {
      if (!nullable) {
        errors.push(`${path}: null 불가`);
        return { value: "", rationale: "" };
      }
      return null;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: 객체가 아님`);
      return nullable ? null : { value: "", rationale: "" };
    }
    const item = value as Record<string, unknown>;
    return {
      value: str(`${path}.value`, item.value),
      rationale: str(`${path}.rationale`, item.rationale),
    };
  };

  const parseLowerBodyDesign = (
    path: string,
    value: unknown,
  ): InferredLowerBodyDesign | null => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: 媛앹껜媛 ?꾨떂`);
      return null;
    }
    const item = value as Record<string, unknown>;
    const enumField = <T extends string>(
      key: string,
      allowed: readonly T[],
      fallback: T,
    ): T => {
      const fieldValue = item[key];
      if (typeof fieldValue === "string" && allowed.includes(fieldValue as T)) {
        return fieldValue as T;
      }
      errors.push(`${path}.${key}: ?덉슜?섏? ?딆? 媛?${JSON.stringify(fieldValue)}`);
      return fallback;
    };

    return {
      bottomType: enumField("bottomType", ["pants", "jeans", "shorts", "skirt"], "pants"),
      bottomPattern: enumField(
        "bottomPattern",
        ["plain", "plaid", "striped", "pleated", "lace"],
        "plain",
      ),
      bottomAccent: enumField(
        "bottomAccent",
        ["none", "belt", "cuffs", "side_stripe", "ribbon"],
        "none",
      ),
      legwear: enumField(
        "legwear",
        ["none", "socks", "stockings", "leg_warmers", "thigh_highs"],
        "none",
      ),
      legwearAsymmetry: enumField(
        "legwearAsymmetry",
        ["none", "left", "right", "both"],
        "none",
      ),
      shoeStyle: enumField(
        "shoeStyle",
        ["sneakers", "dress_shoes", "boots", "loafers", "sandals"],
        "sneakers",
      ),
      rationale: str(`${path}.rationale`, item.rationale),
    };
  };

  const inf = (obj.inferred ?? {}) as Record<string, unknown>;
  const inferred = {
    hairBack: parseInferredItem("inferred.hairBack", inf.hairBack, false) as InferredItem,
    upperBody: parseInferredItem("inferred.upperBody", inf.upperBody, true),
    lowerBody: parseInferredItem("inferred.lowerBody", inf.lowerBody, true),
    lowerBodyDesign: parseLowerBodyDesign(
      "inferred.lowerBodyDesign",
      inf.lowerBodyDesign,
    ),
    shoes: parseInferredItem("inferred.shoes", inf.shoes, true),
  };

  const enumValue = <T extends string>(
    path: string,
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    if (typeof value === "string" && allowed.includes(value as T)) {
      return value as T;
    }
    errors.push(`${path}: 허용되지 않은 값 ${JSON.stringify(value)}`);
    return fallback;
  };
  const hints = (obj.renderHints ?? {}) as Record<string, unknown>;
  const renderHints: PixelRenderHints = {
    faceShape: enumValue(
      "renderHints.faceShape",
      hints.faceShape,
      ["round", "oval", "long", "angular", "square"],
      "oval",
    ),
    eyeShape: enumValue(
      "renderHints.eyeShape",
      hints.eyeShape,
      ["narrow", "almond", "round"],
      "almond",
    ),
    eyeSpacing: enumValue(
      "renderHints.eyeSpacing",
      hints.eyeSpacing,
      ["close", "average", "wide"],
      "average",
    ),
    eyebrowShape: enumValue(
      "renderHints.eyebrowShape",
      hints.eyebrowShape,
      ["straight", "arched", "slanted", "soft"],
      "straight",
    ),
    noseShape: enumValue(
      "renderHints.noseShape",
      hints.noseShape,
      ["small", "straight", "rounded", "prominent"],
      "small",
    ),
    mouthShape: enumValue(
      "renderHints.mouthShape",
      hints.mouthShape,
      ["small", "wide", "full", "thin"],
      "small",
    ),
    jawShape: enumValue(
      "renderHints.jawShape",
      hints.jawShape,
      ["rounded", "pointed", "square", "soft"],
      "soft",
    ),
    bangs: enumValue(
      "renderHints.bangs",
      hints.bangs,
      ["none", "straight", "side", "curtain", "wispy"],
      "none",
    ),
    bangsLength: enumValue(
      "renderHints.bangsLength",
      hints.bangsLength,
      ["none", "short", "brow", "eye"],
      "none",
    ),
    hairTexture: enumValue(
      "renderHints.hairTexture",
      hints.hairTexture,
      ["straight", "wavy", "curly", "coily"],
      "straight",
    ),
    hairVolume: enumValue(
      "renderHints.hairVolume",
      hints.hairVolume,
      ["flat", "normal", "full"],
      "normal",
    ),
    hairSilhouette: enumValue(
      "renderHints.hairSilhouette",
      hints.hairSilhouette,
      ["rounded", "flat", "swept", "tousled", "spiky"],
      "rounded",
    ),
    hairBackShape: enumValue(
      "renderHints.hairBackShape",
      hints.hairBackShape,
      ["tapered", "rounded", "long", "tied", "undercut"],
      "tapered",
    ),
    hairPart: enumValue(
      "renderHints.hairPart",
      hints.hairPart,
      ["none", "center", "left", "right"],
      "none",
    ),
    sideHairLength: enumValue(
      "renderHints.sideHairLength",
      hints.sideHairLength,
      ["none", "short", "cheek", "jaw", "shoulder"],
      "short",
    ),
    garmentTexture: enumValue(
      "renderHints.garmentTexture",
      hints.garmentTexture,
      ["plain", "knit", "denim", "leather", "striped", "patterned"],
      "plain",
    ),
    outerLayer: enumValue(
      "renderHints.outerLayer",
      hints.outerLayer,
      ["none", "light", "heavy"],
      "none",
    ),
    outerGarment: enumValue(
      "renderHints.outerGarment",
      hints.outerGarment,
      ["none", "cardigan", "open_jacket", "coat", "vest"],
      "none",
    ),
    necklace: enumValue(
      "renderHints.necklace",
      hints.necklace,
      ["none", "silver", "gold", "dark"],
      "none",
    ),
    hairAccessory: enumValue(
      "renderHints.hairAccessory",
      hints.hairAccessory,
      ["none", "flower", "bow", "ribbon", "clip"],
      "none",
    ),
    hairAccessorySide: enumValue(
      "renderHints.hairAccessorySide",
      hints.hairAccessorySide,
      ["left", "right", "center"],
      "left",
    ),
    neckAccessory: enumValue(
      "renderHints.neckAccessory",
      hints.neckAccessory,
      ["none", "bow", "tie", "scarf", "collar"],
      "none",
    ),
    bottomPattern: enumValue(
      "renderHints.bottomPattern",
      hints.bottomPattern,
      ["plain", "plaid", "striped", "pleated", "lace"],
      "plain",
    ),
    bottomAccent: enumValue(
      "renderHints.bottomAccent",
      hints.bottomAccent,
      ["none", "belt", "cuffs", "side_stripe", "ribbon"],
      "none",
    ),
    legwear: enumValue(
      "renderHints.legwear",
      hints.legwear,
      ["none", "socks", "stockings", "leg_warmers", "thigh_highs"],
      "none",
    ),
    legwearAsymmetry: enumValue(
      "renderHints.legwearAsymmetry",
      hints.legwearAsymmetry,
      ["none", "left", "right", "both"],
      "none",
    ),
  };

  const identityPrompt = str("identityPrompt", obj.identityPrompt);
  const outfitPrompt = str("outfitPrompt", obj.outfitPrompt);
  const negativePrompt = str("negativePrompt", obj.negativePrompt);
  if (identityPrompt.trim().length < 10) {
    errors.push("identityPrompt: 내용이 비어 있거나 너무 짧음");
  }
  if (outfitPrompt.trim().length < 10) {
    errors.push("outfitPrompt: 내용이 비어 있거나 너무 짧음");
  }

  const fallbackFeatures = (
    typeof obj.fallbackFeatures === "object" && obj.fallbackFeatures !== null
      ? obj.fallbackFeatures
      : (errors.push("fallbackFeatures: 객체가 아님"), {})
  ) as FallbackFeatures;

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    analysis: {
      quality: quality as PhotoAnalysis["quality"],
      failReason,
      framing,
      visibleRegions,
      observed,
      inferred,
      renderHints,
      identityPrompt,
      outfitPrompt,
      negativePrompt,
      fallbackFeatures,
    },
  };
}

// ---------- Scout 호출 ----------

export type AnalysisCallResult =
  | { ok: true; analysis: PhotoAnalysis }
  | { ok: false; reason: "ai_error" | "invalid_response"; detail: string };

/**
 * 사진 분석 실행. json_schema 유도 → 실패 시 json_object로 1회 재시도.
 * 두 경우 모두 validatePhotoAnalysis로 런타임 검증한다.
 */
export async function runPhotoAnalysis(
  env: Env,
  imageDataUrl: string,
): Promise<AnalysisCallResult> {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: ANALYSIS_PROMPT },
      ],
    },
  ];

  const attempts: Array<Record<string, unknown>> = [
    { type: "json_schema", json_schema: PHOTO_ANALYSIS_SCHEMA },
    { type: "json_object" },
  ];

  let lastDetail = "";
  for (const responseFormat of attempts) {
    let parsed: unknown;
    try {
      const result = (await env.AI.run(VISION_MODEL as never, {
        messages,
        max_tokens: 1700,
        response_format: responseFormat,
      } as never)) as { response?: string | Record<string, unknown> };
      if (result.response && typeof result.response === "object") {
        parsed = result.response;
      } else if (typeof result.response === "string") {
        parsed = extractJson(result.response);
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (parsed === null || parsed === undefined) {
      lastDetail = "응답에서 JSON을 찾지 못함";
      continue;
    }
    const validated = validatePhotoAnalysis(parsed);
    if (validated.ok) {
      return { ok: true, analysis: validated.analysis };
    }
    lastDetail = `스키마 검증 실패: ${validated.errors.join("; ")}`;
  }
  return {
    ok: false,
    reason: lastDetail.startsWith("스키마") || lastDetail.startsWith("응답")
      ? "invalid_response"
      : "ai_error",
    detail: lastDetail,
  };
}

export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
