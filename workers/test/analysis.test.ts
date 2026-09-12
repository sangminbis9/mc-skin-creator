import { afterEach, describe, expect, it, vi } from "vitest";
import { wireFixture } from "./compactV3Support";
import { COMPACT_FACE_ORDER, COMPACT_HINT_GROUPS, COMPACT_PHOTO_ANALYSIS_V2_SCHEMA } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import {
  GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,
  GEMMA_VISION_MODEL,
} from "../src/gemmaPhotoAnalysis";
import {
  ANALYSIS_PROMPT,
  analysisPayloadDiagnostic,
  extractAnalysisPayload,
  NECK_DETAIL_PROMPT,
  PORTRAIT_DETAIL_PROMPT,
  PHOTO_ANALYSIS_SCHEMA,
  runNeckDetailAnalysis,
  runPortraitDetailAnalysis,
  runPhotoAnalysis,
  validatePhotoAnalysis,
  validatePortraitRegion,
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

function namedWorkerFixture(compact = wireFixture(makeAnalysis())) {
  return {
    ...compact,
    renderHints: Object.fromEntries(
      Object.entries(COMPACT_HINT_GROUPS).map(([group, fields]) => [
        group,
        Object.fromEntries(fields.map((field, index) => [
          field,
          compact.renderHints[group as keyof typeof compact.renderHints][index],
        ])),
      ]),
    ),
  };
}

describe("runPhotoAnalysis: strict Compact v3 production boundary", () => {
  const photo = "data:image/jpeg;base64,/9j/";
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const response = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
  function envForFallback(run = vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify(namedWorkerFixture()) } }],
  }))) {
    return { GEMINI_API_KEY: "test-key", AI: { run }, MCSKIN_KV: {} } as unknown as Env;
  }
  it("uses current schema, strict validation and rich normalization through the shared 3.8 envelope", async () => {
    const fetchMock = vi.fn(async () => response(wireFixture(makeAnalysis())));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runPhotoAnalysis(envForFallback(), photo);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    if (result.ok) expect(validatePhotoAnalysis(result.analysis).ok).toBe(true);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.responseJsonSchema).toEqual(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
    expect(body.generationConfig).not.toHaveProperty("temperature");
    expect(body.contents[0].parts.at(-1).text).toContain("COMPACT WIRE CONTRACT v3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([503, 429, 404])("falls back once to a real Workers AI provider after %i", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { status: "UNAVAILABLE" } }, { status })));
    const env = envForFallback();
    const result = await runPhotoAnalysis(env, photo);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(env.AI!.run).toHaveBeenCalledExactlyOnceWith(GEMMA_VISION_MODEL,
      expect.objectContaining({
        messages: expect.any(Array),
        max_completion_tokens: 8192,
        chat_template_kwargs: { enable_thinking: false },
      }));
    const workersInput = (env.AI!.run as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA).toBeDefined();
    expect(workersInput).not.toHaveProperty("guided_json");
    expect(workersInput).toHaveProperty("messages");
    expect(workersInput).toHaveProperty("response_format.json_schema.schema", GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
    expect(result.providerAttempts?.filter(item => item.outcome === "started").map(item => item.provider)).toEqual(["gemini", "workers_ai"]);
    expect(result.providerAttempts?.find(item => item.provider === "workers_ai" && item.outcome === "started"))
      .toMatchObject({ responseFormatMode: "workers_named_json_schema_strict" });
    expect(result.providerAttempts?.find(item => item.provider === "workers_ai" && item.outcome === "completed"))
      .toMatchObject({ providerSchemaValidation: "passed", strictValidation: "passed" });
  });
  it("never retries or switches provider for schema/config 400", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: {
      message: "Malformed response schema",
      status: "INVALID_ARGUMENT",
    } }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = envForFallback();
    const result = await runPhotoAnalysis(env, photo);
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(result.providerAttempts?.find(item => item.provider === "gemini" && item.outcome === "failed"))
      .toMatchObject({ status: 400, providerStatus: "INVALID_ARGUMENT", message: "Malformed response schema",
        fallbackEligible: false, fallbackReason: "invalid_argument" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.AI!.run).not.toHaveBeenCalled();
  });
  it("fails over exactly once when Gemini reports FAILED_PRECONDITION", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: {
      message: "A provider project prerequisite is not met",
      status: "FAILED_PRECONDITION",
    } }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = envForFallback();
    const result = await runPhotoAnalysis(env, photo);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
    expect(result.providerAttempts?.map(item => `${item.provider}:${item.outcome}`)).toEqual([
      "gemini:started", "gemini:failed", "workers_ai:started", "workers_ai:completed",
    ]);
    expect(result.providerAttempts?.find(item => item.provider === "gemini" && item.outcome === "failed"))
      .toMatchObject({ status: 400, providerStatus: "FAILED_PRECONDITION",
        message: "A provider project prerequisite is not met",
        fallbackEligible: true, fallbackReason: "provider_failed_precondition" });
    expect(result.providerAttempts?.find(item => item.provider === "workers_ai" && item.outcome === "completed"))
      .toMatchObject({ providerSchemaValidation: "passed", strictValidation: "passed" });
  });
  it("adapts one strict Gemma named response after Gemini FAILED_PRECONDITION", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {
      message: "A provider project prerequisite is not met",
      status: "FAILED_PRECONDITION",
    } }, { status: 400 })));
    const run = vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify(namedWorkerFixture()) } }],
    }));
    const env = envForFallback(run);
    env.WORKERS_VISION_MODEL = GEMMA_VISION_MODEL;
    const result = await runPhotoAnalysis(env, photo);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(GEMMA_VISION_MODEL);
    const input = run.mock.calls[0][1] as Record<string, unknown>;
    expect(input).toMatchObject({
      max_completion_tokens: 8192,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: {
        name: "minecraft_skin_photo_analysis",
        schema: GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,
        strict: true,
      } },
    });
    const messages = input.messages as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(messages[0]?.content.find((part) => part.type === "text")?.text)
      .toContain(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT);
    expect(result.providerAttempts?.find(item => item.provider === "workers_ai" && item.outcome === "started"))
      .toMatchObject({ model: GEMMA_VISION_MODEL, responseFormatMode: "workers_named_json_schema_strict" });
    expect(result.providerAttempts?.find(item => item.provider === "workers_ai" && item.outcome === "completed"))
      .toMatchObject({ providerSchemaValidation: "passed", strictValidation: "passed" });
  });
  it("bounds a stalled response body and still uses one fallback", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
    const pending = runPhotoAnalysis({ ...envForFallback(), GEMINI_STRUCTURED_TIMEOUT_MS: "10" }, photo);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ ok: true, attempts: 2 });
  });
  it("uses one fallback for a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await runPhotoAnalysis(envForFallback(), photo)).toMatchObject({ ok: true, attempts: 2 });
  });
  it("does not repair or retry invalid measurement vocabulary from either provider", async () => {
    const raw = wireFixture(makeAnalysis());
    raw.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown", provenance: "unknown", confidence: 0 }));
    raw.faceMeasurements[0] = { value: "average", provenance: "observed_categorical", confidence: 0.9 } as never;
    vi.stubGlobal("fetch", vi.fn(async () => response(raw)));
    const env = envForFallback();
    const result = await runPhotoAnalysis(env, photo);
    expect(result).toMatchObject({ ok: false, reason: "invalid_response", attempts: 1 });
    if (!result.ok) expect(result.detail).toContain("compact.faceMeasurements[0].value:enum");
    expect(env.AI!.run).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 })));
    const fallback = envForFallback(vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify(namedWorkerFixture(raw)) } }],
    })));
    expect(await runPhotoAnalysis(fallback, photo)).toMatchObject({ ok: false, reason: "invalid_response", attempts: 2 });
  });
  it("records only shape metadata when Llama returns non-JSON prose", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 })));
    const env = envForFallback(vi.fn(async () => ({
      response: "This is prose without a structured object.",
      usage: { prompt_tokens: 100, completion_tokens: 9 },
    })));
    const result = await runPhotoAnalysis(env, photo);
    expect(result).toMatchObject({ ok: false, reason: "invalid_response" });
    const diagnostic = result.providerAttempts?.find(item => item.provider === "workers_ai"
      && item.outcome === "completed")?.outputDiagnostic;
    expect(diagnostic).toMatchObject({
      resultType: "object", resultNull: false, resultArray: false,
      topLevelKeys: ["response", "usage"], responsePresent: true,
      responseType: "string", responseArray: false, responseObjectKeys: [],
      responseString: { characterLength: 42, trimmedLength: 42,
        startsWithObject: false, startsWithArray: false,
        containsOpenBrace: false, containsCloseBrace: false,
        fencedJson: false, extractJsonSucceeded: false },
      choicesPresent: false, choicesType: "undefined",
      extractedType: "null", extractedNull: true, extractedObjectKeys: [],
    });
    expect(JSON.stringify(diagnostic)).not.toContain("This is prose");
  });
  it("rejects missing evidence from Workers instead of padding a live-like incomplete response", async () => {
    const raw = wireFixture(makeAnalysis());
    raw.faceMeasurements = COMPACT_FACE_ORDER.map(() => ({ value: "unknown" })) as never;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 401 })));
    const env = envForFallback(vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify(namedWorkerFixture(raw)) } }],
    })));
    const result = await runPhotoAnalysis(env, photo);
    expect(result).toMatchObject({ ok: false, reason: "invalid_response", attempts: 2 });
    if (!result.ok) expect(result.detail).toContain("gemma.faceMeasurements[0].provenance:required");
    expect(result.providerAttempts?.find(item => item.provider === "workers_ai" && item.outcome === "completed"))
      .toMatchObject({ providerSchemaValidation: "failed", strictValidation: "failed" });
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
  });
  it("rejects unavailable source indices instead of clamping them", async () => {
    const raw = wireFixture(makeAnalysis());
    raw.sourceSelection.portraitImageIndex = 4;
    vi.stubGlobal("fetch", vi.fn(async () => response(raw)));
    expect(await runPhotoAnalysis(envForFallback(), photo)).toMatchObject({ ok: false, reason: "invalid_response", attempts: 1 });
  });
  it("retains valid multi-photo roles", async () => {
    const raw = wireFixture(makeAnalysis());
    raw.sourceSelection.portraitImageIndex = 1;
    vi.stubGlobal("fetch", vi.fn(async () => response(raw)));
    const result = await runPhotoAnalysis(envForFallback(), [photo, photo]);
    expect(result).toMatchObject({ ok: true, analysis: { sourceSelection: { portraitImageIndex: 1 } } });
  });
  it.each(["4006: daily free allocation of neurons used up", "3036: account limited"])("stops after actual Workers quota: %s", async message => {
    const env = envForFallback(vi.fn(async () => { throw new Error(message); }));
    delete env.GEMINI_API_KEY;
    expect(await runPhotoAnalysis(env, photo)).toMatchObject({ ok: false, reason: "quota_exceeded", attempts: 1 });
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
  });
  it("preserves usage accounting", async () => {
    const env = envForFallback(vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify(namedWorkerFixture()) } }],
      usage: { prompt_tokens: 10000, completion_tokens: 2000 },
    })));
    delete env.GEMINI_API_KEY;
    expect(await runPhotoAnalysis(env, photo)).toMatchObject({ ok: true, neuronsSpent: 400 });
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
      neuronsSpent: 100,
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
    expect(NECK_DETAIL_PROMPT).toContain("short paired shirt/lapel flaps");
  });
});

