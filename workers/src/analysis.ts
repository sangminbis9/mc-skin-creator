/**
 * 사진 분석 단계: llama-4-scout로 품질 검사 + observed/inferred 구조의
 * PhotoAnalysis를 뽑는다. 이 결과는 이미지 생성 프롬프트와
 * 절차적 fallback(팔레트 특징) 양쪽의 입력이 된다.
 *
 * observed = 사진에서 실제로 보이는 것, inferred = 보이지 않아 추론한 것.
 * 이 구분을 스키마 수준에서 강제해 환각을 관찰 결과로 취급하지 않게 한다.
 */

import {
  NEURONS_VISION_ANALYSIS,
  NEURONS_VISION_DETAIL_ESTIMATE,
  visionNeuronsFromUsage,
} from "./quota";
import {
  geminiRetryAfterMs,
  generateGeminiStructuredJson,
  isGeminiQuotaError,
  isGeminiTemporaryRateLimit,
} from "./gemini";
import type { Env } from "./types";
import type { IdentityGeometryAnalysis, NormalizedBox } from "./identityGeometry";

const DEFAULT_VISION_MODEL = "gemini-3.6-flash";
const DEFAULT_FALLBACK_VISION_MODEL = "gemini-3.1-flash-lite";

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
  skinUndertone: "warm" | "cool" | "neutral";
  faceShape: "round" | "oval" | "long" | "angular" | "square";
  eyeShape: "narrow" | "almond" | "round";
  eyeSize: "small" | "average" | "large";
  irisLightness: "dark" | "medium" | "light";
  eyeSpacing: "close" | "average" | "wide";
  eyeTilt: "upturned" | "level" | "downturned";
  eyebrowShape: "straight" | "arched" | "slanted" | "soft";
  noseShape: "small" | "straight" | "rounded" | "prominent";
  mouthShape: "small" | "wide" | "full" | "thin";
  mouthOpening: "closed" | "slightly_open" | "teeth_visible";
  lipFullness: "thin" | "average" | "full";
  lipColor: "natural" | "rose" | "red" | "berry" | "brown" | "coral";
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

/** Per-reference ownership for an ordered same-person photo set. */
export interface PortraitRegion {
  /** Bounds are normalized to the selected portrait source, never the upload set. */
  subjectBox: NormalizedBox;
  headBox: NormalizedBox;
  faceBox: NormalizedBox;
  confidence: number;
}

export interface SourceSelection {
  portraitImageIndex: number;
  outfitImageIndex: number;
  generationImageIndex: number;
  portraitEvidence: string;
  outfitEvidence: string;
  generationEvidence: string;
  /** Primary subject localization; null is an explicit request for heuristic recovery. */
  portraitRegion?: PortraitRegion | null;
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
  sourceSelection: SourceSelection;
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
  canonicalIdentity: {
    overallImpression: string;
    mustPreserve: string[];
    features: IdentityFeaturePriority[];
  };
  renderHints: PixelRenderHints;
  identityPrompt: string;
  outfitPrompt: string;
  negativePrompt: string;
  fallbackFeatures: FallbackFeatures;
  /** High-resolution normalized landmarks; absent only when the optional focused pass fails. */
  identityGeometry?: IdentityGeometryAnalysis;
}

export type IdentityFeatureCategory =
  "face" | "hair" | "accessory" | "outfit" | "color" | "silhouette";

export interface IdentityFeaturePriority {
  feature: string;
  category: IdentityFeatureCategory;
  /** 5 is the strongest likeness cue and must be protected first. */
  priority: 1 | 2 | 3 | 4 | 5;
  confidence: "low" | "medium" | "high";
  evidence: string;
  targetRegions: string[];
}

const CLOTHING_COLOR_VALUES = [
  "black",
  "white",
  "gray",
  "light-gray",
  "red",
  "orange",
  "yellow",
  "green",
  "dark-green",
  "blue",
  "navy",
  "sky-blue",
  "purple",
  "pink",
  "brown",
  "beige",
  "denim",
  "khaki",
] as const;
const CLOTHING_COLOR_ENUM = CLOTHING_COLOR_VALUES.map(
  (color) => `"${color}"`,
).join(" | ");

