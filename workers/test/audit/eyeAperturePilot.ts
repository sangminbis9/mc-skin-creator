import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { decodeImage } from "../../src/png";
import { accountingOf, readLatestAuditCheckpoint } from "../primaryAuditRunnerSupport";
import { APERTURE_INPUTS, APERTURE_OPTIONS, apertureRequestIdentity, type runExperimentalAperture } from "./eyeAperturePilotContract";
import { deriveEyeApertureRatio, EYE_APERTURE_CONTRACT_VERSION, validateEyeApertureObservation, type EyeApertureObservation } from "./eyeAperturePrototype";

export const APERTURE_PILOT_ROOT = path.resolve("evaluation-artifacts/experimental-eye-aperture-two-crop-pilot-20260926-001");
export const APERTURE_CROP_PATHS = [
  "evaluation-artifacts/v4-saved-localization-crop-readiness-20260925-001/face-crop.png",
  "evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002/face-crop.png",
] as const;
const REFERENCES = [
  "evaluation-artifacts/v4-wavy-saved-face-crop-geometry-live-20260925-001/summary.json",
  "evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002/summary.json",
];
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const APERTURE_SLOT_PLAN = [
  { id: "NORMAL-1", input: 0, replicate: 1 }, { id: "OPEN-1", input: 1, replicate: 1 },
  { id: "NORMAL-2", input: 0, replicate: 2 }, { id: "OPEN-2", input: 1, replicate: 2 },
] as const;

export async function prepareAperturePilot() {
  const prototypeSourceSha256 = sha(fs.readFileSync("test/audit/eyeAperturePrototype.ts"));
  if (prototypeSourceSha256 !== "ce0389a765130b74c53ad79b4f4e7df28ccdf442da871b3b1300d7eb5971a1ca")
    throw new Error("aperture_prototype_changed");
  const inputs = await Promise.all(APERTURE_CROP_PATHS.map(async (file, index) => {
    const input = index as 0 | 1, expected = APERTURE_INPUTS[input];
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== expected.sha256 || bytes.length !== expected.bytes) throw new Error("aperture_crop_hash_mismatch");
    const decoded = await decodeImage(bytes);
    if (decoded.width !== expected.widthPx || decoded.height !== expected.heightPx) throw new Error("aperture_crop_dimensions_mismatch");
    const checkpoint = await readLatestAuditCheckpoint(path.resolve(REFERENCES[input]));
    const snapshot = checkpoint?.snapshot as Record<string, unknown> | undefined;
    const saved = snapshot?.[input === 0 ? "savedV4FaceGeometry" : "v4Open"] as Record<string, unknown> | undefined;
    if (!checkpoint || saved?.cropSha256 !== expected.sha256 || saved.providerShapeValid !== true || saved.semanticValid !== true)
      throw new Error("aperture_crop_provenance_mismatch");
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    return { dataUrl, metadata: { ...expected, decodedRgbaSha256: sha(decoded.rgba),
      sourceCheckpointSequence: checkpoint.sequence, sourceCheckpointSha256: checkpoint.snapshotSha256,
      requestIdentity: await apertureRequestIdentity(dataUrl, input) } };
  }));
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
  return { inputs, prototypeSourceSha256,
    workingTree: { head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"),
      status: git("status", "--short"), trackedDiffSha256: sha(git("diff", "--no-ext-diff", "--binary")),
      stagedDiffSha256: sha(git("diff", "--cached", "--no-ext-diff", "--binary")) },
    productionHashes: Object.fromEntries(["src/analysis.ts", "src/faceIdentityGeometry.ts", "src/generate.ts", "src/gemini.ts", "src/identityQuantization.ts", "wrangler.jsonc"]
      .map(file => [file, sha(fs.readFileSync(file))])) };
}

export function aperturePixelMeasurements(value: EyeApertureObservation) {
  const derived = deriveEyeApertureRatio(value);
  const perEye = (side: "left" | "right") => {
    const eye = value[side], ratio = derived[side];
    if (ratio === null) return { status: "not_measurable" as const, reason: value.pose === "unsupported" ? "unsupported_pose" : eye.visibility,
      confidence: eye.confidence, points: null, widthPx: null, aperturePx: null, ratio: null, apertureLine: null };
    const px = (p: typeof eye.outerCorner) => ({ x: p.x! * value.cropWidthPx, y: p.y! * value.cropHeightPx });
    const points = { outerCorner: px(eye.outerCorner), innerCorner: px(eye.innerCorner), upperLid: px(eye.upperLid), lowerLid: px(eye.lowerLid) };
    const dx = points.innerCorner.x - points.outerCorner.x, dy = points.innerCorner.y - points.outerCorner.y;
    const widthPx = Math.hypot(dx, dy), sign = dx >= 0 ? 1 : -1;
    const normal = { x: sign * -dy / widthPx, y: sign * dx / widthPx };
    const aperturePx = (points.lowerLid.x - points.upperLid.x) * normal.x + (points.lowerLid.y - points.upperLid.y) * normal.y;
    if (Math.abs(aperturePx / widthPx - ratio) > 1e-12) throw new Error("aperture_derived_formula_mismatch");
    return { status: "measured" as const, reason: null, confidence: eye.confidence, points, widthPx, aperturePx, ratio,
      apertureLine: { from: points.upperLid, to: { x: points.upperLid.x + normal.x * aperturePx, y: points.upperLid.y + normal.y * aperturePx } } };
  };
  return { left: perEye("left"), right: perEye("right"), mean: derived.mean };
}

