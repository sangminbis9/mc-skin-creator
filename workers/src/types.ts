export interface Env {
  AI: Ai;
  MCSKIN_KV: KVNamespace;
  /** Primary multimodal model used to turn a portrait into structured skin details. */
  VISION_MODEL?: string;
  /** Secondary multimodal model used when the primary model fails or returns invalid JSON. */
  VISION_FALLBACK_MODEL?: string;
  /** "true"일 때만 FLUX 이미지 생성 사용 (아니면 절차적 fallback만) */
  IMAGE_GENERATION_ENABLED?: string;
  /** "front_view" | "four_view" — UV atlas는 항상 코드가 조립한다. */
  IMAGE_GEN_STRATEGY?: string;
  /** "balanced"(기본, Klein 4B) | "quality"(Klein 9B, 유료 품질 우선) */
  IMAGE_MODEL_TIER?: string;
  /** Cloudflare 무료 10,000 Neurons/day 중 사용할 비율 (0~1, 기본 0.5) */
  DAILY_BUDGET_RATIO?: string;
}

export type QuotaLevel = "available" | "almost" | "closed";

export interface QuotaStatus {
  level: QuotaLevel;
  remainingGenerations: number;
  resetAtIso: string;
  usedRatio: number;
}
