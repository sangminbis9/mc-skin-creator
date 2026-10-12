import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import ts from "typescript";
import { decodePng, type RawImage } from "../src/png";
import { measureAtlasCraft } from "../src/skinPost";
import { ALL_PARTS, ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";
import { measureCraftTextureOracle } from "./fixtures/craftTextureArrayOracle";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const textureKeys = ["isolatedNoisePixels", "isolatedNoiseRatio", "maxLocalPaletteSize", "meanLocalPaletteSize",
  "connectedClusterCoherence", "colorEntropy", "edgeFrequency"] as const;

it("preserves every texture metric across transparent, threshold, randomized and saved production atlases", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const inputs: Array<{ id: string; atlas: RawImage }> = [];
    // Include non-binary alpha: texture measurement historically treats any nonzero alpha as present.
    for (let seed = 0; seed < 40; seed++) {
      let state = seed + 1;
      const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24; };
      const rgba = new Uint8Array(64 * 64 * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        for (let ch = 0; ch < 3; ch++) rgba[i + ch] = next();
        rgba[i + 3] = seed === 0 ? 0 : seed === 1 ? 255 : next() < 80 ? 0 : next() || 1;
      }
      inputs.push({ id: `authored_seed_${seed}`, atlas: { width: 64, height: 64, rgba } });
    }
    for (const distance of [0, 53, 54, 55, 71, 72, 73]) {
      const rgba = new Uint8Array(64 * 64 * 4);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        rgba[i] = (x + y) % 2 ? distance : 0; rgba[i + 3] = 255;
      }
      inputs.push({ id: `authored_boundary_${distance}`, atlas: { width: 64, height: 64, rgba } });
    }
    const png = readFileSync("evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-017/skin.png");
    expect(sha(png)).toBe("1c4d0fca2c7ca1a0bece170b5e2ad56b93fc80786eaeef7ef8bfce904a3217fb");
    inputs.push({ id: "saved_D017", atlas: await decodePng(png) });
    const cases = inputs.map(({ id, atlas }) => {
      const before = sha(atlas.rgba), oracle = measureCraftTextureOracle(atlas), current = measureAtlasCraft(atlas);
      expect(Object.fromEntries(textureKeys.map(k => [k, current[k]])), id).toEqual(oracle);
      expect(sha(atlas.rgba), id).toBe(before);
      return { id, rgbaSha256: before, metricsSha256: sha(JSON.stringify(oracle)), equal: true };
    });
    // Local-only micro-profile of the actual private implementation, without exporting a test hook in production.
    const text = readFileSync("src/skinPost.ts", "utf8");
    const slice = text.slice(text.indexOf("function perceptualKey("), text.indexOf("/** Analysis-derived expectations"));
    const javascript = ts.transpileModule(slice, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const currentTexture = new Function("ALL_PARTS", "ATLAS_SIZE", "CLASSIC_LAYOUT", javascript + ";return measureCraftTexture;")(
      ALL_PARTS, ATLAS_SIZE, CLASSIC_LAYOUT) as typeof measureCraftTextureOracle;
    const atlas = inputs.at(-1)!.atlas, expected = measureCraftTextureOracle(atlas);
    expect(currentTexture(atlas)).toEqual(expected);
    const time = (fn: typeof measureCraftTextureOracle) => {
      const start = performance.now(); for (let i = 0; i < 50; i++) fn(atlas); return performance.now() - start;
    };
    for (let i = 0; i < 10; i++) { currentTexture(atlas); measureCraftTextureOracle(atlas); }
    const timings = Array.from({ length: 8 }, (_, i) => {
      if (i % 2) { const currentMs = time(currentTexture); return { currentMs, oracleMs: time(measureCraftTextureOracle) }; }
      const oracleMs = time(measureCraftTextureOracle); return { oracleMs, currentMs: time(currentTexture) };
    });
    const out = freshAuditOutput("evaluation-artifacts/craft-texture-allocation-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_equivalence_and_local_timing", providerCalls: 0,
      productionSha256: sha(text), oracleSha256: sha(readFileSync("test/fixtures/craftTextureArrayOracle.ts")),
      cases, timings, iterationsPerSample: 50, exactMetrics: true, inputMutation: false,
      thresholdsChanged: false, samplingLimit: "local Node only; not remote CPU, memory or proof of D019 failure cause",
    }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info("CRAFT_TEXTURE_ALLOCATION", out);
  } finally { network.mockRestore(); }
}, 120_000);
