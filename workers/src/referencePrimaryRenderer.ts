/** Default primary render boundary: validated source -> designed atlas.
 * Pure/bounded selection; no new provider, mutable global state or measurements.
 * The legacy atlas is the source-color/ownership reference, not a second style
 * plan. A reference output must satisfy its independent source construction
 * contract and the unchanged shared craft floors before it may be encoded.
 */
import type { PhotoAnalysis } from "./analysis";
import type { RawImage } from "./png";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import { validateAtlasCraft, validateAtlasCraftFoundation, validateFinalAtlas } from "./skinPost";
import { buildReferenceStylePlan, type ReferenceStylePlan } from "./referenceStyleTemplates";
import { selectReferenceStyleAtlas, type ReferenceRenderedQuality } from "./referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft, type ReferenceCraftPlan } from "./referenceCraftPlan";
import type { ReferenceConstraintResult } from "./referenceStyleConstraints";

export interface ReferencePrimarySummary {
  version: "reference_primary_v1";
  status: "reference_style_accepted" | "source_grammar_preserved";
  provenance: "template_design" | "source_identity_plan";
  /** Source SkinPlan remains unchanged; this is a separate authored design. */
  design?: ReferenceStylePlan;
  renderAttempts: number;
  acceptedCandidates: number;
  sourceGeometryPreserved: true;
  craftValidation: "pass";
  constraints?: ReferenceConstraintResult;
  metrics?: ReferenceRenderedQuality["metrics"];
  preservedReason?: "unresolved_complex_head_grammar";
}
export type ReferencePrimaryRenderResult =
  | { ok: true; atlas: RawImage; summary: ReferencePrimarySummary; craftPlan: ReferenceCraftPlan | null }
  | { ok: false; reason: "source_atlas_invalid" | "source_craft_invalid" | "reference_candidates_rejected" | "reference_craft_invalid"; renderAttempts: number };

export function renderReferencePrimaryAtlas(
  baseline: RawImage, source: SkinPlan, analysis: PhotoAnalysis, style: FaceStyle,
): ReferencePrimaryRenderResult {
  if (!validateFinalAtlas(baseline).ok) return { ok: false, reason: "source_atlas_invalid", renderAttempts: 0 };
  if (!validateAtlasCraftFoundation(baseline, style).ok) return { ok: false, reason: "source_craft_invalid", renderAttempts: 0 };
  if (source.headIdentityPlan.ownership?.execution !== "resolved") {
    // Here the old output is actually returned, so its complete legacy source
    // contract (not just the common foundation) must still pass.
    if (!validateAtlasCraft(baseline, style, undefined, undefined, source).ok) return { ok: false, reason: "source_craft_invalid", renderAttempts: 0 };
    // Explicit unsupported grammar, not an invisible rescue of a rejected
    // reference candidate. Report it so coverage cannot be counted as styled.
    return { ok: true, atlas: baseline, craftPlan: null, summary: {
      version: "reference_primary_v1", status: "source_grammar_preserved", provenance: "source_identity_plan",
      renderAttempts: 0, acceptedCandidates: 0, sourceGeometryPreserved: true, craftValidation: "pass",
      preservedReason: "unresolved_complex_head_grammar",
    } };
  }
  const selection = selectReferenceStyleAtlas(baseline, source, buildReferenceStylePlan(analysis), style);
  const selected = selection.selected;
  if (!selected) return { ok: false, reason: "reference_candidates_rejected", renderAttempts: selection.renderAttempts };
  const craftPlan = buildReferenceCraftPlan(source, selected.design, selected.composition);
  if (!validateReferenceAtlasCraft(selected.composition.atlas, baseline, source, style, craftPlan).ok) return { ok: false, reason: "reference_craft_invalid", renderAttempts: selection.renderAttempts };
  return { ok: true, atlas: selected.composition.atlas, craftPlan, summary: {
    version: "reference_primary_v1", status: "reference_style_accepted", provenance: "template_design",
    design: selected.design, renderAttempts: selection.renderAttempts,
    acceptedCandidates: selection.candidates.filter(c => c.quality?.constructionValid && c.foundation?.ok).length,
    sourceGeometryPreserved: true, craftValidation: "pass",
    constraints: selected.composition.diagnostic.constraints, metrics: selected.quality.metrics,
  } };
}
