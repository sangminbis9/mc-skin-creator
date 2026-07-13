/**
 * PhotoAnalysis → FLUX 이미지 생성 프롬프트.
 * framing(face/upper_body/three_quarter/full_body)별로
 * "보이는 것 보존 / 안 보이는 것 조화롭게 완성" 정책을 문장으로 강제한다.
 */

import type { PhotoAnalysis } from "./analysis";

/** 스타일 참고 이미지 유무에 따른 레퍼런스 인덱스 배치 */
export interface ReferenceLayout {
  /** true면 image0=스타일, image1=인물, image2=UV 가이드. false면 image0=인물, image1=UV 가이드 */
  hasStyleRef: boolean;
}

function framingPolicy(analysis: PhotoAnalysis, personRef: string): string {
  switch (analysis.framing) {
    case "face":
      return [
        `${personRef} shows only the face/head. Faithfully preserve the face, skin tone, hair silhouette, glasses and accessories.`,
        `No clothing is visible, so design a neutral casual full-body outfit that harmonizes with the person's colors and mood: ${analysis.outfitPrompt}`,
      ].join(" ");
    case "upper_body":
      return [
        `${personRef} shows the head and upper body. Faithfully preserve the visible top garment: its colors, collar, sleeves, outer layers and patterns.`,
        `Design matching lower-body clothing and shoes that fit the top's color, formality and season: ${analysis.outfitPrompt}`,
      ].join(" ");
    case "three_quarter":
      return [
        `${personRef} shows the person down to the thighs/knees. Preserve all visible clothing including the lower garment.`,
        `Only complete the shoes and unseen rear surfaces consistently: ${analysis.outfitPrompt}`,
      ].join(" ");
    case "full_body":
      return [
        `${personRef} shows the full body. Preserve the actual outfit and shoes as closely as possible.`,
        `Only infer the unseen side and back surfaces so they connect naturally with the front: ${analysis.outfitPrompt}`,
      ].join(" ");
  }
}

/**
 * 정면+뒷면 두 뷰 생성 프롬프트 (front_pack 전략).
 * FLUX는 UV atlas 배치를 지키지 못하지만 마인크래프트 비율의 캐릭터 뷰는
 * 잘 그린다 — 배치는 skinPack이 결정적으로 수행하고, 뒷면 뷰 덕분에
 * 머리 뒷모습/옷 뒷면이 실제 렌더로 채워진다.
 */
export function buildFrontViewPrompt(analysis: PhotoAnalysis): string {
  const inferred = [
    analysis.inferred.hairBack?.value,
    analysis.inferred.upperBody?.value,
    analysis.inferred.lowerBody?.value,
    analysis.inferred.shoes?.value,
  ]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  const lines = [
    "Use image 1 strictly as the composition and pose guide: replace both guide figures with two views of the SAME blocky pixel-art character, preserving their exact left/right placement, gap, scale, straight pose and proportions.",
    "On the left render the FRONT view. On the right render the true BACK view seen from behind, including the back of the head, inferred hair, garment construction and shoes. Never draw a second front view.",
    "Minecraft proportions: large cubic head (about a quarter of total height), rectangular torso, straight blocky arms and legs.",
    "Both views centered on a plain solid very light gray background with a clear gap between them. Nothing else in the image.",
    `Design the character after the subject of image 0: hairstyle silhouette, bangs, hair color, skin tone, accessories and visible clothing must be clearly readable. ${analysis.identityPrompt}`,
    framingPolicy(analysis, "Image 0"),
    `For surfaces not visible in image 0, use these evidence-based completions consistently in the back view: ${inferred || analysis.outfitPrompt}.`,
    `Low-resolution identity priorities: ${analysis.renderHints.faceShape} face, ${analysis.renderHints.eyeShape} ${analysis.renderHints.eyeTilt} eyes with ${analysis.renderHints.eyeSpacing} spacing, ${analysis.renderHints.eyebrowShape} eyebrows, ${analysis.renderHints.noseShape} nose, ${analysis.renderHints.mouthShape} mouth, ${analysis.renderHints.jawShape} jaw, ${analysis.renderHints.bangsDensity} ${analysis.renderHints.bangsLength} ${analysis.renderHints.bangs} bangs with a ${analysis.renderHints.fringeEdge} edge and ${analysis.renderHints.fringeOpening} fringe opening, ${analysis.renderHints.hairTexture} ${analysis.renderHints.hairVolume}-volume ${analysis.renderHints.hairSilhouette} hair silhouette, ${analysis.renderHints.hairBackShape} back hair, ${analysis.renderHints.hairPart} root parting, ${analysis.renderHints.sideHairLength} ${analysis.renderHints.sideHairShape} side hair with ${analysis.renderHints.sideHairAsymmetry} viewer-side asymmetry and ${analysis.renderHints.earExposure} ear exposure.`,
    `Material priorities: ${analysis.renderHints.garmentTexture} garment texture, ${analysis.renderHints.outerLayer} outer-layer volume, ${analysis.renderHints.outerGarment} outer garment silhouette, ${analysis.renderHints.necklace} necklace, ${analysis.renderHints.hairAccessory} hair accessory on viewer-${analysis.renderHints.hairAccessorySide}, ${analysis.renderHints.neckAccessory} neck accessory, ${analysis.renderHints.bottomPattern} lower-garment pattern, ${analysis.renderHints.bottomAccent} lower-body accent, ${analysis.renderHints.legwearAsymmetry} ${analysis.renderHints.legwear}.`,
    "Use Minecraft second skin layer logic deliberately: base layer contains the readable body and garment colors; outer layer adds hair mass, side hair, bangs, collars, cardigan or jacket edges, sleeve cuffs, skirt or shorts hems, pockets, bows, legwear bands, shoe straps and accessories.",
    "Connect adjacent UV faces visually: front-side-back seams must continue hair strands, sleeve edges, torso hem, skirt or shorts pattern, legwear bands and shoe shapes instead of ending abruptly at face borders.",
    "When the photo only shows the upper body, infer a complete lower-body design with confident 2-4 pixel features that match the top's style: bottoms, legwear, shoes and one or two asymmetric accents if they fit the subject.",
    "Crisp pixel clusters, hard edges, 3-6 shade ramps per material, deliberate high-contrast details. Make thin identity cues such as glasses, necklace, collar and garment pattern at least 2 source pixels thick so they survive downsampling.",
  ];
  const avoid = [
    "more than two figures",
    "side views",
    "cropped body",
    "photorealism",
    "smooth gradients",
    "3D rendering",
    "text",
    "logos",
    "shadows on the ground",
  ];
  if (analysis.negativePrompt.trim()) {
    avoid.push(analysis.negativePrompt.trim());
  }
  lines.push(`Avoid: ${avoid.join(", ")}.`);
  return lines.join("\n");
}

