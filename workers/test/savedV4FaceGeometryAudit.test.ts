import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FACE_GEOMETRY_MODEL, FACE_GEOMETRY_TIMEOUT_MS, faceIdentityGeometryRequest,
  parseFaceIdentityGeometry } from "../src/faceIdentityGeometry";
import { bytesToBase64 } from "../src/png";
import type { Env } from "../src/types";
import { acceptedFaceGeometry, SAVED_V4_CROP_SHA, verifySavedV4FaceCropBytes,
  verifySavedV4FaceCropMetadata } from "./audit/savedV4FaceGeometry";
import auditWorker from "./primaryFaceMeasurementAuditWorker";
import { accountingOf, atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";

const token = "offline-test-token";
const rawGeometry = {
  face: { envelopeLeft: 0.1, envelopeRight: 0.9, foreheadY: 0.12, chinY: 0.96 },
  eyes: { leftCenterX: 0.3, leftCenterY: 0.4, rightCenterX: 0.7, rightCenterY: 0.4,
    leftWidth: 0.16, rightWidth: 0.16, openness: 0.6 },
  brows: { leftY: 0.28, rightY: 0.28, thickness: 0.5, tilt: 0.1 },
  nose: { centerX: 0.5, contrastY: 0.6, visibleStrength: 0.4 },
  mouth: { centerX: 0.5, centerY: 0.74, width: 0.24, leftCornerY: 0.74, rightCornerY: 0.74, opening: "closed" },
  confidence: { faceBounds: 0.9, eyes: 0.9, brows: 0.9, nose: 0.9, mouth: 0.9 },
  directLowerFaceContour: {
    cheek: { left: 0.2, right: 0.8, y: 0.6, evidence: "observed", confidence: 0.9 },
    jaw: { left: 0.25, right: 0.75, y: 0.76, evidence: "observed", confidence: 0.9 },
    chin: { left: 0.35, right: 0.65, y: 0.88, evidence: "observed", confidence: 0.9 },
  },
};
afterEach(() => vi.unstubAllGlobals());

it("pins authoritative V4 evidence and exact reviewed crop without remote execution", async () => {
  const saved = await verifySavedV4FaceCropMetadata();
  expect(saved.first.sequence).toBe(21);
  expect(saved.final.sequence).toBe(33);
  expect(saved.evidence.caseId).toBe("wavy-open-blazer");
  const bytes = await verifySavedV4FaceCropBytes();
  expect(saved.crop.encodedSha256).toBe(SAVED_V4_CROP_SHA);
  const url = `data:image/png;base64,${bytesToBase64(bytes)}`;
  const request = faceIdentityGeometryRequest(url);
  expect(request).toMatchObject({ model: FACE_GEOMETRY_MODEL, imageDataUrls: [url],
    timeoutCapMs: FACE_GEOMETRY_TIMEOUT_MS, allowWorkersAiFallback: false });
  expect(url.startsWith("data:image/png;base64,")).toBe(true);
  expect(request.imageDataUrls).toHaveLength(1);
});

it("sends only the frozen PNG to the geometry binding and durably restores only accepted fields", async () => {
  const network = vi.fn(() => { throw new Error("external_network_forbidden"); });
  vi.stubGlobal("fetch", network);
  const bytes = await verifySavedV4FaceCropBytes();
  const imageDataUrl = `data:image/png;base64,${bytesToBase64(bytes)}`;
  const gemma = vi.fn(async () => ({ response: rawGeometry }));
  const gateway = vi.fn(() => { throw new Error("primary_path_forbidden"); });
  const env = { PRIMARY_AUDIT_TOKEN: token, AI: { run: gemma, gateway } } as unknown as Env & { PRIMARY_AUDIT_TOKEN: string };
  const runId = randomBytes(16).toString("hex");
  const response = await auditWorker.fetch(new Request("http://audit.invalid/face-geometry-direct-audit", {
    method: "POST", headers: { "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
    body: JSON.stringify({ imageDataUrl }),
  }), env);
  const result = await response.json() as { ok: boolean; geometry: ReturnType<typeof parseFaceIdentityGeometry>;
    auditState: unknown; providerShapeValid: boolean; errors: string[]; inputMode: string; crop: unknown };
  expect(response.status).toBe(200);
  expect(result).toMatchObject({ ok: true, providerShapeValid: true, errors: [],
    inputMode: "direct_frozen_face_crop", crop: null });
  expect(accountingOf(result.auditState, runId)).toMatchObject({ dispatch: "known",
    providerCalls: { geminiStarted: 0, gemmaStarted: 1, gemmaCompleted: 1, retry: 0 } });
  expect(gemma).toHaveBeenCalledTimes(1);
  const [model, input] = gemma.mock.calls[0] as unknown as [string, { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> }];
  expect(model).toBe(FACE_GEOMETRY_MODEL);
  expect(input.messages[0].content.filter(part => part.type === "image_url"))
    .toEqual([{ type: "image_url", image_url: { url: imageDataUrl } }]);
  expect(gateway).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
  const accepted = acceptedFaceGeometry(result.geometry!);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "saved-v4-face-geometry-test-"));
  try {
    const checkpoint = path.join(root, "summary.json");
    await atomicCheckpoint(checkpoint, { caseId: "wavy-open-blazer", cropSha256: SAVED_V4_CROP_SHA,
      acceptedGeometry: accepted }, "accepted_geometry_saved");
    const recovered = await readLatestAuditCheckpoint(checkpoint);
    expect(recovered?.event).toBe("accepted_geometry_saved");
    expect(acceptedFaceGeometry((recovered?.snapshot as { acceptedGeometry: typeof accepted }).acceptedGeometry))
      .toEqual(accepted);
    const stored = JSON.stringify(recovered);
    expect(stored).not.toContain("data:image/");
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("portraitEvidence");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
