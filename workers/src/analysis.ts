/**
 * 사진 분석 단계: llama-4-scout로 품질 검사 + observed/inferred 구조의
 * PhotoAnalysis를 뽑는다. 이 결과는 이미지 생성 프롬프트와
 * 절차적 fallback(팔레트 특징) 양쪽의 입력이 된다.
 *
 * observed = 사진에서 실제로 보이는 것, inferred = 보이지 않아 추론한 것.
 * 이 구분을 스키마 수준에서 강제해 환각을 관찰 결과로 취급하지 않게 한다.
 */

import type { Env } from "./types";

const DEFAULT_VISION_MODEL = "@cf/moonshotai/kimi-k2.6";
const DEFAULT_FALLBACK_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

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
  thighAccessory: "none" | "bow" | "ribbon" | "garter";
  thighAccessorySide: "none" | "left" | "right" | "both";
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
  eyeSize: "small" | "average" | "large";
  eyeSpacing: "close" | "average" | "wide";
  eyeTilt: "upturned" | "level" | "downturned";
  eyebrowShape: "straight" | "arched" | "slanted" | "soft";
  noseShape: "small" | "straight" | "rounded" | "prominent";
  mouthShape: "small" | "wide" | "full" | "thin";
  lipFullness: "thin" | "average" | "full";
  jawShape: "rounded" | "pointed" | "square" | "soft";
  bangs: "none" | "straight" | "side" | "curtain" | "wispy";
  bangsLength: "none" | "short" | "brow" | "eye";
  bangsDensity: "sparse" | "balanced" | "dense";
  fringeEdge: "blunt" | "staggered" | "wispy";
  fringeOpening: "none" | "left" | "center" | "right";
  hairTexture: "straight" | "wavy" | "curly" | "coily";
  hairVolume: "flat" | "normal" | "full";
  hairSilhouette: "rounded" | "flat" | "swept" | "tousled" | "spiky";
  hairBackShape: "tapered" | "rounded" | "long" | "tied" | "undercut";
  overallHairLength:
    "cropped" | "ear" | "jaw" | "shoulder" | "chest" | "waist" | "hip";
  hairPart: "none" | "center" | "left" | "right";
  sideHairLength: "none" | "short" | "cheek" | "jaw" | "shoulder";
  sideHairShape:
    "tapered" | "ear_hugging" | "face_framing" | "flared" | "undercut";
  sideHairAsymmetry: "none" | "left" | "right";
  earExposure: "covered" | "partial" | "visible";
  garmentTexture:
    "plain" | "knit" | "denim" | "leather" | "striped" | "patterned";
  outerLayer: "none" | "light" | "heavy";
  outerGarment: "none" | "cardigan" | "open_jacket" | "coat" | "vest";
  necklace: "none" | "silver" | "gold" | "dark";
  hairAccessory: "none" | "flower" | "bow" | "ribbon" | "clip";
  hairAccessoryScale: "small" | "medium" | "large";
  hairAccessorySide: "left" | "right" | "center";
  hairAccessoryColor:
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
  neckAccessory: "none" | "bow" | "tie" | "scarf" | "collar";
  bottomPattern: "plain" | "plaid" | "striped" | "pleated" | "lace";
  bottomAccent: "none" | "belt" | "cuffs" | "side_stripe" | "ribbon";
  legwear: "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs";
  legwearColor:
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
    | "pink"
    | "beige";
  legwearAsymmetry: "none" | "left" | "right" | "both";
  thighAccessory: "none" | "bow" | "ribbon" | "garter";
  thighAccessorySide: "none" | "left" | "right" | "both";
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
- For observed.hair, explicitly describe root/scalp part visibility, fringe density and gaps, left and right temple contours, whether either ear is exposed or framed, side-hair taper/flare, the visible transition toward the nape, and the lowest substantial hair endpoint relative to the shoulders, chest/bust, natural waist or belt, and hips. Do not summarize all short hair as a bowl cut or all side hair as merely "short".
- For every visible white or contrasting fabric at the throat, describe its construction separately from the shirt: ordinary collar flaps, a central knot, paired loops, and any broad hanging tails. Do not call the whole shape a "collar" merely because a collared shirt is underneath. A central knot with two long pointed fabric tails is a neck bow or scarf even when its loops are folded flat or partly hidden.
- If lower body or feet are visible, observed.clothing MUST explicitly name the lower garment type (skirt/shorts/pants/jeans; describe skorts, pleated shorts or skirt-like culottes as skirt-like for low-resolution rendering), pattern or construction (plaid/checkered/pleated/lace/striped/plain), visible legwear (socks/stockings/leg warmers/thigh-highs/knee-high or over-knee socks), legwear asymmetry from the viewer's perspective, and shoe type/color.
- Preserve side-specific details using viewer-left/viewer-right wording for one-sided flowers, bows, leg warmers, thigh bows, side stripes, straps or shoe details.
- When a one-sided accessory or legwear exists, repeat the exact side in observed/inferred text and in renderHints/structured fields. Do not summarize it as simply "asymmetric".

