import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_OPEN_ANCHOR_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-open-anchor-live-20260922-001");
const SUMMARY = path.join(ROOT, "summary.json");
const EXPECTED = {
  head: "3922d659989c237bf7dc011f1dac6659cc4b3a27",
  sourceSha256: "eaa53f58cd9c85b1e5507c8aa3df4152ed730501c74af1d337ec83f6e49e9938",
  sourceRgbaSha256: "66a63da69067d1d50eb1a40354ad585900cd64161c5c1c5d82efbfb13ae00e92",
  frozenPayloadSha256: "5bcb431e3d7a39a0e786aa5b20426ccc3d0989fc60ab1618b153188f90be5d7b",
  rubricSha256: "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27",
  promptSha256: "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd",
  schemaSha256: "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469",
  summarySha256: "76ccf76b1a9c6ab150a81a43cd310096f2700f7ca3422f0fce9e8bd5245bd8a7",
} as const;

type Summary = {
  mode: string;
  branch: string;
  head: string;
  sourceRubricSha256: string;
  faceGeometryPromptSha256: string;
  faceGeometrySchemaSha256: string;
  faceGeometryContract: { lateralGuard: number; compactMax: number; openMin: number };
  selectedCases: Array<{ id: string; photoId: number; expectedSha256: string; expectedBytes: number }>;
  startupAttempts: number;
  healthAttempts: number;
  health: { status: string; httpStatus: number; body: { providerCalls: number } };
  calls: Record<string, number>;
  providerCalls: Record<string, number>;
  primaryProviderCalls: Record<string, number>;
  geometryProviderCalls: Record<string, number> | null;
  primaryResults: Array<Record<string, unknown> & {
    httpStatus: number; ok: boolean; elapsedMs: number; attempts: number;
    providerSequence: Array<Record<string, unknown>>;
    failure: { reason: string; detail: unknown };
  }>;
  geometryResults: unknown[];
  openAnchor: unknown;
  frozenSourcePreflight: Record<string, unknown>;
  prohibited: Record<string, number>;
  packageManagerCalls: number;
  productionAdditionalDiff: number;
  qSentCount: number;
  wranglerGracefulTeardownPathCompleted: boolean;
  ownedProcessInventoryClean: boolean;
  cleanupFailed: boolean;
  temporaryConfigRemoved: boolean;
  temporaryTokenFileRemoved: boolean;
  productionConfigChanged: boolean;
  classification: string;
};

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const readSummary = () => JSON.parse(fs.readFileSync(SUMMARY, "utf8")) as Summary;

function validateAudit() {
  expect(sha(fs.readFileSync(SUMMARY))).toBe(EXPECTED.summarySha256);
  const summary = readSummary();
  expect(summary).toMatchObject({
    mode: "face_geometry_openness_open_anchor_live",
    branch: "main",
    head: EXPECTED.head,
    sourceRubricSha256: EXPECTED.rubricSha256,
    faceGeometryPromptSha256: EXPECTED.promptSha256,
    faceGeometrySchemaSha256: EXPECTED.schemaSha256,
    faceGeometryContract: { lateralGuard: 0.65, compactMax: 0.34, openMin: 0.68 },
    startupAttempts: 1,
    healthAttempts: 1,
    health: { status: "passed", httpStatus: 200, body: { providerCalls: 0 } },
    qSentCount: 1,
    wranglerGracefulTeardownPathCompleted: true,
    ownedProcessInventoryClean: true,
    cleanupFailed: false,
    temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true,
    productionConfigChanged: false,
    packageManagerCalls: 0,
    productionAdditionalDiff: 0,
    classification: "BLOCKED: production primary did not yield a valid portraitRegion for headscarf-color-blocks",
  });
  expect(summary.selectedCases).toEqual([{ id: "headscarf-color-blocks", photoId: -1,
    expectedSha256: EXPECTED.sourceSha256, expectedBytes: 197_802 }]);
  expect(summary.frozenSourcePreflight).toMatchObject({
    sourceClass: "frozen_reviewed_derived_artifact",
    lineage: "VERIFIED_DERIVED_ARTIFACT",
    originalRawBytesAvailable: false,
    label: { eyeOpenness: "open" },
    labelProvenance: "manual_source_review",
    labelFrozenBeforeProvider: true,
    providerResultsConsulted: false,
    geometryResultsConsulted: false,
    payloadSha256: EXPECTED.frozenPayloadSha256,
  });
  expect(summary.calls).toMatchObject({ sourceReads: 1, fileHashChecks: 1, rgbaHashChecks: 1,
    base64Preparations: 1, jpegOrPngTransmissions: 1, primaryPosts: 1,
    faceCropPreparations: 0, geometryPosts: 0 });
  expect(summary.primaryProviderCalls).toMatchObject({ geminiStarted: 1, geminiCompleted: 1,
    geminiFailed: 0, gemmaStarted: 1, gemmaCompleted: 0, gemmaFailed: 0, retry: 0 });
  expect(summary.geometryProviderCalls).toBeNull();
  expect(summary.geometryResults).toEqual([]);
  expect(summary.openAnchor).toBeNull();
  expect(Object.values(summary.prohibited).every(value => value === 0)).toBe(true);
  const primary = summary.primaryResults[0];
  expect(primary).toMatchObject({ httpStatus: 200, ok: false, attempts: 2,
    failure: { reason: "provider_unavailable", detail: null } });
  expect(primary.providerSequence).toMatchObject([
    { provider: "gemini", outcome: "started" },
    { provider: "gemini", outcome: "failed", httpStatus: 503, providerStatus: "UNAVAILABLE",
      fallbackEligible: true, fallbackReason: "provider_failure" },
    { provider: "workers_ai", outcome: "started" },
    { provider: "workers_ai", outcome: "failed", httpStatus: 504, providerStatus: "DEADLINE_EXCEEDED" },
  ]);
  return { summary, primary };
}

