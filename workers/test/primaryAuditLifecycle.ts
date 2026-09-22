// Audit-only memory: never retain binding arguments, results, errors or credentials.
export type AuditStage = "created" | "request_entered" | "primary_started"
  | "gemini_dispatch_started" | "gemini_returned" | "gemini_failed"
  | "gemma_dispatch_started" | "gemma_returned" | "gemma_failed"
  | "photo_analysis_completed" | "geometry_started" | "geometry_completed" | "response_ready";

export type ProviderCalls = {
  geminiStarted: number; geminiCompleted: number; geminiFailed: number;
  gemmaStarted: number; gemmaCompleted: number; gemmaFailed: number; retry: 0;
};
export type AuditRunState = ProviderCalls & {
  runId: string; stage: AuditStage; requestEnteredAt?: number; finalOk?: boolean;
  lifecycle: Array<{ stage: AuditStage; at: number }>;
};
export const validRunId = (value: string | null): value is string =>
  value !== null && /^[a-f0-9]{32}$/.test(value);
export function createAuditState(runId: string): AuditRunState {
  return {
    runId, stage: "created", lifecycle: [{ stage: "created", at: Date.now() }],
    geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
    gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0,
  };
}
export function markAuditStage(state: AuditRunState, stage: AuditStage): void {
  state.stage = stage;
  state.lifecycle.push({ stage, at: Date.now() });
  if (stage === "request_entered") state.requestEnteredAt = Date.now();
}
export function providerCallsOf(state: ProviderCalls): ProviderCalls {
  return {
    geminiStarted: state.geminiStarted, geminiCompleted: state.geminiCompleted, geminiFailed: state.geminiFailed,
    gemmaStarted: state.gemmaStarted, gemmaCompleted: state.gemmaCompleted, gemmaFailed: state.gemmaFailed, retry: 0,
  };
}
export function assertProviderCalls(state: ProviderCalls): void {
  for (const provider of ["gemini", "gemma"] as const) {
    const started = state[`${provider}Started`];
    const completed = state[`${provider}Completed`];
    const failed = state[`${provider}Failed`];
    if (![started, completed, failed].every(n => Number.isInteger(n) && n >= 0)
      || started > 1 || completed + failed > started) throw new Error("invalid_audit_accounting");
  }
  if (state.retry !== 0) throw new Error("invalid_audit_retry");
}

// Proxy an ordinary empty target, not an exotic binding. All other methods are
// bound to their original receiver; Reflect.apply also preserves gateway context.
function forwardingProxy<T extends object>(source: T, overrides: Record<string, unknown>): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (typeof property === "string" && Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(source, property, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}
export function wrapAuditAI<T extends object>(ai: T, state: AuditRunState, gemmaModel: string): T {
  const dispatch = async (provider: "gemini" | "gemma", source: object, method: (...args: unknown[]) => unknown, args: unknown[]) => {
    state[`${provider}Started`]++;
    markAuditStage(state, `${provider}_dispatch_started`);
    try {
      const result = await Reflect.apply(method, source, args);
      state[`${provider}Completed`]++;
      markAuditStage(state, `${provider}_returned`);
      return result;
    } catch (error) {
      state[`${provider}Failed`]++;
      markAuditStage(state, `${provider}_failed`);
      throw error;
    }
  };
  const gateway = Reflect.get(ai, "gateway", ai);
  const run = Reflect.get(ai, "run", ai);
  return forwardingProxy(ai, {
    ...(typeof gateway === "function" ? {
      gateway: (...args: unknown[]) => {
        const original = Reflect.apply(gateway, ai, args);
        const originalRun = Reflect.get(original, "run", original);
        return forwardingProxy(original, {
          run: (...runArgs: unknown[]) => dispatch("gemini", original, originalRun, runArgs),
        });
      },
    } : {}),
    ...(typeof run === "function" ? {
      run: (...args: unknown[]) => args[0] === gemmaModel
        ? dispatch("gemma", ai, run as (...args: unknown[]) => unknown, args) : Reflect.apply(run, ai, args),
    } : {}),
  });
}
