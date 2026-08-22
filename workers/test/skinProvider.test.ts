import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, encodePng, sniffImageSize } from "../src/png";
import { buildSkinPlan } from "../src/skinPlan";
import {
  GeminiImageProvider,
  ResilientImageProvider,
  WorkersAiImageProvider,
} from "../src/skinProvider";
import type { Env } from "../src/types";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";

const env = {
  GEMINI_API_KEY: "test-key",
  GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
  GEMINI_IMAGE_FALLBACK_MODEL: "gemini-3.1-flash-lite-image",
} as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function request() {
  const analysis = makeAnalysis();
  const photo = await encodePng(makeSyntheticAtlas());
  return {
    analysis,
    skinPlan: buildSkinPlan(analysis),
    photoDataUrl: `data:image/png;base64,${bytesToBase64(photo)}`,
    seed: 11,
    mode: "four_view" as const,
  };
}

function generatedImageResponse(): Response {
  return Response.json({
    output_image: {
      type: "image",
      mime_type: "image/jpeg",
      data: "AQID",
    },
  });
}

describe("GeminiImageProvider model fallback", () => {
  it("falls back to Flash Lite when the primary image quota is zero", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: "Image quota is unavailable for this project.",
              status: "RESOURCE_EXHAUSTED",
              details: [
                {
                  violations: [
                    { quotaId: "GenerateRequestsPerDay", quotaValue: "0" },
                  ],
                },
              ],
            },
          },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(generatedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GeminiImageProvider(env).generate(await request());

    expect(result).toMatchObject({
      ok: true,
      imageBytes: new Uint8Array([1, 2, 3]),
      model: "gemini-3.1-flash-lite-image",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(firstBody.model).toBe("gemini-3.1-flash-image");
    expect(firstBody.response_format.aspect_ratio).toBe("4:1");
    expect(secondBody.model).toBe("gemini-3.1-flash-lite-image");
    expect(secondBody.response_format).toMatchObject({
      aspect_ratio: "21:9",
      image_size: "1K",
    });
  });

  it("falls back when the configured image model is not found", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: "The requested model was not found.",
              status: "NOT_FOUND",
            },
          },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(generatedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GeminiImageProvider({
      ...env,
      GEMINI_IMAGE_MODEL: "missing-image-model",
    }).generate(await request());

    expect(result.ok).toBe(true);
    const models = fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)).model,
    );
    expect(models).toEqual([
      "missing-image-model",
      "gemini-3.1-flash-lite-image",
    ]);
  });

  it("does not bypass a temporary rate limit with another model", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "Please retry in 2s.",
            status: "RESOURCE_EXHAUSTED",
            details: [{ retryDelay: "2s" }],
          },
        },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GeminiImageProvider(env).generate(await request());

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps alternate same-person photos before the pose guide in image generation", async () => {
    const fetchMock = vi.fn(async () => generatedImageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const base = await request();
    const result = await new GeminiImageProvider(env).generate({
      ...base,
      referencePhotoDataUrls: [base.photoDataUrl, base.photoDataUrl],
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.input).toHaveLength(5);
    expect(
      body.input.slice(0, 4).map((item: { type: string }) => item.type),
    ).toEqual(["image", "image", "image", "image"]);
    expect(body.input[4].text).toContain(
      "Images 0-2 are intended to show the same person; image 0 is primary",
    );
    expect(body.input[4].text).toContain("do not blend it into a composite");
    expect(body.input[4].text).toContain(
      "Use image 3 strictly as the composition guide",
    );
  });

  it("prioritizes primary, focused face crop, one best alternate and guide", async () => {
    const fetchMock = vi.fn(async () => generatedImageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const base = await request();
    const crop = await encodePng(makeSyntheticAtlas(73));
    const result = await new GeminiImageProvider(env).generate({
      ...base,
      identityCropDataUrl: `data:image/png;base64,${bytesToBase64(crop)}`,
      referencePhotoDataUrls: [base.photoDataUrl, base.photoDataUrl, base.photoDataUrl],
    });
    expect(result).toMatchObject({ ok: true, inputTiles: 4, model: "gemini-3.1-flash-image" });
    if (result.ok) {
      expect(result.providerInputLimit).toBe(4);
      expect(result.inputDiagnostics?.map((input) => input.role)).toEqual([
        "primary",
        "identity_crop",
        "alternate",
        "pose_guide",
      ]);
      expect(result.inputDiagnostics?.every((input) => input.original.width === input.submitted.width && input.original.height === input.submitted.height)).toBe(true);
    }
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.input).toHaveLength(5);
    expect(body.input.slice(0, 4).map((item: { type: string }) => item.type)).toEqual(["image", "image", "image", "image"]);
    expect(body.input[4].text).toContain("Use image 3 strictly as the composition guide");
  });
});

