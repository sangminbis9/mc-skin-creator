/**
 * Generated bindings are the production source of truth. Optional overrides
 * keep unit tests able to exercise disabled flags and legacy provider seams.
 */
interface EnvOverrides {
  /** Configure as a Wrangler secret, never as a public Vite variable. */
  GEMINI_API_KEY?: string;
  /** Production AI Gateway binding; tests may also use it as a legacy provider seam. */
  AI?: Ai;
  MCSKIN_KV: KVNamespace;
  /** Primary multimodal model used to turn a portrait into structured skin details. */
  VISION_MODEL?: string;
  /** Secondary multimodal model used when the primary model fails or returns invalid JSON. */
  VISION_FALLBACK_MODEL?: string;
  /** Per-request deadline for Gemini structured analysis and critique. */
  GEMINI_STRUCTURED_TIMEOUT_MS?: string;
  /** Per-request deadline for Gemini image generation. */
  GEMINI_IMAGE_TIMEOUT_MS?: string;
  GEMINI_IMAGE_MODEL?: string;
  GEMINI_IMAGE_QUALITY_MODEL?: string;
  /** Lower-cost image model tried only when a configured model is unavailable or has no quota. */
  GEMINI_IMAGE_FALLBACK_MODEL?: string;
  /** "true"일 때만 Gemini 이미지 생성 사용 (아니면 절차적 fallback만) */
  IMAGE_GENERATION_ENABLED?: string;
  /** "front_view" | "four_view" — UV atlas는 항상 코드가 조립한다. */
  IMAGE_GEN_STRATEGY?: string;
  /** "balanced" uses GEMINI_IMAGE_MODEL; "quality" uses the quality override. */
  IMAGE_MODEL_TIER?: string;
  /** Run six-view Gemini likeness critique before accepting an image atlas. */
  IMAGE_CRITIQUE_ENABLED?: string;
  /** Gemini 로컬 상대 사용량 표시 분모 비율 (0~1, 기본 0.5; 공급자 한도와 별개) */
  DAILY_BUDGET_RATIO?: string;
}

export type Env = Omit<Partial<Cloudflare.Env>, keyof EnvOverrides> &
  EnvOverrides;

export type QuotaLevel = "available" | "almost" | "closed";

export interface QuotaStatus {
  level: QuotaLevel;
  remainingGenerations: number;
  resetAtIso: string;
  usedRatio: number;
  /** Local accounting is only an estimate until Workers AI reports exhaustion. */
  capacityBasis: "local_estimate" | "provider_reported_closed";
}