describe("runPortraitDetailAnalysis", () => {
  it("re-checks face and crown-to-side hair from the supplied crop", async () => {
    const detail = {
      faceConfidence: "high",
      hairConfidence: "high",
      crownConfidence: "high",
      fringeConfidence: "high",
      sideHairConfidence: "high",
      hairEndpointConfidence: "high",
      hairEndpointLandmark: "ear",
      hairTouchesShoulder: false,
      skinTone: "light",
      skinUndertone: "neutral",
      eyeColor: "dark-brown",
      hairColor: "black",
      faceShape: "oval",
      eyeShape: "almond",
      eyeSize: "small",
      irisLightness: "dark",
      eyeSpacing: "average",
      eyeTilt: "level",
      eyebrowShape: "straight",
      eyebrowThickness: "thin",
      noseShape: "straight",
      mouthShape: "thin",
      mouthOpening: "closed",
      lipFullness: "thin",
      lipColor: "natural",
      jawShape: "soft",
      bangs: "straight",
      bangsLength: "brow",
      hairSilhouette: "rounded",
      bangsDensity: "dense",
      fringeEdge: "staggered",
      fringeOpening: "none",
      hairTexture: "straight",
      hairVolume: "normal",
      overallHairLength: "ear",
      hairPart: "none",
      sideHairLength: "short",
      sideHairShape: "ear_hugging",
      sideHairAsymmetry: "none",
      earExposure: "partial",
      neckAccessory: "bow",
      neckConfidence: "high",
      clothingConfidence: "high",
      faceEvidence: "Light neutral skin and a soft oval jaw are visible.",
      hairEvidence: "A domed crown flows into ear-hugging temple hair.",
      hairEndpointEvidence:
        "The lowest substantial locks end around the ears above the jaw.",
      neckEvidence: "A central knot has two broad pointed hanging tails.",
      clothingEvidence:
        "A small blue and gold rectangular viewer-left chest badge is visible.",
    };
    const run = vi.fn(async () => ({ response: detail }));

    const result = await runPortraitDetailAnalysis(
      makeVisionEnv(run),
      "data:image/png;base64,portrait-crop",
    );

    expect(result).toEqual({
      ok: true,
      detail,
      attempts: 1,
      neuronsSpent: 100,
    });
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      messages: [
        {
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,portrait-crop" },
            },
            { type: "text", text: PORTRAIT_DETAIL_PROMPT },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "minecraft_skin_portrait_detail" },
      },
    });
  });

  it("uses the fallback model when focused portrait output is unavailable", async () => {
    const detail = {
      faceConfidence: "high",
      hairConfidence: "high",
      crownConfidence: "high",
      fringeConfidence: "high",
      sideHairConfidence: "high",
      hairEndpointConfidence: "high",
      hairEndpointLandmark: "jaw",
      hairTouchesShoulder: false,
      skinTone: "light",
      skinUndertone: "neutral",
      eyeColor: "blue",
      hairColor: "blonde",
      faceShape: "oval",
      eyeShape: "almond",
      eyeSize: "average",
      irisLightness: "light",
      eyeSpacing: "average",
      eyeTilt: "level",
      eyebrowShape: "soft",
      eyebrowThickness: "normal",
      noseShape: "straight",
      mouthShape: "wide",
      mouthOpening: "closed",
      lipFullness: "average",
      lipColor: "rose",
      jawShape: "rounded",
      bangs: "none",
      bangsLength: "none",
      hairSilhouette: "tousled",
      bangsDensity: "balanced",
      fringeEdge: "wispy",
      fringeOpening: "none",
      hairTexture: "curly",
      hairVolume: "full",
      overallHairLength: "jaw",
      hairPart: "none",
      sideHairLength: "jaw",
      sideHairShape: "flared",
      sideHairAsymmetry: "none",
      earExposure: "partial",
      neckAccessory: "none",
      neckConfidence: "high",
      faceEvidence: "Warm smiling oval face and light eyes.",
      hairEvidence: "Full curls end above the shoulder at the jaw line.",
      hairEndpointEvidence:
        "Multiple curls end at the jaw and do not touch the shoulder seam.",
      neckEvidence: "No neck accessory is visible.",
    };
    const run = vi.fn(async (model: string) => {
      if (model === "primary-model") throw new Error("primary unavailable");
      return { response: detail };
    });

    const result = await runPortraitDetailAnalysis(
      makeVisionEnv(run),
      "data:image/png;base64,portrait-crop",
    );

    expect(result).toMatchObject({ ok: true, detail, attempts: 2 });
    expect(run.mock.calls.map(([model]) => model)).toEqual([
      "primary-model",
      "fallback-model",
    ]);
  });

  it("distinguishes the outer crown from the fringe edge", () => {
    expect(PORTRAIT_DETAIL_PROMPT).toContain("OUTER crown and temple contour");
    expect(PORTRAIT_DETAIL_PROMPT).toContain(
      "It is not the lower edge of the fringe",
    );
    expect(PORTRAIT_DETAIL_PROMPT).toContain("crown to temple to sideburn/ear");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("crownConfidence");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("fringeConfidence");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("sideHairConfidence");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("hairEndpointConfidence low");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("hairTouchesShoulder true only");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("hairEndpointEvidence");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("central knot with paired loops");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("teeth_visible");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("low neckConfidence");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("clothingConfidence low");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("viewer-relative location");
  });
});

