import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { getPlatformProxy } from "wrangler";
import { GeminiImageProvider, WorkersAiImageProvider } from "../src/skinProvider";
import { buildSkinPlan } from "../src/skinPlan";
import { makeAnalysis } from "./helpers";
import type { Env } from "../src/types";
import { generateFreeSkin } from "../src/engineService";
import { budgetStatus, newBudgetState, reserveBudget, settleBudget } from "../src/freeBudget";
import { base64ToBytes } from "../src/png";
import { buildFaceStyle, fallbackFeaturesToHex, normalizeAnalysisForRendering, postprocessGeneratedSheet, refineFeatureColorsFromAnalysis } from "../src/generate";
import { GENERATION_OBSERVER } from "../src/generationObservation";

function sampleAnalysis() {
    const base = makeAnalysis();
    return makeAnalysis({
      observed: { face: "light warm skin, dark eyes, soft smile", hair: "long dark brown wavy hair parted near the middle",
        accessories: "no glasses", clothing: "white sleeveless lace dress, pale pink cardigan and white shoes",
        colorPalette: ["dark brown", "white", "pale pink"] },
      inferred: { hairBack: { value: "long brown wavy hair", rationale: "visible side length" }, upperBody: null, lowerBody: null, shoes: null },
      canonicalIdentity: { ...base.canonicalIdentity, overallImpression: "Long wavy brown hair and a white lace dress with a pale pink cardigan",
        mustPreserve: ["long dark wavy hair", "white lace dress", "pale pink cardigan", "no glasses"], features: [] },
      renderHints: { ...base.renderHints, overallHairLength: "chest", sideHairLength: "shoulder", sideHairShape: "face_framing", hairTexture: "wavy", hairBackShape: "long", hairPart: "center", bangs: "curtain", fringeOpening: "center", earExposure: "covered", mouthOpening: "closed", outerLayer: "light", outerGarment: "cardigan", bottomPattern: "lace" },
      fallbackFeatures: { ...base.fallbackFeatures, hairstyle: "long", hairColor: "dark-brown", glasses: "none", topType: "dress", topColor: "white", bottomType: "skirt", bottomColor: "white" },
      identityPrompt: "A woman with long dark brown wavy hair parted near the middle and dark eyes, without glasses.",
      outfitPrompt: "White lace dress, pale pink cardigan, white shoes.", negativePrompt: "no glasses, no facial hair",
    });
}

function probeStyle(analysis: ReturnType<typeof makeAnalysis>) {
  const normalized = normalizeAnalysisForRendering(analysis);
  const plan = buildSkinPlan(normalized);
  const features = refineFeatureColorsFromAnalysis(normalized,
    fallbackFeaturesToHex(normalized.fallbackFeatures, normalized.renderHints.skinUndertone));
  return { plan, style: buildFaceStyle(normalized, features, plan.hairPlan) };
}

it.skipIf(process.env.RUN_IMAGE_PROVIDER_PROBE !== "1")("evaluates one real Workers AI image call", async () => {
  const dir = process.env.IMAGE_PROVIDER_PROBE_DIR!;
  const proxy = await getPlatformProxy<Env>({ configPath: process.env.IMAGE_PROVIDER_PROBE_CONFIG || `${dir}/probe-wrangler.json`, persist: false, remoteBindings: true });
  try {
    const analysis = sampleAnalysis();
    const photo = await readFile(`${dir}/probe-photo.jpg`);
    const result = await new WorkersAiImageProvider({ ...proxy.env, WORKERS_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-4b" }).generate({
      analysis, skinPlan: buildSkinPlan(analysis), photoDataUrl: `data:image/jpeg;base64,${photo.toString("base64")}`,
      seed: 11, mode: "four_view", modelTier: "balanced",
    });
    if (!result.ok) throw new Error(result.error);
    await writeFile(`${dir}/probe-generated.png`, result.imageBytes);
    const { plan, style } = probeStyle(analysis);
    const packed = await postprocessGeneratedSheet(result.imageBytes, 0, "four_view", style, plan);
    console.log(JSON.stringify({ packSucceeded: Boolean(packed.atlasBase64), failure: packed.failure ?? null }));
    if (packed.atlasBase64) await writeFile(`${dir}/probe-packed-skin.png`, base64ToBytes(packed.atlasBase64));
    console.log(JSON.stringify({ provider: result.provider, model: result.model, mode: result.mode, neurons: result.neuronsSpent, inputTiles: result.inputTiles, outputTiles: result.outputTiles, inputs: result.inputDiagnostics }));
    expect(result.imageBytes.length).toBeGreaterThan(1000);
    expect(packed.atlasBase64, packed.failure).toBeTruthy();
  } finally { await proxy.dispose(); }
}, 180_000);

