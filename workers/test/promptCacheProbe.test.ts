import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { getPlatformProxy } from "wrangler";
import { GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT } from "../src/gemmaPhotoAnalysis";
import type { Env } from "../src/types";
import { generateFreeSkin } from "../src/engineService";
import { base64ToBytes, decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";

// Explicit opt-in: this makes six real Workers AI calls using public demo assets.
it.skipIf(process.env.RUN_PROMPT_CACHE_PROBE !== "1")("measures cache eligibility on the existing Gemma model", async () => {
  const dir = process.env.IMAGE_PROVIDER_PROBE_DIR!;
  const proxy = await getPlatformProxy<Env>({ configPath: `${dir}/cache-probe-wrangler.json`, persist: false, remoteBindings: true });
  try {
    const photo = await readFile(`${dir}/probe-photo.jpg`);
    const image = `data:image/jpeg;base64,${photo.toString("base64")}`;
    const original = await readFile("../app-store/public/images/woman-lace-photo.png");
    const alternative = `data:image/png;base64,${original.toString("base64")}`;
    for (let index = 0; index < 6; index++) {
      const input = { messages: [{ role: "user", content: [
        { type: "text", text: GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT },
        { type: "image_url", image_url: { url: index % 2 ? alternative : image } },
      ] }], max_completion_tokens: 64, temperature: 0, seed: 0, store: false,
        chat_template_kwargs: { enable_thinking: false } };
      const start = Date.now();
      const result = await proxy.env.AI!.run("@cf/google/gemma-4-26b-a4b-it" as never, input as never,
        { extraHeaders: { "x-session-affinity": "mc-skin-cache-probe-v1" } } as never) as unknown as { usage?: unknown };
      console.log(JSON.stringify({ attempt: index + 1, ms: Date.now() - start, usage: result.usage ?? null }));
    }
  } finally { await proxy.dispose(); }
}, 240_000);

it.skipIf(process.env.RUN_PROMPT_CACHE_E2E !== "1")("checks real full analysis and skin output with prefix caching", async () => {
  const dir = process.env.IMAGE_PROVIDER_PROBE_DIR!;
  const proxy = await getPlatformProxy<Env>({ configPath: `${dir}/cache-probe-wrangler.json`, persist: false, remoteBindings: true });
  try {
    const photo = await readFile(`${dir}/probe-photo.jpg`);
    const binding = proxy.env.AI!;
    for (let index = 0; index < 2; index++) {
      let usage: unknown;
      const env = { ...proxy.env, FREE_IMAGE_GENERATION_ENABLED: "false", MCSKIN_KV: { put: async () => undefined },
        AI: { run: async (model: never, input: never, options: never) => {
          const result = await binding.run(model, input, options) as unknown as { usage?: unknown };
          usage = result.usage;
          return result;
        } } } as unknown as Env;
      const start = Date.now();
      const result = await generateFreeSkin(env, { image: `data:image/jpeg;base64,${photo.toString("base64")}` });
      console.log(JSON.stringify({ attempt: index + 1, ms: Date.now() - start, success: result.success,
        mode: result.body.generationMode, errorCode: result.body.errorCode, usage }));
      expect(result.success).toBe(true);
      expect(result.body.generationMode).toBe("procedural_fallback");
      const bytes = base64ToBytes(result.body.skinPngBase64!);
      const png = await decodePng(bytes);
      expect([png.width, png.height]).toEqual([64, 64]);
      expect(validateFinalAtlas(png).ok).toBe(true);
      await writeFile(`${dir}/cache-e2e-${index + 1}.png`, bytes);
    }
  } finally { await proxy.dispose(); }
}, 240_000);
