/**
 * Opt-in, single-run Gemini contract isolation. The hard counter prevents more
 * than three provider calls. There is no retry, fallback, alternate model,
 * evaluator, or sleep loop in this file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentityCrops } from "../src/generate";
import {
  GeminiApiError,
  geminiProviderErrorDiagnostic,
  generateGeminiStructuredJson,
  isGeminiQuotaError,
  type GeminiStructuredApiFamily,
  type GeminiStructuredRequestShape,
} from "../src/gemini";
import {
  IDENTITY_GEOMETRY_COMPACT_PROMPT_SUFFIX,
  IDENTITY_GEOMETRY_COMPACT_SCHEMA,
  IDENTITY_GEOMETRY_PROMPT,
  normalizeIdentityGeometryCompactResponse,
  parseIdentityGeometry,
  type GeometryCropVisibility,
  type IdentityGeometryAnalysis,
} from "../src/identityGeometry";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import type { Env } from "../src/types";
import { makeAnalysis } from "./helpers";

const RUN = process.env.RUN_LIVE_GEMINI_CONTRACT_CANARY === "1";
const MODEL = "gemini-3.6-flash";
const MAX_CALLS = 3;
const OUTPUT_ROOT = resolve("evaluation-artifacts/gemini-contract-canary-20260904");
const CROP_ROOT = resolve("evaluation-artifacts/head-crop-20260903");

const MINIMAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as const;

const VISUAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { hairVisible: { type: "boolean" } },
  required: ["hairVisible"],
} as const;

type Outcome = "success" | "failure" | "not attempted";

interface AttemptRecord {
  callId: string;
  canary: 1 | 2 | 3;
  purpose: string;
  apiFamily: GeminiStructuredApiFamily;
  apiVersion: "v1beta";
  method: "models.generateContent" | "interactions.create";
  model: string;
  imageCount: number;
  imageMime: string[];
  imageBytes: number[];
  imageBase64Chars: number[];
  imageMagicMatchesMime: boolean[];
  textBytes: number;
  schemaProperties: number;
  schemaRequired: number;
  schemaDepth: number;
  schemaBytes: number | null;
  schemaEnums: number;
  schemaDescriptionChars: number;
  totalSerializedBytes: number;
  httpStatus: number | null;
  providerCode: number | null;
  providerStatus: string | null;
  outcome: Exclude<Outcome, "not attempted">;
  fieldViolations: Array<{ field: string; description: string }>;
  quota: boolean;
  responseContractValid: boolean;
}

interface CanaryManifest {
  generatedAt: string;
  authorizedMax: 3;
  attempted: number;
  success: number;
  http400: number;
  quota: number;
  otherFailures: number;
  currentProductionAtStart: {
    sdkPackage: "none (raw fetch)";
    sdkVersion: "not applicable";
    apiFamily: "generateContent";
    apiVersion: "v1beta";
    method: "models.generateContent";
    model: "gemini-3.6-flash";
  };
  canaries: Record<"1" | "2" | "3", { purpose: string; result: Outcome; callIds: string[] }>;
  attempts: AttemptRecord[];
  rootCause: "API contract" | "multimodal serialization" | "geometry schema complexity" | "geometry measurement" | "still unknown";
  geometry?: Record<string, unknown>;
  pixelProvenance?: Record<string, unknown>;
}

function jpegDataUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

function responseObject(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const response = (result as Record<string, unknown>).response;
  if (typeof response !== "string") return null;
  try {
    const parsed = JSON.parse(response) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function visibilityFor(crops: Awaited<ReturnType<typeof createIdentityCrops>>): GeometryCropVisibility {
  if (!crops) throw new Error("Curly identity crops are required");
  return {
    cropClippingKnown: crops.diagnostics.cropMode !== "center_fallback",
    sourceClippingKnown: crops.diagnostics.quality.sourceClippingKnown,
    crownClipped: crops.diagnostics.cropClipping.top,
    leftHairClipped: crops.diagnostics.cropClipping.left,
    rightHairClipped: crops.diagnostics.cropClipping.right,
    chinClipped: crops.diagnostics.cropClipping.bottom,
    leftEarClipped: crops.diagnostics.leftEarClipped,
    rightEarClipped: crops.diagnostics.rightEarClipped,
    sourceCrownClipped: crops.diagnostics.sourceClipping.top,
    sourceLeftHairClipped: crops.diagnostics.sourceClipping.left,
    sourceRightHairClipped: crops.diagnostics.sourceClipping.right,
    sourceChinClipped: crops.diagnostics.sourceClipping.bottom,
  };
}

function geometrySummary(geometry: IdentityGeometryAnalysis): Record<string, unknown> {
  const peak = (region: IdentityGeometryAnalysis["majorVolumePeaks"][number]["region"]) => {
    const value = geometry.majorVolumePeaks.find((candidate) => candidate.region === region);
    return value ? {
      evidence: value.evidence,
      confidence: value.confidence,
      sourceAgreement: "wide-head direct",
      protrusion: value.protrusion,
      verticalCenter: value.verticalCenter,
      verticalExtent: value.verticalExtent,
    } : { evidence: "not returned", confidence: 0, sourceAgreement: "absent" };
  };
  return {
    crown: { evidence: geometry.crown.evidence, confidence: geometry.crown.confidence, sourceAgreement: "wide-head direct" },
    crown_left: { evidence: geometry.crown.leftEvidence, confidence: geometry.crown.leftConfidence, sourceAgreement: "wide-head direct" },
    side_left: peak("side_left"),
    lower_left: peak("lower_left"),
    side_right: peak("side_right"),
    lower_right: peak("lower_right"),
    fringe: { evidence: geometry.fringe.evidence, confidence: geometry.fringe.confidence, sourceAgreement: "wide-head direct", peaks: geometry.fringe.peaks, direction: geometry.fringe.direction },
  };
}

describe.skipIf(!RUN)("bounded Gemini API contract canaries", () => {
  it("isolates structured transport, image transport, and compact geometry in at most three calls", async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is required for this explicitly authorized live canary");
    const env = {
      GEMINI_API_KEY: apiKey,
      VISION_MODEL: MODEL,
      GEMINI_STRUCTURED_TIMEOUT_MS: process.env.LIVE_STRUCTURED_TIMEOUT_MS ?? "45000",
    } as Env;
    const source = new Uint8Array(await readFile(resolve(CROP_ROOT, "source-cache", "curly-hair.jpg")));
    const baseAnalysis = makeAnalysis();
    const analysis = makeAnalysis({
      observed: { ...baseAnalysis.observed, hair: "asymmetric full blonde curls with visible viewer-left crown, side and lower masses" },
      renderHints: {
        ...baseAnalysis.renderHints,
        hairTexture: "curly",
        hairVolume: "full",
        hairSilhouette: "tousled",
        overallHairLength: "jaw",
        sideHairLength: "jaw",
        sideHairShape: "flared",
        sideHairAsymmetry: "left",
        bangs: "none",
        bangsLength: "none",
      },
    });
    const crops = await createIdentityCrops(jpegDataUrl(source), null, {
      hairTexture: "curly",
      hairVolume: "full",
      overallHairLength: "jaw",
      sideHairAsymmetry: "left",
    });
    expect(crops).not.toBeNull();
    if (!crops) throw new Error("Curly identity crop creation failed before any provider call");
    const cropVisibility = visibilityFor(crops);
    const manifest: CanaryManifest = {
      generatedAt: new Date().toISOString(),
      authorizedMax: 3,
      attempted: 0,
      success: 0,
      http400: 0,
      quota: 0,
      otherFailures: 0,
      currentProductionAtStart: {
        sdkPackage: "none (raw fetch)",
        sdkVersion: "not applicable",
        apiFamily: "generateContent",
        apiVersion: "v1beta",
        method: "models.generateContent",
        model: MODEL,
      },
      canaries: {
        "1": { purpose: "minimal text-only structured output", result: "not attempted", callIds: [] },
        "2": { purpose: "one image plus minimal structured output", result: "not attempted", callIds: [] },
        "3": { purpose: "two-image compact real geometry", result: "not attempted", callIds: [] },
      },
      attempts: [],
      rootCause: "still unknown",
    };
    await mkdir(OUTPUT_ROOT, { recursive: true });
    const persist = async () => writeFile(resolve(OUTPUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await persist();

    const call = async (
      callId: string,
      canary: 1 | 2 | 3,
      purpose: string,
      apiFamily: GeminiStructuredApiFamily,
      images: string[],
      prompt: string,
      schema: unknown,
      maxOutputTokens: number,
    ): Promise<{ ok: true; payload: Record<string, unknown> | null } | { ok: false; error: unknown }> => {
      if (manifest.attempted >= MAX_CALLS) throw new Error("Gemini canary hard budget exceeded before network dispatch");
      manifest.attempted++;
      manifest.canaries[String(canary) as "1" | "2" | "3"].callIds.push(callId);
      let shape: GeminiStructuredRequestShape | null = null;
      try {
        const result = await generateGeminiStructuredJson(env, {
          model: MODEL,
          apiFamily,
          imageDataUrls: images,
          imageLabels: images.length === 1
            ? ["Wider head crop:"]
            : images.length === 2
              ? ["Tight face crop (facial landmark coordinate space):", "Wider head crop (hair/head coordinate space):"]
              : undefined,
          prompt,
          responseSchema: schema,
          maxOutputTokens,
          allowWorkersAiFallback: false,
          onRequestShape: (value) => { shape = value; },
        });
        if (!shape) throw new Error("Request shape checkpoint was not produced");
        const payload = responseObject(result);
        manifest.attempts.push({
          callId, canary, purpose, apiFamily: shape.apiFamily, apiVersion: shape.apiVersion,
          method: shape.endpointMethod, model: shape.model, imageCount: shape.imageParts,
          imageMime: shape.imageMimeTypes, imageBytes: shape.imageRawBytes,
          imageBase64Chars: shape.imageBase64Chars, imageMagicMatchesMime: shape.imageMagicMatchesMime,
          textBytes: shape.promptBytes, schemaProperties: shape.schema.propertyCount,
          schemaRequired: shape.schema.requiredCount, schemaDepth: shape.schema.depth,
          schemaBytes: shape.schema.serializedBytes, schemaEnums: shape.schema.enumValueCount,
          schemaDescriptionChars: shape.schema.descriptionChars,
          totalSerializedBytes: shape.serializedBytes, httpStatus: 200, providerCode: null,
          providerStatus: null, outcome: "success", fieldViolations: [], quota: false,
          responseContractValid: payload !== null,
        });
        manifest.success++;
        manifest.canaries[String(canary) as "1" | "2" | "3"].result = "success";
        await persist();
        return { ok: true, payload };
      } catch (error) {
        if (!shape && error instanceof GeminiApiError) shape = error.requestShape ?? null;
        const diagnostic = geminiProviderErrorDiagnostic(error);
        const quota = isGeminiQuotaError(error);
        if (diagnostic.httpStatus === 400) manifest.http400++;
        else if (quota) manifest.quota++;
        else manifest.otherFailures++;
        manifest.attempts.push({
          callId, canary, purpose,
          apiFamily: shape?.apiFamily ?? apiFamily,
          apiVersion: shape?.apiVersion ?? "v1beta",
          method: shape?.endpointMethod ?? (apiFamily === "interactions" ? "interactions.create" : "models.generateContent"),
          model: shape?.model ?? MODEL,
          imageCount: shape?.imageParts ?? images.length,
          imageMime: shape?.imageMimeTypes ?? [],
          imageBytes: shape?.imageRawBytes ?? [],
          imageBase64Chars: shape?.imageBase64Chars ?? [],
          imageMagicMatchesMime: shape?.imageMagicMatchesMime ?? [],
          textBytes: shape?.promptBytes ?? new TextEncoder().encode(prompt).byteLength,
          schemaProperties: shape?.schema.propertyCount ?? 0,
          schemaRequired: shape?.schema.requiredCount ?? 0,
          schemaDepth: shape?.schema.depth ?? 0,
          schemaBytes: shape?.schema.serializedBytes ?? null,
          schemaEnums: shape?.schema.enumValueCount ?? 0,
          schemaDescriptionChars: shape?.schema.descriptionChars ?? 0,
          totalSerializedBytes: shape?.serializedBytes ?? 0,
          httpStatus: diagnostic.httpStatus,
          providerCode: diagnostic.providerCode,
          providerStatus: diagnostic.providerStatus,
          outcome: "failure",
          fieldViolations: diagnostic.fieldViolations,
          quota,
          responseContractValid: false,
        });
        manifest.canaries[String(canary) as "1" | "2" | "3"].result = "failure";
        await persist();
        return { ok: false, error };
      }
    };

    const first = await call(
      "canary-1-generate-content",
      1,
      "current production path: minimal text-only structured output",
      "generateContent",
      [],
      "Return ok=true.",
      MINIMAL_SCHEMA,
      64,
    );

    let family: GeminiStructuredApiFamily = "generateContent";
    if (!first.ok) {
      const diagnostic = geminiProviderErrorDiagnostic(first.error);
      if (diagnostic.httpStatus !== 400 || diagnostic.providerStatus !== "INVALID_ARGUMENT") {
        manifest.rootCause = "still unknown";
        await persist();
        expect(first.ok, diagnostic.message).toBe(true);
        return;
      }
      const corrected = await call(
        "canary-1-interactions-contract-correction",
        1,
        "official Interactions contract: minimal text-only structured output",
        "interactions",
        [],
        "Return ok=true.",
        MINIMAL_SCHEMA,
        64,
      );
      if (!corrected.ok || corrected.payload?.ok !== true) {
        manifest.rootCause = "API contract";
        await persist();
        expect(corrected.ok, corrected.ok ? "Invalid minimal response" : geminiProviderErrorDiagnostic(corrected.error).message).toBe(true);
        return;
      }
      family = "interactions";
      manifest.rootCause = "API contract";
    } else {
      expect(first.payload).toEqual({ ok: true });
    }

    const second = await call(
      "canary-2-image-structured",
      2,
      "one wide-head PNG plus minimal structured output",
      family,
      [crops.headDataUrl],
      "Inspect the supplied image and report whether hair is visible.",
      VISUAL_SCHEMA,
      64,
    );
    if (!second.ok || typeof second.payload?.hairVisible !== "boolean") {
      manifest.rootCause = family === "interactions" && !first.ok ? "API contract" : "multimodal serialization";
      await persist();
      expect(second.ok, second.ok ? "Invalid visual response" : geminiProviderErrorDiagnostic(second.error).message).toBe(true);
      return;
    }

    if (manifest.attempted >= MAX_CALLS) {
      // The corrected Canary 1 consumed the spare request. Transport and one-
      // image composition are now proven; compact geometry remains unattempted.
      await persist();
      expect(manifest.attempted).toBe(MAX_CALLS);
      return;
    }

    const third = await call(
      "canary-3-compact-geometry",
      3,
      "tight-face and wide-head PNGs plus compact real geometry",
      family,
      [crops.faceDataUrl, crops.headDataUrl],
      `${IDENTITY_GEOMETRY_PROMPT}\n\nP5 identity cues to measure faithfully: asymmetric full blonde curls and the visible viewer-left side/lower masses.\n\n${IDENTITY_GEOMETRY_COMPACT_PROMPT_SUFFIX}`,
      IDENTITY_GEOMETRY_COMPACT_SCHEMA,
      2600,
    );
    if (!third.ok) {
      manifest.rootCause = "geometry schema complexity";
      await persist();
      return;
    }
    const normalized = third.payload
      ? normalizeIdentityGeometryCompactResponse(third.payload, cropVisibility)
      : null;
    const geometry = normalized ? parseIdentityGeometry(normalized) : null;
    if (!geometry) {
      manifest.rootCause = "geometry measurement";
      await persist();
      expect(geometry, "Compact response did not normalize into valid rich geometry").not.toBeNull();
      return;
    }
    const measuredAnalysis = makeAnalysis({
      ...analysis,
      identityGeometry: geometry,
    });
    const plans = buildIdentityPixelPlans(measuredAnalysis);
    const volumePixels = Object.fromEntries(
      ["side_left", "lower_left"].map((region) => {
        const group = plans.hairPlan.structure.groups.find((candidate) => candidate.id === `curl-lobe-${region.replace("_", "-")}`);
        return [region, {
          measurementPresent: geometry.majorVolumePeaks.some((peak) => peak.region === region),
          quantized: plans.facePixelPlan.layout.majorVolumePeaks.find((peak) => peak.region === region) ?? null,
          groupId: group?.id ?? null,
          minecraftHeadPixels: group?.points ?? [],
          reachedMinecraftPixels: Boolean(group?.points.length),
        }];
      }),
    );
    manifest.geometry = geometrySummary(geometry);
    manifest.pixelProvenance = {
      validatorPassed: true,
      quantizationSource: plans.facePixelPlan.source,
      hairStructureSource: plans.hairPlan.structure.source,
      headIdentityGeometryProvenance: plans.headIdentityPlan.geometryProvenance,
      volumePixels,
    };
    manifest.rootCause = "geometry measurement";
    await persist();
    expect(manifest.attempted).toBeLessThanOrEqual(MAX_CALLS);
  }, 180_000);
});