type Result = Awaited<ReturnType<typeof runExperimentalAperture>>;
export type ApertureSlot = {
  id: string; ordinal: number; input: 0 | 1; replicate: number; requestRunId: string;
  cropSha256: string; dimensions: { widthPx: number; heightPx: number };
  requestIdentity: Awaited<ReturnType<typeof apertureRequestIdentity>>;
  status: "not_attempted" | "intent_saved" | "post_invoked" | "returned" | "transport_unobserved";
  postInvoked: boolean; httpStatus: number | null; elapsedMs: number | null;
  accounting: ReturnType<typeof accountingOf> | null;
  outcome: Omit<Result, "accepted"> | null;
  accepted: EyeApertureObservation | null; derived: ReturnType<typeof aperturePixelMeasurements> | null;
};
export function createAperturePilotState(preflight: Awaited<ReturnType<typeof prepareAperturePilot>>) {
  return { runId: randomBytes(16).toString("hex"), contractVersion: EYE_APERTURE_CONTRACT_VERSION,
    workingTree: preflight.workingTree,
    options: APERTURE_OPTIONS, prototypeSourceSha256: preflight.prototypeSourceSha256,
    productionHashes: preflight.productionHashes, inputs: preflight.inputs.map(input => input.metadata),
    localInputAccounting: { frozenPngReads: 2, fileHashChecks: 2, decodedRgbaHashChecks: 2, base64Preparations: 2 },
    measurementDefinition: { eyeSides: "viewer-left/right", axes: "x * cropWidthPx; y * cropHeightPx",
      width: "Euclidean outer-to-inner corner chord in pixels",
      aperture: "lower-minus-upper lid separation projected on positive-image-y chord normal in pixels",
      ratio: "aperturePx / widthPx", location: "central same along-chord position; actual visible lid boundaries",
      unknown: "unknown/occluded/blink/unsupported: null coordinates, zero confidence; no invented ratio",
      summary: "mean only if both eyes measured" },
    lateCompletion: "unknown_unless_observed_in_response", inferenceCancellation: "unknown", billing: "unknown",
    hashDomains: { prompt: "final_prompt_utf8_sha256", schema: "JSON.stringify(responseSchema)", wire: "JSON.stringify(native_binding_input)" },
    reference: { mode: "QUALITATIVE_ONLY", method: "model_assisted_source_only_visual_review_before_landmark_responses",
      independentHumanGroundTruth: false, quantitativeAccuracy: "NOT_MEASURED",
      knownHistoricalScalarResults: true,
      targets: ["visible medial/lateral eye corners, not eyeliner tips", "central upper/lower eyelid margins, not brow/lash extremities"],
      uncertainty: "NORMAL eyeliner and small eye pixels obscure precise edges; OPEN clearer boundaries, but no independent numeric reference",
      sourceLabelsSent: false, sourceSpecificDimensionSuffixApproved: true },
    summaryPolicy: "per-eye first; binocular mean only when both eyes measured; retain both planned repeats; no selection or threshold",
    cachePolicy: "native binding options unchanged; cache-hit and independent inference cannot be confirmed from current response contract",
    posts: 0, retry: 0, dispatchAccounting: "known", stoppedReason: null as string | null,
    classification: "not_started", diskRecovery: false,
    slots: APERTURE_SLOT_PLAN.map((slot, ordinal): ApertureSlot => ({ ...slot, ordinal, requestRunId: randomBytes(16).toString("hex"),
      cropSha256: APERTURE_INPUTS[slot.input].sha256,
      dimensions: { widthPx: APERTURE_INPUTS[slot.input].widthPx, heightPx: APERTURE_INPUTS[slot.input].heightPx },
      requestIdentity: preflight.inputs[slot.input].metadata.requestIdentity,
      status: "not_attempted", postInvoked: false, httpStatus: null, elapsedMs: null, accounting: null,
      outcome: null, accepted: null, derived: null })),
  };
}
export type AperturePilotState = ReturnType<typeof createAperturePilotState>;
type Post = (body: { imageDataUrl: string; pilotRunId: string; slot: number }, requestRunId: string) => Promise<{ status: number; body: unknown }>;

