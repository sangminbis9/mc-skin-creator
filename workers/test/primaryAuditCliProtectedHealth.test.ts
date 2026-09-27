import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it } from "vitest";
import { bytesToBase64, decodeImage, decodePng } from "../src/png";
import { createIdentityCrops, MAX_IMAGE_CHARS } from "../src/generate";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA, FACE_GEOMETRY_MODEL,
  FACE_GEOMETRY_TIMEOUT_MS, faceIdentityGeometryRequest, type FaceIdentityGeometryAnalysis } from "../src/faceIdentityGeometry";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../src/compactPhotoAnalysisV3";
import { COMPACT_PHOTO_ANALYSIS_V4_PROMPT, COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA,
  PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../src/compactPhotoAnalysisV4";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA } from "../src/gemmaPhotoAnalysis";
import { type PhotoAnalysis, type PortraitLocalizationTrace, type PortraitRegion } from "../src/analysis";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { boundedHealthProbe } from "./primaryAuditRemoteReadiness";
import { accountingOf, atomicCheckpoint, exceptionDiagnostic, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { calibrationLocalizationGate } from "./audit/calibrationLocalizationGate";
import { checkpointValidatedLocalizationCapture, type ProtectedValidatedLocalization,
  type ValidatedLocalizationEvidence } from "./audit/validatedLocalizationEvidence";
import { acceptedFaceGeometry, SAVED_V4_CROP_SHA, verifySavedV4FaceCropBytes,
  verifySavedV4FaceCropMetadata } from "./audit/savedV4FaceGeometry";
import { awaitCropVisualReview, launchAfterV4OpenPreflight, validatedSameRunCropContext,
  verifyFrozenV4OpenInputs, verifyV4NormalReference } from "./audit/v4OpenGeometryAudit";
import { APERTURE_PILOT_ROOT, prepareAperturePilot, createAperturePilotState, runAperturePilot,
  verifyApertureRecovery, type AperturePilotState } from "./audit/eyeAperturePilot";
import { APERTURE_V2_LIVE_ROOT, prepareApertureV2Live, createApertureV2State, runApertureV2Batch,
  verifyApertureV2Recovery, type ApertureV2State } from "./audit/eyeApertureV2Live";
import { E2E_ROOT, prepareCurrentDefaultE2E, createE2EState, runCurrentDefaultE2E, type E2EState } from "./audit/currentDefaultE2ELive";
import { E2E_MARKER } from "./audit/currentDefaultE2E";
import { CURRENT_SOURCE_V4_ROOT, CURRENT_SOURCE_V4_SELECTOR, prepareCurrentSourceV4,
  createCurrentSourceV4State, runCurrentSourceV4, type CurrentSourceV4State } from "./audit/currentSourceV4LocalizationLive";

type ProcessRecord = { pid: number; parent: number; created: string };
type Config = { vars: Record<string, unknown>; account_id: string; secrets: { required: string[] } };
type AclRestriction = {
  aclRestricted: boolean; inheritanceDisabled: boolean; currentUserAccessPresent: boolean;
  systemAccessPresent: boolean; broadInheritedAccessPresent: boolean; unexpectedAccessPresent: boolean;
};
const support = createRequire(import.meta.url)("./primaryAuditCliHealthSupport.cjs") as {
  parseConfig(text: string): Config;
  deriveConfig(text: string): string;
  assertConfigDelta(production: Config, audit: Config): string[];
  tokenBindingPreflight(cli: string, production: Config, audit: Config, configPath: string): boolean;
  metadataPreflight(cli: string, config: Config, workersDir: string): {
    selectedProfileClass: string; approvedAccountIdMatch: boolean; authOverrideAbsent: boolean;
    dotenvOverrideAbsent: boolean; credentialContentsRead: boolean; credentialExtraction: boolean;
  };
  discoverPty(): { directory: string; version: string; publicSpawnLoaded: boolean; nativeBackendLoaded: boolean };
  processSnapshot(): ProcessRecord[];
  descendants(snapshot: ProcessRecord[], rootPid: number): ProcessRecord[];
  restrictTemporaryDirectory(directory: string): AclRestriction;
  parseReady(raw: unknown): { event: string; ip: string; port: number } | null;
};
const productionText = fs.readFileSync("wrangler.jsonc", "utf8");
const production = support.parseConfig(productionText);
const cli = fs.readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const RUN_HEALTH = process.env.RUN_BOUND_PROFILE_CLI_HEALTH === "approved";
const RUN_CURRENT_SOURCE_V4 = process.env.RUN_CURRENT_SOURCE_V4_LOCALIZATION === CURRENT_SOURCE_V4_SELECTOR;
const RUN_CURRENT_DEFAULT_E2E = process.env.RUN_CURRENT_DEFAULT_V3_E2E === "approved-29002888-20260927-008";
const RUN_SINGLE_PRIMARY = process.env.RUN_BOUND_PROFILE_CLI_PRIMARY_CANARY === "approved-canary";
const RUN_SIX_CASE_PRIMARY = process.env.RUN_BOUND_PROFILE_CLI_PRIMARY_BATCH === "approved-six-case";
const RUN_TARGETED_PRIMARY = process.env.RUN_BOUND_PROFILE_CLI_PRIMARY_TARGETED === "approved-three-case";
const RUN_FACE_GEOMETRY_TARGETS = process.env.RUN_BOUND_PROFILE_CLI_FACE_GEOMETRY === "approved-two-case";
const RUN_NORMAL_ANCHOR = process.env.RUN_BOUND_PROFILE_CLI_NORMAL_ANCHOR === "approved-wavy-normal";
const RUN_WAVY_LOCALIZATION_TRACE = process.env.RUN_BOUND_PROFILE_CLI_WAVY_LOCALIZATION_TRACE === "approved-wavy-localization-trace-20260925-001";
const RUN_WAVY_TIMEOUT_TRACE = process.env.RUN_BOUND_PROFILE_CLI_WAVY_TIMEOUT_TRACE === "approved-wavy-timeout-origin-20260925-001";
const RUN_WAVY_RELATIONSHIP_TRACE = process.env.RUN_BOUND_PROFILE_CLI_WAVY_RELATIONSHIP_TRACE === "approved-wavy-relationship-trace-20260925-001";
const RUN_V4_WAVY_PRIMARY_LEGACY = process.env.RUN_BOUND_PROFILE_CLI_V4_WAVY_PRIMARY === "approved-v4-wavy-primary-20260925-001";
const RUN_V4_VALIDATED_PERSISTENCE = process.env.RUN_BOUND_PROFILE_CLI_V4_VALIDATED_PERSISTENCE
  === "approved-v4-validated-localization-persistence-20260925-001";
const RUN_SAVED_V4_FACE_GEOMETRY = process.env.RUN_BOUND_PROFILE_CLI_SAVED_V4_FACE_GEOMETRY
  === "approved-v4-wavy-saved-face-crop-geometry-20260925-001";
const RUN_V4_OPEN_GEOMETRY = process.env.RUN_BOUND_PROFILE_CLI_V4_OPEN_GEOMETRY
  === "approved-v4-open-localization-crop-geometry-20260926-002";
const V4_OPEN_GEOMETRY_ROOT = path.resolve("evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002");
const SAVED_V4_FACE_GEOMETRY_ROOT = path.resolve("evaluation-artifacts/v4-wavy-saved-face-crop-geometry-live-20260925-001");
const RUN_V4_WAVY_PRIMARY = RUN_V4_WAVY_PRIMARY_LEGACY || RUN_V4_VALIDATED_PERSISTENCE;
const V4_VALIDATED_PERSISTENCE_ARTIFACT_ROOT = path.resolve("evaluation-artifacts/v4-validated-localization-persistence-live-20260925-001");
const V4_WAVY_ARTIFACT_ROOT = RUN_V4_VALIDATED_PERSISTENCE ? V4_VALIDATED_PERSISTENCE_ARTIFACT_ROOT
  : path.resolve("evaluation-artifacts/structured-localization-v4-wavy-primary-live-20260925-001");
const RUN_WAVY_PRIMARY_TRACE = RUN_WAVY_TIMEOUT_TRACE || RUN_WAVY_RELATIONSHIP_TRACE || RUN_V4_WAVY_PRIMARY;
const RUN_WAVY_DERIVATIVE = process.env.RUN_BOUND_PROFILE_CLI_WAVY_DERIVATIVE === "approved-wavy-derivative-20260925-002"
  || RUN_WAVY_LOCALIZATION_TRACE;
const RUN_WAVY_PRIMARY_INPUT = RUN_WAVY_DERIVATIVE || RUN_WAVY_PRIMARY_TRACE;
const RUN_ANY_NORMAL_ANCHOR = RUN_NORMAL_ANCHOR || RUN_WAVY_DERIVATIVE;
const RUN_OPEN_ANCHOR = process.env.RUN_BOUND_PROFILE_CLI_OPEN_ANCHOR === "approved-headscarf-open";
const RUN_EXTERNAL_OPEN_ANCHOR = process.env.RUN_BOUND_PROFILE_CLI_EXTERNAL_OPEN_ANCHOR === "approved-wikimedia-open";
const RUN_ANY_OPEN_ANCHOR = RUN_OPEN_ANCHOR || RUN_EXTERNAL_OPEN_ANCHOR;
const RUN_OPEN_DIRECTIONAL = process.env.RUN_BOUND_PROFILE_CLI_OPEN_DIRECTIONAL === "approved-headscarf-open-directional";
const RUN_PRIMARY = RUN_SINGLE_PRIMARY || RUN_SIX_CASE_PRIMARY || RUN_TARGETED_PRIMARY || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_WAVY_PRIMARY_TRACE;
const RUN_EYE_APERTURE = process.env.RUN_BOUND_PROFILE_CLI_EYE_APERTURE === "approved-two-crop-aperture-20260926-001";
const RUN_EYE_APERTURE_V2 = process.env.RUN_BOUND_PROFILE_CLI_EYE_APERTURE_V2 === "approved-v2-first-live-20260926-001";
const RUN_REMOTE = RUN_CURRENT_SOURCE_V4 || RUN_CURRENT_DEFAULT_E2E || RUN_PRIMARY || RUN_FACE_GEOMETRY_TARGETS || RUN_OPEN_DIRECTIONAL || RUN_SAVED_V4_FACE_GEOMETRY || RUN_V4_OPEN_GEOMETRY || RUN_EYE_APERTURE || RUN_EYE_APERTURE_V2;
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const GENERALIZATION = path.resolve("evaluation-artifacts/generalization-20260905");
const TARGETED_PRIMARY = path.resolve("evaluation-artifacts/primary-eye-category-targeted-live-20260921-001/summary.json");
const OPEN_SOURCE = path.resolve("evaluation-artifacts/facial-feature-renderer-20260904/headscarf-color-blocks/01-source.png");
const OPEN_FREEZE = path.resolve("evaluation-artifacts/face-geometry-openness-open-source-freeze-20260922-001/frozen-open-label.json");
const OPEN_LINEAGE = path.resolve("evaluation-artifacts/face-geometry-openness-open-source-freeze-20260922-001/source-lineage.json");
const EXTERNAL_OPEN_SOURCE = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
const EXTERNAL_OPEN_FREEZE = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/frozen-open-label.json");
const EXTERNAL_OPEN_PARITY = path.resolve("evaluation-artifacts/open-anchor-production-preprocessing-parity-20260924-001");
const EXTERNAL_OPEN_SOURCE_HASH = "a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac";
const EXTERNAL_OPEN_DERIVATIVE_HASH = "9fb61cca1c4829784d44cf7cc6db1c56d8459923651ba4d8ce02f35756759f4b";
const EXTERNAL_OPEN_DERIVATIVE_RGBA_HASH = "7f97174def06d69b590bd5d8466f398e0ef6a26fa54b7ffba3af969520605a68";
const EXTERNAL_OPEN_PAYLOAD_HASH = "b1c7a8fb3bb8275e5d656420e4bbc418992815c1aefb402896875dc441bc10ed";
const EXTERNAL_OPEN_PREPROCESSING_SOURCE_HASH = "dd6b7dde82b35cc0dd7947b16287c217a23b64d2ac58420015511bfdb352235d";
const WAVY_PARITY = path.resolve("evaluation-artifacts/face-geometry-openness-anchor-input-parity-audit-20260925-001");
const WAVY_DERIVATIVE_HASH = "39bbb6ef4c77591138eec44d5cc0641645c2dcf68c9af09877fee1fcc050929d";
const WAVY_DERIVATIVE_RGBA_HASH = "5cf244ae8b25648cc1c1be49a0a5f183ff3d8c950d1b74003a7d1b81619c6bab";
const V4_REFERENCE_SUFFIX = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const V4_GEMINI_SCHEMA_HASH = "5461f447d49f687b66c5cf03ee73b71c586f6e5349e8ca642f3ddac409e80b7d";
const V4_GEMINI_PROMPT_HASH = "af8ed44ca8cfd3d571706be2a87206d186383c66c7f6c5b5e38b056014ff2c08";
const V4_GEMMA_SCHEMA_HASH = "b3fa270ff6e51e57959389ac8e06cbc496235c32556f3cc698171458530a90d3";
const V4_GEMMA_PROMPT_HASH = "fbd169cc36a61662cc6a3c3a3300893b32cff44db6f49874c1844824d7b9d99a";
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";
const FACE_GEOMETRY_PROMPT_HASH = "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd";
const FACE_GEOMETRY_SCHEMA_HASH = "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469";
const OPEN_SOURCE_FILE_HASH = "eaa53f58cd9c85b1e5507c8aa3df4152ed730501c74af1d337ec83f6e49e9938";
const OPEN_SOURCE_RGBA_HASH = "66a63da69067d1d50eb1a40354ad585900cd64161c5c1c5d82efbfb13ae00e92";
const OPEN_FREEZE_PAYLOAD_HASH = "5bcb431e3d7a39a0e786aa5b20426ccc3d0989fc60ab1618b153188f90be5d7b";
const FACE_GEOMETRY_CROP_HASHES: Record<string, string> = {
  "warm-white-tee": "85f62ffaf83e785c62e45b4fb04306e8d5d8c69484e3a6fa084ad6f3aa188b85",
  "striped-open-shirt": "e954ede4ebe00deafa25f090d3ed374d56897832cb0a85d403a5a5f9ef59270f",
};
type RubricCell = { kind: "expected" | "ambiguous" | "unscorable"; values?: string[]; reason?: string };
type RubricCase = { id: string; photoId: number; sourceSha256: string; sourceBytes: number; faceVisibility: string;
  glassesOrCovering: string; rubric: Record<string, RubricCell> };
type RemoteResult = {
  ok?: boolean;
  elapsedMs?: number;
  primaryElapsedMs?: number | null;
  geminiElapsedMs?: number | null;
  gemmaElapsedMs?: number | null;
  attempts?: number;
  providerSequence?: Array<Record<string, unknown>>;
  validation?: Record<string, string>;
  localizationTrace?: (Omit<PortraitLocalizationTrace, "version"> & { traceVersion: 1 })
    | { traceVersion: 2; contractVersion: string; carrier: string; status: string;
      fieldPresent: boolean; shapeValidation: string; regionValidation: string; validationReason: string | null } | null;
  expectedContractVersion?: string;
  contractValidation?: { providerWireSchemaValid: boolean; primaryCoreValid: boolean; localizationValid: boolean } | null;
  validatedLocalization?: ProtectedValidatedLocalization | null;
  auditState?: unknown;
  analysis?: {
    quality?: unknown; visibleRegions?: unknown;
    sourceSelection?: { portraitImageIndex?: number; portraitRegion?: PortraitRegion | null };
    identityCropContext?: AdaptiveHeadCropContext;
    faceMeasurementEyeOpenness?: { value: string; provenance: string; confidence: number } | null;
    faceMeasurementEvidence?: { cues?: Record<string, { value: string; provenance: string; confidence: number }> };
    relevantRenderHints?: unknown; canonicalFaceCues?: unknown;
    fallbackFeaturesGlasses?: "none" | "regular" | "round" | "sunglasses";
    observedAccessories?: string;
    canonicalAccessoryCues?: Array<{ feature: string; evidence: string; confidence: string; priority: number; targetRegions: string[] }>;
    consumerTrace?: { measurementTrace?: Record<string, { selected?: string }>; faceLayoutPlan?: Record<string, unknown> } | null;
  };
  failure?: { reason?: string; detail?: string };
};
type GeometryRemoteResult = {
  ok?: boolean;
  elapsedMs?: number;
  auditState?: unknown;
  crop?: Record<string, unknown> | null;
  providerShapeValid?: boolean;
  errors?: string[];
  measurements?: Record<string, unknown> | null;
  geometry?: FaceIdentityGeometryAnalysis | null;
  httpStatus?: number | null;
  providerStatus?: string | null;
  error?: string;
};
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation.then(value => ({ done: true as const, value })),
    new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

it("derived audit config preserves every production setting with exactly one empty declaration", () => {
  const auditText = support.deriveConfig(productionText);
  const audit = support.parseConfig(auditText);
  expect(support.assertConfigDelta(production, audit)).toEqual(["vars.PRIMARY_AUDIT_TOKEN"]);
  expect(audit.secrets.required).toEqual(production.secrets.required);
  expect(audit.vars.PRIMARY_AUDIT_TOKEN).toBe("");
  expect(auditText.replace(/\n {4}"PRIMARY_AUDIT_TOKEN": "",/, "")).toBe(productionText);
  expect(support.tokenBindingPreflight(cli, production, audit, path.resolve("wrangler.audit.tmp.jsonc"))).toBe(true);
  const invalid = structuredClone(audit); invalid.vars.VISION_MODEL = "unexpected-model";
  expect(() => support.assertConfigDelta(production, invalid)).toThrow("unexpected_config_delta");
});
it("only exact structured loopback-ready payloads can open the single health gate", () => {
  expect(support.parseReady(JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 }))).toEqual({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 });
  for (const value of [{ event: "OTHER", ip: "127.0.0.1", port: 8787 },
    { event: "DEV_SERVER_READY", ip: "public.invalid", port: 8787 },
    { event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 0 }, null, "secret-bearing-invalid"]) {
    expect(support.parseReady(value)).toBeNull();
  }
});

