/**
 * Opt-in live regression over openly licensed real photographs.
 *
 * Run with RUN_LIVE_GEMINI_EVAL=1 and GEMINI_API_KEY set. Photos are fetched
 * into memory from Wikimedia Commons and are never written to the repository.
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPhotoAnalysis } from "../src/analysis";
import { generateSkin } from "../src/generate";
import { bytesToBase64, decodePng, encodePng } from "../src/png";
import { runSkinCritique } from "../src/skinCritique";
import { buildSkinViewMontage, renderSkinViews } from "../src/skinRender";
import type { Env } from "../src/types";

const LIVE = process.env.RUN_LIVE_GEMINI_EVAL === "1";
const FULL_LIVE = process.env.RUN_LIVE_GEMINI_FULL === "1";
const PROCEDURAL_QA = process.env.RUN_LIVE_GEMINI_PROCEDURAL_QA === "1";
const LIVE_DEBUG = process.env.LIVE_GEMINI_DEBUG === "1";
const LIVE_ARTIFACT_DIR = process.env.LIVE_GEMINI_ARTIFACT_DIR;
const LIVE_VISION_MODEL =
  process.env.LIVE_GEMINI_VISION_MODEL?.trim() || "gemini-3.6-flash";
const LIVE_FALLBACK_MODEL =
  process.env.LIVE_GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.1-flash-lite";
const LIVE_STRUCTURED_TIMEOUT_MS =
  process.env.LIVE_GEMINI_STRUCTURED_TIMEOUT_MS?.trim() || "45000";
const LIVE_IMAGE_TIMEOUT_MS =
  process.env.LIVE_GEMINI_IMAGE_TIMEOUT_MS?.trim() || "120000";
const PROCEDURAL_QA_CASE_FILTER =
  process.env.LIVE_GEMINI_PROCEDURAL_CASES ?? "headscarf-color-blocks";

export const REAL_PHOTO_CASES = [
  {
    id: "long-straight-hair",
    file: "Portrait of a young long-haired woman.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Portrait_of_a_young_long-haired_woman.jpg",
    license: "CC BY 2.0",
    expectedCue: /long|chest|waist|shoulder/i,
  },
  {
    id: "short-hair-red-shirt",
    file: "Smiling Lao woman with short hair and red shirt.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Smiling_Lao_woman_with_short_hair_and_red_shirt.jpg",
    license: "CC BY-SA 4.0",
    expectedCue: /short|cropped|ear|red/i,
  },
  {
    id: "curly-hair",
    file: "Smiling senior woman with curly hair portrait.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Smiling_senior_woman_with_curly_hair_portrait.jpg",
    license: "CC BY 2.0",
    expectedCue: /curly|curl|wavy|volume/i,
  },
  {
    id: "headscarf-color-blocks",
    file: "ASC Leiden - van de Bruinhorst Collection - Somaliland 2019 - 4470 - A portrait of Nasiim Mohomed Ali Aar, author of the novel Between Love, Past and Destiny, with a blue and pink headscarf in Xarunta Dhaqanka ee Hargeysa.jpg",
    page: "https://commons.wikimedia.org/wiki/File:ASC_Leiden_-_van_de_Bruinhorst_Collection_-_Somaliland_2019_-_4470_-_A_portrait_of_Nasiim_Mohomed_Ali_Aar,_author_of_the_novel_Between_Love,_Past_and_Destiny,_with_a_blue_and_pink_headscarf_in_Xarunta_Dhaqanka_ee_Hargeysa.jpg",
    license: "CC BY-SA 4.0",
    expectedCue: /scarf|headscarf|blue|pink/i,
  },
  {
    id: "glasses-monochrome",
    file: "Black and white self-portrait with coke bottle glasses.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Black_and_white_self-portrait_with_coke_bottle_glasses.jpg",
    license: "CC BY-SA 2.0",
    expectedCue: /glass|frame|spectacle/i,
  },
  {
    id: "short-hair-formal",
    file: "Neil Patrick Harris (9449178210) (cropped portrait).jpg",
    page: "https://commons.wikimedia.org/wiki/File:Neil_Patrick_Harris_(9449178210)_(cropped_portrait).jpg",
    license: "CC BY 2.0",
    expectedCue: /short|cropped|swept|formal|jacket|shirt/i,
  },
] as const;

const PROCEDURAL_QA_CASES =
  PROCEDURAL_QA_CASE_FILTER.trim().toLowerCase() === "all"
    ? [...REAL_PHOTO_CASES]
    : REAL_PHOTO_CASES.filter((photo) =>
        PROCEDURAL_QA_CASE_FILTER.split(",")
          .map((id) => id.trim())
          .includes(photo.id),
      );

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function fetchCommonsPhoto(file: string): Promise<string> {
  const url = `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(file)}?width=896`;
  const response = await fetch(url, {
    headers: { "User-Agent": "mc-skin-creator-regression/1.0" },
  });
  if (!response.ok) throw new Error(`Commons HTTP ${response.status}`);
  const mime =
    response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

describe.skipIf(!LIVE)("live diverse real-photo Gemini analysis", () => {
  for (const photo of REAL_PHOTO_CASES) {
    it(`${photo.id} yields a salient canonical identity`, async () => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY is required");
      const dataUrl = await fetchCommonsPhoto(photo.file);
      const result = await runPhotoAnalysis(
        {
          GEMINI_API_KEY: key,
          VISION_MODEL: "gemini-3.6-flash",
          VISION_FALLBACK_MODEL: "gemini-3.6-flash",
        } as Env,
        dataUrl,
      );
      expect(result.ok, result.ok ? undefined : result.detail).toBe(true);
      if (!result.ok) return;
      expect(result.analysis.quality).not.toBe("fail");
      expect(
        result.analysis.canonicalIdentity.mustPreserve.length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        result.analysis.canonicalIdentity.features.length,
      ).toBeGreaterThanOrEqual(4);
      expect(
        result.analysis.canonicalIdentity.features[0].priority,
      ).toBeGreaterThanOrEqual(4);
      expect(
        result.analysis.canonicalIdentity.features.every(
          (feature) => feature.targetRegions.length > 0,
        ),
      ).toBe(true);
      const evidence = [
        result.analysis.observed.hair,
        result.analysis.observed.accessories,
        result.analysis.observed.clothing,
        ...result.analysis.canonicalIdentity.mustPreserve,
      ].join(" ");
      expect(evidence).toMatch(photo.expectedCue);
    }, 120_000);
  }
});

describe.skipIf(!FULL_LIVE)("live end-to-end Gemini skin generation", () => {
  it("runs a real photo through image generation, UV packing, six-view render and critique", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required");
    const source = REAL_PHOTO_CASES.find(
      (photo) => photo.id === "headscarf-color-blocks",
    )!;
    const dataUrl = await fetchCommonsPhoto(source.file);
    const result = await generateSkin(
      {
        GEMINI_API_KEY: key,
        // Keep the full-path smoke independent from the 3.6 model's much
        // smaller free daily request bucket used by the six-case analysis.
        VISION_MODEL: LIVE_VISION_MODEL,
        VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
        GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
        GEMINI_IMAGE_TIMEOUT_MS: LIVE_IMAGE_TIMEOUT_MS,
        GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
        GEMINI_IMAGE_QUALITY_MODEL: "gemini-3.1-flash-image",
        IMAGE_GENERATION_ENABLED: "true",
        IMAGE_GEN_STRATEGY: "four_view",
        IMAGE_MODEL_TIER: "quality",
        IMAGE_CRITIQUE_ENABLED: "true",
        MCSKIN_KV: {
          put: async () => undefined,
        } as unknown as KVNamespace,
      },
      dataUrl,
    );
    expect(result.success, result.body.error).toBe(true);
    expect(result.body.generationMode).toBe("image");
    expect(result.body.skinPngBase64?.length).toBeGreaterThan(1_000);
  }, 300_000);
});

describe.skipIf(!PROCEDURAL_QA)(
  "live real-photo procedural fallback quality",
  () => {
    if (PROCEDURAL_QA_CASES.length === 0) {
      it("selects at least one known procedural QA case", () => {
        throw new Error(
          `No real-photo case matched LIVE_GEMINI_PROCEDURAL_CASES=${PROCEDURAL_QA_CASE_FILTER}`,
        );
      });
    }

    for (const source of PROCEDURAL_QA_CASES) {
      it(`${source.id} renders and passes strict six-view Gemini critique`, async () => {
        const key = process.env.GEMINI_API_KEY;
        if (!key) throw new Error("GEMINI_API_KEY is required");
        const dataUrl = await fetchCommonsPhoto(source.file);
        const analysisResult = await runPhotoAnalysis(
          {
            GEMINI_API_KEY: key,
            VISION_MODEL: LIVE_VISION_MODEL,
            VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
            GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
          } as Env,
          dataUrl,
        );
        expect(
          analysisResult.ok,
          analysisResult.ok ? undefined : analysisResult.detail,
        ).toBe(true);
        if (!analysisResult.ok) return;
        if (LIVE_DEBUG) {
          console.log(
            `${source.id} analysis`,
            JSON.stringify(
              {
                observed: analysisResult.analysis.observed,
                canonicalIdentity: analysisResult.analysis.canonicalIdentity,
                identityPrompt: analysisResult.analysis.identityPrompt,
                renderHints: analysisResult.analysis.renderHints,
                fallbackFeatures: analysisResult.analysis.fallbackFeatures,
              },
              null,
              2,
            ),
          );
        }

        const generation = await generateSkin(
          {
            GEMINI_API_KEY: key,
            VISION_MODEL: LIVE_VISION_MODEL,
            VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
            GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
            MCSKIN_KV: {
              put: async () => undefined,
            } as unknown as KVNamespace,
            IMAGE_GENERATION_ENABLED: "false",
          },
          dataUrl,
        );
        expect(generation.success).toBe(true);
        const atlasBytes = Uint8Array.from(
          atob(generation.body.skinPngBase64!),
          (value) => value.charCodeAt(0),
        );
        const atlas = await decodePng(atlasBytes);
        const montage = buildSkinViewMontage(renderSkinViews(atlas));
        const montageBytes = await encodePng(montage);
        const montageDataUrl = `data:image/png;base64,${bytesToBase64(montageBytes)}`;
        if (LIVE_ARTIFACT_DIR) {
          await mkdir(LIVE_ARTIFACT_DIR, { recursive: true });
          await Promise.all([
            writeFile(
              join(LIVE_ARTIFACT_DIR, `${source.id}-skin.png`),
              atlasBytes,
            ),
            writeFile(
              join(LIVE_ARTIFACT_DIR, `${source.id}-six-view.png`),
              montageBytes,
            ),
            writeFile(
              join(LIVE_ARTIFACT_DIR, `${source.id}-analysis.json`),
              JSON.stringify(
                {
                  primaryAnalysis: analysisResult.analysis,
                  generationAnalysis: generation.body.analysis,
                },
                null,
                2,
              ),
              "utf8",
            ),
          ]);
        }
        const critique = await runSkinCritique(
          {
            GEMINI_API_KEY: key,
            VISION_MODEL: LIVE_VISION_MODEL,
            VISION_FALLBACK_MODEL: LIVE_FALLBACK_MODEL,
            GEMINI_STRUCTURED_TIMEOUT_MS: LIVE_STRUCTURED_TIMEOUT_MS,
          } as Env,
          analysisResult.analysis,
          [dataUrl],
          montageDataUrl,
          generation.body.analysis?.skinPlan,
          atlas,
        );
        expect(critique.ok, critique.ok ? undefined : critique.detail).toBe(
          true,
        );
        if (!critique.ok) return;
        expect(critique.approved, JSON.stringify(critique.critique)).toBe(true);
      }, 300_000);
    }
  },
);
