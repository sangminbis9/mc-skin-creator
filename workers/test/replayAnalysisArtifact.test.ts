import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import {
  buildFaceStyle,
  buildProceduralFallbackAtlas,
  fallbackFeaturesToHex,
  normalizeAnalysisForRendering,
  refineFeatureColorsFromAnalysis,
} from "../src/generate";
import { bytesToBase64, encodePng } from "../src/png";
import { applyProceduralCritiqueCorrections } from "../src/proceduralCorrection";
import { runSkinCritique, type SkinCritique } from "../src/skinCritique";
import { buildSkinPlan } from "../src/skinPlan";
import {
  buildSkinViewMontage,
  inspectRenderedSkin,
  renderSkinViews,
} from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";

const INPUT = process.env.REPLAY_ANALYSIS_JSON;
const OUTPUT = process.env.REPLAY_ARTIFACT_DIR;
const SOURCE_IMAGE = process.env.REPLAY_SOURCE_IMAGE;
const SOURCE_IMAGES_JSON = process.env.REPLAY_SOURCE_IMAGES_JSON;
const OFFLINE_CRITIQUE = process.env.REPLAY_CRITIQUE_JSON;
const REQUIRE_APPROVAL = process.env.REPLAY_REQUIRE_APPROVAL === "1";
const HAIR_LENGTH_OVERRIDE = process.env.REPLAY_HAIR_LENGTH_OVERRIDE?.trim();

const HAIR_LENGTHS = [
  "cropped",
  "ear",
  "jaw",
  "shoulder",
  "chest",
  "waist",
  "hip",
] as const;

interface SavedAnalysisDocument {
  primaryAnalysis?: PhotoAnalysis;
  generationAnalysis?: Partial<PhotoAnalysis>;
  analysis?: Omit<
    PhotoAnalysis,
    | "quality"
    | "failReason"
    | "identityPrompt"
    | "outfitPrompt"
    | "negativePrompt"
    | "fallbackFeatures"
  >;
  features?: PhotoAnalysis["fallbackFeatures"];
}

function hasHexFeaturePalette(
  features: PhotoAnalysis["fallbackFeatures"] | undefined,
): features is PhotoAnalysis["fallbackFeatures"] & Record<string, string> {
  return Boolean(
    features &&
    typeof features.skinTone === "string" &&
    features.skinTone.startsWith("#"),
  );
}

