/** Internal, in-process observation only. Not a binding, header or JSON option. */
export const GENERATION_OBSERVER = Symbol("generation_observer");
// A returned/finished phase proves reachability, not validation acceptance.
// The existing primary-only render recovery may enter render phases again.
export const GENERATION_STAGES = [
  "primary_returned", "primary_diagnostic_finished", "crop_started", "crop_returned",
  "enrichment_finished", "render_context_started", "render_context_finished",
  "source_atlas_started", "source_atlas_finished", "reference_atlas_started",
  "reference_atlas_finished", "png_started", "png_finished", "baseline_returned",
] as const;
export type GenerationStage = typeof GENERATION_STAGES[number];
export type GenerationObserver = (stage: GenerationStage) => void;
export interface GenerationObservationContext {
  [GENERATION_OBSERVER]?: GenerationObserver;
}

const noop: GenerationObserver = () => {};
export function generationObserver(context: GenerationObservationContext): GenerationObserver {
  // Capture per request. Nothing about this request is retained in module state.
  let observer: GenerationObserver | undefined;
  try { observer = context[GENERATION_OBSERVER]; } catch { return noop; }
  if (typeof observer !== "function") return noop;
  return stage => {
    try {
      // A trusted observer should be synchronous. Guard an accidental async
      // observer too, without awaiting it or changing generation control flow.
      const result: unknown = observer(stage);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch { /* Diagnostic failure never changes generation behavior. */ }
  };
}