it("validates the blocked open-anchor live audit without treating provider failure as geometry evidence", () => {
  const { summary } = validateAudit();
  expect(summary.calls.geometryPosts).toBe(0);
  expect(summary.openAnchor).toBeNull();
});

it.skipIf(!BUILD)("writes secret-safe blocked open-anchor review artifacts", () => {
  const { summary, primary } = validateAudit();
  const write = (name: string, body: unknown) => fs.writeFileSync(path.join(ROOT, name),
    `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" });
  write("preflight.json", {
    head: summary.head, branch: summary.branch, sourceRubricSha256: summary.sourceRubricSha256,
    promptSha256: summary.faceGeometryPromptSha256, schemaSha256: summary.faceGeometrySchemaSha256,
    contract: summary.faceGeometryContract, source: summary.selectedCases[0], frozen: summary.frozenSourcePreflight,
  });
  write("source-verification.json", {
    sourceClass: "frozen_reviewed_derived_artifact", fileSha256: EXPECTED.sourceSha256,
    decodedRgbaSha256: EXPECTED.sourceRgbaSha256, bytes: 197_802, dimensions: { width: 270, height: 308 },
    sourceReads: summary.calls.sourceReads, fileHashChecks: summary.calls.fileHashChecks,
    rgbaHashChecks: summary.calls.rgbaHashChecks,
  });
  write("primary-localization.json", {
    caseId: "headscarf-color-blocks", result: "failed_before_valid_portrait_region",
    httpStatus: primary.httpStatus, elapsedMs: primary.elapsedMs, attempts: primary.attempts,
    providerSequence: primary.providerSequence, failure: primary.failure,
  });
  write("crop-verification.json", { status: "not_attempted", reason: "no_valid_fresh_portrait_region" });
  write("geometry-result.json", { status: "not_attempted", providerCalls: 0, reason: "geometry_condition_not_met" });
  write("high-boundary-evidence.json", {
    normal: { caseId: "wavy-open-blazer", score: 0.6, tier: "TIER_A_NORMAL_ANCHOR" },
    open: { caseId: "headscarf-color-blocks", score: null, tier: null },
    classification: "HIGH_BOUNDARY_STILL_UNIDENTIFIABLE", thresholdChanged: false,
  });
  write("three-class-state.json", {
    narrow: 0.5, normal: 0.6, open: null, lowFeasibleInterval: "(0.50, 0.60)",
    highFeasibleInterval: null, classification: "THREE_CLASS_ORDER_NOT_ESTABLISHED",
  });
  write("plan-replay.json", { status: "not_attempted", reason: "no_face_geometry_result" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# OPEN eye-openness anchor live audit\n\n` +
    `- Frozen source hashes and manual open label passed preflight.\n` +
    `- Protected health passed before the source was read.\n` +
    `- Gemini returned 503 UNAVAILABLE and was fallback eligible; Gemma then reached the 504 deadline.\n` +
    `- No valid portraitRegion was produced, so production crop generation, geometry, threshold comparison, and plan replay were not attempted.\n` +
    `- Remote startup 1, health 1, primary POST 1, geometry POST 0, retry 0; literal q exactly once and cleanup passed.\n` +
    `- No production config/source, prompt, schema, thresholds, guard, validator, renderer, or layout was changed.\n\n` +
    `BLOCKED: production primary did not yield a valid portraitRegion for headscarf-color-blocks\n`, { flag: "wx" });
});
