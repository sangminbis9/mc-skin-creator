import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runPhotoAnalysis, validatePhotoAnalysis } from "../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_V2_SCHEMA } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import {
  COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA,
  COMPACT_PHOTO_ANALYSIS_V4_PROMPT,
  COMPACT_PHOTO_ANALYSIS_V4_RUNTIME_SCHEMA,
  PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
  captureStructuredLocalization,
  validateStructuredLocalization,
  validateV4Shape,
} from "../src/compactPhotoAnalysisV4";
import {
  GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,
  GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA,
  GEMMA_VISION_MODEL,
} from "../src/gemmaPhotoAnalysis";
import { buildSkinPlan } from "../src/skinPlan";
import type { Env } from "../src/types";
import { calibrationLocalizationGate } from "./audit/calibrationLocalizationGate";
import { namedGemmaFixture, wireFixture } from "./compactV3Support";
import { makeAnalysis } from "./helpers";
import { withoutHairObservationReinforcement } from "./primaryHairPromptSupport";
import { withoutTiedHairObservation } from "./primaryTiedHairPromptSupport";
import { auditLocalizationTrace } from "./primaryFaceMeasurementAuditWorker";

const photo = "data:image/jpeg;base64,/9j/";
const region = {
  subjectBox: { left: 0.08, top: 0.04, right: 0.62, bottom: 0.98 },
  headBox: { left: 0.16, top: 0.08, right: 0.52, bottom: 0.5 },
  faceBox: { left: 0.21, top: 0.17, right: 0.47, bottom: 0.44 },
  confidence: 0.91,
};
const suffix = " | REGION:[0.08,0.04,0.62,0.98,0.16,0.08,0.52,0.5,0.21,0.17,0.47,0.44,0.91]";
const v4Options = { expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION };
const response = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });

function fixture(value: unknown = region, evidence = "Synthetic portrait") {
  const compact = wireFixture(makeAnalysis());
  compact.sourceSelection = { ...compact.sourceSelection, portraitEvidence: evidence,
    portraitRegion: value } as typeof compact.sourceSelection;
  return compact;
}

function geminiEnv(value: unknown) {
  const fetchMock = vi.fn(async () => response(value));
  vi.stubGlobal("fetch", fetchMock);
  const run = vi.fn(async () => ({ choices: [] }));
  const env = { GEMINI_API_KEY: "local-test-key", AI: { run }, MCSKIN_KV: {} } as unknown as Env;
  return { env, fetchMock, run };
}

async function geminiCase(value: unknown, evidence?: string) {
  const raw = fixture(value, evidence);
  const { env, fetchMock, run } = geminiEnv(raw);
  const result = await runPhotoAnalysis(env, photo, v4Options);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  return result;
}

