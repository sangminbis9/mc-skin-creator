/** Executable reference construction beside (never instead of) source identity.
 * This snapshot is design evidence, not a new measurement/provider contract.
 * Shared craft floors still apply; a selective mask is not permission to pass
 * an unshaded/noisy atlas or erase an independently source-authored cue.
 */
import type { RawImage } from "./png";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { ReferenceStylePlan } from "./referenceStyleTemplates";
import type { ReferenceCompositionResult, ReferenceCompositionDiagnostic } from "./referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "./referenceStyleSelection";
import { validateAtlasCraftFoundation, validateFinalAtlas } from "./skinPost";

export interface ReferenceCraftPlan {
  version: "reference_craft_v1";
  provenance: "template_design";
  /** Original coordinates, observed traits and canonical material primitives. */
  identity: SkinPlan;
  style: ReferenceStylePlan;
  execution: ReferenceCompositionDiagnostic;
}

export function buildReferenceCraftPlan(
  source: SkinPlan, style: ReferenceStylePlan, composition: ReferenceCompositionResult,
): ReferenceCraftPlan {
  // Snapshot rather than sharing mutable arrays with caller/render diagnostics.
  return structuredClone({ version: "reference_craft_v1", provenance: "template_design", identity: source, style, execution: composition.diagnostic });
}

export function validateReferenceAtlasCraft(
  atlas: RawImage, baseline: RawImage, source: SkinPlan, style: FaceStyle, plan: ReferenceCraftPlan,
) {
  const problems = new Set<string>();
  if (plan.version !== "reference_craft_v1" || plan.provenance !== "template_design") problems.add("reference_craft_contract_invalid");
  // Runtime source identity remains authoritative even if a stored paint plan
  // is rewritten along with pixels. Never use a tampered snapshot as evidence.
  if (JSON.stringify(source) !== JSON.stringify(plan.identity)) problems.add("reference_craft_identity_changed");
  const layout = validateFinalAtlas(atlas);
  if (!layout.ok) {
    return { ok: false, problems: [...problems, "final_atlas_invalid"], foundation: null, construction: null };
  }
  const foundation = validateAtlasCraftFoundation(atlas, style);
  foundation.problems.forEach(p => problems.add(p));
  const construction = measureReferenceRenderedQuality({ atlas, diagnostic: plan.execution }, baseline, source, plan.style, style);
  construction.violations.forEach(p => problems.add(p));
  return { ok: problems.size === 0, problems: [...problems], foundation, construction };
}
