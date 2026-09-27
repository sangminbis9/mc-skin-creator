import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { imageIdentity, E2E_MARKER } from "./currentDefaultE2E";
import { base64ToBytes, decodeImage, decodePng, encodePng } from "../../src/png";
import { validateFinalAtlas } from "../../src/skinPost";
import { renderSkinViews } from "../../src/skinRender";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT, COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } from "../../src/compactPhotoAnalysisV3";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT, GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } from "../../src/gemmaPhotoAnalysis";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA } from "../../src/faceIdentityGeometry";
import { createIdentityCrops } from "../../src/generate";
import type { PhotoAnalysis } from "../../src/analysis";
import { projectE2EGateTrace, classifyE2E409, type E2EGateTrace } from "./currentDefaultE2EGateTrace";

export const E2E_ROOT = path.resolve("evaluation-artifacts/current-default-v3-e2e-baseline-20260927-008");
const SOURCE = "evaluation-artifacts/generalization-20260905/sources/29002888.jpg";
const SOURCE_SHA = "0c5a890f0e54275e2851a66f5f6ba92578c0d4feabf83c826aafa57cbf7a1d5a";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const suffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";

export async function verifyPreparedE2E(value: {
  prepared: { analysisDataUrl: string; generationDataUrl: string };
  selectedQualities: { width: number; height: number; quality: number; chars: number }[];
  userAgent: string; sourceSha256: string; sourceBytes: number; preprocessingSourceSha256: string;
}) {
  const source = fs.readFileSync(SOURCE);
  if (sha(source) !== SOURCE_SHA || source.length !== 204067 || value.sourceSha256 !== SOURCE_SHA
    || value.sourceBytes !== source.length || value.preprocessingSourceSha256 !== sha(fs.readFileSync("../src/lib/imageQuality.ts")))
    throw new Error("e2e_source_preprocess_identity_mismatch");
  const decoded = await decodeImage(source);
  const analysis = await imageIdentity(value.prepared.analysisDataUrl);
  const generation = await imageIdentity(value.prepared.generationDataUrl);
  if (analysis.width !== 597 || analysis.height !== 896 || generation.width !== 299 || generation.height !== 448
    || !value.prepared.analysisDataUrl.startsWith("data:image/jpeg;base64,")
    || !value.prepared.generationDataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("e2e_derivative_contract_mismatch");
  for (const item of [analysis, generation]) {
    const quality = value.selectedQualities.find(q => q.width === item.width && q.height === item.height && q.chars === item.dataUrlChars);
    if (!quality || ![0.85, 0.75, 0.6].includes(quality.quality)) throw new Error("e2e_quality_observation_missing");
  }
  return { payload: { image: value.prepared.generationDataUrl, analysisImage: value.prepared.analysisDataUrl }, metadata: {
    source: { path: SOURCE, bytes: source.length, sha256: SOURCE_SHA, width: decoded.width, height: decoded.height,
      decodedRgbaSha256: sha(decoded.rgba), decodedHashProvenance: "computed_this_preflight", provenance: "existing_reviewed_Pexels_29002888" },
    analysis: { ...analysis, quality: value.selectedQualities.find(q => q.width === analysis.width && q.chars === analysis.dataUrlChars)!.quality },
    generation: { ...generation, quality: value.selectedQualities.find(q => q.width === generation.width && q.chars === generation.dataUrlChars)!.quality },
    browserRuntime: value.userAgent.slice(0, 240), preprocessingSourceSha256: value.preprocessingSourceSha256,
    byteFreezeScope: "this_actual_browser_runtime_output_only", rawOriginalTransmitted: false,
  } };
}
export async function prepareCurrentDefaultE2E() {
  if (fs.existsSync(E2E_ROOT)) throw new Error("e2e_fresh_root_required");
  const response = await fetch("http://127.0.0.1:59926/consume", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("e2e_browser_preprocessing_not_ready");
  const prepared = await verifyPreparedE2E(await response.json() as Parameters<typeof verifyPreparedE2E>[0]);
  const fixedFiles = ["wrangler.jsonc", "../src/lib/imageQuality.ts", "../src/lib/cloudflareAI.ts",
    ...fs.readdirSync("src", { recursive: true }).map(String).map(file => path.join("src", file)).filter(file => fs.statSync(file).isFile())];
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { ...prepared, fixedHashes: Object.fromEntries(fixedFiles.map(file => [file, sha(fs.readFileSync(file))])),
    workingTree: { head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), status: git("status", "--short") },
    contract: { version: "primary_compact_v3_legacy_suffix", primaryTimeoutMs: 45_000, geometryTimeoutMs: 25_000,
      geminiSchemaSha256: sha(JSON.stringify(COMPACT_PHOTO_ANALYSIS_V3_SCHEMA)),
      geminiPromptSha256: sha(COMPACT_PHOTO_ANALYSIS_V3_PROMPT + suffix),
      gemmaSchemaSha256: sha(JSON.stringify(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)),
      gemmaPromptSha256: sha(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT + suffix),
      geometrySchemaSha256: sha(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA)),
      geometryPromptSha256: sha(FACE_IDENTITY_GEOMETRY_PROMPT), lateralGuard: 0.65, compactMax: 0.34, openMin: 0.68 } };
}
export function createE2EState(preflight: Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>) {
  return { runId: randomBytes(16).toString("hex"), preprocessing: preflight.metadata, fixedHashes: preflight.fixedHashes,
    workingTree: preflight.workingTree, contract: preflight.contract, generationPosts: 0, providerRetry: 0,
    accounting: "not_attempted", httpStatus: null as number | null, elapsedMs: null as number | null,
    result: null as Record<string, unknown> | null, png: null as Record<string, unknown> | null,
    historicalComparison: null as Record<string, unknown> | null, cropReplay: null as Record<string, unknown> | null,
    e2eGateTrace: null as E2EGateTrace | null, gateBoundary: "unobserved",
    diskRecovery: false, classification: "not_started" };
}
export type E2EState = ReturnType<typeof createE2EState>;
export async function runCurrentDefaultE2E(state: E2EState, prepared: Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>,
  post: (payload: typeof prepared.payload, runId: string) => Promise<{ status: number; body: Record<string, unknown> }>,
  persist: (event: string) => Promise<void>, root: string) {
  if (state.generationPosts) throw new Error("e2e_generation_already_consumed");
  await persist("currentDefaultE2EGenerateIntent");
  state.generationPosts = 1; state.accounting = "unknown";
  await persist("currentDefaultE2EPostStarted");
  const at = Date.now();
  let response: Awaited<ReturnType<typeof post>>;
  try { response = await post(prepared.payload, state.runId); }
  catch { state.elapsedMs = Date.now() - at; state.classification = "BLOCKED: E2E response unobserved; provider accounting unknown";
    await persist("currentDefaultE2ETransportUnobserved"); return; }
  state.elapsedMs = Date.now() - at; state.httpStatus = response.status;
  const { skinPngBase64, e2eGateTrace, ...metadata } = response.body;
  // Persist the allowlisted rejection trace BEFORE the old success-envelope check.
  // Lost responses still remain unknown; this does not add a remote probe, retry or ledger.
  state.e2eGateTrace = projectE2EGateTrace(e2eGateTrace, response.status);
  if (state.e2eGateTrace) {
    state.gateBoundary = response.status === 409 ? classifyE2E409(state.e2eGateTrace) : "observed_non_409";
    await persist("currentDefaultE2EGateTraceCaptured");
  }
  if (metadata.marker !== E2E_MARKER || !Array.isArray(metadata.bindingAttempts)) {
    state.classification = "BLOCKED: E2E protected response/accounting unavailable";
    await persist("currentDefaultE2EInvalidEnvelope"); return;
  }
  state.accounting = "known";
  state.result = metadata;
  await persist("currentDefaultE2EResponseCaptured");
  if (typeof skinPngBase64 === "string") {
    const bytes = base64ToBytes(skinPngBase64);
    const atlas = await decodePng(bytes);
    const validation = validateFinalAtlas(atlas);
    const outputPath = path.join(root, "skin.png");
    fs.writeFileSync(outputPath, bytes, { flag: "wx" });
    const disk = fs.readFileSync(outputPath);
    if (sha(disk) !== sha(bytes)) throw new Error("e2e_png_disk_mismatch");
    const decodedDisk = await decodePng(disk);
    const alpha = new Set<number>(); for (let i = 3; i < atlas.rgba.length; i += 4) alpha.add(atlas.rgba[i]);
    state.png = { width: atlas.width, height: atlas.height, bytes: bytes.length, sha256: sha(bytes),
      decodedRgbaSha256: sha(atlas.rgba), alphaValues: [...alpha].sort((a, b) => a - b), validation,
      diskDecodePass: sha(decodedDisk.rgba) === sha(atlas.rgba), armModelMetadata: "not_exposed" };
    const historical = "evaluation-artifacts/face-geometry-production-live-20260914";
    const oldManifest = JSON.parse(fs.readFileSync(`${historical}/smoke.json`, "utf8"));
    if (oldManifest.source.sha256 === SOURCE_SHA) {
      const oldBytes = fs.readFileSync(`${historical}/skin.png`);
      if (sha(oldBytes) !== oldManifest.png.sha256) throw new Error("e2e_historical_png_hash_mismatch");
      const old = await decodePng(oldBytes); let changedPixels = 0;
      const changedRowBands = { headRows0to15: 0, torsoArmsLegsRows16to47: 0, lowerAtlasRows48to63: 0 };
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => old.rgba[p * 4 + c] !== atlas.rgba[p * 4 + c])) {
        changedPixels++; changedRowBands[p < 1024 ? "headRows0to15" : p < 3072 ? "torsoArmsLegsRows16to47" : "lowerAtlasRows48to63"]++;
      }
      state.historicalComparison = { comparisonStatus: "LIMITED", historicalSourceIdentityMatch: true,
        historicalCodeProvenanceKnown: false, historicalConfigProvenanceKnown: false,
        historicalSha256: sha(oldBytes), currentSha256: sha(bytes), changedPixels, changedRowBands,
        preprocessingSame: false, improvementOrRegression: "not_inferred" };
    }
    if (validation.ok) for (const view of renderSkinViews(atlas).filter(v => ["front", "back", "front_left_three_quarter"].includes(v.name)))
      fs.writeFileSync(path.join(root, `${view.name}.png`), await encodePng(view.image), { flag: "wx" });
    const diagnostics = metadata.diagnostics as { normalizedPrimary?: PhotoAnalysis; geometryInput?: { sha256: string } } | undefined;
    if (diagnostics?.normalizedPrimary && diagnostics.geometryInput) {
      const primary = diagnostics.normalizedPrimary;
      const crops = await createIdentityCrops(prepared.payload.analysisImage, primary.sourceSelection.portraitRegion, {
        hairVolume: primary.renderHints.hairVolume, hairTexture: primary.renderHints.hairTexture,
        overallHairLength: primary.renderHints.overallHairLength, sideHairAsymmetry: primary.renderHints.sideHairAsymmetry,
        headCovering: primary.fallbackFeatures.hat !== "none" || /headscarf|hood|hat/i.test(primary.observed.accessories),
      });
      if (crops) {
        const identity = await imageIdentity(crops.faceDataUrl);
        state.cropReplay = { evidenceMode: "offline_exact_production_helper_replay_after_request",
          actualWireCropSha256: diagnostics.geometryInput.sha256, replaySha256: identity.sha256,
          matchesActualWire: identity.sha256 === diagnostics.geometryInput.sha256,
          diagnostics: identity.sha256 === diagnostics.geometryInput.sha256 ? crops.diagnostics : null };
      }
    }
    state.classification = response.status === 200 && metadata.ok === true && validation.ok
      ? "CURRENT_DEFAULT_V3_E2E_BASELINE_ACQUIRED" : "CURRENT_DEFAULT_V3_E2E_FAILED";
  } else state.classification = "CURRENT_DEFAULT_V3_E2E_FAILED";
  await persist("currentDefaultE2EOutputSaved");
}
