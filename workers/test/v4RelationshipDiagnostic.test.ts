import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validatePortraitRegion, validatePortraitRegionWithDiagnostics } from "../src/analysis";
import { validateStructuredLocalization, type StructuredLocalizationTrace } from "../src/compactPhotoAnalysisV4";
import auditWorker, { auditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";
import { createCurrentSourceV4State, runCurrentSourceV4, ANALYSIS_SHA, currentSourceV4Contract } from "./audit/currentSourceV4LocalizationLive";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { namedGemmaFixture, wireFixture } from "./compactV3Support";
import { makeAnalysis } from "./helpers";
import type { Env } from "../src/types";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sample = (width: number, height: number) => ({
  subjectBox: { left: 0, top: 0, right: 1, bottom: 1 },
  headBox: { left: 0, top: 0, right: width, bottom: height },
  faceBox: { left: 0, top: 0, right: .25, bottom: .2 }, confidence: .9,
});
const cases = [
  ["head_width_ratio", .25, .3],
  ["head_height_ratio", .3, .2],
  ["both_ratios", .25, .2],
] as const;
afterEach(() => vi.unstubAllGlobals());

describe("V4 read-only relationship diagnostic, synthetic provider fixtures only", () => {
  it("preserves public validation and inputs across exact boundaries and malformed cases", () => {
    const widths = [.001, .024, .1, .25, .25 * 1.02 - Number.EPSILON, .25 * 1.02, .25 * 1.02 + Number.EPSILON, .3, .9];
    const heights = [.01, .2, .2 * 1.08 - Number.EPSILON, .2 * 1.08, .2 * 1.08 + Number.EPSILON, .3, .9];
    const inputs: unknown[] = [null, undefined, "wrong", {}, [], { ...sample(.3, .3), confidence: NaN },
      { ...sample(.3, .3), headBox: { left: 0, top: 0, right: Infinity, bottom: .3 } },
      ...widths.flatMap(width => heights.map(height => sample(width, height)))];
    for (const value of inputs) {
      const before = structuredClone(value);
      const observed = validatePortraitRegionWithDiagnostics(value);
      expect(observed.validation).toEqual(validatePortraitRegion(value));
      expect(value).toEqual(before);
      if (observed.validation.ok || observed.validation.reason !== "face_head_relationship_invalid")
        expect(observed).not.toHaveProperty("relationshipFailure");
      else expect(["head_width_ratio", "head_height_ratio", "both_ratios"]).toContain(observed.relationshipFailure);
    }
    expect(validatePortraitRegion(sample(.25 * 1.02, .2 * 1.08)).ok).toBe(true);
  });

  it("keeps neighboring rejection priority and omits subtype on non-relationship outcomes", () => {
    const tooSmall = { ...sample(.001, .001), faceBox: { left: 0, top: 0, right: .024, bottom: .034 } };
    const outside = { ...sample(.4, .4), faceBox: { left: .5, top: .1, right: .75, bottom: .3 } };
    const headOutside = { ...sample(.4, .4), subjectBox: { left: 0, top: 0, right: .3, bottom: .3 } };
    for (const [value, reason] of [[tooSmall, "face_bounds_too_small"], [outside, "face_outside_head"],
      [headOutside, "head_outside_subject"]] as const) {
      const result = validateStructuredLocalization(true, value);
      expect(result.trace.validationReason).toBe(reason);
      expect(result.trace).not.toHaveProperty("relationshipFailure");
      expect(result.region).toBeNull();
    }
    for (const [present, value] of [[false, undefined], [true, null], [true, "wrong"], [true, sample(.3, .3)]] as const) {
      expect(validateStructuredLocalization(present, value).trace).not.toHaveProperty("relationshipFailure");
    }
  });

  it("allowlists only the fixed enum on a genuine INVALID_REGION relationship trace", () => {
    const trace = validateStructuredLocalization(true, sample(.25, .3)).trace;
    const secret = "synthetic-do-not-forward";
    for (const value of [secret, { headBox: secret }, [secret], null, 1]) {
      const injected = Object.assign({}, trace, { relationshipFailure: value, raw: secret }) as StructuredLocalizationTrace;
      const projected = auditLocalizationTrace(injected);
      expect(projected).not.toHaveProperty("relationshipFailure");
      expect(JSON.stringify(projected)).not.toContain(secret);
    }
    for (const value of [
      { ...trace, status: "VALID" as const },
      { ...trace, validationReason: "face_outside_head" as const },
    ]) expect(auditLocalizationTrace(value)).not.toHaveProperty("relationshipFailure");
  });

  for (const provider of ["gemini", "workers_ai"] as const) {
    it.each(cases)(`${provider}: %s survives Worker projection and checkpoint; geometry stays blocked`, async (detail, width, height) => {
      const network = vi.fn(() => { throw new Error("offline_external_network_forbidden"); });
      vi.stubGlobal("fetch", network);
      const raw = wireFixture(makeAnalysis());
      Object.assign(raw.sourceSelection, { portraitRegion: sample(width, height) });
      const gemini = vi.fn(async () => provider === "gemini"
        ? Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] } }] })
        : Response.json({ error: { status: "FAILED_PRECONDITION", message: "Synthetic local fallback trigger" } }, { status: 400 }));
      const gemma = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(namedGemmaFixture(raw)) } }] }));
      const token = "synthetic-audit-token";
      const env = { PRIMARY_AUDIT_TOKEN: token, GEMINI_API_KEY: "synthetic-key", VISION_MODEL: "gemini-3.8-flash",
        WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it", MCSKIN_KV: {},
        AI: { gateway: () => ({ run: gemini }), run: gemma } } as unknown as Env & { PRIMARY_AUDIT_TOKEN: string };
      const state = createCurrentSourceV4State();
      const root = mkdtempSync("evaluation-artifacts/v4-relationship-diagnostic-offline-20260926-");
      const checkpoint = `${root}/summary.json`;
      const cropper = vi.fn();
      const post = vi.fn(async (route: string, imageDataUrl: string, runId: string) => {
        expect(route).toBe("/primary-audit-v4-structured-localization");
        const response = await auditWorker.fetch(new Request(`http://audit.invalid${route}`, {
          method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
          body: JSON.stringify({ imageDataUrl }),
        }), env);
        return { status: response.status, body: await response.json() };
      });
      await runCurrentSourceV4(state, { imageDataUrl: "data:image/jpeg;base64,/9j/",
        source: { sha256: "a".repeat(64) }, input: { sha256: ANALYSIS_SHA, width: 597, height: 896 } },
      post, async event => { await atomicCheckpoint(checkpoint, {
        evidenceOrigin: "synthetic_offline_mock", externalProviderCalls: 0, state,
      }, event); }, cropper);
      expect(state.primary).toMatchObject({ ok: true,
        contractValidation: { providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: false },
        localizationTrace: { status: "INVALID_REGION", validationReason: "face_head_relationship_invalid", relationshipFailure: detail } });
      expect(state.localization).toEqual({ status: "not_captured", reason: "localization_invalid" });
      expect(state.geometryPosts).toBe(0); expect(cropper).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledTimes(1); expect(gemini).toHaveBeenCalledTimes(1);
      expect(gemma).toHaveBeenCalledTimes(provider === "workers_ai" ? 1 : 0);
      expect(network).not.toHaveBeenCalled();
      const recovered = await readLatestAuditCheckpoint(checkpoint);
      expect(recovered?.snapshot).toEqual({ evidenceOrigin: "synthetic_offline_mock", externalProviderCalls: 0, state });
      const stored = JSON.stringify(recovered?.snapshot);
      for (const prohibited of ["headBox", "faceBox", "subjectBox", "data:image", "synthetic-key", token, "rawResponse"])
        expect(stored).not.toContain(prohibited);
    });
  }

  it("does not backfill the consumed live artifact or change provider contract hashes", () => {
    const root = "evaluation-artifacts/current-source-v4-localization-29002888-live-20260926-001";
    const historical = readFileSync(`${root}/summary.json`);
    const previous = JSON.parse(historical.toString());
    expect(previous.currentSourceV4.primary.localizationTrace).toMatchObject({ status: "INVALID_REGION",
      validationReason: "face_head_relationship_invalid" });
    expect(previous.currentSourceV4.primary.localizationTrace).not.toHaveProperty("relationshipFailure");
    expect(currentSourceV4Contract()).toEqual(previous.currentSourceV4Preflight.contract);
    const output = mkdtempSync("evaluation-artifacts/v4-relationship-diagnostic-provenance-20260926-");
    writeFileSync(`${output}/result.json`, JSON.stringify({ externalProviderCalls: 0,
      historicalSummarySha256: sha(historical), historicalRelationshipFailure: "unobserved_not_recoverable",
      historicalArtifactModified: false, providerContractHashesUnchanged: true,
    }, null, 2), { flag: "wx" });
    expect(sha(readFileSync(`${root}/summary.json`))).toBe(sha(historical));
  });
});