it("pins the V4 wavy primary-only request contract without selecting remote execution", () => {
  expect(V4_WAVY_ARTIFACT_ROOT).toBe(RUN_V4_VALIDATED_PERSISTENCE ? V4_VALIDATED_PERSISTENCE_ARTIFACT_ROOT
    : path.resolve("evaluation-artifacts/structured-localization-v4-wavy-primary-live-20260925-001"));
  expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA))).toBe(V4_GEMINI_SCHEMA_HASH);
  expect(hash(`${COMPACT_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMINI_PROMPT_HASH);
  expect(hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA))).toBe(V4_GEMMA_SCHEMA_HASH);
  expect(hash(`${GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMMA_PROMPT_HASH);
  const region = COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA.properties!.sourceSelection.properties!.portraitRegion;
  expect(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA.properties!.sourceSelection.required).toContain("portraitRegion");
  expect(region.type).toEqual(["object", "null"]);
  expect(region.required).toEqual(["subjectBox", "headBox", "faceBox", "confidence"]);
  for (const box of ["subjectBox", "headBox", "faceBox"]) {
    expect(region.properties![box].required).toEqual(["left", "top", "right", "bottom"]);
  }
  expect(fs.readFileSync("src/generate.ts", "utf8")).toContain("runPhotoAnalysis(env, analysisReferences)");
});
it.skipIf(!RUN_V4_VALIDATED_PERSISTENCE)("pins the V4 validated-localization persistence selector without starting the remote runner", () => {
  expect(RUN_V4_WAVY_PRIMARY_LEGACY).toBe(false);
  expect(RUN_PRIMARY && RUN_REMOTE && RUN_WAVY_PRIMARY_INPUT).toBe(true);
  expect(RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_FACE_GEOMETRY_TARGETS || RUN_OPEN_DIRECTIONAL).toBe(false);
  expect(V4_WAVY_ARTIFACT_ROOT).toBe(V4_VALIDATED_PERSISTENCE_ARTIFACT_ROOT);
  expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA))).toBe(V4_GEMINI_SCHEMA_HASH);
  expect(hash(`${COMPACT_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMINI_PROMPT_HASH);
  expect(hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA))).toBe(V4_GEMMA_SCHEMA_HASH);
  expect(hash(`${GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMMA_PROMPT_HASH);
});
it.skipIf(!RUN_SAVED_V4_FACE_GEOMETRY)("pins saved V4 face geometry to one direct PNG request and no primary", async () => {
  expect(RUN_REMOTE && !RUN_PRIMARY && !RUN_FACE_GEOMETRY_TARGETS && !RUN_OPEN_DIRECTIONAL).toBe(true);
  expect([RUN_HEALTH, RUN_SINGLE_PRIMARY, RUN_SIX_CASE_PRIMARY, RUN_TARGETED_PRIMARY,
    RUN_NORMAL_ANCHOR, RUN_WAVY_DERIVATIVE, RUN_OPEN_ANCHOR, RUN_EXTERNAL_OPEN_ANCHOR,
    RUN_WAVY_LOCALIZATION_TRACE, RUN_WAVY_TIMEOUT_TRACE, RUN_WAVY_RELATIONSHIP_TRACE,
    RUN_V4_WAVY_PRIMARY].every(value => !value)).toBe(true);
  expect(path.resolve(process.env.BOUND_PROFILE_CLI_SAVED_V4_FACE_GEOMETRY_ARTIFACT_ROOT ?? ""))
    .toBe(SAVED_V4_FACE_GEOMETRY_ROOT);
  expect(fs.existsSync(SAVED_V4_FACE_GEOMETRY_ROOT)).toBe(false);
  expect(hash(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(FACE_GEOMETRY_PROMPT_HASH);
  expect(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(FACE_GEOMETRY_SCHEMA_HASH);
  expect(FACE_GEOMETRY_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
  expect(FACE_GEOMETRY_TIMEOUT_MS).toBe(25_000);
  const saved = await verifySavedV4FaceCropMetadata();
  expect(saved.evidence.caseId).toBe("wavy-open-blazer");
  expect(saved.crop.encodedSha256).toBe(SAVED_V4_CROP_SHA);
});
it.skipIf(!RUN_V4_OPEN_GEOMETRY)("pins V4 OPEN same-run primary and geometry to one frozen derivative", async () => {
  expect(RUN_REMOTE && !RUN_PRIMARY && !RUN_FACE_GEOMETRY_TARGETS && !RUN_OPEN_DIRECTIONAL).toBe(true);
  expect([RUN_HEALTH, RUN_SAVED_V4_FACE_GEOMETRY, RUN_V4_WAVY_PRIMARY, RUN_EXTERNAL_OPEN_ANCHOR,
    RUN_ANY_NORMAL_ANCHOR, RUN_ANY_OPEN_ANCHOR].every(value => !value)).toBe(true);
  expect(path.resolve(process.env.BOUND_PROFILE_CLI_V4_OPEN_GEOMETRY_ARTIFACT_ROOT ?? "")).toBe(V4_OPEN_GEOMETRY_ROOT);
  expect(fs.existsSync(V4_OPEN_GEOMETRY_ROOT)).toBe(false);
  expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA))).toBe(V4_GEMINI_SCHEMA_HASH);
  expect(hash(`${COMPACT_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMINI_PROMPT_HASH);
  expect(hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA))).toBe(V4_GEMMA_SCHEMA_HASH);
  expect(hash(`${GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMMA_PROMPT_HASH);
  expect(hash(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(FACE_GEOMETRY_PROMPT_HASH);
  expect(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(FACE_GEOMETRY_SCHEMA_HASH);
  expect((await verifyV4NormalReference()).normalOpenness).toBe(0.5);
  const runner = fs.readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
  expect(runner.indexOf("const verifiedOpen = RUN_V4_OPEN_GEOMETRY ? await verifyFrozenV4OpenInputs()"))
    .toBeLessThan(runner.indexOf("fs.mkdirSync(root, { recursive: false })"));
  expect(runner.indexOf("fs.mkdirSync(root, { recursive: false })"))
    .toBeLessThan(runner.indexOf("const startOwner = () => spawn("));
});

it.skipIf(!RUN_WAVY_TIMEOUT_TRACE)("keeps the wavy timeout-origin selector primary-only with an isolated path", () => {
  const root = process.env.BOUND_PROFILE_CLI_WAVY_TIMEOUT_TRACE_ARTIFACT_ROOT;
  expect(RUN_PRIMARY && RUN_REMOTE && RUN_WAVY_PRIMARY_INPUT).toBe(true);
  expect(RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_FACE_GEOMETRY_TARGETS || RUN_OPEN_DIRECTIONAL).toBe(false);
  expect(path.resolve(root ?? "")).toBe(path.resolve("evaluation-artifacts/primary-timeout-origin-wavy-live-20260925-001"));
  // The live runner's mkdir({ recursive: false }) enforces freshness at execution time.
  expect(production.vars.VISION_MODEL).toBe("gemini-3.8-flash");
  expect(production.vars.WORKERS_VISION_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
  expect(production.vars.GEMINI_STRUCTURED_TIMEOUT_MS).toBe("45000");
  expect(hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT)).toMatch(/^[0-9a-f]{64}$/);
  expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA))).toMatch(/^[0-9a-f]{64}$/);
});
it.skipIf(!RUN_WAVY_RELATIONSHIP_TRACE)("keeps the relationship-trace selector primary-only with a fresh path", () => {
  const root = process.env.BOUND_PROFILE_CLI_WAVY_RELATIONSHIP_TRACE_ARTIFACT_ROOT;
  expect(RUN_PRIMARY && RUN_REMOTE && RUN_WAVY_PRIMARY_INPUT).toBe(true);
  expect(RUN_WAVY_TIMEOUT_TRACE || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR
    || RUN_FACE_GEOMETRY_TARGETS || RUN_OPEN_DIRECTIONAL).toBe(false);
  expect(path.resolve(root ?? "")).toBe(path.resolve("evaluation-artifacts/wavy-localization-relationship-trace-live-20260925-001"));
  expect(production.vars.VISION_MODEL).toBe("gemini-3.8-flash");
  expect(production.vars.WORKERS_VISION_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
  expect(production.vars.GEMINI_STRUCTURED_TIMEOUT_MS).toBe("45000");
});

it.skipIf(RUN_WAVY_RELATIONSHIP_TRACE || RUN_V4_WAVY_PRIMARY || RUN_SAVED_V4_FACE_GEOMETRY || RUN_V4_OPEN_GEOMETRY)("freezes the wavy production derivative and current face-only geometry contract offline", async () => {
  const rubric = JSON.parse(fs.readFileSync(RUBRIC, "utf8")) as { cases: RubricCase[] };
  const wavy = rubric.cases.find(item => item.id === "wavy-open-blazer");
  expect(wavy).toMatchObject({ sourceSha256: "fbfd573be40b623d70da02a56bb876a1b53abb88f1806188b1a40b74f2ef2702",
    sourceBytes: 70_987, rubric: { eyeOpenness: { kind: "expected", values: ["normal"] } } });
  const source = fs.readFileSync(path.join(GENERALIZATION, "sources/19908659.jpg"));
  expect([source.length, hash(source)]).toEqual([70_987, wavy!.sourceSha256]);
  const sourceImage = await decodeImage(source);
  expect([sourceImage.width, sourceImage.height]).toEqual([900, 1350]);
  const manifest = JSON.parse(fs.readFileSync(path.join(WAVY_PARITY, "production-derivatives.json"), "utf8")) as Array<{
    caseId: string; sourceSha256: string; derivativeSha256: string; derivativeBytes: number;
    derivativeDimensions: number[]; derivativeDecodedRgbaSha256: string; dataUrlChars: number;
    selectedQuality: number; newDerivativeRawOpenness: string;
  }>;
  const frozen = manifest.find(item => item.caseId === "wavy");
  expect(frozen).toMatchObject({ sourceSha256: wavy!.sourceSha256, derivativeSha256: WAVY_DERIVATIVE_HASH,
    derivativeBytes: 45_769, derivativeDimensions: [597, 896], derivativeDecodedRgbaSha256: WAVY_DERIVATIVE_RGBA_HASH,
    dataUrlChars: 61_051, selectedQuality: 0.85, newDerivativeRawOpenness: "unknown" });
  const derivative = fs.readFileSync(path.join(WAVY_PARITY, "wavy/analysis-derivative.jpg"));
  expect([derivative.length, hash(derivative)]).toEqual([frozen!.derivativeBytes, frozen!.derivativeSha256]);
  const decoded = await decodeImage(derivative);
  expect([decoded.width, decoded.height, hash(Buffer.from(decoded.rgba))]).toEqual([597, 896, WAVY_DERIVATIVE_RGBA_HASH]);
  const wireImage = `data:image/jpeg;base64,${bytesToBase64(derivative)}`;
  expect(wireImage.length).toBe(61_051);
  expect(wireImage.length).toBeLessThanOrEqual(MAX_IMAGE_CHARS);
  expect(hash(Buffer.from(wireImage.slice("data:image/jpeg;base64,".length), "base64"))).toBe(WAVY_DERIVATIVE_HASH);
  expect(hash(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(FACE_GEOMETRY_PROMPT_HASH);
  expect(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(FACE_GEOMETRY_SCHEMA_HASH);
  expect(fs.readFileSync("src/generate.ts", "utf8")).toContain("headHeightPixels * 0.65");
  expect(fs.readFileSync("src/identityQuantization.ts", "utf8"))
    .toContain('geometry.eyes.openness >= 0.68 ? "open" : geometry.eyes.openness <= 0.34 ? "compact" : "readable"');
});

it.skipIf(!RUN_HEALTH && !RUN_REMOTE)("runs one approved temporary-config bound-profile CLI audit and gracefully quits", async () => {
  const root = RUN_CURRENT_SOURCE_V4 ? CURRENT_SOURCE_V4_ROOT : RUN_CURRENT_DEFAULT_E2E ? E2E_ROOT : RUN_EYE_APERTURE_V2 ? APERTURE_V2_LIVE_ROOT : RUN_EYE_APERTURE ? process.env.BOUND_PROFILE_CLI_EYE_APERTURE_ARTIFACT_ROOT : RUN_V4_OPEN_GEOMETRY
    ? process.env.BOUND_PROFILE_CLI_V4_OPEN_GEOMETRY_ARTIFACT_ROOT
    : RUN_SAVED_V4_FACE_GEOMETRY
    ? process.env.BOUND_PROFILE_CLI_SAVED_V4_FACE_GEOMETRY_ARTIFACT_ROOT
    : RUN_V4_VALIDATED_PERSISTENCE
    ? process.env.BOUND_PROFILE_CLI_V4_VALIDATED_PERSISTENCE_ARTIFACT_ROOT
    : RUN_WAVY_RELATIONSHIP_TRACE
    ? process.env.BOUND_PROFILE_CLI_WAVY_RELATIONSHIP_TRACE_ARTIFACT_ROOT
    : RUN_V4_WAVY_PRIMARY
    ? process.env.BOUND_PROFILE_CLI_V4_WAVY_PRIMARY_ARTIFACT_ROOT
    : RUN_WAVY_TIMEOUT_TRACE
    ? process.env.BOUND_PROFILE_CLI_WAVY_TIMEOUT_TRACE_ARTIFACT_ROOT
    : RUN_WAVY_LOCALIZATION_TRACE
    ? process.env.BOUND_PROFILE_CLI_WAVY_LOCALIZATION_TRACE_ARTIFACT_ROOT
    : RUN_WAVY_DERIVATIVE
    ? process.env.BOUND_PROFILE_CLI_WAVY_DERIVATIVE_ARTIFACT_ROOT
    : RUN_EXTERNAL_OPEN_ANCHOR
    ? process.env.BOUND_PROFILE_CLI_EXTERNAL_OPEN_ANCHOR_ARTIFACT_ROOT
    : RUN_OPEN_DIRECTIONAL
    ? process.env.BOUND_PROFILE_CLI_OPEN_DIRECTIONAL_ARTIFACT_ROOT
    : RUN_OPEN_ANCHOR
    ? process.env.BOUND_PROFILE_CLI_OPEN_ANCHOR_ARTIFACT_ROOT
    : RUN_NORMAL_ANCHOR
    ? process.env.BOUND_PROFILE_CLI_NORMAL_ANCHOR_ARTIFACT_ROOT
    : RUN_FACE_GEOMETRY_TARGETS
    ? process.env.BOUND_PROFILE_CLI_FACE_GEOMETRY_ARTIFACT_ROOT
    : RUN_PRIMARY
    ? process.env.BOUND_PROFILE_CLI_PRIMARY_CANARY_ARTIFACT_ROOT
    : process.env.BOUND_PROFILE_CLI_HEALTH_ARTIFACT_ROOT;
  if (!root) throw new Error("fresh_artifact_root_required");
  if (RUN_CURRENT_SOURCE_V4) {
    expect([RUN_HEALTH, RUN_PRIMARY, RUN_CURRENT_DEFAULT_E2E, RUN_FACE_GEOMETRY_TARGETS,
      RUN_OPEN_DIRECTIONAL, RUN_SAVED_V4_FACE_GEOMETRY, RUN_V4_OPEN_GEOMETRY,
      RUN_EYE_APERTURE, RUN_EYE_APERTURE_V2].every(value => !value)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
    expect(production.vars.VISION_MODEL).toBe("gemini-3.8-flash");
    expect(production.vars.WORKERS_VISION_MODEL).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(Number(production.vars.GEMINI_STRUCTURED_TIMEOUT_MS)).toBe(45_000);
  }
  const currentV4Preflight = RUN_CURRENT_SOURCE_V4 ? await prepareCurrentSourceV4() : null;
  if (RUN_CURRENT_DEFAULT_E2E) {
    expect([RUN_HEALTH, RUN_PRIMARY, RUN_FACE_GEOMETRY_TARGETS, RUN_OPEN_DIRECTIONAL, RUN_SAVED_V4_FACE_GEOMETRY,
      RUN_V4_OPEN_GEOMETRY, RUN_EYE_APERTURE, RUN_EYE_APERTURE_V2].every(value => !value)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  }
  const e2ePreflight = RUN_CURRENT_DEFAULT_E2E ? await prepareCurrentDefaultE2E() : null;
  if (RUN_EYE_APERTURE_V2) {
    expect([RUN_HEALTH, RUN_PRIMARY, RUN_FACE_GEOMETRY_TARGETS, RUN_OPEN_DIRECTIONAL,
      RUN_SAVED_V4_FACE_GEOMETRY, RUN_V4_OPEN_GEOMETRY, RUN_EYE_APERTURE].every(value => !value)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  }
  const apertureV2Preflight = RUN_EYE_APERTURE_V2 ? await prepareApertureV2Live() : null;
  if (RUN_EYE_APERTURE) {
    expect(path.resolve(root)).toBe(APERTURE_PILOT_ROOT);
    expect([RUN_HEALTH, RUN_PRIMARY, RUN_FACE_GEOMETRY_TARGETS, RUN_OPEN_DIRECTIONAL,
      RUN_SAVED_V4_FACE_GEOMETRY, RUN_V4_OPEN_GEOMETRY].every(value => !value)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  }
  const aperturePreflight = RUN_EYE_APERTURE ? await prepareAperturePilot() : null;
  if (RUN_SAVED_V4_FACE_GEOMETRY) {
    expect(path.resolve(root)).toBe(SAVED_V4_FACE_GEOMETRY_ROOT);
    expect(RUN_PRIMARY || RUN_FACE_GEOMETRY_TARGETS || RUN_OPEN_DIRECTIONAL || RUN_HEALTH).toBe(false);
  }
  if (RUN_V4_OPEN_GEOMETRY) {
    expect(path.resolve(root)).toBe(V4_OPEN_GEOMETRY_ROOT);
    expect([RUN_HEALTH, RUN_PRIMARY, RUN_FACE_GEOMETRY_TARGETS, RUN_OPEN_DIRECTIONAL,
      RUN_SAVED_V4_FACE_GEOMETRY].every(value => !value)).toBe(true);
  }
  if (RUN_WAVY_TIMEOUT_TRACE) {
    expect(path.resolve(root)).toBe(path.resolve("evaluation-artifacts/primary-timeout-origin-wavy-live-20260925-001"));
    expect([RUN_HEALTH, RUN_SINGLE_PRIMARY, RUN_SIX_CASE_PRIMARY, RUN_TARGETED_PRIMARY,
      RUN_FACE_GEOMETRY_TARGETS, RUN_NORMAL_ANCHOR, RUN_WAVY_DERIVATIVE, RUN_OPEN_ANCHOR,
      RUN_EXTERNAL_OPEN_ANCHOR, RUN_OPEN_DIRECTIONAL].every(value => !value)).toBe(true);
  }
  if (RUN_WAVY_RELATIONSHIP_TRACE) {
    expect(path.resolve(root)).toBe(path.resolve("evaluation-artifacts/wavy-localization-relationship-trace-live-20260925-001"));
    expect([RUN_HEALTH, RUN_SINGLE_PRIMARY, RUN_SIX_CASE_PRIMARY, RUN_TARGETED_PRIMARY,
      RUN_FACE_GEOMETRY_TARGETS, RUN_NORMAL_ANCHOR, RUN_WAVY_DERIVATIVE, RUN_OPEN_ANCHOR,
      RUN_EXTERNAL_OPEN_ANCHOR, RUN_OPEN_DIRECTIONAL, RUN_WAVY_TIMEOUT_TRACE].every(value => !value)).toBe(true);
  }
  if (RUN_V4_WAVY_PRIMARY) {
    expect(path.resolve(root)).toBe(V4_WAVY_ARTIFACT_ROOT);
    expect(RUN_V4_WAVY_PRIMARY_LEGACY && RUN_V4_VALIDATED_PERSISTENCE).toBe(false);
    expect([RUN_HEALTH, RUN_SINGLE_PRIMARY, RUN_SIX_CASE_PRIMARY, RUN_TARGETED_PRIMARY,
      RUN_FACE_GEOMETRY_TARGETS, RUN_NORMAL_ANCHOR, RUN_WAVY_DERIVATIVE, RUN_OPEN_ANCHOR,
      RUN_EXTERNAL_OPEN_ANCHOR, RUN_OPEN_DIRECTIONAL, RUN_WAVY_TIMEOUT_TRACE,
      RUN_WAVY_RELATIONSHIP_TRACE].every(value => !value)).toBe(true);
  }
  if (RUN_WAVY_DERIVATIVE) {
    expect(path.resolve(root)).toBe(path.resolve(RUN_WAVY_LOCALIZATION_TRACE
      ? "evaluation-artifacts/face-geometry-openness-wavy-localization-trace-live-20260925-001"
      : "evaluation-artifacts/face-geometry-openness-wavy-production-derivative-live-20260925-002"));
    expect(RUN_WAVY_LOCALIZATION_TRACE && process.env.RUN_BOUND_PROFILE_CLI_WAVY_DERIVATIVE === "approved-wavy-derivative-20260925-002").toBe(false);
    expect([RUN_HEALTH, RUN_SINGLE_PRIMARY, RUN_SIX_CASE_PRIMARY, RUN_TARGETED_PRIMARY,
      RUN_FACE_GEOMETRY_TARGETS, RUN_NORMAL_ANCHOR, RUN_OPEN_ANCHOR, RUN_EXTERNAL_OPEN_ANCHOR,
      RUN_OPEN_DIRECTIONAL].every(value => !value)).toBe(true);
  }
  // This exact selector verifies both files before allocating the checkpoint or
  // starting Wrangler. The canonical original is never returned as a payload.
  const verifiedOpen = RUN_V4_OPEN_GEOMETRY ? await verifyFrozenV4OpenInputs() : null;
  const openNormal = RUN_V4_OPEN_GEOMETRY ? await verifyV4NormalReference() : null;
  if (RUN_V4_OPEN_GEOMETRY) {
    expect(fs.existsSync(root)).toBe(false);
    expect(verifiedOpen).toMatchObject({ sourceSha256: EXTERNAL_OPEN_SOURCE_HASH,
      derivativeSha256: EXTERNAL_OPEN_DERIVATIVE_HASH, derivativeBytes: 96_780,
      originalDecoder: "audit_only_jpeg_js_127_MiB", derivativeDecoder: "production_decodeImage_64_MiB" });
    expect(openNormal?.normalOpenness).toBe(0.5);
    expect(hash(`${COMPACT_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMINI_PROMPT_HASH);
    expect(hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA))).toBe(V4_GEMINI_SCHEMA_HASH);
    expect(hash(`${GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`)).toBe(V4_GEMMA_PROMPT_HASH);
    expect(hash(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA))).toBe(V4_GEMMA_SCHEMA_HASH);
    expect(hash(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(FACE_GEOMETRY_PROMPT_HASH);
    expect(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(FACE_GEOMETRY_SCHEMA_HASH);
    expect(verifiedOpen!.dataUrlChars).toBeLessThanOrEqual(MAX_IMAGE_CHARS);
  }
  fs.mkdirSync(root, { recursive: false });
  const smokePath = path.join(root, "summary.json");
  const smokeSnapshot = { mode: "audit_checkpoint_smoke", providerRetry: 0, primaryPosts: 0,
    geometryPosts: 0, geminiPrimaryStarted: 0, gemmaPrimaryStarted: 0, gemmaGeometryStarted: 0 };
  const smokeFirst = await atomicCheckpoint(smokePath, smokeSnapshot, "preflight_started");
  const smokeSecond = await atomicCheckpoint(smokePath, smokeSnapshot, "preflight_checkpoint_verified");
  const smokeRecovered = await readLatestAuditCheckpoint(smokePath);
  expect(smokeFirst.sequence).toBe(1);
  expect(smokeSecond.sequence).toBe(2);
  expect(smokeRecovered).toMatchObject({ schemaVersion: 1, sequence: 2,
    event: "preflight_checkpoint_verified", snapshot: smokeSnapshot });
  expect(smokeRecovered?.snapshotSha256).toBe(hash(JSON.stringify(smokeSnapshot)));
  const rubricBytes = fs.readFileSync(RUBRIC);
  expect(hash(rubricBytes)).toBe(RUBRIC_HASH);
  const rubric = JSON.parse(rubricBytes.toString("utf8")) as { cases: RubricCase[] };
  expect(rubric.cases).toHaveLength(7);
  const ordered = [...rubric.cases].sort((a, b) => {
    const high = (value: string) => value === "high" ? 0 : 1;
    return high(a.faceVisibility) - high(b.faceVisibility) || a.sourceBytes - b.sourceBytes || a.id.localeCompare(b.id);
  });
  const selected = ordered[0];
  const sixCaseIds = ["buzz-striped", "bun-check", "warm-white-tee", "full-body-layered", "striped-open-shirt", "sleeveless-bag-skirt"];
  const sixCases = sixCaseIds.map(id => rubric.cases.find(item => item.id === id));
  expect(sixCases.every(Boolean)).toBe(true);
  const targetedCaseIds = ["warm-white-tee", "striped-open-shirt", "sleeveless-bag-skirt"];
  const targetedCases = targetedCaseIds.map(id => rubric.cases.find(item => item.id === id));
  expect(targetedCases.every(Boolean)).toBe(true);
  const openCase: RubricCase = {
    id: RUN_EXTERNAL_OPEN_ANCHOR ? "open-eye-calibration-001" : "headscarf-color-blocks", photoId: -1,
    sourceSha256: RUN_EXTERNAL_OPEN_ANCHOR ? EXTERNAL_OPEN_SOURCE_HASH : OPEN_SOURCE_FILE_HASH,
    sourceBytes: RUN_EXTERNAL_OPEN_ANCHOR ? 3_497_355 : 197_802,
    faceVisibility: RUN_EXTERNAL_OPEN_ANCHOR ? "both eyes fully visible in frozen source"
      : "both eyes fully visible in frozen reviewed artifact",
    glassesOrCovering: RUN_EXTERNAL_OPEN_ANCHOR ? "none" : "headscarf; no glasses",
    rubric: {
      eyeSpacing: { kind: "unscorable", reason: "not part of this source-label freeze" },
      eyeOpenness: { kind: "expected", values: ["open"] },
      eyeFootprint: { kind: "unscorable", reason: "not part of this source-label freeze" },
      browEyeDistance: { kind: "unscorable", reason: "not part of this source-label freeze" },
      browSlope: { kind: "unscorable", reason: "not part of this source-label freeze" },
      mouthWidth: { kind: "unscorable", reason: "not part of this source-label freeze" },
      mouthOpenness: { kind: "unscorable", reason: "not part of this source-label freeze" },
      expression: { kind: "unscorable", reason: "not part of this source-label freeze" },
    },
  };
  const selectedCases = RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL
    ? [openCase]
    : RUN_ANY_NORMAL_ANCHOR || RUN_WAVY_PRIMARY_TRACE
    ? [rubric.cases.find(item => item.id === "wavy-open-blazer")!]
    : RUN_TARGETED_PRIMARY ? targetedCases as RubricCase[]
    : RUN_FACE_GEOMETRY_TARGETS
      ? ["warm-white-tee", "striped-open-shirt"].map(id => rubric.cases.find(item => item.id === id)!)
      : RUN_SIX_CASE_PRIMARY ? sixCases as RubricCase[] : RUN_SINGLE_PRIMARY ? [selected] : [];
  const configName = `wrangler.primary-audit-${randomUUID()}.tmp.jsonc`;
  const configPath = path.resolve(configName);
  const artifact = {
    auditFeatureMode: RUN_CURRENT_DEFAULT_E2E ? "current-default-e2e" : "primary-only",
    mode: RUN_CURRENT_SOURCE_V4 ? "current_source_v4_localization_geometry" : RUN_CURRENT_DEFAULT_E2E ? "current_default_v3_generation_e2e" : RUN_EYE_APERTURE_V2 ? "experimental_eye_aperture_v2_first_live" : RUN_EYE_APERTURE ? "experimental_eye_aperture_two_crop_pilot" : RUN_V4_OPEN_GEOMETRY ? "v4_open_localization_crop_geometry_live"
      : RUN_SAVED_V4_FACE_GEOMETRY ? "saved_v4_face_crop_geometry_only_live"
      : RUN_V4_VALIDATED_PERSISTENCE ? "v4_validated_localization_persistence_live"
      : RUN_V4_WAVY_PRIMARY ? "structured_localization_v4_wavy_primary_live"
      : RUN_WAVY_RELATIONSHIP_TRACE ? "wavy_localization_relationship_trace_live"
      : RUN_WAVY_TIMEOUT_TRACE ? "primary_timeout_origin_wavy_live"
      : RUN_WAVY_DERIVATIVE ? "face_geometry_openness_wavy_production_derivative_live"
      : RUN_EXTERNAL_OPEN_ANCHOR ? "face_geometry_openness_external_open_anchor_live"
      : RUN_OPEN_DIRECTIONAL ? "face_geometry_openness_open_directional_live"
      : RUN_OPEN_ANCHOR ? "face_geometry_openness_open_anchor_live"
      : RUN_NORMAL_ANCHOR ? "face_geometry_openness_normal_anchor_live"
      : RUN_FACE_GEOMETRY_TARGETS ? "face_geometry_openness_contract_live_retest"
      : RUN_TARGETED_PRIMARY ? "targeted_eye_category_recheck"
      : RUN_SIX_CASE_PRIMARY ? "six_case_primary_batch" : RUN_PRIMARY ? "single_primary_canary" : "protected_health_only",
    branch: "main", head: "3922d659989c237bf7dc011f1dac6659cc4b3a27",
    sourceRubricSha256: hash(rubricBytes),
    faceGeometryPromptSha256: RUN_FACE_GEOMETRY_TARGETS || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL || RUN_SAVED_V4_FACE_GEOMETRY || RUN_V4_OPEN_GEOMETRY ? hash(FACE_IDENTITY_GEOMETRY_PROMPT) : null,
    faceGeometrySchemaSha256: RUN_FACE_GEOMETRY_TARGETS || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL || RUN_SAVED_V4_FACE_GEOMETRY || RUN_V4_OPEN_GEOMETRY ? hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)) : null,
    faceGeometryContract: RUN_FACE_GEOMETRY_TARGETS || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL || RUN_SAVED_V4_FACE_GEOMETRY || RUN_V4_OPEN_GEOMETRY
      ? { lateralGuard: 0.65, compactMax: 0.34, openMin: 0.68 }
      : null,
    selectedCanary: RUN_SINGLE_PRIMARY ? { id: selected.id, photoId: selected.photoId,
      expectedSha256: selected.sourceSha256, expectedBytes: selected.sourceBytes } : null,
    selectedCases: RUN_SIX_CASE_PRIMARY || RUN_TARGETED_PRIMARY || RUN_FACE_GEOMETRY_TARGETS || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL || RUN_WAVY_PRIMARY_TRACE ? selectedCases.map(item => ({ id: item.id, photoId: item.photoId,
      expectedSha256: item.sourceSha256, expectedBytes: item.sourceBytes })) : null,
    primaryContract: RUN_WAVY_PRIMARY_TRACE || RUN_V4_OPEN_GEOMETRY ? {
      expectedContractVersion: RUN_V4_WAVY_PRIMARY || RUN_V4_OPEN_GEOMETRY ? PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
        : "primary_compact_v3_legacy_suffix",
      geminiModel: production.vars.VISION_MODEL, gemmaModel: production.vars.WORKERS_VISION_MODEL,
      geminiDeadlineMs: Number(production.vars.GEMINI_STRUCTURED_TIMEOUT_MS), gemmaDeadlineMs: 45_000,
      promptBaseSha256: hash(RUN_V4_WAVY_PRIMARY || RUN_V4_OPEN_GEOMETRY ? COMPACT_PHOTO_ANALYSIS_V4_PROMPT : COMPACT_PHOTO_ANALYSIS_V3_PROMPT),
      promptFinalSha256: RUN_V4_WAVY_PRIMARY || RUN_V4_OPEN_GEOMETRY ? hash(`${COMPACT_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`) : null,
      schemaJsonSha256: hash(JSON.stringify(RUN_V4_WAVY_PRIMARY || RUN_V4_OPEN_GEOMETRY
        ? COMPACT_PHOTO_ANALYSIS_V4_PROVIDER_SCHEMA : COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)),
      gemmaPromptBaseSha256: hash(RUN_V4_WAVY_PRIMARY || RUN_V4_OPEN_GEOMETRY ? GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT : GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT),
      gemmaPromptFinalSha256: RUN_V4_WAVY_PRIMARY || RUN_V4_OPEN_GEOMETRY ? hash(`${GEMMA_NAMED_PHOTO_ANALYSIS_V4_PROMPT}${V4_REFERENCE_SUFFIX}`) : null,
      gemmaSchemaJsonSha256: hash(JSON.stringify(RUN_V4_WAVY_PRIMARY || RUN_V4_OPEN_GEOMETRY
        ? GEMMA_NAMED_PHOTO_ANALYSIS_V4_SCHEMA : GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)),
      analysisSourceSha256: hash(fs.readFileSync("src/analysis.ts")),
      geminiSourceSha256: hash(fs.readFileSync("src/gemini.ts")),
    } : null,
    wranglerVersion: JSON.parse(fs.readFileSync("node_modules/wrangler/package.json", "utf8")).version as string,
    ptyVersion: null as string | null, ptyBackendVerified: false,
    temporaryConfigUsed: false, temporaryConfigPathClass: "workers_directory",
    temporaryConfigName: configName, temporaryConfigSemanticDiff: [] as string[],
    productionConfigChanged: false, productionConfigHashBefore: hash(productionText), productionConfigHashAfter: null as string | null,
    tokenBindingPreflightPassed: false,
    preflight: null as ReturnType<typeof support.metadataPreflight> | null,
    lifecycle: [] as { stage: string; elapsedMs: number }[], outputClasses: [] as string[],
    startupAttempts: 0, devServerReadyReceived: false, localProxyReadyElapsedMs: null as number | null,
    hotkeyRegistrationProven: false, senderOwnedRelationshipVerified: false,
    healthAttempts: 0, healthElapsedMs: null as number | null,
    health: null as Awaited<ReturnType<typeof boundedHealthProbe>> | null,
    qSentCount: 0, shutdownRequested: false,
    wrapperExitObserved: false, wrapperCloseObserved: false, wrapperExitCode: null as number | null,
    wrapperSignalAbsent: false, bridgeCompletionObserved: false,
    ptyExitObserved: false, ptyExitCode: null as number | null,
    ownerResultFlushed: false, ownerExitObserved: false, ownerCloseObserved: false, ownerExitCode: null as number | null,
    ownedProcessCount: 0, ownedProcessInventoryClean: false, cleanupFailed: false,
    temporaryConfigRemoved: false, temporaryTokenFileRemoved: false, temporaryTokenFileCreated: false,
    temporaryDirectoryAclRestricted: false, inheritanceDisabled: false,
    currentUserAccessPresent: false, systemAccessPresent: false,
    broadInheritedAccessPresent: false, unexpectedAccessPresent: false,
    wranglerGracefulTeardownPathCompleted: false, serverSidePreviewDeletionIndependentlyConfirmed: false,
    calls: { sourceReads: verifiedOpen || currentV4Preflight ? 1 : 0, derivativeReads: verifiedOpen ? 1 : 0,
      jpegReads: verifiedOpen || currentV4Preflight ? 1 : 0, hashChecks: 0, fileHashChecks: verifiedOpen || currentV4Preflight ? 1 : 0,
      rgbaHashChecks: verifiedOpen ? 2 : currentV4Preflight ? 1 : 0,
      derivativeHashChecks: verifiedOpen ? 1 : 0, derivativeRgbaHashChecks: verifiedOpen ? 1 : 0,
      base64Preparations: aperturePreflight || apertureV2Preflight ? 2 : 0, jpegTransmissions: 0, jpegOrPngTransmissions: 0, primaryPosts: 0,
      faceCropPreparations: 0, geometryPosts: 0 },
    providerCalls: null as null | { geminiStarted: number; geminiCompleted: number; geminiFailed: number;
      gemmaStarted: number; gemmaCompleted: number; gemmaFailed: number; retry: 0 },
    primaryProviderCalls: null as null | { geminiStarted: number; geminiCompleted: number; geminiFailed: number;
      gemmaStarted: number; gemmaCompleted: number; gemmaFailed: number; retry: 0 },
    geometryProviderCalls: null as null | { geminiStarted: number; geminiCompleted: number; geminiFailed: number;
      gemmaStarted: number; gemmaCompleted: number; gemmaFailed: number; retry: 0 },
    providerAccounting: "not_attempted" as "not_attempted" | "known" | "unknown",
    primaryHttpStatus: null as number | null,
    geometryHttpStatus: null as number | null,
    filesystemRetryCount: smokeFirst.filesystemRetryCount + smokeSecond.filesystemRetryCount,
    summaryProjectionFailures: Number(smokeFirst.summaryProjectionFailed) + Number(smokeSecond.summaryProjectionFailed),
    checkpointVersionCount: smokeSecond.sequence,
    primary: null as null | Record<string, unknown>,
    validLocalization: null as null | Record<string, unknown>,
    validatedLocalizationEvidence: null as ValidatedLocalizationEvidence | null,
    validatedLocalizationCapture: null as null | { status: "captured" | "not_captured";
      reason?: string; provenanceComplete?: boolean; missingProvenance?: string[] },
    primaryResults: [] as Array<Record<string, unknown>>,
    geometryResults: [] as Array<Record<string, unknown>>,
    savedV4FaceGeometry: null as null | Record<string, unknown>,
    v4Open: null as null | Record<string, unknown>,
    aperturePilot: aperturePreflight ? createAperturePilotState(aperturePreflight) : null,
    apertureV2: apertureV2Preflight ? createApertureV2State(apertureV2Preflight) : null,
    currentDefaultE2E: e2ePreflight ? createE2EState(e2ePreflight) : null,
    currentSourceV4: currentV4Preflight ? createCurrentSourceV4State() : null,
    currentSourceV4Preflight: currentV4Preflight ? { source: currentV4Preflight.source, input: currentV4Preflight.input,
      contract: currentV4Preflight.contract, fixedHashes: currentV4Preflight.fixedHashes } : null,
    normalAnchor: null as null | Record<string, unknown>,
    openNormalComparison: null as null | Record<string, unknown>,
    openAnchor: null as null | Record<string, unknown>,
    openDirectional: null as null | Record<string, unknown>,
    frozenSourcePreflight: null as null | Record<string, unknown>,
    rubricComparison: null as null | Array<Record<string, unknown>>,
    remainingSixAnalyzed: 0,
    prohibited: { ...(RUN_CURRENT_DEFAULT_E2E || RUN_CURRENT_SOURCE_V4 ? {} : { primaryGemini: 0, primaryGemma: 0 }), newStripedGeometry: 0, newWarmGeometry: 0,
      fullIdentityGeometry: 0, portraitDetail: 0, neckDetail: 0,
      imageGeneration: 0, skinImageGeneration: 0,
      critique: 0, pairwise: 0, evaluator: 0 },
    packageManagerCalls: 0, productionAdditionalDiff: 0,
    classification: "not_started",
  };
  const start = Date.now();
  const checkpoint = path.join(root, "summary.json");
  let writes: Promise<void> = Promise.resolve();
  let checkpointFailure: unknown = null;
  const persist = (stage = "checkpoint"): Promise<void> => {
    // Snapshot before asynchronous IO so later lifecycle changes cannot mutate
    // the checkpoint payload that is already queued.
    const snapshot = structuredClone(artifact);
    const next = writes.then(async () => {
      const result = await atomicCheckpoint(checkpoint, snapshot, stage);
      artifact.filesystemRetryCount += result.filesystemRetryCount;
      if (result.summaryProjectionFailed) artifact.summaryProjectionFailures++;
      artifact.checkpointVersionCount = result.sequence;
    });
    writes = next.catch(error => {
      checkpointFailure ??= error;
      artifact.classification = "BLOCKED: audit checkpoint persistence failed";
    });
    void next.catch(() => {});
    return next;
  };
  const observe = (stage: string): Promise<void> => {
    artifact.lifecycle.push({ stage, elapsedMs: Date.now() - start });
    return persist(stage);
  };
  const durableObserve = async (stage: string): Promise<void> => {
    await observe(stage);
    if (checkpointFailure) throw checkpointFailure;
  };
  let token = "";
  let tokenDirectory: string | null = null;
  let tokenFile: string | null = null;
  let owner: ReturnType<typeof spawn> | null = null;
  const owned: ProcessRecord[] = [];
  let before: ProcessRecord[] = [];
  let ownerClosed = false;
  let ownerExited = false;
  let qRequested = false;
  let exitPromise: Promise<number | null> | null = null;
  let closePromise: Promise<number | null> | null = null;
  const updateInventory = () => {
    const snapshot = support.processSnapshot();
    const records = support.descendants(snapshot, process.pid)
      .filter(record => !before.some(old => old.pid === record.pid && old.created === record.created));
    for (const record of records) if (!owned.some(old => old.pid === record.pid && old.created === record.created)) owned.push(record);
    artifact.ownedProcessCount = owned.length;
    return snapshot;
  };
  persist();
  try {
    const auditText = support.deriveConfig(productionText);
    const audit = support.parseConfig(auditText);
    artifact.temporaryConfigSemanticDiff = support.assertConfigDelta(production, audit);
    artifact.tokenBindingPreflightPassed = support.tokenBindingPreflight(cli, production, audit, configPath);
    artifact.preflight = support.metadataPreflight(cli, audit, path.dirname(configPath));
    if (RUN_FACE_GEOMETRY_TARGETS || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL || RUN_SAVED_V4_FACE_GEOMETRY || RUN_V4_OPEN_GEOMETRY) {
      expect(artifact.faceGeometryPromptSha256).toBe(FACE_GEOMETRY_PROMPT_HASH);
      expect(artifact.faceGeometrySchemaSha256).toBe(FACE_GEOMETRY_SCHEMA_HASH);
      expect(fs.readFileSync("src/generate.ts", "utf8")).toContain("headHeightPixels * 0.65");
      expect(fs.readFileSync("src/identityQuantization.ts", "utf8"))
        .toContain('geometry.eyes.openness >= 0.68 ? "open" : geometry.eyes.openness <= 0.34 ? "compact" : "readable"');
    }
    if (RUN_SAVED_V4_FACE_GEOMETRY) {
      const saved = await verifySavedV4FaceCropMetadata();
      artifact.savedV4FaceGeometry = { status: "preflight_verified", caseId: saved.evidence.caseId,
        sourceSha256: saved.evidence.sourceSha256, derivativeSha256: saved.evidence.derivativeSha256,
        primaryContractVersion: saved.evidence.expectedContractVersion,
        primaryProvider: saved.evidence.provider, primaryModel: saved.evidence.model,
        primaryPromptSha256: saved.evidence.promptSha256, primarySchemaJsonSha256: saved.evidence.schemaJsonSha256,
        primaryHashDomains: saved.evidence.hashDomains, primaryValidation: saved.evidence.contractValidation,
        primaryRunId: saved.evidence.runId, firstEvidenceCheckpoint: saved.first,
        finalEvidenceCheckpoint: saved.final, portraitImageIndex: saved.evidence.portraitImageIndex,
        validatedRegion: saved.evidence.region, cropSha256: SAVED_V4_CROP_SHA,
        cropDimensions: saved.crop.outputDimensions, cropProvenance: "saved_v4_region_current_production_helper_offline",
        geometryModel: FACE_GEOMETRY_MODEL, geometryTimeoutMs: FACE_GEOMETRY_TIMEOUT_MS,
        geometryPromptSha256: artifact.faceGeometryPromptSha256,
        geometrySchemaJsonSha256: artifact.faceGeometrySchemaSha256,
        geometryHashDomains: { prompt: "prompt_utf8_sha256", schema: "json_stringify_response_schema_sha256" },
        acceptedGeometry: null, normalOpenness: null };
      await durableObserve("savedV4GeometryMetadataPreflightPassed");
    }
    if (RUN_V4_OPEN_GEOMETRY) {
      const normal = openNormal!;
      expect(artifact.primaryContract).toMatchObject({
        expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
        geminiModel: "gemini-3.8-flash", gemmaModel: "@cf/google/gemma-4-26b-a4b-it",
        geminiDeadlineMs: 45_000, gemmaDeadlineMs: 45_000,
        promptFinalSha256: V4_GEMINI_PROMPT_HASH, schemaJsonSha256: V4_GEMINI_SCHEMA_HASH,
        gemmaPromptFinalSha256: V4_GEMMA_PROMPT_HASH, gemmaSchemaJsonSha256: V4_GEMMA_SCHEMA_HASH,
      });
      const frozen = JSON.parse(fs.readFileSync(EXTERNAL_OPEN_FREEZE, "utf8")) as {
        payload: { caseId: string; sourceSha256: string; decodedRgbaSha256: string; bytes: number;
          dimensions: { width: number; height: number }; label: { eyeOpenness: string };
          labelFrozenBeforeProvider: boolean; sourceReview: { lateralFaceMargins: string;
            stableAperture: string; glasses: string; occlusion: string } }; payloadSha256: string };
      expect([hash(JSON.stringify(frozen.payload)), frozen.payloadSha256]).toEqual([
        EXTERNAL_OPEN_PAYLOAD_HASH, EXTERNAL_OPEN_PAYLOAD_HASH]);
      expect(frozen.payload).toMatchObject({ caseId: "open-eye-calibration-001",
        sourceSha256: EXTERNAL_OPEN_SOURCE_HASH, decodedRgbaSha256: "235b852bbcc9acf02d84e484705d7174a1bbb33748bf5f12ce1aa47f9a7a9c89",
        bytes: 3_497_355, dimensions: { width: 2002, height: 3000 },
        label: { eyeOpenness: "open" }, labelFrozenBeforeProvider: true,
        sourceReview: { lateralFaceMargins: "FULL_FACE_MARGIN_OK", stableAperture: "stable_large",
          glasses: "none", occlusion: "none" } });
      expect(hash(fs.readFileSync("src/generate.ts"))).toBe(normal.policyIdentity.generateSourceSha256);
      expect(hash(fs.readFileSync("src/adaptiveHeadCrop.ts"))).toBe(normal.policyIdentity.adaptiveHeadCropSourceSha256);
      expect(hash(fs.readFileSync("src/png.ts"))).toBe(normal.policyIdentity.decoderSourceSha256);
      artifact.frozenSourcePreflight = { caseId: frozen.payload.caseId, sourceSha256: frozen.payload.sourceSha256,
        payloadSha256: frozen.payloadSha256, label: "open", labelFrozenBeforeProvider: true,
        providerInputBasis: "frozen_598x896_analysis_derivative" };
      artifact.v4Open = { status: "preflight_verified", normalReference: {
        checkpointSequence: normal.sequence, checkpointSha256: normal.snapshotSha256,
        openness: normal.normalOpenness, eyesConfidence: normal.eyesConfidence },
        sourceSha256: EXTERNAL_OPEN_SOURCE_HASH, derivativeSha256: EXTERNAL_OPEN_DERIVATIVE_HASH,
        expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
        cropPolicyIdentity: normal.policyIdentity,
        acceptedGeometry: null, openOpenness: null, eyesConfidence: null };
      await durableObserve("v4OpenMetadataPreflightPassed");
    }
    if (RUN_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL) {
      const frozen = JSON.parse(fs.readFileSync(OPEN_FREEZE, "utf8")) as {
        payload: Record<string, unknown> & {
          status?: string; canonicalSourceLabel?: { eyeOpenness?: string }; candidateTier?: string;
          labelProvenance?: string; labelFrozenBeforeProvider?: boolean; providerResultsConsulted?: boolean;
          geometryResultsConsulted?: boolean; reviewedArtifactFileSha256?: string;
          reviewedArtifactDecodedRgbaSha256?: string; reviewedArtifactBytes?: number;
          reviewedArtifactDimensions?: { width?: number; height?: number };
        };
        payloadSha256?: string;
      };
      const lineage = JSON.parse(fs.readFileSync(OPEN_LINEAGE, "utf8")) as {
        classification?: string; originalSource?: { rawFileAvailable?: boolean };
        reviewedArtifact?: { fileSha256?: string; decodedRgbaSha256?: string; bytes?: number;
          dimensions?: { width?: number; height?: number }; manifestPixelHashMatches?: boolean };
      };
      expect(hash(JSON.stringify(frozen.payload))).toBe(OPEN_FREEZE_PAYLOAD_HASH);
      expect(frozen.payloadSha256).toBe(OPEN_FREEZE_PAYLOAD_HASH);
      expect(frozen.payload).toMatchObject({
        status: "OPEN_SOURCE_CONFIRMED", canonicalSourceLabel: { eyeOpenness: "open" },
        candidateTier: "TIER_A_OPEN_SOURCE_READY", labelProvenance: "manual_source_review",
        labelFrozenBeforeProvider: true, providerResultsConsulted: false, geometryResultsConsulted: false,
        reviewedArtifactFileSha256: OPEN_SOURCE_FILE_HASH,
        reviewedArtifactDecodedRgbaSha256: OPEN_SOURCE_RGBA_HASH,
        reviewedArtifactBytes: 197_802, reviewedArtifactDimensions: { width: 270, height: 308 },
      });
      expect(lineage).toMatchObject({
        classification: "VERIFIED_DERIVED_ARTIFACT", originalSource: { rawFileAvailable: false },
        reviewedArtifact: { fileSha256: OPEN_SOURCE_FILE_HASH, decodedRgbaSha256: OPEN_SOURCE_RGBA_HASH,
          bytes: 197_802, dimensions: { width: 270, height: 308 }, manifestPixelHashMatches: true },
      });
      artifact.frozenSourcePreflight = {
        sourceClass: "frozen_reviewed_derived_artifact", lineage: lineage.classification,
        originalRawBytesAvailable: lineage.originalSource?.rawFileAvailable ?? null,
        label: frozen.payload.canonicalSourceLabel, labelProvenance: frozen.payload.labelProvenance,
        labelFrozenBeforeProvider: frozen.payload.labelFrozenBeforeProvider,
        providerResultsConsulted: frozen.payload.providerResultsConsulted,
        geometryResultsConsulted: frozen.payload.geometryResultsConsulted,
        payloadSha256: frozen.payloadSha256,
      };
    }
    if (RUN_EXTERNAL_OPEN_ANCHOR) {
      expect(hash(fs.readFileSync(path.resolve("../src/lib/imageQuality.ts")))).toBe(EXTERNAL_OPEN_PREPROCESSING_SOURCE_HASH);
      const frozen = JSON.parse(fs.readFileSync(EXTERNAL_OPEN_FREEZE, "utf8")) as {
        payload: { sourceSha256: string; bytes: number; dimensions: { width: number; height: number };
          label: { eyeOpenness: string }; labelFrozenBeforeProvider: boolean };
        payloadSha256: string;
      };
      expect(hash(JSON.stringify(frozen.payload))).toBe(EXTERNAL_OPEN_PAYLOAD_HASH);
      expect(frozen.payloadSha256).toBe(EXTERNAL_OPEN_PAYLOAD_HASH);
      expect(frozen.payload).toMatchObject({ sourceSha256: EXTERNAL_OPEN_SOURCE_HASH,
        bytes: 3_497_355, dimensions: { width: 2002, height: 3000 },
        label: { eyeOpenness: "open" }, labelFrozenBeforeProvider: true });
      artifact.frozenSourcePreflight = { sourceClass: "canonical_original",
        sourceReviewBasis: "canonical_original", providerInputBasis: "production_analysis_derivative",
        sourceSha256: EXTERNAL_OPEN_SOURCE_HASH, labelFrozenBeforeProvider: true,
        payloadSha256: EXTERNAL_OPEN_PAYLOAD_HASH };
    }
    if (RUN_WAVY_PRIMARY_INPUT) {
      const derivativeManifest = JSON.parse(fs.readFileSync(path.join(WAVY_PARITY, "production-derivatives.json"), "utf8")) as Array<{
        caseId: string; sourceSha256: string; derivativeSha256: string; derivativeBytes: number;
        derivativeDimensions: number[]; derivativeDecodedRgbaSha256: string; dataUrlChars: number;
        selectedQuality: number; newDerivativeRawOpenness: string;
      }>;
      const frozen = derivativeManifest.find(item => item.caseId === "wavy");
      expect(frozen).toMatchObject({ sourceSha256: "fbfd573be40b623d70da02a56bb876a1b53abb88f1806188b1a40b74f2ef2702",
        derivativeSha256: WAVY_DERIVATIVE_HASH, derivativeBytes: 45_769, derivativeDimensions: [597, 896],
        derivativeDecodedRgbaSha256: WAVY_DERIVATIVE_RGBA_HASH, dataUrlChars: 61_051,
        selectedQuality: 0.85, newDerivativeRawOpenness: "unknown" });
      expect(selectedCases).toHaveLength(1);
      expect(selectedCases[0]).toMatchObject({ id: "wavy-open-blazer", photoId: 19_908_659,
        sourceSha256: frozen!.sourceSha256, sourceBytes: 70_987,
        glassesOrCovering: "none", rubric: { eyeOpenness: { kind: "expected", values: ["normal"] } } });
      artifact.frozenSourcePreflight = { sourceClass: "canonical_wavy_source",
        sourceReviewBasis: "pre-existing frozen manual rubric", providerInputBasis: "production_analysis_derivative",
        sourceSha256: frozen!.sourceSha256, derivativeSha256: frozen!.derivativeSha256,
        sourceLabel: "normal", labelFrozenBeforeProvider: true, productionInputParity: true };
    }
    if (RUN_WAVY_PRIMARY_TRACE) {
      expect(artifact.primaryContract).toMatchObject({
        geminiModel: "gemini-3.8-flash", gemmaModel: "@cf/google/gemma-4-26b-a4b-it",
        geminiDeadlineMs: 45_000, gemmaDeadlineMs: 45_000,
      });
      const analysisSource = fs.readFileSync("src/analysis.ts", "utf8");
      const geminiSource = fs.readFileSync("src/gemini.ts", "utf8");
      expect(analysisSource).toContain("timeoutCapMs: 45_000");
      expect(geminiSource).toContain("const DEFAULT_STRUCTURED_TIMEOUT_MS = 45_000");
      expect(geminiSource).toContain("return runWorkersAiStructuredFallback(env, request, 2)");
      expect(geminiSource).toContain("env.AI!.run(model as never, input as never)");
      expect(geminiSource).toContain("maxAttempts: 1");
      if (RUN_V4_WAVY_PRIMARY) {
        expect(artifact.primaryContract).toMatchObject({
          expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
          promptFinalSha256: V4_GEMINI_PROMPT_HASH, schemaJsonSha256: V4_GEMINI_SCHEMA_HASH,
          gemmaPromptFinalSha256: V4_GEMMA_PROMPT_HASH, gemmaSchemaJsonSha256: V4_GEMMA_SCHEMA_HASH,
        });
      }
    }
    expect(artifact.tokenBindingPreflightPassed).toBe(true);
    expect(artifact.preflight.selectedProfileClass).toBe("non_default");
    expect(artifact.preflight.approvedAccountIdMatch && artifact.preflight.authOverrideAbsent && artifact.preflight.dotenvOverrideAbsent).toBe(true);
    expect(artifact.wranglerVersion).toBe("4.120.0");
    expect(cli).toContain("isInteractive() && args.showInteractiveDevSession !== false");
    const registration = cli.indexOf("unregisterHotKeys = registerDevHotKeys(devEnvs, args, { tunnelManager });");
    const readyEmission = cli.indexOf('event: "DEV_SERVER_READY"', registration);
    expect(registration).toBeGreaterThan(0); expect(readyEmission).toBeGreaterThan(registration);
    const pty = support.discoverPty();
    artifact.ptyVersion = pty.version;
    artifact.ptyBackendVerified = pty.publicSpawnLoaded && pty.nativeBackendLoaded;
    before = support.processSnapshot();
    fs.writeFileSync(configPath, auditText, { flag: "wx" });
    artifact.temporaryConfigUsed = true;
    // Secure the empty directory before any token is written. Tokens never
    // enter command arguments, config, checkpoints, output, or exceptions.
    tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skin-audit-token-"));
    const acl = support.restrictTemporaryDirectory(tokenDirectory);
    artifact.temporaryDirectoryAclRestricted = acl.aclRestricted;
    artifact.inheritanceDisabled = acl.inheritanceDisabled;
    artifact.currentUserAccessPresent = acl.currentUserAccessPresent;
    artifact.systemAccessPresent = acl.systemAccessPresent;
    artifact.broadInheritedAccessPresent = acl.broadInheritedAccessPresent;
    artifact.unexpectedAccessPresent = acl.unexpectedAccessPresent;
    expect(artifact.temporaryDirectoryAclRestricted).toBe(true);
    token = randomBytes(32).toString("hex");
    tokenFile = path.join(tokenDirectory, "audit.env");
    fs.writeFileSync(tokenFile, `PRIMARY_AUDIT_TOKEN=${token}\n`, { flag: "wx" });
    artifact.temporaryTokenFileCreated = true;
    await durableObserve("preflightPassed");
    let resolveReady!: (value: { ip: string; port: number }) => void;
    const localReady = new Promise<{ ip: string; port: number }>(resolve => { resolveReady = resolve; });
    const startOwner = () => spawn(process.execPath,
      [path.resolve("test/fixtures/primaryAuditCliHealthPty.cjs"), "owner", pty.directory, configName, tokenFile!, artifact.auditFeatureMode], {
        cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      });
    owner = RUN_V4_OPEN_GEOMETRY
      ? await launchAfterV4OpenPreflight(async () => {
        if (!verifiedOpen || hash(verifiedOpen.derivative) !== EXTERNAL_OPEN_DERIVATIVE_HASH)
          throw new Error("v4_open_preflight_not_verified");
      }, startOwner)
      : startOwner();
    artifact.startupAttempts = 1;
    observe("cliOwnerSpawnRequested");
    exitPromise = new Promise(resolve => owner!.once("exit", code => {
      ownerExited = true; artifact.ownerExitObserved = true; artifact.ownerExitCode = code;
      observe("ownerExitObserved"); resolve(code);
    }));
    closePromise = new Promise(resolve => owner!.once("close", code => {
      ownerClosed = true; artifact.ownerCloseObserved = true; observe("ownerCloseObserved"); resolve(code);
    }));
    let bridgePid: number | null = null;
    let wrapperPid: number | null = null;
    owner.on("error", () => { artifact.classification = "BLOCKED: PTY owner startup failed"; observe("ownerSpawnError"); });
    owner.on("message", raw => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (message.kind === "owner_started") {
        if (message.ownerPid !== owner?.pid || !Number.isInteger(message.bridgePid)) return;
        bridgePid = message.bridgePid as number;
        updateInventory(); observe("ptyOwnerStarted");
      } else if (message.kind === "bridge_started") {
        if (message.bridgePid !== bridgePid || !Number.isInteger(message.wrapperPid) || message.stdinTTY !== true || message.stdoutTTY !== true) return;
        wrapperPid = message.wrapperPid as number;
        updateInventory(); observe("ttyBridgeStarted");
      } else if (message.kind === "ready" && !artifact.devServerReadyReceived) {
        const payload = support.parseReady(message.payload);
        if (!payload || message.bridgePid !== bridgePid || message.wrapperPid !== wrapperPid) return;
        const inventory = updateInventory();
        const bridge = inventory.find(item => item.pid === bridgePid && item.parent === owner?.pid);
        const wrapper = inventory.find(item => item.pid === wrapperPid && item.parent === bridgePid);
        const innerCli = inventory.find(item => item.parent === wrapperPid);
        if (!bridge || !wrapper || !innerCli) return;
        artifact.senderOwnedRelationshipVerified = true;
        artifact.devServerReadyReceived = true;
        artifact.hotkeyRegistrationProven = true;
        artifact.localProxyReadyElapsedMs = Date.now() - start;
        observe("localProxyReady"); resolveReady(payload);
      } else if (message.kind === "hotkeys_registered") {
        artifact.hotkeyRegistrationProven = true; observe("interactiveUiRegistered");
      } else if (message.kind === "classification" && ["auth_error", "build_error", "unknown_error"].includes(message.value as string)) {
        if (!artifact.outputClasses.includes(message.value as string)) artifact.outputClasses.push(message.value as string);
        observe("cliOutputClassified");
      } else if (message.kind === "q_sent") { artifact.qSentCount = 1; observe("qSent"); }
      else if (message.kind === "wrapper_exit") { artifact.wrapperExitObserved = true; observe("wrapperExitObserved"); }
      else if (message.kind === "wrapper_close") { artifact.wrapperCloseObserved = true; observe("wrapperCloseObserved"); }
      else if (message.kind === "pty_exit") { artifact.ptyExitObserved = true; observe("ptyExitObserved"); }
      else if (message.kind === "owner_result_flushed") { artifact.ownerResultFlushed = true; observe("ownerResultFlushed"); }
      else if (message.kind === "result") {
        const state = message.state as Record<string, unknown>;
        for (const key of ["wrapperExitObserved", "wrapperCloseObserved", "wrapperSignalAbsent", "bridgeCompletionObserved", "ptyExitObserved"] as const) artifact[key] = state[key] === true;
        artifact.wrapperExitCode = Number.isInteger(state.wrapperExitCode) ? state.wrapperExitCode as number : null;
        artifact.ptyExitCode = Number.isInteger(state.ptyExitCode) ? state.ptyExitCode as number : null;
        artifact.qSentCount = state.qSentCount === 1 ? 1 : 0;
        observe("ptyOwnerResult");
      }
    });
    const startup = await bounded(Promise.race([localReady.then(value => ({ status: "ready" as const, value })),
      exitPromise.then(() => ({ status: "exit" as const }))]), 30_000);
    if (!startup.done || startup.value.status !== "ready") {
      artifact.classification = artifact.outputClasses.includes("auth_error")
        ? "BLOCKED: bound-profile remote preview authentication failed" : "BLOCKED: DEV_SERVER_READY not observed";
    } else {
      const url = `http://${startup.value.value.ip}:${startup.value.value.port}`;
      updateInventory();
      const healthStart = Date.now();
      artifact.health = await boundedHealthProbe({ fetch: (_url, init) => fetch(`${url}/primary-audit-health`, init) }, token, stage => {
        if (stage === "healthRequestStarted") artifact.healthAttempts++;
        observe(stage);
      });
      artifact.healthElapsedMs = Date.now() - healthStart;
      artifact.classification = artifact.health.status === "passed" ? "health_passed_cleanup_pending"
        : artifact.health.httpStatus === 403 ? "BLOCKED: protected health token binding failed" : "BLOCKED: protected remote health failed";
      updateInventory(); await durableObserve("healthCompleted");
      if (RUN_CURRENT_SOURCE_V4 && artifact.health.status === "passed" && currentV4Preflight && artifact.currentSourceV4) {
        await runCurrentSourceV4(artifact.currentSourceV4, currentV4Preflight, async (route, imageDataUrl, requestRunId) => {
          const response = await fetch(`${url}${route}`, {
            method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": token,
              "x-primary-audit-run-id": requestRunId }, body: JSON.stringify({ imageDataUrl }),
            signal: AbortSignal.timeout(route === "/primary-audit-v4-structured-localization" ? 120_000 : 60_000),
          });
          return { status: response.status, body: await response.json() };
        }, async stage => {
          const s = artifact.currentSourceV4!;
          artifact.calls.primaryPosts = s.primaryPosts; artifact.calls.geometryPosts = s.geometryPosts;
          artifact.calls.faceCropPreparations = s.cropPreparations;
          artifact.calls.jpegTransmissions = s.primaryPosts;
          artifact.calls.jpegOrPngTransmissions = s.primaryPosts + s.geometryPosts;
          artifact.primaryHttpStatus = s.primaryHttp; artifact.geometryHttpStatus = s.geometryHttp;
          artifact.primaryProviderCalls = s.primaryAccounting.dispatch === "known" ? s.primaryAccounting.providerCalls : null;
          artifact.geometryProviderCalls = s.geometryAccounting?.dispatch === "known" ? s.geometryAccounting.providerCalls : null;
          artifact.providerAccounting = s.primaryAccounting.dispatch === "known"
            && (!s.geometryPosts || s.geometryAccounting?.dispatch === "known") ? "known" : "unknown";
          // Missing response accounting is never projected as zero provider calls.
          artifact.providerCalls = artifact.providerAccounting === "known" ? { ...artifact.primaryProviderCalls! } : null;
          if (artifact.providerCalls && artifact.geometryProviderCalls) for (const key of
            ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const)
            artifact.providerCalls[key] += artifact.geometryProviderCalls[key];
          await durableObserve(stage);
        });
        artifact.classification = "current_source_v4_completed_cleanup_pending";
      }
      if (RUN_CURRENT_DEFAULT_E2E && artifact.health.status === "passed" && e2ePreflight && artifact.currentDefaultE2E) {
        await runCurrentDefaultE2E(artifact.currentDefaultE2E, e2ePreflight, async (payload, requestRunId) => {
          const response = await fetch(`${url}/current-default-e2e-audit`, {
            method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": token,
              "x-primary-audit-run-id": requestRunId, "x-current-default-e2e": E2E_MARKER,
              "x-e2e-analysis-sha": e2ePreflight.metadata.analysis.sha256,
              "x-e2e-generation-sha": e2ePreflight.metadata.generation.sha256 },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(150_000),
          });
          return { status: response.status, body: await response.json() as Record<string, unknown> };
        }, durableObserve, root);
        artifact.providerAccounting = artifact.currentDefaultE2E.accounting === "known" ? "known" : "unknown";
        artifact.classification = "current_default_e2e_completed_cleanup_pending";
      }
      if (RUN_EYE_APERTURE_V2 && artifact.health.status === "passed" && apertureV2Preflight && artifact.apertureV2) {
        const batch = artifact.apertureV2;
        await runApertureV2Batch(batch, apertureV2Preflight.inputs.map(i => i.dataUrl), async (body, requestRunId) => {
          artifact.calls.jpegOrPngTransmissions++;
          const response = await fetch(`${url}/experimental-eye-aperture-v2-audit`, {
            method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": token,
              "x-primary-audit-run-id": requestRunId }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
          });
          return { status: response.status, body: await response.json() };
        }, async event => {
          artifact.providerAccounting = batch.dispatchAccounting === "unknown" ? "unknown" : batch.posts ? "known" : "not_attempted";
          const counts = { geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0, gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0 as const };
          for (const slot of batch.slots) if (slot.accounting?.dispatch === "known")
            for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const)
              counts[key] += slot.accounting.providerCalls[key];
          artifact.providerCalls = artifact.providerAccounting === "unknown" ? null : counts;
          await durableObserve(event);
        });
        artifact.classification = "aperture_v2_completed_cleanup_pending";
      }
      if (RUN_EYE_APERTURE && artifact.health.status === "passed" && aperturePreflight && artifact.aperturePilot) {
        const pilot = artifact.aperturePilot;
        await runAperturePilot(pilot, aperturePreflight.inputs.map(input => input.dataUrl), async (body, requestRunId) => {
          artifact.calls.jpegOrPngTransmissions++;
          const response = await fetch(`${url}/experimental-eye-aperture-audit`, {
            method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": token,
              "x-primary-audit-run-id": requestRunId }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
          });
          return { status: response.status, body: await response.json() };
        }, async event => {
          artifact.providerAccounting = pilot.dispatchAccounting === "unknown" ? "unknown" : pilot.posts ? "known" : "not_attempted";
          const counts = { geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
            gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0 as const };
          for (const slot of pilot.slots) if (slot.accounting?.dispatch === "known") {
            for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const)
              counts[key] += slot.accounting.providerCalls[key];
          }
          artifact.providerCalls = artifact.providerAccounting === "unknown" ? null : counts;
          await durableObserve(event);
        });
        artifact.classification = "aperture_completed_cleanup_pending";
      }
      if (RUN_V4_OPEN_GEOMETRY && artifact.health.status === "passed") {
        artifact.providerCalls = { geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
          gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0 };
        if (!verifiedOpen) throw new Error("v4_open_preflight_not_verified");
        // Only the previously verified frozen derivative is eligible for transmission.
        const derivative = verifiedOpen.derivative;
        expect(hash(derivative)).toBe(EXTERNAL_OPEN_DERIVATIVE_HASH);
        const imageDataUrl = `data:image/jpeg;base64,${bytesToBase64(derivative)}`;
        artifact.calls.base64Preparations++;
        expect(imageDataUrl.length).toBe(verifiedOpen.dataUrlChars);
        expect(imageDataUrl.length).toBeLessThanOrEqual(MAX_IMAGE_CHARS);
        expect(hash(Buffer.from(imageDataUrl.slice("data:image/jpeg;base64,".length), "base64")))
          .toBe(EXTERNAL_OPEN_DERIVATIVE_HASH);
        artifact.v4Open = { ...artifact.v4Open, status: "source_verified", derivativeBytes: derivative.length,
          derivativeDimensions: verifiedOpen.derivativeDimensions,
          derivativeDecodedRgbaSha256: verifiedOpen.derivativeDecodedRgbaSha256 };
        await durableObserve("v4OpenSourceAndDerivativeVerified");
        const primaryRunId = randomBytes(16).toString("hex");
        artifact.v4Open = { ...artifact.v4Open, status: "primary_intent_durable", primaryRunId,
          primaryImageSha256: EXTERNAL_OPEN_DERIVATIVE_HASH, primaryImageCount: 1,
          primaryPromptSha256: V4_GEMINI_PROMPT_HASH, primarySchemaJsonSha256: V4_GEMINI_SCHEMA_HASH };
        await durableObserve("v4OpenPrimaryRequestIntent");
        artifact.calls.primaryPosts++; artifact.calls.jpegTransmissions++; artifact.calls.jpegOrPngTransmissions++;
        await durableObserve("v4OpenPrimaryPostStarted");
        const primaryResponse = await fetch(`${url}/primary-audit-v4-structured-localization`, {
          method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": token,
            "x-primary-audit-run-id": primaryRunId },
          body: JSON.stringify({ imageDataUrl }), signal: AbortSignal.timeout(120_000),
        });
        artifact.primaryHttpStatus = primaryResponse.status;
        await durableObserve("v4OpenPrimaryHeadersReceived");
        const primaryResult = await primaryResponse.json() as RemoteResult;
        await durableObserve("v4OpenPrimaryBodyParsed");
        const primaryAccounting = accountingOf(primaryResult.auditState, primaryRunId);
        artifact.providerAccounting = primaryAccounting.dispatch;
        if (primaryAccounting.dispatch === "known") {
          artifact.primaryProviderCalls = primaryAccounting.providerCalls;
          for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
            artifact.providerCalls[key] += primaryAccounting.providerCalls[key];
          }
        }
        const completed = (primaryResult.providerSequence ?? []).filter(item => item.outcome === "completed");
        const selectedProvider = completed.length === 1 ? completed[0] : null;
        const selectedHashes = selectedProvider?.provider === "gemini"
          ? { promptSha256: V4_GEMINI_PROMPT_HASH, schemaJsonSha256: V4_GEMINI_SCHEMA_HASH }
          : selectedProvider?.provider === "workers_ai"
            ? { promptSha256: V4_GEMMA_PROMPT_HASH, schemaJsonSha256: V4_GEMMA_SCHEMA_HASH } : null;
        await checkpointValidatedLocalizationCapture({
          primaryOk: primaryResponse.ok && primaryResult.ok === true
            && primaryResult.validation?.richPhotoAnalysis === "passed",
          expectedContractVersion: primaryResult.expectedContractVersion,
          contractValidation: primaryResult.contractValidation,
          protectedLocalization: primaryResult.validatedLocalization,
          localizationTrace: primaryResult.localizationTrace,
          imageCount: 1, runId: primaryRunId, caseId: "open-eye-calibration-001",
          sourceSha256: EXTERNAL_OPEN_SOURCE_HASH, derivativeSha256: EXTERNAL_OPEN_DERIVATIVE_HASH,
          inputDimensions: { width: 598, height: 896 }, provider: selectedProvider?.provider,
          model: selectedProvider?.model ?? selectedProvider?.modelId,
          promptSha256: selectedHashes?.promptSha256, schemaJsonSha256: selectedHashes?.schemaJsonSha256,
        }, async capture => {
          artifact.validatedLocalizationEvidence = capture.status === "captured" ? capture.evidence : null;
          artifact.validatedLocalizationCapture = capture.status === "captured"
            ? { status: "captured", provenanceComplete: capture.evidence.provenanceComplete,
              missingProvenance: capture.evidence.missingProvenance } : capture;
          await durableObserve(capture.status === "captured"
            ? "v4OpenLocalizationCaptured" : "v4OpenLocalizationNotCaptured");
        });
        const corePassed = primaryResponse.ok && primaryResult.ok === true && primaryAccounting.dispatch === "known"
          && primaryResult.expectedContractVersion === PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
          && primaryResult.contractValidation?.providerWireSchemaValid === true
          && primaryResult.contractValidation.primaryCoreValid === true
          && primaryResult.contractValidation.localizationValid === true
          && primaryResult.validation?.richPhotoAnalysis === "passed";
        const gate = calibrationLocalizationGate({ primaryPassed: corePassed,
          quality: primaryResult.analysis?.quality,
          faceVisible: (primaryResult.analysis?.visibleRegions as { face?: unknown } | undefined)?.face,
          portraitImageIndex: primaryResult.analysis?.sourceSelection?.portraitImageIndex,
          expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
          sourceVerified: true, imageCount: 1, trace: primaryResult.localizationTrace,
          portraitRegion: primaryResult.analysis?.sourceSelection?.portraitRegion });
        const evidence = artifact.validatedLocalizationEvidence;
        artifact.primary = { caseId: "open-eye-calibration-001", runId: primaryRunId,
          httpStatus: primaryResponse.status, ok: primaryResult.ok === true,
          elapsedMs: primaryResult.elapsedMs ?? null,
          providerSequence: (primaryResult.providerSequence ?? []).map(item => ({
            provider: item.provider ?? null, outcome: item.outcome ?? null,
            httpStatus: item.httpStatus ?? null, providerStatus: item.providerStatus ?? null,
            elapsedMs: item.elapsedMs ?? null })),
          providerAccounting: primaryAccounting.dispatch,
          contractValidation: primaryResult.contractValidation ?? null,
          richPhotoAnalysisValidation: primaryResult.validation?.richPhotoAnalysis ?? "unobserved",
          localizationTrace: primaryResult.localizationTrace ?? null,
          providerLocalizationStatus: gate.providerLocalizationStatus,
          calibrationLocalizationEligible: gate.calibrationLocalizationEligible,
          portraitImageIndex: primaryResult.analysis?.sourceSelection?.portraitImageIndex ?? null,
          quality: primaryResult.analysis?.quality ?? null,
          faceVisible: (primaryResult.analysis?.visibleRegions as { face?: unknown } | undefined)?.face ?? null,
          primaryEyeOpennessDiagnostic: primaryResult.analysis?.faceMeasurementEyeOpenness ?? null,
          providerGlassesDiagnostic: primaryResult.analysis?.fallbackFeaturesGlasses ?? null,
          failureReason: primaryResult.failure?.reason ?? null };
        artifact.v4Open = { ...artifact.v4Open, status: "primary_observed",
          primaryHttpStatus: primaryResponse.status, primaryAccounting: primaryAccounting.dispatch,
          primaryProvider: selectedProvider?.provider ?? null, primaryModel: selectedProvider?.model ?? selectedProvider?.modelId ?? null,
          primaryPromptSha256: selectedHashes?.promptSha256 ?? null,
          primarySchemaJsonSha256: selectedHashes?.schemaJsonSha256 ?? null,
          primaryValidation: primaryResult.contractValidation ?? null,
          localizationStatus: gate.providerLocalizationStatus,
          calibrationLocalizationEligible: gate.calibrationLocalizationEligible };
        await durableObserve("v4OpenPrimaryObservationSaved");
        if (!corePassed || !gate.calibrationLocalizationEligible || !gate.normalizedRegion.ok
          || !evidence?.provenanceComplete || evidence.runId !== primaryRunId
          || evidence.derivativeSha256 !== EXTERNAL_OPEN_DERIVATIVE_HASH
          || evidence.region.confidence !== gate.normalizedRegion.region.confidence) {
          artifact.classification = !corePassed ? "V4_OPEN_PRIMARY_UNAVAILABLE" : "V4_OPEN_LOCALIZATION_UNAVAILABLE";
        } else {
          const cropContext = validatedSameRunCropContext(primaryResult.analysis?.identityCropContext);
          if (!cropContext) artifact.classification = "V4_OPEN_CROP_CONTEXT_UNAVAILABLE";
          else {
            artifact.validLocalization = { caseId: "open-eye-calibration-001", runId: primaryRunId,
              sourceSha256: EXTERNAL_OPEN_SOURCE_HASH, derivativeSha256: EXTERNAL_OPEN_DERIVATIVE_HASH,
              region: gate.normalizedRegion.region, portraitImageIndex: 0,
              expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
              provider: evidence.provider, model: evidence.model,
              promptSha256: evidence.promptSha256, schemaJsonSha256: evidence.schemaJsonSha256,
              contractValidation: evidence.contractValidation,
              cropContext };
            await durableObserve("v4OpenSameRunContextAndRegionSaved");
            const crop = await createIdentityCrops(imageDataUrl, gate.normalizedRegion.region, cropContext);
            artifact.calls.faceCropPreparations++;
            if (!crop || crop.diagnostics.cropMode !== "subject_aware"
              || crop.diagnostics.quality.usableForFaceGeometry !== true) {
              artifact.classification = "V4_OPEN_CROP_NOT_SUITABLE";
            } else {
              const faceBytes = Buffer.from(crop.faceDataUrl.slice(crop.faceDataUrl.indexOf(",") + 1), "base64");
              const cropSha256 = hash(faceBytes);
              const faceDecoded = await decodePng(new Uint8Array(faceBytes));
              expect([faceDecoded.width, faceDecoded.height]).toEqual([
                crop.diagnostics.faceCropDimensions.width, crop.diagnostics.faceCropDimensions.height]);
              fs.writeFileSync(path.join(root, "face-crop.png"), faceBytes, { flag: "wx" });
              artifact.v4Open = { ...artifact.v4Open, status: "crop_pending_visual_review",
                cropRunId: primaryRunId, cropSha256, cropDecodedRgbaSha256: hash(faceDecoded.rgba),
                cropBytes: faceBytes.length, cropDimensions: crop.diagnostics.faceCropDimensions,
                cropMode: crop.diagnostics.cropMode, cropPolicyIdentity: artifact.v4Open?.cropPolicyIdentity,
                finalFaceBox: crop.diagnostics.finalFaceBox,
                faceCropLateralGuard: crop.diagnostics.faceCropLateralGuard,
                cropQuality: crop.diagnostics.quality, clippingRisk: crop.diagnostics.clippingRisk };
              await durableObserve("v4OpenFaceCropReadyForVisualReview");
              const review = await awaitCropVisualReview(root, primaryRunId, cropSha256, 300_000);
              artifact.v4Open = { ...artifact.v4Open, visualReview: review,
                status: review ? "crop_visually_accepted" : "crop_visual_review_failed" };
              await durableObserve("v4OpenVisualReviewCompleted");
              if (!review) artifact.classification = "V4_OPEN_CROP_NOT_SUITABLE";
              else {
                const geometryRequest = faceIdentityGeometryRequest(crop.faceDataUrl);
                expect(geometryRequest).toMatchObject({ model: FACE_GEOMETRY_MODEL,
                  imageDataUrls: [crop.faceDataUrl], maxOutputTokens: 4096,
                  timeoutCapMs: FACE_GEOMETRY_TIMEOUT_MS, allowWorkersAiFallback: false });
                expect(hash(geometryRequest.prompt)).toBe(FACE_GEOMETRY_PROMPT_HASH);
                expect(hash(JSON.stringify(geometryRequest.responseSchema))).toBe(FACE_GEOMETRY_SCHEMA_HASH);
                const geometryRunId = randomBytes(16).toString("hex");
                artifact.v4Open = { ...artifact.v4Open, status: "geometry_intent_durable",
                  geometryRunId, geometryModel: FACE_GEOMETRY_MODEL,
                  geometryPromptSha256: FACE_GEOMETRY_PROMPT_HASH,
                  geometrySchemaJsonSha256: FACE_GEOMETRY_SCHEMA_HASH, geometryTimeoutMs: FACE_GEOMETRY_TIMEOUT_MS,
                  geometryImageSha256: cropSha256, geometryImageCount: 1, geometryImageMime: "image/png" };
                await durableObserve("v4OpenGeometryRequestIntent");
                artifact.calls.geometryPosts++; artifact.calls.jpegOrPngTransmissions++;
                await durableObserve("v4OpenGeometryPostStarted");
                const geometryResponse = await fetch(`${url}/face-geometry-direct-audit`, {
                  method: "POST", headers: { "content-type": "application/json",
                    "x-primary-audit-token": token, "x-primary-audit-run-id": geometryRunId },
                  body: JSON.stringify({ imageDataUrl: crop.faceDataUrl }), signal: AbortSignal.timeout(60_000),
                });
                artifact.geometryHttpStatus = geometryResponse.status;
                await durableObserve("v4OpenGeometryHeadersReceived");
                const geometryResult = await geometryResponse.json() as GeometryRemoteResult & { inputMode?: string };
                await durableObserve("v4OpenGeometryBodyParsed");
                const geometryAccounting = accountingOf(geometryResult.auditState, geometryRunId);
                artifact.providerAccounting = geometryAccounting.dispatch;
                if (geometryAccounting.dispatch === "known") {
                  artifact.geometryProviderCalls = geometryAccounting.providerCalls;
                  for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
                    artifact.providerCalls[key] += geometryAccounting.providerCalls[key];
                  }
                }
                const shapeValid = geometryResult.providerShapeValid === true;
                const semanticValid = geometryResult.ok === true && geometryResult.errors?.length === 0;
                const safeErrors = (geometryResult.errors ?? []).filter(error => error.length <= 128
                  && /^(?:faceGeometry|geometry)(?:\.[A-Za-z0-9_.]+)?:[A-Za-z0-9_]+$/.test(error)).slice(0, 32);
                let accepted: FaceIdentityGeometryAnalysis | null = null;
                if (geometryResponse.ok && geometryResult.inputMode === "direct_frozen_face_crop"
                  && geometryResult.crop === null && shapeValid && semanticValid && geometryResult.geometry
                  && geometryAccounting.dispatch === "known" && geometryAccounting.providerCalls.geminiStarted === 0
                  && geometryAccounting.providerCalls.gemmaStarted === 1 && geometryAccounting.providerCalls.retry === 0) {
                  try { accepted = acceptedFaceGeometry(geometryResult.geometry); }
                  catch { /* rejected geometry is never saved or compared */ }
                }
                const normal = artifact.v4Open?.normalReference as { openness: number; eyesConfidence: number };
                const openScore = accepted?.eyes.openness ?? null;
                artifact.v4Open = { ...artifact.v4Open,
                  status: accepted ? "accepted_geometry_saved" : "geometry_not_accepted",
                  geometryAuditHttpStatus: geometryResponse.status,
                  geometryProviderHttpStatus: geometryResult.httpStatus ?? null,
                  geometryProviderStatus: geometryResult.providerStatus ?? null,
                  geometryElapsedMs: geometryResult.elapsedMs ?? null,
                  geometryProviderAccounting: geometryAccounting.dispatch,
                  providerShapeValid: shapeValid, semanticValid, safeErrorPaths: safeErrors,
                  acceptedGeometry: accepted, openOpenness: openScore,
                  eyesConfidence: accepted?.confidence.eyes ?? null,
                  highBoundaryRelation: openScore === null ? "not_evaluable"
                    : openScore > normal.openness ? "open_above_normal"
                      : openScore === normal.openness ? "non_separable" : "inverted",
                  feasibleThresholdInterval: openScore !== null && openScore > normal.openness
                    ? `(${normal.openness.toFixed(2)}, ${openScore.toFixed(2)}]` : null,
                  limitations: "different source, primary localization, and production face crop; one observation per class",
                  finalThresholdSelected: false };
                artifact.classification = accepted ? "v4_open_geometry_observed_cleanup_pending"
                  : geometryResponse.ok ? "V4_OPEN_GEOMETRY_INVALID" : "V4_OPEN_GEOMETRY_PROVIDER_FAILED";
                await durableObserve(accepted ? "v4OpenAcceptedGeometryPersisted" : "v4OpenGeometryFailurePersisted");
              }
            }
          }
        }
      }
      if (RUN_SAVED_V4_FACE_GEOMETRY && artifact.health.status === "passed") {
        artifact.providerCalls = { geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
          gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0 };
        const saved = await verifySavedV4FaceCropMetadata();
        const bytes = await verifySavedV4FaceCropBytes();
        artifact.calls.sourceReads++;
        artifact.calls.fileHashChecks++;
        artifact.calls.rgbaHashChecks++;
        await durableObserve("savedV4FaceCropVerifiedAfterHealth");
        const imageDataUrl = `data:image/png;base64,${bytesToBase64(bytes)}`;
        artifact.calls.base64Preparations++;
        const request = faceIdentityGeometryRequest(imageDataUrl);
        expect(request).toMatchObject({ model: FACE_GEOMETRY_MODEL, imageDataUrls: [imageDataUrl],
          maxOutputTokens: 4096, timeoutCapMs: FACE_GEOMETRY_TIMEOUT_MS, allowWorkersAiFallback: false });
        expect(hash(request.prompt)).toBe(FACE_GEOMETRY_PROMPT_HASH);
        expect(hash(JSON.stringify(request.responseSchema))).toBe(FACE_GEOMETRY_SCHEMA_HASH);
        expect(saved.evidence.caseId).toBe("wavy-open-blazer");
        const runId = randomBytes(16).toString("hex");
        artifact.savedV4FaceGeometry = { ...artifact.savedV4FaceGeometry,
          status: "request_intent_durable", geometryRunId: runId, providerRetry: 0,
          primaryPosts: 0, expectedImageCount: 1, expectedMime: "image/png" };
        await durableObserve("savedV4GeometryRequestIntent");
        artifact.calls.geometryPosts++;
        artifact.calls.jpegOrPngTransmissions++;
        await durableObserve("savedV4GeometryPostStarted");
        const response = await fetch(`${url}/face-geometry-direct-audit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
          body: JSON.stringify({ imageDataUrl }), signal: AbortSignal.timeout(60_000),
        });
        artifact.geometryHttpStatus = response.status;
        await durableObserve("savedV4GeometryHeadersReceived");
        const result = await response.json() as GeometryRemoteResult & { inputMode?: string };
        await durableObserve("savedV4GeometryBodyParsed");
        const accounting = accountingOf(result.auditState, runId);
        artifact.providerAccounting = accounting.dispatch;
        if (accounting.dispatch === "known") {
          artifact.geometryProviderCalls = accounting.providerCalls;
          artifact.providerCalls = accounting.providerCalls;
        }
        const safeErrors = (result.errors ?? []).filter(error => error.length <= 128
          && /^(?:faceGeometry|geometry)(?:\.[A-Za-z0-9_.]+)?:[A-Za-z0-9_]+$/.test(error)).slice(0, 32);
        const shapeValid = result.providerShapeValid === true;
        const semanticValid = result.ok === true && result.errors?.length === 0;
        let accepted: FaceIdentityGeometryAnalysis | null = null;
        const acceptedCandidate = response.ok && result.inputMode === "direct_frozen_face_crop" && result.crop === null
          && shapeValid && semanticValid && result.geometry && accounting.dispatch === "known"
          && accounting.providerCalls.geminiStarted === 0 && accounting.providerCalls.gemmaStarted === 1
          && accounting.providerCalls.retry === 0;
        if (acceptedCandidate && result.geometry) {
          try { accepted = acceptedFaceGeometry(result.geometry); }
          catch { /* The local revalidation gate rejects; no coordinates are persisted. */ }
        }
        artifact.savedV4FaceGeometry = { ...artifact.savedV4FaceGeometry,
          status: accepted ? "accepted_geometry_saved" : "geometry_not_accepted",
          auditHttpStatus: response.status, nativeBindingOutcome: accounting.dispatch === "known"
            ? accounting.providerCalls.gemmaCompleted === 1 ? "binding_returned"
              : accounting.providerCalls.gemmaFailed === 1 ? "binding_failed" : "not_observed" : "unknown",
          providerHttpStatus: result.httpStatus ?? null, providerStatus: result.providerStatus ?? null,
          elapsedMs: result.elapsedMs ?? null, providerShapeValid: shapeValid,
          semanticValid, safeErrorPaths: safeErrors,
          providerAccounting: accounting.dispatch,
          acceptedGeometry: accepted, normalOpenness: accepted?.eyes.openness ?? null,
          eyesConfidence: accepted?.confidence.eyes ?? null,
          cropSha256: SAVED_V4_CROP_SHA, primaryPosts: 0, providerRetry: 0 };
        await durableObserve(accepted ? "savedV4AcceptedGeometryPersisted" : "savedV4GeometryFailurePersisted");
        artifact.classification = accepted ? "saved_v4_geometry_observed_cleanup_pending"
          : response.ok ? "V4_NORMAL_GEOMETRY_INVALID" : "V4_NORMAL_GEOMETRY_PROVIDER_FAILED";
      }
      if (RUN_OPEN_DIRECTIONAL && artifact.health.status === "passed") {
        artifact.providerCalls = {
          geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
          gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0,
        };
        const selectedCase = selectedCases[0];
        observe(`openDirectionalSelected:${selectedCase.id}`);
        const source = fs.readFileSync(OPEN_SOURCE);
        artifact.calls.sourceReads++;
        artifact.calls.hashChecks++;
        artifact.calls.fileHashChecks++;
        expect(source.byteLength).toBe(197_802);
        expect(hash(source)).toBe(OPEN_SOURCE_FILE_HASH);
        expect(Array.from(source.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const decoded = await decodePng(new Uint8Array(source));
        artifact.calls.rgbaHashChecks++;
        expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 270, height: 308 });
        expect(hash(decoded.rgba)).toBe(OPEN_SOURCE_RGBA_HASH);
        observe(`openDirectionalSourceVerified:${selectedCase.id}`);
        const imageDataUrl = `data:image/png;base64,${bytesToBase64(source)}`;
        artifact.calls.base64Preparations++;
        const runId = randomBytes(16).toString("hex");
        artifact.calls.jpegOrPngTransmissions++;
        artifact.calls.geometryPosts++;
        await durableObserve(`openDirectionalGeometryPostStarted:${selectedCase.id}`);
        const response = await fetch(`${url}/face-geometry-direct-audit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
          body: JSON.stringify({ imageDataUrl }),
          signal: AbortSignal.timeout(60_000),
        });
        artifact.geometryHttpStatus = response.status;
        await durableObserve(`openDirectionalGeometryHeadersReceived:${selectedCase.id}`);
        const result = await response.json() as GeometryRemoteResult & { inputMode?: string };
        await durableObserve(`openDirectionalGeometryBodyParsed:${selectedCase.id}`);
        const accounting = accountingOf(result.auditState, runId);
        artifact.providerAccounting = accounting.dispatch;
        if (accounting.dispatch === "known") {
          artifact.geometryProviderCalls = accounting.providerCalls;
          for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
            artifact.providerCalls[key] += accounting.providerCalls[key];
          }
        }
        const geometryValid = response.ok && result.ok === true && result.inputMode === "direct_frozen_face_crop"
          && result.crop === null && result.providerShapeValid === true && (result.errors?.length ?? 0) === 0
          && Boolean(result.geometry) && accounting.dispatch === "known";
        const eyesConfidence = result.geometry?.confidence.eyes ?? null;
        const confidenceUsable = (eyesConfidence ?? 0) >= 0.55;
        const openScore = result.geometry?.eyes.openness ?? null;
        const directionalClassification = openScore === null ? null
          : openScore > 0.6 ? "OPEN_DIRECTION_CONFIRMED"
            : openScore === 0.6 ? "OPEN_DIRECTION_NON_SEPARABLE" : "OPEN_DIRECTION_INVERTED";
        const anchorTier = geometryValid && confidenceUsable ? "TIER_B_OPEN_DIRECTIONAL" : "INELIGIBLE_OPEN_DIRECTIONAL";
        artifact.geometryResults.push({
          caseId: selectedCase.id,
          sourceClass: "frozen_reviewed_derived_artifact",
          sourceSha256: OPEN_SOURCE_FILE_HASH,
          sourceDecodedRgbaSha256: OPEN_SOURCE_RGBA_HASH,
          sourceBytes: source.byteLength,
          sourceDimensions: { width: decoded.width, height: decoded.height },
          frozenSourceEyeOpenness: "open",
          inputMode: result.inputMode ?? null,
          directInputUnchanged: true,
          crop: result.crop ?? null,
          httpStatus: response.status,
          ok: result.ok === true,
          elapsedMs: result.elapsedMs ?? null,
          providerShapeValid: result.providerShapeValid ?? false,
          semanticValidationPassed: result.ok === true && (result.errors?.length ?? 0) === 0,
          errors: result.errors ?? [],
          measurements: result.measurements ?? null,
          geometry: result.geometry ?? null,
          providerHttpStatus: result.httpStatus ?? null,
          providerStatus: result.providerStatus ?? null,
          providerAccounting: accounting.dispatch,
          providerCalls: accounting.dispatch === "known" ? accounting.providerCalls : null,
          inputEligibility: "DIRECT_GEOMETRY_TIER_B_ONLY",
          inputConfounder: "viewer-right facial envelope touches source edge; historical framing is not current-crop equivalent; both eyes and eyelids remain readable",
          anchorTier,
        });
        artifact.openDirectional = {
          caseId: selectedCase.id,
          sourceClass: "frozen_reviewed_derived_artifact",
          frozenSourceEyeOpenness: "open",
          anchorTier,
          postContractOpenness: openScore,
          eyesConfidence,
          normalReference: 0.6,
          directionalClassification,
          threeClassDirectionalState: openScore !== null && 0.5 < 0.6 && 0.6 < openScore
            ? "THREE_CLASS_DIRECTION_CONFIRMED" : "THREE_CLASS_DIRECTION_NOT_CONFIRMED",
          currentOpenMinDiagnostic: openScore === null ? "NOT_EVALUABLE"
            : openScore >= 0.68 ? "AT_OR_ABOVE_CURRENT_OPEN_MIN" : "BELOW_CURRENT_OPEN_MIN",
          highBoundaryCalibrationClaimed: false,
        };
        artifact.classification = geometryValid && confidenceUsable && directionalClassification
          ? "open_directional_completed_cleanup_pending"
          : response.ok ? "BLOCKED: direct open geometry validation or confidence failed"
            : "BLOCKED: direct open geometry provider/runtime failure";
        await durableObserve(`openDirectionalGeometryCompleted:${selectedCase.id}`);
      }
      if (RUN_FACE_GEOMETRY_TARGETS && artifact.health.status === "passed") {
        observe("geometryTargetsSelected");
        artifact.providerCalls = {
          geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
          gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0,
        };
        const targeted = JSON.parse(fs.readFileSync(TARGETED_PRIMARY, "utf8")) as {
          primaryResults?: Array<{
            caseId?: string;
            sourceSha256?: string;
            sourceBytes?: number;
            sourceSelection?: { portraitImageIndex?: number; portraitRegion?: PortraitRegion | null };
            faceMeasurementEvidence?: unknown;
            relevantRenderHints?: unknown;
            fallbackFeaturesGlasses?: unknown;
          }>;
        };
        for (const selectedCase of selectedCases) {
          observe(`geometryCaseSelected:${selectedCase.id}`);
          const stored = targeted.primaryResults?.find(item => item.caseId === selectedCase.id);
          const portraitRegion = stored?.sourceSelection?.portraitRegion;
          if (!stored || stored.sourceSha256 !== selectedCase.sourceSha256 || stored.sourceBytes !== selectedCase.sourceBytes
            || stored.sourceSelection?.portraitImageIndex !== 0 || !portraitRegion?.faceBox) {
            artifact.classification = `BLOCKED: missing production-equivalent stored face localization for ${selectedCase.id}`;
            break;
          }
          const frozen = JSON.parse(fs.readFileSync(path.resolve(GENERALIZATION,
            `after/${selectedCase.id}/analysis-and-plan.json`), "utf8")) as { analysis?: PhotoAnalysis };
          if (!frozen.analysis) {
            artifact.classification = `BLOCKED: missing frozen replay analysis for ${selectedCase.id}`;
            break;
          }
          const hints = frozen.analysis.renderHints;
          const cropContext: AdaptiveHeadCropContext = {
            hairVolume: hints.hairVolume,
            hairTexture: hints.hairTexture,
            overallHairLength: hints.overallHairLength,
            sideHairAsymmetry: hints.sideHairAsymmetry,
            headCovering: frozen.analysis.fallbackFeatures.hat === "headscarf",
          };
          const source = fs.readFileSync(path.resolve(GENERALIZATION, `sources/${selectedCase.photoId}.jpg`));
          artifact.calls.jpegReads++;
          artifact.calls.hashChecks++;
          expect(source.byteLength).toBe(selectedCase.sourceBytes);
          expect(hash(source)).toBe(selectedCase.sourceSha256);
          expect(Array.from(source.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
          observe(`geometrySourceHashVerified:${selectedCase.id}`);
          const imageDataUrl = `data:image/jpeg;base64,${bytesToBase64(source)}`;
          artifact.calls.base64Preparations++;
          const localCrop = await createIdentityCrops(imageDataUrl, portraitRegion, cropContext);
          expect(localCrop?.diagnostics.quality.usableForFaceGeometry).toBe(true);
          if (!localCrop) {
            artifact.classification = `BLOCKED: production face crop unavailable for ${selectedCase.id}`;
            break;
          }
          artifact.calls.faceCropPreparations++;
          const cropBytes = Buffer.from(localCrop.faceDataUrl.slice(localCrop.faceDataUrl.indexOf(",") + 1), "base64");
          expect(hash(cropBytes)).toBe(FACE_GEOMETRY_CROP_HASHES[selectedCase.id]);
          observe(`geometryCropPrepared:${selectedCase.id}`);
          const runId = randomBytes(16).toString("hex");
          artifact.calls.jpegTransmissions++;
          artifact.calls.geometryPosts++;
          await durableObserve(`geometryPostStarted:${selectedCase.id}`);
          const response = await fetch(`${url}/face-geometry-audit`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
            body: JSON.stringify({ imageDataUrl, portraitRegion, cropContext }),
            signal: AbortSignal.timeout(60_000),
          });
          artifact.geometryHttpStatus = response.status;
          await durableObserve(`geometryHeadersReceived:${selectedCase.id}`);
          const result = await response.json() as GeometryRemoteResult;
          await durableObserve(`geometryBodyParsed:${selectedCase.id}`);
          const accounting = accountingOf(result.auditState, runId);
          artifact.providerAccounting = accounting.dispatch;
          if (accounting.dispatch === "known") {
            for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
              artifact.providerCalls[key] += accounting.providerCalls[key];
            }
          }
          expect(result.crop).toEqual(localCrop.diagnostics);
          artifact.geometryResults.push({
            caseId: selectedCase.id,
            sourceSha256: selectedCase.sourceSha256,
            sourceBytes: selectedCase.sourceBytes,
            sourceImageIndex: stored.sourceSelection.portraitImageIndex,
            storedPortraitRegion: portraitRegion,
            primaryFaceMeasurementEvidence: stored.faceMeasurementEvidence ?? null,
            primaryRelevantRenderHints: stored.relevantRenderHints ?? null,
            primaryFallbackFeaturesGlasses: stored.fallbackFeaturesGlasses ?? null,
            cropContext,
            crop: localCrop.diagnostics,
            faceCropSha256: hash(cropBytes),
            faceCropEncodedBytes: cropBytes.byteLength,
            httpStatus: response.status,
            ok: result.ok === true,
            elapsedMs: result.elapsedMs ?? null,
            primaryElapsedMs: result.primaryElapsedMs ?? null,
            geminiElapsedMs: result.geminiElapsedMs ?? null,
            gemmaElapsedMs: result.gemmaElapsedMs ?? null,
            providerShapeValid: result.providerShapeValid ?? false,
            semanticValidationPassed: result.ok === true && (result.errors?.length ?? 0) === 0,
            errors: result.errors ?? [],
            measurements: result.measurements ?? null,
            geometry: result.geometry ?? null,
            providerHttpStatus: result.httpStatus ?? null,
            providerStatus: result.providerStatus ?? null,
            providerAccounting: accounting.dispatch,
            providerCalls: accounting.dispatch === "known" ? accounting.providerCalls : null,
          });
          await durableObserve(`geometryCompleted:${selectedCase.id}`);
          if (!response.ok || accounting.dispatch !== "known") {
            artifact.classification = !response.ok
              ? "BLOCKED: geometry POST did not return HTTP success"
              : "BLOCKED: provider accounting became unknown";
            break;
          }
        }
        if (artifact.geometryResults.length === selectedCases.length && artifact.providerAccounting === "known") {
          artifact.classification = "geometry_audit_completed_cleanup_pending";
        }
      }
      if (RUN_PRIMARY && artifact.health.status === "passed") {
        observe(RUN_TARGETED_PRIMARY ? "targetedCasesSelected" : RUN_SIX_CASE_PRIMARY ? "batchSelected" : "canarySelected");
        artifact.providerCalls = {
          geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
          gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0,
        };
        const cueNames = ["eyeSpacing", "eyeOpenness", "eyeFootprint", "browEyeDistance",
          "browSlope", "mouthWidth", "mouthOpenness", "expression"];
        for (const selectedCase of selectedCases) {
          observe(`caseSelected:${selectedCase.id}`);
          const source = fs.readFileSync(RUN_EXTERNAL_OPEN_ANCHOR ? EXTERNAL_OPEN_SOURCE
            : RUN_OPEN_ANCHOR ? OPEN_SOURCE
              : path.resolve(GENERALIZATION, `sources/${selectedCase.photoId}.jpg`));
          artifact.calls.sourceReads++;
          if (!RUN_OPEN_ANCHOR) artifact.calls.jpegReads++;
          artifact.calls.hashChecks++; artifact.calls.fileHashChecks++;
          expect(source.byteLength).toBe(selectedCase.sourceBytes);
          expect(hash(source)).toBe(selectedCase.sourceSha256);
          if (RUN_EXTERNAL_OPEN_ANCHOR) {
            expect(Array.from(source.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
            const original = decodeJpeg(source, { useTArray: true, maxMemoryUsageInMB: 127 });
            artifact.calls.rgbaHashChecks++;
            expect([original.width, original.height, hash(Buffer.from(original.data))]).toEqual([
              2002, 3000, "235b852bbcc9acf02d84e484705d7174a1bbb33748bf5f12ce1aa47f9a7a9c89",
            ]);
          } else if (RUN_OPEN_ANCHOR) {
            expect(Array.from(source.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            const decoded = await decodePng(new Uint8Array(source));
            artifact.calls.rgbaHashChecks++;
            expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 270, height: 308 });
            expect(hash(decoded.rgba)).toBe(OPEN_SOURCE_RGBA_HASH);
          } else {
            expect(Array.from(source.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
            if (RUN_WAVY_PRIMARY_INPUT) {
              const decodedSource = await decodeImage(source);
              expect([decodedSource.width, decodedSource.height]).toEqual([900, 1350]);
            }
          }
          observe(`sourceHashVerified:${selectedCase.id}`);
          let providerInput = source;
          let productionInputDerivative: Record<string, unknown> | null = null;
          if (RUN_EXTERNAL_OPEN_ANCHOR) {
            const manifest = JSON.parse(fs.readFileSync(path.join(EXTERNAL_OPEN_PARITY, "analysis-derivative.json"), "utf8")) as {
              productionInputDerivative: { sourceSha256: string; sha256: string; bytes: number;
                dataUrlChars: number; width: number; height: number; mime: string; role: string };
            };
            providerInput = fs.readFileSync(path.join(EXTERNAL_OPEN_PARITY, "analysis-derivative.jpg"));
            artifact.calls.jpegReads++;
            artifact.calls.hashChecks++;
            const derivative = manifest.productionInputDerivative;
            expect(derivative).toMatchObject({ role: "analysis", mime: "image/jpeg",
              sourceSha256: EXTERNAL_OPEN_SOURCE_HASH, sha256: EXTERNAL_OPEN_DERIVATIVE_HASH,
              bytes: 96_780, dataUrlChars: 129_063, width: 598, height: 896 });
            expect(providerInput.byteLength).toBe(derivative.bytes);
            expect(hash(providerInput)).toBe(derivative.sha256);
            const decoded = await decodeImage(providerInput);
            expect([decoded.width, decoded.height]).toEqual([598, 896]);
            artifact.calls.rgbaHashChecks++;
            expect(hash(Buffer.from(decoded.rgba))).toBe(EXTERNAL_OPEN_DERIVATIVE_RGBA_HASH);
            productionInputDerivative = derivative;
          }
          if (RUN_WAVY_PRIMARY_INPUT) {
            const manifest = JSON.parse(fs.readFileSync(path.join(WAVY_PARITY, "production-derivatives.json"), "utf8")) as Array<{
              caseId: string; sourceSha256: string; derivativeSha256: string; derivativeBytes: number;
              derivativeDimensions: number[]; derivativeDecodedRgbaSha256: string; dataUrlChars: number;
              selectedQuality: number; newDerivativeRawOpenness: string;
            }>;
            const frozen = manifest.find(item => item.caseId === "wavy");
            expect(frozen).toBeDefined();
            providerInput = fs.readFileSync(path.join(WAVY_PARITY, "wavy/analysis-derivative.jpg"));
            artifact.calls.derivativeReads++;
            artifact.calls.jpegReads++;
            artifact.calls.hashChecks++; artifact.calls.derivativeHashChecks++;
            expect(providerInput.byteLength).toBe(frozen!.derivativeBytes);
            expect(hash(providerInput)).toBe(WAVY_DERIVATIVE_HASH);
            const decoded = await decodeImage(providerInput);
            expect([decoded.width, decoded.height]).toEqual([597, 896]);
            artifact.calls.rgbaHashChecks++; artifact.calls.derivativeRgbaHashChecks++;
            expect(hash(Buffer.from(decoded.rgba))).toBe(WAVY_DERIVATIVE_RGBA_HASH);
            productionInputDerivative = { role: "analysis", mime: "image/jpeg", sourceSha256: frozen!.sourceSha256,
              sha256: frozen!.derivativeSha256, decodedRgbaSha256: frozen!.derivativeDecodedRgbaSha256,
              bytes: frozen!.derivativeBytes, width: 597, height: 896,
              dataUrlChars: frozen!.dataUrlChars, selectedQuality: frozen!.selectedQuality };
          }
          const imageDataUrl = `data:${RUN_OPEN_ANCHOR ? "image/png" : "image/jpeg"};base64,${bytesToBase64(providerInput)}`;
          if (RUN_EXTERNAL_OPEN_ANCHOR) {
            expect(imageDataUrl.length).toBe(129_063);
            expect(imageDataUrl.length).toBeLessThanOrEqual(MAX_IMAGE_CHARS);
          }
          if (RUN_WAVY_PRIMARY_INPUT) {
            expect(imageDataUrl.length).toBe(61_051);
            expect(imageDataUrl.length).toBeLessThanOrEqual(MAX_IMAGE_CHARS);
            expect(hash(Buffer.from(imageDataUrl.slice("data:image/jpeg;base64,".length), "base64"))).toBe(WAVY_DERIVATIVE_HASH);
          }
          artifact.calls.base64Preparations++;
          observe(`payloadPreparedInMemory:${selectedCase.id}`);
          const runId = randomBytes(16).toString("hex");
          artifact.calls.jpegTransmissions++;
          artifact.calls.jpegOrPngTransmissions++;
          artifact.calls.primaryPosts++;
          // This durable intent is written before the single POST. Recovery may
          // then say "dispatch unknown", but must never replay the request.
          await durableObserve(`primaryPostStarted:${selectedCase.id}`);
          const response = await fetch(`${url}${RUN_V4_WAVY_PRIMARY
            ? "/primary-audit-v4-structured-localization" : "/primary-audit"}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
            body: JSON.stringify({ imageDataUrl }),
            signal: AbortSignal.timeout(120_000),
          });
          artifact.primaryHttpStatus = response.status;
          await durableObserve(`primaryHeadersReceived:${selectedCase.id}`);
          const result = await response.json() as RemoteResult;
          await durableObserve(`primaryBodyParsed:${selectedCase.id}`);
          const accounting = accountingOf(result.auditState, runId);
          artifact.providerAccounting = accounting.dispatch;
          if ((RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_WAVY_PRIMARY_TRACE) && accounting.dispatch === "known") {
            artifact.primaryProviderCalls = accounting.providerCalls;
          }
          if (accounting.dispatch === "known") {
            for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
              artifact.providerCalls[key] += accounting.providerCalls[key];
            }
          }
          const evidence = result.analysis?.faceMeasurementEvidence;
          const cues = evidence?.cues;
          const rubricComparison = cueNames.map(cue => {
            const expected = selectedCase.rubric[cue];
            const provider = cues?.[cue];
            const coverage = expected.kind === "unscorable" ? "unscorable"
              : !provider ? "absent" : provider.value === "unknown" ? "unknown" : "covered";
            const agreement = coverage !== "covered" || !provider ? "n/a"
              : expected.values?.includes(provider.value)
                ? expected.kind === "ambiguous" ? "ambiguous-compatible" : "exact"
                : "wrong";
            return { caseId: selectedCase.id, cue, sourceExpected: expected.values ?? null,
              sourceScorable: expected.kind !== "unscorable", providerValue: provider?.value ?? null,
              providerProvenance: provider?.provenance ?? null, providerConfidence: provider?.confidence ?? null,
              coverage, agreement };
          });
          const primaryPassed = response.ok && result.ok === true && accounting.dispatch === "known"
            && result.validation?.compactProviderSchema === "passed"
            && result.validation?.compactStrictRuntime === "passed"
            && result.validation?.richPhotoAnalysis === "passed";
          const v4CorePassed = RUN_V4_WAVY_PRIMARY && response.ok && result.ok === true
            && accounting.dispatch === "known" && result.expectedContractVersion === PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
            && result.contractValidation?.primaryCoreValid === true
            && result.validation?.richPhotoAnalysis === "passed";
          const v4Completed = RUN_V4_WAVY_PRIMARY
            ? (result.providerSequence ?? []).filter(item => item.outcome === "completed") : [];
          const v4OutputProvider = v4Completed.length === 1 ? v4Completed[0] : null;
          const v4SelectedHashes = v4OutputProvider?.provider === "gemini"
            ? { promptSha256: V4_GEMINI_PROMPT_HASH, schemaJsonSha256: V4_GEMINI_SCHEMA_HASH }
            : v4OutputProvider?.provider === "workers_ai"
              ? { promptSha256: V4_GEMMA_PROMPT_HASH, schemaJsonSha256: V4_GEMMA_SCHEMA_HASH } : null;
          if (RUN_V4_WAVY_PRIMARY) {
            await checkpointValidatedLocalizationCapture({
              primaryOk: response.ok && result.ok === true && result.validation?.richPhotoAnalysis === "passed",
              expectedContractVersion: result.expectedContractVersion,
              contractValidation: result.contractValidation,
              protectedLocalization: result.validatedLocalization,
              localizationTrace: result.localizationTrace,
              imageCount: 1, runId, caseId: selectedCase.id,
              sourceSha256: selectedCase.sourceSha256, derivativeSha256: WAVY_DERIVATIVE_HASH,
              inputDimensions: { width: productionInputDerivative?.width, height: productionInputDerivative?.height },
              provider: v4OutputProvider?.provider, model: v4OutputProvider?.model ?? v4OutputProvider?.modelId,
              promptSha256: v4SelectedHashes?.promptSha256, schemaJsonSha256: v4SelectedHashes?.schemaJsonSha256,
            }, async capture => {
              artifact.validatedLocalizationEvidence = capture.status === "captured" ? capture.evidence : null;
              artifact.validatedLocalizationCapture = capture.status === "captured"
                ? { status: "captured", provenanceComplete: capture.evidence.provenanceComplete,
                  missingProvenance: capture.evidence.missingProvenance }
                : capture;
              // This authoritative write completes before the calibration gate can reject or throw.
              await durableObserve(capture.status === "captured"
                ? `validatedLocalizationObserved:${selectedCase.id}`
                : `validatedLocalizationNotCaptured:${selectedCase.id}`);
            });
          }
          const localizationGate = calibrationLocalizationGate({
            primaryPassed: RUN_V4_WAVY_PRIMARY ? v4CorePassed : primaryPassed,
            quality: result.analysis?.quality,
            faceVisible: (result.analysis?.visibleRegions as { face?: unknown } | undefined)?.face,
            portraitImageIndex: result.analysis?.sourceSelection?.portraitImageIndex,
            ...(RUN_V4_WAVY_PRIMARY ? { expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
              sourceVerified: true, imageCount: 1 } : {}),
            trace: result.localizationTrace,
            portraitRegion: result.analysis?.sourceSelection?.portraitRegion,
          });
          const primary = {
            caseId: selectedCase.id,
            sourceSha256: selectedCase.sourceSha256,
            sourceBytes: selectedCase.sourceBytes,
            productionInputDerivative,
            sourceGlassesOrCovering: selectedCase.glassesOrCovering,
            httpStatus: response.status,
            ok: result.ok === true,
            elapsedMs: result.elapsedMs ?? null,
            primaryElapsedMs: result.primaryElapsedMs ?? null,
            geminiElapsedMs: result.geminiElapsedMs ?? null,
            gemmaElapsedMs: result.gemmaElapsedMs ?? null,
            attempts: result.attempts ?? null,
            providerSequence: result.providerSequence ?? [],
            validation: result.validation ?? null,
            providerAccounting: accounting.dispatch,
            providerCalls: accounting.dispatch === "known" ? accounting.providerCalls : null,
            failure: result.failure ? { reason: result.failure.reason ?? null, detail: result.failure.detail ?? null } : null,
            quality: result.analysis?.quality ?? null,
            visibleRegions: result.analysis?.visibleRegions ?? null,
            sourceSelection: result.analysis?.sourceSelection ?? null,
            localizationTrace: result.localizationTrace ?? null,
            providerLocalizationStatus: localizationGate.providerLocalizationStatus,
            calibrationLocalizationEligible: localizationGate.calibrationLocalizationEligible,
            faceMeasurementEvidence: evidence ?? null,
            relevantRenderHints: result.analysis?.relevantRenderHints ?? null,
            canonicalFaceCues: result.analysis?.canonicalFaceCues ?? null,
            fallbackFeaturesGlasses: result.analysis?.fallbackFeaturesGlasses ?? null,
            observedAccessories: result.analysis?.observedAccessories ?? null,
            canonicalAccessoryCues: result.analysis?.canonicalAccessoryCues ?? null,
            measurementTraceSelected: result.analysis?.consumerTrace?.measurementTrace
              ? Object.fromEntries(Object.entries(result.analysis.consumerTrace.measurementTrace)
                .map(([cue, decision]) => [cue, decision.selected ?? null])) : null,
            categoricalOnlyFaceLayoutPlan: result.analysis?.consumerTrace?.faceLayoutPlan ?? null,
            rubricComparison,
          };
          if (RUN_V4_WAVY_PRIMARY) {
            const trace = result.localizationTrace?.traceVersion === 2 ? result.localizationTrace : null;
            const outputProvider = v4OutputProvider;
            const selectedHashes = v4SelectedHashes;
            const providerObservations = (result.providerSequence ?? []).map(item => ({
              provider: item.provider, model: item.model ?? item.modelId ?? null,
              attempted: item.outcome === "started", outcome: item.outcome,
              expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
              promptSha256: item.provider === "gemini" ? V4_GEMINI_PROMPT_HASH : V4_GEMMA_PROMPT_HASH,
              schemaJsonSha256: item.provider === "gemini" ? V4_GEMINI_SCHEMA_HASH : V4_GEMMA_SCHEMA_HASH,
              httpStatus: item.httpStatus ?? null, providerStatus: item.providerStatus ?? null,
              origin: item.origin ?? null, deadlineTimerFired: item.deadlineTimerFired ?? null,
              elapsedMs: item.elapsedMs ?? null, configuredDeadlineMs: item.configuredDeadlineMs ?? null,
            }));
            artifact.primary = {
              caseId: selectedCase.id, runId, sourceSha256: selectedCase.sourceSha256,
              derivativeSha256: WAVY_DERIVATIVE_HASH, expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
              httpStatus: response.status, ok: result.ok === true, elapsedMs: result.elapsedMs ?? null,
              primaryElapsedMs: result.primaryElapsedMs ?? null, providerObservations,
              providerAccounting: accounting.dispatch,
              providerCalls: accounting.dispatch === "known" ? accounting.providerCalls : null,
              contractValidation: result.contractValidation ?? null,
              richPhotoAnalysisValidation: result.validation?.richPhotoAnalysis ?? "unobserved",
              failureReason: result.failure?.reason ?? null,
              quality: result.analysis?.quality ?? null,
              faceVisible: (result.analysis?.visibleRegions as { face?: unknown } | undefined)?.face ?? null,
              portraitImageIndex: result.analysis?.sourceSelection?.portraitImageIndex ?? null,
              localizationTrace: trace,
              normalizedPortraitRegionPresent: v4CorePassed && localizationGate.normalizedRegion.ok,
              calibrationLocalizationEligible: localizationGate.calibrationLocalizationEligible,
            };
            if (v4CorePassed && result.contractValidation?.providerWireSchemaValid === true
              && result.contractValidation.localizationValid === true && trace?.status === "VALID"
              && trace.contractVersion === PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION
              && trace.carrier === "structured_region" && localizationGate.calibrationLocalizationEligible
              && localizationGate.normalizedRegion.ok && selectedHashes && outputProvider) {
              artifact.validLocalization = {
                caseId: selectedCase.id, runId, sourceSha256: selectedCase.sourceSha256,
                derivativeSha256: WAVY_DERIVATIVE_HASH, portraitImageIndex: result.analysis?.sourceSelection?.portraitImageIndex,
                expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
                provider: outputProvider.provider, model: outputProvider.model ?? outputProvider.modelId ?? null,
                ...selectedHashes, contractValidation: result.contractValidation,
                traceVersion: 2, carrier: "structured_region", status: "VALID",
                region: localizationGate.normalizedRegion.region,
                confidence: localizationGate.normalizedRegion.region.confidence,
                calibrationLocalizationEligible: true,
              };
            }
          } else if (RUN_WAVY_RELATIONSHIP_TRACE) {
            const observed = primaryPassed && result.localizationTrace?.traceVersion === 1 ? result.localizationTrace : null;
            const relationshipFailure = observed?.validationReason === "face_head_relationship_invalid"
              && (observed.relationshipFailure === "head_width_ratio"
                || observed.relationshipFailure === "head_height_ratio"
                || observed.relationshipFailure === "both_ratios")
              ? observed.relationshipFailure : null;
            const localizationTrace = observed ? {
              traceVersion: observed.traceVersion, status: observed.status,
              markerPresent: observed.markerPresent, terminalTokenPresent: observed.terminalTokenPresent,
              numericCount: observed.numericCount, numericParse: observed.numericParse,
              regionValidation: observed.regionValidation, validationReason: observed.validationReason,
              ...(relationshipFailure ? { relationshipFailure } : {}),
            } : null;
            artifact.primary = {
              caseId: selectedCase.id, sourceSha256: selectedCase.sourceSha256,
              productionInputDerivative, httpStatus: response.status, ok: result.ok === true,
              elapsedMs: result.elapsedMs ?? null, primaryElapsedMs: result.primaryElapsedMs ?? null,
              geminiElapsedMs: result.geminiElapsedMs ?? null, gemmaElapsedMs: result.gemmaElapsedMs ?? null,
              providerSequence: result.providerSequence ?? [], validation: result.validation ?? null,
              providerAccounting: accounting.dispatch,
              providerCalls: accounting.dispatch === "known" ? accounting.providerCalls : null,
              failureReason: result.failure?.reason ?? null,
              quality: result.analysis?.quality ?? null,
              faceVisible: (result.analysis?.visibleRegions as { face?: unknown } | undefined)?.face ?? null,
              portraitImageIndex: result.analysis?.sourceSelection?.portraitImageIndex ?? null,
              localizationTrace, providerLocalizationStatus: primaryPassed ? localizationGate.providerLocalizationStatus : null,
              normalizedPortraitRegionPresent: primaryPassed && localizationGate.normalizedRegion.ok,
              calibrationLocalizationEligible: localizationGate.calibrationLocalizationEligible,
            };
            if (primaryPassed && localizationGate.calibrationLocalizationEligible
              && localizationGate.normalizedRegion.ok && observed?.status === "VALID") {
              artifact.validLocalization = {
                caseId: selectedCase.id, runId, derivativeSha256: WAVY_DERIVATIVE_HASH,
                portraitImageIndex: result.analysis?.sourceSelection?.portraitImageIndex ?? null,
                promptBaseSha256: hash(COMPACT_PHOTO_ANALYSIS_V3_PROMPT),
                schemaJsonSha256: hash(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)),
                region: localizationGate.normalizedRegion.region,
              };
            }
          } else if (RUN_SINGLE_PRIMARY || RUN_ANY_NORMAL_ANCHOR || RUN_WAVY_TIMEOUT_TRACE) {
            artifact.primary = primary;
            artifact.rubricComparison = rubricComparison;
          } else artifact.primaryResults.push(primary);
          artifact.remainingSixAnalyzed = RUN_SIX_CASE_PRIMARY ? artifact.primaryResults.length : 0;
          await durableObserve(`primaryCompleted:${selectedCase.id}`);
          if (RUN_V4_WAVY_PRIMARY) {
            const trace = result.localizationTrace?.traceVersion === 2 ? result.localizationTrace : null;
            artifact.classification = !response.ok || accounting.dispatch !== "known"
              || !result.ok && !result.contractValidation ? "V4_REQUEST_OR_EXECUTION_FAILED"
              : result.contractValidation?.primaryCoreValid === false ? "V4_CORE_VALIDATION_FAILED"
                : !v4CorePassed ? "V4_REQUEST_OR_EXECUTION_FAILED"
                  : trace?.status === "VALID" && artifact.validLocalization
                    ? "V4_VALID_LOCALIZATION_OBSERVED"
                    : trace?.status === "EXPLICIT_NULL" ? "V4_EXPLICIT_NULL_OBSERVED"
                      : "V4_LOCALIZATION_CONTRACT_FAILURE";
            await durableObserve(`v4PrimaryTraceCaptured:${selectedCase.id}`);
            break;
          }
          if (RUN_WAVY_RELATIONSHIP_TRACE) {
            const trace = primaryPassed && result.localizationTrace?.traceVersion === 1 ? result.localizationTrace : null;
            artifact.classification = !primaryPassed ? "primary_provider_failed_cleanup_pending"
              : trace?.status === "VALID" && artifact.validLocalization ? "valid_localization_cleanup_pending"
                : trace?.status === "INVALID_REGION" && trace.validationReason === "face_head_relationship_invalid"
                  ? (trace.relationshipFailure === "head_width_ratio"
                    || trace.relationshipFailure === "head_height_ratio"
                    || trace.relationshipFailure === "both_ratios") ? "region_relationship_failure_cleanup_pending"
                    : "observability_gap_cleanup_pending"
                  : trace?.status ? "other_localization_failure_cleanup_pending" : "observability_gap_cleanup_pending";
            await durableObserve(`primaryTraceCaptured:${selectedCase.id}`);
            break;
          }
          if (RUN_WAVY_TIMEOUT_TRACE) {
            artifact.classification = primaryPassed
              ? "primary_timeout_trace_completed_cleanup_pending"
              : "primary_timeout_trace_failed_cleanup_pending";
            break;
          }
          if (RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR) {
            if (primaryPassed && localizationGate.providerLocalizationStatus !== "VALID") {
              artifact.classification = `LOCALIZATION_CONTRACT_FAILURE: ${selectedCase.id} (${localizationGate.providerLocalizationStatus ?? "trace_missing"})`;
              break;
            }
            const portraitValidation = localizationGate.normalizedRegion;
            if (!localizationGate.calibrationLocalizationEligible || !portraitValidation.ok) {
              artifact.classification = `BLOCKED: production primary did not yield a valid portraitRegion for ${selectedCase.id}`;
              break;
            }
            await durableObserve(`primaryPortraitRegionValidated:${selectedCase.id}`);
            const cropContext = result.analysis?.identityCropContext;
            if (!cropContext) {
              artifact.classification = `BLOCKED: production primary did not yield current crop context for ${selectedCase.id}`;
              break;
            }
            const localCrop = await createIdentityCrops(imageDataUrl, portraitValidation.region, cropContext);
            if (!localCrop || !localCrop.diagnostics.quality.usableForFaceGeometry) {
              artifact.classification = `BLOCKED: production face crop unavailable for ${selectedCase.id}`;
              break;
            }
            if ((RUN_EXTERNAL_OPEN_ANCHOR || RUN_WAVY_DERIVATIVE) && (localCrop.diagnostics.cropMode !== "subject_aware"
              || !localCrop.diagnostics.quality.sourceClippingKnown
              || localCrop.diagnostics.quality.cropClipping.left
              || localCrop.diagnostics.quality.cropClipping.right
              || localCrop.diagnostics.quality.sourceClipping.left
              || localCrop.diagnostics.quality.sourceClipping.right)) {
              artifact.classification = "BLOCKED: production derivative face crop lacks complete lateral margins";
              break;
            }
            artifact.calls.faceCropPreparations++;
            artifact.calls.hashChecks++;
            const cropBytes = Buffer.from(localCrop.faceDataUrl.slice(localCrop.faceDataUrl.indexOf(",") + 1), "base64");
            const cropSha256 = hash(cropBytes);
            if (RUN_EXTERNAL_OPEN_ANCHOR || RUN_WAVY_DERIVATIVE) {
              const decodedCrop = await decodeImage(cropBytes);
              expect([decodedCrop.width, decodedCrop.height]).toEqual([
                localCrop.diagnostics.faceCropDimensions.width, localCrop.diagnostics.faceCropDimensions.height,
              ]);
            }
            await durableObserve(`anchorCropPrepared:${selectedCase.id}`);
            const geometryContractValid = hash(FACE_IDENTITY_GEOMETRY_PROMPT) === FACE_GEOMETRY_PROMPT_HASH
              && hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)) === FACE_GEOMETRY_SCHEMA_HASH
              && fs.readFileSync("src/generate.ts", "utf8").includes("headHeightPixels * 0.65")
              && fs.readFileSync("src/identityQuantization.ts", "utf8")
                .includes('geometry.eyes.openness >= 0.68 ? "open" : geometry.eyes.openness <= 0.34 ? "compact" : "readable"');
            if (!geometryContractValid) {
              artifact.classification = "BLOCKED: face geometry contract preflight mismatch";
              break;
            }
            const geometryRunId = randomBytes(16).toString("hex");
            artifact.calls.jpegTransmissions++;
            artifact.calls.jpegOrPngTransmissions++;
            artifact.calls.geometryPosts++;
            await durableObserve(`anchorGeometryPostStarted:${selectedCase.id}`);
            const geometryResponse = await fetch(`${url}/face-geometry-audit`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": geometryRunId },
              body: JSON.stringify({ imageDataUrl, portraitRegion: portraitValidation.region, cropContext }),
              signal: AbortSignal.timeout(60_000),
            });
            artifact.geometryHttpStatus = geometryResponse.status;
            await durableObserve(`anchorGeometryHeadersReceived:${selectedCase.id}`);
            const geometryResult = await geometryResponse.json() as GeometryRemoteResult;
            await durableObserve(`anchorGeometryBodyParsed:${selectedCase.id}`);
            const geometryAccounting = accountingOf(geometryResult.auditState, geometryRunId);
            artifact.providerAccounting = geometryAccounting.dispatch;
            if (geometryAccounting.dispatch === "known") {
              artifact.geometryProviderCalls = geometryAccounting.providerCalls;
              for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
                artifact.providerCalls[key] += geometryAccounting.providerCalls[key];
              }
            }
            const geometryValid = geometryResponse.ok && geometryResult.ok === true
              && geometryResult.providerShapeValid === true && (geometryResult.errors?.length ?? 0) === 0
              && Boolean(geometryResult.geometry) && geometryAccounting.dispatch === "known";
            const confidenceUsable = (geometryResult.geometry?.confidence.eyes ?? 0) >= 0.55;
            const lateralCropClean = !localCrop.diagnostics.quality.cropClipping.left
              && !localCrop.diagnostics.quality.cropClipping.right
              && (!RUN_WAVY_DERIVATIVE || (!localCrop.diagnostics.quality.sourceClipping.left
                && !localCrop.diagnostics.quality.sourceClipping.right));
            const noGlasses = result.analysis?.fallbackFeaturesGlasses === "none"
              && (RUN_ANY_OPEN_ANCHOR || selectedCase.glassesOrCovering === "none");
            const envelopeClean = (geometryResult.geometry?.face.envelopeLeft ?? 0) > 0
              && (geometryResult.geometry?.face.envelopeRight ?? 1) < 1;
            const sourceLabelFrozen = RUN_ANY_OPEN_ANCHOR || RUN_WAVY_DERIVATIVE
              ? artifact.frozenSourcePreflight?.labelFrozenBeforeProvider === true : true;
            const anchorTier = geometryValid && confidenceUsable && lateralCropClean && noGlasses
              && envelopeClean && sourceLabelFrozen
              ? RUN_ANY_OPEN_ANCHOR ? "TIER_A_OPEN_GEOMETRY_ANCHOR"
                : RUN_WAVY_DERIVATIVE ? "TIER_A_NORMAL_GEOMETRY_ANCHOR_PRODUCTION_PARITY" : "TIER_A_NORMAL_ANCHOR"
              : geometryValid && confidenceUsable && noGlasses
                ? RUN_ANY_OPEN_ANCHOR ? "TIER_B_OPEN_DIRECTIONAL" : "TIER_B_NORMAL_DIRECTIONAL"
                : RUN_ANY_OPEN_ANCHOR ? "INELIGIBLE_OPEN_ANCHOR" : "INELIGIBLE_NORMAL_ANCHOR";
            artifact.geometryResults.push({
              caseId: selectedCase.id,
              sourceClass: RUN_EXTERNAL_OPEN_ANCHOR ? "canonical_original_with_production_derivative"
                : RUN_WAVY_DERIVATIVE ? "canonical_source_with_production_derivative"
                : RUN_OPEN_ANCHOR ? "frozen_reviewed_derived_artifact" : "raw_production_photo",
              sourceSha256: selectedCase.sourceSha256,
              sourceDecodedRgbaSha256: RUN_EXTERNAL_OPEN_ANCHOR
                ? "235b852bbcc9acf02d84e484705d7174a1bbb33748bf5f12ce1aa47f9a7a9c89"
                : RUN_OPEN_ANCHOR ? OPEN_SOURCE_RGBA_HASH : null,
              productionInputDerivative,
              sourceBytes: selectedCase.sourceBytes,
              sourceImageIndex: 0,
              frozenSourceEyeOpenness: selectedCase.rubric.eyeOpenness.values?.[0] ?? null,
              freshPortraitRegion: portraitValidation.region,
              primaryFaceMeasurementEvidence: result.analysis?.faceMeasurementEvidence ?? null,
              primaryFallbackFeaturesGlasses: result.analysis?.fallbackFeaturesGlasses ?? null,
              primaryObservedAccessories: result.analysis?.observedAccessories ?? null,
              primaryCanonicalAccessoryCues: result.analysis?.canonicalAccessoryCues ?? null,
              cropContext,
              crop: localCrop.diagnostics,
              faceCropSha256: cropSha256,
              faceCropEncodedBytes: cropBytes.byteLength,
              httpStatus: geometryResponse.status,
              ok: geometryResult.ok === true,
              elapsedMs: geometryResult.elapsedMs ?? null,
              providerShapeValid: geometryResult.providerShapeValid ?? false,
              semanticValidationPassed: geometryResult.ok === true && (geometryResult.errors?.length ?? 0) === 0,
              errors: geometryResult.errors ?? [],
              measurements: geometryResult.measurements ?? null,
              geometry: geometryResult.geometry ?? null,
              providerHttpStatus: geometryResult.httpStatus ?? null,
              providerStatus: geometryResult.providerStatus ?? null,
              providerAccounting: geometryAccounting.dispatch,
              providerCalls: geometryAccounting.dispatch === "known" ? geometryAccounting.providerCalls : null,
              cropValidity: { usableForFaceGeometry: localCrop.diagnostics.quality.usableForFaceGeometry,
                lateralCropClean, envelopeClean, sourceClippingKnown: localCrop.diagnostics.quality.sourceClippingKnown,
                sourceClipping: localCrop.diagnostics.quality.sourceClipping,
                cropClipping: localCrop.diagnostics.quality.cropClipping },
              anchorTier,
            });
            if (RUN_ANY_OPEN_ANCHOR) {
              const openScore = geometryResult.geometry?.eyes.openness ?? null;
              const relation = anchorTier !== "TIER_A_OPEN_GEOMETRY_ANCHOR" ? "HIGH_BOUNDARY_STILL_UNIDENTIFIABLE"
                : openScore === null ? "HIGH_BOUNDARY_STILL_UNIDENTIFIABLE"
                  : openScore > 0.6 ? "HIGH_BOUNDARY_SEPARABLE"
                    : openScore === 0.6 ? "HIGH_BOUNDARY_NON_SEPARABLE" : "HIGH_BOUNDARY_ORDER_INVERTED";
              artifact.openAnchor = { caseId: selectedCase.id,
                sourceClass: RUN_EXTERNAL_OPEN_ANCHOR ? "canonical_original_with_production_derivative" : "frozen_reviewed_derived_artifact",
                productionInputDerivative,
                frozenSourceEyeOpenness: "open", anchorTier, postContractOpenness: openScore,
                eyesConfidence: geometryResult.geometry?.confidence.eyes ?? null, cropSha256,
                normalReference: 0.6, relation,
                feasibleInterval: relation === "HIGH_BOUNDARY_SEPARABLE" ? `(0.60, ${openScore?.toFixed(2)})` : null,
                currentOpenMinCompatibility: anchorTier !== "TIER_A_OPEN_GEOMETRY_ANCHOR" || openScore === null
                  ? "NOT_EVALUABLE" : 0.68 <= openScore
                    ? "CURRENT_HIGH_BOUNDARY_COMPATIBLE_WITH_ANCHORS"
                    : "CURRENT_HIGH_BOUNDARY_INCOMPATIBLE_WITH_ANCHOR",
                threeClassState: anchorTier === "TIER_A_OPEN_GEOMETRY_ANCHOR" && openScore !== null && 0.6 < openScore
                  ? "THREE_CLASS_ORDER_ESTABLISHED" : "THREE_CLASS_ORDER_NOT_ESTABLISHED" };
            } else {
              const normalScore = geometryResult.geometry?.eyes.openness ?? null;
              artifact.normalAnchor = { caseId: selectedCase.id, frozenSourceEyeOpenness: "normal", anchorTier,
                postContractOpenness: normalScore, eyesConfidence: geometryResult.geometry?.confidence.eyes ?? null,
                cropSha256, productionInputParity: RUN_WAVY_DERIVATIVE,
                historicalRawInputOpenness: RUN_WAVY_DERIVATIVE ? 0.6 : null,
                historicalPreContractOpenness: 0.85 };
              if (RUN_WAVY_DERIVATIVE) {
                const relation = anchorTier !== "TIER_A_NORMAL_GEOMETRY_ANCHOR_PRODUCTION_PARITY" || normalScore === null
                  ? "NORMAL_PRODUCTION_ANCHOR_INVALID"
                  : normalScore < 0.6 ? "OPEN_NORMAL_PRODUCTION_SEPARABLE"
                    : normalScore === 0.6 ? "OPEN_NORMAL_PRODUCTION_NON_SEPARABLE"
                      : "OPEN_NORMAL_PRODUCTION_ORDER_INVERTED";
                artifact.openNormalComparison = { productionOpenOpenness: 0.6, productionOpenConfidence: 0.95,
                  normalOpenness: normalScore, normalConfidence: geometryResult.geometry?.confidence.eyes ?? null,
                  historicalRawInputNormalOpenness: 0.6,
                  preprocessingDelta: normalScore === null ? null : normalScore - 0.6,
                  relation, feasibleHighInterval: relation === "OPEN_NORMAL_PRODUCTION_SEPARABLE"
                    ? `(${normalScore?.toFixed(2)}, 0.60)` : null,
                  currentOpenMin: 0.68, lowBoundaryProductionParity: "UNVALIDATED_FOR_INPUT_PARITY" };
              }
            }
            await durableObserve(`anchorGeometryCompleted:${selectedCase.id}`);
            artifact.classification = geometryValid
              ? RUN_ANY_OPEN_ANCHOR ? "open_anchor_completed_cleanup_pending" : "normal_anchor_completed_cleanup_pending"
              : RUN_WAVY_DERIVATIVE ? "NORMAL_PRODUCTION_ANCHOR_INVALID"
                : `BLOCKED: ${selectedCase.id} face geometry validation failed`;
            break;
          }
          if (!response.ok || accounting.dispatch !== "known") {
            artifact.classification = !response.ok
              ? "BLOCKED: primary POST did not return HTTP success"
              : "BLOCKED: provider accounting became unknown";
            break;
          }
        }
        if (RUN_TARGETED_PRIMARY && artifact.primaryResults.length === selectedCases.length
          && artifact.providerAccounting === "known") artifact.classification = "targeted_recheck_completed_cleanup_pending";
        else if (RUN_SIX_CASE_PRIMARY && artifact.primaryResults.length === selectedCases.length
          && artifact.providerAccounting === "known") artifact.classification = "six_case_batch_completed_cleanup_pending";
        else if (RUN_SINGLE_PRIMARY) {
          const primary = artifact.primary;
          const passed = primary?.ok === true && Boolean(primary.faceMeasurementEvidence)
            && (primary.validation as Record<string, string> | null)?.compactProviderSchema === "passed"
            && (primary.validation as Record<string, string> | null)?.compactStrictRuntime === "passed"
            && (primary.validation as Record<string, string> | null)?.richPhotoAnalysis === "passed";
          artifact.classification = passed ? "canary_passed_cleanup_pending" : "BLOCKED: primary analysis validation failed";
        }
      }
    }
  } catch (error) {
    // Error detail is classified, never the raw message/path/token.
    artifact.classification = checkpointFailure ? "BLOCKED: audit checkpoint persistence failed"
      : RUN_CURRENT_DEFAULT_E2E ? "BLOCKED: current-default E2E preflight or runtime boundary"
      : RUN_EYE_APERTURE || RUN_EYE_APERTURE_V2 ? "BLOCKED: experimental aperture preflight or runtime evidence boundary"
      : RUN_V4_OPEN_GEOMETRY && artifact.calls.geometryPosts > 0
      ? "BLOCKED: V4 OPEN geometry POST failed before validated response"
      : RUN_V4_OPEN_GEOMETRY && artifact.calls.primaryPosts > 0
      ? "BLOCKED: V4 OPEN primary POST failed before validated response"
      : RUN_SAVED_V4_FACE_GEOMETRY && artifact.calls.geometryPosts > 0
      ? "BLOCKED: saved V4 geometry POST failed before validated response"
      : RUN_OPEN_DIRECTIONAL && artifact.calls.geometryPosts > 0
      ? "BLOCKED: direct open geometry provider/runtime failure"
      : artifact.calls.primaryPosts > 0
      ? "BLOCKED: primary POST failed before a validated response"
      : artifact.calls.hashChecks > 0
        ? "BLOCKED: canary source hash or byte-count verification failed"
        : "BLOCKED: audit config or lifecycle preflight failed";
    const safe = exceptionDiagnostic(error, "startup");
    observe(`exception_${safe.messageClassified}`);
  } finally {
    if (owner && !ownerExited && artifact.hotkeyRegistrationProven && !qRequested) {
      qRequested = true; artifact.shutdownRequested = true; observe("shutdownRequested");
      await writes; // Record q intent before the one literal q, including on failure paths.
      owner.send({ command: "q", registrationProven: true });
    }
    if (owner && exitPromise && closePromise) {
      const completion = await bounded(Promise.all([exitPromise, closePromise]), 30_000);
      if (!completion.done || !ownerClosed) {
        artifact.cleanupFailed = true; artifact.classification = "BLOCKED: graceful q teardown was not confirmed";
        // Fail closed: do not close the terminal or terminate live Wrangler.
        // Keep the dedicated owner alive and identifiable; no further run.
        owner.unref(); if (owner.connected) owner.disconnect();
      }
    }
    if (!owner || ownerClosed) {
      try {
        const after = support.processSnapshot();
        artifact.ownedProcessInventoryClean = !after.some(record => owned.some(old => old.pid === record.pid && old.created === record.created));
        if (!artifact.ownedProcessInventoryClean) { artifact.cleanupFailed = true; artifact.classification = "BLOCKED: owned process cleanup was incomplete"; }
      } catch { artifact.cleanupFailed = true; artifact.classification = "BLOCKED: owned process cleanup could not be verified"; }
      if (artifact.ownedProcessInventoryClean) {
        try {
          if (tokenFile) fs.unlinkSync(tokenFile);
          artifact.temporaryTokenFileRemoved = !tokenFile || !fs.existsSync(tokenFile);
          if (tokenDirectory) fs.rmdirSync(tokenDirectory);
          if (artifact.temporaryConfigUsed) fs.unlinkSync(configPath);
          artifact.temporaryConfigRemoved = !fs.existsSync(configPath);
        } catch { artifact.cleanupFailed = true; artifact.classification = "BLOCKED: temporary audit file cleanup failed"; }
      }
    }
    token = "";
    artifact.productionConfigHashAfter = hash(fs.readFileSync("wrangler.jsonc"));
    artifact.productionConfigChanged = artifact.productionConfigHashAfter !== artifact.productionConfigHashBefore;
    artifact.wranglerGracefulTeardownPathCompleted = artifact.shutdownRequested && artifact.qSentCount === 1
      && artifact.wrapperExitObserved && artifact.wrapperCloseObserved && artifact.wrapperExitCode === 0 && artifact.wrapperSignalAbsent
      && artifact.bridgeCompletionObserved && artifact.ptyExitObserved && artifact.ptyExitCode === 0
      && artifact.ownerResultFlushed && artifact.ownerExitObserved && artifact.ownerCloseObserved && artifact.ownerExitCode === 0;
    if (artifact.startupAttempts === 1 && !artifact.wranglerGracefulTeardownPathCompleted) {
      artifact.cleanupFailed = true; artifact.classification = "BLOCKED: graceful q teardown was not confirmed";
    }
    if (artifact.health?.status === "passed" && artifact.wranglerGracefulTeardownPathCompleted
      && artifact.ownedProcessInventoryClean && artifact.temporaryConfigRemoved && artifact.temporaryTokenFileRemoved
      && !artifact.productionConfigChanged && !artifact.cleanupFailed) {
      if (!RUN_REMOTE) artifact.classification = "READY_FOR_SINGLE_BOUND_PROFILE_PRIMARY_CANARY";
      else if (RUN_CURRENT_SOURCE_V4 && artifact.classification === "current_source_v4_completed_cleanup_pending") {
        artifact.classification = artifact.currentSourceV4!.classification;
      }
      else if (RUN_CURRENT_DEFAULT_E2E && artifact.classification === "current_default_e2e_completed_cleanup_pending") {
        artifact.classification = artifact.currentDefaultE2E!.classification;
      }
      else if (RUN_EYE_APERTURE_V2 && artifact.classification === "aperture_v2_completed_cleanup_pending") {
        artifact.classification = artifact.apertureV2!.classification;
      }
      else if (RUN_EYE_APERTURE && artifact.classification === "aperture_completed_cleanup_pending") {
        artifact.classification = artifact.aperturePilot!.classification;
      }
      else if (RUN_WAVY_TIMEOUT_TRACE && artifact.classification === "primary_timeout_trace_completed_cleanup_pending") {
        artifact.classification = "PRIMARY_SUCCESS_WITH_TIMEOUT_TRACE";
      }
      else if (RUN_WAVY_TIMEOUT_TRACE && artifact.classification === "primary_timeout_trace_failed_cleanup_pending") {
        artifact.classification = "TIMEOUT_ORIGIN_TRACE_REVIEW_REQUIRED";
      }
      else if (RUN_WAVY_RELATIONSHIP_TRACE) {
        const completed: Record<string, string> = {
          valid_localization_cleanup_pending: "VALID_LOCALIZATION_SAVED",
          region_relationship_failure_cleanup_pending: "REGION_RELATION_FAILURE_OBSERVED",
          other_localization_failure_cleanup_pending: "OTHER_LOCALIZATION_FAILURE_OBSERVED",
          primary_provider_failed_cleanup_pending: "PRIMARY_PROVIDER_FAILED_WITH_TRACE",
          observability_gap_cleanup_pending: "OBSERVABILITY_GAP",
        };
        artifact.classification = completed[artifact.classification] ?? artifact.classification;
      }
      else if (RUN_FACE_GEOMETRY_TARGETS && artifact.classification === "geometry_audit_completed_cleanup_pending") {
        artifact.classification = "READY_TO_REVIEW_FACE_GEOMETRY_LOW_EYE_TARGET_AUDIT";
      }
      else if (RUN_ANY_NORMAL_ANCHOR && artifact.classification === "normal_anchor_completed_cleanup_pending") {
        artifact.classification = RUN_WAVY_DERIVATIVE
          ? String(artifact.openNormalComparison?.relation ?? "NORMAL_PRODUCTION_ANCHOR_INVALID")
          : "READY_TO_REVIEW_FACE_GEOMETRY_NORMAL_ANCHOR";
      }
      else if (RUN_ANY_OPEN_ANCHOR && artifact.classification === "open_anchor_completed_cleanup_pending") {
        artifact.classification = "READY_TO_REVIEW_FACE_GEOMETRY_OPEN_ANCHOR";
      }
      else if (RUN_OPEN_DIRECTIONAL && artifact.classification === "open_directional_completed_cleanup_pending") {
        artifact.classification = String(artifact.openDirectional?.directionalClassification ?? "BLOCKED: direct open direction missing");
      }
      else if (RUN_SAVED_V4_FACE_GEOMETRY && artifact.classification === "saved_v4_geometry_observed_cleanup_pending") {
        artifact.classification = "V4_NORMAL_GEOMETRY_OBSERVED_WITH_LIMITATIONS";
      }
      else if (RUN_V4_OPEN_GEOMETRY && artifact.classification === "v4_open_geometry_observed_cleanup_pending") {
        artifact.classification = "V4_OPEN_GEOMETRY_OBSERVED_WITH_LIMITATIONS";
      }
      else if (artifact.classification === "canary_passed_cleanup_pending") artifact.classification = "READY_TO_REVIEW_PRIMARY_FACE_MEASUREMENT_CANARY";
      else if (artifact.classification === "six_case_batch_completed_cleanup_pending") artifact.classification = "READY_TO_REVIEW_SIX_CASE_PRIMARY_FACE_MEASUREMENT_AUDIT";
      else if (artifact.classification === "targeted_recheck_completed_cleanup_pending") artifact.classification = "READY_TO_REVIEW_TARGETED_EYE_CATEGORY_RECHECK";
    }
    observe("finalCheckpoint"); await writes;
    if (RUN_CURRENT_SOURCE_V4 && artifact.currentSourceV4 && currentV4Preflight) {
      const recovered = await readLatestAuditCheckpoint(checkpoint);
      const restored = (recovered?.snapshot as { currentSourceV4?: CurrentSourceV4State } | undefined)?.currentSourceV4;
      expect(recovered?.snapshotSha256).toBe(hash(JSON.stringify(recovered?.snapshot)));
      expect(restored).toEqual(artifact.currentSourceV4);
      if (restored?.acceptedGeometry) expect(acceptedFaceGeometry(restored.acceptedGeometry)).toEqual(restored.acceptedGeometry);
      for (const [file, expected] of Object.entries(currentV4Preflight.fixedHashes)) expect(hash(fs.readFileSync(file))).toBe(expected);
      artifact.currentSourceV4.diskRecovery = true;
      await durableObserve("currentSourceV4DiskRecoveryChecked");
    }
    if (RUN_CURRENT_DEFAULT_E2E && artifact.currentDefaultE2E) {
      const recovered = await readLatestAuditCheckpoint(checkpoint);
      const restored = (recovered?.snapshot as { currentDefaultE2E?: E2EState } | undefined)?.currentDefaultE2E;
      expect(recovered?.snapshotSha256).toBe(hash(JSON.stringify(recovered?.snapshot)));
      expect(restored).toEqual(artifact.currentDefaultE2E);
      for (const [file, expected] of Object.entries(artifact.currentDefaultE2E.fixedHashes)) expect(hash(fs.readFileSync(file))).toBe(expected);
      artifact.currentDefaultE2E.diskRecovery = true;
      await durableObserve("currentDefaultE2EDiskRecoveryChecked");
    }
    if (RUN_EYE_APERTURE_V2 && artifact.apertureV2) {
      const recovered = await readLatestAuditCheckpoint(checkpoint);
      const restored = (recovered?.snapshot as { apertureV2?: ApertureV2State } | undefined)?.apertureV2;
      expect(Boolean(restored && recovered && recovered.snapshotSha256 === hash(JSON.stringify(recovered.snapshot))),
        "aperture_v2_checkpoint_integrity_failed").toBe(true);
      verifyApertureV2Recovery(restored!, artifact.apertureV2);
      for (const [file, expected] of Object.entries(artifact.apertureV2.fixedHashes)) expect(hash(fs.readFileSync(file))).toBe(expected);
      artifact.apertureV2.diskRecovery = true;
      await durableObserve("apertureV2DiskRecoveryChecked");
    }
    if (RUN_EYE_APERTURE && artifact.aperturePilot) {
      const recovered = await readLatestAuditCheckpoint(checkpoint);
      const restored = (recovered?.snapshot as { aperturePilot?: AperturePilotState } | undefined)?.aperturePilot;
      if (!restored || !recovered || recovered.snapshotSha256 !== hash(JSON.stringify(recovered.snapshot)))
        throw new Error("aperture_checkpoint_integrity_failed");
      verifyApertureRecovery(restored, artifact.aperturePilot);
      expect(hash(fs.readFileSync("test/audit/eyeAperturePrototype.ts"))).toBe(artifact.aperturePilot.prototypeSourceSha256);
      for (const [file, expected] of Object.entries(artifact.aperturePilot.productionHashes))
        expect(hash(fs.readFileSync(file))).toBe(expected);
      artifact.aperturePilot.diskRecovery = true;
      await durableObserve("apertureDiskRecoveryChecked");
    }
    if (RUN_SAVED_V4_FACE_GEOMETRY) {
      const recovered = await readLatestAuditCheckpoint(checkpoint);
      const saved = recovered?.snapshot as { savedV4FaceGeometry?: { acceptedGeometry?: FaceIdentityGeometryAnalysis | null;
        cropSha256?: string; primaryRunId?: string } } | undefined;
      const memory = artifact.savedV4FaceGeometry?.acceptedGeometry as FaceIdentityGeometryAnalysis | null | undefined;
      const restored = saved?.savedV4FaceGeometry?.acceptedGeometry;
      let matches = recovered?.snapshotSha256 === hash(JSON.stringify(recovered.snapshot))
        && saved?.savedV4FaceGeometry?.cropSha256 === SAVED_V4_CROP_SHA
        && saved?.savedV4FaceGeometry?.primaryRunId === artifact.savedV4FaceGeometry?.primaryRunId
        && JSON.stringify(restored ?? null) === JSON.stringify(memory ?? null);
      if (matches && restored) {
        try { matches = JSON.stringify(acceptedFaceGeometry(restored)) === JSON.stringify(restored); }
        catch { matches = false; }
      }
      artifact.savedV4FaceGeometry = { ...artifact.savedV4FaceGeometry,
        diskRecovery: matches === true, recoveredSequence: recovered?.sequence ?? null,
        acceptedGeometryRevalidated: Boolean(restored && matches) };
      if (!matches) artifact.classification = "BLOCKED: accepted geometry checkpoint recovery failed";
      await observe("savedV4GeometryDiskRecoveryChecked"); await writes;
    }
    if (RUN_V4_OPEN_GEOMETRY) {
      const recovered = await readLatestAuditCheckpoint(checkpoint);
      const restoredSnapshot = recovered?.snapshot as { v4Open?: { acceptedGeometry?: FaceIdentityGeometryAnalysis | null;
        cropSha256?: string; geometryImageSha256?: string; primaryRunId?: string;
        derivativeSha256?: string; geometryRunId?: string } } | undefined;
      const restored = restoredSnapshot?.v4Open?.acceptedGeometry;
      const memory = artifact.v4Open?.acceptedGeometry as FaceIdentityGeometryAnalysis | null | undefined;
      let matches = recovered?.snapshotSha256 === hash(JSON.stringify(recovered.snapshot))
        && restoredSnapshot?.v4Open?.derivativeSha256 === EXTERNAL_OPEN_DERIVATIVE_HASH
        && restoredSnapshot.v4Open.primaryRunId === artifact.v4Open?.primaryRunId
        && restoredSnapshot.v4Open.geometryRunId === artifact.v4Open?.geometryRunId
        && restoredSnapshot.v4Open.cropSha256 === artifact.v4Open?.cropSha256
        && restoredSnapshot.v4Open.geometryImageSha256 === artifact.v4Open?.geometryImageSha256
        && JSON.stringify(restored ?? null) === JSON.stringify(memory ?? null);
      if (matches && restored) {
        try { matches = JSON.stringify(acceptedFaceGeometry(restored)) === JSON.stringify(restored); }
        catch { matches = false; }
      }
      artifact.v4Open = { ...artifact.v4Open, diskRecovery: matches === true,
        recoveredSequence: recovered?.sequence ?? null,
        acceptedGeometryRevalidated: Boolean(restored && matches) };
      if (!matches) artifact.classification = "BLOCKED: V4 OPEN checkpoint recovery failed";
      await observe("v4OpenDiskRecoveryChecked"); await writes;
    }
    if (checkpointFailure) expect.fail("audit checkpoint persistence failed");
  }
  expect(artifact.startupAttempts).toBeLessThanOrEqual(1);
  if (RUN_CURRENT_DEFAULT_E2E && artifact.currentDefaultE2E) {
    expect(artifact.currentDefaultE2E.generationPosts).toBeLessThanOrEqual(1);
    expect(artifact.currentDefaultE2E.providerRetry).toBe(0);
    const attempts = artifact.currentDefaultE2E.result?.bindingAttempts as { stage: string }[] | undefined;
    if (attempts) for (const stage of ["geminiPrimary", "gemmaPrimary", "faceGeometry"])
      expect(attempts.filter(attempt => attempt.stage === stage).length).toBeLessThanOrEqual(1);
  }
  expect(artifact.healthAttempts).toBeLessThanOrEqual(1);
  expect(artifact.qSentCount).toBeLessThanOrEqual(1);
  const primaryLimit = RUN_TARGETED_PRIMARY ? 3 : RUN_SIX_CASE_PRIMARY ? 6
    : RUN_CURRENT_SOURCE_V4 || RUN_SINGLE_PRIMARY || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_WAVY_PRIMARY_TRACE || RUN_V4_OPEN_GEOMETRY ? 1 : 0;
  const geometryLimit = RUN_WAVY_RELATIONSHIP_TRACE ? 0
    : RUN_FACE_GEOMETRY_TARGETS ? 2 : RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL ? 1 : 0;
  const geometryLimitForRun = geometryLimit + Number(RUN_SAVED_V4_FACE_GEOMETRY) + Number(RUN_V4_OPEN_GEOMETRY) + Number(RUN_CURRENT_SOURCE_V4);
  const directSourceLimit = RUN_OPEN_DIRECTIONAL || RUN_SAVED_V4_FACE_GEOMETRY ? 1 : 0;
  expect(artifact.calls.primaryPosts).toBeLessThanOrEqual(primaryLimit);
  expect(artifact.calls.geometryPosts).toBeLessThanOrEqual(geometryLimitForRun);
  if (RUN_WAVY_PRIMARY_TRACE) {
    expect(artifact.calls.faceCropPreparations).toBe(0);
    expect(artifact.calls.geometryPosts).toBe(0);
    expect(artifact.geometryResults).toHaveLength(0);
  }
  expect(artifact.calls.sourceReads).toBeLessThanOrEqual(primaryLimit + directSourceLimit);
  expect(artifact.calls.derivativeReads).toBeLessThanOrEqual(RUN_WAVY_PRIMARY_INPUT || RUN_V4_OPEN_GEOMETRY ? 1 : RUN_EXTERNAL_OPEN_ANCHOR ? 1 : 0);
  expect(artifact.calls.fileHashChecks).toBeLessThanOrEqual(primaryLimit + directSourceLimit);
  expect(artifact.calls.rgbaHashChecks).toBeLessThanOrEqual(RUN_CURRENT_SOURCE_V4 || RUN_SAVED_V4_FACE_GEOMETRY ? 1 : RUN_EXTERNAL_OPEN_ANCHOR || RUN_V4_OPEN_GEOMETRY ? 2
    : RUN_WAVY_PRIMARY_INPUT ? 1
    : RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL ? 1 : 0);
  // This primary-only mode verifies the original for provenance, then reads
  // the frozen derivative for transmission; neither read is a second POST.
  expect(artifact.calls.jpegReads).toBeLessThanOrEqual(primaryLimit + geometryLimit + Number(RUN_WAVY_PRIMARY_TRACE));
  if ((RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL) && artifact.health?.status !== "passed") {
    expect(artifact.calls.sourceReads).toBe(0);
    expect(artifact.calls.primaryPosts).toBe(0);
    expect(artifact.calls.geometryPosts).toBe(0);
  }
  expect(artifact.providerCalls?.geminiStarted ?? 0).toBeLessThanOrEqual(primaryLimit);
  expect(artifact.providerCalls?.gemmaStarted ?? 0).toBeLessThanOrEqual(primaryLimit + geometryLimitForRun + (RUN_EYE_APERTURE ? 4 : 0) + (RUN_EYE_APERTURE_V2 ? 2 : 0));
  if (RUN_EYE_APERTURE_V2) {
    expect(artifact.apertureV2!.posts).toBeLessThanOrEqual(2);
    expect(artifact.calls.jpegOrPngTransmissions).toBeLessThanOrEqual(2);
    expect(artifact.calls.primaryPosts + artifact.calls.geometryPosts + artifact.calls.faceCropPreparations + artifact.calls.jpegTransmissions).toBe(0);
  }
  if (RUN_EYE_APERTURE) {
    expect(artifact.aperturePilot!.posts).toBeLessThanOrEqual(4);
    expect(artifact.calls.primaryPosts + artifact.calls.geometryPosts + artifact.calls.faceCropPreparations + artifact.calls.jpegTransmissions).toBe(0);
  }
  if (RUN_SAVED_V4_FACE_GEOMETRY) {
    expect(artifact.calls.primaryPosts).toBe(0);
    expect(artifact.calls.faceCropPreparations).toBe(0);
    expect(artifact.calls.jpegReads).toBe(0);
    expect(artifact.calls.jpegTransmissions).toBe(0);
    expect(artifact.calls.geometryPosts).toBeLessThanOrEqual(1);
    expect(artifact.providerCalls?.geminiStarted ?? 0).toBe(0);
    if (artifact.health?.status !== "passed") expect(artifact.calls.sourceReads).toBe(0);
  }
  if (RUN_V4_OPEN_GEOMETRY) {
    expect(artifact.calls.primaryPosts).toBeLessThanOrEqual(1);
    expect(artifact.calls.geometryPosts).toBeLessThanOrEqual(1);
    expect(artifact.calls.faceCropPreparations).toBeLessThanOrEqual(1);
    expect(artifact.calls.jpegTransmissions).toBeLessThanOrEqual(1);
    expect(artifact.calls.jpegOrPngTransmissions).toBeLessThanOrEqual(2);
    expect(artifact.providerCalls?.geminiStarted ?? 0).toBeLessThanOrEqual(1);
    expect(artifact.providerCalls?.gemmaStarted ?? 0).toBeLessThanOrEqual(2);
    if (artifact.health?.status !== "passed") {
      expect(artifact.calls.sourceReads).toBe(0);
      expect(artifact.calls.primaryPosts).toBe(0);
      expect(artifact.calls.geometryPosts).toBe(0);
    }
  }
  expect(artifact.providerCalls?.retry ?? 0).toBe(0);
  if (RUN_OPEN_DIRECTIONAL) {
    expect(artifact.calls.primaryPosts).toBe(0);
    expect(artifact.calls.faceCropPreparations).toBe(0);
    expect(artifact.calls.geometryPosts).toBeLessThanOrEqual(1);
    expect(artifact.providerCalls?.geminiStarted ?? 0).toBe(0);
    expect(artifact.providerCalls?.gemmaStarted ?? 0).toBeLessThanOrEqual(1);
    expect(artifact.calls.jpegReads).toBe(0);
    expect(artifact.calls.jpegTransmissions).toBe(0);
  }
  expect(Object.values(artifact.prohibited).every(value => value === 0)).toBe(true);
  expect(artifact.productionConfigChanged).toBe(false);
}, RUN_SIX_CASE_PRIMARY || RUN_TARGETED_PRIMARY || RUN_FACE_GEOMETRY_TARGETS || RUN_ANY_NORMAL_ANCHOR || RUN_ANY_OPEN_ANCHOR || RUN_OPEN_DIRECTIONAL || RUN_V4_OPEN_GEOMETRY || RUN_EYE_APERTURE ? 900_000 : 300_000);
