/** Bounded two-slot owner, using existing checkpoint/lifecycle infrastructure. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { decodeImage } from "../../src/png";
import { accountingOf, readLatestAuditCheckpoint } from "../primaryAuditRunnerSupport";
import { APERTURE_INPUTS } from "./eyeAperturePilotContract";
import { APERTURE_CROP_PATHS } from "./eyeAperturePilot";
import { EYE_APERTURE_V2_VERSION, type EyeApertureV2Observation } from "./eyeApertureV2Prototype";
import { APERTURE_V2_OPTIONS, apertureV2RequestIdentity, acceptedV2Observation, v2Measurements, safeV2Errors, safeV2Trace,
  type runExperimentalApertureV2, type V2Measurements } from "./eyeApertureV2LiveContract";

export const APERTURE_V2_LIVE_ROOT = path.resolve("evaluation-artifacts/eye-aperture-v2-first-live-check-20260926-001");
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export async function prepareApertureV2Live() {
  const implementation = JSON.parse(fs.readFileSync("evaluation-artifacts/eye-aperture-v2-central-section-implementation-20260926-001/v2-contract.json", "utf8"));
  const sourceSha256 = sha(fs.readFileSync("test/audit/eyeApertureV2Prototype.ts"));
  if (sourceSha256 !== implementation.sourceSha256) throw new Error("aperture_v2_prototype_changed");
  const references = ["evaluation-artifacts/v4-wavy-saved-face-crop-geometry-live-20260925-001/summary.json",
    "evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002/summary.json"];
  const inputs = await Promise.all(APERTURE_CROP_PATHS.map(async (file, i) => {
    const input = i as 0 | 1, expected = APERTURE_INPUTS[input], bytes = fs.readFileSync(file);
    if (sha(bytes) !== expected.sha256 || bytes.length !== expected.bytes) throw new Error("aperture_v2_crop_identity_mismatch");
    const decoded = await decodeImage(bytes);
    if (decoded.width !== expected.widthPx || decoded.height !== expected.heightPx) throw new Error("aperture_v2_crop_dimensions_mismatch");
    const saved = await readLatestAuditCheckpoint(path.resolve(references[input]));
    const snapshot = saved?.snapshot as Record<string, Record<string, unknown>> | undefined;
    const source = snapshot?.[input === 0 ? "savedV4FaceGeometry" : "v4Open"];
    if (!saved || source?.cropSha256 !== expected.sha256 || source.providerShapeValid !== true || source.semanticValid !== true)
      throw new Error("aperture_v2_crop_provenance_mismatch");
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const identity = await apertureV2RequestIdentity(dataUrl, input);
    if (identity.schemaSha256 !== implementation.schemaSha256) throw new Error("aperture_v2_schema_changed");
    return { dataUrl, metadata: { ...expected, decodedRgbaSha256: sha(decoded.rgba),
      provenanceCheckpointSequence: saved.sequence, provenanceCheckpointSha256: saved.snapshotSha256, requestIdentity: identity } };
  }));
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { inputs, sourceSha256, workingTree: { head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"),
    status: git("status", "--short"), trackedDiffSha256: sha(git("diff", "--no-ext-diff", "--binary")) },
    fixedHashes: Object.fromEntries(["test/audit/eyeAperturePrototype.ts", "test/audit/eyeApertureV2Prototype.ts",
      ...fs.readdirSync("src", { recursive: true }).map(String).filter(p => fs.statSync(path.join("src", p)).isFile()).map(p => path.join("src", p)), "wrangler.jsonc"]
      .map(file => [file, sha(fs.readFileSync(file))])) };
}
type Outcome = Awaited<ReturnType<typeof runExperimentalApertureV2>>;
export type V2Slot = { id: string; input: 0 | 1; requestRunId: string; cropSha256: string;
  dimensions: { widthPx: number; heightPx: number }; requestIdentity: Awaited<ReturnType<typeof apertureV2RequestIdentity>>;
  status: "not_attempted" | "intent_saved" | "post_invoked" | "returned" | "transport_unobserved";
  postInvoked: boolean; httpStatus: number | null; elapsedMs: number | null;
  accounting: ReturnType<typeof accountingOf> | null; outcome: Omit<Outcome, "accepted"> | null;
  accepted: EyeApertureV2Observation | null; derived: V2Measurements | null };
export function createApertureV2State(p: Awaited<ReturnType<typeof prepareApertureV2Live>>) {
  return { runId: randomBytes(16).toString("hex"), contractVersion: EYE_APERTURE_V2_VERSION,
    executionMode: "remote_observation", workingTree: p.workingTree, fixedHashes: p.fixedHashes,
    options: APERTURE_V2_OPTIONS, sourceSha256: p.sourceSha256, inputs: p.inputs.map(i => i.metadata),
    hashDomains: { prompt: "final prompt UTF-8 SHA-256, includes caller dimension suffix", schema: "UTF-8 JSON.stringify(responseSchema)", wire: "UTF-8 JSON.stringify(native_binding_input)", source: "exact prototype file bytes" },
    sourceLabelsSent: false, posts: 0, retry: 0, dispatchAccounting: "known", stoppedReason: null as string | null,
    classification: "not_started", diskRecovery: false, quantitativeLandmarkAccuracy: "NOT_MEASURED", repeatability: "NOT_TESTED", populationGeneralization: "NOT_TESTED",
    slots: ([0, 1] as const).map((input): V2Slot => ({ id: input === 0 ? "NORMAL-1" : "OPEN-1", input,
      requestRunId: randomBytes(16).toString("hex"), cropSha256: APERTURE_INPUTS[input].sha256,
      dimensions: { widthPx: APERTURE_INPUTS[input].widthPx, heightPx: APERTURE_INPUTS[input].heightPx },
      requestIdentity: p.inputs[input].metadata.requestIdentity, status: "not_attempted", postInvoked: false,
      httpStatus: null, elapsedMs: null, accounting: null, outcome: null, accepted: null, derived: null })) };
}
export type ApertureV2State = ReturnType<typeof createApertureV2State>;
type Post = (body: { imageDataUrl: string; batchRunId: string; slot: number }, id: string) => Promise<{ status: number; body: unknown }>;
export async function runApertureV2Batch(state: ApertureV2State, images: string[], post: Post, persist: (event: string) => Promise<void>) {
  if (state.posts || state.slots.some(s => s.status !== "not_attempted")) throw new Error("aperture_v2_run_consumed");
  for (const slot of state.slots) {
    if (state.posts >= 2) throw new Error("aperture_v2_budget_exhausted");
    if (JSON.stringify(await apertureV2RequestIdentity(images[slot.input], slot.input)) !== JSON.stringify(slot.requestIdentity))
      throw new Error("aperture_v2_wire_changed");
    slot.status = "intent_saved"; await persist(`v2RequestIntent:${slot.input}`);
    slot.status = "post_invoked"; slot.postInvoked = true; state.posts++; const started = Date.now();
    let response: Awaited<ReturnType<Post>>;
    try { response = await post({ imageDataUrl: images[slot.input], batchRunId: state.runId, slot: slot.input }, slot.requestRunId); }
    catch {
      slot.status = "transport_unobserved"; slot.elapsedMs = Date.now() - started; state.dispatchAccounting = "unknown";
      state.stoppedReason = "dispatch_or_result_unobserved"; await persist("v2TransportUnobserved"); break;
    }
    slot.status = "returned"; slot.httpStatus = response.status; slot.elapsedMs = Date.now() - started;
    const body = response.body as Partial<Outcome> & { auditState?: unknown; runId?: string; batchRunId?: string; slot?: number };
    slot.accounting = accountingOf(body?.auditState, slot.requestRunId);
    if (slot.accounting.dispatch !== "known" || slot.accounting.providerCalls.geminiStarted !== 0
      || slot.accounting.providerCalls.gemmaStarted !== 1 || slot.accounting.providerCalls.retry !== 0
      || body.runId !== slot.requestRunId || body.batchRunId !== state.runId || body.slot !== slot.input) {
      state.dispatchAccounting = "unknown"; state.stoppedReason = "accounting_or_identity_invalid"; await persist("v2AccountingFailure"); break;
    }
    if (JSON.stringify(body.requestIdentity) !== JSON.stringify(slot.requestIdentity)) {
      state.stoppedReason = "remote_wire_identity_mismatch"; await persist("v2IdentityFailure"); break;
    }
    // Copy endpoint allowlist only; do not retain arbitrary error text or rejected numeric payloads.
    slot.outcome = { requestIdentity: slot.requestIdentity, providerOutcome: body.providerOutcome === "returned" ? "returned" : "failed",
      providerHttpStatus: null, diagnosticStatus: typeof body.diagnosticStatus === "number" ? body.diagnosticStatus : null,
      providerStatus: typeof body.providerStatus === "string" && /^[A-Za-z0-9_]{1,64}$/.test(body.providerStatus) ? body.providerStatus : null,
      elapsedMs: typeof body.elapsedMs === "number" ? body.elapsedMs : slot.elapsedMs,
      trace: safeV2Trace(body.trace), shapeValid: body.shapeValid === true ? true : body.shapeValid === false ? false : null,
      semanticContractValid: body.semanticContractValid === true ? true : body.semanticContractValid === false ? false : null,
      shapeErrors: safeV2Errors(body.shapeErrors), semanticErrors: safeV2Errors(body.semanticErrors) };
    if (response.status !== 200 || body.providerOutcome !== "returned") state.stoppedReason = "request_or_execution_failed";
    else if (body.shapeValid !== true || body.semanticContractValid !== true) state.stoppedReason = "output_contract_failed";
    else {
      const checked = acceptedV2Observation(body.accepted, slot.input);
      if (!checked) state.stoppedReason = "accepted_revalidation_failed";
      else {
        slot.accepted = checked; await persist(`v2AcceptedEvidence:${slot.input}`);
        slot.derived = v2Measurements(checked, slot.input);
      }
    }
    await persist(`v2DerivedOutcome:${slot.input}`);
    if (state.stoppedReason) break; // Canary-first: even shape or semantic rejection stops OPEN.
  }
  state.classification = state.stoppedReason === "output_contract_failed" ? "V2_OUTPUT_CONTRACT_FAILED"
    : state.stoppedReason === "request_or_execution_failed" ? "V2_REQUEST_OR_EXECUTION_FAILED"
    : state.stoppedReason ? `BLOCKED: ${state.stoppedReason}`
    : state.slots.some(s => s.derived?.measurementAvailable) ? "V2_MEASURABLE_OUTPUT_OBSERVED" : "V2_VALID_ABSTENTION_ONLY";
  await persist("v2BatchComplete");
}
export function verifyApertureV2Recovery(disk: ApertureV2State, memory: ApertureV2State) {
  if (JSON.stringify(disk) !== JSON.stringify(memory) || disk.contractVersion !== EYE_APERTURE_V2_VERSION || disk.posts > 2 || disk.retry !== 0)
    throw new Error("aperture_v2_checkpoint_identity_failed");
  for (const [i, slot] of disk.slots.entries()) {
    if (slot.input !== i || slot.cropSha256 !== APERTURE_INPUTS[slot.input].sha256
      || slot.dimensions.widthPx !== APERTURE_INPUTS[slot.input].widthPx || slot.dimensions.heightPx !== APERTURE_INPUTS[slot.input].heightPx
      || JSON.stringify(slot.requestIdentity) !== JSON.stringify(disk.inputs[slot.input].requestIdentity)) throw new Error("aperture_v2_slot_identity_failed");
    if (slot.accepted && (JSON.stringify(acceptedV2Observation(slot.accepted, slot.input)) !== JSON.stringify(slot.accepted)
      || JSON.stringify(v2Measurements(slot.accepted, slot.input)) !== JSON.stringify(slot.derived))) throw new Error("aperture_v2_recovered_values_invalid");
    if (!slot.accepted && slot.derived) throw new Error("aperture_v2_derived_without_evidence");
  }
  return true;
}
