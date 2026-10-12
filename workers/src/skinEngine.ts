/** Portable deterministic engine: no Worker bindings, HTTP, secrets, storage,
 * canvas or provider dispatch. Use it after a validated photo observation. */
import type { PhotoAnalysis } from "./analysis";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { RawImage } from "./png";
import { renderReferencePrimaryAtlas } from "./referencePrimaryRenderer";
import { repairSkinIntegrity } from "../../shared/skinIntegrity";
export const SKIN_ENGINE_VERSION = "reference-engine-20261013-v1";
export function renderSkinEngine(source: RawImage, plan: SkinPlan, observation: PhotoAnalysis, style: FaceStyle) {
  const rendered = renderReferencePrimaryAtlas(source, plan, observation, style);
  if (!rendered.ok) return rendered;
  const checked = repairSkinIntegrity(rendered.atlas, source);
  if (!checked.report.valid) return { ok: false as const, reason: "source_atlas_invalid" as const, renderAttempts: rendered.summary.renderAttempts };
  return { ...rendered, atlas: checked.atlas, engine: { version: SKIN_ENGINE_VERSION,
    format: "minecraft-64x64-rgba" as const, editions: ["java", "bedrock"] as const,
    sourceConstraints: "validated" as const, integrity: checked.report } };
}
