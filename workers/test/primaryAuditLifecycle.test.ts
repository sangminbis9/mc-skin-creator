import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import auditWorker from "./primaryFaceMeasurementAuditWorker";
import { assertProviderCalls, createAuditState, wrapAuditAI } from "./primaryAuditLifecycle";
import { accountedRequest, accountingOf, atomicCheckpoint, healthReady,
  readLatestAuditCheckpoint, type LocalStage } from "./primaryAuditRunnerSupport";
import { calibrationLocalizationGate } from "./audit/calibrationLocalizationGate";
import { checkpointValidatedLocalizationCapture } from "./audit/validatedLocalizationEvidence";
import { namedGemmaFixture, wireFixture } from "./compactV3Support";
import { makeAnalysis } from "./helpers";
import { GEMMA_VISION_MODEL } from "../src/gemmaPhotoAnalysis";
import { PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION } from "../src/compactPhotoAnalysisV4";
import { FACE_GEOMETRY_MODEL } from "../src/faceIdentityGeometry";
import { validatePortraitRegion } from "../src/analysis";
import type { Env } from "../src/types";

const token = "audit-token-must-not-persist";
const key = "api-key-must-not-persist";
const photo = "data:image/jpeg;base64,/9j/";
const runId = () => randomBytes(16).toString("hex");
const geminiSuccess = (analysis = makeAnalysis()) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(wireFixture(analysis)) }] } }] });
const geometryFixture = () => ({
  face: { envelopeLeft: 0.1, envelopeRight: 0.9, foreheadY: 0.12, chinY: 0.96 },
  eyes: { leftCenterX: 0.3, leftCenterY: 0.4, rightCenterX: 0.7, rightCenterY: 0.4,
    leftWidth: 0.16, rightWidth: 0.16, openness: 0.72 },
  brows: { leftY: 0.28, rightY: 0.28, thickness: 0.5, tilt: 0.1 },
  nose: { centerX: 0.5, contrastY: 0.6, visibleStrength: 0.4 },
  mouth: { centerX: 0.5, centerY: 0.74, width: 0.24, leftCornerY: 0.74, rightCornerY: 0.74, opening: "closed" },
  confidence: { faceBounds: 0.9, eyes: 0.9, brows: 0.9, nose: 0.9, mouth: 0.9 },
  directLowerFaceContour: {
    cheek: { left: 0.2, right: 0.8, y: 0.6, evidence: "observed", confidence: 0.9 },
    jaw: { left: 0.25, right: 0.75, y: 0.76, evidence: "observed", confidence: 0.9 },
    chin: { left: 0.35, right: 0.65, y: 0.88, evidence: "observed", confidence: 0.9 },
  },
});
function fixture(run?: ReturnType<typeof vi.fn>, analysis = makeAnalysis()) {
  const gatewayRun = run ?? vi.fn(async () => geminiSuccess(analysis));
  const gemma = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(namedGemmaFixture(wireFixture(makeAnalysis()))) } }] }));
  const gateway = { run: gatewayRun };
  const env = {
    PRIMARY_AUDIT_TOKEN: token, GEMINI_API_KEY: key, VISION_MODEL: "gemini-3.8-flash",
    WORKERS_VISION_MODEL: GEMMA_VISION_MODEL, AI: { gateway: vi.fn(() => gateway), run: gemma }, MCSKIN_KV: {},
  } as unknown as Env & { PRIMARY_AUDIT_TOKEN: string };
  const fetch = (url: string, init?: RequestInit) => auditWorker.fetch(new Request(url, init), env);
  const post = (id: string, body: unknown = { imageDataUrl: photo }) => fetch("http://audit.invalid/primary-audit", {
    method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": id }, body: JSON.stringify(body),
  });
  const status = async (id: string) => (await fetch(`http://audit.invalid/primary-audit-status?runId=${id}`, {
    headers: { "x-primary-audit-token": token },
  })).json();
  return { env, fetch, post, status, run: gatewayRun, gemma };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function prohibitNetwork() {
  const network = vi.fn(() => { throw new Error("external_network_forbidden"); });
  vi.stubGlobal("fetch", network);
  return network;
}
function safe(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of ["data:image", "/9j/", key, token, "Authorization", "imageDataUrl", "raw request body"])
    expect(text).not.toContain(secret);
}
describe("audit Worker: actual production analysis, fake bindings only", () => {
  it("records entry and dispatch before successful Gemini binding return", async () => {
    const network = prohibitNetwork(); const f = fixture(); const id = runId();
    const result = await (await f.post(id)).json();
    expect(result).toMatchObject({ ok: true, auditState: { runId: id, geminiStarted: 1, geminiCompleted: 1, geminiFailed: 0, gemmaStarted: 0, finalOk: true, stage: "response_ready" } });
    expect(result.auditState.lifecycle.map((item: { stage: string }) => item.stage)).toEqual([
      "created", "request_entered", "primary_started", "gemini_dispatch_started", "gemini_returned", "photo_analysis_completed", "response_ready",
    ]);
    assertProviderCalls(result.auditState); safe(await f.status(id));
    expect(network).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("selects V4 only on the protected audit route and returns bounded structured localization", async () => {
    const network = prohibitNetwork();
    const region = { subjectBox: { left: 0.08, top: 0.04, right: 0.62, bottom: 0.98 },
      headBox: { left: 0.16, top: 0.08, right: 0.52, bottom: 0.5 },
      faceBox: { left: 0.21, top: 0.17, right: 0.47, bottom: 0.44 }, confidence: 0.91 };
    const compact = wireFixture(makeAnalysis());
    const raw = { ...compact, sourceSelection: { ...compact.sourceSelection, portraitRegion: region } };
    const f = fixture(vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] } }] })));
    const id = runId();
    const result = await (await f.fetch("http://audit.invalid/primary-audit-v4-structured-localization", {
      method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": id },
      body: JSON.stringify({ imageDataUrl: photo }),
    })).json();
    expect(result).toMatchObject({ ok: true, expectedContractVersion: PRIMARY_COMPACT_V4_STRUCTURED_LOCALIZATION,
      contractValidation: { providerWireSchemaValid: true, primaryCoreValid: true, localizationValid: true },
      localizationTrace: { traceVersion: 2, carrier: "structured_region", status: "VALID" },
      validatedLocalization: { portraitImageIndex: 0, region },
      analysis: { sourceSelection: { portraitImageIndex: 0, portraitRegion: region },
        identityCropContext: { hairVolume: "normal", hairTexture: "straight",
          overallHairLength: "ear", sideHairAsymmetry: "none", headCovering: false },
        fallbackFeaturesGlasses: "regular" },
      auditState: { geminiStarted: 1, gemmaStarted: 0, retry: 0 } });
    expect(result.analysis).not.toHaveProperty("portraitEvidence");
    expect(result.analysis).not.toHaveProperty("observed");
    const protectedJson = JSON.parse(JSON.stringify(result));
    expect(protectedJson.localizationTrace).not.toHaveProperty("version");
    const checkpointPath = resolve(await mkdtemp(resolve(tmpdir(), "v4-audit-gate-")), "summary.json");
    const capture = await checkpointValidatedLocalizationCapture({
      primaryOk: protectedJson.ok && protectedJson.validation.richPhotoAnalysis === "passed",
      expectedContractVersion: protectedJson.expectedContractVersion,
      contractValidation: protectedJson.contractValidation,
      protectedLocalization: protectedJson.validatedLocalization,
      localizationTrace: protectedJson.localizationTrace,
      imageCount: 1, runId: id, caseId: "wavy-open-blazer",
      sourceSha256: "a".repeat(64), derivativeSha256: "b".repeat(64),
      inputDimensions: { width: 597, height: 896 }, provider: "gemini", model: "gemini-3.8-flash",
      promptSha256: "c".repeat(64), schemaJsonSha256: "d".repeat(64),
    }, async observed => {
      await atomicCheckpoint(checkpointPath,
        { validatedLocalizationEvidence: observed.status === "captured" ? observed.evidence : null },
        "validated_localization_observed");
    });
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") return;
    expect(capture.evidence.region).toEqual(region);
    expect(capture.evidence.provenanceComplete).toBe(true);
    const recovered = await readLatestAuditCheckpoint(checkpointPath);
    expect(recovered).toMatchObject({ schemaVersion: 1, event: "validated_localization_observed",
      snapshot: { validatedLocalizationEvidence: { region, portraitImageIndex: 0 } } });
    const recoveredEvidence = (recovered!.snapshot as { validatedLocalizationEvidence: typeof capture.evidence })
      .validatedLocalizationEvidence;
    expect(recoveredEvidence.region).toEqual(region);
    expect(validatePortraitRegion(recoveredEvidence.region).ok).toBe(true);
    const gateInput = {
      primaryPassed: protectedJson.ok === true && protectedJson.contractValidation.primaryCoreValid === true
        && protectedJson.validation.richPhotoAnalysis === "passed",
      quality: protectedJson.analysis.quality,
      faceVisible: protectedJson.analysis.visibleRegions.face,
      portraitImageIndex: protectedJson.analysis.sourceSelection.portraitImageIndex,
      sourceVerified: true, imageCount: 1,
      expectedContractVersion: protectedJson.expectedContractVersion,
      trace: protectedJson.localizationTrace,
      portraitRegion: protectedJson.analysis.sourceSelection.portraitRegion,
    };
    const gate = calibrationLocalizationGate(gateInput);
    expect(gate.calibrationLocalizationEligible).toBe(true);
    expect(gate.normalizedRegion.ok).toBe(true);
    const classification = protectedJson.contractValidation.providerWireSchemaValid === true
      && protectedJson.contractValidation.localizationValid === true
      && gate.calibrationLocalizationEligible ? "V4_VALID_LOCALIZATION_OBSERVED" : "V4_LOCALIZATION_CONTRACT_FAILURE";
    expect(classification).toBe("V4_VALID_LOCALIZATION_OBSERVED");
    await atomicCheckpoint(checkpointPath, gateInput, "primary_completed");
    const gateCheckpoint = await readLatestAuditCheckpoint(checkpointPath);
    expect(gateCheckpoint).toMatchObject({ schemaVersion: 1, event: "primary_completed",
      snapshot: { trace: { traceVersion: 2, status: "VALID" } } });
    expect(calibrationLocalizationGate(gateCheckpoint!.snapshot as typeof gateInput).calibrationLocalizationEligible).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.gemma).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    safe(result);
  });
  it.each([
    ["explicit_null", null],
    ["missing", undefined],
    ["malformed", "rejected-provider-payload"],
    ["semantic_invalid", { subjectBox: { left: 0.08, top: 0.04, right: 0.62, bottom: 0.98 },
      headBox: { left: 0.16, top: 0.08, right: 0.52, bottom: 0.5 },
      faceBox: { left: 0.7, top: 0.17, right: 0.9, bottom: 0.44 }, confidence: 0.91 }],
  ])("never exposes a rejected V4 region payload (%s)", async (_label, regionValue) => {
    const network = prohibitNetwork();
    const compact = wireFixture(makeAnalysis());
    const raw = { ...compact, sourceSelection: { ...compact.sourceSelection, portraitRegion: regionValue } };
    const f = fixture(vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] } }] })));
    const result = await (await f.fetch("http://audit.invalid/primary-audit-v4-structured-localization", {
      method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": runId() },
      body: JSON.stringify({ imageDataUrl: photo }),
    })).json();
    expect(result.validatedLocalization).toBeNull();
    expect(JSON.stringify(result)).not.toContain("rejected-provider-payload");
    expect(JSON.stringify(result)).not.toContain('"left":0.7');
    expect(f.gemma).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    safe(result);
  });
  it("captures only bounded glasses cross-field evidence", async () => {
    prohibitNetwork();
    const base = makeAnalysis();
    const longAccessory = `fine gold necklace\u0000 ${"x".repeat(400)}`;
    const analysis = makeAnalysis({
      observed: { ...base.observed, accessories: longAccessory },
      fallbackFeatures: { ...base.fallbackFeatures, glasses: "none" },
      canonicalIdentity: {
        ...base.canonicalIdentity,
        features: base.canonicalIdentity.features.map((feature, index) => index === 1
          ? { ...feature, feature: longAccessory, evidence: `visible accessory\u0007 ${"y".repeat(400)}` }
          : feature),
      },
    });
    const f = fixture(undefined, analysis);
    const result = await (await f.post(runId())).json();
    expect(result.analysis).toMatchObject({
      fallbackFeaturesGlasses: "none",
      canonicalAccessoryCues: [expect.objectContaining({ confidence: "high", priority: 5 })],
    });
    expect(result.analysis.observedAccessories.length).toBe(256);
    expect(result.analysis.canonicalAccessoryCues[0].feature.length).toBe(256);
    expect(result.analysis.canonicalAccessoryCues[0].evidence.length).toBe(256);
    expect([...JSON.stringify(result.analysis)].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    })).toBe(false);
    for (const forbidden of ["identityPrompt", "outfitPrompt", "observedFace", "observedHair", "observedClothing", "canonicalIdentity"]) {
      expect(result.analysis).not.toHaveProperty(forbidden);
    }
  });
  it("lets production FAILED_PRECONDITION alone select exactly one Gemma fallback", async () => {
    const network = prohibitNetwork();
    const f = fixture(vi.fn(async () => Response.json({ error: { status: "FAILED_PRECONDITION" } }, { status: 400 })));
    const result = await (await f.post(runId())).json();
    expect(result.ok).toBe(true);
    // HTTP 400 is a resolved binding return, not a binding throw.
    expect(result.auditState).toMatchObject({ geminiStarted: 1, geminiCompleted: 1, geminiFailed: 0, gemmaStarted: 1, gemmaCompleted: 1, gemmaFailed: 0, retry: 0 });
    expect(result.providerSequence).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "gemini", outcome: "failed", fallbackEligible: true })]));
    assertProviderCalls(result.auditState); expect(f.gemma).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
  });
  it("does not select fallback on INVALID_ARGUMENT", async () => {
    prohibitNetwork(); const f = fixture(vi.fn(async () => Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 })));
    const result = await (await f.post(runId())).json();
    expect(result.ok).toBe(false); expect(result.auditState.gemmaStarted).toBe(0); expect(f.gemma).not.toHaveBeenCalled();
  });
  it("exposes Started=1 while a binding promise has not returned", async () => {
    prohibitNetwork();
    let release!: (value: Response) => void; let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const f = fixture(vi.fn(() => { entered(); return pending; })); const id = runId();
    const request = f.post(id); await dispatched;
    const state = await f.status(id);
    expect(state).toMatchObject({ found: true, runId: id, stage: "gemini_dispatch_started", geminiStarted: 1, geminiCompleted: 0, geminiFailed: 0 });
    assertProviderCalls(state); safe(state);
    release(geminiSuccess()); await request; // test cleanup only, no retry
  });
  it("keeps pre-provider validation errors at request_entered with starts zero", async () => {
    const f = fixture(); const id = runId();
    expect((await f.post(id, { imageDataUrl: 1 })).status).toBe(400);
    expect(await f.status(id)).toMatchObject({ stage: "request_entered", geminiStarted: 0, gemmaStarted: 0, finalOk: false });
    expect(f.run).not.toHaveBeenCalled(); expect(f.gemma).not.toHaveBeenCalled();
  });
  it("health is token-protected and requires no provider call", async () => {
    const f = fixture(); const stages: LocalStage[] = [];
    expect(await healthReady(f, token, async stage => { stages.push(stage); })).toBe(true);
    expect(stages).toEqual(["healthRequestStarted", "healthResponseReceived"]);
    expect((await f.fetch("http://audit.invalid/primary-audit-health")).status).toBe(403);
    expect(f.run).not.toHaveBeenCalled(); expect(f.gemma).not.toHaveBeenCalled();
  });
  it("passes one protected direct geometry image unchanged without primary analysis or recropping", async () => {
    const network = prohibitNetwork();
    const f = fixture();
    f.gemma.mockResolvedValueOnce({ response: geometryFixture() });
    const id = runId();
    const response = await f.fetch("http://audit.invalid/face-geometry-direct-audit", {
      method: "POST",
      headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": id },
      body: JSON.stringify({ imageDataUrl: photo }),
    });
    const result = await response.json() as Record<string, unknown> & { auditState: Record<string, unknown> };
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ ok: true, inputMode: "direct_frozen_face_crop", crop: null,
      providerShapeValid: true, errors: [], geometry: { eyes: { openness: 0.72 } },
      auditState: { geminiStarted: 0, gemmaStarted: 1, gemmaCompleted: 1, retry: 0, finalOk: true } });
    const [model, input] = f.gemma.mock.calls[0] as unknown as [string, { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> }];
    expect(model).toBe(FACE_GEOMETRY_MODEL);
    expect(input.messages[0].content.filter(part => part.type === "image_url")).toEqual([
      { type: "image_url", image_url: { url: photo } },
    ]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.gemma).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    safe(result);
  });
  it("returns only matching run state; unknown id is found=false, wrong token 403", async () => {
    const f = fixture(); const id = runId(); await f.post(id, {});
    expect(await f.status(id)).toMatchObject({ found: true, runId: id });
    expect(await f.status(runId())).toMatchObject({ found: false });
    expect((await f.fetch(`http://audit.invalid/primary-audit-status?runId=${id}`, { headers: { "x-primary-audit-token": "wrong" } })).status).toBe(403);
  });
  it("rejects malformed or duplicate run ids without provider dispatch", async () => {
    const f = fixture(); expect((await f.post("secret-or-payload")).status).toBe(400);
    const id = runId(); await f.post(id, {}); expect((await f.post(id)).status).toBe(409);
    expect(f.run).not.toHaveBeenCalled();
  });
});
describe("binding context and forwarding", () => {
  it("preserves this, argument identity and exact result/error identity", async () => {
    const state = createAuditState(runId()); const args = { secret: token }; const options = { signal: new AbortController().signal };
    const result = { untouched: true }; const error = new Error(key);
    const gateway = { async run(input: unknown, opts: unknown) {
      expect(this).toBe(gateway); expect(input).toBe(args); expect(opts).toBe(options); return result;
    } };
    const ai = { gateway(name: string) { expect(this).toBe(ai); expect(name).toBe("default"); return gateway; },
      async run(model: string, input: unknown) { expect(this).toBe(ai); expect(model).toBe(GEMMA_VISION_MODEL); expect(input).toBe(args); throw error; } };
    const wrapped = wrapAuditAI(ai, state, GEMMA_VISION_MODEL);
    expect(await wrapped.gateway("default").run(args, options)).toBe(result);
    await expect(wrapped.run(GEMMA_VISION_MODEL, args)).rejects.toBe(error);
    expect(state).toMatchObject({ geminiStarted: 1, geminiCompleted: 1, gemmaStarted: 1, gemmaFailed: 1 });
    assertProviderCalls(state); safe(state);
  });
  it("does not count unrelated Workers AI models and rethrows Gemini error untouched", async () => {
    const state = createAuditState(runId()); const error = { secret: key };
    const ai = { gateway() { return { run() { throw error; } }; }, run() { return "other"; } };
    const wrapped = wrapAuditAI(ai, state, GEMMA_VISION_MODEL);
    expect(wrapped.run()).toBe("other");
    await expect(wrapped.gateway().run()).rejects.toBe(error);
    expect(state).toMatchObject({ geminiStarted: 1, geminiFailed: 1, gemmaStarted: 0 }); assertProviderCalls(state);
  });
  it("checks per-case limits, completion inequalities and retry=0", () => {
    const state = createAuditState(runId()); assertProviderCalls(state);
    expect(() => assertProviderCalls({ ...state, geminiCompleted: 1 })).toThrow();
    expect(() => assertProviderCalls({ ...state, gemmaStarted: 2 })).toThrow();
    expect(() => assertProviderCalls({ ...state, retry: 1 } as never)).toThrow();
  });
});
describe("local checkpoints and single timeout status recovery", () => {
  it("atomically rewrites a safe checkpoint and recovers started count after a short fake timeout", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "primary-audit-")); const path = resolve(root, "checkpoint.json");
    const id = runId(); const state = { ...createAuditState(id), stage: "gemini_dispatch_started", geminiStarted: 1 };
    const artifact: { localLifecycle: Partial<Record<LocalStage, number>>; accounting?: unknown } = { localLifecycle: {} };
    const checkpoint = async (stage: LocalStage) => { artifact.localLifecycle[stage] = Date.now(); await atomicCheckpoint(path, artifact); };
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("primary-audit-status")) return Response.json({ found: true, ...state });
      await new Promise(resolve => setTimeout(resolve, 1));
      throw Object.assign(new Error(token), { name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT" });
    });
    const outcome = await accountedRequest({ fetch }, token, id, JSON.stringify({ imageDataUrl: photo }), checkpoint);
    artifact.accounting = outcome.accounting; await atomicCheckpoint(path, artifact);
    expect(outcome).toMatchObject({ failure: "timeout", accounting: { dispatch: "known", final: false, providerCalls: { geminiStarted: 1, geminiCompleted: 0 } } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Object.keys(artifact.localLifecycle)).toEqual(["canaryFetchInvoked", "timeoutObserved", "statusProbeAttempted"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(artifact); safe(artifact);
  });
  it.each(["missing", "failed", "wrong_run", "invalid_counts"])("keeps dispatch unknown when status is %s", async mode => {
    const id = runId(); const state = createAuditState(mode === "wrong_run" ? runId() : id);
    const fetch = vi.fn(async (url: string) => {
      if (!url.includes("status") || mode === "failed") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return Response.json({ found: mode !== "missing", ...state, ...(mode === "invalid_counts" ? { geminiStarted: 2 } : {}) });
    });
    const result = await accountedRequest({ fetch }, token, id, "body-not-to-save", async () => {});
    expect(result.accounting).toEqual({ dispatch: "unknown" }); expect(fetch).toHaveBeenCalledTimes(2); safe(result);
  });
  it("tracks headers and body separately on normal completion", async () => {
    const id = runId(); const state = { ...createAuditState(id), finalOk: true };
    const stages: LocalStage[] = [];
    const result = await accountedRequest({ fetch: async () => Response.json({ auditState: state }) }, token, id, "not-saved", async stage => { stages.push(stage); });
    expect(stages).toEqual(["canaryFetchInvoked", "canaryHeadersReceived", "finalBodyParsed"]);
    expect(result.accounting.dispatch).toBe("known");
    expect(accountingOf(undefined, id)).toEqual({ dispatch: "unknown" });
  });
});
