/** Portable deterministic engine: no Worker bindings, HTTP, secrets, storage,
 * canvas or provider dispatch. Use it after a validated photo observation. */
import type { PhotoAnalysis } from "./analysis";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { RawImage } from "./png";
import { renderReferencePrimaryAtlas } from "./referencePrimaryRenderer";
import { repairSkinIntegrity } from "../../shared/skinIntegrity";
import { buildReferenceStylePlan, type ReferenceStylePlan, type SkinPresentation } from "./referenceStyleTemplates";
import { applyCoveredHeadFinish, COVERED_HEAD_FINISH } from "./coveredHeadFinish";
import { validateFinalAtlas } from "./skinPost";
import { applyNameMcHead, applyObservedBeanie, nameMcHairMask, NAMEMC_HEAD_FINISH, STYLIZED_NAMEMC_HEAD_FINISH, PREVIOUS_NAMEMC_HEAD_FINISH, namemcDrapeReliefCount, namemcDrapeReservation, usesAdaptiveHeadPolicy, usesNameMcHead, usesPhotoDrapePolicy, type NameMcFinishPolicy } from "./namemcHeadTemplate";
import { buildPhotoDrape, classifyPhotoHair, type PhotoDrapeCell } from "./photoHairFinish";
import { buildPhotoHeadGeometry, type PhotoHeadGeometry } from "./photoHeadGeometry";
import { renderReferenceGarmentUnderlay } from "./referenceStyleRenderer";
import { refineFixedFootwear } from "./fixedFootwearFinish";
import { CLASSIC_LAYOUT } from "./uvLayout";
import { sculptStylizedHair, sculptWrappedHair } from "./stylizedHairArt";
import { applyPublicClothFinish, PUBLIC_CLOTH_POLICY } from "./publicClothFinish";
import { PUBLIC_LEGWEAR_POLICY } from "./outfitIdentity";
export const SKIN_ENGINE_VERSION = "reference-engine-20261126-front-locks-v26";

export function photoHeadForRender(style: FaceStyle, observation: PhotoAnalysis, drape: readonly PhotoDrapeCell[],
  presentation: SkinPresentation = "source", policy: NameMcFinishPolicy = NAMEMC_HEAD_FINISH): PhotoHeadGeometry {
  const observed = observation.observed.hair;
  const profile = classifyPhotoHair(style, observed, true);
  // The caller supplies already-scoped drape. Only shoulder joins can change;
  // the forehead, fringe and crown still come from the original hair profile.
  const geometry = buildPhotoHeadGeometry(style, profile, observed, drape, observation.visibleRegions.hair ? observation.appearanceDetail : undefined);
  return policy === NAMEMC_HEAD_FINISH ? sculptWrappedHair(geometry, profile, presentation)
    : policy === STYLIZED_NAMEMC_HEAD_FINISH ? sculptStylizedHair(geometry, profile, presentation) : geometry;
}

export function renderNameMcPresentation(atlas: RawImage, plan: SkinPlan, observation: PhotoAnalysis, style: FaceStyle,
  presentation: SkinPresentation, design?: ReferenceStylePlan, policy: NameMcFinishPolicy = NAMEMC_HEAD_FINISH,
  drape: readonly PhotoDrapeCell[] = usesPhotoDrapePolicy(policy) ? buildPhotoDrape(plan, observation, style, usesAdaptiveHeadPolicy(policy)) : [],
  geometry: PhotoHeadGeometry | undefined = usesAdaptiveHeadPolicy(policy) ? photoHeadForRender(style, observation, drape, presentation, policy) : undefined): RawImage {
  const front = CLASSIC_LAYOUT.body.overlay.front;
  const reservation = new Set(drape.filter(p => p.face === "front").map(p => ((front.y + p.y) * 64 + front.x + p.x) * 4));
  const underlay = renderReferenceGarmentUnderlay(atlas, plan, design ?? buildReferenceStylePlan(observation), style,
    usesPhotoDrapePolicy(policy) ? reservation : namemcDrapeReservation,
    usesPhotoDrapePolicy(policy) ? drape.filter(p => p.layer === "overlay").length : namemcDrapeReliefCount);
  const result = applyNameMcHead(atlas, underlay, plan, style, presentation, policy, drape, classifyPhotoHair(style, observation.observed.hair, usesAdaptiveHeadPolicy(policy)), geometry);
  if (policy !== PREVIOUS_NAMEMC_HEAD_FINISH) refineFixedFootwear(result, plan.outfitPlan.lower);
  return result;
}
export function renderSkinEngine(source: RawImage, plan: SkinPlan, observation: PhotoAnalysis, style: FaceStyle, maxRenderAttempts?: number, presentation?: SkinPresentation) {
  const rendered = renderReferencePrimaryAtlas(source, plan, observation, style, maxRenderAttempts);
  if (!rendered.ok) return rendered;
  const checked = repairSkinIntegrity(rendered.atlas, source);
  if (!checked.report.valid) return { ok: false as const, reason: "source_atlas_invalid" as const, renderAttempts: rendered.summary.renderAttempts };
  // Omission is reserved for internal historical replays; public requests
  // always specify a finish, including the default photo-led presentation.
  const fixedTemplate = presentation !== undefined && usesNameMcHead(plan, style);
  const drape = fixedTemplate ? buildPhotoDrape(plan, observation, style, true) : undefined;
  const geometry = drape && photoHeadForRender(style, observation, drape, presentation);
  const atlas = presentation === undefined ? checked.atlas : fixedTemplate
    ? renderNameMcPresentation(checked.atlas, plan, observation, style, presentation, rendered.summary.design, NAMEMC_HEAD_FINISH, drape, geometry)
    : applyCoveredHeadFinish(checked.atlas, plan, style, presentation, rendered.craftPlan?.execution);
  if (presentation !== undefined) {
    if (observation.visibleRegions.hair || observation.visibleRegions.face) applyObservedBeanie(atlas, style, observation.appearanceDetail);
    const design = rendered.summary.design ?? (fixedTemplate ? buildReferenceStylePlan(observation) : undefined);
    applyPublicClothFinish(atlas, plan, style.skinTone ?? "#d39e80", design?.garmentDetailPolicy ?? !!design?.materialDetailPolicy,
      drape, fixedTemplate ? undefined : rendered.craftPlan?.execution.surfaces);
  }
  if (!validateFinalAtlas(atlas).ok) return { ok: false as const, reason: "source_atlas_invalid" as const, renderAttempts: rendered.summary.renderAttempts };
  return { ...rendered, atlas, fixedHairMask: drape && nameMcHairMask(style, drape, NAMEMC_HEAD_FINISH, geometry, (observation.visibleRegions.hair || observation.visibleRegions.face) ? observation.appearanceDetail : undefined), summary: presentation === undefined ? rendered.summary : {
    ...rendered.summary, headFinish: { policy: fixedTemplate ? NAMEMC_HEAD_FINISH : COVERED_HEAD_FINISH, presentation }, garmentFinish: PUBLIC_CLOTH_POLICY,
    ...(plan.outfitPlan.lower.legwear.startRow !== undefined ? { legwearFinish: PUBLIC_LEGWEAR_POLICY } : {}),
  }, engine: { version: SKIN_ENGINE_VERSION,
    format: "minecraft-64x64-rgba" as const, editions: ["java", "bedrock"] as const,
    sourceConstraints: "validated" as const, integrity: checked.report } };
}
