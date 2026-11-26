import { afterEach, expect, it, vi } from "vitest";
import { generateFreeSkin, freeQuotaStatus } from "../src/engineService";
import { FREE_VISION_MODEL, MAX_CALL_NEURONS, MAX_IMAGE_CALL_NEURONS, newBudgetState, reserveBudget, settleBudget, reportedGemmaNeurons } from "../src/freeBudget";
import { encodePng, bytesToBase64, base64ToBytes, decodePng } from "../src/png";
import { makeFourViewSheet, makeSyntheticAtlas } from "./helpers";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import { FREE_GEMMA_PRIMARY_TIMEOUT_MS, generateGeminiImage, GeminiApiError } from "../src/gemini";
import { fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { makeAnalysis } from "./helpers";
import { validatePhotoAnalysis } from "../src/analysis";
import { GENERATION_OBSERVER } from "../src/generationObservation";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { validateGemmaNamedPhotoAnalysis } from "../src/gemmaPhotoAnalysis";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
afterEach(() => vi.restoreAllMocks());

it("requires scoped appearance details in the same provider call and paints them without exposing the analysis", async () => {
  const s = await setup();
  const payload = { ...namedGemmaFixture(wireFixture(semanticFixture("plain"))), appearanceDetail: {
    frontHairLeft: "unknown", frontHairRight: "unknown", frontHairTexture: "unknown", upperPattern: "unknown", upperPalette: [],
    leftSleeveColor: "", rightSleeveColor: "", skirtBase: "", skirtCheck: "", beanie: "ear_beanie", beanieBase: "#74c3d2", beanieTrim: [], sockTop: "unknown",
  } };
  s.run.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 9000, completion_tokens: 3000 } });
  const result = await generateFreeSkin(s.env, { image: s.image, presentation: "source" });
  expect(result.success, result.body.errorCode).toBe(true);
  expect(s.run).toHaveBeenCalledOnce();
  const wire = s.run.mock.calls[0][1] as { response_format: { json_schema: { schema: { required: string[] } } } };
  expect(wire.response_format.json_schema.schema.required).toContain("appearanceDetail");
  expect(result.body).not.toHaveProperty("analysis");
  const atlas = await decodePng(base64ToBytes(result.body.skinPngBase64!));
  const top = CLASSIC_LAYOUT.head.base.top, i = ((top.y + 3) * 64 + top.x + 3) * 4;
  expect(atlas.rgba[i + 1] - atlas.rgba[i]).toBeGreaterThan(35);
});

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