export const ANALYSIS_PROMPT = `You are a character designer analyzing a photo to build a Minecraft-style avatar that closely resembles the person in it.

STEP 1 — photo quality:
- "fail" + failReason "no_face" if there is no real human face clearly visible (this includes blank images, objects, landscapes, drawings without a real person).
- "fail" + failReason "blurry" if the photo is too blurry to see facial features.
- "fail" + failReason "too_small" if the person is too small in the frame.
- "warn" if usable but not ideal, "pass" if good.
A photo showing only a face IS acceptable — never fail a photo just because the body is not visible.
If multiple people appear, analyze only the most prominent/central person.

STEP 2 — reference ownership and framing:
- With one image, set every sourceSelection image index to 0.
- With multiple compatible images, portraitImageIndex is the clearest face+hair view for a dedicated crop, outfitImageIndex is the clearest head-to-toe clothing evidence, and generationImageIndex is the most complete, least-occluded view that should anchor a full Minecraft character. These can be different images. Give concrete evidence for each choice.
- Do not automatically select image 0. Prefer a sharp face portrait for portraitImageIndex and a clear three-quarter/full-body view for outfitImageIndex and generationImageIndex. Use only indices that exist in the attached set.
- framing describes the most complete compatible view selected for generation: "face" (head only), "upper_body" (head + torso), "three_quarter" (down to thighs/knees), "full_body".
- visibleRegions is the union of regions directly visible across all compatible references. A lower body seen in image 2 is visible, not inferred, even when image 0 is a face portrait.
- Localize only the same primary person selected by portraitImageIndex. Append to portraitEvidence exactly " | REGION:[subject L,T,R,B,head L,T,R,B,face L,T,R,B,confidence]" using 13 comma-separated numbers, or " | REGION:null" when bounds cannot be measured. All coordinates are normalized 0..1 within that selected source image, not within a montage or another reference. subjectBox encloses that person's visible body, headBox encloses crown/hair/head covering through jaw and a small amount of neck, and faceBox encloses the visible forehead, brows, eyes, nose, mouth, chin, glasses and face edges. Do not include another person's face.

STEP 3 — observed: describe ONLY what is actually visible in at least one compatible reference. Fuse the clearest evidence per region instead of privileging upload order. Be specific and concrete (colors, shapes, textures). Never invent details you cannot see. For observed.clothing, describe garment type, colors and general patterns (stripes, plain, graphic) — never brand names or logo identities. Never return the bare word "logo": describe a visible small mark neutrally as a graphic, badge or marking and include its visible colors, approximate shape and viewer-relative chest location when readable.
- observed.face MUST explicitly state the visible skin-tone impression (pale/fair, light, medium, tan, brown or dark, plus warm/cool/neutral undertone when readable). Include that skin colour in observed.colorPalette. Do not omit it merely because the lighting is soft or the face occupies a small part of the frame.
- For observed.hair, explicitly describe root/scalp part visibility, fringe density and gaps, left and right temple contours, whether either ear is exposed or framed, side-hair taper/flare, the visible transition toward the nape, and the lowest substantial hair endpoint relative to the shoulders, chest/bust, natural waist or belt, and hips. Correct for head tilt and slanted shoulders: compare the locks with local physical landmarks on the same side of the person instead of raw screen height. Do not summarize all short hair as a bowl cut or all side hair as merely "short".
- For every visible white or contrasting fabric at the throat, describe its construction separately from the shirt: ordinary collar flaps, a central knot, paired loops, and any broad hanging tails. Do not call the whole shape a "collar" merely because a collared shirt is underneath. A central knot with two long pointed fabric tails is a neck bow or scarf even when its loops are folded flat or partly hidden.
- If lower body or feet are visible, observed.clothing MUST explicitly name the lower garment type (skirt/shorts/pants/jeans; describe skorts, pleated shorts or skirt-like culottes as skirt-like for low-resolution rendering), pattern or construction (plaid/checkered/pleated/lace/striped/plain), visible legwear (socks/stockings/leg warmers/thigh-highs/knee-high or over-knee socks), legwear asymmetry from the viewer's perspective, and shoe type/color.
- Preserve side-specific details using viewer-left/viewer-right wording for one-sided flowers, bows, leg warmers, thigh bows, side stripes, straps or shoe details.
- When a one-sided accessory or legwear exists, repeat the exact side in observed/inferred text and in renderHints/structured fields. Do not summarize it as simply "asymmetric".

STEP 4 — inferred: for body parts and clothing NOT visible, design choices that stay coherent with the observed colors, style and mood. Each inferred item needs a short rationale grounded in observed evidence. Rules:
- Never base clothing choices on gender presentation or facial stereotypes; use only visible clothing cues, colors and mood.
- If there are no clothing cues at all, choose neutral casual wear that harmonizes with skin/hair colors. Vary between shirt, knit, hoodie or light jacket depending on the photo's mood — do not always default to a plain t-shirt.
- If a region IS visible in the photo, set its inferred entry to null.
- If the lower body is NOT visible, fill inferred.lowerBodyDesign using minimum invention: extend only materials, colors, formality and construction already supported by the visible outfit. Plain pants, no accent, no legwear and simple shoes is valid when it is the least assumptive continuation. Never add a pattern, belt, stripe, accessory, asymmetry or legwear merely to make the design more detailed. State the evidence boundary in rationale. If the lower body IS visible, set inferred.lowerBodyDesign to null.
- For inferred lower-body designs with one-sided legwear, use legwearAsymmetry "left" or "right" from the viewer's perspective. For a one-sided thigh bow, ribbon or garter, use thighAccessorySide independently. Repeat both exact sides in outfitPrompt; a thigh accessory can intentionally sit on the opposite leg from asymmetric legwear.

STEP 5 — prompts for an image generation model:
- identityPrompt: 2-4 sentences capturing the recognizable identity, as SPECIFIC as possible: face shape (round/oval/angular), skin tone, hair (exact color shade, parting direction, bangs style, length, texture like straight/wavy/curly), eye shape and color, eyebrow shape, nose/mouth impression, facial hair, glasses shape/color, hat, earrings, and any distinctive features. Avoid generic phrases — describe what makes THIS person recognizable.
- outfitPrompt: 1-3 sentences describing the COMPLETE head-to-toe outfit: visible garments first (preserve them faithfully), then inferred garments. When lower body or feet are visible, explicitly include the lower garment, legwear/asymmetry and shoe details instead of summarizing them as "bottoms" or omitting them.
- negativePrompt: things to avoid for this specific person (e.g. "no beard" if clean-shaven, "no hat" if bare-headed).

STEP 5A — canonicalIdentity and likeness salience:
- When multiple reference images are supplied, treat them as evidence for the SAME person and use sourceSelection rather than upload order to assign portrait, outfit and generation ownership. Reconcile lighting, pose and expression differences; never create multiple people or average away a distinctive feature.
- Before fusing identity evidence, check that each alternate is compatible with the majority on multiple stable cues. If one alternate conflicts on several stable traits beyond plausible lighting, pose, expression, styling or time differences, treat it as an accidental outlier: do not blend its conflicting face, hair or accessory traits. Cues consistently supported by the clearest compatible references win. Never reject an otherwise compatible alternate merely because makeup, expression, lighting, hairstyle or outfit changed.
- canonicalIdentity.overallImpression: one concise description of the stable appearance shared across the references.
- canonicalIdentity.mustPreserve: 3-8 concrete, ordered likeness cues that must remain readable after reduction to a 64x64 Minecraft skin.
- canonicalIdentity.features: 4-12 distinct cues. Assign priority 5 only to the strongest identity cues, then 4/3/2/1 in descending importance. Include category, confidence, visible evidence, and exact targetRegions such as "head.front", "head.overlay", "torso.front", "arm.left" or "leg.right".
- Prefer stable face geometry, hair silhouette/part/fringe, signature glasses/accessories, characteristic color blocks and outfit silhouette. Do not use race, gender, age guesses, attractiveness, or personality as identity cues.

STEP 6 — renderHints for a very low-resolution 8x8 face and layered Minecraft skin:
- Classify the visible skin undertone, face geometry, eye geometry/size/iris lightness/spacing/tilt, eyebrow shape, nose shape, mouth footprint/opening, lip fullness/color, jaw shape, bangs, bangs length/density/fringe edge/opening, hair texture/volume, hair silhouette, back-hair shape, overall hair length, hair parting, side-hair length/shape, ear exposure, garment texture, outer-layer thickness, and necklace.
- skinUndertone records the skin itself after discounting studio color casts, background spill, blush and makeup: warm for golden/peach/yellow, cool for rosy/pink/blue-red, and neutral when neither direction clearly dominates. Keep it independent from skin lightness.
- eyeSize describes the visible eye aperture relative to this person's face: small for compact or narrow openings, average for moderate openings, and large when the eyes are a dominant identity cue with clearly visible vertical iris/sclera area. Judge the actual eye opening, not eyeliner, glasses magnification, raised eyebrows, or facial expression.
- irisLightness describes the value of the iris itself within its color family: dark for near-black/deep irises, medium for a subdued but readable color, and light for distinctly pale/bright irises. Ignore white catchlights, sclera, eyelid shadow, exposure and red-eye; do not call a dark iris light because it contains a small reflection.
- eyeTilt describes the line between each eye's inner and outer corner: upturned when the outer corners sit visibly higher, level when nearly horizontal, or downturned when the outer corners sit visibly lower. Judge geometry, not expression.
- eyebrowShape means the visible brow impression: straight/horizontal, arched/raised center, slanted/serious angled, or soft/low-contrast.
- noseShape means the visible low-res nose impression: small/subtle, straight/vertical, rounded/soft tip, or prominent/strong bridge.
- mouthShape means the visible low-resolution mouth footprint: use small for a compact mouth even when the lips are full, wide for a broad mouth, full for a strongly defined mouth whose footprint is not compact, and thin for a very subtle line.
- mouthOpening is independent from mouth width and expression: closed when the lips meet with no dark opening, slightly_open when a narrow dark gap is visible but teeth are not a dominant cue, and teeth_visible only when a clear white tooth row is visibly exposed. A friendly or wide smile is not automatically teeth_visible.
- lipFullness independently records lip volume: thin, average, or full/plump. Do not collapse "small full lips" into only small or only full; return mouthShape "small" and lipFullness "full".
- lipColor records the dominant visible lip pigmentation after discounting specular highlights and deep mouth-corner shadows: natural for skin-adjacent/subtle lips, rose for muted pink, red for clear red lipstick, berry for cool magenta/wine, brown for warm nude/brown, and coral for orange-pink. Judge the lips themselves, not cheek blush or surrounding skin.
- jawShape means the visible lower-face contour: rounded/full jaw, pointed/narrow chin, square/strong jaw corners, or soft/low-contrast jaw.
- bangsLength means how far the front fringe visually falls: none, short/upper-forehead, brow/eyebrow-level, or eye/partly covering the eyes.
- bangsDensity describes how continuous the visible fringe is: sparse for separated wisps with substantial forehead gaps, balanced for clustered locks with several gaps, or dense for a bowl/blunt fringe with only a small staggered break. Do not infer a center part merely from a tiny separation between bang tips; hairPart requires a visible scalp/root direction.
- fringeEdge describes only the lower outline of the fringe: blunt for a mostly level baseline, staggered for distinct locks ending at alternating heights, or wispy for thin separated tips. Even dense blunt bangs must retain the visible natural break instead of becoming a solid rectangular bar.
- fringeOpening records the largest visible forehead gap between front-hair clusters from the viewer's perspective: left, center, right, or none. This is independent from hairPart: a bang-tip opening can exist without visible scalp/root parting. Prefer the actual dominant gap instead of forcing symmetry.
- hairSilhouette means the visible outer outline of the hair: rounded/dome-like, flat/sleek, swept/asymmetric, tousled/soft irregular, or spiky/sharp tufts.
- Classify hairSilhouette from the crown and temple OUTER CONTOUR, not from separated bang tips or individual highlight strands. Do not choose spiky merely because a straight fringe has jagged ends; spiky requires multiple clearly outward-pointing crown or temple tufts. A smooth dome over staggered bangs is rounded.
- hairVolume is independent from silhouette and length: flat means sleek/low-volume hair lying close to the head, normal means ordinary lift, and full means visibly thick, voluminous or expanded away from the scalp. Long hair is not automatically full, and a rounded anatomical crown can still have flat volume.
- Straight or blunt bangs do NOT make the crown silhouette flat. Short two-block, bowl-like or ear-length hair with a visibly domed crown and tapered/ear-hugging sides is rounded unless the top itself is explicitly flat, boxy or close-cropped.
- hairBackShape is the inferred rear construction: tapered neat nape, rounded full back, long hair down the back, tied ponytail/bun, or undercut close nape. Use visible side/top hair and inferred.hairBack rationale.
- overallHairLength records the lowest point reached by the longest clearly visible, substantial continuous locks (ignore only isolated flyaway hairs), not just the front fringe: cropped/scalp, ear, jaw, shoulder, chest, waist, or hip. Curly width/volume is NOT length: curls that flare outward around the ears or jaw but do not visibly touch or overlap the shoulder line are ear- or jaw-length, never shoulder-length. Choose shoulder only when substantial locks visibly reach the physical shoulder seam. When the head is tilted or the shoulders slope in the image, mentally rotate the head upright and compare each lock with its local ear, jaw, neck and same-side shoulder seam; never use raw image y-position alone. "chest" ends around the bust/upper torso and clearly above the natural waist; "waist" reaches the lower ribs, waistband or belt line; "hip" reaches the shorts/skirt side seam or hip line. For full-body and three-quarter photos, compare the endpoint directly with the jaw, neck, shoulder seam, bust, belt/natural waist and hip line before choosing. Preserve clearly visible chest-, waist- or hip-length hair instead of collapsing every long hairstyle to shoulder length. If the endpoint is hidden by the crop, infer it conservatively from visible strands and inferred.hairBack and state that inference in identityPrompt.
- hairPart is the visible parting direction from the viewer's perspective: center, left, right, or none.
- sideHairLength is how far the side hair visually falls: none, short/ear-level, cheek, jaw, or shoulder. Keep it geometrically consistent with overallHairLength, hairBackShape, and sideHairShape: a cropped/ear-length cut with a tapered or undercut back normally has none/short side hair, never a cheek/jaw/shoulder panel, unless a distinct longer face-framing lock is clearly visible and explicitly described.
- sideHairShape describes the side profile around the temple and ear: tapered narrows cleanly toward the ear, ear_hugging wraps around and partly frames the ear, face_framing forms longer front locks, flared pushes outward with visible volume, and undercut is close/shaved below the top. Infer it from both visible sides and keep left/right profiles coherent unless the photo clearly shows an asymmetric cut.
- sideHairAsymmetry records which side has a clearly longer or fuller side lock from the VIEWER'S perspective: "left", "right", or "none". Use it only for a real structural difference, not merely because head rotation hides one side. Repeat the side in observed.hair and identityPrompt.
- earExposure records whether the ears are covered by hair, partially exposed, or clearly visible. Judge the visible ear opening independently from sideHairShape so ear_hugging short hair does not become a long solid side panel.
- necklace means a clearly visible necklace/chain/pendant; otherwise "none".
- hairAccessory means a visible hair flower, bow, ribbon or clip that should survive at 64x64; otherwise "none". hairAccessoryScale is small for a tiny pin/single subtle bloom, medium for a clearly visible ordinary accessory, and large for an oversized bloom, multiple-flower cluster, floral arrangement or prominent bow. Judge its occupied area relative to the head. hairAccessorySide is the accessory position from the viewer's perspective: left, right, or center. hairAccessoryColor is the dominant visible accessory color; do not copy the hair or clothing color when the accessory itself has a different color. For multicolor flowers choose the dominant petal color.
- neckAccessory means a visible bow, necktie, scarf or distinct collar at the throat/chest that should be rendered as a bold low-res cue. Inspect the knot and hanging fabric: paired loops or broad pointed tails descending below the throat are a bow or scarf, not merely a collar. Use "collar" only when the visible fabric consists of paired shirt/lapel flaps ending close to the neckline with no central knot and no long hanging tails. A shirt can have both an ordinary collar and a prominent white neck bow; choose "bow" when the bow is the stronger 64x64 identity cue.
- bottomPattern captures visible plaid/checks, stripes, pleats or lace on the lower garment. If the lower body is not visible, choose a coherent inferred pattern only when it fits the visible top; otherwise "plain".
- bottomAccent captures a bold low-res lower-body detail: belt, cuffs, side stripe or ribbon. If the lower body is not visible, use "none" unless the visible outfit directly supports a coordinated construction such as matching formal trousers with a belt. Never invent a side stripe, ribbon, cuff or other new motif merely to make the hidden lower body more detailed.
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
  "sourceSelection": {
    "portraitImageIndex": int,
    "outfitImageIndex": int,
    "generationImageIndex": int,
    "portraitEvidence": str,
    "outfitEvidence": str,
    "generationEvidence": str
  },
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
    "skinUndertone": "warm" | "cool" | "neutral",
    "faceShape": "round" | "oval" | "long" | "angular" | "square",
    "eyeShape": "narrow" | "almond" | "round",
    "eyeSize": "small" | "average" | "large",
    "irisLightness": "dark" | "medium" | "light",
    "eyeSpacing": "close" | "average" | "wide",
    "eyeTilt": "upturned" | "level" | "downturned",
    "eyebrowShape": "straight" | "arched" | "slanted" | "soft",
    "noseShape": "small" | "straight" | "rounded" | "prominent",
    "mouthShape": "small" | "wide" | "full" | "thin",
    "mouthOpening": "closed" | "slightly_open" | "teeth_visible",
    "lipFullness": "thin" | "average" | "full",
    "lipColor": "natural" | "rose" | "red" | "berry" | "brown" | "coral",
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
    sourceSelection: {
      type: "object",
      additionalProperties: false,
      properties: {
        portraitImageIndex: { type: "integer", minimum: 0, maximum: 4 },
        outfitImageIndex: { type: "integer", minimum: 0, maximum: 4 },
        generationImageIndex: { type: "integer", minimum: 0, maximum: 4 },
        portraitEvidence: { type: "string" },
        outfitEvidence: { type: "string" },
        generationEvidence: { type: "string" },
      },
      required: [
        "portraitImageIndex",
        "outfitImageIndex",
        "generationImageIndex",
        "portraitEvidence",
        "outfitEvidence",
        "generationEvidence",
      ],
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
    canonicalIdentity: {
      type: "object",
      additionalProperties: false,
      properties: {
        overallImpression: { type: "string" },
        mustPreserve: {
          type: "array",
          minItems: 3,
          maxItems: 8,
          items: { type: "string" },
        },
        features: {
          type: "array",
          minItems: 4,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              feature: { type: "string" },
              category: {
                type: "string",
                enum: [
                  "face",
                  "hair",
                  "accessory",
                  "outfit",
                  "color",
                  "silhouette",
                ],
              },
              priority: { type: "integer", minimum: 1, maximum: 5 },
              confidence: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
              evidence: { type: "string" },
              targetRegions: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
            },
            required: [
              "feature",
              "category",
              "priority",
              "confidence",
              "evidence",
              "targetRegions",
            ],
          },
        },
      },
      required: ["overallImpression", "mustPreserve", "features"],
    },
    renderHints: {
      type: "object",
      properties: {
        skinUndertone: {
          type: "string",
          enum: ["warm", "cool", "neutral"],
        },
        faceShape: {
          type: "string",
          enum: ["round", "oval", "long", "angular", "square"],
        },
        eyeShape: { type: "string", enum: ["narrow", "almond", "round"] },
        eyeSize: { type: "string", enum: ["small", "average", "large"] },
        irisLightness: {
          type: "string",
          enum: ["dark", "medium", "light"],
        },
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
        mouthOpening: {
          type: "string",
          enum: ["closed", "slightly_open", "teeth_visible"],
        },
        lipFullness: {
          type: "string",
          enum: ["thin", "average", "full"],
        },
        lipColor: {
          type: "string",
          enum: ["natural", "rose", "red", "berry", "brown", "coral"],
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
        "skinUndertone",
        "faceShape",
        "eyeShape",
        "eyeSize",
        "irisLightness",
        "eyeSpacing",
        "eyeTilt",
        "eyebrowShape",
        "noseShape",
        "mouthShape",
        "mouthOpening",
        "lipFullness",
        "lipColor",
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
    fallbackFeatures: {
      type: "object",
      description:
        "Coarse optional cache. The server reconstructs any omitted keys from observed, inferred and canonical identity evidence.",
    },
  },
  required: [
    "quality",
    "failReason",
    "framing",
    "visibleRegions",
    "sourceSelection",
    "observed",
    "inferred",
    "canonicalIdentity",
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

export type PortraitRegionValidation =
  | { ok: true; region: PortraitRegion }
  | { ok: false; reason: string };

/** Validate normalized primary-subject localization without trusting model output. */
export function validatePortraitRegion(value: unknown): PortraitRegionValidation {
  if (Array.isArray(value) && value.length === 13 && value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    value = {
      subjectBox: { left: value[0], top: value[1], right: value[2], bottom: value[3] },
      headBox: { left: value[4], top: value[5], right: value[6], bottom: value[7] },
      faceBox: { left: value[8], top: value[9], right: value[10], bottom: value[11] },
      confidence: value[12],
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "portrait_region_missing" };
  }
  const source = value as Record<string, unknown>;
  const parseBox = (name: string): NormalizedBox | null => {
    const candidate = source[name];
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const box = candidate as Record<string, unknown>;
    const values = [box.left, box.top, box.right, box.bottom];
    if (!values.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)) return null;
    const parsed = { left: Number(box.left), top: Number(box.top), right: Number(box.right), bottom: Number(box.bottom) };
    return parsed.left < parsed.right && parsed.top < parsed.bottom ? parsed : null;
  };
  const subjectBox = parseBox("subjectBox");
  const headBox = parseBox("headBox");
  const faceBox = parseBox("faceBox");
  if (!subjectBox || !headBox || !faceBox) return { ok: false, reason: "malformed_normalized_bounds" };
  if (typeof source.confidence !== "number" || !Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1) {
    return { ok: false, reason: "invalid_localization_confidence" };
  }
  const width = (box: NormalizedBox) => box.right - box.left;
  const height = (box: NormalizedBox) => box.bottom - box.top;
  if (width(faceBox) < 0.025 || height(faceBox) < 0.035) return { ok: false, reason: "face_bounds_too_small" };
  if (width(headBox) < width(faceBox) * 1.02 || height(headBox) < height(faceBox) * 1.08) {
    return { ok: false, reason: "face_head_relationship_invalid" };
  }
  const containsWithTolerance = (outer: NormalizedBox, inner: NormalizedBox, tolerance: number) =>
    inner.left >= outer.left - tolerance && inner.top >= outer.top - tolerance &&
    inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
  if (!containsWithTolerance(headBox, faceBox, 0.06)) return { ok: false, reason: "face_outside_head" };
  if (!containsWithTolerance(subjectBox, headBox, 0.08)) return { ok: false, reason: "head_outside_subject" };
  return { ok: true, region: { subjectBox, headBox, faceBox, confidence: source.confidence } };
}

const GENERIC_IDENTITY_KEYS = new Set([
  "faceshape",
  "skintone",
  "eyecolor",
  "eyeshape",
  "eyesize",
  "eyebrows",
  "eyebrowshape",
  "nose",
  "noseshape",
  "mouth",
  "mouthshape",
  "lips",
  "lipcolor",
  "haircolor",
  "hairstyle",
  "hairlength",
  "overallhairlength",
  "bangs",
  "fringe",
  "hairpart",
  "hairsilhouette",
  "toptype",
  "topcolor",
  "bottomtype",
  "bottomcolor",
  "outfit",
  "clothing",
  "glasses",
  "earrings",
  "hat",
  "accessory",
  "accessories",
  "expression",
]);

function identityKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readableCueValue(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value)
    ? ""
    : value.replace(/[_-]+/g, " ").trim();
}

function cueForGenericIdentityKey(
  key: string,
  renderHints: PixelRenderHints,
  fallbackFeatures: FallbackFeatures,
): string {
  const skin = readableCueValue(fallbackFeatures.skinTone);
  const eyes = readableCueValue(fallbackFeatures.eyeColor);
  const hair = readableCueValue(fallbackFeatures.hairColor);
  const top = readableCueValue(fallbackFeatures.topColor);
  const bottom = readableCueValue(fallbackFeatures.bottomColor);
  switch (key) {
    case "faceshape":
      return `${renderHints.faceShape} face shape`;
    case "skintone":
      return `${renderHints.skinUndertone}${skin ? ` ${skin}` : ""} skin`;
    case "eyecolor":
      return `${renderHints.irisLightness}${eyes ? ` ${eyes}` : ""} ${renderHints.eyeShape} eyes`;
    case "eyeshape":
    case "eyesize":
      return `${renderHints.eyeSize} ${renderHints.eyeShape} ${renderHints.eyeTilt} eyes`;
    case "eyebrows":
    case "eyebrowshape":
      return `${renderHints.eyebrowShape} eyebrows`;
    case "nose":
    case "noseshape":
      return `${renderHints.noseShape} nose`;
    case "mouth":
    case "mouthshape":
    case "lips":
    case "lipcolor":
      return `${renderHints.mouthShape} ${renderHints.lipFullness} ${renderHints.lipColor} lips`;
    case "haircolor":
      return `${hair ? `${hair} ` : ""}${renderHints.hairTexture} hair`;
    case "hairstyle":
    case "hairlength":
    case "overallhairlength":
    case "hairsilhouette":
      return `${renderHints.overallHairLength}-length ${renderHints.hairTexture} hair with a ${renderHints.hairSilhouette} silhouette`;
    case "bangs":
    case "fringe":
      return `${renderHints.bangsDensity} ${renderHints.bangsLength} ${renderHints.bangs} fringe`;
    case "hairpart":
      return `${renderHints.hairPart} root parting`;
    case "toptype":
    case "topcolor":
      return `${top ? `${top} ` : ""}${readableCueValue(fallbackFeatures.topType)}`;
    case "bottomtype":
    case "bottomcolor":
      return `${bottom ? `${bottom} ` : ""}${readableCueValue(fallbackFeatures.bottomType)}`;
    case "glasses": {
      const glasses = readableCueValue(fallbackFeatures.glasses);
      return glasses === "none"
        ? "bare face without glasses"
        : `${readableCueValue(fallbackFeatures.glassesColor)} ${glasses} glasses`.trim();
    }
    case "earrings":
      return fallbackFeatures.earrings
        ? "visible earrings"
        : "bare ears without earrings";
    case "hat": {
      const hat = readableCueValue(fallbackFeatures.hat);
      return hat === "none"
        ? "uncovered hair without a hat"
        : `${hat} headwear`;
    }
    case "expression":
      return `${readableCueValue(fallbackFeatures.expression)} expression`;
    default:
      return "";
  }
}

function concretizeCanonicalIdentity(
  mustPreserve: string[],
  features: IdentityFeaturePriority[],
  renderHints: PixelRenderHints,
  fallbackFeatures: FallbackFeatures,
): {
  mustPreserve: string[];
  features: IdentityFeaturePriority[];
} {
  const originalKeys = features.map((feature) => identityKey(feature.feature));
  const concreteFeatures = features.map((feature, index) => {
    const key = originalKeys[index];
    if (!GENERIC_IDENTITY_KEYS.has(key)) return feature;
    const evidence = feature.evidence.trim().replace(/[.;]+$/g, "");
    const concrete =
      evidence.length >= 8 &&
      !/^(?:none|unknown|not visible|n\/?a)$/i.test(evidence)
        ? evidence
        : cueForGenericIdentityKey(key, renderHints, fallbackFeatures);
    return concrete ? { ...feature, feature: concrete } : feature;
  });
  const featureByOriginalKey = new Map(
    originalKeys.map((key, index) => [key, concreteFeatures[index].feature]),
  );
  const concreteMustPreserve = mustPreserve.map((cue) => {
    const key = identityKey(cue);
    if (!GENERIC_IDENTITY_KEYS.has(key)) return cue.trim();
    return (
      featureByOriginalKey.get(key) ||
      cueForGenericIdentityKey(key, renderHints, fallbackFeatures) ||
      cue.trim()
    );
  });
  const uniqueMustPreserve = [...new Set(concreteMustPreserve.filter(Boolean))];
  for (const feature of concreteFeatures) {
    if (uniqueMustPreserve.length >= 3) break;
    if (!uniqueMustPreserve.includes(feature.feature)) {
      uniqueMustPreserve.push(feature.feature);
    }
  }
  return {
    mustPreserve: uniqueMustPreserve.slice(0, 8),
    features: concreteFeatures,
  };
}

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
        sourceSelection: {
          portraitImageIndex: 0,
          outfitImageIndex: 0,
          generationImageIndex: 0,
          portraitEvidence: "photo rejected before source selection",
          outfitEvidence: "photo rejected before source selection",
          generationEvidence: "photo rejected before source selection",
          portraitRegion: null,
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
        canonicalIdentity: {
          overallImpression: "",
          mustPreserve: [],
          features: [],
        },
        renderHints: {
          skinUndertone: "neutral",
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

  const selection =
    typeof obj.sourceSelection === "object" &&
    obj.sourceSelection !== null &&
    !Array.isArray(obj.sourceSelection)
      ? (obj.sourceSelection as Record<string, unknown>)
      : (errors.push("sourceSelection: 객체가 아님"), {});
  const sourceIndex = (path: string, value: unknown): number => {
    if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 4) {
      errors.push(`${path}: 0~4 정수 필요`);
      return 0;
    }
    return Number(value);
  };
  const sourceSelection: SourceSelection = {
    portraitImageIndex: sourceIndex(
      "sourceSelection.portraitImageIndex",
      selection.portraitImageIndex,
    ),
    outfitImageIndex: sourceIndex(
      "sourceSelection.outfitImageIndex",
      selection.outfitImageIndex,
    ),
    generationImageIndex: sourceIndex(
      "sourceSelection.generationImageIndex",
      selection.generationImageIndex,
    ),
    portraitEvidence: str(
      "sourceSelection.portraitEvidence",
      selection.portraitEvidence,
    ).replace(/\s*\|\s*REGION\s*:\s*(?:\[[^\]]*\]|null)\s*$/i, ""),
    outfitEvidence: str(
      "sourceSelection.outfitEvidence",
      selection.outfitEvidence,
    ),
    generationEvidence: str(
      "sourceSelection.generationEvidence",
      selection.generationEvidence,
    ),
    portraitRegion: (() => {
      let candidate = selection.portraitRegion;
      if (candidate === null || candidate === undefined) {
        const evidence = typeof selection.portraitEvidence === "string" ? selection.portraitEvidence : "";
        const match = /\|\s*REGION\s*:\s*\[([^\]]+)\]\s*$/i.exec(evidence);
        if (match) candidate = match[1].split(",").map((value) => Number(value.trim()));
      }
      if (candidate === null || candidate === undefined) return null;
      const validated = validatePortraitRegion(candidate);
      return validated.ok ? validated.region : null;
    })(),
  };
  for (const [key, evidence] of Object.entries(sourceSelection)) {
    if (key.endsWith("Evidence") && String(evidence).trim().length < 3) {
      errors.push(`sourceSelection.${key}: 근거가 너무 짧음`);
    }
  }

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
  // Observation owns visible regions. A structurally valid model response may
  // still repeat visible clothing under `inferred`; remove that contradiction
  // at the analysis boundary so later completion cannot overwrite evidence.
  if (visibleRegions.upperBody) inferred.upperBody = null;
  if (visibleRegions.lowerBody) {
    inferred.lowerBody = null;
    inferred.lowerBodyDesign = null;
  }
  if (visibleRegions.feet) inferred.shoes = null;

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
    skinUndertone: enumValue(
      "renderHints.skinUndertone",
      hints.skinUndertone,
      ["warm", "cool", "neutral"],
      "neutral",
    ),
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
    irisLightness: enumValue(
      "renderHints.irisLightness",
      hints.irisLightness,
      ["dark", "medium", "light"],
      "medium",
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
    mouthOpening: enumValue(
      "renderHints.mouthOpening",
      hints.mouthOpening,
      ["closed", "slightly_open", "teeth_visible"],
      "closed",
    ),
    lipFullness: enumValue(
      "renderHints.lipFullness",
      hints.lipFullness,
      ["thin", "average", "full"],
      "average",
    ),
    lipColor: enumValue(
      "renderHints.lipColor",
      hints.lipColor,
      ["natural", "rose", "red", "berry", "brown", "coral"],
      "natural",
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

  const canonical =
    typeof obj.canonicalIdentity === "object" &&
    obj.canonicalIdentity !== null &&
    !Array.isArray(obj.canonicalIdentity)
      ? (obj.canonicalIdentity as Record<string, unknown>)
      : (errors.push("canonicalIdentity: 객체가 아님"), {});
  const overallImpression = str(
    "canonicalIdentity.overallImpression",
    canonical.overallImpression,
  );
  const mustPreserve = Array.isArray(canonical.mustPreserve)
    ? canonical.mustPreserve.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : (errors.push("canonicalIdentity.mustPreserve: 배열이 아님"), []);
  if (overallImpression.trim().length < 10) {
    errors.push("canonicalIdentity.overallImpression: 내용이 너무 짧음");
  }
  if (mustPreserve.length < 3 || mustPreserve.length > 8) {
    errors.push("canonicalIdentity.mustPreserve: 3~8개 필요");
  }

  const featureCategories: IdentityFeatureCategory[] = [
    "face",
    "hair",
    "accessory",
    "outfit",
    "color",
    "silhouette",
  ];
  const identityFeatures: IdentityFeaturePriority[] = [];
  if (!Array.isArray(canonical.features)) {
    errors.push("canonicalIdentity.features: 배열이 아님");
  } else {
    for (const [index, rawFeature] of canonical.features.entries()) {
      const path = `canonicalIdentity.features[${index}]`;
      if (
        typeof rawFeature !== "object" ||
        rawFeature === null ||
        Array.isArray(rawFeature)
      ) {
        errors.push(`${path}: 객체가 아님`);
        continue;
      }
      const item = rawFeature as Record<string, unknown>;
      const feature = str(`${path}.feature`, item.feature);
      const evidence = str(`${path}.evidence`, item.evidence);
      const category = str(`${path}.category`, item.category);
      const confidence = str(`${path}.confidence`, item.confidence);
      const priority = item.priority;
      const targetRegions = Array.isArray(item.targetRegions)
        ? item.targetRegions.filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
        : (errors.push(`${path}.targetRegions: 배열이 아님`), []);
      if (!featureCategories.includes(category as IdentityFeatureCategory)) {
        errors.push(`${path}.category: 허용되지 않은 값`);
      }
      if (
        !Number.isInteger(priority) ||
        Number(priority) < 1 ||
        Number(priority) > 5
      ) {
        errors.push(`${path}.priority: 1~5 정수 필요`);
      }
      if (
        !(["low", "medium", "high"] as const).includes(
          confidence as "low" | "medium" | "high",
        )
      ) {
        errors.push(`${path}.confidence: 허용되지 않은 값`);
      }
      if (feature.trim().length < 3 || evidence.trim().length < 3) {
        errors.push(`${path}: feature/evidence가 너무 짧음`);
      }
      if (targetRegions.length === 0) {
        errors.push(`${path}.targetRegions: 한 개 이상 필요`);
      }
      identityFeatures.push({
        feature,
        category: category as IdentityFeatureCategory,
        priority: Number(priority) as IdentityFeaturePriority["priority"],
        confidence: confidence as IdentityFeaturePriority["confidence"],
        evidence,
        targetRegions,
      });
    }
  }
  if (identityFeatures.length < 4 || identityFeatures.length > 12) {
    errors.push("canonicalIdentity.features: 4~12개 필요");
  }
  identityFeatures.sort((a, b) => b.priority - a.priority);

  const fallbackSource =
    typeof obj.fallbackFeatures === "object" &&
    obj.fallbackFeatures !== null &&
    !Array.isArray(obj.fallbackFeatures)
      ? (obj.fallbackFeatures as Record<string, unknown>)
      : {};
  const fallbackEnum = <T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T =>
    typeof value === "string" && allowed.includes(value as T)
      ? (value as T)
      : fallback;
  const fallbackColor = <T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ): string =>
    typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())
      ? value.trim().toLowerCase()
      : fallbackEnum(value, allowed, fallback);
  const fallbackEvidence = [
    observed.face,
    observed.hair,
    observed.accessories,
    observed.clothing,
    identityPrompt,
    outfitPrompt,
    overallImpression,
    ...mustPreserve,
  ]
    .join(" ")
    .toLowerCase();
  const inferredHairstyle: FallbackFeatures["hairstyle"] =
    renderHints.hairTexture === "curly" || renderHints.hairTexture === "coily"
      ? "curly"
      : renderHints.hairBackShape === "tied"
        ? "bun"
        : ["shoulder", "chest", "waist", "hip"].includes(
              renderHints.overallHairLength,
            )
          ? "long"
          : "short";
  const inferredGlasses: FallbackFeatures["glasses"] = /\bsunglasses?\b/.test(
    fallbackEvidence,
  )
    ? "sunglasses"
    : /\b(?:round|circular)[- ](?:frame|framed)|\bround glasses\b/.test(
          fallbackEvidence,
        )
      ? "round"
      : /\b(?:glasses|spectacles|eyeglasses|frames)\b/.test(fallbackEvidence)
        ? "regular"
        : "none";
  const inferredTopType: FallbackFeatures["topType"] = /\bhoodie\b/.test(
    fallbackEvidence,
  )
    ? "hoodie"
    : /\b(?:jacket|coat|blazer)\b/.test(fallbackEvidence)
      ? "jacket"
      : /\b(?:sweater|pullover|knit)\b/.test(fallbackEvidence)
        ? "sweater"
        : /\bdress\b/.test(fallbackEvidence)
          ? "dress"
          : /\b(?:shirt|blouse)\b/.test(fallbackEvidence)
            ? "shirt"
            : "tshirt";
  const inferredBottomType: FallbackFeatures["bottomType"] =
    inferred.lowerBodyDesign?.bottomType ??
    (/\bskirt\b/.test(fallbackEvidence)
      ? "skirt"
      : /\bshorts\b/.test(fallbackEvidence)
        ? "shorts"
        : /\bjeans\b/.test(fallbackEvidence)
          ? "jeans"
          : "pants");
  const fallbackFeatures: FallbackFeatures = {
    skinTone: fallbackColor(
      fallbackSource.skinTone,
      ["pale", "light", "medium", "tan", "brown", "dark"],
      "light",
    ),
    hairColor: fallbackColor(
      fallbackSource.hairColor,
      [
        "black",
        "dark-brown",
        "brown",
        "light-brown",
        "blonde",
        "platinum",
        "red",
        "auburn",
        "gray",
        "white",
        "dyed-blue",
        "dyed-pink",
        "dyed-purple",
        "dyed-green",
      ],
      "dark-brown",
    ),
    hairstyle: fallbackEnum(
      fallbackSource.hairstyle,
      [
        "bald",
        "buzz",
        "short",
        "medium",
        "long",
        "ponytail",
        "bun",
        "twintails",
        "curly",
        "afro",
      ],
      inferredHairstyle,
    ),
    eyeColor: fallbackColor(
      fallbackSource.eyeColor,
      ["black", "dark-brown", "brown", "hazel", "green", "blue", "gray"],
      "dark-brown",
    ),
    eyebrowThickness: fallbackEnum(
      fallbackSource.eyebrowThickness,
      ["thin", "normal", "thick"],
      "normal",
    ),
    facialHair: fallbackEnum(
      fallbackSource.facialHair,
      ["none", "mustache", "goatee", "beard", "stubble"],
      "none",
    ),
    glasses: fallbackEnum(
      fallbackSource.glasses,
      ["none", "regular", "round", "sunglasses"],
      inferredGlasses,
    ),
    glassesColor: fallbackColor(
      fallbackSource.glassesColor,
      CLOTHING_COLOR_VALUES,
      "black",
    ),
    earrings:
      typeof fallbackSource.earrings === "boolean"
        ? fallbackSource.earrings
        : /\b(?:earrings?|ear studs?|hoops?)\b/.test(fallbackEvidence),
    hat: fallbackEnum(
      fallbackSource.hat,
      ["none", "cap", "beanie", "hood"],
      /\bcap\b/.test(fallbackEvidence)
        ? "cap"
        : /\bbeanie\b/.test(fallbackEvidence)
          ? "beanie"
          : /\bhood\b/.test(fallbackEvidence)
            ? "hood"
            : "none",
    ),
    hatColor: fallbackColor(
      fallbackSource.hatColor,
      CLOTHING_COLOR_VALUES,
      "black",
    ),
    expression: fallbackEnum(
      fallbackSource.expression,
      ["smile", "neutral", "serious"],
      /\b(?:smile|smiling|grin)\b/.test(fallbackEvidence) ? "smile" : "neutral",
    ),
    topType: fallbackEnum(
      fallbackSource.topType,
      ["tshirt", "shirt", "hoodie", "jacket", "sweater", "dress", "tank"],
      inferredTopType,
    ),
    topColor: fallbackColor(
      fallbackSource.topColor,
      CLOTHING_COLOR_VALUES,
      "blue",
    ),
    topAccentColor: fallbackColor(
      fallbackSource.topAccentColor,
      CLOTHING_COLOR_VALUES,
      "white",
    ),
    sleeveLength: fallbackEnum(
      fallbackSource.sleeveLength,
      ["short", "long"],
      /\blong[- ]sleeves?\b/.test(fallbackEvidence) ? "long" : "short",
    ),
    bottomType: fallbackEnum(
      fallbackSource.bottomType,
      ["pants", "jeans", "shorts", "skirt"],
      inferredBottomType,
    ),
    bottomColor: fallbackColor(
      fallbackSource.bottomColor,
      CLOTHING_COLOR_VALUES,
      "denim",
    ),
    shoesColor: fallbackColor(
      fallbackSource.shoesColor,
      CLOTHING_COLOR_VALUES,
      "white",
    ),
  };

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const concreteCanonical = concretizeCanonicalIdentity(
    mustPreserve,
    identityFeatures,
    renderHints,
    fallbackFeatures,
  );

  return {
    ok: true,
    analysis: {
      quality: quality as PhotoAnalysis["quality"],
      failReason,
      framing,
      visibleRegions,
      sourceSelection,
      observed,
      inferred,
      canonicalIdentity: {
        overallImpression,
        mustPreserve: concreteCanonical.mustPreserve,
        features: concreteCanonical.features,
      },
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
  | {
      ok: true;
      analysis: PhotoAnalysis;
      attempts: number;
      neuronsSpent: number;
    }
  | {
      ok: false;
      reason:
        "ai_error" | "invalid_response" | "quota_exceeded" | "rate_limited";
      detail: string;
      attempts: number;
      neuronsSpent: number;
      retryAfterMs?: number;
    };

export interface NeckDetailAnalysis {
  neckAccessory: "none" | "bow" | "tie" | "scarf" | "collar";
  confidence: "low" | "medium" | "high";
  evidence: string;
}

export type NeckDetailCallResult =
  | {
      ok: true;
      detail: NeckDetailAnalysis;
      attempts: number;
      neuronsSpent: number;
    }
  | {
      ok: false;
      reason: "ai_error" | "invalid_response" | "quota_exceeded";
      detail: string;
      attempts: number;
      neuronsSpent: number;
    };

export interface PortraitDetailAnalysis {
  faceConfidence: "low" | "medium" | "high";
  hairConfidence: "low" | "medium" | "high";
  crownConfidence: "low" | "medium" | "high";
  fringeConfidence: "low" | "medium" | "high";
  sideHairConfidence: "low" | "medium" | "high";
  hairEndpointConfidence: "low" | "medium" | "high";
  hairEndpointLandmark:
    | "scalp"
    | "ear"
    | "jaw"
    | "neck"
    | "shoulder"
    | "below_shoulder"
    | "not_visible";
  hairTouchesShoulder: boolean;
  clothingConfidence?: "low" | "medium" | "high";
  skinTone: "pale" | "light" | "medium" | "tan" | "brown" | "dark";
  skinUndertone: "warm" | "cool" | "neutral";
  eyeColor:
    "black" | "dark-brown" | "brown" | "hazel" | "green" | "blue" | "gray";
  hairColor:
    | "black"
    | "dark-brown"
    | "brown"
    | "light-brown"
    | "blonde"
    | "platinum"
    | "red"
    | "auburn"
    | "gray"
    | "white"
    | "dyed-blue"
    | "dyed-pink"
    | "dyed-purple"
    | "dyed-green";
  faceShape: PixelRenderHints["faceShape"];
  eyeShape: PixelRenderHints["eyeShape"];
  eyeSize: PixelRenderHints["eyeSize"];
  irisLightness: PixelRenderHints["irisLightness"];
  eyeSpacing: PixelRenderHints["eyeSpacing"];
  eyeTilt: PixelRenderHints["eyeTilt"];
  eyebrowShape: PixelRenderHints["eyebrowShape"];
  eyebrowThickness: "thin" | "normal" | "thick";
  noseShape: PixelRenderHints["noseShape"];
  mouthShape: PixelRenderHints["mouthShape"];
  mouthOpening: PixelRenderHints["mouthOpening"];
  lipFullness: PixelRenderHints["lipFullness"];
  lipColor: PixelRenderHints["lipColor"];
  jawShape: PixelRenderHints["jawShape"];
  bangs: PixelRenderHints["bangs"];
  bangsLength: PixelRenderHints["bangsLength"];
  hairSilhouette: PixelRenderHints["hairSilhouette"];
  bangsDensity: PixelRenderHints["bangsDensity"];
  fringeEdge: PixelRenderHints["fringeEdge"];
  fringeOpening: PixelRenderHints["fringeOpening"];
  hairTexture: PixelRenderHints["hairTexture"];
  hairVolume: PixelRenderHints["hairVolume"];
  overallHairLength: PixelRenderHints["overallHairLength"];
  hairPart: PixelRenderHints["hairPart"];
  sideHairLength: PixelRenderHints["sideHairLength"];
  sideHairShape: PixelRenderHints["sideHairShape"];
  sideHairAsymmetry: PixelRenderHints["sideHairAsymmetry"];
  earExposure: PixelRenderHints["earExposure"];
  neckAccessory: NeckDetailAnalysis["neckAccessory"];
  neckConfidence: NeckDetailAnalysis["confidence"];
  faceEvidence: string;
  hairEvidence: string;
  hairEndpointEvidence: string;
  neckEvidence: string;
  clothingEvidence?: string;
}

export type PortraitDetailCallResult =
  | {
      ok: true;
      detail: PortraitDetailAnalysis;
      attempts: number;
      neuronsSpent: number;
    }
  | {
      ok: false;
      reason: "ai_error" | "invalid_response" | "quota_exceeded";
      detail: string;
      attempts: number;
      neuronsSpent: number;
    };

export const PORTRAIT_DETAIL_PROMPT = `This is an enlarged head-and-upper-body crop of the same real person already analyzed for a Minecraft skin.
Re-check the face, visible hair geometry, throat construction, and only upper-garment micro-details actually visible in this crop. Do not infer unseen clothing or the unseen back/lower endpoint of the hair.

