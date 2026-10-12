import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { generateSkin } from "../src/generate";
import { generateFreeSkin } from "../src/engineService";
import { decodePng, base64ToBytes, bytesToBase64, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { wireFixture } from "./compactV3Support";
import { COMPACT_HINT_GROUPS } from "../src/compactPhotoAnalysis";
import { budgetStatus, newBudgetState, reserveBudget } from "../src/freeBudget";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const compact = () => wireFixture(makeAnalysis());
const namedCompact = () => {
  const value = compact();
  return {
    ...value,
    renderHints: Object.fromEntries(
      Object.entries(COMPACT_HINT_GROUPS).map(([group, fields]) => [
        group,
        Object.fromEntries(fields.map((field, index) => [
          field,
          value.renderHints[group as keyof typeof value.renderHints][index],
        ])),
      ]),
    ),
  };
};
const gemini = (value: unknown) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
const kv = () => ({ get: vi.fn(async () => null), put: vi.fn(async () => undefined) });
function environment(): Env {
  const state = newBudgetState(new Date().toISOString().slice(0, 10));
  return { GEMINI_API_KEY: "test-key", AI: { run: vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify(namedCompact()) } }],
  })) },
    NEURON_BUDGET: { getByName: () => ({ status: async () => budgetStatus(state),
      reserve: async (id: string) => ({ day: state.day, accepted: reserveBudget(state,id) }), settle: async () => undefined }) },
    MCSKIN_KV: kv(), IMAGE_GENERATION_ENABLED: "true", IMAGE_CRITIQUE_ENABLED: "true",
    HEAD_CANDIDATE_SELECTION_ENABLED: "true" } as unknown as Env;
}
async function photo() { return `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(7)))}`; }
async function assertSkin(body: { ok: boolean; skinPngBase64?: string; generationMode?: string }) {
  expect(body.ok).toBe(true);
  expect(body.generationMode).toBe("procedural_fallback");
  const png = await decodePng(base64ToBytes(body.skinPngBase64!));
  expect([png.width, png.height]).toEqual([64, 64]);
  expect(validateFinalAtlas(png).ok).toBe(true);
}
describe("production upload-to-PNG reliability", () => {
  it("reports native free-model quota exhaustion without writing private diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 })));
    const env = environment();
    env.AI!.run = vi.fn(async () => { throw new Error("3036: daily free allocation exhausted"); }) as never;
    const response = await worker.fetch(new Request("https://local/api/generate", { method: "POST", body: JSON.stringify({ image: await photo() }) }), env);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ errorCode: "quota_exceeded" });
    expect(env.MCSKIN_KV.put).not.toHaveBeenCalledWith(expect.stringContaining("providers-closed"), expect.anything(), expect.anything());
  });
  it("POST /api/generate uses the free native model without a Gemini HTTP request", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = environment();
    const response = await worker.fetch(new Request("https://local/api/generate", { method: "POST", body: JSON.stringify({ image: await photo() }) }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await assertSkin(await response.json());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
  });
  it("POST /api/generate ignores configured Gemini keys and prerequisite failures", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: {
      message: "A provider project prerequisite is not met",
      status: "FAILED_PRECONDITION",
    } }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = environment();
    const response = await worker.fetch(new Request("https://local/api/generate", {
      method: "POST", body: JSON.stringify({ image: await photo() }),
    }), env);
    expect(response.status).toBe(200);
    await assertSkin(await response.json());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
  });
  it("skips every unavailable optional provider even with old production flags enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(gemini(compact())).mockRejectedValue(new Error("optional provider unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const env = environment();
    env.AI!.run = vi.fn(async () => { throw new Error("optional AI unavailable"); }) as never;
    const provider = { generate: vi.fn(async () => { throw new Error("image unavailable"); }) };
    const result = await generateSkin(env, await photo(), provider);
    await assertSkin(result.body as Parameters<typeof assertSkin>[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(env.AI!.run).not.toHaveBeenCalled();
    expect(provider.generate).not.toHaveBeenCalled();
  });
  it("rolls back a thrown optional image provider to the primary atlas in quality-work opt-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gemini(compact())));
    const env = { ...environment(), SYNCHRONOUS_ENHANCEMENTS_ENABLED: "true" };
    const result = await generateSkin(env, await photo(), { generate: vi.fn(async () => { throw new Error("image unavailable"); }) });
    await assertSkin(result.body as Parameters<typeof assertSkin>[0]);
  });
  it("does not lose a rendered PNG when advisory KV writes fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gemini(compact())));
    const env = environment();
    env.MCSKIN_KV.put = vi.fn(async () => { throw new Error("KV unavailable"); }) as never;
    const response = await worker.fetch(new Request("https://local/api/generate", { method: "POST", body: JSON.stringify({ image: await photo() }) }), env);
    expect(response.status).toBe(200);
    await assertSkin(await response.json());
  });
  it("stops malformed requests before any provider and returns structured errors", async () => {
    const env = environment();
    vi.stubGlobal("fetch", vi.fn());
    for (const body of [{ image: "data:image/jpeg;base64,/9j/", referenceImages: "not-array" }, { image: 7 }]) {
      const response = await worker.fetch(new Request("https://local/api/generate", { method: "POST", body: JSON.stringify(body) }), env);
      expect(response.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(env.AI!.run).not.toHaveBeenCalled();
  });
  it("exposes the same PNG contract on the versioned platform endpoint without analysis prose", async () => {
    const env = environment();
    const response = await worker.fetch(new Request("https://local/v1/skins", { method: "POST",
      body: JSON.stringify({ image: await photo() }) }), env);
    expect(response.status).toBe(200);
    const body = await response.json(); await assertSkin(body);
    expect(body.analysis).toBeUndefined(); expect(body.quota.capacityBasis).toBe("project_reserved");
  });
  it("bounds the reserved native provider deadline without retrying or calling paid HTTP", async () => {
    const image = await photo();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const env = environment();
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted=resolve; });
    env.AI!.run = vi.fn(() => { signalStarted(); return new Promise(() => {}); }) as never;
    const pending = generateFreeSkin(env, { image });
    // Wait for lazy schema imports and actual dispatch before moving time.
    await started;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await pending).toMatchObject({ status: 503, success: false, body: { errorCode: "provider_unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(env.AI!.run).toHaveBeenCalledTimes(1);
  });
});
