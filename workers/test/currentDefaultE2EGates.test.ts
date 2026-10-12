import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { encode } from "jpeg-js";
import type { Env } from "../src/types";
import { projectE2EGateTrace, classifyE2E409 } from "./audit/currentDefaultE2EGateTrace";
import { createE2EState, runCurrentDefaultE2E, type prepareCurrentDefaultE2E } from "./audit/currentDefaultE2ELive";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const root = path.resolve("evaluation-artifacts/current-default-v3-e2e-409-gate-audit-20260926-001");
const jpeg = (width: number, height: number) => `data:image/jpeg;base64,${Buffer.from(encode({ width, height,
  data: Buffer.alloc(width * height * 4, 255) }, 85).data).toString("base64")}`;
const payload = { image: jpeg(299, 448), analysisImage: jpeg(597, 896) };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function scenario(name: string) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_network_forbidden"); }));
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const { default: production } = await import("../src/index");
  const { default: worker } = await import("./primaryFaceMeasurementAuditWorker");
  const { imageIdentity, E2E_MARKER } = await import("./audit/currentDefaultE2E");
  const { COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } = await import("../src/compactPhotoAnalysisV3");
  const provider = vi.fn(async () => Response.json({}, { status: 200 }));
  const ai = { gateway: () => ({ run: provider }), run: provider };
  const env = { PRIMARY_AUDIT_TOKEN: "offline-token", GEMINI_API_KEY: "offline-key", AI: ai,
    VISION_MODEL: "gemini-3.8-flash", WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it",
    FACE_GEOMETRY_ENRICHMENT_ENABLED: "true", MCSKIN_KV: { put: vi.fn() } };
  const mut = env as Record<string, unknown>;
  if (name === "key_missing" || name === "multiple_context" || name === "bad_selector_context") delete mut.GEMINI_API_KEY;
  if (name === "ai_missing" || name === "multiple_context") delete mut.AI;
  if (name === "gateway_missing") mut.AI = { run: provider };
  if (name === "vision_mismatch" || name === "multiple_context") mut.VISION_MODEL = "other";
  if (name === "workers_model_mismatch") mut.WORKERS_VISION_MODEL = "other";
  if (name === "geometry_flag_mismatch") mut.FACE_GEOMETRY_ENRICHMENT_ENABLED = "false";
  const status = name.startsWith("handler_") ? Number(name.split("_")[1]) : 200;
  const handler = vi.spyOn(production, "fetch").mockImplementation(async (request, e) => {
    expect(new URL(request.url).pathname).toBe("/api/generate");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual(payload);
    if (name.endsWith("_dispatch") && e.AI) await e.AI.gateway("offline").run({ provider: "google-ai-studio", headers: {},
      endpoint: "v1beta/models/gemini-3.8-flash:generateContent",
      query: { generationConfig: { responseJsonSchema: COMPACT_PHOTO_ANALYSIS_V3_SCHEMA } } });
    if (name.includes("_throw_")) throw new Error("untrusted detail must not escape");
    return Response.json({ ok: status === 200, errorCode: status === 200 ? undefined : "ai_failed" }, { status });
  });
  const a = await imageIdentity(payload.analysisImage), g = await imageIdentity(payload.image);
  const req = () => new Request("https://offline/current-default-e2e-audit", { method: "POST",
    headers: { "content-type": "application/json", "x-primary-audit-token": name === "auth" ? "bad" : "offline-token",
      "x-primary-audit-run-id": name.startsWith("bad_selector") ? "bad" : "a".repeat(32),
      "x-current-default-e2e": E2E_MARKER, "x-e2e-analysis-sha": name === "bad_hash" ? "bad" : a.sha256,
      "x-e2e-generation-sha": g.sha256 }, body: name === "bad_payload" ? "{}" : JSON.stringify(payload) });
  if (name.startsWith("duplicate")) {
    await worker.fetch(req(), env as unknown as Env); handler.mockClear(); provider.mockClear();
    if (name === "duplicate_context") delete mut.GEMINI_API_KEY;
  }
  const response = await worker.fetch(req(), env as unknown as Env);
  const text = await response.text();
  const parsed = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
  const body = typeof parsed === "object" ? Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== "e2eGateTrace")) : parsed;
  return { name, status: response.status, body, handlerCount: handler.mock.calls.length,
    providerMockCount: provider.mock.calls.length, trace: typeof parsed === "object" ? parsed.e2eGateTrace ?? null : null };
}
const names = ["valid", "key_missing", "ai_missing", "gateway_missing", "vision_mismatch", "workers_model_mismatch",
  "geometry_flag_mismatch", "multiple_context", "duplicate", "auth", "bad_selector", "bad_payload", "bad_hash",
  "handler_400", "handler_409", "handler_429", "handler_503", "handler_409_dispatch"];
