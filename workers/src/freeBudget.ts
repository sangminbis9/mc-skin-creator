/** Project-wide reservation ledger. Stores counters only, never photos or identity. */
export const PROJECT_NEURON_LIMIT = 5000;
export const FREE_VISION_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const MAX_FREE_OUTPUT_TOKENS = 8192;
// Published Gemma context window and rates, checked 2026-10-13. Reserve the
// ENTIRE context, including image tokens, rather than guessing from JPEG bytes.
export const MAX_FREE_INPUT_TOKENS = 256000;
export const INPUT_NEURONS_PER_MILLION = 9091;
export const OUTPUT_NEURONS_PER_MILLION = 27273;
export const MAX_CALL_NEURONS = Math.ceil((MAX_FREE_INPUT_TOKENS * INPUT_NEURONS_PER_MILLION
  + MAX_FREE_OUTPUT_TOKENS * OUTPUT_NEURONS_PER_MILLION) / 1_000_000);

export interface BudgetState {
  day: string; used: number; closed: boolean;
  reservations: Record<string, number>;
}
export interface BudgetStatus { day: string; used: number; available: number; limit: number; closed: boolean }
export function budgetStatus(state: BudgetState): BudgetStatus {
  return { day: state.day, used: state.used, available: Math.max(0, PROJECT_NEURON_LIMIT - state.used),
    limit: PROJECT_NEURON_LIMIT, closed: state.closed || state.used + MAX_CALL_NEURONS > PROJECT_NEURON_LIMIT };
}
export function newBudgetState(day: string): BudgetState { return { day, used: 0, closed: false, reservations: {} }; }
export function reserveBudget(state: BudgetState, id: string): boolean {
  if (!/^[a-z0-9-]{16,64}$/i.test(id) || Object.hasOwn(state.reservations, id) || budgetStatus(state).closed) return false;
  state.used += MAX_CALL_NEURONS; state.reservations[id] = MAX_CALL_NEURONS; return true;
}
/** Only authenticated provider token usage can release a reservation. Unknown,
 * failed, timed-out and crash-interrupted calls retain their full upper bound. */
export function settleBudget(state: BudgetState, id: string, charged: number): void {
  const held = state.reservations[id];
  if (held === undefined) return;
  if (!Number.isSafeInteger(charged) || charged < 1 || charged > held) { state.closed = true; return; }
  state.used -= held - charged; delete state.reservations[id];
}
export function reportedGemmaNeurons(result: unknown): number | null {
  if (!result || typeof result !== "object" || !("usage" in result)) return null;
  const usage = result.usage;
  if (!usage || typeof usage !== "object" || !("prompt_tokens" in usage) || !("completion_tokens" in usage)) return null;
  const input = usage.prompt_tokens, output = usage.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output)
    || input < 1 || output < 0 || input > MAX_FREE_INPUT_TOKENS || output > MAX_FREE_OUTPUT_TOKENS) return null;
  return Math.max(1, Math.ceil((input * INPUT_NEURONS_PER_MILLION + output * OUTPUT_NEURONS_PER_MILLION) / 1_000_000));
}