Face:
- Classify the person's actual skin lightness/undertone, iris color and irisLightness, face/jaw outline, visible eye aperture and spacing, eyebrow line, nose, mouth footprint and opening, lip fullness and dominant lip pigmentation.
- mouthOpening is closed when the lips meet, slightly_open for a narrow dark gap without a dominant white row, and teeth_visible only when clearly exposed teeth are an important visible cue. Do not infer teeth from a friendly or wide smile alone.
- irisLightness is the iris itself: dark near-black/deep, medium subdued but colored, light distinctly pale/bright. Ignore catchlights, sclera, eyelid shadow and exposure.
- For lipColor discount shine and mouth-corner shadow: natural means skin-adjacent/subtle, rose muted pink, red clear red, berry cool magenta/wine, brown warm nude/brown, and coral orange-pink.
- Judge eye size from the open eye aperture, not eyeliner, eyelashes, catchlights, expression, or the apparent size of the dark iris.
- eyebrowThickness is the visible hair-bearing brow stroke: thin for a fine one-pixel-like line, normal for an ordinary brow, and thick only for a clearly broad/dense brow. Ignore fringe shadows, eyeliner and glasses frames.
- Use low confidence when resolution, occlusion, pose, or lighting cannot support a correction.

Hair:
- Report separate crownConfidence, fringeConfidence, sideHairConfidence and hairEndpointConfidence. A clear crown does not make an occluded ear/side profile or a lock cut off by the crop reliable. Use low for each uncertain subgroup even when overall hairConfidence is medium/high.
- Classify the dominant root hair color separately from highlights, reflections and background spill.
- hairSilhouette is the OUTER crown and temple contour. It is not the lower edge of the fringe. Straight or blunt bangs can still sit under a rounded crown.
- hairVolume is independent from length and silhouette: flat for sleek/low-volume hair close to the head, normal for ordinary lift, and full only when the hair visibly expands away from the scalp. Do not call all long hair full.
- Classify overallHairLength from the lowest substantial visible lock relative to the ear, jaw, neck and physical shoulder seam. Correct for head tilt and slanted shoulders by mentally rotating the head upright and comparing each lock with its same-side anatomical landmarks; do not use raw screen y-position. Curly hair that flares widely around the head but ends above the shoulder is ear- or jaw-length, not shoulder-length. Use shoulder only when multiple substantial locks visibly touch or overlap the shoulder seam.
- Report hairEndpointLandmark independently as the closest anatomical level reached by those lowest substantial locks. Report hairTouchesShoulder true only when multiple substantial locks physically touch or overlap the local shoulder seam after correcting for head tilt. Wide curls beside the neck, flyaways, background edges and sweater texture do not count. hairEndpointEvidence must state the visible same-side landmark relationship rather than merely repeat the enum.
- Set hairEndpointConfidence low when the lowest substantial locks leave the crop, disappear behind clothing/body, or their endpoint is otherwise not directly visible. In that case classify the nearest visible length conservatively but expect the full-frame analysis to retain ownership of overallHairLength.
- A short two-block, bowl-like or ear-length cut with a domed top and tapered/ear-hugging sides is rounded unless the crown itself is visibly flat, boxy or close-cropped.
- Trace continuity from crown to temple to sideburn/ear on both sides. sideHairShape describes that contour; earExposure describes the visible ear opening rather than hair length.
- Set sideHairConfidence low when either relevant temple/ear contour is hidden by pose, hand, accessory, crop boundary or dense overlapping locks. Do not report structural sideHairAsymmetry merely because head rotation foreshortens one side.
- Measure bangsLength from the lowest substantial front-fringe tips against the upper forehead, eyebrow line and eye aperture. A short overall haircut can still have brow- or eye-length bangs; never reuse overallHairLength for bangsLength.
- Classify fringe density, edge and opening from the visible construction, not isolated highlight strands. A few narrow gaps between dense blunt tips do not make the fringe short or sparse.
- Set hairPart only when a visible scalp/root line or coherent root direction proves it. Do not turn a gap between bang tips, a highlight, or a shadow channel into a center part; use none when dense fringe hides the roots.
- Use low confidence when the crop does not clearly show a feature.