it("freezes/compares synthetic status, response shape, handler count and provider count without external calls", async () => {
  const results: Awaited<ReturnType<typeof scenario>>[] = [];
  for (const name of names) {
    const r = await scenario(name);
    expect(r.status).toBe(name === "auth" ? 403 : ["bad_selector", "bad_payload", "bad_hash"].includes(name) ? 400
      : name.startsWith("handler_") ? Number(name.split("_")[1]) : name === "valid" ? 200 : 409);
    if (!name.startsWith("handler_") && name !== "valid") expect(r.handlerCount).toBe(0);
    expect(r.providerMockCount).toBe(name.endsWith("_dispatch") ? 1 : 0);
    // The historical gate baseline predates passive propagation capture. Check
    // that addition independently; keep its original status/dispatch envelope exact.
    if (r.handlerCount === 1) {
      const { imageIdentity } = await import("./audit/currentDefaultE2E");
      expect(r.body.propagationTrace).toEqual({
        version: "primary_png_propagation_v1", runId: "a".repeat(32),
        inputs: { analysisSha256: (await imageIdentity(payload.analysisImage)).sha256,
          generationSha256: (await imageIdentity(payload.image)).sha256 },
        providerStage: null, evidenceScope: "this_request_only_not_historical_recovery",
        primary: null, renderAnalysis: {}, selectedFamilies: null, referenceStyle: {},
        sourceParameters: null, skinPlan: { skinPlan: null }, injectedParameters: null,
        parameterEvidence: "unverified", replay: null, finalPng: null, projectionChanges: [],
      });
    } else if (typeof r.body === "object") expect(r.body).not.toHaveProperty("propagationTrace");
    results.push(r); vi.restoreAllMocks();
  }
  if (process.env.E2E_GATE_OFFLINE_CAPTURE === "before") {
    fs.mkdirSync(root, { recursive: false });
    fs.writeFileSync(path.join(root, "synthetic-before.json"), JSON.stringify(results, null, 2), { flag: "wx" });
  } else {
    const before = JSON.parse(fs.readFileSync(path.join(root, "synthetic-before.json"), "utf8"));
    const withoutTrace = (rows: typeof results) => rows.map(row => ({
      ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "trace" && key !== "body")),
      body: typeof row.body === "object" && row.body !== null
        ? Object.fromEntries(Object.entries(row.body).filter(([key]) => key !== "propagationTrace")) : row.body,
    }));
    expect(withoutTrace(results)).toEqual(withoutTrace(before));
    if (process.env.E2E_GATE_OFFLINE_CAPTURE === "after")
      fs.writeFileSync(path.join(root, "synthetic-after.json"), JSON.stringify(results, null, 2), { flag: "wx" });
  }
});

const failures = { key_missing: "gemini_api_key_missing", ai_missing: "ai_binding_missing",
  gateway_missing: "ai_gateway_not_function", vision_mismatch: "vision_model_mismatch",
  workers_model_mismatch: "workers_vision_model_mismatch", geometry_flag_mismatch: "face_geometry_flag_mismatch",
  multiple_context: "gemini_api_key_missing", duplicate: "e2e_already_consumed" };
