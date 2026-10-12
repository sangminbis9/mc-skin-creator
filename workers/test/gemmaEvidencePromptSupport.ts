// Independent exact production delta for immutable historical prompt comparisons.
// This is not used to change provider data or bypass runtime validation.
import { withoutGemmaSourceEvidenceReminder } from "./gemmaSourceEvidencePromptSupport";
export const GEMMA_EVIDENCE_REMINDER = `FACE MEASUREMENT EVIDENCE CONSISTENCY:
For every faceMeasurements entry, confidence measures support for the chosen non-unknown cue value, not certainty that the cue is unavailable.
Unavailable evidence must be exactly {"value":"unknown","provenance":"unknown","confidence":0}, even when you are certain it cannot be measured.
A non-unknown cue requires visible face evidence, non-unknown provenance, and confidence >=0.75. Do not raise confidence or invent a cue to satisfy this rule; use the unavailable tuple when evidence is insufficient.
Before returning, check value/provenance/confidence together for every entry.`;

export function withoutGemmaEvidenceReminder(prompt: string): string {
  // Later source-selection reminder is independently exact-checked against H-007.
  prompt = withoutGemmaSourceEvidenceReminder(prompt);
  const suffix = `\n\n${GEMMA_EVIDENCE_REMINDER}`;
  if (!prompt.endsWith(suffix) || prompt.split(suffix).length !== 2)
    throw new Error("expected_exactly_one_terminal_gemma_evidence_reminder");
  return prompt.slice(0, -suffix.length);
}

/** Reconstruct only the exact pre-reminder module for immutable file-hash guards. */
export function withoutGemmaEvidenceSourceDelta(source: string): string {
  source = withoutGemmaSourceEvidenceReminder(source);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let value = source.replace(/\r\n/g, "\n");
  const block = '/** Re-emphasize the existing V3 evidence contract, without coercing returned data. */\n'
    + 'export const GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT = `${namedV3Prompt}\n\n'
    + GEMMA_EVIDENCE_REMINDER + '`;\n\n';
  const deltas: Array<[string, string]> = [
    [block, ""],
    ["const namedV3Prompt =", "export const GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT ="],
    ["if (namedV3Prompt.split(", "if (GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT.split("],
    ["// This V3-only reminder does not silently change the internal opt-in V4 contract.\n", ""],
    ["export const GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT = namedV3Prompt", "export const GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT = GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT"],
  ];
  for (const [current, previous] of deltas) {
    if (value.split(current).length !== 2) throw new Error("unexpected_gemma_evidence_source_delta");
    value = value.replace(current, previous);
  }
  return value.replace(/\n/g, newline);
}
