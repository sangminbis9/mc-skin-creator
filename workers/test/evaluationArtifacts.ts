/**
 * Evaluation-only identity stage exporter.
 *
 * This module lives under test/ so it is never imported into the Worker
 * bundle. Callers must provide an explicit output directory. Full source
 * photographs and credentials are intentionally not accepted by the API.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FacePixelPlan } from "../src/identityPlans";
import { encodePng, type RawImage } from "../src/png";

export interface IdentityEvaluationArtifacts {
  sourceFace: RawImage;
  sourceHead?: RawImage;
  generatedSheetFace?: RawImage;
  packedHeadBefore?: RawImage;
  facePixelPlan: FacePixelPlan;
  oldFacePixelPlan?: FacePixelPlan;
  candidateA?: RawImage;
  candidateB?: RawImage;
  candidateC?: RawImage;
  finalHeadFront: RawImage;
  finalHeadLeft: RawImage;
  finalHeadRight: RawImage;
  finalSkin: RawImage;
  critique: unknown;
  metrics: Record<string, unknown>;
}

const ROLE_COLORS: Record<FacePixelPlan["pixels"][number]["role"], [number, number, number, number]> = {
  skin_light: [239, 190, 158, 255],
  skin_mid: [211, 154, 116, 255],
  skin_shadow: [153, 99, 75, 255],
  hair_light: [92, 72, 58, 255],
  hair_mid: [55, 42, 35, 255],
  hair_shadow: [28, 21, 18, 255],
  brow: [35, 27, 23, 255],
  glasses: [190, 196, 202, 255],
  iris: [52, 75, 83, 255],
  sclera: [231, 225, 211, 255],
  nose_shadow: [156, 104, 83, 255],
  lip: [157, 78, 89, 255],
  teeth: [236, 229, 210, 255],
  mouth_shadow: [75, 37, 42, 255],
};

export function renderFacePixelPlan(plan: FacePixelPlan, scale = 24): RawImage {
  const width = 8 * scale;
  const height = 8 * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (const pixel of plan.pixels) {
    const color = ROLE_COLORS[pixel.role];
    for (let y = pixel.y * scale; y < (pixel.y + 1) * scale; y++) {
      for (let x = pixel.x * scale; x < (pixel.x + 1) * scale; x++) {
        rgba.set(color, (y * width + x) * 4);
      }
    }
  }
  return { width, height, rgba };
}

export async function writeIdentityEvaluationArtifacts(
  outputRoot: string,
  caseId: string,
  artifacts: IdentityEvaluationArtifacts,
): Promise<string> {
  if (!outputRoot.trim()) throw new Error("An explicit evaluation artifact root is required");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(caseId)) throw new Error("Invalid evaluation case id");
  const caseDirectory = resolve(outputRoot, caseId);
  await mkdir(caseDirectory, { recursive: true });
  const images: Array<[string, RawImage | undefined]> = [
    ["01-source-face.png", artifacts.sourceFace],
    ["01b-source-head.png", artifacts.sourceHead],
    ["02-generated-sheet-face.png", artifacts.generatedSheetFace],
    ["03-packed-head-before-identity.png", artifacts.packedHeadBefore],
    ["04a-old-face-pixel-plan.png", artifacts.oldFacePixelPlan ? renderFacePixelPlan(artifacts.oldFacePixelPlan) : undefined],
    ["04-face-pixel-plan.png", renderFacePixelPlan(artifacts.facePixelPlan)],
    ["05-candidate-a.png", artifacts.candidateA],
    ["06-candidate-b.png", artifacts.candidateB],
    ["06b-candidate-c.png", artifacts.candidateC],
    ["07-final-head-front.png", artifacts.finalHeadFront],
    ["08-final-head-left.png", artifacts.finalHeadLeft],
    ["09-final-head-right.png", artifacts.finalHeadRight],
    ["10-final-skin.png", artifacts.finalSkin],
  ];
  await Promise.all(images.flatMap(([name, image]) => image ? [encodePng(image).then((bytes) => writeFile(join(caseDirectory, name), bytes))] : []));
  await Promise.all([
    writeFile(join(caseDirectory, "critique.json"), JSON.stringify(artifacts.critique, null, 2), "utf8"),
    writeFile(join(caseDirectory, "metrics.json"), JSON.stringify(artifacts.metrics, null, 2), "utf8"),
  ]);
  return caseDirectory;
}
