// Offline fake-response tests only: no CLI runner import, network, image or inference.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { captureE2EHttpResponse, createE2EState, runCurrentDefaultE2E,
  classifyRejectedE2EBody,
  type prepareCurrentDefaultE2E } from "./audit/currentDefaultE2ELive";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { AuditShutdownLatch } from "./auditShutdownLatch";
import { E2E_MARKER } from "./audit/currentDefaultE2E";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const historicalRoot = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-003";
const historicalNames = fs.readdirSync(historicalRoot).filter(f => f.endsWith(".json"));
const historicalHashes = historicalNames.map(f => [f, sha(fs.readFileSync(path.join(historicalRoot, f)))]);
const fixedFiles = Object.keys(JSON.parse(fs.readFileSync(`${historicalRoot}/summary.json`, "utf8")).currentDefaultE2E.fixedHashes).sort();
const productionHash = () => sha(JSON.stringify(fixedFiles.map(f => [f, sha(fs.readFileSync(f))])));
const productionBefore = productionHash();
const prepared = { payload: { image: "offline-memory-only", analysisImage: "offline-memory-only" } } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
const sentinel = "private-diagnostic-sentinel-123";
let root: string;
const outcomes: Array<Record<string, unknown>> = [];
beforeAll(() => { root = fs.mkdtempSync("evaluation-artifacts/e2e-response-observation-offline-20261007-"); });
afterEach(() => vi.unstubAllGlobals());

async function scenario(id: string, send: () => Promise<{ status: number; json: () => Promise<unknown> }>) {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline_network_forbidden"); }));
  const directory = path.join(root, id); fs.mkdirSync(directory);
  const state = createE2EState(prepared), events: string[] = [];
  const file = path.join(directory, "summary.json");
  const persist = async (event: string) => { events.push(event); await atomicCheckpoint(file, state, event); };
  const post = vi.fn(async (_payload: typeof prepared.payload, _runId: string, onHeaders: (status: number) => Promise<void>) => captureE2EHttpResponse(send, onHeaders));
  await runCurrentDefaultE2E(state, prepared, post, persist, directory);
  expect(post).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  const recovered = await readLatestAuditCheckpoint(file);
  expect(recovered?.snapshot).toEqual(JSON.parse(JSON.stringify(state)));
  expect(recovered?.snapshotSha256).toBe(sha(JSON.stringify(recovered?.snapshot)));
  expect(state.result).toBeNull(); expect(state.png).toBeNull(); expect(state.accounting).toBe("unknown");
  await expect(runCurrentDefaultE2E(state, prepared, post, persist, directory)).rejects.toThrow("e2e_generation_already_consumed");
  expect(post).toHaveBeenCalledOnce();
  for (const f of fs.readdirSync(directory)) {
    const text = fs.readFileSync(path.join(directory, f), "utf8");
    expect(text).not.toMatch(/private-diagnostic-sentinel|preview\.invalid|offline-memory-only|data:image|rawResponse|rawRequest|rawPrompt/);
  }
  outcomes.push({ id, evidenceKind: "synthetic_response_only", observation: state.httpObservation,
    httpStatus: state.httpStatus, accounting: state.accounting, classification: state.classification,
    simulatedPostCalls: post.mock.calls.length, realProviderCalls: 0, checkpointRecovered: true });
  return { state, events, directory };
}