it.each([false, true])("keeps the fixed eyes and paints front chest locks with one free analysis (structured-only: %s)", async (structuredOnly) => {
  const s = await setup();
  const photo = semanticFixture("plain");
  photo.observed.hair = "Long dark brown wavy hair. Wispy bangs reach the eyebrows with skin between the strands. Hair lies over the front of the gray hoodie on both sides to the chest.";
  photo.observed.accessories = "No visible accessories.";
  photo.observed.clothing = "Light gray zip hoodie with dark lettering.";
  photo.identityPrompt = "Round face with dark brown wavy hair and fine bangs.";
  photo.inferred.hairBack = { value: "Long wavy back hair", rationale: "Matches the visible long hair." };
  photo.canonicalIdentity = {
    overallImpression: "Round face with brow-length wispy bangs, dark wavy locks and a light gray zip hoodie.",
    mustPreserve: ["visible wispy bangs", "long front locks", "light gray hoodie"],
    features: [
      { feature: "wispy bangs", evidence: "Separate thin bangs over the forehead.", category: "hair", confidence: "high", priority: 5, targetRegions: ["head.front"] },
      { feature: "long wavy front locks", evidence: "Hair lies over the front of the hoodie on both sides to the chest.", category: "hair", confidence: "high", priority: 5, targetRegions: ["head.front", "torso.front"] },
      { feature: "round face", evidence: "The jaw is rounded.", category: "face", confidence: "high", priority: 4, targetRegions: ["head.front"] },
      { feature: "gray hoodie", evidence: "A light gray zipped hooded sweatshirt.", category: "outfit", confidence: "high", priority: 4, targetRegions: ["torso.front"] },
    ],
  };
  Object.assign(photo.fallbackFeatures, { hairColor: "dark-brown", hairstyle: "long", glasses: "none", topType: "hoodie", topColor: "gray" });
  Object.assign(photo.renderHints, { bangs: "none", bangsLength: "none", bangsDensity: "balanced", fringeOpening: "center",
    hairTexture: "wavy", overallHairLength: "chest", hairBackShape: "long", sideHairLength: "jaw" });
  if (structuredOnly) {
    photo.observed.hair = "Long dark brown wavy hair. Wispy bangs reach the eyebrows with skin between the strands. Both sides are tucked behind the ears.";
    photo.canonicalIdentity.features[1].evidence = "Long wavy locks on both sides.";
    photo.visibleRegions.upperBody = true;
  }
  const base = namedGemmaFixture(wireFixture(photo));
  expect(validateGemmaNamedPhotoAnalysis(base)).toEqual([]);
  const payload = structuredOnly ? { ...base, appearanceDetail: {
    templeLeft: "at_ear", templeRight: "at_ear", frontHairLeft: "chest", frontHairRight: "shoulder", frontHairTexture: "wavy",
  } } : base;
  s.run.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: 9000, completion_tokens: 3000 } });

  const result = await generateFreeSkin(s.env, { image: s.image });
  expect(result.success, result.body.errorCode).toBe(true);
  expect(s.run).toHaveBeenCalledOnce();
  expect(JSON.stringify(s.run.mock.calls[0][1])).toContain("front garment overlap");
  const atlas = await decodePng(base64ToBytes(result.body.skinPngBase64!));
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  const pixel = (rect: { x: number; y: number }, x: number, y: number) => {
    const i = ((rect.y + y) * 64 + rect.x + x) * 4;
    return atlas.rgba.slice(i, i + 4);
  };
  const head = CLASSIC_LAYOUT.head;
  const fringe = Array.from({ length: 6 }, (_, i) => pixel(head.base.front, i + 1, 2)[0]);
  expect(fringe.some(red => red < 110)).toBe(true);
  expect(fringe.some(red => red > 150)).toBe(true);
  for (const [x, outerX] of [[2, 1], [5, 6]]) {
    expect(pixel(head.overlay.front, x, 5)[3]).toBe(0);
    expect(pixel(head.base.front, x, 5)[0]).toBeLessThan(110);
    expect(pixel(head.base.front, outerX, 5)[0]).toBeGreaterThan(180);
    expect(pixel(head.base.front, outerX, 6)[0]).toBeGreaterThan(230);
  }
  expect(pixel(head.overlay.front, 4, 5)[3]).toBe(0);
  expect(result.body.features?.fixedHairMask).toMatch(/^[A-Za-z0-9+/]{683}=$/);
  const body = CLASSIC_LAYOUT.body.base.front;
  for (const x of [0, 7]) {
    expect(pixel(body, x, 0)[0]).toBeLessThan(110);
    expect(pixel(CLASSIC_LAYOUT.body.overlay.front, x, 0)[3]).toBe(0);
  }
  expect(pixel(body, 0, 6)[0]).toBeLessThan(110);
  if (structuredOnly) expect(pixel(body, 7, 6)[0]).toBeGreaterThan(125);
  else expect(pixel(body, 7, 6)[0]).toBeLessThan(110);
  expect(pixel(body, 3, 0)[0]).toBeGreaterThan(125);
  expect(pixel(body, 3, 6)[0]).toBeGreaterThan(125);
  for (const x of [0, 7]) expect(pixel(body, x, 11)[0]).toBeGreaterThan(110);
  for (const x of [1, 6]) expect(pixel(CLASSIC_LAYOUT.body.overlay.front, x, 2)[3]).toBe(255);
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
it("honors both selected avatar finishes on the same observation without image generation or extra calls", async () => {
  const s = await setup();
  const observation = semanticFixture("plain");
  observation.observed.accessories = "none";
  observation.observed.face = "soft oval face with visible dark eyes and a small closed mouth";
  observation.canonicalIdentity.features = observation.canonicalIdentity.features.map(f => f.category !== "accessory" ? f : ({
    ...f, category: "face", feature: "dark readable eyes", evidence: "both eyes are visible", targetRegions: ["head.front"],
  }));
  observation.canonicalIdentity.overallImpression = "Oval warm face with short side-swept dark hair and a closed mouth.";
  observation.canonicalIdentity.mustPreserve = observation.canonicalIdentity.mustPreserve.filter(f => !f.includes("glasses"));
  observation.fallbackFeatures.glasses = "none";
  observation.fallbackFeatures.expression = "neutral";
  observation.renderHints.mouthShape = "small";
  observation.renderHints.mouthOpening = "closed";
  const providerObservation = namedGemmaFixture(wireFixture(observation));
  expect(validateGemmaNamedPhotoAnalysis(providerObservation)).toEqual([]);
  s.run.mockImplementation(async () => ({ choices: [{ message: { content: JSON.stringify(providerObservation) } }],
    usage: { prompt_tokens: 9000, completion_tokens: 3000 } }));
  const env = { ...s.env, FREE_IMAGE_GENERATION_ENABLED: "true" };
  const results = await Promise.all((["feminine", "masculine", "source"] as const).map(presentation =>
    generateFreeSkin(env, { image: s.image, presentation })));
  const atlases = await Promise.all(results.map(result => {
    expect(result).toMatchObject({ success: true, body: { generationMode: "procedural_fallback" } });
    return decodePng(base64ToBytes(result.body.skinPngBase64!));
  }));
  expect(atlases.every(a => validateFinalAtlas(a).ok)).toBe(true);
  expect(atlases[0].rgba).not.toEqual(atlases[1].rgba);
  // Full atlas difference alone would pass even if only the hair or outfit
  // changed. Verify real face changes and identical garment pixels.
  const front = CLASSIC_LAYOUT.head.base.front;
  const texel = (a: typeof atlases[number], x: number, y: number) => a.rgba.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
  let facialDifferences = 0;
  for (let y = 3; y < 8; y++) for (let x = 1; x < 7; x++) {
    if (texel(atlases[0], front.x + x, front.y + y).some((v, i) => v !== texel(atlases[1], front.x + x, front.y + y)[i])) facialDifferences++;
  }
  expect(facialDifferences).toBeGreaterThan(0);
  expect(atlases[0].rgba.slice(16 * 64 * 4)).toEqual(atlases[1].rgba.slice(16 * 64 * 4));
  const { fixedHairMask: feminineMask, ...feminineFeatures } = results[0].body.features!;
  const { fixedHairMask: masculineMask, ...masculineFeatures } = results[1].body.features!;
  expect(feminineFeatures).toEqual(masculineFeatures);
  expect(feminineMask).toMatch(/^[A-Za-z0-9+/]{683}=$/);
  expect(masculineMask).toMatch(/^[A-Za-z0-9+/]{683}=$/);
  expect(feminineMask).not.toBe(masculineMask);
  expect(s.run.mock.calls.map(call => call[0])).toEqual([FREE_VISION_MODEL, FREE_VISION_MODEL, FREE_VISION_MODEL]);
  const output = process.env.SKIN_PRESENTATION_ARTIFACT_DIR;
  if (output) {
    const fronts = atlases.map(a => renderSkinViews(a).find(v => v.name === "front")!.image);
    const { width, height } = fronts[0];
    const comparison = { width: width * 2, height, rgba: new Uint8Array(width * 2 * height * 4) };
    for (let y = 0; y < height; y++) fronts.forEach((p, i) => {
      comparison.rgba.set(p.rgba.subarray(y * width * 4, (y + 1) * width * 4), (2 * y + i) * width * 4);
    });
    const png = await encodePng(scaleNearestNeighbor(comparison, comparison.width * 5, comparison.height * 5));
    await writeFile(join(output, "skin-finish-comparison.png"), png);
  }
}, 30_000);
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
it("accepts a slow free analysis after the old 60-second cutoff with one model call", async () => {
  const s = await setup(), response = await s.run();
  s.run.mockClear();
  vi.useFakeTimers();
  try {
    s.run.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(response), 65_000)));
    const pending = generateFreeSkin(s.env, { image: s.image });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(65_000);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(validateFinalAtlas(await decodePng(base64ToBytes(result.body.skinPngBase64!))).ok).toBe(true);
    expect(s.run).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it("distinguishes the free local deadline from provider failures without logging input", async () => {
  const s = await setup(), warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.useFakeTimers();
  try {
    s.run.mockImplementationOnce(() => new Promise(() => {}));
    const pending = generateFreeSkin(s.env, { image: s.image });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(FREE_GEMMA_PRIMARY_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ status: 503, body: { errorCode: "provider_unavailable" } });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ origin: "LOCAL_DEADLINE", deadlineTimerFired: true });
    expect(s.run).toHaveBeenCalledOnce();
    s.run.mockRejectedValueOnce(new GeminiApiError("private-photo", 503, "UNAVAILABLE"));
    await expect(generateFreeSkin(s.env, { image: s.image })).resolves.toMatchObject({ status: 503 });
    expect(JSON.parse(String(warn.mock.calls[1]?.[0]))).toMatchObject({ origin: "BINDING_REJECTION", deadlineTimerFired: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-photo");
  } finally { vi.useRealTimers(); }
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
