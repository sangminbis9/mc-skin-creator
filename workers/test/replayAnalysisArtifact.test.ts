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
const OFFLINE_CRITIQUE = process.env.REPLAY_CRITIQUE_JSON;
const REQUIRE_APPROVAL = process.env.REPLAY_REQUIRE_APPROVAL === "1";

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
    const features = refineFeatureColorsFromAnalysis(
      analysis,
      fallbackFeaturesToHex(
        analysis.fallbackFeatures,
        analysis.renderHints.skinUndertone,
      ),
    );
    const style = buildFaceStyle(analysis, features);
    const atlas = buildProceduralFallbackAtlas(features, style);
    expect(atlas).not.toBeNull();
    if (!atlas) return;

    expect(validateFinalAtlas(atlas).ok).toBe(true);
    const views = renderSkinViews(atlas);
    expect(inspectRenderedSkin(views).ok).toBe(true);
    const montage = buildSkinViewMontage(views);
    const stem = basename(INPUT as string).replace(/-analysis\.json$/i, "");
    await mkdir(OUTPUT as string, { recursive: true });
    const atlasBytes = await encodePng(atlas);
    const montageBytes = await encodePng(montage);
    await Promise.all([
      writeFile(join(OUTPUT as string, `${stem}-skin.png`), atlasBytes),
      writeFile(
        join(OUTPUT as string, `${stem}-six-view.png`),
        montageBytes,
      ),
      writeFile(
        join(OUTPUT as string, `${stem}-normalized.json`),
        JSON.stringify({ analysis, features, style }, null, 2),
        "utf8",
      ),
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

    if (SOURCE_IMAGE) {
      const key = process.env.GEMINI_API_KEY;
      expect(key, "GEMINI_API_KEY is required for replay critique").toBeTruthy();
      if (!key) return;
      const sourceBytes = await readFile(SOURCE_IMAGE);
      const mime = /\.png$/i.test(SOURCE_IMAGE) ? "image/png" : "image/jpeg";
      const critique = await runSkinCritique(
        {
          GEMINI_API_KEY: key,
          VISION_MODEL:
            process.env.LIVE_GEMINI_VISION_MODEL?.trim() ||
            "gemini-3.6-flash",
          VISION_FALLBACK_MODEL:
            process.env.LIVE_GEMINI_FALLBACK_MODEL?.trim() ||
            "gemini-3.1-flash-lite",
          GEMINI_STRUCTURED_TIMEOUT_MS:
            process.env.LIVE_GEMINI_STRUCTURED_TIMEOUT_MS?.trim() || "90000",
        } as Env,
        analysis,
        [`data:${mime};base64,${bytesToBase64(sourceBytes)}`],
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
  });
});
