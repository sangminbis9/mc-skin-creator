export interface Env {
  AI: Ai;
  MCSKIN_KV: KVNamespace;
}

export type QuotaLevel = "available" | "almost" | "closed";

export interface QuotaStatus {
  level: QuotaLevel;
  remainingGenerations: number;
  resetAtIso: string;
  usedRatio: number;
}