describe("structured localization v4: internal opt-in only", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pins local request schema/prompt hashes without storing wire bodies", () => {
    const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
    expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA))).toBe("5461f447d49f687b66c5cf03ee73b71c586f6e5349e8ca642f3ddac409e80b7d");
    expect(hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA))).toBe("b3fa270ff6e51e57959389ac8e06cbc496235c32556f3cc698171458530a90d3");
    // V4 inherits both reviewed shared hair instructions. Reverse only those
    // exact independently specified blocks; keep historical hashes immutable.
    expect(hash(`${withoutHairObservationReinforcement(withoutTiedHairObservation(COMPACT_PHOTO_ANALYSIS_V4_PROMPT))}${suffix}`)).toBe("af8ed44ca8cfd3d571706be2a87206d186383c66c7f6c5b5e38b056014ff2c08");
    expect(hash(`${withoutHairObservationReinforcement(withoutTiedHairObservation(GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT))}${suffix}`)).toBe("fbd169cc36a61662cc6a3c3a3300893b32cff44db6f49874c1844824d7b9d99a");
  });

  it("keeps v3 exports untouched while requiring the complete named nullable field in both v4 wires", () => {
    expect(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA.properties!.sourceSelection.properties).not.toHaveProperty("portraitRegion");
    expect(COMPACT_PHOTO_ANALYSIS_V2_SCHEMA.properties!.sourceSelection.properties).not.toHaveProperty("portraitRegion");
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA.properties!.sourceSelection.properties).not.toHaveProperty("portraitRegion");
    for (const schema of [COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA,
      COMPACT_PHOTO_ANALYSIS_V4_RUNTIME_SCHEMA, GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA]) {
      const selection = schema.properties!.sourceSelection;
      expect(selection.required).toContain("portraitRegion");
      const location = selection.properties!.portraitRegion;
      expect(location.type).toEqual(["object", "null"]);
      expect(location.required).toEqual(["subjectBox", "headBox", "faceBox", "confidence"]);
      expect(location.additionalProperties).toBe(false);
      for (const box of ["subjectBox", "headBox", "faceBox"]) {
        expect(location.properties![box].required).toEqual(["left", "top", "right", "bottom"]);
        expect(location.properties![box].additionalProperties).toBe(false);
      }
    }
    expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).toContain("Append to portraitEvidence exactly");
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain("Append to portraitEvidence exactly");
    expect(COMPACT_PHOTO_ANALYSIS_V4_PROMPT).not.toContain("Append to portraitEvidence exactly");
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT).not.toContain("Append to portraitEvidence exactly");
    expect(COMPACT_PHOTO_ANALYSIS_V4_PROMPT).toContain("sourceSelection.portraitRegion");
  });

  it("projects only portraitRegion without mutating the provider DTO", () => {
    const raw = { ...fixture(), unexpectedCoreField: "must fail" };
    const before = structuredClone(raw);
    const captured = captureStructuredLocalization(raw);
    expect(raw).toEqual(before);
    expect(captured.fieldPresent).toBe(true);
    expect(captured.fieldValue).toEqual(region);
    expect(captured.core).not.toHaveProperty("sourceSelection.portraitRegion");
    expect(captured.core).toMatchObject({ unexpectedCoreField: "must fail" });
  });

  it.each([
    [region, "VALID", true],
    [null, "EXPLICIT_NULL", false],
    ["wrong", "MALFORMED", false],
    [[], "MALFORMED", false],
    [{ ...region, headBox: undefined }, "MALFORMED", false],
    [{ ...region, faceBox: { ...region.faceBox, left: "0.21" } }, "MALFORMED", false],
    [{ ...region, faceBox: { ...region.faceBox, left: "" } }, "MALFORMED", false],
    [{ ...region, faceBox: { ...region.faceBox, left: Number.NaN } }, "MALFORMED", false],
    [{ ...region, confidence: Number.POSITIVE_INFINITY }, "MALFORMED", false],
    [{ ...region, confidence: 1.2 }, "INVALID_REGION", false],
    [{ ...region, headBox: { ...region.headBox, right: 0.42 } }, "INVALID_REGION", false],
    [{ ...region, faceBox: { ...region.faceBox, extra: 1 } }, "MALFORMED", false],
  ] as const)("classifies only named localization data: %s", (value, status, valid) => {
    const checked = validateStructuredLocalization(true, value);
    expect(checked.trace.status).toBe(status);
    expect(checked.localizationValid).toBe(valid);
    expect(checked.region === null).toBe(!valid);
    expect(JSON.stringify(checked.trace)).not.toContain("subjectBox");
  });

  it("accepts a valid object through the actual Gemini request and rich normalization", async () => {
    const raw = fixture();
    const { env, fetchMock } = geminiEnv(raw);
    const result = await runPhotoAnalysis(env, photo, v4Options);
    expect(result).toMatchObject({ ok: true, attempts: 1, expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      contractValidation: { providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: true },
      localizationTrace: { version: 2, carrier: "structured_region", status: "VALID" } });
    if (!result.ok) return;
    expect(result.analysis.sourceSelection.portraitRegion).toEqual(region);
    expect(buildSkinPlan(result.analysis).facePixelPlan).toBeDefined();
    expect(result.analysis).not.toHaveProperty("expectedContractVersion");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.responseJsonSchema).toEqual(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA);
    expect(body.contents[0].parts.at(-1).text).toBe(`${COMPACT_PHOTO_ANALYSIS_V4_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`);
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(body.generationConfig).not.toHaveProperty("temperature");
  });

  it("keeps explicit null authoritative across repeated rich validation despite a valid-looking suffix", async () => {
    const result = await geminiCase(null, `Synthetic portrait${suffix}`);
    expect(result).toMatchObject({ ok: true, contractValidation: { providerWireSchemaValid: true,
      primaryCoreValid: true, localizationValid: false }, localizationTrace: { status: "EXPLICIT_NULL" } });
    if (!result.ok) return;
    expect(result.analysis.sourceSelection.portraitRegion).toBeNull();
    expect(buildSkinPlan(result.analysis).facePixelPlan).toBeDefined();
    const again = validatePhotoAnalysis(result.analysis, { kind: "structured_region", region: null });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.analysis.sourceSelection.portraitRegion).toBeNull();
  });

  it("does not revive missing or malformed v4 localization from a legacy suffix", async () => {
    for (const value of [undefined, "wrong", { ...region, confidence: 1.2 }]) {
      const raw = fixture(value, `Synthetic portrait${suffix}`);
      if (value === undefined) delete raw.sourceSelection.portraitRegion;
      const { env } = geminiEnv(raw);
      const result = await runPhotoAnalysis(env, photo, v4Options);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.contractValidation).toEqual({ providerWireSchemaValid: value === undefined ? false : value !== "wrong",
        primaryCoreValid: true, localizationValid: false });
      expect(result.analysis.sourceSelection.portraitRegion).toBeNull();
      const repeated = validatePhotoAnalysis(result.analysis, { kind: "structured_region", region: null });
      expect(repeated.ok && repeated.analysis.sourceSelection.portraitRegion === null).toBe(true);
    }
  });

  it("prefers a valid structured region over conflicting legacy prose", async () => {
    const result = await geminiCase(region, "Synthetic portrait | REGION:null");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.sourceSelection.portraitRegion).toEqual(region);
  });

  it("normalizes an equivalent legacy suffix and named region to the same internal region", async () => {
    const legacy = makeAnalysis();
    legacy.sourceSelection.portraitEvidence = `Synthetic portrait${suffix}`;
    legacy.sourceSelection.portraitRegion = null;
    const validated = validatePhotoAnalysis(legacy);
    const structured = await geminiCase(region);
    expect(validated.ok).toBe(true);
    expect(structured.ok).toBe(true);
    if (validated.ok && structured.ok) {
      expect(structured.analysis.sourceSelection.portraitRegion).toEqual(validated.analysis.sourceSelection.portraitRegion);
    }
  });

  it("rejects core errors rather than labeling them localization-only", async () => {
    for (const changed of [
      { ...fixture(), unexpectedCoreField: "x" },
      { ...fixture(), sourceSelection: { ...fixture().sourceSelection, portraitImageIndex: 3 } },
      { ...fixture(), renderHints: { ...fixture().renderHints, eyes: ["invalid"] } },
    ]) {
      const { env } = geminiEnv(changed);
      const result = await runPhotoAnalysis(env, photo, v4Options);
      expect(result).toMatchObject({ ok: false, reason: "invalid_response",
        contractValidation: { primaryCoreValid: false } });
    }
  });

  it("keeps named Gemma fallback on v4 and normalizes to Gemini's region", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {
      status: "FAILED_PRECONDITION", message: "Local synthetic fallback trigger",
    } }, { status: 400 })));
    const run = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(namedGemmaFixture(fixture())) } }] }));
    const env = { GEMINI_API_KEY: "local-test-key", WORKERS_VISION_MODEL: GEMMA_VISION_MODEL,
      AI: { run }, MCSKIN_KV: {} } as unknown as Env;
    const result = await runPhotoAnalysis(env, photo, v4Options);
    expect(result).toMatchObject({ ok: true, attempts: 2, expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      contractValidation: { providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: true } });
    if (result.ok) expect(result.analysis.sourceSelection.portraitRegion).toEqual(region);
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0][1] as Record<string, unknown>;
    expect(input).toHaveProperty("response_format.json_schema.schema", GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA);
    const message = (input.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0];
    expect(message.content.at(-1)?.text).toBe(`${GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT}\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.`);
    expect(message.content.at(-1)?.text).not.toContain("Append to portraitEvidence exactly");
  });

  it("treats invalid Gemma named render hints as a core failure, never a localization failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {
      status: "FAILED_PRECONDITION", message: "Local synthetic fallback trigger",
    } }, { status: 400 })));
    const named = namedGemmaFixture(fixture());
    named.renderHints.eyes.eyeSpacing = "not-a-valid-hint";
    const run = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(named) } }] }));
    const env = { GEMINI_API_KEY: "local-test-key", WORKERS_VISION_MODEL: GEMMA_VISION_MODEL,
      AI: { run }, MCSKIN_KV: {} } as unknown as Env;
    const result = await runPhotoAnalysis(env, photo, v4Options);
    expect(result).toMatchObject({ ok: false, reason: "invalid_response", attempts: 2,
      contractValidation: { primaryCoreValid: false, localizationValid: true } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("isolates concurrent v3/v4 requests without any global contract switch", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const v4 = Object.hasOwn(body.generationConfig.responseJsonSchema.properties.sourceSelection.properties,
        "portraitRegion");
      return response(v4 ? fixture(null, `Synthetic portrait${suffix}`) : wireFixture(makeAnalysis()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = { GEMINI_API_KEY: "local-test-key", MCSKIN_KV: {} } as unknown as Env;
    const [legacy, structured] = await Promise.all([
      runPhotoAnalysis(env, photo), runPhotoAnalysis(env, photo, v4Options),
    ]);
    expect(legacy.ok).toBe(true);
    expect(structured).toMatchObject({ ok: true, expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      localizationTrace: { status: "EXPLICIT_NULL" } });
    if (structured.ok) expect(structured.analysis.sourceSelection.portraitRegion).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses v3 by default and refuses an unsupported internal version before dispatch", async () => {
    const raw = wireFixture(makeAnalysis());
    const { env, fetchMock } = geminiEnv(raw);
    const defaultResult = await runPhotoAnalysis(env, photo);
    const explicitResult = await runPhotoAnalysis(env, photo, { expectedContractVersion: "primary_compact_v3_legacy_suffix" });
    expect(defaultResult.ok).toBe(explicitResult.ok);
    if (defaultResult.ok && explicitResult.ok) {
      expect(defaultResult.analysis).toEqual(explicitResult.analysis);
    }
    const bodies = fetchMock.mock.calls.map(call => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0].generationConfig.responseJsonSchema).toEqual(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA);
    const unsupported = await runPhotoAnalysis(env, photo, { expectedContractVersion: "unsupported" as never });
    expect(unsupported).toMatchObject({ ok: false, attempts: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose a public request-selected contract in the production generation caller", async () => {
    const source = await readFile("src/generate.ts", "utf8");
    expect(source).toContain("runPhotoAnalysis(env, analysisReferences)");
    expect(source).not.toContain("expectedContractVersion");
  });

  it("keeps calibration and trace audit safe and version-aware", () => {
    const valid = validateStructuredLocalization(true, region).trace;
    const sanitized = auditLocalizationTrace(valid);
    expect(sanitized).toMatchObject({ traceVersion: 2, carrier: "structured_region", status: "VALID" });
    expect(JSON.stringify(sanitized)).not.toContain("subjectBox");
    const gate = { primaryPassed: true, quality: "pass", faceVisible: true,
      portraitImageIndex: 0, sourceVerified: true,
      expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      trace: sanitized, portraitRegion: region };
    expect(calibrationLocalizationGate(gate).calibrationLocalizationEligible).toBe(true);
    expect(calibrationLocalizationGate({ ...gate, sourceVerified: false }).calibrationLocalizationEligible).toBe(false);
    for (const candidate of [validateStructuredLocalization(true, null).trace,
      validateStructuredLocalization(false, undefined).trace,
      validateStructuredLocalization(true, "wrong").trace,
      validateStructuredLocalization(true, { ...region,
        faceBox: { left: 0.7, top: 0.17, right: 0.9, bottom: 0.44 } }).trace]) {
      const rejected = calibrationLocalizationGate({ ...gate, trace: auditLocalizationTrace(candidate) });
      expect(rejected.calibrationLocalizationEligible).toBe(false);
    }
    for (const badTrace of [
      { ...sanitized, traceVersion: undefined, version: 2 },
      { ...sanitized, traceVersion: 1 },
      { ...sanitized, traceVersion: "2" },
      { ...sanitized, traceVersion: null },
      { ...sanitized, carrier: "legacy_suffix" },
      { ...sanitized, contractVersion: "primary_compact_v3_legacy_suffix" },
    ]) {
      expect(calibrationLocalizationGate({ ...gate, trace: badTrace as typeof sanitized })
        .calibrationLocalizationEligible).toBe(false);
    }
    expect(calibrationLocalizationGate({ ...gate, expectedContractVersion: "primary_compact_v3_legacy_suffix" })
      .calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...gate, primaryPassed: false }).calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...gate, quality: "warn" }).calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...gate, faceVisible: false }).calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...gate, portraitImageIndex: 1 }).calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...gate, portraitRegion: null }).calibrationLocalizationEligible).toBe(false);
    expect(calibrationLocalizationGate({ ...gate, portraitRegion: {
      ...region, faceBox: { left: 0.7, top: 0.17, right: 0.9, bottom: 0.44 },
    } })
      .calibrationLocalizationEligible).toBe(false);
  });

  it("distinguishes provider wire from core on absent localization and unknown core fields", () => {
    const raw = fixture();
    delete raw.sourceSelection.portraitRegion;
    expect(validateV4Shape(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA, raw, false)).toContain(
      "compact.sourceSelection.portraitRegion:required",
    );
    expect(validateStructuredLocalization(false, undefined).trace.status).toBe("MISSING");
    expect(validateV4Shape(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA,
      { ...raw, unknownTopLevel: true }, false)).toContain("compact.unknownTopLevel:additionalProperty");
  });
});
