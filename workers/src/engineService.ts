/** HTTP-independent application boundary. Platform hosts supply bindings;
 * consumers receive only a PNG and public editor metadata, never analysis prose. */
import { generateSkin, type GenerateResult } from "./generate";
import { FREE_VISION_MODEL, MAX_FREE_OUTPUT_TOKENS, MAX_CALL_NEURONS, MAX_IMAGE_ATTEMPTS, MAX_IMAGE_CALL_NEURONS, reportedGemmaNeurons } from "./freeBudget";
import { withinDeadline } from "./deadline";
import { WorkersAiImageProvider, type SkinGenerationProvider } from "./skinProvider";
import type { Env, QuotaStatus } from "./types";
import { validVisionImage } from "./visionInput";

export interface SkinEngineRequest { image: string; analysisImage?: string; referenceImages?: string[] }
export async function freeQuotaStatus(env: Env): Promise<QuotaStatus> {
  const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
  if (!env.NEURON_BUDGET) return { level: "closed", remainingGenerations: 0,
    resetAtIso: reset.toISOString(), usedRatio: 1, capacityBasis: "project_reserved" };
  const status = await withinDeadline(() => env.NEURON_BUDGET!.getByName("mc-skin-project").status(), 2000,
    () => new Error("Budget unavailable"));
  return { level: status.closed ? "closed" : status.used / status.limit >= .85 ? "almost" : "available",
    remainingGenerations: status.closed ? 0 : Math.floor(status.available / MAX_CALL_NEURONS),
    resetAtIso: reset.toISOString(), usedRatio: Math.min(1, status.used / status.limit), capacityBasis: "project_reserved" };
}
export async function generateFreeSkin(env: Env, input: SkinEngineRequest): Promise<GenerateResult> {
  const images = [input.image, input.analysisImage ?? input.image, ...(input.referenceImages ?? [])];
  if ((input.referenceImages?.length ?? 0) > 4 || images.some(v => typeof v !== "string" || !validVisionImage(v)))
    return { success: false, status: 400, neuronsSpent: 0, body: { ok: false, errorCode: "bad_request", error: "축소된 JPEG 또는 PNG 사진을 사용해 주세요" } };
  if (!env.AI || !env.NEURON_BUDGET) return { success: false, status: 503, neuronsSpent: 0,
    body: { ok: false, errorCode: "provider_unavailable", error: "무료 생성 서비스 설정을 확인해 주세요" } };
  const budget = env.NEURON_BUDGET.getByName("mc-skin-project");
  const imageEnabled = env.FREE_IMAGE_GENERATION_ENABLED === "true";
  let dispatched = false, charged = 0, budgetDenied = false;
  let imageReservation: { id: string; day: string } | undefined;
  let measuredAnalysis: number | null = null;
  let imageCalls = 0;
  const imageEnv = { ...env, ...(imageEnabled ? { MCSKIN_KV: { put: async () => undefined } as unknown as KVNamespace } : {}),
    WORKERS_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
    WORKERS_IMAGE_QUALITY_MODEL: "@cf/black-forest-labs/flux-2-klein-4b", IMAGE_MODEL_TIER: "balanced" };
  const workerImage = new WorkersAiImageProvider(imageEnv);
  const imageProvider: SkinGenerationProvider = { generate: async request => {
    if (!imageReservation || imageCalls >= MAX_IMAGE_ATTEMPTS) throw new Error("Image dispatch limit reached");
    imageCalls++;
    return workerImage.generate({ ...request, modelTier: "balanced" });
  } };
  let result: GenerateResult;
  try {
    result = await generateSkin({ ...imageEnv, AI_POLICY: "workers_free_only", WORKERS_VISION_MODEL: FREE_VISION_MODEL,
      FREE_ANALYSIS_RUN: async wire => {
        if (dispatched || wire.max_completion_tokens !== MAX_FREE_OUTPUT_TOKENS) throw new Error("Free call policy rejected");
        dispatched = true;
        const id = crypto.randomUUID();
        const reservation = await withinDeadline(() => budget.reserve(id), 2000, () => new Error("Reservation unavailable"));
        if (!reservation.accepted) { budgetDenied = true; throw new Error("Project budget closed"); }
        if (imageEnabled) imageReservation = { id, day: reservation.day };
        charged = MAX_CALL_NEURONS;
        const response = await env.AI!.run(FREE_VISION_MODEL as never, wire as never);
        const measured = reportedGemmaNeurons(response);
        measuredAnalysis = measured;
        if (measured !== null && !imageEnabled) {
          await withinDeadline(() => budget.settle(reservation.day, id, measured), 1000,
            () => new Error("Settlement unavailable")).then(() => { charged = measured; }).catch(() => undefined);
        }
        return response;
      },
    }, input.image, imageEnabled ? imageProvider : undefined, input.analysisImage ?? input.image, input.referenceImages ?? []);
  } finally {
    if (imageEnabled && imageReservation && measuredAnalysis !== null) {
      const held = imageReservation;
      const cost = measuredAnalysis + imageCalls * MAX_IMAGE_CALL_NEURONS;
      await withinDeadline(() => budget.settle(held.day, held.id, cost), 1000,
        () => new Error("Settlement unavailable")).then(() => { charged = cost; }).catch(() => undefined);
    }
  }
  if (budgetDenied) return { status: 429, success: false, neuronsSpent: 0,
    body: { ok: false, errorCode: "quota_exceeded", error: "오늘의 생성 수량이 마감됐어요" } };
  // Explicit response allowlist. Internal observations/plans stay request-local.
  const b = result.body;
  return { status: result.status, success: result.success, neuronsSpent: charged,
    body: { ok: b.ok, ...(b.quality ? { quality: b.quality } : {}), ...(b.features ? { features: b.features } : {}),
      ...(b.skinPngBase64 ? { skinPngBase64: b.skinPngBase64 } : {}),
      ...(b.generationMode ? { generationMode: b.generationMode } : {}),
      ...(b.failReason ? { failReason: b.failReason } : {}),
      ...(b.errorCode ? { errorCode: b.errorCode, error: b.error } : {}) } };
}
