import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_PHOTO_ANALYSIS_V2_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  normalizeCompactPhotoAnalysisV2,
  validateCompactPhotoAnalysisV2,
} from "../src/compactPhotoAnalysis";
import {
  buildGeminiStructuredRequestEnvelope,
  generateGeminiStructuredJson,
} from "../src/gemini";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import type { Env } from "../src/types";
import { safeProviderMessage } from "./primaryTransportSupport";

const ROOT = resolve("evaluation-artifacts/compact-primary-v2-20260909");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prompt = `${COMPACT_PHOTO_ANALYSIS_V2_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`;
const request = (images: string[]) => ({
  model: "gemini-3.6-flash",
  imageDataUrls: images,
  prompt,
  responseSchema: COMPACT_PHOTO_ANALYSIS_V2_SCHEMA,
  maxOutputTokens: 8192,
  allowWorkersAiFallback: false,
});

async function assertOfflineReady() {
  const offline = JSON.parse(await readFile(join(ROOT, "offline.json"), "utf8"));
  const semantic = JSON.parse(await readFile(join(ROOT, "semantic-equivalence.json"), "utf8"));
  const frozen = JSON.parse(await readFile(join(ROOT, "frozen-regression.json"), "utf8"));
  expect(offline).toMatchObject({
    schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA),
    promptHash: sha(COMPACT_PHOTO_ANALYSIS_V2_PROMPT),
    groupCount: 15,
    compactV2: {
      valid: true,
      serializedBytes: 7919,
      propertyCount: 98,
      requiredCount: 77,
      depth: 5,
      largestSingleEnum: 16,
    },
  });
  expect(semantic).toMatchObject({
    passed: true,
    fixtureCount: 8,
    sourceSemanticLoss: 0,
    planDiffs: 0,
    atlasDiffs: 0,
  });
  expect(frozen).toMatchObject({
    passed: true,
    cases: 12,
    calibratedCases: 5,
    planDiffs: 0,
    atlasDiffs: 0,
    unrelatedDiffs: 0,
  });
  return { offline, semantic, frozen };
}

describe("compact v2 primary canary contract", () => {
  it("keeps text and JPEG requests identical outside the image part", async () => {
    await assertOfflineReady();
    const empty = buildGeminiStructuredRequestEnvelope(request([]));
    const image = buildGeminiStructuredRequestEnvelope(request(["data:image/jpeg;base64,/9j/2Q=="]));
    expect(empty.shape).toMatchObject({
      apiFamily: "generateContent",
      apiVersion: "v1beta",
      imageParts: 0,
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    });
    expect(image.shape).toMatchObject({ imageParts: 1, imageMimeTypes: ["image/jpeg"] });
    expect((empty.body as { generationConfig: unknown }).generationConfig)
      .toEqual((image.body as { generationConfig: unknown }).generationConfig);
    expect(JSON.stringify(image.body)).toContain('"data":"/9j/2Q=="');
    expect(JSON.stringify(image.body)).not.toContain("data:image");
    expect(JSON.stringify(image.body)).not.toContain('"responseSchema":');
  });
});

