import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, encodePng } from "../src/png";
import { buildSkinPlan } from "../src/skinPlan";
import { GeminiImageProvider } from "../src/skinProvider";
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
});
