import { afterEach, expect, it, vi } from "vitest";
import { generateFreeSkin, freeQuotaStatus } from "../src/engineService";
import { FREE_VISION_MODEL, MAX_CALL_NEURONS, MAX_IMAGE_CALL_NEURONS, newBudgetState, reserveBudget, settleBudget, reportedGemmaNeurons } from "../src/freeBudget";
import { encodePng, bytesToBase64, base64ToBytes, decodePng } from "../src/png";
import { makeFourViewSheet, makeSyntheticAtlas } from "./helpers";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import { generateGeminiImage } from "../src/gemini";
import { fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { makeAnalysis } from "./helpers";
import { validatePhotoAnalysis } from "../src/analysis";
import { GENERATION_OBSERVER } from "../src/generationObservation";
afterEach(() => vi.restoreAllMocks());

it("carries the observed dress color into its skirt when no separate color is given", () => {
  const base = makeAnalysis();
  const photo = makeAnalysis({
    observed: { ...base.observed, clothing: "A white lace midi dress with a square neckline and tiered lace skirt; a light pink cardigan." },
    outfitPrompt: "White lace dress and a pink cardigan.",
    fallbackFeatures: { ...base.fallbackFeatures, bottomType: "skirt", bottomColor: "denim" },
  });
  const colors = refineFeatureColorsFromAnalysis(photo, fallbackFeaturesToHex(photo.fallbackFeatures));
  expect(colors.bottomColor).toBe("#f2f2f2");
  const contrast = makeAnalysis({ ...photo, observed: { ...photo.observed, clothing: "A white dress and a red skirt." } });
  const other = refineFeatureColorsFromAnalysis(contrast, fallbackFeaturesToHex(contrast.fallbackFeatures));
  expect(other.bottomColor).not.toBe("#f2f2f2");
});

it("recognizes a long dress as a skirt even if the word skirt is absent", () => {
  const base = makeAnalysis();
  const result = validatePhotoAnalysis({ ...base, fallbackFeatures: undefined,
    observed: { ...base.observed, clothing: "A white, sleeveless lace midi dress with a pink cardigan." },
    canonicalIdentity: { ...base.canonicalIdentity, mustPreserve: ["white lace dress", "long dark hair", "light skin"] },
    identityPrompt: "A person with long dark hair.", outfitPrompt: "A white sleeveless lace dress with a pink cardigan.",
  });
  expect(result.ok, result.ok ? undefined : result.errors.join(", ")).toBe(true);
  if (!result.ok) return;
  expect(result.analysis.fallbackFeatures.bottomType).toBe("skirt");
  const colors = refineFeatureColorsFromAnalysis(result.analysis, fallbackFeaturesToHex(result.analysis.fallbackFeatures));
  expect(colors.bottomColor).toBe("#f2f2f2");
});

it("renders the observed hoodie color instead of a conflicting fallback color", async () => {
  const s = await setup();
  const photo = semanticFixture("plain");
  photo.observed.clothing = "A light-gray hooded sweatshirt with a small dark graphic on the upper left chest. Black jeans. White socks with red and navy stripes near the top. No shoes are worn.";
  photo.outfitPrompt = "A light-gray hoodie and black jeans.";
  photo.visibleRegions.upperBody = true;
  photo.visibleRegions.lowerBody = true;
  photo.renderHints.outerGarment = "none";
  photo.fallbackFeatures.topColor = "blue";
  photo.fallbackFeatures.topType = "hoodie";
  photo.fallbackFeatures.sleeveLength = "short";
  const payload = namedGemmaFixture(wireFixture(photo));
  s.run.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: 9000, completion_tokens: 3000 } });
  const result = await generateFreeSkin(s.env, { image: s.image });
  expect(result.success).toBe(true);
  expect(result.body.features).toMatchObject({ topType: "hoodie", topColor: "#b7b7b7", sleeveLength: "long" });
  const atlas = await decodePng(base64ToBytes(result.body.skinPngBase64!));
  const pixel = (x: number, y: number) => [...atlas.rgba.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];
  const [red, , blue] = pixel(23, 25);
  expect(red).toBeGreaterThan(120);
  expect(Math.abs(red - blue)).toBeLessThan(25);
});
async function setup() {
  const image = `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(64)))}`;
  const state = newBudgetState(new Date().toISOString().slice(0, 10));
  const reserve = vi.fn(async (id: string) => ({ day: state.day, accepted: reserveBudget(state, id) }));
  const settle = vi.fn(async (_day: string, id: string, cost: number) => settleBudget(state, id, cost));
  const run = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(namedGemmaFixture(wireFixture(semanticFixture("plain")))) } }],
    usage: { prompt_tokens: 9000, completion_tokens: 3000 } }));
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
  const env = { AI: { run, gateway: vi.fn(() => { throw new Error("paid_gateway_forbidden"); }) },
    GEMINI_API_KEY: "credential-that-must-not-be-used", MCSKIN_KV: kv,
    NEURON_BUDGET: { getByName: () => ({ reserve, settle, status: async () => ({ day: state.day, used: state.used,
      available: 5000 - state.used, limit: 5000, closed: state.closed || state.used + MAX_CALL_NEURONS > 5000 }) }) },
    FACE_GEOMETRY_ENRICHMENT_ENABLED: "true", SYNCHRONOUS_ENHANCEMENTS_ENABLED: "true", IMAGE_GENERATION_ENABLED: "true",
  } as unknown as Env;
  return { image, state, reserve, settle, run, kv, env };
}
it("uses exactly one free model despite Gemini keys and enhancement flags, without project reservation", async () => {
  const s = await setup(), network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const result = await generateFreeSkin(s.env, { image: s.image });
  expect(result.success).toBe(true); expect(result.body.skinPngBase64).toBeTruthy();
  expect(validateFinalAtlas(await decodePng(base64ToBytes(result.body.skinPngBase64!))).ok).toBe(true);
  expect(s.run).toHaveBeenCalledTimes(1); expect(s.run.mock.calls[0][0]).toBe(FREE_VISION_MODEL);
  expect(s.reserve).not.toHaveBeenCalled(); expect(s.settle).not.toHaveBeenCalled();
  const wire = s.run.mock.calls[0][1]; expect(wire).toMatchObject({ temperature: 0, seed: 0, store: false, max_completion_tokens: 8192 });
  expect(JSON.stringify(wire)).toContain("Do not merge different outfits");
  expect(wire.messages[0].content[0].type).toBe("text");
  expect(wire.messages[0].content[1]).toMatchObject({ type: "image_url", image_url: { url: s.image } });
  expect(s.run.mock.calls[0][2]).toEqual({ extraHeaders: { "x-session-affinity": "mc-skin-analysis-v1" } });
  expect(result.body.analysis).toBeUndefined(); expect(s.kv.put).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  expect(result.neuronsSpent).toBe(reportedGemmaNeurons({ usage: { prompt_tokens: 9000, completion_tokens: 3000 } }));
  expect(await freeQuotaStatus(s.env)).toMatchObject({ capacityBasis: "provider_unknown", level: "unknown", remainingGenerations: null });
});
it("blocks oversize/malformed input and requires an AI binding", async () => {
  const s = await setup();
  expect((await generateFreeSkin(s.env, { image: "data:image/jpeg;base64,YQ==" })).status).toBe(400);
  const bomb = base64ToBytes(s.image.split(",")[1]); new DataView(bomb.buffer).setUint32(16, 100000);
  expect((await generateFreeSkin(s.env, { image: `data:image/png;base64,${bytesToBase64(bomb)}` })).status).toBe(400);
  expect((await generateFreeSkin({ ...s.env, AI: undefined }, { image: s.image })).status).toBe(503);
  expect(s.run).not.toHaveBeenCalled();
});
it("rejects a direct paid-image helper invocation under the free policy", async () => {
  const s = await setup(), net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not dispatch"));
  await expect(generateGeminiImage({ ...s.env, AI_POLICY: "workers_free_only" }, {
    model: "gemini-3.1-flash-image", prompt: "private prompt", images: [], seed: 0,
  })).rejects.toThrow("disabled by free policy");
  expect(net).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled();
});
it("does not retry failed analysis or store provider error content", async () => {
  const s = await setup(), log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  s.run.mockRejectedValue(new Error("private-photo data:image/jpeg;base64,secret API credential"));
  const result = await generateFreeSkin(s.env, { image: s.image });
  expect(result.success).toBe(false); expect(s.run).toHaveBeenCalledTimes(1);
  expect(s.reserve).not.toHaveBeenCalled(); expect(s.settle).not.toHaveBeenCalled(); expect(s.kv.put).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/private-photo|secret API/); expect(log).not.toHaveBeenCalled();
});
it("retains reservation on missing/invalid provider usage and rejects double settlement", () => {
  const state = newBudgetState("2026-10-13"), id = "a".repeat(32);
  expect(reserveBudget(state, id)).toBe(true); expect(reserveBudget(state, id)).toBe(false);
  expect(reportedGemmaNeurons({ usage: { prompt_tokens: -1, completion_tokens: 3 } })).toBeNull();
  settleBudget(state, id, 300); settleBudget(state, id, 1); expect(state.used).toBe(300);
  const newDay = newBudgetState("2026-10-14"); expect(newDay.used).toBe(0);
  settleBudget(state, "unknown-id", 1); expect(newDay.used).toBe(0);
});

