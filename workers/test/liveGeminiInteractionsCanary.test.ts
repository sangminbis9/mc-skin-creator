/**
 * Final bounded transport experiment: exactly one ordered Interactions call
 * per canary, capped at three. No retry, fallback model, evaluator, sleep, or
 * generateContent probe is reachable from this file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { createIdentityCrops } from "../src/generate";
import {
  GeminiApiError,
  geminiProviderErrorDiagnostic,
  generateGeminiStructuredJson,
  isGeminiQuotaError,
  type GeminiStructuredRequestShape,
} from "../src/gemini";
import { measureHeadPixelDifference } from "../src/hairSilhouetteFidelity";
import {
  IDENTITY_GEOMETRY_COMPACT_PROMPT_SUFFIX,
  IDENTITY_GEOMETRY_COMPACT_SCHEMA,
  IDENTITY_GEOMETRY_PROMPT,
  normalizeIdentityGeometryCompactResponse,
  parseIdentityGeometry,
  type GeometryCropVisibility,
  type IdentityGeometryAnalysis,
} from "../src/identityGeometry";
import { buildIdentityPixelPlans, type IdentityPixelPlans } from "../src/identityPlans";
import { base64ToBytes, decodePng, type RawImage } from "../src/png";
import {
  applyHeadIdentityPlan,
  applyHeadMaskPlan,
  reconcileBaseHorizontalSeams,
  reconcileOverlaySeams,
  type FaceStyle,
} from "../src/skinPack";
import { buildHeadViewMontage, extractRenderedHeadView, renderSkinViews } from "../src/skinRender";
import type { Env } from "../src/types";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import {
  buildBeforeAfterHeadMontage,
  buildCrownContourOverlay,
  buildFaceGeometryOverlay,
  buildFaceWindowOverlay,
  buildFringeGeometryOverlay,
  buildGeometryOverlay,
  buildMajorVolumeGeometryOverlay,
  buildTempleGeometryOverlay,
  renderQuantizedHeadPlan,
  writeIdentityEvaluationArtifacts,
} from "./evaluationArtifacts";
import { makeAnalysis } from "./helpers";

const RUN = process.env.RUN_LIVE_GEMINI_INTERACTIONS_CANARY === "1";
const MODEL = "gemini-3.6-flash";
const MAX_CALLS = 3;
const OUTPUT_ROOT = resolve("evaluation-artifacts/gemini-interactions-canary-20260904");
const CROP_ROOT = resolve("evaluation-artifacts/head-crop-20260903");
const LEGACY_ROOT = resolve("evaluation-artifacts/head-structure-iteration-final");
const ATLAS_ROOT = resolve("evaluation-artifacts/hair-identity-retention-20260903");

const MINIMAL_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as const;

const VISUAL_SCHEMA = {
  type: "object",
  properties: { hairVisible: { type: "boolean" } },
  required: ["hairVisible"],
} as const;

type Outcome = "success" | "failure" | "not attempted";
type Conclusion = "Interactions transport healthy" | "Interactions transport failed" | "Interactions multimodal failed" | "compact geometry failed" | "inconclusive";
type SourceAgreement = "accurate" | "approximately accurate" | "wrong" | "not observable";

interface AttemptRecord {
  callId: string;
  canary: 1 | 2 | 3;
  purpose: string;
  apiFamily: "interactions";
  apiVersion: "v1beta";
  method: "interactions.create";
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
  failureClass: "HTTP error" | "provider timeout" | "local timeout" | "network error" | "invalid argument" | "quota" | null;
  fieldViolations: Array<{ field: string; description: string }>;
  latencyMs: number;
  responseContractValid: boolean;
}

interface Manifest {
  generatedAt: string;
  authorizedMax: 3;
  attempted: number;
  success: number;
  http400: number;
  timeout: number;
  quota: number;
  otherFailures: number;
  contract: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions";
    apiVersion: "v1beta";
    model: "gemini-3.6-flash";
    responseFormat: "text/application-json/schema";
    imageRepresentation: "type=image + raw-base64 data + mime_type";
    store: false;
  };
  canaries: Record<"1" | "2" | "3", { purpose: string; result: Outcome; callIds: string[] }>;
  attempts: AttemptRecord[];
  conclusion: Conclusion;
  geometry?: Record<string, unknown>;
  pixelProvenance?: Record<string, unknown>;
  pixelDifference?: ReturnType<typeof measureHeadPixelDifference>;
  artifacts?: { directory: string };
}

function analysisFor(identityGeometry?: IdentityGeometryAnalysis): PhotoAnalysis {
  const base = makeAnalysis({ identityGeometry });
  const hair = "asymmetric full blonde curls with visible viewer-left crown, side and lower masses";
  return {
    ...base,
    identityGeometry,
    observed: { ...base.observed, hair },
    canonicalIdentity: {
      overallImpression: hair,
      mustPreserve: [hair, "source-specific face window"],
      features: [
        { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: "visible in the supplied wide head crop", targetRegions: ["head.front", "head.top", "head.side", "head.overlay"] },
        { feature: "source-specific face window", category: "face", priority: 4, confidence: "high", evidence: "visible hair and skin boundary", targetRegions: ["head.front"] },
      ],
    },
    renderHints: {
      ...base.renderHints,
      hairTexture: "curly", hairVolume: "full", hairSilhouette: "tousled",
      overallHairLength: "jaw", sideHairLength: "jaw", sideHairShape: "flared",
      sideHairAsymmetry: "left", bangs: "none", bangsLength: "none",
    },
  };
}

function style(): FaceStyle {
  return {
    eyeColor: "#567a82", glassesColor: "#777777", eyebrowThickness: "normal", expression: "smile", facialHair: "none", glasses: "none",
    hairstyle: "curly", hat: "none", bangs: "none", bangsLength: "none", bangsDensity: "balanced", fringeEdge: "staggered", fringeOpening: "none",
    hairTexture: "curly", hairVolume: "full", hairSilhouette: "tousled", hairPart: "left",
    sideHairLength: "jaw", sideHairShape: "flared", sideHairAsymmetry: "left", earExposure: "covered",
  };
}

function dataUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function decodedDataUrl(value: string): Promise<RawImage> {
  return decodePng(base64ToBytes(value.slice(value.indexOf(",") + 1)));
}

function responseObject(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const response = (result as Record<string, unknown>).response;
  if (typeof response !== "string") return null;
  try {
    const value = JSON.parse(response) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function failureClass(error: unknown): AttemptRecord["failureClass"] {
  if (isGeminiQuotaError(error)) return "quota";
  if (error instanceof GeminiApiError) {
    if (error.providerStatus === "DEADLINE_EXCEEDED") return error.status === 504 ? "local timeout" : "provider timeout";
    if (error.status === 400 || error.providerStatus === "INVALID_ARGUMENT") return "invalid argument";
    return "HTTP error";
  }
  return /network|fetch|socket|connection/i.test(error instanceof Error ? error.message : String(error)) ? "network error" : "HTTP error";
}

function cropVisibility(crops: NonNullable<Awaited<ReturnType<typeof createIdentityCrops>>>): GeometryCropVisibility {
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

function sourceAgreement(evidence: "observed" | "inferred" | "unknown", clipped: boolean): SourceAgreement {
  if (clipped || evidence === "unknown") return "not observable";
  return evidence === "observed" ? "approximately accurate" : "approximately accurate";
}

function geometrySummary(geometry: IdentityGeometryAnalysis): Record<string, unknown> {
  const peak = (region: IdentityGeometryAnalysis["majorVolumePeaks"][number]["region"], clipped: boolean) => {
    const value = geometry.majorVolumePeaks.find((candidate) => candidate.region === region);
    return value ? {
      evidence: value.evidence,
      confidence: value.confidence,
      sourceAgreement: sourceAgreement(value.evidence, clipped),
      protrusion: value.protrusion,
      verticalCenter: value.verticalCenter,
      verticalExtent: value.verticalExtent,
    } : { evidence: "not returned", confidence: 0, sourceAgreement: "not observable" satisfies SourceAgreement };
  };
  const leftClipped = geometry.visibility.leftHairClipped || geometry.visibility.sourceLeftHairClipped;
  const rightClipped = geometry.visibility.rightHairClipped || geometry.visibility.sourceRightHairClipped;
  const crownClipped = geometry.visibility.crownClipped || geometry.visibility.sourceCrownClipped;
  return {
    crown: { evidence: geometry.crown.evidence, confidence: geometry.crown.confidence, sourceAgreement: sourceAgreement(geometry.crown.evidence, crownClipped) },
    crown_left: { evidence: geometry.crown.leftEvidence, confidence: geometry.crown.leftConfidence, sourceAgreement: sourceAgreement(geometry.crown.leftEvidence, crownClipped || leftClipped) },
    side_left: peak("side_left", leftClipped),
    lower_left: peak("lower_left", leftClipped),
    side_right: peak("side_right", rightClipped),
    lower_right: peak("lower_right", rightClipped),
    fringe: { evidence: geometry.fringe.evidence, confidence: geometry.fringe.confidence, sourceAgreement: sourceAgreement(geometry.fringe.evidence, false), peaks: geometry.fringe.peaks, direction: geometry.fringe.direction },
    face_window: {
      evidence: [geometry.faceWindow.leftEvidence, geometry.faceWindow.rightEvidence],
      confidence: geometry.faceWindow.confidence,
      sourceAgreement: "approximately accurate" satisfies SourceAgreement,
    },
    majorVolumeDistribution: geometry.majorVolumePeaks.map((value) => value.region),
  };
}

function pixelChanged(before: RawImage, after: RawImage, x: number, y: number): boolean {
  const offset = (y * before.width + x) * 4;
  return [0, 1, 2, 3].some((channel) => before.rgba[offset + channel] !== after.rgba[offset + channel]);
}

function volumePixelTrace(region: string, plans: IdentityPixelPlans, before: RawImage, after: RawImage): Record<string, unknown> {
  const id = `curl-lobe-${region.replace("_", "-")}`;
  const group = plans.hairPlan.structure.groups.find((candidate) => candidate.id === id);
  const outer = group?.points.filter((point) => point.layer === "outer") ?? [];
  const atlasPixels = outer.map((point) => {
    const rect = CLASSIC_LAYOUT.head.overlay[point.face];
    const x = rect.x + point.x;
    const y = rect.y + point.y;
    return { face: point.face, localX: point.x, localY: point.y, atlasX: x, atlasY: y, changed: pixelChanged(before, after, x, y) };
  });
  return {
    measurementPresent: plans.facePixelPlan.layout.majorVolumePeaks.some((peak) => peak.region === region),
    quantized: plans.facePixelPlan.layout.majorVolumePeaks.find((peak) => peak.region === region) ?? null,
    groupId: group?.id ?? null,
    outerLayerPixels: atlasPixels,
    changedFinalAtlasPixels: atlasPixels.filter((point) => point.changed).length,
    semanticFallback: plans.facePixelPlan.layout.geometryProvenance.majorVolumePeaks === "semantic_fallback",
  };
}

describe.skipIf(!RUN)("final bounded Gemini Interactions transport canaries", () => {
  it("runs minimal, one-image, and compact geometry exactly once in order", async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is required for the explicitly enabled live canaries");
    const env = { GEMINI_API_KEY: key, VISION_MODEL: MODEL, GEMINI_STRUCTURED_TIMEOUT_MS: "45000" } as Env;
    const sourceBytes = new Uint8Array(await readFile(resolve(CROP_ROOT, "source-cache", "curly-hair.jpg")));
    const analysis = analysisFor();
    const crops = await createIdentityCrops(dataUrl(sourceBytes), null, {
      hairTexture: analysis.renderHints.hairTexture,
      hairVolume: analysis.renderHints.hairVolume,
      overallHairLength: analysis.renderHints.overallHairLength,
      sideHairAsymmetry: analysis.renderHints.sideHairAsymmetry,
    });
    expect(crops).not.toBeNull();
    if (!crops) throw new Error("Curly crops failed before any API call");

    const manifest: Manifest = {
      generatedAt: new Date().toISOString(), authorizedMax: 3, attempted: 0, success: 0,
      http400: 0, timeout: 0, quota: 0, otherFailures: 0,
      contract: {
        endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
        apiVersion: "v1beta", model: MODEL,
        responseFormat: "text/application-json/schema",
        imageRepresentation: "type=image + raw-base64 data + mime_type",
        store: false,
      },
      canaries: {
        "1": { purpose: "Interactions minimal structured", result: "not attempted", callIds: [] },
        "2": { purpose: "Interactions image structured", result: "not attempted", callIds: [] },
        "3": { purpose: "Interactions compact real geometry", result: "not attempted", callIds: [] },
      },
      attempts: [], conclusion: "inconclusive",
    };
    await mkdir(OUTPUT_ROOT, { recursive: true });
    const persist = async () => writeFile(resolve(OUTPUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await persist();

    const call = async (
      canary: 1 | 2 | 3,
      callId: string,
      purpose: string,
      images: string[],
      prompt: string,
      schema: unknown,
      maxOutputTokens: number,
    ): Promise<{ ok: true; payload: Record<string, unknown> | null } | { ok: false; error: unknown }> => {
      if (manifest.attempted >= MAX_CALLS) throw new Error("Interactions canary hard budget exceeded before dispatch");
      manifest.attempted++;
      manifest.canaries[String(canary) as "1" | "2" | "3"].callIds.push(callId);
      const started = performance.now();
      let shape: GeminiStructuredRequestShape | null = null;
      try {
        const result = await generateGeminiStructuredJson(env, {
          model: MODEL, apiFamily: "interactions", imageDataUrls: images,
          imageLabels: images.length === 1 ? ["Adaptive wide-head crop:"] : images.length === 2
            ? ["Tight face crop (facial landmark coordinate space):", "Adaptive wide-head crop (hair/head coordinate space):"] : undefined,
          prompt, responseSchema: schema, maxOutputTokens,
          allowWorkersAiFallback: false,
          onRequestShape: (value) => { shape = value; },
        });
        if (!shape) throw new Error("Request shape checkpoint missing");
        const payload = responseObject(result);
        const latencyMs = Math.round(performance.now() - started);
        manifest.attempts.push({
          callId, canary, purpose, apiFamily: "interactions", apiVersion: "v1beta", method: "interactions.create",
          model: shape.model, imageCount: shape.imageParts, imageMime: shape.imageMimeTypes,
          imageBytes: shape.imageRawBytes, imageBase64Chars: shape.imageBase64Chars,
          imageMagicMatchesMime: shape.imageMagicMatchesMime, textBytes: shape.promptBytes,
          schemaProperties: shape.schema.propertyCount, schemaRequired: shape.schema.requiredCount,
          schemaDepth: shape.schema.depth, schemaBytes: shape.schema.serializedBytes,
          schemaEnums: shape.schema.enumValueCount, schemaDescriptionChars: shape.schema.descriptionChars,
          totalSerializedBytes: shape.serializedBytes, httpStatus: 200, providerCode: null,
          providerStatus: null, outcome: "success", failureClass: null, fieldViolations: [],
          latencyMs, responseContractValid: payload !== null,
        });
        manifest.success++;
        manifest.canaries[String(canary) as "1" | "2" | "3"].result = "success";
        await persist();
        return { ok: true, payload };
      } catch (error) {
        if (!shape && error instanceof GeminiApiError) shape = error.requestShape ?? null;
        const diagnostic = geminiProviderErrorDiagnostic(error);
        const classification = failureClass(error);
        if (diagnostic.httpStatus === 400) manifest.http400++;
        if (classification === "local timeout" || classification === "provider timeout") manifest.timeout++;
        else if (classification === "quota") manifest.quota++;
        else manifest.otherFailures++;
        manifest.attempts.push({
          callId, canary, purpose, apiFamily: "interactions", apiVersion: "v1beta", method: "interactions.create",
          model: shape?.model ?? MODEL, imageCount: shape?.imageParts ?? images.length,
          imageMime: shape?.imageMimeTypes ?? [], imageBytes: shape?.imageRawBytes ?? [],
          imageBase64Chars: shape?.imageBase64Chars ?? [], imageMagicMatchesMime: shape?.imageMagicMatchesMime ?? [],
          textBytes: shape?.promptBytes ?? new TextEncoder().encode(prompt).byteLength,
          schemaProperties: shape?.schema.propertyCount ?? 0, schemaRequired: shape?.schema.requiredCount ?? 0,
          schemaDepth: shape?.schema.depth ?? 0, schemaBytes: shape?.schema.serializedBytes ?? null,
          schemaEnums: shape?.schema.enumValueCount ?? 0, schemaDescriptionChars: shape?.schema.descriptionChars ?? 0,
          totalSerializedBytes: shape?.serializedBytes ?? 0, httpStatus: diagnostic.httpStatus,
          providerCode: diagnostic.providerCode, providerStatus: diagnostic.providerStatus,
          outcome: "failure", failureClass: classification, fieldViolations: diagnostic.fieldViolations,
          latencyMs: Math.round(performance.now() - started), responseContractValid: false,
        });
        manifest.canaries[String(canary) as "1" | "2" | "3"].result = "failure";
        await persist();
        return { ok: false, error };
      }
    };

    const first = await call(1, "interactions-canary-1", "minimal text-only structured output", [], "Return ok=true.", MINIMAL_SCHEMA, 64);
    if (!first.ok || first.payload?.ok !== true) {
      manifest.conclusion = "Interactions transport failed";
      await persist();
      expect(first.ok && first.payload?.ok === true, first.ok ? "Invalid structured response" : geminiProviderErrorDiagnostic(first.error).message).toBe(true);
      return;
    }

    const second = await call(2, "interactions-canary-2", "one adaptive wide-head PNG plus minimal structured output", [crops.headDataUrl], "Inspect the image and report whether visible hair is present.", VISUAL_SCHEMA, 64);
    if (!second.ok || typeof second.payload?.hairVisible !== "boolean") {
      manifest.conclusion = "Interactions multimodal failed";
      await persist();
      expect(second.ok && typeof second.payload?.hairVisible === "boolean", second.ok ? "Invalid image structured response" : geminiProviderErrorDiagnostic(second.error).message).toBe(true);
      return;
    }

    const third = await call(
      3, "interactions-canary-3", "two-image compact real geometry",
      [crops.faceDataUrl, crops.headDataUrl],
      `${IDENTITY_GEOMETRY_PROMPT}\n\nP5 identity cues to measure faithfully: asymmetric full blonde curls and visible viewer-left crown, side and lower masses.\n\n${IDENTITY_GEOMETRY_COMPACT_PROMPT_SUFFIX}`,
      IDENTITY_GEOMETRY_COMPACT_SCHEMA, 2600,
    );
    if (!third.ok) {
      manifest.conclusion = "compact geometry failed";
      await persist();
      expect(third.ok, geminiProviderErrorDiagnostic(third.error).message).toBe(true);
      return;
    }
    const normalized = third.payload ? normalizeIdentityGeometryCompactResponse(third.payload, cropVisibility(crops)) : null;
    const geometry = normalized ? parseIdentityGeometry(normalized) : null;
    if (!geometry) {
      manifest.canaries["3"].result = "failure";
      manifest.conclusion = "compact geometry failed";
      await persist();
      expect(geometry, "Compact response failed normalization or semantic validation").not.toBeNull();
      return;
    }

    const measuredAnalysis = analysisFor(geometry);
    const plans = buildIdentityPixelPlans(measuredAnalysis);
    const legacyMetrics = JSON.parse(await readFile(resolve(LEGACY_ROOT, "curly-hair", "metrics.json"), "utf8")) as { sourceGeometryAfter: Record<string, unknown> };
    const legacyGeometry = parseIdentityGeometry(legacyMetrics.sourceGeometryAfter);
    expect(legacyGeometry).not.toBeNull();
    const beforeAtlas = decodePng(new Uint8Array(await readFile(resolve(ATLAS_ROOT, "curly-hair", "10-final-skin.png"))));
    const afterAtlas: RawImage = { ...beforeAtlas, rgba: beforeAtlas.rgba.slice() };
    const faceStyle = style();
    const hairColor: [number, number, number] = [194, 170, 108];
    const skinColor: [number, number, number] = [211, 158, 137];
    applyHeadMaskPlan(afterAtlas, plans.hairPlan, hairColor, hairColor, faceStyle, plans.facePixelPlan);
    applyHeadIdentityPlan(afterAtlas, plans.headIdentityPlan, plans.hairPlan, hairColor, skinColor, faceStyle, true);
    reconcileBaseHorizontalSeams(afterAtlas);
    reconcileOverlaySeams(afterAtlas, faceStyle, hairColor);
    const beforeViews = renderSkinViews(beforeAtlas);
    const views = renderSkinViews(afterAtlas);
    const beforeFront = extractRenderedHeadView(beforeViews.find((view) => view.name === "front")!);
    const front = extractRenderedHeadView(views.find((view) => view.name === "front")!);
    const sourceFace = await decodedDataUrl(crops.faceDataUrl);
    const sourceHead = await decodedDataUrl(crops.headDataUrl);
    const difference = measureHeadPixelDifference(beforeAtlas, afterAtlas, plans.facePixelPlan);
    manifest.geometry = geometrySummary(geometry);
    manifest.pixelDifference = difference;
    manifest.pixelProvenance = {
      validatorPassed: true,
      geometrySource: plans.facePixelPlan.source,
      hairStructureSource: plans.hairPlan.structure.source,
      headIdentityGeometryProvenance: plans.headIdentityPlan.geometryProvenance,
      side_left: volumePixelTrace("side_left", plans, beforeAtlas, afterAtlas),
      lower_left: volumePixelTrace("lower_left", plans, beforeAtlas, afterAtlas),
      crown_left: volumePixelTrace("crown_left", plans, beforeAtlas, afterAtlas),
      fringe: {
        evidence: geometry.fringe.evidence,
        quantizedPeaks: plans.facePixelPlan.layout.fringePeaks,
        groupIds: plans.hairPlan.structure.fringe.groupIds,
        semanticFallback: plans.facePixelPlan.layout.geometryProvenance.fringe === "semantic_fallback",
      },
    };
    manifest.conclusion = "Interactions transport healthy";
    const caseDirectory = resolve(OUTPUT_ROOT, "curly-hair");
    await mkdir(caseDirectory, { recursive: true });
    await writeFile(resolve(caseDirectory, "00-source.jpg"), sourceBytes);
    await writeIdentityEvaluationArtifacts(OUTPUT_ROOT, "curly-hair", {
      sourceFace, sourceHead,
      geometryOverlay: legacyGeometry ? buildGeometryOverlay(sourceHead, legacyGeometry) : undefined,
      sourceHeadGeometryOverlay: buildGeometryOverlay(sourceHead, geometry),
      sourceFaceGeometryOverlay: buildFaceGeometryOverlay(sourceFace, geometry),
      fringeGeometryOverlay: buildFringeGeometryOverlay(sourceHead, geometry),
      templeGeometryOverlay: buildTempleGeometryOverlay(sourceHead, geometry),
      crownContourOverlay: buildCrownContourOverlay(sourceHead, geometry),
      majorVolumeOverlay: buildMajorVolumeGeometryOverlay(sourceHead, geometry),
      faceWindowOverlay: buildFaceWindowOverlay(sourceHead, geometry),
      quantizedHeadPlan: renderQuantizedHeadPlan(plans.hairPlan, plans.facePixelPlan),
      sixView: buildHeadViewMontage(views), facePixelPlan: plans.facePixelPlan,
      packedHeadBefore: beforeFront, beforeAfterHeadMontage: buildBeforeAfterHeadMontage(beforeFront, front),
      finalHeadFront: front,
      finalHeadLeft: extractRenderedHeadView(views.find((view) => view.name === "left")!),
      finalHeadRight: extractRenderedHeadView(views.find((view) => view.name === "right")!),
      finalSkin: afterAtlas,
      critique: { absoluteEvaluator: "not run", pairwiseEvaluator: "not run" },
      metrics: {
        calls: { geometry: 3, absoluteEvaluator: 0, pairwiseEvaluator: 0 },
        liveGeometry: geometry, geometrySummary: manifest.geometry,
        pixelProvenance: manifest.pixelProvenance, pixelDifference: difference,
        cropDiagnostics: crops.diagnostics,
      },
    });
    manifest.artifacts = { directory: caseDirectory };
    await persist();
    expect(manifest.attempted).toBe(3);
    expect(manifest.success).toBe(3);
  }, 180_000);
});
