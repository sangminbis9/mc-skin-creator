import type { FaceIdentityAxis, FaceIdentitySaliencePlan } from "./faceIdentitySalience";

export type FacialRgb = [number, number, number];

export interface FacialContrastStyle {
  eyeColor: FacialRgb;
  lipColor: "natural" | "rose" | "red" | "berry" | "brown" | "coral";
  irisLightness: "dark" | "medium" | "light";
  contrastBoost: boolean;
}

/** A compact, source-conditioned palette. Geometry and pixel ownership stay in FacePixelPlan. */
export interface FacialContrastPlan {
  eyeDark: FacialRgb;
  eyeMid: FacialRgb;
  browDark: FacialRgb;
  browMid: FacialRgb;
  lipDark: FacialRgb;
  lipMid: FacialRgb;
  teethLight: FacialRgb;
  noseShade: FacialRgb;
  targets: {
    eye: number;
    brow: number;
    mouth: number;
    teeth: number;
    nose: number;
  };
}

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const mix = (a: FacialRgb, b: FacialRgb, amount: number): FacialRgb => [
  clamp(a[0] * (1 - amount) + b[0] * amount),
  clamp(a[1] * (1 - amount) + b[1] * amount),
  clamp(a[2] * (1 - amount) + b[2] * amount),
];
const shade = (color: FacialRgb, factor: number): FacialRgb => color.map((channel) => clamp(channel * factor)) as FacialRgb;
const luminance = (color: FacialRgb) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;

export function facialColorDistance(first: FacialRgb, second: FacialRgb): number {
  return Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
}

function salience(plan: FaceIdentitySaliencePlan, axis: FaceIdentityAxis): number {
  return [...plan.primary, ...plan.secondary, ...plan.tertiary].find((cue) => cue.axis === axis)?.score ?? 0;
}

function ensureContrast(candidate: FacialRgb, background: FacialRgb, minimum: number, preferDark: boolean): FacialRgb {
  if (facialColorDistance(candidate, background) >= minimum) return candidate;
  const dark = shade(mix(candidate, background, 0.08), preferDark ? 0.38 : 0.48);
  const light = mix(candidate, [242, 236, 220], 0.68);
  if (preferDark) return dark;
  return facialColorDistance(dark, background) >= facialColorDistance(light, background) ? dark : light;
}

function ensureMinimumLuminance(candidate: FacialRgb, minimum: number): FacialRgb {
  if (luminance(candidate) >= minimum) return candidate;
  const warmWhite: FacialRgb = [238, 230, 212];
  for (let step = 1; step <= 10; step++) {
    const raised = mix(candidate, warmWhite, step / 10);
    if (luminance(raised) >= minimum) return raised;
  }
  return warmWhite;
}

export function buildFacialContrastPlan(
  skin: FacialRgb,
  hair: FacialRgb,
  style: FacialContrastStyle,
  identity: FaceIdentitySaliencePlan,
): FacialContrastPlan {
  const boost = style.contrastBoost ? 16 : 0;
  const eyeTarget = 92 + boost + Math.round(Math.max(salience(identity, "eye_width"), salience(identity, "eye_openness")) * 16);
  const browTarget = 62 + boost + Math.round(salience(identity, "brow_strength") * 20);
  const mouthTarget = 54 + boost + Math.round(Math.max(salience(identity, "mouth_width"), salience(identity, "mouth_topology")) * 18);
  const lipSources: Record<FacialContrastStyle["lipColor"], FacialRgb> = {
    natural: mix(skin, [126, 67, 60], 0.38),
    rose: mix(skin, [157, 78, 89], 0.58),
    red: mix(skin, [153, 48, 51], 0.62),
    berry: mix(skin, [118, 47, 73], 0.62),
    brown: mix(skin, [112, 67, 56], 0.6),
    coral: mix(skin, [180, 83, 69], 0.58),
  };
  const eyeFactor = style.irisLightness === "light" ? 0.76 : style.irisLightness === "medium" ? 0.6 : 0.48;
  const eyeDark = ensureContrast(shade(style.eyeColor, eyeFactor), skin, eyeTarget, true);
  const eyeMid = ensureContrast(mix(eyeDark, skin, 0.27), skin, Math.max(70, eyeTarget - 25), true);
  const browDark = ensureContrast(shade(hair, 0.54), skin, browTarget, true);
  const browMid = ensureContrast(mix(shade(hair, 0.72), skin, 0.1), skin, Math.max(48, browTarget - 18), true);
  const lipMid = ensureContrast(lipSources[style.lipColor], skin, mouthTarget, false);
  const lipDark = ensureContrast(shade(lipMid, 0.56), skin, mouthTarget + 18, true);
  // Teeth are warm and complexion-linked, avoiding a fixed white sparkle.
  const teethBase = ensureContrast(mix(skin, [232, 222, 202], 0.58), skin, 46 + Math.round(salience(identity, "mouth_topology") * 12), false);
  const teethLight = ensureMinimumLuminance(teethBase, Math.max(115, luminance(lipMid) + 24, luminance(lipDark) + 24));
  const noseShade = ensureContrast(mix(skin, [104, 67, 58], 0.22), skin, 30 + boost / 2, true);
  return {
    eyeDark,
    eyeMid,
    browDark,
    browMid,
    lipDark,
    lipMid,
    teethLight,
    noseShade,
    targets: { eye: eyeTarget, brow: browTarget, mouth: mouthTarget, teeth: 46, nose: 30 },
  };
}
