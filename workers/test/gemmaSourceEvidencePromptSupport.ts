// Exact inverse of the reviewed prompt-only delta, never a provider-data repair.
export const GEMMA_SOURCE_EVIDENCE_REMINDER = `SOURCE SELECTION EVIDENCE COMPLETENESS:
Even with one image and all image indices set to 0, provide descriptive evidence in sourceSelection.portraitEvidence, outfitEvidence, and generationEvidence explaining the visible view or its limitations for each choice.
Each evidence string must contain at least 3 characters after trimming. For portraitEvidence, this minimum applies to the descriptive prose before the REGION suffix; append the required REGION suffix without replacing the prose.
Use only visible source support, describe limitations honestly, and do not invent details or pad evidence to meet the minimum.`;

export function withoutGemmaSourceEvidenceReminder(value: string): string {
  const newline = value.includes("\r\n") ? "\r\n" : "\n";
  const block = `${GEMMA_SOURCE_EVIDENCE_REMINDER}\n\n`.replace(/\n/g, newline);
  if (value.split(block).length !== 2) throw new Error("expected_exactly_one_source_evidence_reminder");
  return value.replace(block, "");
}
