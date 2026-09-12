import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import { COMPACT_PHOTO_ANALYSIS_SCHEMA, COMPACT_PHOTO_ANALYSIS_PROMPT, normalizeCompactPhotoAnalysis, validateCompactPhotoAnalysis } from "../src/compactPhotoAnalysis";
import { buildGeminiStructuredRequestEnvelope, generateGeminiStructuredJson } from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
import { safeProviderMessage } from "./primaryTransportSupport";

const ROOT = resolve("evaluation-artifacts/compact-primary-20260909");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prompt = `${COMPACT_PHOTO_ANALYSIS_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`;
const request = (images: string[]) => ({ model: "gemini-3.6-flash", imageDataUrls: images, prompt, responseSchema: COMPACT_PHOTO_ANALYSIS_SCHEMA, maxOutputTokens: 8192, allowWorkersAiFallback: false });

describe("compact primary canary contract", () => {
  it("preserves model, endpoint and non-schema generation config; one raw-base64 JPEG only", () => {
    const empty = buildGeminiStructuredRequestEnvelope(request([]));
    const image = buildGeminiStructuredRequestEnvelope(request(["data:image/jpeg;base64,/9j/2Q=="]));
    expect(empty.shape).toMatchObject({ apiFamily: "generateContent", apiVersion: "v1beta", imageParts: 0, temperature: 0, maxOutputTokens: 8192, responseMimeType: "application/json" });
    expect(image.shape).toMatchObject({ imageParts: 1, imageMimeTypes: ["image/jpeg"] });
    expect((empty.body as { generationConfig: unknown }).generationConfig).toEqual((image.body as { generationConfig: unknown }).generationConfig);
    expect(JSON.stringify(image.body)).toContain('"data":"/9j/2Q=="');
    expect(JSON.stringify(image.body)).not.toContain("data:image");
    expect(JSON.stringify(image.body)).not.toContain('"responseSchema":');
  });
});

describe.skipIf(!["1", "2"].includes(process.env.COMPACT_PRIMARY_CANARY ?? ""))("authorized compact primary live canary", () => {
  it("dispatches one call, checkpoints safely, and never retries", async () => {
    const id = Number(process.env.COMPACT_PRIMARY_CANARY);
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    expect(Boolean(apiKey)).toBe(true);
    await mkdir(ROOT, { recursive: true });
    const metrics = inspectGeminiResponseSchema(COMPACT_PHOTO_ANALYSIS_SCHEMA);
    expect(metrics).toMatchObject({ valid: true, depth: 5 });
    expect(metrics.serializedBytes).toBeLessThanOrEqual(7000);
    expect(metrics.propertyCount).toBeLessThanOrEqual(100);
    const offline = JSON.parse(await readFile(join(ROOT, "offline.json"), "utf8"));
    expect(offline.schemaHash).toBe(sha(COMPACT_PHOTO_ANALYSIS_SCHEMA));
    expect(offline.promptHash).toBe(sha(COMPACT_PHOTO_ANALYSIS_PROMPT));
    const prior = (await readdir(ROOT)).filter(name => /^canary-[12]\.json$/.test(name));
    expect(prior.length).toBe(id - 1);
    const images: string[] = [];
    if (id === 2) {
      const textResult = JSON.parse(await readFile(join(ROOT, "canary-1.json"), "utf8"));
      expect(textResult).toMatchObject({ httpStatus: 200, jsonReturned: true, schemaValidation: true, completed: true, attemptedCalls: 1 });
      expect(textResult.schemaHash).toBe(sha(COMPACT_PHOTO_ANALYSIS_SCHEMA));
      expect(textResult.promptHash).toBe(sha(prompt));
      const manifest = JSON.parse(await readFile(resolve("evaluation-artifacts/generalization-20260905/annotations.json"), "utf8")) as Array<{ existing?: boolean; photoId?: number; sourceUrl?: string }>;
      const publicPhoto = manifest.find(photo => !photo.existing && photo.photoId && photo.sourceUrl?.startsWith("https://www.pexels.com/photo/"));
      expect(publicPhoto).toBeTruthy();
      const bytes = await readFile(resolve(`evaluation-artifacts/generalization-20260905/sources/${publicPhoto!.photoId}.jpg`));
      expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
      images.push(`data:image/jpeg;base64,${bytes.toString("base64")}`);
    }
    const options = request(images);
    const envelope = buildGeminiStructuredRequestEnvelope(options);
    const validate = new Ajv({ allErrors: true }).compile(COMPACT_PHOTO_ANALYSIS_SCHEMA);
    const path = join(ROOT, `canary-${id}.json`);
    const result: Record<string, unknown> = {
      id, model: options.model, apiFamily: "generateContent", apiVersion: "v1beta",
      endpoint: `/v1beta/models/${options.model}:generateContent`, imageCount: images.length,
      imageMime: images.length ? "image/jpeg" : null, schemaHash: sha(COMPACT_PHOTO_ANALYSIS_SCHEMA),
      promptHash: sha(prompt), wireHash: sha(envelope.body), metrics, attemptedCalls: 0,
      httpStatus: null, providerCode: null, providerStatus: null, providerMessage: null,
      jsonReturned: false, schemaValidation: false, normalizationSuccess: false, completed: false,
    };
    await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" });
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (++attempts !== 1) throw new Error("COMPACT_CANARY_RETRY_FORBIDDEN");
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.origin).toBe("https://generativelanguage.googleapis.com");
      expect(url.pathname).toBe(result.endpoint);
      expect(sha(JSON.parse(String(init?.body)))).toBe(result.wireHash);
      result.attemptedCalls = 1;
      await writeFile(path, JSON.stringify(result, null, 2));
      const response = await originalFetch(input, init);
      result.httpStatus = response.status;
      const payload = await response.clone().json().catch(() => null);
      result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
      result.providerStatus = safeProviderMessage(payload?.error?.status, [apiKey!]);
      result.providerMessage = safeProviderMessage(payload?.error?.message, [apiKey!]);
      if (response.ok) {
        const text = (payload?.candidates?.[0]?.content?.parts ?? []).filter((part: { thought?: boolean }) => !part.thought).map((part: { text?: string }) => part.text ?? "").join("");
        let parsed: unknown;
        try { parsed = JSON.parse(text); result.jsonReturned = true; } catch { result.jsonReturned = false; }
        result.schemaValidation = result.jsonReturned === true && validate(parsed) === true;
        result.schemaErrorCount = validate.errors?.length ?? 0;
        if (result.schemaValidation) {
          result.slotValidation = validateCompactPhotoAnalysis(parsed).length === 0;
          result.normalizationSuccess = normalizeCompactPhotoAnalysis(parsed).ok;
        }
        result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
      }
      await writeFile(path, JSON.stringify(result, null, 2));
      return response;
    });
    try {
      await generateGeminiStructuredJson({ GEMINI_API_KEY: apiKey!, GEMINI_STRUCTURED_TIMEOUT_MS: "45000" } as Env, options);
    } catch (error) { result.clientErrorName = error instanceof Error ? error.name : "unknown"; }
    finally {
      spy.mockRestore(); result.completed = true;
      await writeFile(path, JSON.stringify(result, null, 2));
    }
    expect(attempts).toBe(1);
  }, 60000);
});