STEP 4 — inferred: for body parts and clothing NOT visible, design choices that stay coherent with the observed colors, style and mood. Each inferred item needs a short rationale grounded in observed evidence. Rules:
- Never base clothing choices on gender presentation or facial stereotypes; use only visible clothing cues, colors and mood.
- If there are no clothing cues at all, choose neutral casual wear that harmonizes with skin/hair colors. Vary between shirt, knit, hoodie or light jacket depending on the photo's mood — do not always default to a plain t-shirt.
- If a region IS visible in the photo, set its inferred entry to null.
- If the lower body is NOT visible, also fill inferred.lowerBodyDesign with concrete Minecraft-ready choices for bottomType, pattern, accent, legwear, asymmetry, optional thigh accessory and shoe style. If the lower body IS visible, set inferred.lowerBodyDesign to null. Prefer a detailed but coherent design over a generic plain lower half. Never return the completely generic combination of plain pants + no accent + no legwear + sneakers: infer at least one low-resolution construction cue (pattern, belt, cuffs, side stripe or legwear) from the visible top, and describe the shoe color/construction in inferred.shoes.
- For inferred lower-body designs with one-sided legwear, use legwearAsymmetry "left" or "right" from the viewer's perspective. For a one-sided thigh bow, ribbon or garter, use thighAccessorySide independently. Repeat both exact sides in outfitPrompt; a thigh accessory can intentionally sit on the opposite leg from asymmetric legwear.

STEP 5 — prompts for an image generation model:
- identityPrompt: 2-4 sentences capturing the recognizable identity, as SPECIFIC as possible: face shape (round/oval/angular), skin tone, hair (exact color shade, parting direction, bangs style, length, texture like straight/wavy/curly), eye shape and color, eyebrow shape, nose/mouth impression, facial hair, glasses shape/color, hat, earrings, and any distinctive features. Avoid generic phrases — describe what makes THIS person recognizable.
- outfitPrompt: 1-3 sentences describing the COMPLETE head-to-toe outfit: visible garments first (preserve them faithfully), then inferred garments. When lower body or feet are visible, explicitly include the lower garment, legwear/asymmetry and shoe details instead of summarizing them as "bottoms" or omitting them.
- negativePrompt: things to avoid for this specific person (e.g. "no beard" if clean-shaven, "no hat" if bare-headed).

