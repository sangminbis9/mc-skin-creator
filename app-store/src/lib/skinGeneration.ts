import { ApiError, requestSkinGeneration } from "./cloudflareAI";
import { decodeSkinPng } from "./skinDecode";
import { normalizeFeatures, type SkinFeatures } from "./skinFeatures";

export interface GeneratedSkin {
  canvas: HTMLCanvasElement;
  features: SkinFeatures;
  onDevice: boolean;
}

export async function generateEditableSkin(photo: string, analysisPhoto: string, references: string[]): Promise<GeneratedSkin> {
  const result = await requestSkinGeneration(photo, analysisPhoto, references);
  const canvas = result.skinPngBase64 ? await decodeSkinPng(result.skinPngBase64) : null;
  if (!canvas) throw new ApiError("Invalid skin image", "SKIN_RENDER_FAILED", result);
  return { canvas, features: normalizeFeatures(result.features ?? {}), onDevice: false };
}