it.skipIf(process.env.RUN_END_TO_END_IMAGE_PROBE !== "1")("evaluates real photo analysis and bounded image generation", async () => {
  const dir = process.env.IMAGE_PROVIDER_PROBE_DIR!;
  const proxy = await getPlatformProxy<Env>({ configPath: process.env.IMAGE_PROVIDER_PROBE_CONFIG!, persist: false, remoteBindings: true });
  const state = newBudgetState(new Date().toISOString().slice(0, 10));
  const calls: string[] = [];
  try {
    const binding = proxy.env.AI!;
    const env = { ...proxy.env, FREE_IMAGE_GENERATION_ENABLED: "true", IMAGE_GEN_STRATEGY: "four_view",
      MCSKIN_KV: { put: async () => undefined },
      AI: { run: async (model: string, input: never) => {
        calls.push(model);
        if (calls.length > 3) throw new Error("Probe call limit reached");
        const response = await binding.run(model as never, input);
        if (model.includes("flux") && response && typeof response === "object" && "image" in response && typeof response.image === "string") {
          await writeFile(`${dir}/e2e-sheet-${calls.length - 1}.png`, base64ToBytes(response.image));
        }
        if (model.includes("gemma")) await writeFile(`${dir}/e2e-analysis.json`, JSON.stringify(response));
        return response;
      } },
      NEURON_BUDGET: { getByName: () => ({
        status: async () => budgetStatus(state),
        reserve: async (id: string) => ({ day: state.day, accepted: reserveBudget(state, id) }),
        settle: async (_day: string, id: string, amount: number) => settleBudget(state, id, amount),
      }) },
    } as unknown as Env;
    const photo = await readFile(`${dir}/probe-photo.jpg`);
    const image = `data:image/jpeg;base64,${photo.toString("base64")}`;
    const started = Date.now();
    const result = await generateFreeSkin(env, { image });
    console.log(JSON.stringify({ status: result.status, ok: result.success, mode: result.body.generationMode,
      errorCode: result.body.errorCode, calls, neuronsReservedOrSpent: state.used, elapsedMs: Date.now() - started }));
    if (result.body.skinPngBase64) await writeFile(`${dir}/e2e-generated-skin.png`, base64ToBytes(result.body.skinPngBase64));
    expect(result.success).toBe(true);
    expect(result.body.generationMode).toBe("image");
  } finally { await proxy.dispose(); }
}, 240_000);

it.skipIf(process.env.RUN_GEMINI_IMAGE_PROBE !== "1")("evaluates the configured Gemini image model once", async () => {
  const dir = process.env.IMAGE_PROVIDER_PROBE_DIR!;
  const analysis = makeAnalysis();
  const photo = await readFile(`${dir}/probe-photo.jpg`);
  const result = await new GeminiImageProvider({
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_IMAGE_MODEL: process.env.IMAGE_PROBE_MODEL || "gemini-3.1-flash-image",
    GEMINI_IMAGE_FALLBACK_MODEL: process.env.IMAGE_PROBE_MODEL || "gemini-3.1-flash-image",
  } as Env).generate({
    analysis, skinPlan: buildSkinPlan(analysis), photoDataUrl: `data:image/jpeg;base64,${photo.toString("base64")}`,
    seed: 11, mode: "four_view", modelTier: "balanced",
  });
  console.log(JSON.stringify({ ok: result.ok, provider: result.provider, attemptedModels: result.attemptedModels,
    ...(!result.ok ? { quotaExceeded: result.quotaExceeded, retryable: result.retryable } : {}) }));
  if (!result.ok) throw new Error("Image provider did not return an image");
  await writeFile(`${dir}/gemini-probe-generated.png`, result.imageBytes);
  expect(result.imageBytes.length).toBeGreaterThan(1000);
}, 180_000);

it.skipIf(process.env.RUN_IMAGE_PROVIDER_REPLAY !== "1")("replays the saved generated sheet without a provider call", async () => {
  const dir = process.env.IMAGE_PROVIDER_PROBE_DIR!;
  const sheet = await readFile(`${dir}/probe-generated.png`);
  const { plan, style } = probeStyle(sampleAnalysis());
  const packed = await postprocessGeneratedSheet(sheet, 0, "four_view", style, plan);
  console.log(JSON.stringify({ packSucceeded: Boolean(packed.atlasBase64), failure: packed.failure ?? null }));
  if (packed.atlasBase64) await writeFile(`${dir}/probe-packed-skin.png`, base64ToBytes(packed.atlasBase64));
  expect(packed.atlasBase64, packed.failure).toBeTruthy();
});

it.skipIf(process.env.RUN_E2E_REPLAY !== "1")("replays actual analysis and image responses without provider calls", async () => {
  const dir = process.env.IMAGE_PROVIDER_PROBE_DIR!;
  const photo = await readFile(`${dir}/probe-photo.jpg`);
  const analysis = JSON.parse(await readFile(`${dir}/e2e-analysis.json`, "utf8"));
  const sheet = await readFile(`${dir}/e2e-sheet-1.png`);
  const state = newBudgetState(new Date().toISOString().slice(0, 10));
  const startedCpu = process.cpuUsage();
  const stages: Array<{ stage: string; cpuMs: number }> = [];
  const env = { FREE_IMAGE_GENERATION_ENABLED: "true", IMAGE_GEN_STRATEGY: "four_view",
    [GENERATION_OBSERVER]: (stage: string) => {
      const cpu = process.cpuUsage(startedCpu);
      stages.push({ stage, cpuMs: Math.round((cpu.user + cpu.system) / 1000) });
    },
    MCSKIN_KV: { put: async () => undefined },
    AI: { run: async (model: string) => model.includes("gemma") ? analysis : { image: sheet.toString("base64") } },
    NEURON_BUDGET: { getByName: () => ({ status: async () => budgetStatus(state),
      reserve: async (id: string) => ({ day: state.day, accepted: reserveBudget(state, id) }),
      settle: async (_day: string, id: string, amount: number) => settleBudget(state, id, amount) }) },
  } as unknown as Env;
  const result = await generateFreeSkin(env, { image: `data:image/jpeg;base64,${photo.toString("base64")}` });
  const cpu = process.cpuUsage(startedCpu);
  console.log(JSON.stringify({ status: result.status, mode: result.body.generationMode, features: result.body.features,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000), stages }));
  if (result.body.skinPngBase64) await writeFile(`${dir}/e2e-replay.png`, base64ToBytes(result.body.skinPngBase64));
  expect(result.success).toBe(true);
  expect(result.body.generationMode).toBe("image");
  expect(result.body.features).toMatchObject({ bottomType: "skirt", bottomColor: "#f2f2f2" });
});
