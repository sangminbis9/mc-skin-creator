import { ApiError, requestSkinGeneration } from "./cloudflareAI";
import { loadImage } from "./imageQuality";
import { estimatePhotoColors } from "./photoColors";
import { decodeSkinPng } from "./skinDecode";
import { normalizeFeatures, type SkinFeatures } from "./skinFeatures";
import { generateSkinFromFeatures } from "./skinFromFeatures";

export interface GeneratedSkin {
  canvas: HTMLCanvasElement;
  features: SkinFeatures;
  onDevice: boolean;
}

async function photoFeatures(photo: string): Promise<Partial<SkinFeatures>> {
  const image = await loadImage(photo);
  const scale = Math.min(1, 96 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Photo canvas unavailable");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return estimatePhotoColors(ctx.getImageData(0, 0, canvas.width, canvas.height));
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function generateEditableSkin(photo: string, analysisPhoto: string, references: string[]): Promise<GeneratedSkin> {
  let features: SkinFeatures | undefined;
  try {
    const result = await requestSkinGeneration(photo, analysisPhoto, references);
    const canvas = result.skinPngBase64 ? await decodeSkinPng(result.skinPngBase64) : null;
    if (canvas) return { canvas, features: normalizeFeatures(result.features ?? {}), onDevice: false };
    if (result.features) features = normalizeFeatures(result.features);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code === "photo_rejected" || error.code === "bad_request") throw error;
    if (error.response?.ok && error.response.features) features = normalizeFeatures(error.response.features);
  }
  // Only completed server results are cached. A later request can use AI again.
  features ??= normalizeFeatures(await photoFeatures(analysisPhoto));
  return { canvas: generateSkinFromFeatures(features), features, onDevice: true };
}