describe.skipIf(!INPUT || !OUTPUT)("saved-analysis visual replay", () => {
  it("renders the current deterministic atlas and six-view montage", async () => {
    const document = JSON.parse(
      await readFile(INPUT as string, "utf8"),
    ) as SavedAnalysisDocument;
    const source = document.primaryAnalysis
      ? ({
          ...document.primaryAnalysis,
          ...document.generationAnalysis,
          fallbackFeatures: document.primaryAnalysis.fallbackFeatures,
          identityPrompt: document.primaryAnalysis.identityPrompt,
          outfitPrompt: document.primaryAnalysis.outfitPrompt,
          negativePrompt: document.primaryAnalysis.negativePrompt,
        } satisfies PhotoAnalysis)
      : document.analysis && document.features
        ? ({
            ...document.analysis,
            quality: "pass",
            failReason: null,
            identityPrompt: [
              document.analysis.canonicalIdentity.overallImpression,
              document.analysis.observed.face,
              document.analysis.observed.hair,
            ].join("; "),
            outfitPrompt: [
              document.analysis.observed.clothing,
              document.analysis.observed.accessories,
            ].join("; "),
            negativePrompt: "",
            fallbackFeatures: document.features,
          } satisfies PhotoAnalysis)
        : undefined;
    expect(source).toBeDefined();
    if (!source) return;

    const analysis = normalizeAnalysisForRendering(source);
    if (HAIR_LENGTH_OVERRIDE) {
      expect(HAIR_LENGTHS).toContain(
        HAIR_LENGTH_OVERRIDE as (typeof HAIR_LENGTHS)[number],
      );
      const hairLength = HAIR_LENGTH_OVERRIDE as
        PhotoAnalysis["renderHints"]["overallHairLength"] | undefined;
      if (hairLength) {
        analysis.renderHints.overallHairLength = hairLength;
        analysis.renderHints.sideHairLength =
          hairLength === "cropped" || hairLength === "ear"
            ? "short"
            : hairLength === "jaw"
              ? "jaw"
              : "shoulder";
      }
    }
    const features = refineFeatureColorsFromAnalysis(
      analysis,
      hasHexFeaturePalette(document.features)
        ? document.features
        : fallbackFeaturesToHex(
            analysis.fallbackFeatures,
            analysis.renderHints.skinUndertone,
          ),
    );
    const style = buildFaceStyle(analysis, features);
    const stem = basename(INPUT as string).replace(/-analysis\.json$/i, "");
    await mkdir(OUTPUT as string, { recursive: true });
    await writeFile(
      join(OUTPUT as string, `${stem}-normalized.json`),
      JSON.stringify({ analysis, features, style }, null, 2),
      "utf8",
    );
    const atlas = buildProceduralFallbackAtlas(features, style);
    expect(atlas).not.toBeNull();
    if (!atlas) return;

    expect(validateFinalAtlas(atlas).ok).toBe(true);
    const views = renderSkinViews(atlas);
    expect(inspectRenderedSkin(views).ok).toBe(true);
    const montage = buildSkinViewMontage(views);
    const atlasBytes = await encodePng(atlas);
    const montageBytes = await encodePng(montage);
    await Promise.all([
      writeFile(join(OUTPUT as string, `${stem}-skin.png`), atlasBytes),
      writeFile(join(OUTPUT as string, `${stem}-six-view.png`), montageBytes),
    ]);

    if (OFFLINE_CRITIQUE) {
      const offlineCritique = JSON.parse(OFFLINE_CRITIQUE) as SkinCritique;
      const correction = applyProceduralCritiqueCorrections(
        analysis,
        style,
        offlineCritique,
      );
      expect(correction.applied.length).toBeGreaterThan(0);
      const correctedAtlas = buildProceduralFallbackAtlas(
        features,
        correction.style,
      );
      expect(correctedAtlas).not.toBeNull();
      if (!correctedAtlas) return;
      expect(validateFinalAtlas(correctedAtlas).ok).toBe(true);
      const correctedViews = renderSkinViews(correctedAtlas);
      expect(inspectRenderedSkin(correctedViews).ok).toBe(true);
      const correctedMontage = buildSkinViewMontage(correctedViews);
      await Promise.all([
        writeFile(
          join(OUTPUT as string, `${stem}-corrected-skin.png`),
          await encodePng(correctedAtlas),
        ),
        writeFile(
          join(OUTPUT as string, `${stem}-corrected-six-view.png`),
          await encodePng(correctedMontage),
        ),
        writeFile(
          join(OUTPUT as string, `${stem}-correction.json`),
          JSON.stringify(correction, null, 2),
          "utf8",
        ),
      ]);
    }

    const sourceImagePaths = SOURCE_IMAGES_JSON
      ? (JSON.parse(SOURCE_IMAGES_JSON) as unknown)
      : SOURCE_IMAGE
        ? [SOURCE_IMAGE]
        : [];
    expect(Array.isArray(sourceImagePaths)).toBe(true);
    if (Array.isArray(sourceImagePaths) && sourceImagePaths.length > 0) {
      expect(sourceImagePaths.every((value) => typeof value === "string")).toBe(
        true,
      );
      expect(sourceImagePaths.length).toBeLessThanOrEqual(5);
      const key = process.env.GEMINI_API_KEY;
      expect(
        key,
        "GEMINI_API_KEY is required for replay critique",
      ).toBeTruthy();
      if (!key) return;
      const sourceDataUrls = await Promise.all(
        sourceImagePaths.map(async (sourcePath) => {
          const sourceBytes = await readFile(sourcePath as string);
          const mime = /\.png$/i.test(sourcePath as string)
            ? "image/png"
            : "image/jpeg";
          return `data:${mime};base64,${bytesToBase64(sourceBytes)}`;
        }),
      );
      const critique = await runSkinCritique(
        {
          GEMINI_API_KEY: key,
          VISION_MODEL:
            process.env.LIVE_GEMINI_VISION_MODEL?.trim() || "gemini-3.6-flash",
          VISION_FALLBACK_MODEL:
            process.env.LIVE_GEMINI_FALLBACK_MODEL?.trim() ||
            "gemini-3.1-flash-lite",
          GEMINI_STRUCTURED_TIMEOUT_MS:
            process.env.LIVE_GEMINI_STRUCTURED_TIMEOUT_MS?.trim() || "90000",
        } as Env,
        analysis,
        sourceDataUrls,
        `data:image/png;base64,${bytesToBase64(montageBytes)}`,
        buildSkinPlan(analysis),
        atlas,
      );
      await writeFile(
        join(OUTPUT as string, `${stem}-critique.json`),
        JSON.stringify(critique, null, 2),
        "utf8",
      );
      expect(critique.ok, critique.ok ? undefined : critique.detail).toBe(true);
      if (critique.ok && REQUIRE_APPROVAL) {
        expect(critique.approved, JSON.stringify(critique.critique)).toBe(true);
      }
    }
  }, 120_000);
});