it("uses a bounded image call and returns a validated generated atlas without a reservation", async () => {
  const s = await setup();
  const sheet = bytesToBase64(await encodePng(makeFourViewSheet()));
  const analysis = { choices: [{ message: { content: JSON.stringify(namedGemmaFixture(wireFixture(semanticFixture("plain")))) } }],
    usage: { prompt_tokens: 9000, completion_tokens: 3000 } };
  s.run.mockImplementation(async (model: string) => model === FREE_VISION_MODEL ? analysis : { image: sheet } as never);
  const stages: string[] = [];
  const result = await generateFreeSkin({ ...s.env, FREE_IMAGE_GENERATION_ENABLED: "true", IMAGE_GEN_STRATEGY: "four_view",
    [GENERATION_OBSERVER]: (stage: string) => stages.push(stage) }, { image: s.image });
  expect(result).toMatchObject({ success: true, body: { ok: true, generationMode: "image" } });
  expect(stages).not.toContain("render_context_started");
  expect(validateFinalAtlas(await decodePng(base64ToBytes(result.body.skinPngBase64!))).ok).toBe(true);
  expect(s.run.mock.calls.map(call => call[0])).toEqual([FREE_VISION_MODEL, "@cf/black-forest-labs/flux-2-klein-4b"]);
  expect(s.reserve).not.toHaveBeenCalled();
  expect(s.kv.put).not.toHaveBeenCalled();
  const analysisCost = reportedGemmaNeurons(analysis)!;
  expect(s.settle).not.toHaveBeenCalled();
  expect(result.neuronsSpent).toBe(analysisCost + MAX_IMAGE_CALL_NEURONS);
});

