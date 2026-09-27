import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { workersAiStructuredInput } from "../src/gemini";
import auditWorker from "./primaryFaceMeasurementAuditWorker";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { APERTURE_INPUTS } from "./audit/eyeAperturePilotContract";
import { prepareApertureV2Live, createApertureV2State, runApertureV2Batch, verifyApertureV2Recovery } from "./audit/eyeApertureV2Live";
import { APERTURE_V2_OPTIONS, apertureV2Request, apertureV2RequestIdentity, safeV2Errors, safeV2Trace } from "./audit/eyeApertureV2LiveContract";
import { buildEyeApertureV2Request, EYE_APERTURE_V2_VERSION, type EyeApertureV2Observation } from "./audit/eyeApertureV2Prototype";

let preflight: Awaited<ReturnType<typeof prepareApertureV2Live>>;
beforeAll(async () => { preflight = await prepareApertureV2Live(); });
afterEach(() => vi.unstubAllGlobals());
const id = () => randomBytes(16).toString("hex");
const fixture = (input: 0 | 1): EyeApertureV2Observation => ({ version: EYE_APERTURE_V2_VERSION,
  cropWidthPx: APERTURE_INPUTS[input].widthPx, cropHeightPx: APERTURE_INPUTS[input].heightPx, pose: "frontal",
  left: { visibility: "observed", outerCorner: { x: .2, y: .4 }, innerCorner: { x: .4, y: .4 }, upperLidOffsetPx: 1, lowerLidOffsetPx: 6, confidence: .9 },
  right: { visibility: "observed", outerCorner: { x: .8, y: .4 }, innerCorner: { x: .6, y: .4 }, upperLidOffsetPx: -2, lowerLidOffsetPx: 3, confidence: .8 } });
const abstain = () => ({ visibility: "unknown" as const, outerCorner: { x: null, y: null }, innerCorner: { x: null, y: null },
  upperLidOffsetPx: null, lowerLidOffsetPx: null, confidence: 0 });
