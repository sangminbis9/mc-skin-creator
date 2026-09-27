import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { workersAiStructuredInput } from "../src/gemini";
import auditWorker from "./primaryFaceMeasurementAuditWorker";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { APERTURE_INPUTS, APERTURE_OPTIONS, apertureImageIdentity, aperturePilotRequest, apertureRequestIdentity } from "./audit/eyeAperturePilotContract";
import { aperturePixelMeasurements, createAperturePilotState, prepareAperturePilot, runAperturePilot, verifyApertureRecovery } from "./audit/eyeAperturePilot";
import { buildEyeAperturePrototypeRequest, EYE_APERTURE_CONTRACT_VERSION, validateEyeApertureObservation, type EyeApertureObservation } from "./audit/eyeAperturePrototype";

let preflight: Awaited<ReturnType<typeof prepareAperturePilot>>;
beforeAll(async () => { preflight = await prepareAperturePilot(); });
afterEach(() => vi.unstubAllGlobals());
const fixture = (input: number): EyeApertureObservation => {
  const eye = (x: number, sign: number) => ({ visibility: "observed" as const,
    outerCorner: { x: x - sign * 0.1, y: 0.4 }, innerCorner: { x: x + sign * 0.1, y: 0.4 },
    upperLid: { x, y: 0.37 }, lowerLid: { x, y: 0.43 }, confidence: 0.9 });
  return { version: EYE_APERTURE_CONTRACT_VERSION, cropWidthPx: APERTURE_INPUTS[input].widthPx,
    cropHeightPx: APERTURE_INPUTS[input].heightPx, pose: "frontal", left: eye(0.3, 1), right: eye(0.7, -1) };
};
function mockedEndpoint(responses: unknown[]) {
  const network = vi.fn(() => { throw new Error("external_network_forbidden"); }); vi.stubGlobal("fetch", network);
  let index = 0;
  const run = vi.fn(async (_model: string, _input: unknown) => { const response = responses[index++]; if (response instanceof Error) throw response; return { response }; });
  const gateway = vi.fn(() => { throw new Error("primary_forbidden"); });
  const token = randomBytes(20).toString("hex");
  const env = { PRIMARY_AUDIT_TOKEN: token, AI: { run, gateway } } as unknown as Env & { PRIMARY_AUDIT_TOKEN: string };
  const post = async (body: unknown, runId: string) => {
    const response = await auditWorker.fetch(new Request("http://audit.invalid/experimental-eye-aperture-audit", {
      method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": runId }, body: JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  return { run, gateway, network, post, env };
}

it("freezes exact crops, unchanged prototype and per-source repeated payloads, with no labels in native wire", async () => {
  expect(preflight.prototypeSourceSha256).toBe("ce0389a765130b74c53ad79b4f4e7df28ccdf442da871b3b1300d7eb5971a1ca");
  for (const input of [0, 1] as const) {
    const data = preflight.inputs[input], size = APERTURE_INPUTS[input];
    expect(await apertureImageIdentity(data.dataUrl, input)).toBe(true);
    expect(await apertureImageIdentity(data.dataUrl, input === 0 ? 1 : 0)).toBe(false);
    const original = buildEyeAperturePrototypeRequest(data.dataUrl, size.widthPx, size.heightPx);
    const request = aperturePilotRequest(data.dataUrl, input);
    expect(request.prompt).toBe(original.prompt); expect(request.responseSchema).toBe(original.responseSchema);
    expect(request.imageDataUrls).toEqual([data.dataUrl]);
    const wire = workersAiStructuredInput(request, APERTURE_OPTIONS.model);
    expect(JSON.stringify(wire)).not.toMatch(/NORMAL|OPEN|wavy|calibration-001|0\.50|sourceLabel/);
    expect(wire).toMatchObject({ max_completion_tokens: 4096, chat_template_kwargs: { enable_thinking: false } });
    expect(await apertureRequestIdentity(data.dataUrl, input)).toEqual(data.metadata.requestIdentity);
  }
  const state = createAperturePilotState(preflight);
  expect(state.slots[0].requestIdentity).toEqual(state.slots[2].requestIdentity);
  expect(state.slots[1].requestIdentity).toEqual(state.slots[3].requestIdentity);
  expect(state.slots[0].requestIdentity.promptSha256).not.toBe(state.slots[1].requestIdentity.promptSha256);
});

it("runs four mocked stateless endpoint calls in fixed order, checkpoints landmarks before ratios and recovers exact JSON", async () => {
  const endpoint = mockedEndpoint([fixture(0), fixture(1), fixture(0), fixture(1)]);
  const state = createAperturePilotState(preflight);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eye-aperture-checkpoint-"));
  const checkpoint = path.join(directory, "summary.json");
  await runAperturePilot(state, preflight.inputs.map(input => input.dataUrl), endpoint.post, async event => {
    if (event.startsWith("apertureLandmarksAccepted:")) {
      const slot = state.slots[Number(event.split(":")[1])];
      expect(slot.accepted).not.toBeNull(); expect(slot.derived).toBeNull();
    }
    await atomicCheckpoint(checkpoint, JSON.parse(JSON.stringify(state)), event);
  });
  const recovered = await readLatestAuditCheckpoint(checkpoint);
  expect(verifyApertureRecovery(recovered!.snapshot as typeof state, state)).toBe(true);
  expect(state.classification).toBe("EYE_APERTURE_PILOT_COMPLETED");
  expect(state.posts).toBe(4); expect(endpoint.run).toHaveBeenCalledTimes(4);
  expect(endpoint.gateway).not.toHaveBeenCalled(); expect(endpoint.network).not.toHaveBeenCalled();
  for (const [index, slot] of state.slots.entries()) {
    expect(slot.accounting).toMatchObject({ dispatch: "known", providerCalls: { geminiStarted: 0, gemmaStarted: 1, retry: 0 } });
    expect(slot.derived!.left.widthPx).toBeCloseTo(APERTURE_INPUTS[index % 2].widthPx * 0.2);
    expect(slot.derived!.left.aperturePx).toBeCloseTo(APERTURE_INPUTS[index % 2].heightPx * 0.06);
    expect(endpoint.run.mock.calls[index][0]).toBe(APERTURE_OPTIONS.model);
  }
  const json = fs.readFileSync(checkpoint, "utf8");
  expect(json).not.toMatch(/data:image|base64,|x-primary-audit-token|imageDataUrl/);
  await expect(runAperturePilot(state, [], endpoint.post, async () => {})).rejects.toThrow("already_consumed");
  // Remove only this test-owned temporary checkpoint directory.
  expect(path.dirname(directory)).toBe(os.tmpdir()); fs.rmSync(directory, { recursive: true });
});

it("consumes output-invalid slots without salvaging and does not invent unknown-eye ratios", async () => {
  const value = fixture(1);
  value.left = { visibility: "unknown", confidence: 0, outerCorner: { x: null, y: null },
    innerCorner: { x: null, y: null }, upperLid: { x: null, y: null }, lowerLid: { x: null, y: null } };
  expect(validateEyeApertureObservation(value).ok).toBe(true);
  expect(aperturePixelMeasurements(value)).toMatchObject({ left: { ratio: null, points: null }, mean: null });
  const endpoint = mockedEndpoint([{}, value, fixture(0), fixture(1)]), state = createAperturePilotState(preflight);
  await runAperturePilot(state, preflight.inputs.map(input => input.dataUrl), endpoint.post, async () => {});
  expect(state.posts).toBe(4); expect(state.slots[0].accepted).toBeNull(); expect(state.slots[0].derived).toBeNull();
  expect(state.slots[0].outcome!.providerShapeValid).toBe(false);
});

it("stops on explicit schema rejection without substitution or retry", async () => {
  const endpoint = mockedEndpoint([new Error("unsupported response_format schema")]), state = createAperturePilotState(preflight);
  await runAperturePilot(state, preflight.inputs.map(input => input.dataUrl), endpoint.post, async () => {});
  expect(state.posts).toBe(1); expect(endpoint.run).toHaveBeenCalledTimes(1);
  expect(state.classification).toBe("EYE_APERTURE_REMOTE_CONTRACT_REJECTED");
});

it("stops on unobserved transport/accounting, and checkpoint intent failure prevents any POST", async () => {
  for (const post of [vi.fn(async () => { throw new Error("timeout"); }), vi.fn(async () => ({ status: 500, body: {} }))]) {
    const state = createAperturePilotState(preflight);
    await runAperturePilot(state, preflight.inputs.map(input => input.dataUrl), post, async () => {});
    expect(post).toHaveBeenCalledTimes(1); expect(state.dispatchAccounting).toBe("unknown");
    expect(state.slots.slice(1).every(slot => !slot.postInvoked)).toBe(true);
  }
  const post = vi.fn(), state = createAperturePilotState(preflight);
  await expect(runAperturePilot(state, preflight.inputs.map(input => input.dataUrl), post, async () => { throw new Error("checkpoint_failed"); })).rejects.toThrow();
  expect(post).not.toHaveBeenCalled(); expect(state.posts).toBe(0);
});

it("rejects unauthenticated, out-of-order and wrong-image endpoint requests with zero binding calls", async () => {
  const endpoint = mockedEndpoint([]), id = () => randomBytes(16).toString("hex");
  expect((await auditWorker.fetch(new Request("http://audit.invalid/experimental-eye-aperture-audit", { method: "POST" }), endpoint.env)).status).toBe(403);
  expect((await endpoint.post({ pilotRunId: id(), slot: 1, imageDataUrl: preflight.inputs[1].dataUrl }, id())).status).toBe(400);
  expect((await endpoint.post({ pilotRunId: id(), slot: 0, imageDataUrl: preflight.inputs[1].dataUrl }, id())).status).toBe(400);
  expect(endpoint.run).not.toHaveBeenCalled();
});