describe("validatePhotoAnalysis", () => {
  it("validates one primary-subject region and degrades malformed localization to crop fallback", () => {
    const region = {
      subjectBox: { left: 0.08, top: 0.04, right: 0.62, bottom: 0.98 },
      headBox: { left: 0.16, top: 0.08, right: 0.52, bottom: 0.5 },
      faceBox: { left: 0.21, top: 0.17, right: 0.47, bottom: 0.44 },
      confidence: 0.91,
    };
    expect(validatePortraitRegion(region)).toMatchObject({ ok: true, region });
    const compact = makeAnalysis({
      sourceSelection: {
        ...makeAnalysis().sourceSelection,
        portraitEvidence: "the selected image clearly shows the primary person | REGION:[0.08,0.04,0.62,0.98,0.16,0.08,0.52,0.5,0.21,0.17,0.47,0.44,0.91]",
      },
    });
    const compactResult = validatePhotoAnalysis(compact);
    expect(compactResult.ok).toBe(true);
    if (compactResult.ok) {
      expect(compactResult.analysis.sourceSelection.portraitRegion).toEqual(region);
      expect(compactResult.analysis.sourceSelection.portraitEvidence).not.toContain("REGION:");
    }
    const invalid = makeAnalysis({ sourceSelection: { ...makeAnalysis().sourceSelection, portraitRegion: { ...region, faceBox: { left: 0.7, top: 0.2, right: 0.8, bottom: 0.4 } } } });
    const result = validatePhotoAnalysis(invalid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.sourceSelection.portraitRegion).toBeNull();
    expect(ANALYSIS_PROMPT).toContain("same primary person");
    expect(ANALYSIS_PROMPT).toContain("Do not include another person's face");
  });

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

  it("describes supported provider response shapes without retaining content", () => {
    const analysis = makeAnalysis();
    const diagnostic = analysisPayloadDiagnostic({ response: JSON.stringify(analysis) });
    expect(diagnostic).toMatchObject({ responseType: "string",
      responseString: { startsWithObject: true, containsCloseBrace: true, extractJsonSucceeded: true },
      extractedType: "object", extractedNull: false });
    expect(diagnostic.extractedObjectKeys).toContain("quality");
    expect(JSON.stringify(diagnostic)).not.toContain(analysis.observed.face);
  });

  it("turns schema-key salience into concrete identity cues", () => {
    const raw = makeAnalysis({
      canonicalIdentity: {
        overallImpression:
          "A person with full blonde curls, light eyes and a gray knit sweater.",
        mustPreserve: ["faceShape", "hairColor", "eyeColor", "topType"],
        features: [
          {
            feature: "faceShape",
            category: "face",
            priority: 5,
            confidence: "high",
            evidence: "soft oval face with bright blue eyes",
            targetRegions: ["head.front"],
          },
          {
            feature: "hairColor",
            category: "hair",
            priority: 4,
            confidence: "high",
            evidence: "full jaw-length blonde curls",
            targetRegions: ["head.overlay"],
          },
          {
            feature: "topType",
            category: "outfit",
            priority: 3,
            confidence: "high",
            evidence: "light gray cable-knit sweater",
            targetRegions: ["torso.front"],
          },
          {
            feature: "glasses",
            category: "accessory",
            priority: 1,
            confidence: "high",
            evidence: "none",
            targetRegions: ["head.front"],
          },
        ],
      },
      fallbackFeatures: {
        ...makeAnalysis().fallbackFeatures,
        eyeColor: "blue",
        hairColor: "blonde",
        topType: "sweater",
        topColor: "gray",
        glasses: "none",
      },
    });

    const result = validatePhotoAnalysis(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.canonicalIdentity.mustPreserve).toEqual([
      "soft oval face with bright blue eyes",
      "full jaw-length blonde curls",
      "medium blue round eyes",
      "light gray cable-knit sweater",
    ]);
    expect(
      result.analysis.canonicalIdentity.features.map(({ feature }) => feature),
    ).toEqual([
      "soft oval face with bright blue eyes",
      "full jaw-length blonde curls",
      "light gray cable-knit sweater",
      "bare face without glasses",
    ]);
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
    expect(ANALYSIS_PROMPT).toContain("legwearColor");
    expect(ANALYSIS_PROMPT).toContain("use beige for cream/ivory/oatmeal");
    expect(
      PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties.legwearColor.enum,
    ).toContain("beige");
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
    expect(ANALYSIS_PROMPT).toContain("using minimum invention");
    expect(ANALYSIS_PROMPT).toContain(
      "Never add a pattern, belt, stripe, accessory, asymmetry or legwear merely to make the design more detailed",
    );
    expect(ANALYSIS_PROMPT).toContain("Plain pants, no accent, no legwear and simple shoes is valid");
  });

  it("analysis prompt distinguishes fringe density and side-hair profile", () => {
    expect(ANALYSIS_PROMPT).toContain("bangsDensity");
    expect(ANALYSIS_PROMPT).toContain("fringeEdge");
    expect(ANALYSIS_PROMPT).toContain("fringeOpening");
    expect(ANALYSIS_PROMPT).toContain("independent from hairPart");
    expect(ANALYSIS_PROMPT).toContain("eyeSize");
    expect(ANALYSIS_PROMPT).toContain("skinUndertone");
    expect(ANALYSIS_PROMPT).toContain("accidental outlier");
    expect(ANALYSIS_PROMPT).toContain(
      "Never reject an otherwise compatible alternate",
    );
    expect(ANALYSIS_PROMPT).toContain("actual eye opening");
    expect(ANALYSIS_PROMPT).toContain("irisLightness");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("iris itself");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("eyebrowThickness");
    expect(PORTRAIT_DETAIL_PROMPT).toContain(
      "visible hair-bearing brow stroke",
    );
    expect(ANALYSIS_PROMPT).toContain("lipFullness");
    expect(ANALYSIS_PROMPT).toContain("lipColor");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("dominant lip pigmentation");
    expect(ANALYSIS_PROMPT).toContain("small full lips");
    expect(ANALYSIS_PROMPT).toContain("eyeTilt");
    expect(ANALYSIS_PROMPT).toContain("solid rectangular bar");
    expect(ANALYSIS_PROMPT).toContain("visible scalp/root direction");
    expect(ANALYSIS_PROMPT).toContain("crown and temple OUTER CONTOUR");
    expect(ANALYSIS_PROMPT).toContain("Long hair is not automatically full");
    expect(PORTRAIT_DETAIL_PROMPT).toContain("Do not call all long hair full");
    expect(PORTRAIT_DETAIL_PROMPT).toContain(
      "lowest substantial front-fringe tips",
    );
    expect(PORTRAIT_DETAIL_PROMPT).toContain("gap between bang tips");
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

  it("recovers a complete safe fallback contract when Gemini omits coarse enums", () => {
    const base = makeAnalysis();
    const result = validatePhotoAnalysis(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy brown hair falling below the shoulders",
          accessories: "turquoise teardrop earrings and round glasses",
          clothing: "black jacket over a white shirt",
        },
        renderHints: {
          ...base.renderHints,
          hairTexture: "wavy",
          overallHairLength: "chest",
        },
        fallbackFeatures: {} as never,
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.fallbackFeatures).toMatchObject({
        hairstyle: "long",
        glasses: "round",
        earrings: true,
        topType: "jacket",
        bottomType: "pants",
      });
      expect(Object.keys(result.analysis.fallbackFeatures)).toHaveLength(19);
    }
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
    broken.renderHints.skinUndertone = "green" as never;
    broken.renderHints.irisLightness = "glowing" as never;
    broken.renderHints.noseShape = "triangle" as never;
    broken.renderHints.mouthShape = "square" as never;
    broken.renderHints.lipColor = "neon" as never;
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
    broken.renderHints.legwearColor = "cyan" as never;
    broken.renderHints.earExposure = "unknown" as never;
    const result = validatePhotoAnalysis(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("renderHints.eyebrowShape");
      expect(result.errors.join()).toContain("renderHints.skinUndertone");
      expect(result.errors.join()).toContain("renderHints.irisLightness");
      expect(result.errors.join()).toContain("renderHints.noseShape");
      expect(result.errors.join()).toContain("renderHints.mouthShape");
      expect(result.errors.join()).toContain("renderHints.lipColor");
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
      expect(result.errors.join()).toContain("renderHints.legwearColor");
      expect(result.errors.join()).toContain("renderHints.earExposure");
    }
  });

  it("객체가 아닌 응답은 즉시 실패한다", () => {
    expect(validatePhotoAnalysis("json이 아님").ok).toBe(false);
    expect(validatePhotoAnalysis(null).ok).toBe(false);
    expect(validatePhotoAnalysis([1, 2]).ok).toBe(false);
  });
});