it("does not return a procedural skin when image generation fails and accounts for attempts", async () => {
  const s = await setup();
  const analysis = { choices: [{ message: { content: JSON.stringify(namedGemmaFixture(wireFixture(semanticFixture("plain")))) } }],
    usage: { prompt_tokens: 9000, completion_tokens: 3000 } };
  s.run.mockImplementation(async (model: string) => {
    if (model === FREE_VISION_MODEL) return analysis;
    throw new Error("3040: temporary out of capacity");
  });
  const result = await generateFreeSkin({ ...s.env, FREE_IMAGE_GENERATION_ENABLED: "true", IMAGE_GEN_STRATEGY: "four_view" }, { image: s.image });
  expect(result).toMatchObject({ success: false, body: { ok: false, errorCode: "provider_unavailable" } });
  expect(result.body.skinPngBase64).toBeUndefined();
  expect(s.run).toHaveBeenCalledTimes(3);
  expect(s.settle).not.toHaveBeenCalled();
});

it("reports Cloudflare's daily quota error from image generation", async () => {
  const s = await setup();
  const analysis = { choices: [{ message: { content: JSON.stringify(namedGemmaFixture(wireFixture(semanticFixture("plain")))) } }],
    usage: { prompt_tokens: 9000, completion_tokens: 3000 } };
  s.run.mockImplementation(async (model: string) => {
    if (model === FREE_VISION_MODEL) return analysis;
    throw new Error("3036: daily free allocation exhausted");
  });
  const result = await generateFreeSkin({ ...s.env, FREE_IMAGE_GENERATION_ENABLED: "true", IMAGE_GEN_STRATEGY: "four_view" }, { image: s.image });
  expect(result).toMatchObject({ status: 429, success: false, body: { errorCode: "quota_exceeded" } });
});

it("generates even when provider usage is unavailable", async () => {
  const s = await setup();
  const sheet = bytesToBase64(await encodePng(makeFourViewSheet()));
  const analysis = { choices: [{ message: { content: JSON.stringify(namedGemmaFixture(wireFixture(semanticFixture("plain")))) } }] };
  s.run.mockImplementation(async (model: string) => model === FREE_VISION_MODEL ? analysis : { image: sheet } as never);
  const result = await generateFreeSkin({ ...s.env, FREE_IMAGE_GENERATION_ENABLED: "true", IMAGE_GEN_STRATEGY: "four_view" }, { image: s.image });
  expect(result.body.generationMode).toBe("image");
  expect(s.settle).not.toHaveBeenCalled();
  expect(s.reserve).not.toHaveBeenCalled();
});