it.each(Object.entries(failures))("captures first fixed failure %s without entering handler or provider", async (name, code) => {
  const r = await scenario(name);
  const trace = projectE2EGateTrace(r.trace, r.status);
  expect(trace).toMatchObject({ failureCode: code, routeEntered: true, selectorValidated: true,
    handlerInvocationStarted: false, providerAttemptIntent: 0, providerAttemptStarted: 0,
    providerDispatchObserved: false, responseOrigin: "audit_gate", responseFinalized: true });
  expect(classifyE2E409(trace)).toBe("PRE_PROVIDER_E2E_GATE_FAILURE");
  expect(r.handlerCount).toBe(0); expect(r.providerMockCount).toBe(0);
});
it("separates handler entry, returned status, and actual binding callback entry", async () => {
  for (const name of ["handler_409", "handler_409_dispatch"]) {
    const r = await scenario(name);
    const trace = projectE2EGateTrace(r.trace, 409)!;
    expect(trace).toMatchObject({ handlerInvocationStarted: true, handlerInvocationReturned: true,
      responseOrigin: "production_handler", failureCode: "production_handler_http_error" });
    expect(trace.providerAttemptStarted).toBe(r.providerMockCount);
    expect(classifyE2E409(trace)).toBe(name.endsWith("_dispatch") ? "POST_DISPATCH_E2E_GATE_FAILURE" : "PRE_PROVIDER_E2E_GATE_FAILURE");
    if (r.providerMockCount) expect(trace.firstProviderStartedSequence).toBeGreaterThan(trace.firstProviderIntentSequence);
    vi.restoreAllMocks();
  }
});
it("projects only fixed fields and rejects forged/partial trace rather than inferring zero", async () => {
  const r = await scenario("key_missing");
  const trace = projectE2EGateTrace(r.trace, 409)!;
  expect(projectE2EGateTrace({ ...trace, extra: "untrusted body", headers: "forbidden", image: "forbidden" }, 409)).toEqual(trace);
  for (const input of [null, {}, { ...trace, traceVersion: 2 }, { ...trace, failureCode: "private provider message" },
    { ...trace, responseFinalized: false }, { ...trace, responseStatus: 200 },
    { ...trace, providerAttemptStarted: 1 }, { ...trace, handlerInvocationStarted: true }])
    expect(projectE2EGateTrace(input, 409)).toBeNull();
  expect(classifyE2E409(null)).toBe("UNKNOWN_409_BOUNDARY");
  expect(JSON.stringify(trace)).not.toMatch(/offline-key|offline-token|data:image|requestBody|headers/);
});
it("durably captures early rejection before success-envelope validation and recovers the exact trace", async () => {
  const r = await scenario("geometry_flag_mismatch");
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  const dir = fs.mkdtempSync(path.join(root, "checkpoint-test-"));
  const file = path.join(dir, "summary.json");
  const events: string[] = [];
  const post = vi.fn(async () => ({ status: 409, body: { error: "e2e_production_context_mismatch", e2eGateTrace: r.trace,
    extra: "must_not_persist", response: "must_not_persist" } }));
  await runCurrentDefaultE2E(state, prepared, post, async event => {
    events.push(event); await atomicCheckpoint(file, state, event);
  }, dir);
  const recovered = await readLatestAuditCheckpoint(file);
  expect(recovered?.snapshot).toMatchObject({ e2eGateTrace: { failureCode: "face_geometry_flag_mismatch",
    handlerInvocationStarted: false, providerAttemptStarted: 0 }, gateBoundary: "PRE_PROVIDER_E2E_GATE_FAILURE", result: null });
  expect(events.indexOf("currentDefaultE2EGateTraceCaptured")).toBeLessThan(events.indexOf("currentDefaultE2EInvalidEnvelope"));
  expect(JSON.stringify(recovered)).not.toContain("must_not_persist");
  expect(post).toHaveBeenCalledTimes(1);
});
it("a trace checkpoint failure after the POST does not trigger a retry", async () => {
  const r = await scenario("key_missing");
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  const post = vi.fn(async () => ({ status: 409, body: { e2eGateTrace: r.trace } }));
  await expect(runCurrentDefaultE2E(state, prepared, post, async event => {
    if (event === "currentDefaultE2EGateTraceCaptured") throw new Error("checkpoint_failed");
  }, "unused")).rejects.toThrow("checkpoint_failed");
  expect(post).toHaveBeenCalledTimes(1);
  await expect(runCurrentDefaultE2E(state, prepared, post, async () => {}, "unused")).rejects.toThrow("already_consumed");
  expect(post).toHaveBeenCalledTimes(1);
});
it("an old-style HTTP 409 without trace remains unknown", async () => {
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  await runCurrentDefaultE2E(state, prepared, async () => ({ status: 409, body: { error: "e2e_production_context_mismatch" } }),
    async () => {}, "unused");
  expect(state.e2eGateTrace).toBeNull(); expect(state.accounting).toBe("unknown");
});
it("selector and consumed gates retain precedence over invalid environment", async () => {
  const selector = await scenario("bad_selector_context");
  expect(selector.status).toBe(400);
  expect(selector.trace.failureCode).toBe("invalid_e2e_marker_or_run_id");
  expect(selector.handlerCount).toBe(0);
  vi.restoreAllMocks();
  const consumed = await scenario("duplicate_context");
  expect(consumed.status).toBe(409);
  expect(consumed.trace.failureCode).toBe("e2e_already_consumed");
  expect(consumed.handlerCount).toBe(0);
});
it("retains actual callback-start evidence when the handler throws afterward", async () => {
  const r = await scenario("handler_500_throw_dispatch");
  expect(r.status).toBe(500);
  expect(projectE2EGateTrace(r.trace, 500)).toMatchObject({ responseOrigin: "audit_exception",
    handlerInvocationStarted: true, handlerInvocationReturned: false, providerAttemptStarted: 1,
    failureCode: "e2e_adapter_exception" });
  expect(JSON.stringify(r.body)).not.toContain("untrusted detail");
});
it("does not add internal trace fields to the real public production response", async () => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_network_forbidden"); }));
  const { default: production } = await import("../src/index");
  const response = await production.fetch(new Request("https://offline/api/generate", { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" }),
    { MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => {}) } } as unknown as Env);
  expect(response.status).toBe(400);
  expect(await response.json()).not.toHaveProperty("e2eGateTrace");
});
