import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractJson, runPhotoAnalysis, type PhotoAnalysis } from "../src/analysis";
import {
  FACE_MEASUREMENT_VALUES,
  resolveFaceMeasurements,
  type FaceMeasurementCue,
} from "../src/faceMeasurementEvidence";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { normalizeAnalysisForRendering } from "../src/generate";
import type { Env } from "../src/types";
import type { AnnotatedCase } from "./generalizationSupport";
import { safeProviderMessage } from "./primaryTransportSupport";

const RUN = process.env.RUN_FACE_MEASUREMENT_LIVE === "1";
const ROOT = resolve("evaluation-artifacts/face-measurement-live-20260908");
const SOURCE_ROOT = resolve("evaluation-artifacts/generalization-20260905/sources");
const MANIFEST = resolve("evaluation-artifacts/generalization-20260905/annotations.json");
const GROUND_TRUTH = resolve("evaluation-artifacts/face-quantization-generalization-20260907/after/summary.json");
const MODEL = "gemini-3.6-flash";
const CUES = Object.keys(FACE_MEASUREMENT_VALUES) as FaceMeasurementCue[];
type Agreement = "agree" | "approximately_agree" | "disagree" | "not_assessable";

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plainPlan = (analysis: PhotoAnalysis) => {
  const plan = structuredClone(buildFacePixelPlanVariants(normalizeAnalysisForRendering(analysis), 1)[0]);
  if (plan) delete plan.layout.measurementTrace;
  return plan;
};
const rawObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function manualValue(cue: FaceMeasurementCue, audit: Record<string, unknown> | null): string | undefined {
  if (!audit) return undefined;
  const key = cue === "expression" ? "mouthTopology" : cue;
  const value = audit[key];
  if (typeof value !== "string" || value === "unknown") return undefined;
  if (cue === "mouthWidth" && value === "compact") return "narrow";
  if (cue === "browSlope" && value === "soft") return undefined;
  return (FACE_MEASUREMENT_VALUES[cue] as readonly string[]).includes(value) && value !== "unknown" ? value : undefined;
}

const ordered: Partial<Record<FaceMeasurementCue, readonly string[]>> = {
  eyeSpacing: ["narrow", "medium", "wide"],
  eyeOpenness: ["narrow", "normal", "open"],
  eyeFootprint: ["compact", "medium", "wide"],
  browEyeDistance: ["close", "normal", "high"],
  mouthWidth: ["narrow", "medium", "wide"],
};
function agreement(cue: FaceMeasurementCue, provider: string, provenance: string, manual: string | undefined): Agreement {
  if (provenance !== "observed_categorical" || provider === "unknown" || !manual) return "not_assessable";
  if (provider === manual) return "agree";
  const scale = ordered[cue];
  if (scale && Math.abs(scale.indexOf(provider) - scale.indexOf(manual)) === 1) return "approximately_agree";
  return "disagree";
}

function confidenceBand(value: number): "<0.50" | "0.50-0.74" | "0.75-0.89" | ">=0.90" {
  if (value < 0.5) return "<0.50";
  if (value < 0.75) return "0.50-0.74";
  if (value < 0.9) return "0.75-0.89";
  return ">=0.90";
}