function endpoint(responses: unknown[]) {
  const network = vi.fn(() => { throw new Error("external_network_forbidden"); }); vi.stubGlobal("fetch", network);
  let index = 0;
  const run = vi.fn(async (_model: string, _wire: unknown) => { void _model; void _wire; const r = responses[index++]; if (r instanceof Error) throw r;
    return { response: JSON.stringify(r) }; });
  const gateway = vi.fn(() => { throw new Error("primary_forbidden"); });
  const token = randomBytes(20).toString("hex");
  const env = { PRIMARY_AUDIT_TOKEN: token, AI: { run, gateway } } as unknown as Env & { PRIMARY_AUDIT_TOKEN: string };
  const post = async (body: unknown, runId: string) => {
    const response = await auditWorker.fetch(new Request("http://audit.invalid/experimental-eye-aperture-v2-audit", {
      method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": runId }, body: JSON.stringify(body) }), env);
    return { status: response.status, body: await response.json() };
  };
  return { run, gateway, network, env, post };
}
it("pins exact v2 module/crops/dimensions/wire without transmitting labels or using v1 prompt", async () => {
  for (const i of [0, 1] as const) {
    const source = preflight.inputs[i], d = APERTURE_INPUTS[i];
    const built = buildEyeApertureV2Request(source.dataUrl, d), request = apertureV2Request(source.dataUrl, i);
    expect(request.prompt).toBe(built.prompt); expect(request.responseSchema).toEqual(built.responseSchema);
    expect(request.imageDataUrls).toEqual([source.dataUrl]);
    expect(await apertureV2RequestIdentity(source.dataUrl, i)).toEqual(source.metadata.requestIdentity);
    const wire = workersAiStructuredInput(request, APERTURE_V2_OPTIONS.model);
    expect(wire).toMatchObject({ max_completion_tokens: 4096, chat_template_kwargs: { enable_thinking: false } });
    expect(JSON.stringify(wire)).not.toMatch(/NORMAL|OPEN|wavy|calibration-001|0\.50|eye_aperture_landmarks_v1/);
    expect(wire).not.toHaveProperty("temperature"); expect(wire).not.toHaveProperty("seed");
    expect(request.timeoutCapMs).toBe(25000); expect(request.allowWorkersAiFallback).toBe(false);
  }
});
for (const mode of ["measurable", "abstention", "partial"] as const) it(`actual protected boundary/checkpoint/recovery: ${mode}`, async () => {
  const responses = ([0, 1] as const).map(i => {
    const f = fixture(i); if (mode === "abstention") { f.left = abstain(); f.right = abstain(); }
    if (mode === "partial") f.right = abstain(); return f;
  });
  const e = endpoint(responses), state = createApertureV2State(preflight); state.executionMode = "offline_synthetic";
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-v2-offline-")), checkpoint = path.join(temp, "summary.json");
  try {
    await atomicCheckpoint(checkpoint, { smoke: true }, "local_smoke");
    expect((await readLatestAuditCheckpoint(checkpoint))!.snapshot).toEqual({ smoke: true });
    await runApertureV2Batch(state, preflight.inputs.map(i => i.dataUrl), e.post, async event => {
      if (event.startsWith("v2AcceptedEvidence:")) {
        const slot = state.slots[Number(event.split(":")[1])]; expect(slot.accepted).not.toBeNull(); expect(slot.derived).toBeNull();
      }
      await atomicCheckpoint(checkpoint, structuredClone(state), event);
    });
    const record = await readLatestAuditCheckpoint(checkpoint);
    expect(verifyApertureV2Recovery(record!.snapshot as typeof state, state)).toBe(true);
    expect(state.posts).toBe(2); expect(e.run).toHaveBeenCalledTimes(2);
    expect(e.network).not.toHaveBeenCalled(); expect(e.gateway).not.toHaveBeenCalled();
    for (const slot of state.slots) {
      expect(slot.outcome).toMatchObject({ providerOutcome: "returned", providerHttpStatus: null, shapeValid: true, semanticContractValid: true });
      expect(slot.accounting).toMatchObject({ dispatch: "known", providerCalls: { geminiStarted: 0, gemmaStarted: 1, gemmaCompleted: 1, retry: 0 } });
      expect(slot.accepted).toEqual(responses[slot.input]);
      if (mode !== "abstention") {
        expect(slot.derived!.left.measurement!.gapPx).toBe(5); // pixels, not normalized offsets
        expect(slot.derived!.left.measurement!.ratio).toBeCloseTo(5 / (.2 * slot.dimensions.widthPx));
      }
      if (mode !== "measurable") expect(slot.derived!.meanRatio).toBeNull();
      expect(slot.derived!.measurementAvailable).toBe(mode !== "abstention");
    }
    const serialized = fs.readFileSync(checkpoint, "utf8");
    expect(serialized).not.toMatch(/imageDataUrl|base64,|x-primary-audit-token|offline_synthetic.*providerOrigin/);
    await expect(runApertureV2Batch(state, [], e.post, async () => {})).rejects.toThrow("consumed");
  } finally {
    expect(path.dirname(path.resolve(temp))).toBe(path.resolve(os.tmpdir())); fs.rmSync(temp, { recursive: true });
  }
});
for (const mode of ["shape", "semantic", "provider"] as const) it(`NORMAL ${mode} failure stops OPEN with no repair or retry`, async () => {
  const invalid = fixture(0); invalid.left.lowerLidOffsetPx = -10;
  const e = endpoint([mode === "shape" ? { unexpected: "not retained" } : mode === "semantic" ? invalid : new Error("binding failed")]);
  const state = createApertureV2State(preflight);
  await runApertureV2Batch(state, preflight.inputs.map(i => i.dataUrl), e.post, async () => {});
  expect(state.posts).toBe(1); expect(e.run).toHaveBeenCalledTimes(1); expect(state.slots[1].status).toBe("not_attempted");
  expect(state.slots[0].accepted).toBeNull(); expect(state.slots[0].derived).toBeNull();
  expect(JSON.stringify(state)).not.toContain('"lowerLidOffsetPx":-10');
  expect(state.classification).toBe(mode === "provider" ? "V2_REQUEST_OR_EXECUTION_FAILED" : "V2_OUTPUT_CONTRACT_FAILED");
  const refused = await e.post({ imageDataUrl: preflight.inputs[1].dataUrl, batchRunId: state.runId, slot: 1 }, id());
  expect(refused.status).toBe(400); expect(e.run).toHaveBeenCalledTimes(1);
});
it("fails closed on intent persistence, post-response persistence and transport/accounting uncertainty", async () => {
  const e = endpoint([fixture(0)]), state = createApertureV2State(preflight), post = vi.fn(e.post);
  await expect(runApertureV2Batch(state, preflight.inputs.map(i => i.dataUrl), post, async () => { throw new Error("disk"); })).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
  const after = createApertureV2State(preflight);
  await expect(runApertureV2Batch(after, preflight.inputs.map(i => i.dataUrl), post, async event => {
    if (event.startsWith("v2AcceptedEvidence")) throw new Error("disk_after_post");
  })).rejects.toThrow("disk_after_post");
  expect(post).toHaveBeenCalledTimes(1); expect(after.slots[1].postInvoked).toBe(false);
  for (const failedPost of [vi.fn(async () => { throw new Error("timeout"); }), vi.fn(async () => ({ status: 500, body: {} }))]) {
    const s = createApertureV2State(preflight);
    await runApertureV2Batch(s, preflight.inputs.map(i => i.dataUrl), failedPost, async () => {});
    expect(failedPost).toHaveBeenCalledTimes(1); expect(s.dispatchAccounting).toBe("unknown");
  }
});
it("guards auth, order, crop identity and duplicate slot before binding", async () => {
  const e = endpoint([fixture(0)]), batch = id();
  expect((await auditWorker.fetch(new Request("http://audit.invalid/experimental-eye-aperture-v2-audit", { method: "POST" }), e.env)).status).toBe(403);
  expect((await e.post({ batchRunId: batch, slot: 1, imageDataUrl: preflight.inputs[1].dataUrl }, id())).status).toBe(400);
  expect((await e.post({ batchRunId: batch, slot: 0, imageDataUrl: preflight.inputs[1].dataUrl }, id())).status).toBe(400);
  expect(e.run).not.toHaveBeenCalled();
  const body = { batchRunId: batch, slot: 0, imageDataUrl: preflight.inputs[0].dataUrl };
  expect((await e.post(body, id())).status).toBe(200); expect((await e.post(body, id())).status).toBe(400);
  expect(e.run).toHaveBeenCalledTimes(1);
});
it("does not leak arbitrary shape keys or trace prose", () => {
  expect(safeV2Errors(["eyeApertureV2.secret_payload:additional"])).toEqual(["eyeApertureV2:unclassified_validation_error"]);
  expect(safeV2Trace({ outcome: "completed", message: "secret", raw: "not allowed" })).not.toHaveProperty("message");
});