STEP 6 — renderHints for a very low-resolution 8x8 face and layered Minecraft skin:
- Classify the visible face geometry, eye geometry/size/spacing/tilt, eyebrow shape, nose shape, mouth footprint, lip fullness, jaw shape, bangs, bangs length/density/fringe edge/opening, hair texture/volume, hair silhouette, back-hair shape, overall hair length, hair parting, side-hair length/shape, ear exposure, garment texture, outer-layer thickness, and necklace.
- eyeSize describes the visible eye aperture relative to this person's face: small for compact or narrow openings, average for moderate openings, and large when the eyes are a dominant identity cue with clearly visible vertical iris/sclera area. Judge the actual eye opening, not eyeliner, glasses magnification, raised eyebrows, or facial expression.
- eyeTilt describes the line between each eye's inner and outer corner: upturned when the outer corners sit visibly higher, level when nearly horizontal, or downturned when the outer corners sit visibly lower. Judge geometry, not expression.
- eyebrowShape means the visible brow impression: straight/horizontal, arched/raised center, slanted/serious angled, or soft/low-contrast.
- noseShape means the visible low-res nose impression: small/subtle, straight/vertical, rounded/soft tip, or prominent/strong bridge.
- mouthShape means the visible low-resolution mouth footprint: use small for a compact mouth even when the lips are full, wide for a broad mouth, full for a strongly defined mouth whose footprint is not compact, and thin for a very subtle line.
- lipFullness independently records lip volume: thin, average, or full/plump. Do not collapse "small full lips" into only small or only full; return mouthShape "small" and lipFullness "full".
- jawShape means the visible lower-face contour: rounded/full jaw, pointed/narrow chin, square/strong jaw corners, or soft/low-contrast jaw.
- bangsLength means how far the front fringe visually falls: none, short/upper-forehead, brow/eyebrow-level, or eye/partly covering the eyes.
- bangsDensity describes how continuous the visible fringe is: sparse for separated wisps with substantial forehead gaps, balanced for clustered locks with several gaps, or dense for a bowl/blunt fringe with only a small staggered break. Do not infer a center part merely from a tiny separation between bang tips; hairPart requires a visible scalp/root direction.
- fringeEdge describes only the lower outline of the fringe: blunt for a mostly level baseline, staggered for distinct locks ending at alternating heights, or wispy for thin separated tips. Even dense blunt bangs must retain the visible natural break instead of becoming a solid rectangular bar.
- fringeOpening records the largest visible forehead gap between front-hair clusters from the viewer's perspective: left, center, right, or none. This is independent from hairPart: a bang-tip opening can exist without visible scalp/root parting. Prefer the actual dominant gap instead of forcing symmetry.
- hairSilhouette means the visible outer outline of the hair: rounded/dome-like, flat/sleek, swept/asymmetric, tousled/soft irregular, or spiky/sharp tufts.
- Classify hairSilhouette from the crown and temple OUTER CONTOUR, not from separated bang tips or individual highlight strands. Do not choose spiky merely because a straight fringe has jagged ends; spiky requires multiple clearly outward-pointing crown or temple tufts. A smooth dome over staggered bangs is rounded.
- hairBackShape is the inferred rear construction: tapered neat nape, rounded full back, long hair down the back, tied ponytail/bun, or undercut close nape. Use visible side/top hair and inferred.hairBack rationale.
- overallHairLength records the lowest point reached by the longest clearly visible, substantial continuous locks (ignore only isolated flyaway hairs), not just the front fringe: cropped/scalp, ear, jaw, shoulder, chest, waist, or hip. "chest" ends around the bust/upper torso and clearly above the natural waist; "waist" reaches the lower ribs, waistband or belt line; "hip" reaches the shorts/skirt side seam or hip line. For full-body and three-quarter photos, compare the endpoint directly with the bust, belt/natural waist and hip line before choosing. Preserve clearly visible chest-, waist- or hip-length hair instead of collapsing every long hairstyle to shoulder length. If the endpoint is hidden by the crop, infer it conservatively from visible strands and inferred.hairBack and state that inference in identityPrompt.
- hairPart is the visible parting direction from the viewer's perspective: center, left, right, or none.
- sideHairLength is how far the side hair visually falls: none, short/ear-level, cheek, jaw, or shoulder.
- sideHairShape describes the side profile around the temple and ear: tapered narrows cleanly toward the ear, ear_hugging wraps around and partly frames the ear, face_framing forms longer front locks, flared pushes outward with visible volume, and undercut is close/shaved below the top. Infer it from both visible sides and keep left/right profiles coherent unless the photo clearly shows an asymmetric cut.
- sideHairAsymmetry records which side has a clearly longer or fuller side lock from the VIEWER'S perspective: "left", "right", or "none". Use it only for a real structural difference, not merely because head rotation hides one side. Repeat the side in observed.hair and identityPrompt.
- earExposure records whether the ears are covered by hair, partially exposed, or clearly visible. Judge the visible ear opening independently from sideHairShape so ear_hugging short hair does not become a long solid side panel.
- necklace means a clearly visible necklace/chain/pendant; otherwise "none".
- hairAccessory means a visible hair flower, bow, ribbon or clip that should survive at 64x64; otherwise "none". hairAccessoryScale is small for a tiny pin/single subtle bloom, medium for a clearly visible ordinary accessory, and large for an oversized bloom, multiple-flower cluster, floral arrangement or prominent bow. Judge its occupied area relative to the head. hairAccessorySide is the accessory position from the viewer's perspective: left, right, or center. hairAccessoryColor is the dominant visible accessory color; do not copy the hair or clothing color when the accessory itself has a different color. For multicolor flowers choose the dominant petal color.
- neckAccessory means a visible bow, necktie, scarf or distinct collar at the throat/chest that should be rendered as a bold low-res cue. Inspect the knot and hanging fabric: paired loops or broad pointed tails descending below the throat are a bow or scarf, not merely a collar. Use "collar" only when the visible fabric consists of paired shirt/lapel flaps ending close to the neckline with no central knot and no long hanging tails. A shirt can have both an ordinary collar and a prominent white neck bow; choose "bow" when the bow is the stronger 64x64 identity cue.
- bottomPattern captures visible plaid/checks, stripes, pleats or lace on the lower garment. If the lower body is not visible, choose a coherent inferred pattern only when it fits the visible top; otherwise "plain".
- bottomAccent captures a bold low-res lower-body detail: belt, cuffs, side stripe or ribbon. If the lower body is not visible, infer one from the visible top's formality and color harmony when useful; otherwise "none".
- legwear captures visible socks, stockings, leg warmers or thigh-highs. Treat knee-high, over-knee and OTK socks as thigh_highs for low-resolution rendering. legwearColor is the closest dominant fabric color of that legwear (use beige for cream/ivory/oatmeal). Preserve the photographed color instead of borrowing the top or shoe color. If legwear is inferred, choose a coherent color from the visible outfit. legwearAsymmetry is "left" or "right" when only one leg has the distinctive legwear, "both" when both legs do, and "none" when no legwear is visible.
- thighAccessory independently captures a bow, tied ribbon or garter visibly attached around the upper thigh. thighAccessorySide is its side from the VIEWER'S perspective. Use "none" for both fields when no thigh accessory exists. Never infer a thigh bow merely because the opposite leg has one-sided legwear.
- For full_body photos, renderHints.bottomPattern, bottomAccent, legwear, legwearAsymmetry, thighAccessory and thighAccessorySide must be based on the visible lower body whenever visible; do not default to plain/none if plaid, pleats, lace, ribbons, socks, stockings, leg warmers or asymmetric details are visible.
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
      "thighAccessory": "none" | "bow" | "ribbon" | "garter",
      "thighAccessorySide": "none" | "left" | "right" | "both",
      "shoeStyle": "sneakers" | "dress_shoes" | "boots" | "loafers" | "sandals",
      "rationale": str
    } | null,
    "shoes": { "value": str, "rationale": str } | null
  },
  "renderHints": {
    "faceShape": "round" | "oval" | "long" | "angular" | "square",
    "eyeShape": "narrow" | "almond" | "round",
    "eyeSize": "small" | "average" | "large",
    "eyeSpacing": "close" | "average" | "wide",
    "eyeTilt": "upturned" | "level" | "downturned",
    "eyebrowShape": "straight" | "arched" | "slanted" | "soft",
    "noseShape": "small" | "straight" | "rounded" | "prominent",
    "mouthShape": "small" | "wide" | "full" | "thin",
    "lipFullness": "thin" | "average" | "full",
    "jawShape": "rounded" | "pointed" | "square" | "soft",
    "bangs": "none" | "straight" | "side" | "curtain" | "wispy",
    "bangsLength": "none" | "short" | "brow" | "eye",
    "bangsDensity": "sparse" | "balanced" | "dense",
    "fringeEdge": "blunt" | "staggered" | "wispy",
    "fringeOpening": "none" | "left" | "center" | "right",
    "hairTexture": "straight" | "wavy" | "curly" | "coily",
    "hairVolume": "flat" | "normal" | "full",
    "hairSilhouette": "rounded" | "flat" | "swept" | "tousled" | "spiky",
    "hairBackShape": "tapered" | "rounded" | "long" | "tied" | "undercut",
    "overallHairLength": "cropped" | "ear" | "jaw" | "shoulder" | "chest" | "waist" | "hip",
    "hairPart": "none" | "center" | "left" | "right",
    "sideHairLength": "none" | "short" | "cheek" | "jaw" | "shoulder",
    "sideHairShape": "tapered" | "ear_hugging" | "face_framing" | "flared" | "undercut",
    "sideHairAsymmetry": "none" | "left" | "right",
    "earExposure": "covered" | "partial" | "visible",
    "garmentTexture": "plain" | "knit" | "denim" | "leather" | "striped" | "patterned",
    "outerLayer": "none" | "light" | "heavy",
    "outerGarment": "none" | "cardigan" | "open_jacket" | "coat" | "vest",
    "necklace": "none" | "silver" | "gold" | "dark",
    "hairAccessory": "none" | "flower" | "bow" | "ribbon" | "clip",
    "hairAccessoryScale": "small" | "medium" | "large",
    "hairAccessorySide": "left" | "right" | "center",
    "hairAccessoryColor": "black" | "brown" | "white" | "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink",
    "neckAccessory": "none" | "bow" | "tie" | "scarf" | "collar",
    "bottomPattern": "plain" | "plaid" | "striped" | "pleated" | "lace",
    "bottomAccent": "none" | "belt" | "cuffs" | "side_stripe" | "ribbon",
    "legwear": "none" | "socks" | "stockings" | "leg_warmers" | "thigh_highs",
    "legwearColor": "black" | "brown" | "white" | "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "beige",
    "legwearAsymmetry": "none" | "left" | "right" | "both",
    "thighAccessory": "none" | "bow" | "ribbon" | "garter",
    "thighAccessorySide": "none" | "left" | "right" | "both"
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
    thighAccessory: {
      type: "string",
      enum: ["none", "bow", "ribbon", "garter"],
    },
    thighAccessorySide: {
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
    "thighAccessory",
    "thighAccessorySide",
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
      required: [
        "hairBack",
        "upperBody",
        "lowerBody",
        "lowerBodyDesign",
        "shoes",
      ],
    },
    renderHints: {
      type: "object",
      properties: {
        faceShape: {
          type: "string",
          enum: ["round", "oval", "long", "angular", "square"],
        },
        eyeShape: { type: "string", enum: ["narrow", "almond", "round"] },
        eyeSize: { type: "string", enum: ["small", "average", "large"] },
        eyeSpacing: { type: "string", enum: ["close", "average", "wide"] },
        eyeTilt: { type: "string", enum: ["upturned", "level", "downturned"] },
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
        lipFullness: {
          type: "string",
          enum: ["thin", "average", "full"],
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
        bangsDensity: {
          type: "string",
          enum: ["sparse", "balanced", "dense"],
        },
        fringeEdge: {
          type: "string",
          enum: ["blunt", "staggered", "wispy"],
        },
        fringeOpening: {
          type: "string",
          enum: ["none", "left", "center", "right"],
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
        overallHairLength: {
          type: "string",
          description:
            "Lowest substantial continuous hair endpoint: chest ends around the bust and above the natural waist; waist reaches the lower ribs, waistband or belt; hip reaches the hip or shorts/skirt side seam.",
          enum: ["cropped", "ear", "jaw", "shoulder", "chest", "waist", "hip"],
        },
        hairPart: {
          type: "string",
          enum: ["none", "center", "left", "right"],
        },
        sideHairLength: {
          type: "string",
          enum: ["none", "short", "cheek", "jaw", "shoulder"],
        },
        sideHairShape: {
          type: "string",
          enum: [
            "tapered",
            "ear_hugging",
            "face_framing",
            "flared",
            "undercut",
          ],
        },
        sideHairAsymmetry: {
          type: "string",
          enum: ["none", "left", "right"],
        },
        earExposure: {
          type: "string",
          enum: ["covered", "partial", "visible"],
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
        hairAccessoryScale: {
          type: "string",
          enum: ["small", "medium", "large"],
        },
        hairAccessorySide: {
          type: "string",
          enum: ["left", "right", "center"],
        },
        hairAccessoryColor: {
          type: "string",
          enum: [
            "black",
            "brown",
            "white",
            "gray",
            "red",
            "orange",
            "yellow",
            "green",
            "blue",
            "purple",
            "pink",
          ],
        },
        neckAccessory: {
          type: "string",
          description:
            "Strongest neck fabric cue. A central knot with paired loops or long pointed hanging tails is bow/scarf even over a collared shirt. Use collar only for short paired collar/lapel flaps with no knot or long tails.",
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
        legwearColor: {
          type: "string",
          enum: [
            "black",
            "brown",
            "white",
            "gray",
            "red",
            "orange",
            "yellow",
            "green",
            "blue",
            "purple",
            "pink",
            "beige",
          ],
        },
        legwearAsymmetry: {
          type: "string",
          enum: ["none", "left", "right", "both"],
        },
        thighAccessory: {
          type: "string",
          enum: ["none", "bow", "ribbon", "garter"],
        },
        thighAccessorySide: {
          type: "string",
          enum: ["none", "left", "right", "both"],
        },
      },
      required: [
        "faceShape",
        "eyeShape",
        "eyeSize",
        "eyeSpacing",
        "eyeTilt",
        "eyebrowShape",
        "noseShape",
        "mouthShape",
        "lipFullness",
        "jawShape",
        "bangs",
        "bangsLength",
        "bangsDensity",
        "fringeEdge",
        "fringeOpening",
        "hairTexture",
        "hairVolume",
        "hairSilhouette",
        "hairBackShape",
        "overallHairLength",
        "hairPart",
        "sideHairLength",
        "sideHairShape",
        "sideHairAsymmetry",
        "earExposure",
        "garmentTexture",
        "outerLayer",
        "outerGarment",
        "necklace",
        "hairAccessory",
        "hairAccessoryScale",
        "hairAccessorySide",
        "hairAccessoryColor",
        "neckAccessory",
        "bottomPattern",
        "bottomAccent",
        "legwear",
        "legwearColor",
        "legwearAsymmetry",
        "thighAccessory",
        "thighAccessorySide",
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

export type ValidationResult =
  { ok: true; analysis: PhotoAnalysis } | ValidationFailure;

const FRAMINGS: Framing[] = [
  "face",
  "upper_body",
  "three_quarter",
  "full_body",
];

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
      errors.push(
        `failReason: 허용되지 않은 값 ${JSON.stringify(obj.failReason)}`,
      );
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
        observed: {
          face: "",
          hair: "",
          accessories: "",
          clothing: "",
          colorPalette: [],
        },
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
          eyeSize: "average",
          eyeSpacing: "average",
          eyeTilt: "level",
          eyebrowShape: "straight",
          noseShape: "small",
          mouthShape: "small",
          lipFullness: "average",
          jawShape: "soft",
          bangs: "none",
          bangsLength: "none",
          bangsDensity: "balanced",
          fringeEdge: "staggered",
          fringeOpening: "none",
          hairTexture: "straight",
          hairVolume: "normal",
          hairSilhouette: "rounded",
          hairBackShape: "tapered",
          overallHairLength: "ear",
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
          neckAccessory: "none",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearColor: "white",
          legwearAsymmetry: "none",
          thighAccessory: "none",
          thighAccessorySide: "none",
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
      errors.push(
        `${path}.${key}: ?덉슜?섏? ?딆? 媛?${JSON.stringify(fieldValue)}`,
      );
      return fallback;
    };

    return {
      bottomType: enumField(
        "bottomType",
        ["pants", "jeans", "shorts", "skirt"],
        "pants",
      ),
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
      thighAccessory: enumField(
        "thighAccessory",
        ["none", "bow", "ribbon", "garter"],
        "none",
      ),
      thighAccessorySide: enumField(
        "thighAccessorySide",
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
    hairBack: parseInferredItem(
      "inferred.hairBack",
      inf.hairBack,
      false,
    ) as InferredItem,
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
    eyeSize: enumValue(
      "renderHints.eyeSize",
      hints.eyeSize,
      ["small", "average", "large"],
      "average",
    ),
    eyeSpacing: enumValue(
      "renderHints.eyeSpacing",
      hints.eyeSpacing,
      ["close", "average", "wide"],
      "average",
    ),
    eyeTilt: enumValue(
      "renderHints.eyeTilt",
      hints.eyeTilt,
      ["upturned", "level", "downturned"],
      "level",
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
    lipFullness: enumValue(
      "renderHints.lipFullness",
      hints.lipFullness,
      ["thin", "average", "full"],
      "average",
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
    bangsDensity: enumValue(
      "renderHints.bangsDensity",
      hints.bangsDensity,
      ["sparse", "balanced", "dense"],
      "balanced",
    ),
    fringeEdge: enumValue(
      "renderHints.fringeEdge",
      hints.fringeEdge,
      ["blunt", "staggered", "wispy"],
      "staggered",
    ),
    fringeOpening: enumValue(
      "renderHints.fringeOpening",
      hints.fringeOpening,
      ["none", "left", "center", "right"],
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
    overallHairLength: enumValue(
      "renderHints.overallHairLength",
      hints.overallHairLength,
      ["cropped", "ear", "jaw", "shoulder", "chest", "waist", "hip"],
      "ear",
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
    sideHairShape: enumValue(
      "renderHints.sideHairShape",
      hints.sideHairShape,
      ["tapered", "ear_hugging", "face_framing", "flared", "undercut"],
      "tapered",
    ),
    sideHairAsymmetry: enumValue(
      "renderHints.sideHairAsymmetry",
      hints.sideHairAsymmetry,
      ["none", "left", "right"],
      "none",
    ),
    earExposure: enumValue(
      "renderHints.earExposure",
      hints.earExposure,
      ["covered", "partial", "visible"],
      "partial",
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
    hairAccessoryScale: enumValue(
      "renderHints.hairAccessoryScale",
      hints.hairAccessoryScale,
      ["small", "medium", "large"],
      "medium",
    ),
    hairAccessorySide: enumValue(
      "renderHints.hairAccessorySide",
      hints.hairAccessorySide,
      ["left", "right", "center"],
      "left",
    ),
    hairAccessoryColor: enumValue(
      "renderHints.hairAccessoryColor",
      hints.hairAccessoryColor,
      [
        "black",
        "brown",
        "white",
        "gray",
        "red",
        "orange",
        "yellow",
        "green",
        "blue",
        "purple",
        "pink",
      ],
      "pink",
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
    legwearColor: enumValue(
      "renderHints.legwearColor",
      hints.legwearColor,
      [
        "black",
        "brown",
        "white",
        "gray",
        "red",
        "orange",
        "yellow",
        "green",
        "blue",
        "purple",
        "pink",
        "beige",
      ],
      "white",
    ),
    legwearAsymmetry: enumValue(
      "renderHints.legwearAsymmetry",
      hints.legwearAsymmetry,
      ["none", "left", "right", "both"],
      "none",
    ),
    thighAccessory: enumValue(
      "renderHints.thighAccessory",
      hints.thighAccessory,
      ["none", "bow", "ribbon", "garter"],
      "none",
    ),
    thighAccessorySide: enumValue(
      "renderHints.thighAccessorySide",
      hints.thighAccessorySide,
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
  | { ok: true; analysis: PhotoAnalysis; attempts: number }
  | {
      ok: false;
      reason: "ai_error" | "invalid_response" | "quota_exceeded";
      detail: string;
      attempts: number;
    };

export interface NeckDetailAnalysis {
  neckAccessory: "none" | "bow" | "tie" | "scarf" | "collar";
  confidence: "low" | "medium" | "high";
  evidence: string;
}

export type NeckDetailCallResult =
  | { ok: true; detail: NeckDetailAnalysis; attempts: number }
  | {
      ok: false;
      reason: "ai_error" | "invalid_response" | "quota_exceeded";
      detail: string;
      attempts: number;
    };

export const NECK_DETAIL_PROMPT = `This is a zoomed upper-body crop of the same person from a full or three-quarter photo.
Classify the strongest visible fabric construction at the throat/chest for a low-resolution Minecraft skin.

Inspect geometry, not garment stereotypes:
- bow: a central knot with paired loops, folded wings, or two broad pointed hanging tails
- scarf: wrapped or draped neck fabric, especially a central fold with long loose tails but no clear bow loops
- tie: a narrow central knot and one narrow vertical blade
- collar: only short paired shirt/lapel flaps ending near the neckline, with no central knot and no long hanging tails
- none: no distinct neck fabric cue

A collared shirt may also have a prominent bow or scarf over it. In that case choose the bow/scarf because it is the stronger 64x64 identity cue.
Return concise visual evidence. Use high confidence only when the knot/loops/tails or collar-only construction is clearly visible.`;

const NECK_DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    neckAccessory: {
      type: "string",
      enum: ["none", "bow", "tie", "scarf", "collar"],
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    evidence: { type: "string" },
  },
  required: ["neckAccessory", "confidence", "evidence"],
} as const;

/**
 * Focused second-pass classifier for tall full-body photos. The main pass
 * still owns every other feature; this crop only disambiguates tiny neck
 * fabric that is easy to collapse into a generic shirt collar.
 */
export async function runNeckDetailAnalysis(
  env: Env,
  detailImageDataUrl: string,
): Promise<NeckDetailCallResult> {
  const visionModel = env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  try {
    const modelOptions = visionModel.includes("moonshotai/")
      ? { chat_template_kwargs: { thinking: false } }
      : {};
    const result = await env.AI.run(
      visionModel as never,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: detailImageDataUrl },
              },
              { type: "text", text: NECK_DETAIL_PROMPT },
            ],
          },
        ],
        max_tokens: 260,
        temperature: 0,
        ...modelOptions,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "minecraft_skin_neck_detail",
            description:
              "Focused neck fabric classification from an upper-body crop",
            schema: NECK_DETAIL_SCHEMA,
          },
        },
      } as never,
    );
    const parsed = extractAnalysisPayload(result);
    if (!parsed) {
      return {
        ok: false,
        reason: "invalid_response",
        detail: "neck detail response did not contain JSON",
        attempts: 1,
      };
    }
    const neckAccessory = parsed.neckAccessory;
    const confidence = parsed.confidence;
    const evidence = parsed.evidence;
    if (
      !["none", "bow", "tie", "scarf", "collar"].includes(
        String(neckAccessory),
      ) ||
      !["low", "medium", "high"].includes(String(confidence)) ||
      typeof evidence !== "string" ||
      evidence.trim().length < 3
    ) {
      return {
        ok: false,
        reason: "invalid_response",
        detail: "neck detail response failed schema validation",
        attempts: 1,
      };
    }
    return {
      ok: true,
      detail: {
        neckAccessory:
          neckAccessory as NeckDetailAnalysis["neckAccessory"],
        confidence: confidence as NeckDetailAnalysis["confidence"],
        evidence: evidence.trim(),
      },
      attempts: 1,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: isWorkersAiQuotaError(detail)
        ? "quota_exceeded"
        : "ai_error",
      detail,
      attempts: 1,
    };
  }
}

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

  // Workers AI follows the OpenAI-compatible response_format shape here.
  // `json_schema.name` is required; passing the schema object directly makes
  // the provider reject the request before inference and forces every request
  // onto the less reliable free-form JSON retry.
  const structuredResponseFormat = {
    type: "json_schema",
    json_schema: {
      name: "minecraft_skin_photo_analysis",
      description:
        "Structured portrait, hair, face and outfit analysis for a Minecraft skin",
      schema: PHOTO_ANALYSIS_SCHEMA,
    },
  };
  const primaryModel = env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  const fallbackModel =
    env.VISION_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_VISION_MODEL;
  const visionModels = [...new Set([primaryModel, fallbackModel])];

  let lastDetail = "";
  let sawInvalidResponse = false;
  let attempts = 0;
  // A second structured pass is more reliable than switching to free-form
  // json_object output. Free-form retries were the main source of truncated or
  // schema-incomplete production responses. Alternate models across two rounds
  // so a transient provider error does not immediately fail the whole request.
  for (let round = 0; round < 2; round++) {
    for (const visionModel of visionModels) {
      let parsed: unknown;
      try {
        attempts += 1;
        const modelOptions = visionModel.includes("moonshotai/")
          ? { chat_template_kwargs: { thinking: false } }
          : {};
        const result = await env.AI.run(
          visionModel as never,
          {
            messages,
            max_tokens: 3200,
            temperature: 0,
            ...modelOptions,
            response_format: structuredResponseFormat,
          } as never,
        );
        parsed = extractAnalysisPayload(result);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        lastDetail = `${visionModel}: ${detail}`;
        if (isWorkersAiQuotaError(detail)) {
          return {
            ok: false,
            reason: "quota_exceeded",
            detail: lastDetail,
            attempts,
          };
        }
        continue;
      }
      if (parsed === null || parsed === undefined) {
        sawInvalidResponse = true;
        lastDetail = `${visionModel}: response did not contain JSON`;
        continue;
      }
      const validated = validatePhotoAnalysis(parsed);
      if (validated.ok) {
        return { ok: true, analysis: validated.analysis, attempts };
      }
      sawInvalidResponse = true;
      lastDetail = `${visionModel}: schema validation failed: ${validated.errors.join("; ")}`;
    }
  }
  return {
    ok: false,
    reason: sawInvalidResponse ? "invalid_response" : "ai_error",
    detail: lastDetail,
    attempts,
  };
}

function isWorkersAiQuotaError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("4006") ||
    normalized.includes("daily free allocation") ||
    (normalized.includes("neurons") && normalized.includes("used up"))
  );
}

/** Normalize Workers AI native (`response`) and chat-completions (`choices`) output. */
export function extractAnalysisPayload(
  result: unknown,
): Record<string, unknown> | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  const root = result as Record<string, unknown>;
  let content = root.response;
  if (content === undefined && Array.isArray(root.choices)) {
    const first = root.choices[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      const message = (first as Record<string, unknown>).message;
      if (
        typeof message === "object" &&
        message !== null &&
        !Array.isArray(message)
      ) {
        content = (message as Record<string, unknown>).content;
      }
    }
  }
  if (Array.isArray(content)) {
    content = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item !== "object" || item === null || Array.isArray(item))
          return "";
        const block = item as Record<string, unknown>;
        return typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }
  if (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content)
  ) {
    return content as Record<string, unknown>;
  }
  return typeof content === "string" ? extractJson(content) : null;
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