describe.skipIf(!["A", "B"].includes(process.env.COMPACT_PRIMARY_V2_CANARY ?? ""))(
  "authorized compact v2 primary live canary",
  () => {
    it("dispatches exactly one request and checkpoints secret-safe acceptance evidence", async () => {
      const id = process.env.COMPACT_PRIMARY_V2_CANARY as "A" | "B";
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      expect(Boolean(apiKey)).toBe(true);
      const ready = await assertOfflineReady();
      const metrics = inspectGeminiResponseSchema(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA);
      const images: string[] = [];
      if (id === "B") {
        const textResult = JSON.parse(await readFile(join(ROOT, "canary-a.json"), "utf8"));
        expect(textResult).toMatchObject({
          httpStatus: 200,
          jsonReturned: true,
          schemaValidation: true,
          compactValidation: true,
          normalizationSuccess: true,
          completed: true,
          attemptedCalls: 1,
          schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA),
          promptHash: sha(prompt),
        });
        const manifest = JSON.parse(await readFile(
          resolve("evaluation-artifacts/generalization-20260905/annotations.json"),
          "utf8",
        )) as Array<{ existing?: boolean; photoId?: number; sourceUrl?: string }>;
        const publicPhoto = manifest.find((photo) =>
          !photo.existing && photo.photoId && photo.sourceUrl?.startsWith("https://www.pexels.com/photo/"),
        );
        expect(publicPhoto).toBeTruthy();
        const bytes = await readFile(resolve(
          `evaluation-artifacts/generalization-20260905/sources/${publicPhoto!.photoId}.jpg`,
        ));
        expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
        images.push(`data:image/jpeg;base64,${bytes.toString("base64")}`);
      }

      const options = request(images);
      const envelope = buildGeminiStructuredRequestEnvelope(options);
      const validate = new Ajv({ allErrors: true }).compile(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA);
      const artifactPath = join(ROOT, `canary-${id.toLowerCase()}.json`);
      const result: Record<string, unknown> = {
        id,
        model: options.model,
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        endpoint: `/v1beta/models/${options.model}:generateContent`,
        imageCount: images.length,
        imageMime: images.length ? "image/jpeg" : null,
        imageMagicMatchesMime: images.length ? true : null,
        payloadRepresentation: images.length ? "raw_base64_in_inlineData" : null,
        schemaHash: sha(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA),
        promptHash: sha(prompt),
        wireHash: sha(envelope.body),
        metrics,
        offlineSemanticEquivalence: ready.semantic.passed,
        frozenRegression: ready.frozen.passed,
        attemptedCalls: 0,
        httpStatus: null,
        providerCode: null,
        providerStatus: null,
        providerMessage: null,
        jsonReturned: false,
        schemaValidation: false,
        compactValidation: false,
        normalizationSuccess: false,
        completed: false,
      };
      await writeFile(artifactPath, JSON.stringify(result, null, 2), { flag: "wx" });

      const originalFetch = globalThis.fetch;
      let attempts = 0;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (++attempts !== 1) throw new Error("COMPACT_V2_CANARY_RETRY_FORBIDDEN");
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        expect(url.origin).toBe("https://generativelanguage.googleapis.com");
        expect(url.pathname).toBe(result.endpoint);
        expect(sha(JSON.parse(String(init?.body)))).toBe(result.wireHash);
        result.attemptedCalls = 1;
        await writeFile(artifactPath, JSON.stringify(result, null, 2));
        const response = await originalFetch(input, init);
        result.httpStatus = response.status;
        const payload = await response.clone().json().catch(() => null);
        result.providerCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
        result.providerStatus = safeProviderMessage(payload?.error?.status, [apiKey!]);
        result.providerMessage = safeProviderMessage(payload?.error?.message, [apiKey!]);
        if (response.ok) {
          const text = (payload?.candidates?.[0]?.content?.parts ?? [])
            .filter((part: { thought?: boolean }) => !part.thought)
            .map((part: { text?: string }) => part.text ?? "")
            .join("");
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
            result.jsonReturned = true;
          } catch {
            result.jsonReturned = false;
          }
          result.schemaValidation = result.jsonReturned === true && validate(parsed) === true;
          result.schemaErrorCount = validate.errors?.length ?? 0;
          if (result.schemaValidation) {
            const compactErrors = validateCompactPhotoAnalysisV2(parsed);
            result.compactValidation = compactErrors.length === 0;
            result.compactErrorCount = compactErrors.length;
            result.normalizationSuccess = normalizeCompactPhotoAnalysisV2(parsed).ok;
          }
          result.finishReason = safeProviderMessage(payload?.candidates?.[0]?.finishReason);
        }
        await writeFile(artifactPath, JSON.stringify(result, null, 2));
        return response;
      });
      try {
        await generateGeminiStructuredJson({
          GEMINI_API_KEY: apiKey!,
          GEMINI_STRUCTURED_TIMEOUT_MS: "45000",
        } as Env, options);
      } catch (error) {
        result.clientErrorName = error instanceof Error ? error.name : "unknown";
      } finally {
        spy.mockRestore();
        result.completed = true;
        await writeFile(artifactPath, JSON.stringify(result, null, 2));
      }
      expect(attempts).toBe(1);
    }, 60000);
  },
);
