// Audit only. Best-effort CLI log evidence, never authoritative provider accounting.
import { GENERATION_STAGES } from "../../src/generationObservation";
const providers = ["geminiPrimary", "gemmaPrimary", "faceGeometry"] as const;
const boundaries = ["invoked", "returned", "threw", "inspection_started", "inspection_finished"] as const;
export const PROPAGATION_STAGES = [
  "propagation_projection_started", "propagation_projection_finished",
  "propagation_png_started", "propagation_png_finished",
  "propagation_normalization_started", "propagation_normalization_finished",
  "propagation_plan_started", "propagation_plan_finished",
  "propagation_features_finished", "propagation_parameters_finished",
] as const;
export type PropagationStage = typeof PROPAGATION_STAGES[number];
export const E2E_STAGES = ["input_verified", "handler_entered", "handler_returned",
  "propagation_started", "propagation_finished",
  ...PROPAGATION_STAGES,
  ...GENERATION_STAGES.map(stage => `production_${stage}` as const),
  ...providers.flatMap(p => boundaries.map(b => `${p}_${b}` as const))] as const;
export type E2EStage = typeof E2E_STAGES[number];
export type StageObservation = { runId: string; stage: E2EStage };
export function stageObservation(value: unknown, expectedRunId: string | null): StageObservation | null {
  if (!value || typeof value !== "object" || !expectedRunId || !/^[a-f0-9]{32}$/.test(expectedRunId)) return null;
  const v = value as Record<string, unknown>;
  return v.runId === expectedRunId && typeof v.stage === "string" && E2E_STAGES.some(s => s === v.stage)
    ? { runId: expectedRunId, stage: v.stage as E2EStage } : null;
}
export function createStageEmitter(runId: string | null) {
  const sent = new Set<E2EStage>();
  return (stage: E2EStage) => {
    const safe = stageObservation({ runId, stage }, runId);
    if (!safe || sent.has(safe.stage)) return;
    sent.add(safe.stage);
    // Single short framed line; no values from the model, request body or errors.
    // Logging failure must not change the existing dispatch/validation behavior.
    try { console.info(`MCSKIN_E2E_STAGE_V1|${safe.runId}|${safe.stage}|END`); } catch { /* passive */ }
  };
}
