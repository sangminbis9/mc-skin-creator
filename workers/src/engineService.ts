/** Cloudflare is the authority for the account's free daily allocation. */
import { generateSkin, type GenerateResult } from "./generate";
import { FREE_VISION_MODEL, MAX_FREE_OUTPUT_TOKENS, MAX_IMAGE_ATTEMPTS, MAX_IMAGE_CALL_NEURONS, reportedGemmaNeurons } from "./freeBudget";
import { WorkersAiImageProvider, type SkinGenerationProvider } from "./skinProvider";
import type { Env, QuotaStatus } from "./types";
import { validVisionImage } from "./visionInput";

export interface SkinEngineRequest { image: string; analysisImage?: string; referenceImages?: string[] }

export async function freeQuotaStatus(_env: Env, providerClosed = false): Promise<QuotaStatus> {
  const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
  return { level: providerClosed ? "closed" : "unknown", remainingGenerations: providerClosed ? 0 : null,
    resetAtIso: reset.toISOString(), usedRatio: null,
    capacityBasis: providerClosed ? "provider_reported_closed" : "provider_unknown" };
}

export async function generateFreeSkin(env: Env, input: SkinEngineRequest): Promise<GenerateResult> {
  const images = [input.image, input.analysisImage ?? input.image, ...(input.referenceImages ?? [])];
  if ((input.referenceImages?.length ?? 0) > 4 || images.some(v => typeof v !== "string" || !validVisionImage(v)))
    return { success: false, status: 400, neuronsSpent: 0, body: { ok: false, errorCode: "bad_request", error: "축소된 JPEG 또는 PNG 사진을 사용해 주세요" } };
  if (!env.AI) return { success: false, status: 503, neuronsSpent: 0,
    body: { ok: false, errorCode: "provider_unavailable", error: "무료 생성 서비스 설정을 확인해 주세요" } };
  const imageEnabled = env.FREE_IMAGE_GENERATION_ENABLED === "true";
  let dispatched = false, charged = 0, imageCalls = 0;
  const imageEnv = { ...env, ...(imageEnabled ? { MCSKIN_KV: { put: async () => undefined } as unknown as KVNamespace } : {}),
    WORKERS_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
    WORKERS_IMAGE_QUALITY_MODEL: "@cf/black-forest-labs/flux-2-klein-4b", IMAGE_MODEL_TIER: "balanced" };
  const workerImage = new WorkersAiImageProvider(imageEnv);
  const imageProvider: SkinGenerationProvider = { generate: async request => {
    if (!dispatched || imageCalls >= MAX_IMAGE_ATTEMPTS) throw new Error("Image dispatch limit reached");
    imageCalls++;
    return workerImage.generate({ ...request, modelTier: "balanced" });
  } };
  const result = await generateSkin({ ...imageEnv, AI_POLICY: "workers_free_only", WORKERS_VISION_MODEL: FREE_VISION_MODEL,
    FREE_ANALYSIS_RUN: async wire => {
      if (dispatched || wire.max_completion_tokens !== MAX_FREE_OUTPUT_TOKENS) throw new Error("Free call policy rejected");
      dispatched = true;
      const response = await env.AI!.run(FREE_VISION_MODEL as never, wire as never);
      charged = reportedGemmaNeurons(response) ?? 0;
      return response;
    },
  }, input.image, imageEnabled ? imageProvider : undefined, input.analysisImage ?? input.image, input.referenceImages ?? []);
  const b = result.body;
  return { status: result.status, success: result.success, neuronsSpent: charged + imageCalls * MAX_IMAGE_CALL_NEURONS,
    body: { ok: b.ok, ...(b.quality ? { quality: b.quality } : {}), ...(b.features ? { features: b.features } : {}),
      ...(b.skinPngBase64 ? { skinPngBase64: b.skinPngBase64 } : {}),
      ...(b.generationMode ? { generationMode: b.generationMode } : {}),
      ...(b.failReason ? { failReason: b.failReason } : {}),
      ...(b.errorCode ? { errorCode: b.errorCode, error: b.error } : {}) } };
}
