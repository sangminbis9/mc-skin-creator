import { afterEach, expect, it, vi } from "vitest";
import { generateFreeSkin, freeQuotaStatus } from "../src/engineService";
import { FREE_VISION_MODEL, MAX_CALL_NEURONS, newBudgetState, reserveBudget, settleBudget, reportedGemmaNeurons } from "../src/freeBudget";
import { encodePng, bytesToBase64, base64ToBytes, decodePng } from "../src/png";
import { makeSyntheticAtlas } from "./helpers";
import { namedGemmaFixture, semanticFixture, wireFixture } from "./compactV3Support";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import { generateGeminiImage } from "../src/gemini";
afterEach(() => vi.restoreAllMocks());
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
it("uses exactly one reserved free model despite Gemini keys and enhancement flags, with no sensitive persistence", async () => {
  const s = await setup(), network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const result = await generateFreeSkin(s.env, { image: s.image });
  expect(result.success).toBe(true); expect(result.body.skinPngBase64).toBeTruthy();
  expect(validateFinalAtlas(await decodePng(base64ToBytes(result.body.skinPngBase64!))).ok).toBe(true);
  expect(s.run).toHaveBeenCalledTimes(1); expect(s.run.mock.calls[0][0]).toBe(FREE_VISION_MODEL);
  expect(s.reserve).toHaveBeenCalledTimes(1); expect(s.settle).toHaveBeenCalledTimes(1);
  expect(s.reserve.mock.invocationCallOrder[0]).toBeLessThan(s.run.mock.invocationCallOrder[0]);
  const wire = s.run.mock.calls[0][1]; expect(wire).toMatchObject({ temperature: 0, seed: 0, store: false, max_completion_tokens: 8192 });
  expect(JSON.stringify(wire)).toContain("Do not merge different outfits");
  expect(result.body.analysis).toBeUndefined(); expect(s.kv.put).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  expect(result.neuronsSpent).toBe(reportedGemmaNeurons({ usage: { prompt_tokens: 9000, completion_tokens: 3000 } }));
  expect(await freeQuotaStatus(s.env)).toMatchObject({ capacityBasis: "project_reserved", level: "available" });
});
it("blocks oversize/malformed input, absent budget and exhausted budget before any provider call", async () => {
  const s = await setup();
  expect((await generateFreeSkin(s.env, { image: "data:image/jpeg;base64,YQ==" })).status).toBe(400);
  const bomb = base64ToBytes(s.image.split(",")[1]); new DataView(bomb.buffer).setUint32(16, 100000);
  expect((await generateFreeSkin(s.env, { image: `data:image/png;base64,${bytesToBase64(bomb)}` })).status).toBe(400);
  expect((await generateFreeSkin({ ...s.env, NEURON_BUDGET: undefined }, { image: s.image })).status).toBe(503);
  s.state.used = 4900;
  expect((await generateFreeSkin(s.env, { image: s.image })).status).toBe(429);
  expect(s.run).not.toHaveBeenCalled();
});
it("rejects a direct paid-image helper invocation under the free policy", async () => {
  const s = await setup(), net = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not dispatch"));
  await expect(generateGeminiImage({ ...s.env, AI_POLICY: "workers_free_only" }, {
    model: "gemini-3.1-flash-image", prompt: "private prompt", images: [], seed: 0,
  })).rejects.toThrow("disabled by free policy");
  expect(net).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled();
});
it("retains full failed-call cost without retrying or storing provider error content", async () => {
  const s = await setup(), log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  s.run.mockRejectedValue(new Error("private-photo data:image/jpeg;base64,secret API credential"));
  const result = await generateFreeSkin(s.env, { image: s.image });
  expect(result.success).toBe(false); expect(s.run).toHaveBeenCalledTimes(1);
  expect(s.state.used).toBe(MAX_CALL_NEURONS); expect(s.settle).not.toHaveBeenCalled(); expect(s.kv.put).not.toHaveBeenCalled();
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
