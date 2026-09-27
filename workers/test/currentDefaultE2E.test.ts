import { afterEach, expect, it, vi } from "vitest";
import { encode } from "jpeg-js";
import { readFileSync } from "node:fs";
import type { Env } from "../src/types";
import { makeAnalysis } from "./helpers";
import { wireFixture, namedGemmaFixture } from "./compactV3Support";
import { E2E_MARKER, imageIdentity, boundedProjection } from "./audit/currentDefaultE2E";
import { base64ToBytes, decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { createE2EState, runCurrentDefaultE2E, type prepareCurrentDefaultE2E } from "./audit/currentDefaultE2ELive";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const jpeg = (width: number, height: number) => `data:image/jpeg;base64,${Buffer.from(encode({ width, height,
  data: Buffer.alloc(width * height * 4, 255) }, 85).data).toString("base64")}`;
const payload = { image: jpeg(299, 448), analysisImage: jpeg(597, 896) };
const identity = Promise.all([imageIdentity(payload.analysisImage), imageIdentity(payload.image)]);
async function setup(failure?: "fallback" | "invalid", facialHairEvidence = false, croppedHairEvidence: boolean | "qualified" = false, plaidPaletteEvidence = false, storedGeometryEvidence: boolean | "008" = false) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external_network_forbidden_in_offline_test"); }));
  const { default: worker } = await import("./primaryFaceMeasurementAuditWorker");
  const stored = storedGeometryEvidence ? JSON.parse(readFileSync(storedGeometryEvidence === "008"
    ? "evaluation-artifacts/current-default-v3-e2e-baseline-20260927-008/summary.json"
    : "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json", "utf8")).currentDefaultE2E.result : null;
  const fixtureAnalysis = stored ? makeAnalysis({ ...stored.diagnostics.normalizedPrimary,
    // The saved allowlist has normalized region metadata, not a complete wire
    // sourceSelection. Use the explicit synthetic single-image test context.
    sourceSelection: makeAnalysis().sourceSelection,
    identityPrompt: stored.diagnostics.normalizedPrimary.observed.hair, outfitPrompt: stored.diagnostics.normalizedPrimary.observed.clothing }) : makeAnalysis();
  if (croppedHairEvidence) {
    fixtureAnalysis.observed.hair = croppedHairEvidence === "qualified"
      ? "Very short, almost bald hair, showing the scalp closely."
      : "Very short, closely cropped black hair following the scalp, with no visible fringe or parting.";
    fixtureAnalysis.canonicalIdentity.mustPreserve = ["Dark complexion", croppedHairEvidence === "qualified"
      ? "Bald/very short hair head silhouette" : "Closely cropped black hair", "Neutral face", "Collared shirt"];
    fixtureAnalysis.canonicalIdentity.features = fixtureAnalysis.canonicalIdentity.features.map(f => f.category === "hair"
      ? { ...f, feature: croppedHairEvidence === "qualified" ? "very short/bald hair" : "Closely cropped black hair",
        evidence: "Scalp-close dark hair with no fringe" } : f);
    fixtureAnalysis.fallbackFeatures.hairstyle = "curly";
    fixtureAnalysis.renderHints = { ...fixtureAnalysis.renderHints, hairTexture: "coily", hairVolume: "flat",
      overallHairLength: "cropped", bangs: "none", bangsLength: "none", sideHairLength: "none", hairAccessory: "none" };
  }
  if (plaidPaletteEvidence) {
    fixtureAnalysis.observed.clothing = "A collared button-down shirt with a small-scale plaid/checkered pattern in shades of blue, tan, and dark brown.";
    fixtureAnalysis.fallbackFeatures.topType = "shirt";
    fixtureAnalysis.fallbackFeatures.topAccentColor = "white";
    fixtureAnalysis.renderHints.garmentTexture = "patterned";
    fixtureAnalysis.renderHints.outerGarment = "none";
  }
  const fixture = wireFixture(fixtureAnalysis);
  if (facialHairEvidence) {
    fixture.observed.face = "Oval face with groomed dark mustache and goatee.";
    fixture.canonicalIdentity.mustPreserve.push("Groomed goatee and mustache");
    fixture.fallbackFeatures!.facialHair = "none";
  }
  const gatewayRun = vi.fn(async () => failure
    ? Response.json({ error: { status: failure === "fallback" ? "FAILED_PRECONDITION" : "INVALID_ARGUMENT" } }, { status: 400 })
    : Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(fixture) }] } }] }));
  const nativeRun = vi.fn(async (_model: string, body: Record<string, unknown>) => {
    const schema = (body.response_format as { json_schema: { schema: { properties: Record<string, unknown> } } }).json_schema.schema;
    if ("face" in schema.properties) {
      if (stored) {
        const accepted = stored.diagnostics.geometry.acceptedGeometry;
        const wire = structuredClone(accepted);
        delete wire.source; delete wire.eyes.interEyeDistance; delete wire.eyes.verticalAsymmetry; delete wire.nose.leftRightBias;
        return { response: wire };
      }
      return { response: {} }; // Deliberate invalid optional geometry; production fail-open must be preserved.
    }
    return { response: namedGemmaFixture(fixture) };
  });
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
  const env = { GEMINI_API_KEY: "offline-only", PRIMARY_AUDIT_TOKEN: "offline-token", VISION_MODEL: "gemini-3.8-flash",
    WORKERS_VISION_MODEL: "@cf/google/gemma-4-26b-a4b-it", FACE_GEOMETRY_ENRICHMENT_ENABLED: "true",
    GEMINI_STRUCTURED_TIMEOUT_MS: "45000", AI: { gateway: () => ({ run: gatewayRun }), run: nativeRun }, MCSKIN_KV: kv };
  const [analysis, generation] = await identity;
  const request = (changes: Record<string, string> = {}, body: unknown = payload) => new Request("https://offline/current-default-e2e-audit", {
    method: "POST", headers: { "content-type": "application/json", "x-primary-audit-token": "offline-token",
      "x-primary-audit-run-id": "a".repeat(32), "x-current-default-e2e": E2E_MARKER,
      "x-e2e-analysis-sha": analysis.sha256, "x-e2e-generation-sha": generation.sha256, ...changes }, body: JSON.stringify(body),
  });
  return { worker, env: env as unknown as Env, gatewayRun, nativeRun, kv, request };
}
it("carries corroborated facial hair through the actual handler and Gemma fallback into final PNG", async () => {
  // All provider bindings are mocks; the production handler and renderer are real.
  const s = await setup("fallback", true);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ ok: true, features: { facialHair: "goatee" },
    diagnostics: { normalizedPrimary: { fallbackFeatures: { facialHair: "goatee" } },
      primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64 as string))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(2); // Gemma primary + deliberately rejected optional geometry.
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [undefined, true], ["fallback", true], [undefined, "qualified"], ["fallback", "qualified"],
] as const)("carries scalp-close evidence through real V3 handler to a surface-only PNG (%s / %s)", async (failure, evidence) => {
  const s = await setup(failure, false, evidence);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; analysis: { skinPlan: { hairPlan: { surfaceOnly: boolean; texture: string }; headIdentityPlan: { outerHairGroupIds: string[] } } } };
  expect(body.analysis.skinPlan.hairPlan).toMatchObject({ surfaceOnly: true, texture: "coily" });
  expect(body.analysis.skinPlan.headIdentityPlan.outerHairGroupIds).toEqual([]);
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  for (let y = 0; y < 8; y++) for (let x = 40; x < 48; x++) expect(atlas.rgba[(y * 64 + x) * 4 + 3]).toBe(0);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("renders stored bald/long-sleeve evidence through V3 without cross-field long hair (%s)", async failure => {
  const s = await setup(failure, false, false, false, "008");
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string;
    diagnostics: { geometry: { semanticPass: boolean } };
    analysis: { skinPlan: { hairPlan: { template: string }; facePixelPlan: { source: string } } } };
  expect(body.diagnostics.geometry.semanticPass).toBe(true);
  expect(body.analysis.skinPlan.hairPlan.template).toBe("bald");
  expect(body.analysis.skinPlan.facePixelPlan.source).toBe("identity_geometry");
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it("protects the adapter without adding a public production route", async () => {
  const s = await setup();
  expect((await s.worker.fetch(s.request({ "x-primary-audit-token": "wrong" }), s.env)).status).toBe(403);
  expect((await s.worker.fetch(s.request({ "x-current-default-e2e": "wrong" }), s.env)).status).toBe(400);
  expect((await s.worker.fetch(new Request("https://offline/api/generate", { method: "POST",
    headers: { "x-primary-audit-token": "offline-token" } }), s.env)).status).toBe(404);
  expect(s.gatewayRun).not.toHaveBeenCalled(); expect(s.nativeRun).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains accepted geometry through real handler without mistaking goatee for complexion (%s)", async failure => {
  const s = await setup(failure, false, false, false, true);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; diagnostics: { geometry: { semanticPass: boolean } };
    analysis: { skinPlan: { facePixelPlan: { source: string; layout: { geometryUsage: { eyes: boolean; mouth: boolean } } } } } };
  expect(body.diagnostics.geometry.semanticPass).toBe(true);
  expect(body.analysis.skinPlan.facePixelPlan).toMatchObject({ source: "identity_geometry", layout: { geometryUsage: { eyes: true, mouth: true } } });
  expect(validateFinalAtlas(await decodePng(base64ToBytes(body.skinPngBase64))).ok).toBe(true);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("retains observed plaid tan through real V3 handler and final PNG (%s)", async failure => {
  const s = await setup(failure, false, false, true);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as { skinPngBase64: string; analysis: { skinPlan: { outfitPlan: { upper: { pattern: { color: string } } } } } };
  expect(body.analysis.skinPlan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  let tanPixels = 0;
  for (let y = 16; y < 32; y++) for (let x = 16; x < 40; x++) {
    const p = (y * 64 + x) * 4;
    if (atlas.rgba[p] === 197 && atlas.rgba[p + 1] === 170 && atlas.rgba[p + 2] === 130 && atlas.rgba[p + 3] === 255) tanPixels++;
  }
  expect(tanPixels).toBeGreaterThan(0);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "fallback"] as const)("reuses actual production handler; optional geometry rejection preserves valid PNG (%s)", async failure => {
  const s = await setup(failure);
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ ok: true, generationMode: "procedural_fallback", contract: "primary_compact_v3_legacy_suffix",
    diagnostics: { primaryValidation: { providerShapePass: true, strictRuntimePass: true, normalizationPass: true, richValidationPass: true },
      geometry: { providerShapePass: false, semanticPass: false, acceptedGeometry: null } } });
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  expect(s.nativeRun).toHaveBeenCalledTimes(failure ? 2 : 1);
  expect(s.kv.get).toHaveBeenCalled(); // Real handler quota path, no injected fake quota inside the adapter.
  const atlas = await decodePng(base64ToBytes(body.skinPngBase64 as string));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  expect((await s.worker.fetch(s.request(), s.env)).status).toBe(409);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1);
  const { skinPngBase64: png, ...metadata } = body;
  expect(png).toBeTruthy();
  expect(JSON.stringify(metadata)).not.toMatch(/offline-token|offline-only|data:image|base64,/);
});
it("does not turn an ineligible primary failure into fallback or geometry", async () => {
  const s = await setup("invalid");
  const response = await s.worker.fetch(s.request(), s.env);
  expect(response.status).not.toBe(200);
  expect(s.gatewayRun).toHaveBeenCalledTimes(1); expect(s.nativeRun).not.toHaveBeenCalled();
});
it("rejects raw-original-shaped or opt-in injected payload before provider dispatch", async () => {
  const s = await setup();
  expect((await s.worker.fetch(s.request({}, { ...payload, expectedContractVersion: "primary_compact_v4_structured_localization" }), s.env)).status).toBe(400);
  expect(s.gatewayRun).not.toHaveBeenCalled();
});
it("keeps one production handler call and the original preprocessing implementation", () => {
  const adapter = readFileSync("test/audit/currentDefaultE2E.ts", "utf8");
  expect(adapter.match(/productionWorker\.fetch\(/g)).toHaveLength(1);
  expect(adapter).not.toMatch(/runPhotoAnalysis\(|generateSkin\(|SYNCHRONOUS_ENHANCEMENTS_ENABLED\s*:/);
  const browser = readFileSync("test/audit/currentDefaultPreprocess.mjs", "utf8");
  expect(browser).toContain("preparePhotoForUpload(source)");
  expect(browser).not.toMatch(/drawImage\(|Math\.round|resize/);
  expect(boundedProjection({ secret: "hidden", value: "data:image/jpeg;base64,abc", safe: "striped" }))
    .toEqual({ value: "[redacted]", safe: "striped" });
});

it.each([1, 2])("does not POST when authoritative checkpoint %s fails", async failAt => {
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  let writes = 0;
  const post = vi.fn();
  await expect(runCurrentDefaultE2E(state, prepared, post, async () => {
    if (++writes === failAt) throw new Error("checkpoint_unavailable");
  }, "unused")).rejects.toThrow("checkpoint_unavailable");
  expect(post).not.toHaveBeenCalled();
});

it("does not retry an unobserved generation response or invent provider counts", async () => {
  const prepared = { payload } as Awaited<ReturnType<typeof prepareCurrentDefaultE2E>>;
  const state = createE2EState(prepared);
  const post = vi.fn(async () => { throw new Error("transport_unobserved"); });
  await runCurrentDefaultE2E(state, prepared, post, async () => {}, "unused");
  expect(post).toHaveBeenCalledTimes(1);
  expect(state.accounting).toBe("unknown");
  expect(state.result).toBeNull();
  await expect(runCurrentDefaultE2E(state, prepared, post, async () => {}, "unused"))
    .rejects.toThrow("e2e_generation_already_consumed");
  expect(post).toHaveBeenCalledTimes(1);
});