export function buildSkinPrompt(
  analysis: PhotoAnalysis,
  layout: ReferenceLayout,
): string {
  const personRef = layout.hasStyleRef ? "Image 1" : "Image 0";
  const uvRef = layout.hasStyleRef ? "Image 2" : "Image 1";

  const lines: string[] = [
    // 레이아웃 지시를 맨 앞에 — diffusion 모델은 프롬프트 앞부분을 가장 강하게 따른다.
    `Repaint ${uvRef} — a Minecraft Java 64x64 classic skin UV texture atlas — keeping every rectangle in exactly the same position and size, but replacing the flat placeholder colors with pixel-art textures for a blocky video game character.`,
    "The output must be a flat UV texture atlas with the identical layout structure: disjoint rectangles for each cube face of head, torso, arms and legs, on a plain dark background.",
    "The output must NOT be a character illustration, character sheet, full-body view, or multiple character poses.",
  ];
  if (layout.hasStyleRef) {
    lines.push(
      "Image 0 shows what a finished skin atlas of this kind looks like — match its pixel density, palette discipline, shading depth and overlay usage, but do NOT copy its character, colors or clothing.",
    );
  }
  lines.push(
    `Design the character after the subject of ${personRef}: the hairstyle silhouette, hair color, skin tone, accessories and visible clothing must be readable in the atlas. ${analysis.identityPrompt}`,
    framingPolicy(analysis, personRef),
    "Do not leave lower-body or rear face rectangles blank just because they are not visible in the photo.",
    `Carry these low-resolution identity priorities into the atlas: ${analysis.renderHints.faceShape} face, ${analysis.renderHints.eyeShape} eyes, ${analysis.renderHints.bangsDensity} ${analysis.renderHints.bangsLength} ${analysis.renderHints.bangs} bangs with a ${analysis.renderHints.fringeEdge} edge, ${analysis.renderHints.hairTexture} ${analysis.renderHints.hairVolume}-volume ${analysis.renderHints.hairSilhouette} hair, ${analysis.renderHints.hairBackShape} back hair, ${analysis.renderHints.hairPart} parting, ${analysis.renderHints.sideHairLength} ${analysis.renderHints.sideHairShape} side hair with ${analysis.renderHints.sideHairAsymmetry} viewer-side asymmetry and ${analysis.renderHints.earExposure} ear exposure.`,
    `Carry these clothing priorities into the atlas: ${analysis.renderHints.garmentTexture} texture, ${analysis.renderHints.outerLayer} outer layer, ${analysis.renderHints.outerGarment} silhouette, ${analysis.renderHints.neckAccessory} neck accessory, ${analysis.renderHints.bottomPattern} lower pattern, ${analysis.renderHints.bottomAccent} lower accent, ${analysis.renderHints.legwearAsymmetry} ${analysis.renderHints.legwear}.`,
    "Use the overlay (second layer) rectangles deliberately for hair volume, bangs, side hair, collars, jacket or cardigan edges, sleeve cuffs, skirt or shorts hems, pockets, bows, legwear bands, shoe straps and accessories.",
    "Keep front, back, left and right UV faces connected: hair strands, sleeve edges, torso hems, side layers, lower-garment pattern, legwear bands and shoes must wrap across adjacent rectangles instead of appearing as disconnected patches.",
    "When the source photo lacks lower-body visibility, generate a coherent lower-body outfit rather than plain filler: choose bottoms, legwear, shoes and restrained asymmetric details that fit the visible top.",
    "Use deliberate pixel clusters and 3-6 shade ramps per material" +
      (layout.hasStyleRef
        ? ", like Image 0."
        : ". Aim for hand-crafted pixel-art quality with crisp single-pixel detailing."),
  );
  const avoid = [
    "character sheets",
    "full-body character drawings",
    "random noise",
    "smooth gradients",
    "photorealism",
    "rendered 3D characters",
    "backgrounds",
    "text",
    "logos",
  ];
  if (analysis.negativePrompt.trim()) {
    avoid.push(analysis.negativePrompt.trim());
  }
  lines.push(`Avoid: ${avoid.join(", ")}.`);
  lines.push(
    "Return only the repainted flat square Minecraft skin texture atlas.",
  );
  return lines.join("\n");
}
