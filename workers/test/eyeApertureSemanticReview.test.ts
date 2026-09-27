import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { extractAnalysisPayload } from "../src/analysis";
import auditWorker from "./primaryFaceMeasurementAuditWorker";
import { readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { APERTURE_INPUTS, APERTURE_OPTIONS, aperturePilotRequest, apertureRequestIdentity } from "./audit/eyeAperturePilotContract";
import { deriveEyeApertureRatio, EYE_APERTURE_SCHEMA, EYE_APERTURE_PROMPT, buildEyeAperturePrototypeRequest } from "./audit/eyeAperturePrototype";
import { abstainingEye, chordPlacementProbe, evaluateExample, measurableExample, semanticExamples, tiltedExample } from "./audit/eyeApertureSemanticReview";

const ROOT = path.resolve("evaluation-artifacts/eye-aperture-semantic-contract-review-20260926-001");
const PILOT = path.resolve("evaluation-artifacts/experimental-eye-aperture-two-crop-pilot-20260926-001");
const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
const examples = semanticExamples();
const parity: Array<Record<string, unknown>> = [];
const network = vi.fn(() => { throw new Error("external_network_forbidden"); });
beforeAll(() => vi.stubGlobal("fetch", network));
afterAll(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

for (const example of examples) it(`specification truth table: ${example.id}`, () => {
  expect(evaluateExample(example).agrees).toBe(true);
});

it("checks independent pixel arithmetic and image-plane tilt without borrowing expected logic from validator", () => {
  const ratio = deriveEyeApertureRatio(measurableExample());
  expect(ratio.left).toBeCloseTo(10 / 40); expect(ratio.right).toBeCloseTo(12 / 40); expect(ratio.mean).toBeCloseTo(11 / 40);
  const tilted = deriveEyeApertureRatio(tiltedExample());
  expect(tilted.left).toBeCloseTo(ratio.left!); expect(tilted.right).toBeCloseTo(ratio.right!);
});

it("separates nullable-state validity from measurement availability and audits predicate ordering", () => {
  const row = (id: string) => evaluateExample(examples.find(e => e.id === id)!).actual;
  expect(row("both-unknown")).toMatchObject({ semanticContractValid: true, measurementAvailable: false, binocularMeasurementAvailable: false, validationErrors: [] });
  expect(row("only-left-measured")).toMatchObject({ semanticContractValid: true, measurableEyes: ["left"], binocularMeasurementAvailable: false });
  expect(row("unknown-reversed-corners").validationErrors).toEqual([
    "eyeAperture.left:corner_order", "eyeAperture.right:corner_order", "eyeAperture:viewer_left_right_order",
    "eyeAperture.left:unknown_requires_null_and_zero_confidence", "eyeAperture.right:unknown_requires_null_and_zero_confidence",
  ]);
  expect(row("null-x-corner").validationErrors).toEqual(["eyeAperture.left:observed_requires_landmarks"]);
  expect(row("null-y-reversed-corner").validationErrors).toEqual(["eyeAperture.left:corner_order", "eyeAperture.left:observed_requires_landmarks"]);
  expect(row("shape-before-semantic").validationErrors).toEqual(["eyeAperture.left.visibility:enum"]);
});

it("records an unadvertised chord-straddling requirement without changing it or reconstructing live values", () => {
  const probe = chordPlacementProbe();
  expect(probe.schemaValid).toBe(true);
  expect(probe.actual.ok).toBe(false);
  expect(probe.actual.errors).toEqual(["eyeAperture.left:invalid_chord_or_lid_geometry"]);
  expect(EYE_APERTURE_PROMPT).not.toMatch(/straddl|opposite sides|above.*chord|below.*chord/i);
  expect(probe.expectedFromPromptAlone).toBe("UNRESOLVED_CONTRACT_DECISION");
});

const formats = ["response-object", "response-json", "choices-json", "response-text-blocks"] as const;
for (const format of formats) it(`actual protected adapter preserves DTO and final wire via fake binding: ${format}`, async () => {
  for (const state of ["measured", "abstain", "partial", "contradictory"] as const) {
    const input = format === "choices-json" ? 1 : 0;
    const cropPath = input === 0 ? "evaluation-artifacts/v4-saved-localization-crop-readiness-20260925-001/face-crop.png"
      : "evaluation-artifacts/v4-open-localization-crop-geometry-live-20260926-002/face-crop.png";
    const bytes = fs.readFileSync(cropPath); expect(sha(bytes)).toBe(APERTURE_INPUTS[input].sha256);
    const imageDataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const dto = measurableExample(); dto.cropWidthPx = APERTURE_INPUTS[input].widthPx; dto.cropHeightPx = APERTURE_INPUTS[input].heightPx;
    if (state === "abstain") { dto.left = abstainingEye(); dto.right = abstainingEye("blink"); }
    if (state === "partial") dto.right = abstainingEye("occluded");
    if (state === "contradictory") dto.left.visibility = "unknown";
    const json = JSON.stringify(dto);
    const fakeResult = format === "response-object" ? { response: structuredClone(dto) }
      : format === "response-json" ? { response: `\n\`\`\`json\n${json}\n\`\`\`` }
      : format === "choices-json" ? { choices: [{ message: { content: json } }] }
      : { response: [{ text: json.slice(0, 40) }, { text: json.slice(40) }] };
    expect(extractAnalysisPayload(fakeResult)).toEqual(dto);
    const before = JSON.stringify(fakeResult);
    let capturedWireHash = "", capturedPromptHash = "", capturedSchemaHash = "";
    const run = vi.fn(async (model: string, raw: unknown) => {
      expect(model).toBe(APERTURE_OPTIONS.model);
      const wire = raw as { messages: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
        max_completion_tokens: number; chat_template_kwargs: { enable_thinking: boolean };
        response_format: { type: string; json_schema: { schema: unknown; strict: boolean } } };
      const original = buildEyeAperturePrototypeRequest(imageDataUrl, dto.cropWidthPx, dto.cropHeightPx);
      expect(wire.messages).toHaveLength(1); expect(wire.messages[0].content).toHaveLength(2);
      expect(sha(wire.messages[0].content[0].image_url!.url)).toBe(sha(imageDataUrl));
      expect(wire.messages[0].content[1].text).toBe(original.prompt);
      expect(wire.response_format.json_schema.schema).toBe(EYE_APERTURE_SCHEMA);
      expect(wire).toMatchObject({ max_completion_tokens: 4096, chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_schema", json_schema: { strict: true } } });
      expect(Object.hasOwn(wire, "temperature")).toBe(false);
      const request = aperturePilotRequest(imageDataUrl, input);
      expect(request.timeoutCapMs).toBe(25000); expect(request.allowWorkersAiFallback).toBe(false);
      capturedWireHash = sha(JSON.stringify(wire)); capturedPromptHash = sha(wire.messages[0].content[1].text!);
      capturedSchemaHash = sha(JSON.stringify(wire.response_format.json_schema.schema));
      return fakeResult;
    });
    const gateway = vi.fn(() => { throw new Error("primary_gateway_forbidden"); });
    const token = randomBytes(16).toString("hex"), id = () => randomBytes(16).toString("hex");
    const env = { PRIMARY_AUDIT_TOKEN: token, AI: { run, gateway } } as unknown as Env & { PRIMARY_AUDIT_TOKEN: string };
    // Each endpoint pilot starts at slot 0 (NORMAL); OPEN wire tested directly below.
    let body: Record<string, unknown>;
    if (input === 0) {
      const response = await auditWorker.fetch(new Request("http://offline.invalid/experimental-eye-aperture-audit", {
        method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": id() },
        body: JSON.stringify({ imageDataUrl, pilotRunId: id(), slot: 0 }),
      }), env);
      expect(response.status).toBe(200); body = await response.json() as Record<string, unknown>;
    } else {
      const { runExperimentalAperture } = await import("./audit/eyeAperturePilotContract");
      body = await Response.json(await runExperimentalAperture(env, imageDataUrl, input)).json() as Record<string, unknown>;
    }
    expect(run).toHaveBeenCalledTimes(1); expect(gateway).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(fakeResult)).toBe(before);
    expect(body.providerShapeValid).toBe(true); expect(body.semanticValid).toBe(state !== "contradictory");
    expect(body.accepted).toEqual(state === "contradictory" ? null : dto);
    expect(JSON.stringify(body)).not.toContain(imageDataUrl); expect(JSON.stringify(body)).not.toContain(token);
    const identity = await apertureRequestIdentity(imageDataUrl, input);
    expect(identity).toEqual({ promptSha256: capturedPromptHash, schemaSha256: capturedSchemaHash, wireSha256: capturedWireHash });
    const historical = await readLatestAuditCheckpoint(path.join(PILOT, "summary.json"));
    const old = historical!.snapshot as { aperturePilot: { inputs: Array<{ requestIdentity: unknown }> } };
    expect(identity).toEqual(old.aperturePilot.inputs[input].requestIdentity);
    parity.push({ format, state, input, fakeBindingOnly: true, externalCalls: 0, finalWireEqualsHistoricalHash: true,
      requestIdentity: identity, dtoFieldsPreserved: state !== "contradictory", rejectedPayloadDiscarded: state === "contradictory",
      providerShapeValid: body.providerShapeValid, semanticContractValid: body.semanticValid,
      measurementAvailable: state === "measured" || state === "partial" });
  }
});

it("does not coerce enums or numeric tokens during actual extraction", () => {
  const value = measurableExample();
  const modified = { ...value, left: { ...value.left, visibility: " observed ", confidence: "0.9" } };
  expect(extractAnalysisPayload({ response: JSON.stringify(modified) })).toEqual(modified);
  expect(extractAnalysisPayload(value)).toBeNull(); // Unwrapped DTO is not a binding envelope.
  expect(extractAnalysisPayload({ response: null, choices: [{ message: { content: JSON.stringify(value) } }] })).toBeNull();
  expect(extractAnalysisPayload({ response: "not-json" })).toBeNull();
});

it.skipIf(process.env.WRITE_EYE_APERTURE_SEMANTIC_REVIEW !== "approved-offline")("writes new offline evidence and preserves every frozen implementation/historical artifact byte", async () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "start-state.json"), "utf8")) as { hashes: Record<string, string> };
  for (const [file, expected] of Object.entries(baseline.hashes)) expect(sha(fs.readFileSync(file)), file).toBe(expected);
  const checkpoint = await readLatestAuditCheckpoint(path.join(PILOT, "summary.json"));
  const snapshot = checkpoint!.snapshot as { classification: string; aperturePilot: { slots: Array<{
    id: string; status: string; httpStatus: number; accepted: unknown; derived: unknown; outcome: {
      providerShapeValid: boolean; semanticValid: boolean; semanticErrors: string[]; requestIdentity: unknown;
    } }> } };
  const observed = { checkpointSequence: checkpoint!.sequence, checkpointSha256: checkpoint!.snapshotSha256,
    originalClassification: snapshot.classification, executionCompleted: true, acceptedLandmarks: 0,
    ratioOverlayRepeatabilityAccuracy: "NOT_MEASURED", slots: snapshot.aperturePilot.slots.map(slot => ({ id: slot.id,
      status: slot.status, auditHttpStatus: slot.httpStatus, providerShapeValid: slot.outcome.providerShapeValid,
      semanticValid: slot.outcome.semanticValid, errorsInOrder: slot.outcome.semanticErrors, requestIdentity: slot.outcome.requestIdentity })) };
  expect(snapshot.aperturePilot.slots.every(s => s.accepted === null && s.derived === null)).toBe(true);
  expect(parity).toHaveLength(16);
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("observed-error-paths.json", observed);
  write("state-truth-table.json", { expectationMethod: "Independent prompt/schema examples and explicit pixel fixtures; no copied validator branch as expected oracle",
    syntheticOnly: true, notHistoricalReconstruction: true, rows: examples.map(evaluateExample) });
  write("request-validator-parity.json", { boundary: "prototype builder -> native request -> fake AI.run response -> actual extractor -> shape -> semantic -> Response.json -> parsed result",
    externalCalls: 0, valuesTrimmedCoercedDefaulted: false, namedEyeFieldsSwapped: false,
    note: "12 cases traversed protected endpoint; 4 OPEN cases traversed its exact adapter plus same serializer. Existing slot guard remains unchanged.",
    currentNativeSchemaEqualsPrototype: true, historicalHashEvidenceAvailable: true,
    schemaNameMetadata: "minecraft_skin_photo_analysis", schemaNameNote: "Inherited generic descriptor; actual experimental schema/version is identical. No causal claim for rejection.", cases: parity });
  write("synthetic-regressions.json", { unambiguousSpecificationCases: examples.length,
    allUnambiguousExpectedResultsMatch: examples.every(e => evaluateExample(e).agrees),
    normalStateValidatorDefectReproduced: false, valueOrSideMappingDefectReproduced: false,
    chordPlacementContractQuestion: chordPlacementProbe(),
    implementationAndHistoryHashesUnchanged: Object.keys(baseline.hashes).length, externalCalls: 0 });
  expect(network).not.toHaveBeenCalled();
});