describe("Workers AI image recovery", () => {
  it("sends the primary portrait, compatible references and pose guide as multipart inputs", async () => {
    const base = await request();
    const output = await encodePng(makeSyntheticAtlas(7));
    let capturedModel = "";
    let capturedForm: FormData | null = null;
    const ai = {
      run: vi.fn(async (model: string, input: unknown) => {
        capturedModel = model;
        const multipart = (input as {
          multipart: { body: ReadableStream; contentType: string };
        }).multipart;
        capturedForm = await new Response(multipart.body, {
          headers: { "content-type": multipart.contentType },
        }).formData();
        return { image: bytesToBase64(output) };
      }),
    } as unknown as Ai;

    const result = await new WorkersAiImageProvider({
      ...env,
      AI: ai,
      WORKERS_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
    }).generate({
      ...base,
      referencePhotoDataUrls: [
        base.photoDataUrl,
        base.photoDataUrl,
        base.photoDataUrl,
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      inputTiles: 4,
      outputTiles: 2,
      provider: "workers_ai",
      model: "@cf/black-forest-labs/flux-2-klein-4b",
      mode: "four_view",
    });
    expect(result.neuronsSpent).toBeGreaterThan(0);
    if (result.ok) {
      expect(result.providerInputLimit).toBe(4);
      expect(result.inputDiagnostics?.map((input) => input.role)).toEqual([
        "primary",
        "alternate",
        "alternate",
        "pose_guide",
      ]);
      expect(result.inputDiagnostics?.every((input) => input.submitted.width <= 448 && input.submitted.height <= 448)).toBe(true);
    }
    expect(capturedModel).toBe("@cf/black-forest-labs/flux-2-klein-4b");
    expect(capturedForm).not.toBeNull();
    expect(capturedForm?.get("width")).toBe("1024");
    expect(capturedForm?.get("height")).toBe("256");
    expect(capturedForm?.get("seed")).toBe("11");
    expect(capturedForm?.get("input_image_0")).toBeInstanceOf(File);
    expect(capturedForm?.get("input_image_1")).toBeInstanceOf(File);
    expect(capturedForm?.get("input_image_2")).toBeInstanceOf(File);
    expect(capturedForm?.get("input_image_3")).toBeInstanceOf(File);
    expect(capturedForm?.get("input_image_4")).toBeNull();
    expect(String(capturedForm?.get("prompt"))).toContain(
      "Images 0-2 are intended to show the same person",
    );
    expect(String(capturedForm?.get("prompt"))).toContain(
      "Use image 3 strictly as the composition guide",
    );
  });

  it("uses Workers AI when Gemini reports exhausted image quota", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "Image quota is unavailable for this project.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                violations: [
                  { quotaId: "GenerateRequestsPerDay", quotaValue: "0" },
                ],
              },
            ],
          },
        },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const output = await encodePng(makeSyntheticAtlas(9));
    const aiRun = vi.fn(async () => ({ image: bytesToBase64(output) }));
    const result = await new ResilientImageProvider({
      ...env,
      AI: { run: aiRun } as unknown as Ai,
      GEMINI_IMAGE_FALLBACK_MODEL: "gemini-3.1-flash-image",
      WORKERS_IMAGE_FALLBACK_ENABLED: "true",
    }).generate(await request());

    expect(result).toMatchObject({ ok: true, provider: "workers_ai" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(result.neuronsSpent).toBeGreaterThan(0);
  });

  it("selects Klein 9B for the quality recovery tier and meters its higher cost", async () => {
    const output = await encodePng(makeSyntheticAtlas(10));
    let capturedModel = "";
    const aiRun = vi.fn(async (model: string) => {
      capturedModel = model;
      return { image: bytesToBase64(output) };
    });
    const result = await new WorkersAiImageProvider({
      ...env,
      AI: { run: aiRun } as unknown as Ai,
      WORKERS_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
      WORKERS_IMAGE_QUALITY_MODEL:
        "@cf/black-forest-labs/flux-2-klein-9b",
    }).generate({ ...(await request()), modelTier: "quality" });

    expect(result).toMatchObject({
      ok: true,
      provider: "workers_ai",
      mode: "four_view",
    });
    expect(capturedModel).toBe("@cf/black-forest-labs/flux-2-klein-9b");
    expect(result.neuronsSpent).toBeGreaterThan(1_300);
  });

  it("marks Workers AI moderation failures as retryable consumed capacity", async () => {
    const aiRun = vi.fn(async () => {
      throw new Error(
        "3030: Your output has been flagged. Please choose another prompt / input image combination",
      );
    });
    const result = await new WorkersAiImageProvider({
      ...env,
      AI: { run: aiRun } as unknown as Ai,
      WORKERS_IMAGE_QUALITY_MODEL:
        "@cf/black-forest-labs/flux-2-klein-9b",
    }).generate({ ...(await request()), modelTier: "quality" });

    expect(result).toMatchObject({
      ok: false,
      provider: "workers_ai",
      retryable: true,
      capacityConsumed: true,
    });
    expect(result.neuronsSpent).toBeGreaterThan(1_300);
  });

  it("remembers exhausted Gemini quota while retrying temporary Workers AI capacity", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "Image quota is unavailable for this project.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                violations: [
                  { quotaId: "GenerateRequestsPerDay", quotaValue: "0" },
                ],
              },
            ],
          },
        },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const output = await encodePng(makeSyntheticAtlas(12));
    const aiRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("3040 out of capacity"))
      .mockResolvedValueOnce({ image: bytesToBase64(output) });
    const provider = new ResilientImageProvider({
      ...env,
      AI: { run: aiRun } as unknown as Ai,
      GEMINI_IMAGE_FALLBACK_MODEL: "gemini-3.1-flash-image",
      WORKERS_IMAGE_FALLBACK_ENABLED: "true",
    });
    const generationRequest = await request();

    const first = await provider.generate(generationRequest);
    const second = await provider.generate({
      ...generationRequest,
      seed: generationRequest.seed + 1,
    });

    expect(first).toMatchObject({
      ok: false,
      retryable: true,
      quotaExceeded: false,
      capacityConsumed: true,
    });
    expect(first.neuronsSpent).toBeGreaterThan(0);
    expect(second).toMatchObject({
      ok: true,
      provider: "workers_ai",
      mode: "front_view",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(aiRun).toHaveBeenCalledTimes(2);
  });

  it("does not send malformed or undersized input to the fallback provider", async () => {
    const aiRun = vi.fn();
    const base = await request();
    const result = await new WorkersAiImageProvider({
      ...env,
      AI: { run: aiRun } as unknown as Ai,
    }).generate({
      ...base,
      photoDataUrl: "data:image/png;base64,AQID",
    });

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("downscales a tall portrait below the Workers AI 512px input limit", async () => {
    const width = 640;
    const height = 960;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 132;
      rgba[i * 4 + 1] = 104;
      rgba[i * 4 + 2] = 92;
      rgba[i * 4 + 3] = 255;
    }
    const portrait = await encodePng({ width, height, rgba });
    const output = await encodePng(makeSyntheticAtlas(15));
    let primaryInputSize: { width: number; height: number } | null = null;
    const aiRun = vi.fn(async (_model: string, input: unknown) => {
      const multipart = (input as {
        multipart: { body: ReadableStream; contentType: string };
      }).multipart;
      const form = await new Response(multipart.body, {
        headers: { "content-type": multipart.contentType },
      }).formData();
      const image = form.get("input_image_0");
      expect(image).toBeInstanceOf(File);
      primaryInputSize = sniffImageSize(
        new Uint8Array(await (image as File).arrayBuffer()),
      );
      return { image: bytesToBase64(output) };
    });
    const base = await request();
    const result = await new WorkersAiImageProvider({
      ...env,
      AI: { run: aiRun } as unknown as Ai,
    }).generate({
      ...base,
      photoDataUrl: `data:image/png;base64,${bytesToBase64(portrait)}`,
    });

    expect(result.ok).toBe(true);
    expect(primaryInputSize).toEqual({ width: 299, height: 448 });
  });
});
