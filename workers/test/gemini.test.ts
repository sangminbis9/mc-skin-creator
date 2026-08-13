import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiApiError,
  generateGeminiImage,
  geminiRetryAfterMs,
  generateGeminiStructuredJson,
  isGeminiModelUnavailable,
  isGeminiQuotaError,
  isGeminiTemporaryRateLimit,
} from "../src/gemini";
import type { Env } from "../src/types";

const env = { GEMINI_API_KEY: "test-key" } as Env;
const LIVE_IMAGE_PROBE = process.env.RUN_LIVE_GEMINI_IMAGE_PROBE === "1";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gemini REST client", () => {
  it("routes production requests through the account-bound AI Gateway", async () => {
    const getUrl = vi.fn(async () =>
      "https://gateway.ai.cloudflare.com/v1/account/default/google-ai-studio",
    );
    const gateway = vi.fn(() => ({ getUrl }));
    const fetchMock = vi.fn(async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateGeminiStructuredJson(
      {
        ...env,
        AI: { gateway } as unknown as Ai,
      },
      {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 100,
      },
    );

    expect(gateway).toHaveBeenCalledWith("default");
    expect(getUrl).toHaveBeenCalledWith("google-ai-studio");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gateway.ai.cloudflare.com/v1/account/default/google-ai-studio/v1beta/models/gemini-test:generateContent",
    );
  });

  it("sends multimodal structured-output requests server-side", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: '{"quality":"pass"}' }] } }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 3,
          totalTokenCount: 15,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateGeminiStructuredJson(env, {
      model: "gemini-test",
      imageDataUrls: ["data:image/png;base64,AQID"],
      prompt: "Analyze",
      responseSchema: { type: "object" },
      maxOutputTokens: 100,
    });

    expect(result).toEqual({
      response: '{"quality":"pass"}',
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/models/gemini-test:generateContent");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    const body = JSON.parse(String(init?.body));
    expect(body.contents[0].parts[1]).toEqual({
      inlineData: { mimeType: "image/png", data: "AQID" },
    });
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
  });

  it("keeps multiple same-person references ordered and labeled", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateGeminiStructuredJson(env, {
      model: "gemini-test",
      imageDataUrls: [
        "data:image/png;base64,AQID",
        "data:image/jpeg;base64,BAUG",
      ],
      prompt: "Fuse identity",
      responseSchema: { type: "object" },
      maxOutputTokens: 100,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.contents[0].parts).toEqual([
      { text: "Reference image 0 of the same person:" },
      { inlineData: { mimeType: "image/png", data: "AQID" } },
      { text: "Reference image 1 of the same person:" },
      { inlineData: { mimeType: "image/jpeg", data: "BAUG" } },
      { text: "Fuse identity" },
    ]);
  });

  it("uses explicit image roles for source-versus-render comparisons", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateGeminiStructuredJson(env, {
      model: "gemini-test",
      imageDataUrls: [
        "data:image/png;base64,AQID",
        "data:image/png;base64,BAUG",
      ],
      imageLabels: [
        "Primary source portrait:",
        "Rendered candidate montage, NOT a source photo:",
      ],
      prompt: "Compare",
      responseSchema: { type: "object" },
      maxOutputTokens: 100,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.contents[0].parts[0]).toEqual({
      text: "Primary source portrait:",
    });
    expect(body.contents[0].parts[2]).toEqual({
      text: "Rendered candidate montage, NOT a source photo:",
    });
  });

  it("rejects mismatched custom image labels before sending a request", async () => {
    await expect(
      generateGeminiStructuredJson(env, {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        imageLabels: [],
        prompt: "Compare",
        responseSchema: { type: "object" },
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow("imageLabels must match");
  });

  it("retains five source photos plus one rendered comparison image", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const imageDataUrls = Array.from(
      { length: 6 },
      (_, index) => `data:image/png;base64,AQI${index}`,
    );

    await generateGeminiStructuredJson(env, {
      model: "gemini-test",
      imageDataUrls,
      imageLabels: imageDataUrls.map((_, index) => `Input ${index}:`),
      prompt: "Compare every input",
      responseSchema: { type: "object" },
      maxOutputTokens: 100,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const parts = body.contents[0].parts as Array<{
      text?: string;
      inlineData?: unknown;
    }>;
    expect(parts.filter((part) => part.inlineData)).toHaveLength(6);
    expect(parts.filter((part) => part.text).map((part) => part.text)).toEqual([
      "Input 0:",
      "Input 1:",
      "Input 2:",
      "Input 3:",
      "Input 4:",
      "Input 5:",
      "Compare every input",
    ]);
  });

  it("rejects more than six structured-comparison images", async () => {
    await expect(
      generateGeminiStructuredJson(env, {
        model: "gemini-test",
        imageDataUrls: Array.from(
          { length: 7 },
          () => "data:image/png;base64,AQID",
        ),
        prompt: "Compare",
        responseSchema: { type: "object" },
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow("1 to 6 input images");
  });

  it("extracts the final image from an Interactions response", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        steps: [
          {
            type: "model_output",
            content: [{ type: "image", mime_type: "image/png", data: "AQID" }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bytes = await generateGeminiImage(env, {
      model: "gemini-image-test",
      prompt: "Generate",
      images: [{ mimeType: "image/png", bytes: new Uint8Array([4, 5, 6]) }],
      seed: 7,
      aspectRatio: "4:1",
    });

    expect([...bytes]).toEqual([1, 2, 3]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format).toMatchObject({
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: "4:1",
      image_size: "1K",
    });
    expect(body.input[0]).toMatchObject({
      type: "image",
      mime_type: "image/png",
      data: "BAUG",
    });
  });

  it("recognizes Gemini resource exhaustion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: { message: "quota exhausted", status: "RESOURCE_EXHAUSTED" },
          },
          { status: 429 },
        ),
      ),
    );

    await expect(
      generateGeminiStructuredJson(env, {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 10,
      }),
    ).rejects.toSatisfy(isGeminiQuotaError);
  });

  it("recognizes only model-availability client errors as fallback candidates", () => {
    expect(
      isGeminiModelUnavailable(
        new GeminiApiError("model was not found", 404, "NOT_FOUND"),
      ),
    ).toBe(true);
    expect(
      isGeminiModelUnavailable(
        new GeminiApiError("invalid image payload", 400, "INVALID_ARGUMENT"),
      ),
    ).toBe(false);
  });

  it("aborts a stalled structured request with a deadline error", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateGeminiStructuredJson(
        { ...env, GEMINI_STRUCTURED_TIMEOUT_MS: "10" },
        {
          model: "gemini-stalled",
          imageDataUrls: ["data:image/png;base64,AQID"],
          prompt: "Analyze",
          responseSchema: { type: "object" },
          maxOutputTokens: 10,
        },
      ),
    ).rejects.toMatchObject({
      status: 504,
      providerStatus: "DEADLINE_EXCEEDED",
    });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("separates a short provider rate limit from permanent quota closure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "Please retry in 2.25s.",
              status: "RESOURCE_EXHAUSTED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.RetryInfo",
                  retryDelay: "2.25s",
                },
              ],
            },
          },
          { status: 429 },
        ),
      ),
    );

    let caught: unknown;
    try {
      await generateGeminiStructuredJson(env, {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 10,
      });
    } catch (error) {
      caught = error;
    }
    expect(isGeminiQuotaError(caught)).toBe(true);
    expect(isGeminiTemporaryRateLimit(caught)).toBe(true);
    expect(geminiRetryAfterMs(caught)).toBe(2250);
  });

  it("treats an explicit zero limit as closed even when a retry delay is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message:
                "Quota exceeded for generate_content_free_tier_requests, limit: 0. Please retry in 53s.",
              status: "RESOURCE_EXHAUSTED",
              details: [{ retryDelay: "53s" }],
            },
          },
          { status: 429 },
        ),
      ),
    );

    let caught: unknown;
    try {
      await generateGeminiStructuredJson(env, {
        model: "gemini-zero-quota",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 10,
      });
    } catch (error) {
      caught = error;
    }
    expect(isGeminiQuotaError(caught)).toBe(true);
    expect(isGeminiTemporaryRateLimit(caught)).toBe(false);
  });
});

describe.skipIf(!LIVE_IMAGE_PROBE)("live Gemini image model probe", () => {
  it("generates an image with the Flash Lite fallback model", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required");
    const bytes = await generateGeminiImage(
      { GEMINI_API_KEY: key, GEMINI_IMAGE_TIMEOUT_MS: "120000" } as Env,
      {
        model: "gemini-3.1-flash-lite-image",
        prompt:
          "Generate a simple non-photorealistic pixel-art blue cube centered on a plain light background. No text.",
        images: [],
        seed: 17,
        aspectRatio: "16:9",
      },
    );
    expect(bytes.length).toBeGreaterThan(1_000);
  }, 150_000);
});
