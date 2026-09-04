import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiApiError,
  buildGeminiStructuredRequestEnvelope,
  generateGeminiImage,
  geminiProviderErrorDiagnostic,
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
  it("uses one preflighted envelope for serialization without leaking image data into diagnostics", () => {
    const request = {
      model: "gemini-test",
      imageDataUrls: ["data:image/png;base64,AQID", "data:image/jpeg;base64,BAUG"],
      imageLabels: ["Face:", "Head:"],
      prompt: "Measure geometry",
      responseSchema: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 } }, required: ["x"] },
      maxOutputTokens: 2600,
    };
    const envelope = buildGeminiStructuredRequestEnvelope(request);
    expect(envelope.shape).toMatchObject({
      model: "gemini-test", endpointMethod: "models.generateContent", imageParts: 2,
      imageMimeTypes: ["image/png", "image/jpeg"], promptChars: 16,
      responseMimeType: "application/json", responseSchemaEnabled: true,
      maxOutputTokens: 2600, temperature: 0,
    });
    expect(envelope.shape.schema.valid).toBe(true);
    expect(JSON.stringify(envelope.shape)).not.toMatch(/AQID|BAUG|data:image|test-key/);
    expect(JSON.stringify(envelope.body)).toContain("AQID");
  });

  it("keeps generateContent and Interactions structured contracts separate", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    const generated = buildGeminiStructuredRequestEnvelope({
      model: "gemini-3.6-flash",
      imageDataUrls: [],
      prompt: "Return ok=true.",
      responseSchema: schema,
      maxOutputTokens: 64,
    });
    expect(generated.shape).toMatchObject({
      apiFamily: "generateContent",
      apiVersion: "v1beta",
      endpointMethod: "models.generateContent",
      structuredConfigKey: "generationConfig.responseJsonSchema",
      imageParts: 0,
    });
    expect(generated.body).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Return ok=true." }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: schema,
      },
    });
    expect(generated.body).not.toHaveProperty("input");
    expect(generated.body).not.toHaveProperty("response_format");

    const interaction = buildGeminiStructuredRequestEnvelope({
      model: "gemini-3.6-flash",
      apiFamily: "interactions",
      imageDataUrls: [],
      prompt: "Return ok=true.",
      responseSchema: schema,
      maxOutputTokens: 64,
    });
    expect(interaction.shape).toMatchObject({
      apiFamily: "interactions",
      apiVersion: "v1beta",
      endpointMethod: "interactions.create",
      structuredConfigKey: "response_format.schema",
      imageParts: 0,
      temperature: null,
    });
    expect(interaction.body).toEqual({
      model: "gemini-3.6-flash",
      store: false,
      input: [{ type: "text", text: "Return ok=true." }],
      response_format: { type: "text", mime_type: "application/json", schema },
      generation_config: { max_output_tokens: 64, thinking_level: "low" },
    });
    expect(interaction.body).not.toHaveProperty("contents");
    expect(interaction.body).not.toHaveProperty("generationConfig");
  });

  it("serializes image bytes as raw base64 and audits MIME magic bytes", () => {
    const envelope = buildGeminiStructuredRequestEnvelope({
      model: "gemini-3.6-flash",
      apiFamily: "interactions",
      imageDataUrls: [
        "data:image/png;base64,iVBORw0KGgo=",
        "data:image/jpeg;base64,/9j/",
        "data:image/png;base64,/9j/",
      ],
      prompt: "Inspect",
      responseSchema: { type: "object" },
      maxOutputTokens: 64,
    });
    expect(envelope.shape.imageRawBytes).toEqual([8, 3, 3]);
    expect(envelope.shape.imageMagicMatchesMime).toEqual([true, true, false]);
    expect(envelope.shape.imageBase64Chars).toEqual([12, 4, 4]);
    expect(JSON.stringify(envelope.body)).not.toContain("data:image");
    expect(envelope.body).toMatchObject({
      input: [
        { type: "text" },
        { type: "image", mime_type: "image/png", data: "iVBORw0KGgo=" },
        { type: "text" },
        { type: "image", mime_type: "image/jpeg", data: "/9j/" },
        { type: "text" },
        { type: "image", mime_type: "image/png", data: "/9j/" },
        { type: "text", text: "Inspect" },
      ],
    });
  });

  it("uses the Interactions endpoint and parses structured output text", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      output_text: '{"ok":true}',
      usage: { total_input_tokens: 4, total_output_tokens: 2, total_tokens: 6 },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateGeminiStructuredJson(env, {
      model: "gemini-3.6-flash",
      apiFamily: "interactions",
      imageDataUrls: [],
      prompt: "Return ok=true.",
      responseSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      maxOutputTokens: 64,
      allowWorkersAiFallback: false,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(result).toEqual({
      response: '{"ok":true}',
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  });

  it("rejects unsupported schemas locally without a provider call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateGeminiStructuredJson(env, {
      model: "gemini-test",
      imageDataUrls: ["data:image/png;base64,AQID"],
      prompt: "Analyze",
      responseSchema: { type: "object", properties: { value: { type: "string", pattern: "unsupported" } } },
      maxOutputTokens: 100,
    })).rejects.toMatchObject({ providerStatus: "CLIENT_SCHEMA_PREFLIGHT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves sanitized provider field violations and request shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Request contains an invalid argument.",
        details: [{ fieldViolations: [{ field: "generation_config.response_json_schema", description: "Schema is too complex" }] }],
      },
    }, { status: 400 })));
    let caught: unknown;
    try {
      await generateGeminiStructuredJson(env, {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 100,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GeminiApiError);
    const diagnostic = geminiProviderErrorDiagnostic(caught);
    expect(diagnostic).toEqual({
      httpStatus: 400,
      providerCode: 400,
      providerStatus: "INVALID_ARGUMENT",
      message: "Request contains an invalid argument.",
      fieldViolations: [{ field: "generation_config.response_json_schema", description: "Schema is too complex" }],
    });
    expect((caught as GeminiApiError).requestShape).toMatchObject({ model: "gemini-test", responseSchemaEnabled: true });
  });

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

  it("falls back to account-internal Workers AI when the gateway rejects authentication", async () => {
    const getUrl = vi.fn(async () =>
      "https://gateway.ai.cloudflare.com/v1/account/default/google-ai-studio",
    );
    const run = vi.fn(async () => ({ response: '{"quality":"pass"}' }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "Unauthorized", status: "UNAUTHENTICATED" } },
          { status: 401 },
        ),
      ),
    );
    const legacyWorkersAiInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "A" }] }],
    };

    const result = await generateGeminiStructuredJson(
      {
        ...env,
        AI: {
          gateway: () => ({ getUrl }),
          run,
        } as unknown as Ai,
      },
      {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 100,
        legacyWorkersAiInput,
      },
    );

    expect(result).toEqual({ response: '{"quality":"pass"}' });
    expect(run).toHaveBeenCalledWith(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      legacyWorkersAiInput,
    );
  });

  it("falls back to account-internal Workers AI when Gemini exhausts its daily quota", async () => {
    const run = vi.fn(async () => ({
      response: '{"quality":"pass"}',
      usage: { prompt_tokens: 1200, completion_tokens: 180 },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "Gemini free-tier requests per day exhausted",
              status: "RESOURCE_EXHAUSTED",
            },
          },
          { status: 429 },
        ),
      ),
    );

    const result = await generateGeminiStructuredJson(
      {
        ...env,
        AI: { run } as unknown as Ai,
      },
      {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 100,
      },
    );

    expect(result).toMatchObject({ response: '{"quality":"pass"}' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
    );
  });

  it("falls back to Workers AI when a structured Gemini request times out", async () => {
    const run = vi.fn(async () => ({ response: '{"quality":"pass"}' }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          }),
      ),
    );

    const result = await generateGeminiStructuredJson(
      {
        ...env,
        GEMINI_STRUCTURED_TIMEOUT_MS: "10",
        AI: { run } as unknown as Ai,
      },
      {
        model: "gemini-stalled",
        imageDataUrls: ["data:image/png;base64,AQID"],
        prompt: "Analyze",
        responseSchema: { type: "object" },
        maxOutputTokens: 100,
      },
    );

    expect(result).toEqual({ response: '{"quality":"pass"}' });
    expect(run).toHaveBeenCalledOnce();
  });

  it("builds a Workers AI schema request for critique fallback", async () => {
    const run = vi.fn(async () => ({ response: "{}" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "User location is not supported for the API use.",
              status: "INVALID_ARGUMENT",
            },
          },
          { status: 400 },
        ),
      ),
    );

    await generateGeminiStructuredJson(
      {
        ...env,
        AI: { run } as unknown as Ai,
      },
      {
        model: "gemini-test",
        imageDataUrls: ["data:image/png;base64,AQID"],
        imageLabels: ["Source portrait:"],
        prompt: "Critique",
        responseSchema: { type: "object", properties: {} },
        maxOutputTokens: 100,
      },
    );

    const input = run.mock.calls[0][1] as Record<string, unknown>;
    expect(run.mock.calls[0][0]).toBe(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
    );
    expect(input).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "minecraft_skin_structured_fallback" },
      },
    });
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
    ).rejects.toThrow("at most 6 input images");
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