it("separates fetch/socket failure and retains only allowlisted exception codes", async () => {
  const error = new TypeError(`fetch failed https://preview.invalid/?token=${sentinel}`, {
    cause: Object.assign(new Error(sentinel), { code: "UND_ERR_SOCKET" }),
  });
  const send = vi.fn(async () => { throw error; });
  const { state, events } = await scenario("fetch-socket", send);
  expect(send).toHaveBeenCalledOnce(); expect(state.httpStatus).toBeNull();
  expect(state.httpObservation).toMatchObject({ stage: "await_response", httpStatus: null,
    exception: { name: "TypeError", causeCode: "UND_ERR_SOCKET", messageClassified: "fetch_failed" } });
  expect(events).not.toContain("currentDefaultE2EHttpHeadersReceived");
  expect(state.classification).toBe("BLOCKED: E2E response unobserved; provider accounting unknown");
});
it("retains an observed abort without inferring remote cancellation", async () => {
  const { state } = await scenario("abort", async () => { throw new DOMException(sentinel, "AbortError"); });
  expect(state.httpObservation).toMatchObject({ stage: "await_response", httpStatus: null,
    exception: { name: "AbortError", messageClassified: "aborted" } });
  expect(state.accounting).toBe("unknown");
});
it.each([200, 503])("persists HTTP %s before JSON rejection without saving a response snippet", async status => {
  const { state, events, directory } = await scenario(`invalid-json-${status}`, async () => new Response(`<html>${sentinel}</html>`, { status }));
  expect(state.httpStatus).toBe(status);
  expect(state.httpObservation).toMatchObject({ stage: "json_parse", httpStatus: status,
    jsonRootType: null, exception: { name: "SyntaxError" } });
  expect(state.classification).toBe("BLOCKED: E2E HTTP response JSON unavailable; provider accounting unknown");
  expect(events).toContain("currentDefaultE2EHttpHeadersReceived");
  const header = JSON.parse(fs.readFileSync(path.join(directory, "summary.json.checkpoint-000003.json"), "utf8"));
  expect(header.event).toBe("currentDefaultE2EHttpHeadersReceived");
  expect(header.snapshot.httpStatus).toBe(status);
  expect(header.snapshot.httpObservation.stage).toBe("headers_received");
});
it("does not mislabel a body-stream error as a pre-header fetch failure", async () => {
  const { state } = await scenario("body-stream", async () => ({ status: 502,
    json: async () => { throw Object.assign(new TypeError(sentinel), { cause: { code: "ECONNRESET" } }); } }));
  expect(state.httpObservation).toMatchObject({ stage: "json_parse", httpStatus: 502, exception: { causeCode: "ECONNRESET" } });
});
it.each(["1101", "1102", "1019"] as const)("persists only a fixed reported code %s from non-JSON, not an inferred provider outcome", async code => {
  const { state } = await scenario(`reported-code-${code}`, async () => new Response(
    `<html><h1>Error <span>${code}</span></h1><p>${sentinel} https://preview.invalid/private</p></html>`, { status: 503 }));
  expect(state.httpObservation?.rejectedBody).toEqual({ format: "html", reportedErrorCode: code,
    codeAmbiguous: false, inspectionTruncated: false });
  expect(state.accounting).toBe("unknown"); expect(state.result).toBeNull();
});
it("does not copy free text or invent an error code from unrelated digits", () => {
  expect(classifyRejectedE2EBody(`private ${sentinel} 1101`)).toEqual({ format: "text",
    reportedErrorCode: null, codeAmbiguous: false, inspectionTruncated: false });
  expect(classifyRejectedE2EBody("  ").format).toBe("empty");
  expect(classifyRejectedE2EBody("Error 1101 Error 1102")).toMatchObject({ reportedErrorCode: null, codeAmbiguous: true });
  expect(classifyRejectedE2EBody("x".repeat(65_536) + "Error 1101")).toMatchObject({
    reportedErrorCode: null, inspectionTruncated: true });
});
it("reads a real response once and preserves BOM-prefixed valid JSON semantics", async () => {
  const response = new Response('\uFEFF{"ok":true}', { status: 200 });
  const read = vi.spyOn(response, "text"), json = vi.spyOn(response, "json"), send = vi.fn(async () => response);
  expect(await captureE2EHttpResponse(send, async () => {})).toEqual({ status: 200, body: { ok: true } });
  expect(send).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
});
it.each([
  ["null", null], ["array", []], ["string", sentinel], ["number", 42], ["boolean", false], ["non_json", undefined],
] as const)("records only the invalid JSON root type %s", async (type, value) => {
  const { state } = await scenario(`root-${type}`, async () => ({ status: 200, json: async () => value }));
  expect(state.httpObservation).toEqual({ stage: "json_root", httpStatus: 200, jsonRootType: type, exception: null });
});
it("distinguishes a parsed object with no protected envelope from a JSON parse failure", async () => {
  const { state } = await scenario("unprotected-object", async () => new Response(JSON.stringify({ diagnostic: sentinel }), { status: 500 }));
  expect(state.httpObservation).toEqual({ stage: "json_parsed", httpStatus: 500, jsonRootType: "object", exception: null });
  expect(state.classification).toBe("BLOCKED: E2E protected response/accounting unavailable");
});
it("leaves protected structured responses on the existing accounting/output path", async () => {
  const state = createE2EState(prepared), events: string[] = [];
  const metadata = { marker: E2E_MARKER, bindingAttempts: [], ok: false };
  const send = vi.fn(async () => new Response(JSON.stringify(metadata), { status: 502 }));
  const post = vi.fn(async (_payload: typeof prepared.payload, _runId: string, onHeaders: (status: number) => Promise<void>) => captureE2EHttpResponse(send, onHeaders));
  await runCurrentDefaultE2E(state, prepared, post, async event => { events.push(event); }, "unused");
  expect(state.httpObservation).toEqual({ stage: "json_parsed", httpStatus: 502, jsonRootType: "object", exception: null });
  expect(state.accounting).toBe("known"); expect(state.result).toEqual(metadata); expect(state.png).toBeNull();
  expect(state.classification).toBe("CURRENT_DEFAULT_V3_E2E_FAILED");
  expect(events).toEqual(["currentDefaultE2EGenerateIntent", "currentDefaultE2EPostStarted",
    "currentDefaultE2EHttpHeadersReceived", "currentDefaultE2EResponseCaptured", "currentDefaultE2EOutputSaved"]);
  expect(send).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce();
});
it("retains unknown callback phase for an uninstrumented legacy caller", async () => {
  const state = createE2EState(prepared), post = vi.fn(async () => { throw new SyntaxError(sentinel); });
  await runCurrentDefaultE2E(state, prepared, post, async () => {}, "unused");
  expect(state.httpObservation).toMatchObject({ stage: "post_callback", httpStatus: null, exception: { name: "SyntaxError" } });
  expect(state.httpStatus).toBeNull(); expect(state.accounting).toBe("unknown");
  expect(post).toHaveBeenCalledOnce();
});
it("stops at failed header checkpoint without reading the body or repeating the POST", async () => {
  const state = createE2EState(prepared), json = vi.fn(async () => ({}));
  const send = vi.fn(async () => ({ status: 200, json }));
  const post = vi.fn(async (_payload: typeof prepared.payload, _runId: string, onHeaders: (status: number) => Promise<void>) => captureE2EHttpResponse(send, onHeaders));
  const persist = vi.fn(async (event: string) => { if (event === "currentDefaultE2EHttpHeadersReceived") throw new Error(sentinel); });
  await expect(runCurrentDefaultE2E(state, prepared, post, persist, "unused")).rejects.toThrow("e2e_http_checkpoint_failed");
  expect(json).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
  expect(state.accounting).toBe("unknown"); expect(state.result).toBeNull();
  await expect(runCurrentDefaultE2E(state, prepared, post, persist, "unused")).rejects.toThrow("already_consumed");
  expect(post).toHaveBeenCalledOnce();
});
it("keeps capture open while JSON is pending, then permits one-shot q after the failure checkpoint", async () => {
  const state = createE2EState(prepared);
  let entered!: () => void, rejectBody!: (error: Error) => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const body = new Promise<never>((_resolve, reject) => { rejectBody = reject; });
  const sendQ = vi.fn(), latch = new AuditShutdownLatch({ ownerAlive: () => true, registrationProven: () => true,
    checkpointIntent: async () => {}, sendQ, onFailure: () => {} });
  const directory = path.join(root, "pending-body"); fs.mkdirSync(directory);
  const file = path.join(directory, "summary.json");
  const post = vi.fn(async (_payload: typeof prepared.payload, _runId: string, onHeaders: (status: number) => Promise<void>) => captureE2EHttpResponse(async () => ({ status: 503,
    json: () => { entered(); return body; } }), onHeaders));
  const running = runCurrentDefaultE2E(state, prepared, post, async event => { await atomicCheckpoint(file, state, event); }, directory);
  await entering;
  expect((await readLatestAuditCheckpoint(file))?.event).toBe("currentDefaultE2EHttpHeadersReceived");
  latch.assertCapturing(); await latch.tryQ(); expect(sendQ).not.toHaveBeenCalled();
  rejectBody(new SyntaxError(sentinel)); await running;
  expect((await readLatestAuditCheckpoint(file))?.event).toBe("currentDefaultE2EHttpBodyUnavailable");
  latch.beginShutdown(); await latch.tryQ(); await latch.tryQ(); expect(sendQ).toHaveBeenCalledOnce();
  latch.beginFinalization(); latch.finalize();
  expect(() => latch.assertCapturing()).toThrow("audit_run_consumed"); expect(post).toHaveBeenCalledOnce();
});
it("preserves the exact existing E2E fetch expression, timeout and request options", () => {
  const source = fs.readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
  const file = ts.createSourceFile("runner.ts", source, ts.ScriptTarget.Latest, true), matches: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "fetch"
      && node.arguments[0]?.getText(file).includes("/current-default-e2e-audit")) matches.push(node.getText(file));
    ts.forEachChild(node, visit);
  }; visit(file);
  expect(matches).toHaveLength(1);
  expect(sha(matches[0])).toBe("b3ddfde18caaebb4766745ecac932cf9b6d30c712bd5b1a271dccceca7f3af22");
});
afterAll(() => {
  expect(productionHash()).toBe(productionBefore);
  expect(historicalNames.map(f => [f, sha(fs.readFileSync(path.join(historicalRoot, f)))])).toEqual(historicalHashes);
  fs.writeFileSync(path.join(root, "verification.json"), JSON.stringify({ mode: "offline_mocked_responses_only",
    remoteStartupAttempts: 0, networkCalls: 0, providerCalls: 0, originalImageReads: 0,
    fetchExpressionSha256: "b3ddfde18caaebb4766745ecac932cf9b6d30c712bd5b1a271dccceca7f3af22",
    productionFileCount: fixedFiles.length, productionHashesBeforeAfterEqual: true,
    productionHash: productionBefore, historical003JsonUnchanged: true,
    historical003HttpSubtype: "unrecoverable_not_inferred", outcomes }, null, 2), { flag: "wx" });
  console.info(`E2E_RESPONSE_OBSERVATION_OFFLINE ${root}`);
});
