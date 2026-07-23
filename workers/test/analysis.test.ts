import { describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_PROMPT,
  extractAnalysisPayload,
  NECK_DETAIL_PROMPT,
  PHOTO_ANALYSIS_SCHEMA,
  runNeckDetailAnalysis,
  runPhotoAnalysis,
  validatePhotoAnalysis,
} from "../src/analysis";
import type { Env } from "../src/types";
import { makeAnalysis } from "./helpers";

function makeVisionEnv(
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>,
): Env {
  return {
    VISION_MODEL: "primary-model",
    VISION_FALLBACK_MODEL: "fallback-model",
    AI: { run: vi.fn(run) } as unknown as Env["AI"],
  } as unknown as Env;
}

describe("runPhotoAnalysis", () => {
  it("uses the fallback model after both primary response formats fail", async () => {
    const run = vi.fn(async (model: string) => {
      if (model === "primary-model") {
        throw new Error("primary unavailable");
      }
      return { response: makeAnalysis() };
    });
    const env = makeVisionEnv(run);

    const result = await runPhotoAnalysis(env, "data:image/jpeg;base64,photo");

    expect(result.ok).toBe(true);
    expect(run.mock.calls.map(([model]) => model)).toEqual([
      "primary-model",
      "primary-model",
      "fallback-model",
    ]);
    expect(result).toMatchObject({ attempts: 3 });
  });

  it("falls back when the primary model emits invalid structured output", async () => {
    const run = vi.fn(async (model: string) =>
      model === "primary-model"
        ? { response: "not-json" }
        : { response: makeAnalysis() },
    );

    const result = await runPhotoAnalysis(
      makeVisionEnv(run),
      "data:image/jpeg;base64,photo",
    );

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not call the fallback model when the primary response is valid", async () => {
    const run = vi.fn(async () => ({ response: makeAnalysis() }));

    const result = await runPhotoAnalysis(
      makeVisionEnv(run),
      "data:image/jpeg;base64,photo",
    );

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "minecraft_skin_photo_analysis",
          schema: PHOTO_ANALYSIS_SCHEMA,
        },
      },
    });
    expect(result).toMatchObject({ attempts: 1 });
  });

  it("returns ai_error when both models throw", async () => {
    const run = vi.fn(async () => {
      throw new Error("provider unavailable");
    });

    const result = await runPhotoAnalysis(
      makeVisionEnv(run),
      "data:image/jpeg;base64,photo",
    );

    expect(result).toMatchObject({ ok: false, reason: "ai_error" });
    expect(run).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ attempts: 4 });
  });

  it("stops immediately when Workers AI reports the shared daily neuron limit", async () => {
    const run = vi.fn(async () => {
      throw new Error(
        "4006: you have used up your daily free allocation of 10,000 neurons",
      );
    });

    const result = await runPhotoAnalysis(
      makeVisionEnv(run),
      "data:image/jpeg;base64,photo",
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "quota_exceeded",
      attempts: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns invalid_response when neither model emits JSON", async () => {
    const run = vi.fn(async () => ({ response: "not-json" }));

    const result = await runPhotoAnalysis(
      makeVisionEnv(run),
      "data:image/jpeg;base64,photo",
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_response" });
    expect(run).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ attempts: 4 });
  });
});

describe("runNeckDetailAnalysis", () => {
  it("classifies throat fabric from the supplied upper-body crop", async () => {
    const run = vi.fn(async () => ({
      response: {
        neckAccessory: "bow",
        confidence: "high",
        evidence: "A central knot has two broad pointed hanging tails.",
      },
    }));
    const env = makeVisionEnv(run);

    const result = await runNeckDetailAnalysis(
      env,
      "data:image/png;base64,upper-body-crop",
    );

    expect(result).toEqual({
      ok: true,
      detail: {
        neckAccessory: "bow",
        confidence: "high",
        evidence: "A central knot has two broad pointed hanging tails.",
      },
      attempts: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      messages: [
        {
          content: [
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,upper-body-crop",
              },
            },
            { type: "text", text: NECK_DETAIL_PROMPT },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "minecraft_skin_neck_detail" },
      },
    });
  });

  it("distinguishes a dominant bow/scarf from short collar-only flaps", () => {
    expect(NECK_DETAIL_PROMPT).toContain("central knot");
    expect(NECK_DETAIL_PROMPT).toContain("paired loops");
    expect(NECK_DETAIL_PROMPT).toContain("long hanging tails");
    expect(NECK_DETAIL_PROMPT).toContain(
      "short paired shirt/lapel flaps",
    );
  });
});