describe.skipIf(!RUN)("live primary face measurement coverage", () => {
  it("runs each frozen public photo through at most one real primary provider request", async () => {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    expect(apiKey, "GEMINI_API_KEY must be supplied through the process environment").toBeTruthy();
    await expect(stat(join(ROOT, "run-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const annotations = JSON.parse(await readFile(MANIFEST, "utf8")) as AnnotatedCase[];
    const cases = annotations.filter(c => !c.existing);
    expect(cases).toHaveLength(7);
    const previous = JSON.parse(await readFile(GROUND_TRUTH, "utf8")) as {
      cases: Record<string, { sourceAudit: Record<string, unknown> | null }>;
    };
    await mkdir(ROOT, { recursive: true });
    const results: Array<Record<string, unknown>> = [];
    let providerCalls = 0;
    let stoppedEarly = false;
    let stopReason: string | null = null;

    for (const photo of cases) {
      const bytes = await readFile(join(SOURCE_ROOT, `${photo.photoId}.jpg`));
      const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
      const originalFetch = globalThis.fetch;
      let firstProviderCallMade = false;
      let httpStatus: number | null = null;
      let providerCode: number | null = null;
      let providerStatus: string | null = null;
      let providerMessage: string | null = null;
      let endpointPath: string | null = null;
      let networkFailure: string | null = null;
      let rawAnalysis: Record<string, unknown> | null = null;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (firstProviderCallMade) throw new Error("LIVE_PROVIDER_RETRY_BLOCKED");
        firstProviderCallMade = true;
        providerCalls += 1;
        endpointPath = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
        try {
          const response = await originalFetch(input, init);
          httpStatus = response.status;
          const payload = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
          const error = rawObject(payload?.error);
          providerCode = typeof error?.code === "number" ? error.code : null;
          providerStatus = typeof error?.status === "string" ? error.status : null;
          providerMessage = safeProviderMessage(error?.message, [apiKey!]);
          const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
          const candidate = rawObject(candidates[0]);
          const content = rawObject(candidate?.content);
          const parts = Array.isArray(content?.parts) ? content.parts : [];
          const text = parts.map(part => rawObject(part)?.text).filter((part): part is string => typeof part === "string").join("");
          rawAnalysis = text ? extractJson(text) : null;
          return response;
        } catch (error) {
          networkFailure = error instanceof Error ? error.name : "unknown_error";
          throw error;
        }
      }) as typeof fetch;

      let result: Awaited<ReturnType<typeof runPhotoAnalysis>>;
      try {
        result = await runPhotoAnalysis({
          GEMINI_API_KEY: apiKey!,
          VISION_MODEL: MODEL,
          VISION_FALLBACK_MODEL: MODEL,
          GEMINI_STRUCTURED_TIMEOUT_MS: "45000",
        } as Env, dataUrl);
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(firstProviderCallMade).toBe(true);
      const transportOk = httpStatus !== null && httpStatus >= 200 && httpStatus < 300 && rawAnalysis !== null && result.ok;
      if (!transportOk) {
        stoppedEarly = true;
        stopReason = httpStatus === 400 ? "HTTP_400" : networkFailure ?? (!rawAnalysis ? "invalid_structured_response" : result.ok ? "unknown_transport_failure" : result.reason);
        results.push({
          id: photo.id, success: false, endpointPath, model: MODEL, actualProviderCalls: 1,
          httpStatus, providerCode, providerStatus, providerMessage, stopReason,
        });
      } else {
        const analysis = result.analysis;
        const rawEvidence = rawObject(rawAnalysis!.faceMeasurementEvidence);
        const rawCues = rawObject(rawEvidence?.cues);
        const evidence = analysis.faceMeasurementEvidence;
        const trace = resolveFaceMeasurements(analysis);
        const beforeAnalysis = structuredClone(analysis);
        delete beforeAnalysis.faceMeasurementEvidence;
        const before = plainPlan(beforeAnalysis);
        const after = plainPlan(analysis);
        const beforeHash = sha256(before);
        const afterHash = sha256(after);
        const manual = previous.cases[photo.id]?.sourceAudit ?? null;
        const cueResults = Object.fromEntries(CUES.map(cue => {
          const raw = rawObject(rawCues?.[cue]);
          const validated = evidence?.cues[cue] ?? { value: "unknown", provenance: "unknown", confidence: 0 };
          const ablated = structuredClone(analysis);
          if (ablated.faceMeasurementEvidence) {
            ablated.faceMeasurementEvidence.cues[cue] = { value: "unknown", provenance: "unknown", confidence: 0 };
          }
          const affectsPlan = sha256(plainPlan(ablated)) !== afterHash;
          const truth = manualValue(cue, manual);
          return [cue, {
            returned: Boolean(raw),
            raw: raw ? {
              value: typeof raw.value === "string" ? raw.value : "invalid",
              provenance: typeof raw.provenance === "string" ? raw.provenance : "invalid",
              confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : null,
            } : null,
            validated,
            eligibleAfterValidation: validated.provenance === "observed_categorical" && validated.value !== "unknown",
            quantizerConsumption: trace[cue].selected,
            affectsFacePixelPlan: affectsPlan,
            manualGroundTruth: truth ?? "not_assessable",
            agreement: agreement(cue, validated.value, validated.provenance, truth),
          }];
        }));
        const cueValues = Object.values(cueResults) as Array<{
          validated: { value: string; provenance: string; confidence: number };
          eligibleAfterValidation: boolean;
          affectsFacePixelPlan: boolean;
        }>;
        const changed = beforeHash !== afterHash;
        results.push({
          id: photo.id, success: true, endpointPath, model: MODEL, actualProviderCalls: 1,
          httpStatus, providerCode, providerStatus, providerMessage,
          rawEvidenceBlockReturned: Boolean(rawEvidence),
          referenceImageIndex: evidence?.referenceImageIndex ?? null,
          observedCategoricalCueCount: cueValues.filter(c => c.validated.provenance === "observed_categorical").length,
          inferredCueCount: cueValues.filter(c => c.validated.provenance === "inferred").length,
          unknownCueCount: cueValues.filter(c => c.validated.provenance === "unknown").length,
          eligibleCueCount: cueValues.filter(c => c.eligibleAfterValidation).length,
          productionInfluenceCueCount: cueValues.filter(c => c.affectsFacePixelPlan).length,
          facePixelPlanChanged: changed,
          cueResults,
          measurementTrace: trace,
          facePixelPlan: changed ? { before, after } : null,
        });
      }
      await writeFile(join(ROOT, "run-state.json"), JSON.stringify({
        model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta", providerCalls,
        stoppedEarly, stopReason, completedCaseIds: results.map(r => r.id), results,
      }, null, 2));
      if (stoppedEarly) break;
    }

    const successful = results.filter(r => r.success === true);
    const successfulCues = successful.flatMap(result => {
      const perCue = result.cueResults as Record<string, {
        raw: { provenance: string; confidence: number | null } | null;
        eligibleAfterValidation: boolean; affectsFacePixelPlan: boolean; agreement: Agreement;
      }>;
      return CUES.map(cue => ({ id: result.id, cue, ...perCue[cue] }));
    });
    const bands = ["<0.50", "0.50-0.74", "0.75-0.89", ">=0.90"] as const;
    const confidence = Object.fromEntries(bands.map(band => {
      const entries = successfulCues.filter(c => c.raw?.provenance === "observed_categorical" && c.raw.confidence !== null && confidenceBand(c.raw.confidence) === band);
      const assessable = entries.filter(c => c.agreement !== "not_assessable");
      return [band, {
        observed: entries.length, assessable: assessable.length,
        agree: assessable.filter(c => c.agreement === "agree").length,
        approximatelyAgree: assessable.filter(c => c.agreement === "approximately_agree").length,
        disagree: assessable.filter(c => c.agreement === "disagree").length,
      }];
    }));
    const cueCoverage = Object.fromEntries(CUES.map(cue => {
      const observable = cases.filter(c => manualValue(cue, previous.cases[c.id]?.sourceAudit ?? null) !== undefined).length;
      const entries = successfulCues.filter(c => c.cue === cue);
      return [cue, {
        eligibleObserved: entries.filter(c => c.eligibleAfterValidation).length,
        manuallyObservable: observable,
        productionInfluence: entries.filter(c => c.affectsFacePixelPlan).length,
      }];
    }));
    const assessed = successfulCues.filter(c => c.agreement !== "not_assessable");
    const summary = {
      classification: stoppedEarly ? "D_transport_failure" : "transport_works",
      model: MODEL, apiFamily: "generateContent", apiVersion: "v1beta",
      calls: { authorized: 7, primaryLive: providerCalls, successful: successful.length, geometry: 0, absolute: 0, pairwise: 0, interactions: 0 },
      stoppedEarly, stopReason,
      personCoverage: {
        peopleWithEligibleObservedCue: successful.filter(r => Number(r.eligibleCueCount) > 0).length,
        denominator: 7,
      },
      cueCoverage,
      productionUse: {
        affectedCases: successful.filter(r => r.facePixelPlanChanged === true).length,
        affectedCues: successfulCues.filter(c => c.affectsFacePixelPlan).length,
      },
      accuracy: {
        assessable: assessed.length,
        agree: assessed.filter(c => c.agreement === "agree").length,
        approximatelyAgree: assessed.filter(c => c.agreement === "approximately_agree").length,
        disagree: assessed.filter(c => c.agreement === "disagree").length,
      },
      confidence,
      cases: results,
      safety: {
        rawImagesStoredInJson: false, rawBase64Stored: false, apiKeyStored: false,
        fullProviderRequestStored: false, fullProviderResponseStored: false,
      },
    };
    await writeFile(join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
    expect(providerCalls).toBeLessThanOrEqual(7);
    expect(results).toHaveLength(stoppedEarly ? 1 : 7);
  }, 600_000);
});
