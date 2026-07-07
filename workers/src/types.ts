export interface Env {
  AI: Ai;
  MCSKIN_KV: KVNamespace;
  /** "true"일 때만 FLUX 이미지 생성 사용 (아니면 절차적 fallback만) */
  IMAGE_GENERATION_ENABLED?: string;
  /** "front_view"(기본) | "direct_atlas" — 이미지 생성 전략 */
  IMAGE_GEN_STRATEGY?: string;
  /** "balanced"(기본, Klein 4B) | "quality"(Klein 9B, 유료 품질 우선) */
  IMAGE_MODEL_TIER?: string;
  /** Cloudflare 무료 10,000 Neurons/day 중 사용할 비율 (0~1, 기본 0.5) */
  DAILY_BUDGET_RATIO?: string;
  /** 로컬 개발 전용 스타일 참고 스킨 (448x448 PNG base64, .dev.vars) */
  STYLE_REF_B64?: string;
}

export type QuotaLevel = "available" | "almost" | "closed";

export interface QuotaStatus {
  level: QuotaLevel;
  remainingGenerations: number;
  resetAtIso: string;
  usedRatio: number;
}