describe("validatePhotoAnalysis", () => {
  it("accepts structured JSON from Workers AI native and chat-completions responses", () => {
    const analysis = makeAnalysis();
    expect(extractAnalysisPayload({ response: analysis })).toEqual(analysis);
    expect(
      extractAnalysisPayload({
        choices: [
          { message: { content: `result:\n${JSON.stringify(analysis)}` } },
        ],
      }),
    ).toEqual(analysis);
    expect(
      extractAnalysisPayload({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "```json\n" },
                { type: "text", text: JSON.stringify(analysis) },
                { type: "text", text: "\n```" },
              ],
            },
          },
        ],
      }),
    ).toEqual(analysis);
  });

  it("analysis prompt requires visible lower-body, legwear asymmetry and shoe details", () => {
    expect(ANALYSIS_PROMPT).toContain("lower garment type");
    expect(ANALYSIS_PROMPT).toContain(
      "legwear asymmetry from the viewer's perspective",
    );
    expect(ANALYSIS_PROMPT).toContain("shoe type/color");
    expect(ANALYSIS_PROMPT).toContain("viewer-left/viewer-right");
    expect(ANALYSIS_PROMPT).toContain("renderHints.bottomPattern");
    expect(ANALYSIS_PROMPT).toContain(
      "skorts, pleated shorts or skirt-like culottes",
    );
    expect(ANALYSIS_PROMPT).toContain(
      'never default to "pants" for a visible skirt, skort',
    );
    expect(ANALYSIS_PROMPT).toContain("knee-high or over-knee socks");
    expect(ANALYSIS_PROMPT).toContain(
      "Treat knee-high, over-knee and OTK socks as thigh_highs",
    );
    expect(ANALYSIS_PROMPT).toContain(
      'Do not summarize it as simply "asymmetric"',
    );
    expect(ANALYSIS_PROMPT).toContain('legwearAsymmetry "left" or "right"');
    expect(ANALYSIS_PROMPT).toContain("thighAccessorySide independently");
    expect(ANALYSIS_PROMPT).toContain(
      "a thigh accessory can intentionally sit on the opposite leg",
    );
    expect(ANALYSIS_PROMPT).toContain(
      "Never infer a thigh bow merely because the opposite leg has one-sided legwear",
    );
    expect(ANALYSIS_PROMPT).toContain(
      "Repeat both exact sides in outfitPrompt",
    );
    expect(ANALYSIS_PROMPT).toContain(
      "Never return the completely generic combination of plain pants + no accent + no legwear + sneakers",
    );
    expect(ANALYSIS_PROMPT).toContain("describe the shoe color/construction");
  });

  it("analysis prompt distinguishes fringe density and side-hair profile", () => {
    expect(ANALYSIS_PROMPT).toContain("bangsDensity");
    expect(ANALYSIS_PROMPT).toContain("fringeEdge");
    expect(ANALYSIS_PROMPT).toContain("fringeOpening");
    expect(ANALYSIS_PROMPT).toContain("independent from hairPart");
    expect(ANALYSIS_PROMPT).toContain("eyeSize");
    expect(ANALYSIS_PROMPT).toContain("actual eye opening");
    expect(ANALYSIS_PROMPT).toContain("lipFullness");
    expect(ANALYSIS_PROMPT).toContain("small full lips");
    expect(ANALYSIS_PROMPT).toContain("eyeTilt");
    expect(ANALYSIS_PROMPT).toContain("solid rectangular bar");
    expect(ANALYSIS_PROMPT).toContain("visible scalp/root direction");
    expect(ANALYSIS_PROMPT).toContain("crown and temple OUTER CONTOUR");
    expect(ANALYSIS_PROMPT).toContain(
      "A smooth dome over staggered bangs is rounded",
    );
    expect(ANALYSIS_PROMPT).toContain("overallHairLength");
    expect(ANALYSIS_PROMPT).toContain("chest-, waist- or hip-length hair");
    expect(ANALYSIS_PROMPT).toContain("belt/natural waist");
    expect(ANALYSIS_PROMPT).toContain(
      "longest clearly visible, substantial continuous locks",
    );
    expect(ANALYSIS_PROMPT).toContain("sideHairShape");
    expect(ANALYSIS_PROMPT).toContain("sideHairAsymmetry");
    expect(ANALYSIS_PROMPT).toContain(
      "not merely because head rotation hides one side",
    );
    expect(ANALYSIS_PROMPT).toContain("ear_hugging");
    expect(ANALYSIS_PROMPT).toContain("earExposure");
    expect(ANALYSIS_PROMPT).toContain("keep left/right profiles coherent");
    expect(ANALYSIS_PROMPT).toContain("hairAccessoryColor");
    expect(ANALYSIS_PROMPT).toContain("hairAccessoryScale");
    expect(ANALYSIS_PROMPT).toContain("multiple-flower cluster");
    expect(ANALYSIS_PROMPT).toContain("dominant petal color");
    expect(ANALYSIS_PROMPT).toContain("paired loops or broad pointed tails");
    expect(ANALYSIS_PROMPT).toContain("prominent white neck bow");
    expect(ANALYSIS_PROMPT).toContain(
      'Use "collar" only when the visible fabric consists of paired shirt/lapel flaps',
    );
    expect(ANALYSIS_PROMPT).toContain(
      "central knot with two long pointed fabric tails",
    );
    expect(ANALYSIS_PROMPT).toContain(
      '"waist" reaches the lower ribs, waistband or belt line',
    );
    expect(
      PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties.neckAccessory
        .description,
    ).toContain("central knot");
    expect(
      PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties.overallHairLength
        .description,
    ).toContain("waist reaches");
  });

  it("유효한 분석은 통과한다", () => {
    const result = validatePhotoAnalysis(makeAnalysis());
    expect(result.ok).toBe(true);
  });

  it("얼굴만 보이는 사진(framing=face)도 품질 실패로 처리되지 않는다", () => {
    const result = validatePhotoAnalysis(
      makeAnalysis({
        framing: "face",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: false,
          lowerBody: false,
          feet: false,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.quality).toBe("pass");
      expect(result.analysis.framing).toBe("face");
    }
  });

  it("quality=fail이면 나머지 필드가 없어도 실패 사유와 함께 통과한다", () => {
    const result = validatePhotoAnalysis({
      quality: "fail",
      failReason: "no_face",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.quality).toBe("fail");
      expect(result.analysis.failReason).toBe("no_face");
    }
  });

  it("허용되지 않은 framing은 명시적 오류로 반환한다 (조용한 기본값 대체 없음)", () => {
    const result = validatePhotoAnalysis(
      makeAnalysis({ framing: "selfie" as never }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("framing");
    }
  });

  it("identityPrompt가 비어 있으면 오류다", () => {
    const result = validatePhotoAnalysis(makeAnalysis({ identityPrompt: "" }));
    expect(result.ok).toBe(false);
  });

  it("inferred 항목의 구조가 틀리면 오류를 수집한다", () => {
    const broken = makeAnalysis();
    (broken.inferred as Record<string, unknown>).hairBack = "short";
    const result = validatePhotoAnalysis(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("hairBack");
    }
  });

  it("저해상도 렌더 힌트의 허용값을 검증한다", () => {
    const broken = makeAnalysis();
    broken.renderHints.eyebrowShape = "zigzag" as never;
    broken.renderHints.noseShape = "triangle" as never;
    broken.renderHints.mouthShape = "square" as never;
    broken.renderHints.jawShape = "blocky" as never;
    broken.renderHints.bangs = "generic" as never;
    broken.renderHints.bangsLength = "forehead" as never;
    broken.renderHints.bangsDensity = "solid_block" as never;
    broken.renderHints.fringeEdge = "square" as never;
    broken.renderHints.fringeOpening = "random" as never;
    broken.renderHints.eyeTilt = "diagonal" as never;
    broken.renderHints.hairSilhouette = "generic" as never;
    broken.renderHints.hairBackShape = "generic" as never;
    broken.renderHints.sideHairShape = "random" as never;
    broken.renderHints.sideHairAsymmetry = "both" as never;
    broken.renderHints.hairAccessoryColor = "cyan" as never;
    broken.renderHints.earExposure = "unknown" as never;
    const result = validatePhotoAnalysis(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("renderHints.eyebrowShape");
      expect(result.errors.join()).toContain("renderHints.noseShape");
      expect(result.errors.join()).toContain("renderHints.mouthShape");
      expect(result.errors.join()).toContain("renderHints.jawShape");
      expect(result.errors.join()).toContain("renderHints.bangs");
      expect(result.errors.join()).toContain("renderHints.bangsLength");
      expect(result.errors.join()).toContain("renderHints.bangsDensity");
      expect(result.errors.join()).toContain("renderHints.fringeEdge");
      expect(result.errors.join()).toContain("renderHints.fringeOpening");
      expect(result.errors.join()).toContain("renderHints.eyeTilt");
      expect(result.errors.join()).toContain("renderHints.hairSilhouette");
      expect(result.errors.join()).toContain("renderHints.hairBackShape");
      expect(result.errors.join()).toContain("renderHints.sideHairShape");
      expect(result.errors.join()).toContain("renderHints.sideHairAsymmetry");
      expect(result.errors.join()).toContain("renderHints.hairAccessoryColor");
      expect(result.errors.join()).toContain("renderHints.earExposure");
    }
  });

  it("객체가 아닌 응답은 즉시 실패한다", () => {
    expect(validatePhotoAnalysis("json이 아님").ok).toBe(false);
    expect(validatePhotoAnalysis(null).ok).toBe(false);
    expect(validatePhotoAnalysis([1, 2]).ok).toBe(false);
  });
});