Neck detail:
- Also classify the strongest visible fabric construction at the throat: bow, tie, scarf, ordinary collar, or none.
- A bow has a central knot with paired loops/wings or broad hanging tails; a scarf wraps or drapes without clear bow loops; a tie has a narrow knot and vertical blade; an ordinary collar has only short paired flaps.
- A collared shirt can still have a bow or scarf over it. Choose the stronger low-resolution identity cue and use low neckConfidence when the knot/loops/tails are not clearly visible.

Visible upper-garment detail:
- Use clothingConfidence low when the crop does not clearly show the garment.
- In clothingEvidence describe only stable, low-resolution cues missing from a generic color block: small chest graphic/badge/patch colors, approximate shape and viewer-relative location; shoulder stripes or piping; collar/cuff construction; and a clearly visible knit, denim or athletic texture.
- Never identify a brand or write only "logo". Use neutral graphic/badge/marking wording and preserve visible colors. Do not invent text or symbols that cannot be read.

Return concise faceEvidence, hairEvidence, neckEvidence and clothingEvidence describing only visible geometry and colors.`;

const PORTRAIT_DETAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    faceConfidence: { type: "string", enum: ["low", "medium", "high"] },
    hairConfidence: { type: "string", enum: ["low", "medium", "high"] },
    crownConfidence: { type: "string", enum: ["low", "medium", "high"] },
    fringeConfidence: { type: "string", enum: ["low", "medium", "high"] },
    sideHairConfidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    hairEndpointConfidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    hairEndpointLandmark: {
      type: "string",
      enum: [
        "scalp",
        "ear",
        "jaw",
        "neck",
        "shoulder",
        "below_shoulder",
        "not_visible",
      ],
    },
    hairTouchesShoulder: { type: "boolean" },
    clothingConfidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    skinTone: {
      type: "string",
      enum: ["pale", "light", "medium", "tan", "brown", "dark"],
    },
    skinUndertone: {
      type: "string",
      enum: ["warm", "cool", "neutral"],
    },
    eyeColor: {
      type: "string",
      enum: ["black", "dark-brown", "brown", "hazel", "green", "blue", "gray"],
    },
    hairColor: {
      type: "string",
      enum: [
        "black",
        "dark-brown",
        "brown",
        "light-brown",
        "blonde",
        "platinum",
        "red",
        "auburn",
        "gray",
        "white",
        "dyed-blue",
        "dyed-pink",
        "dyed-purple",
        "dyed-green",
      ],
    },
    faceShape: {
      type: "string",
      enum: ["round", "oval", "long", "angular", "square"],
    },
    eyeShape: { type: "string", enum: ["narrow", "almond", "round"] },
    eyeSize: { type: "string", enum: ["small", "average", "large"] },
    irisLightness: {
      type: "string",
      enum: ["dark", "medium", "light"],
    },
    eyeSpacing: { type: "string", enum: ["close", "average", "wide"] },
    eyeTilt: {
      type: "string",
      enum: ["upturned", "level", "downturned"],
    },
    eyebrowShape: {
      type: "string",
      enum: ["straight", "arched", "slanted", "soft"],
    },
    eyebrowThickness: {
      type: "string",
      enum: ["thin", "normal", "thick"],
    },
    noseShape: {
      type: "string",
      enum: ["small", "straight", "rounded", "prominent"],
    },
    mouthShape: {
      type: "string",
      enum: ["small", "wide", "full", "thin"],
    },
    mouthOpening: {
      type: "string",
      enum: ["closed", "slightly_open", "teeth_visible"],
    },
    lipFullness: { type: "string", enum: ["thin", "average", "full"] },
    lipColor: {
      type: "string",
      enum: ["natural", "rose", "red", "berry", "brown", "coral"],
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
    hairSilhouette: {
      type: "string",
      enum: ["rounded", "flat", "swept", "tousled", "spiky"],
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
    hairVolume: {
      type: "string",
      enum: ["flat", "normal", "full"],
    },
    overallHairLength: {
      type: "string",
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
      enum: ["tapered", "ear_hugging", "face_framing", "flared", "undercut"],
    },
    sideHairAsymmetry: {
      type: "string",
      enum: ["none", "left", "right"],
    },
    earExposure: {
      type: "string",
      enum: ["covered", "partial", "visible"],
    },
    neckAccessory: {
      type: "string",
      enum: ["none", "bow", "tie", "scarf", "collar"],
    },
    neckConfidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    faceEvidence: { type: "string" },
    hairEvidence: { type: "string" },
    hairEndpointEvidence: { type: "string" },
    neckEvidence: { type: "string" },
    clothingEvidence: { type: "string" },
  },
  required: [
    "faceConfidence",
    "hairConfidence",
    "crownConfidence",
    "fringeConfidence",
    "sideHairConfidence",
    "hairEndpointConfidence",
    "hairEndpointLandmark",
    "hairTouchesShoulder",
    "skinTone",
    "skinUndertone",
    "eyeColor",
    "hairColor",
    "faceShape",
    "eyeShape",
    "eyeSize",
    "irisLightness",
    "eyeSpacing",
    "eyeTilt",
    "eyebrowShape",
    "eyebrowThickness",
    "noseShape",
    "mouthShape",
    "mouthOpening",
    "lipFullness",
    "lipColor",
    "jawShape",
    "bangs",
    "bangsLength",
    "hairSilhouette",
    "bangsDensity",
    "fringeEdge",
    "fringeOpening",
    "hairTexture",
    "hairVolume",
    "overallHairLength",
    "hairPart",
    "sideHairLength",
    "sideHairShape",
    "sideHairAsymmetry",
    "earExposure",
    "neckAccessory",
    "neckConfidence",
    "faceEvidence",
    "hairEvidence",
    "hairEndpointEvidence",
    "neckEvidence",
  ],
} as const;

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

async function runStructuredVision(
  env: Env,
  options: {
    model: string;
    imageDataUrls: string[];
    prompt: string;
    schema: unknown;
    schemaName: string;
    schemaDescription: string;
    maxOutputTokens: number;
  },
): Promise<unknown> {
  const legacyInput = {
    messages: [
      {
        role: "user",
        content: [
          ...options.imageDataUrls.map((url) => ({
            type: "image_url",
            image_url: { url },
          })),
          { type: "text", text: options.prompt },
        ],
      },
    ],
    max_tokens: options.maxOutputTokens,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: options.schemaName,
        description: options.schemaDescription,
        schema: options.schema,
      },
    },
  };
  return generateGeminiStructuredJson(env, {
    model: options.model,
    imageDataUrls: options.imageDataUrls,
    prompt: options.prompt,
    responseSchema: options.schema,
    maxOutputTokens: options.maxOutputTokens,
    legacyWorkersAiInput: legacyInput,
  });
}

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
    const result = await runStructuredVision(env, {
      model: visionModel,
      imageDataUrls: [detailImageDataUrl],
      prompt: NECK_DETAIL_PROMPT,
      schema: NECK_DETAIL_SCHEMA,
      schemaName: "minecraft_skin_neck_detail",
      schemaDescription:
        "Focused neck fabric classification from an upper-body crop",
      maxOutputTokens: 260,
    });
    const neuronsSpent = visionNeuronsFromUsage(
      result,
      NEURONS_VISION_DETAIL_ESTIMATE,
    );
    const parsed = extractAnalysisPayload(result);
    if (!parsed) {
      return {
        ok: false,
        reason: "invalid_response",
        detail: "neck detail response did not contain JSON",
        attempts: 1,
        neuronsSpent,
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
        neuronsSpent,
      };
    }
    return {
      ok: true,
      detail: {
        neckAccessory: neckAccessory as NeckDetailAnalysis["neckAccessory"],
        confidence: confidence as NeckDetailAnalysis["confidence"],
        evidence: evidence.trim(),
      },
      attempts: 1,
      neuronsSpent,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: isAiQuotaError(error) ? "quota_exceeded" : "ai_error",
      detail,
      attempts: 1,
      neuronsSpent: NEURONS_VISION_DETAIL_ESTIMATE,
    };
  }
}

/**
 * Focused second-pass classifier for portrait identity. It is intentionally
 * limited to features visible in the crop, leaving outfit and inferred rear
 * or lower-body construction under the main analysis.
 */
async function runPortraitDetailWithModel(
  env: Env,
  detailImageDataUrl: string,
  visionModel: string,
): Promise<PortraitDetailCallResult> {
  try {
    const result = await runStructuredVision(env, {
      model: visionModel,
      imageDataUrls: [detailImageDataUrl],
      prompt: PORTRAIT_DETAIL_PROMPT,
      schema: PORTRAIT_DETAIL_SCHEMA,
      schemaName: "minecraft_skin_portrait_detail",
      schemaDescription:
        "Focused face and visible hair classification from an enlarged portrait crop",
      // The four subgroup confidence fields prevent broad hair overwrites.
      // Leave enough structured-output headroom so their addition cannot turn
      // an otherwise valid portrait pass into a truncated JSON response.
      maxOutputTokens: 760,
    });
    const neuronsSpent = visionNeuronsFromUsage(
      result,
      NEURONS_VISION_DETAIL_ESTIMATE,
    );
    const parsed = extractAnalysisPayload(result);
    if (!parsed) {
      return {
        ok: false,
        reason: "invalid_response",
        detail: "portrait detail response did not contain JSON",
        attempts: 1,
        neuronsSpent,
      };
    }

    const enumFields: Record<
      keyof Omit<
        PortraitDetailAnalysis,
        | "faceEvidence"
        | "hairEvidence"
        | "hairEndpointEvidence"
        | "hairTouchesShoulder"
        | "neckEvidence"
        | "clothingConfidence"
        | "clothingEvidence"
      >,
      readonly string[]
    > = {
      faceConfidence: ["low", "medium", "high"],
      hairConfidence: ["low", "medium", "high"],
      crownConfidence: ["low", "medium", "high"],
      fringeConfidence: ["low", "medium", "high"],
      sideHairConfidence: ["low", "medium", "high"],
      hairEndpointConfidence: ["low", "medium", "high"],
      hairEndpointLandmark: [
        "scalp",
        "ear",
        "jaw",
        "neck",
        "shoulder",
        "below_shoulder",
        "not_visible",
      ],
      skinTone: ["pale", "light", "medium", "tan", "brown", "dark"],
      skinUndertone: ["warm", "cool", "neutral"],
      eyeColor: [
        "black",
        "dark-brown",
        "brown",
        "hazel",
        "green",
        "blue",
        "gray",
      ],
      hairColor: [
        "black",
        "dark-brown",
        "brown",
        "light-brown",
        "blonde",
        "platinum",
        "red",
        "auburn",
        "gray",
        "white",
        "dyed-blue",
        "dyed-pink",
        "dyed-purple",
        "dyed-green",
      ],
      faceShape: ["round", "oval", "long", "angular", "square"],
      eyeShape: ["narrow", "almond", "round"],
      eyeSize: ["small", "average", "large"],
      irisLightness: ["dark", "medium", "light"],
      eyeSpacing: ["close", "average", "wide"],
      eyeTilt: ["upturned", "level", "downturned"],
      eyebrowShape: ["straight", "arched", "slanted", "soft"],
      eyebrowThickness: ["thin", "normal", "thick"],
      noseShape: ["small", "straight", "rounded", "prominent"],
      mouthShape: ["small", "wide", "full", "thin"],
      mouthOpening: ["closed", "slightly_open", "teeth_visible"],
      lipFullness: ["thin", "average", "full"],
      lipColor: ["natural", "rose", "red", "berry", "brown", "coral"],
      jawShape: ["rounded", "pointed", "square", "soft"],
      bangs: ["none", "straight", "side", "curtain", "wispy"],
      bangsLength: ["none", "short", "brow", "eye"],
      hairSilhouette: ["rounded", "flat", "swept", "tousled", "spiky"],
      bangsDensity: ["sparse", "balanced", "dense"],
      fringeEdge: ["blunt", "staggered", "wispy"],
      fringeOpening: ["none", "left", "center", "right"],
      hairTexture: ["straight", "wavy", "curly", "coily"],
      hairVolume: ["flat", "normal", "full"],
      overallHairLength: [
        "cropped",
        "ear",
        "jaw",
        "shoulder",
        "chest",
        "waist",
        "hip",
      ],
      hairPart: ["none", "center", "left", "right"],
      sideHairLength: ["none", "short", "cheek", "jaw", "shoulder"],
      sideHairShape: [
        "tapered",
        "ear_hugging",
        "face_framing",
        "flared",
        "undercut",
      ],
      sideHairAsymmetry: ["none", "left", "right"],
      earExposure: ["covered", "partial", "visible"],
      neckAccessory: ["none", "bow", "tie", "scarf", "collar"],
      neckConfidence: ["low", "medium", "high"],
    };
    const validEnums = Object.entries(enumFields).every(([field, values]) =>
      values.includes(String(parsed[field])),
    );
    const clothingConfidence = parsed.clothingConfidence;
    const clothingFieldsValid =
      clothingConfidence === undefined ||
      (["low", "medium", "high"].includes(String(clothingConfidence)) &&
        typeof parsed.clothingEvidence === "string");
    if (
      !validEnums ||
      !clothingFieldsValid ||
      typeof parsed.hairTouchesShoulder !== "boolean" ||
      typeof parsed.faceEvidence !== "string" ||
      parsed.faceEvidence.trim().length < 3 ||
      typeof parsed.hairEvidence !== "string" ||
      parsed.hairEvidence.trim().length < 3 ||
      typeof parsed.hairEndpointEvidence !== "string" ||
      parsed.hairEndpointEvidence.trim().length < 3 ||
      typeof parsed.neckEvidence !== "string" ||
      parsed.neckEvidence.trim().length < 3
    ) {
      return {
        ok: false,
        reason: "invalid_response",
        detail: "portrait detail response failed schema validation",
        attempts: 1,
        neuronsSpent,
      };
    }
    return {
      ok: true,
      detail: {
        ...(parsed as unknown as PortraitDetailAnalysis),
        faceEvidence: parsed.faceEvidence.trim(),
        hairEvidence: parsed.hairEvidence.trim(),
        hairEndpointEvidence: parsed.hairEndpointEvidence.trim(),
        neckEvidence: parsed.neckEvidence.trim(),
        ...(typeof parsed.clothingEvidence === "string"
          ? { clothingEvidence: parsed.clothingEvidence.trim() }
          : {}),
      },
      attempts: 1,
      neuronsSpent,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: isAiQuotaError(error) ? "quota_exceeded" : "ai_error",
      detail,
      attempts: 1,
      neuronsSpent: NEURONS_VISION_DETAIL_ESTIMATE,
    };
  }
}

export async function runPortraitDetailAnalysis(
  env: Env,
  detailImageDataUrl: string,
): Promise<PortraitDetailCallResult> {
  const primaryModel = env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  const fallbackModel =
    env.VISION_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_VISION_MODEL;
  const primary = await runPortraitDetailWithModel(
    env,
    detailImageDataUrl,
    primaryModel,
  );
  if (
    primary.ok ||
    fallbackModel === primaryModel ||
    (primary.reason === "quota_exceeded" && !env.GEMINI_API_KEY)
  ) {
    return primary;
  }
  const fallback = await runPortraitDetailWithModel(
    env,
    detailImageDataUrl,
    fallbackModel,
  );
  return fallback.ok
    ? {
        ...fallback,
        attempts: primary.attempts + fallback.attempts,
        neuronsSpent: primary.neuronsSpent + fallback.neuronsSpent,
      }
    : {
        ...fallback,
        attempts: primary.attempts + fallback.attempts,
        neuronsSpent: primary.neuronsSpent + fallback.neuronsSpent,
        detail: `${primaryModel}: ${primary.detail}\n${fallbackModel}: ${fallback.detail}`,
      };
}

/**
 * 사진 분석 실행. json_schema 유도 → 실패 시 json_object로 1회 재시도.
 * 두 경우 모두 validatePhotoAnalysis로 런타임 검증한다.
 */
export async function runPhotoAnalysis(
  env: Env,
  imageDataUrls: string | string[],
): Promise<AnalysisCallResult> {
  const references = Array.isArray(imageDataUrls)
    ? imageDataUrls.slice(0, 5)
    : [imageDataUrls];
  const primaryModel = env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  const fallbackModel =
    env.VISION_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_VISION_MODEL;
  const visionModels = [...new Set([primaryModel, fallbackModel])];

  let lastDetail = "";
  const failureDetails: string[] = [];
  let sawInvalidResponse = false;
  let sawTemporaryRateLimit = false;
  let lastRetryAfterMs: number | undefined;
  let attempts = 0;
  let neuronsSpent = 0;
  // A second structured pass is more reliable than switching to free-form
  // json_object output. Free-form retries were the main source of truncated or
  // schema-incomplete production responses. Alternate models across two rounds
  // so a transient provider error does not immediately fail the whole request.
  for (let round = 0; round < 2; round++) {
    for (let modelIndex = 0; modelIndex < visionModels.length; modelIndex++) {
      const visionModel = visionModels[modelIndex];
      let parsed: unknown;
      try {
        attempts += 1;
        const result = await runStructuredVision(env, {
          model: visionModel,
          imageDataUrls: references,
          prompt: `${ANALYSIS_PROMPT}\n\nREFERENCE SET: ${references.length} image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`,
          schema: PHOTO_ANALYSIS_SCHEMA,
          schemaName: "minecraft_skin_photo_analysis",
          schemaDescription:
            "Structured portrait, hair, face and outfit analysis for a Minecraft skin",
          // The full identity + render-hint schema is intentionally rich.
          // 3,200 truncated roughly half of the diverse real-photo set.
          maxOutputTokens: 8192,
        });
        neuronsSpent += visionNeuronsFromUsage(result, NEURONS_VISION_ANALYSIS);
        parsed = extractAnalysisPayload(result);
      } catch (error) {
        neuronsSpent += NEURONS_VISION_ANALYSIS;
        const detail = error instanceof Error ? error.message : String(error);
        lastDetail = `round ${round + 1} ${visionModel}: ${detail}`;
        failureDetails.push(lastDetail);
        if (isGeminiTemporaryRateLimit(error)) {
          const retryAfterMs = geminiRetryAfterMs(error) ?? 1_000;
          sawTemporaryRateLimit = true;
          lastRetryAfterMs = retryAfterMs;
          // Gemini quotas are model-specific. Do not wait on an exhausted
          // primary while a distinct fallback model may still be available.
          if (modelIndex < visionModels.length - 1) continue;
          if (round === 0 && retryAfterMs <= 30_000) {
            await new Promise((resolve) =>
              setTimeout(resolve, retryAfterMs + 250),
            );
            continue;
          }
          continue;
        }
        if (isAiQuotaError(error)) {
          if (
            isGeminiQuotaError(error) &&
            modelIndex < visionModels.length - 1
          ) {
            continue;
          }
          return {
            ok: false,
            reason: "quota_exceeded",
            detail: failureDetails.join("\n"),
            attempts,
            neuronsSpent,
          };
        }
        continue;
      }
      if (parsed === null || parsed === undefined) {
        sawInvalidResponse = true;
        lastDetail = `round ${round + 1} ${visionModel}: response did not contain JSON`;
        failureDetails.push(lastDetail);
        continue;
      }
      const validated = validatePhotoAnalysis(parsed);
      if (validated.ok) {
        const lastReferenceIndex = Math.max(0, references.length - 1);
        const boundedIndex = (index: number): number =>
          Math.min(lastReferenceIndex, Math.max(0, index));
        return {
          ok: true,
          analysis: {
            ...validated.analysis,
            sourceSelection: {
              ...validated.analysis.sourceSelection,
              portraitImageIndex: boundedIndex(
                validated.analysis.sourceSelection.portraitImageIndex,
              ),
              outfitImageIndex: boundedIndex(
                validated.analysis.sourceSelection.outfitImageIndex,
              ),
              generationImageIndex: boundedIndex(
                validated.analysis.sourceSelection.generationImageIndex,
              ),
            },
          },
          attempts,
          neuronsSpent,
        };
      }
      sawInvalidResponse = true;
      lastDetail = `round ${round + 1} ${visionModel}: schema validation failed: ${validated.errors.join("; ")}`;
      failureDetails.push(lastDetail);
    }
  }
  return {
    ok: false,
    reason: sawInvalidResponse
      ? "invalid_response"
      : sawTemporaryRateLimit
        ? "rate_limited"
        : "ai_error",
    detail: failureDetails.join("\n") || lastDetail,
    attempts,
    neuronsSpent,
    ...(sawTemporaryRateLimit && lastRetryAfterMs
      ? { retryAfterMs: lastRetryAfterMs }
      : {}),
  };
}

function isAiQuotaError(error: unknown): boolean {
  if (isGeminiQuotaError(error)) return true;
  const detail = error instanceof Error ? error.message : String(error);
  return isWorkersAiQuotaError(detail);
}

/** Legacy matcher retained for old diagnostic strings and unit tests. */
export function isWorkersAiQuotaError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("4006") ||
    normalized.includes("3036") ||
    normalized.includes("account limited") ||
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