/** The four slots are fixed before observations; a failed slot is never replaced. */
export async function runAperturePilot(state: AperturePilotState, dataUrls: string[], post: Post, persist: (event: string) => Promise<void>) {
  if (state.posts !== 0 || state.slots.some(slot => slot.status !== "not_attempted")) throw new Error("aperture_pilot_already_consumed");
  for (const slot of state.slots) {
    if (state.posts >= 4) throw new Error("aperture_budget_exhausted");
    if (JSON.stringify(await apertureRequestIdentity(dataUrls[slot.input], slot.input)) !== JSON.stringify(slot.requestIdentity))
      throw new Error("aperture_request_identity_changed");
    slot.status = "intent_saved"; await persist(`apertureIntent:${slot.ordinal}`);
    const started = Date.now();
    slot.status = "post_invoked"; slot.postInvoked = true; state.posts++;
    let response: Awaited<ReturnType<Post>>;
    try { response = await post({ imageDataUrl: dataUrls[slot.input], pilotRunId: state.runId, slot: slot.ordinal }, slot.requestRunId); }
    catch {
      slot.elapsedMs = Date.now() - started; slot.status = "transport_unobserved";
      state.dispatchAccounting = "unknown"; state.stoppedReason = "provider_dispatch_or_result_unobserved";
      await persist(`apertureTransportUnobserved:${slot.ordinal}`); break;
    }
    slot.status = "returned"; slot.httpStatus = response.status; slot.elapsedMs = Date.now() - started;
    const body = response.body as Partial<Result> & { auditState?: unknown; slot?: number; runId?: string; pilotRunId?: string };
    slot.accounting = accountingOf(body?.auditState, slot.requestRunId);
    if (slot.accounting.dispatch !== "known" || slot.accounting.providerCalls.geminiStarted !== 0
      || slot.accounting.providerCalls.gemmaStarted !== 1 || body.slot !== slot.ordinal
      || body.runId !== slot.requestRunId || body.pilotRunId !== state.runId) {
      state.dispatchAccounting = "unknown"; state.stoppedReason = "provider_accounting_invalid";
      await persist(`apertureAccountingUnknown:${slot.ordinal}`); break;
    }
    if (JSON.stringify(body.requestIdentity) !== JSON.stringify(slot.requestIdentity)) {
      state.stoppedReason = "remote_request_hash_mismatch"; await persist(`apertureIdentityFailure:${slot.ordinal}`); break;
    }
    const safeErrors = (errors: unknown): string[] => Array.isArray(errors) ? errors.map(error => typeof error === "string"
      && /^eyeAperture(?:\.[A-Za-z0-9_]+)*:[A-Za-z0-9_]+$/.test(error) ? error : "eyeAperture:unclassified_validation_error") : [];
    slot.outcome = { requestIdentity: slot.requestIdentity,
      providerOutcome: body.providerOutcome === "returned" ? "returned" : "failed",
      providerHttpStatus: typeof body.providerHttpStatus === "number" ? body.providerHttpStatus : null,
      providerStatus: typeof body.providerStatus === "string" && /^[A-Za-z0-9_]{1,64}$/.test(body.providerStatus) ? body.providerStatus : null,
      elapsedMs: typeof body.elapsedMs === "number" ? body.elapsedMs : 0, requestRejected: body.requestRejected === true,
      providerShapeValid: body.providerShapeValid === true ? true : body.providerShapeValid === false ? false : null,
      shapeErrors: safeErrors(body.shapeErrors), semanticValid: body.semanticValid === true ? true : body.semanticValid === false ? false : null,
      semanticErrors: safeErrors(body.semanticErrors), cacheHit: null, independentInferenceConfirmed: false };
    if (body.accepted && body.providerShapeValid === true && body.semanticValid === true) {
      const checked = validateEyeApertureObservation(body.accepted, slot.dimensions);
      if (!checked.ok) { state.stoppedReason = "accepted_landmark_revalidation_failed"; await persist(`apertureRecoveryGateFailure:${slot.ordinal}`); break; }
      slot.accepted = structuredClone(checked.value);
      await persist(`apertureLandmarksAccepted:${slot.ordinal}`);
      slot.derived = aperturePixelMeasurements(slot.accepted);
    }
    await persist(`apertureOutcome:${slot.ordinal}`);
    if (body.requestRejected) { state.stoppedReason = "experimental_request_rejected"; break; }
  }
  state.classification = state.stoppedReason === "experimental_request_rejected" ? "EYE_APERTURE_REMOTE_CONTRACT_REJECTED"
    : state.slots.every(slot => slot.status === "returned") && !state.stoppedReason ? "EYE_APERTURE_PILOT_COMPLETED" : "EYE_APERTURE_PILOT_PARTIAL";
  await persist("apertureBatchCompleted");
}

export function verifyApertureRecovery(state: AperturePilotState, memory: AperturePilotState) {
  if (JSON.stringify(state) !== JSON.stringify(memory)) throw new Error("aperture_checkpoint_memory_mismatch");
  for (const [index, slot] of state.slots.entries()) {
    if (slot.ordinal !== index || slot.id !== APERTURE_SLOT_PLAN[index].id || slot.cropSha256 !== APERTURE_INPUTS[slot.input].sha256)
      throw new Error("aperture_slot_identity_mismatch");
    if (slot.accepted) {
      if (!validateEyeApertureObservation(slot.accepted, slot.dimensions).ok
        || JSON.stringify(aperturePixelMeasurements(slot.accepted)) !== JSON.stringify(slot.derived)) throw new Error("aperture_recovered_landmark_invalid");
    }
  }
  return true;
}
