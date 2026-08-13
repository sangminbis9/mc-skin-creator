import type { PhotoAnalysis } from "./analysis";
import type { FaceStyle } from "./skinPack";
import type { SkinCritique } from "./skinCritique";

export interface ProceduralStyleCorrection {
  style: FaceStyle;
  applied: string[];
}

function joinedDefectText(critique: SkinCritique): string {
  return critique.defects
    .filter((defect) => defect.severity !== "minor")
    .map(
      (defect) =>
        `${defect.feature} ${defect.evidence} ${defect.correction}`,
    )
    .join(" ")
    .toLowerCase();
}

function hasTarget(critique: SkinCritique, pattern: RegExp): boolean {
  return critique.defects
    .filter((defect) => defect.severity !== "minor")
    .some((defect) =>
      defect.targetRegions.some((region) => pattern.test(region.toLowerCase())),
    );
}

function graphicSide(text: string): FaceStyle["topGraphicSide"] {
  if (/viewer(?:'s)?[- ]left/.test(text)) return "viewer_left";
  if (/viewer(?:'s)?[- ]right/.test(text)) return "viewer_right";
  return "center";
}

/**
 * Translate a bounded Gemini critique into safe deterministic style changes.
 *
 * The critique is never allowed to invent a new visual fact. It can only ask
 * the renderer to strengthen geometry or details already present in the
 * structured photo analysis. UV coordinates and alpha validity remain owned
 * by the deterministic packer.
 */
export function applyProceduralCritiqueCorrections(
  analysis: PhotoAnalysis,
  current: FaceStyle,
  critique: SkinCritique,
): ProceduralStyleCorrection {
  const style: FaceStyle = { ...current };
  const applied: string[] = [];
  const defectText = joinedDefectText(critique);
  const observedText = [
    analysis.observed.face,
    analysis.observed.hair,
    analysis.observed.accessories,
    analysis.observed.clothing,
    analysis.identityPrompt,
    analysis.outfitPrompt,
    analysis.canonicalIdentity.overallImpression,
    ...analysis.canonicalIdentity.mustPreserve,
  ]
    .join(" ")
    .toLowerCase();

  const headTargeted =
    hasTarget(critique, /(?:^|\.)head(?:\.|$)/) ||
    critique.defects.some(
      (defect) =>
        defect.severity !== "minor" &&
        (defect.category === "face_hair" || defect.category === "identity"),
    );
  const hairTargeted =
    headTargeted &&
    /\b(?:hair|crown|curl|coily|fringe|bangs?|part|silhouette|spik|quiff|helmet|flat|volume|strand)\b/.test(
      defectText,
    );

  if (hairTargeted) {
    style.hairDepthBoost = true;
    Object.assign(style, {
      hairTexture: analysis.renderHints.hairTexture,
      hairSilhouette: analysis.renderHints.hairSilhouette,
      hairBackShape: analysis.renderHints.hairBackShape,
      overallHairLength: analysis.renderHints.overallHairLength,
      hairPart: analysis.renderHints.hairPart,
      bangs: analysis.renderHints.bangs,
      bangsLength: analysis.renderHints.bangsLength,
      bangsDensity: analysis.renderHints.bangsDensity,
      fringeEdge: analysis.renderHints.fringeEdge,
      fringeOpening: analysis.renderHints.fringeOpening,
      sideHairLength: analysis.renderHints.sideHairLength,
      sideHairShape: analysis.renderHints.sideHairShape,
      sideHairAsymmetry: analysis.renderHints.sideHairAsymmetry,
      earExposure: analysis.renderHints.earExposure,
    });
    if (
      analysis.renderHints.hairTexture === "curly" ||
      analysis.renderHints.hairTexture === "coily"
    ) {
      style.hairstyle = "curly";
      style.hairVolume = "full";
      style.hairSilhouette = "tousled";
    } else if (
      analysis.renderHints.hairSilhouette === "spiky" ||
      analysis.renderHints.hairSilhouette === "tousled"
    ) {
      style.hairVolume = "full";
    } else {
      style.hairVolume = analysis.renderHints.hairVolume;
    }
    applied.push("head.hair:analysis_geometry+contrast");
  }

  const faceTargeted =
    headTargeted &&
    critique.defects.some((defect) => {
      if (defect.severity === "minor") return false;
      const text = `${defect.feature} ${defect.evidence} ${defect.correction}`.toLowerCase();
      return /\b(?:face|eyes?|brows?|nose|mouth|smile|teeth|jaw(?![-\s]+length)(?:line| shape)?|expression|wrinkle|mature|skin tone)\b/.test(
        text,
      );
    });
  if (faceTargeted) {
    Object.assign(style, {
      faceShape: analysis.renderHints.faceShape,
      eyeShape: analysis.renderHints.eyeShape,
      eyeSize: analysis.renderHints.eyeSize,
      irisLightness: analysis.renderHints.irisLightness,
      eyeSpacing: analysis.renderHints.eyeSpacing,
      eyeTilt: analysis.renderHints.eyeTilt,
      eyebrowShape: analysis.renderHints.eyebrowShape,
      noseShape: analysis.renderHints.noseShape,
      mouthShape: analysis.renderHints.mouthShape,
      mouthOpening: analysis.renderHints.mouthOpening,
      lipFullness: analysis.renderHints.lipFullness,
      lipColor: analysis.renderHints.lipColor,
      jawShape: analysis.renderHints.jawShape,
    });
    if (/\b(?:mature|older|senior|wrinkle|smile lines?|crow'?s feet)\b/.test(observedText)) {
      style.matureFeatures = true;
    }
    applied.push("head.face:analysis_geometry");
  }

  const outfitTargeted =
    hasTarget(critique, /(?:torso|body|arm|leg)/) ||
    critique.defects.some(
      (defect) =>
        defect.severity !== "minor" &&
        (defect.category === "outfit" || defect.category === "overlay"),
    );
  if (outfitTargeted) {
    if (
      /\b(?:layer|overlay|flat|depth|jacket|cardigan|coat|vest|collar|cuff|hem|lapel)\b/.test(
        defectText,
      )
    ) {
      style.outerLayer = "heavy";
      style.outerGarment = analysis.renderHints.outerGarment;
      applied.push("body.overlay:strengthened");
    }
    if (
      /\b(?:graphic|badge|patch|marking|emblem)\b/.test(defectText) &&
      /\b(?:graphic|badge|patch|marking)\b/.test(observedText)
    ) {
      style.topGraphic = true;
      style.topGraphicSide = graphicSide(observedText);
      applied.push("torso.front:observed_graphic");
    }
    if (/\b(?:tie|necktie)\b/.test(defectText) && /\b(?:tie|necktie)\b/.test(observedText)) {
      style.neckAccessory = "tie";
      style.neckAccessoryPattern = /\bstriped\b/.test(observedText)
        ? "striped"
        : "plain";
      applied.push("torso.front:observed_tie");
    }
  }

  return { style, applied: [...new Set(applied)] };
}
