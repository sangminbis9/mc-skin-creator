import type { PhotoAnalysis } from "../src/analysis";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";

/** Explicit replay of the pre-2026-10-11 presentation. Historical comparisons
 * isolate earlier hair/mouth changes; current-default coverage lives in
 * referencePrimaryIntegration and referenceUserFeedback, without this adapter. */
export function buildPreFeedbackReferenceDesign(analysis: PhotoAnalysis) {
  const design = buildReferenceStylePlan(analysis);
  delete design.faceLayoutPolicy;
  delete design.hairPalettePolicy;
  delete design.headProportionPolicy;
  delete design.materialDetailPolicy;
  delete design.hairVolumePolicy;
  delete design.headSeamPolicy;
  return design;
}
