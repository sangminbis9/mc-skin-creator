import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodePng, bytesToBase64 } from "../src/png";
import { makeSyntheticAtlas } from "./helpers";

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  const png = bytesToBase64(await encodePng(makeSyntheticAtlas(64)));
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true,
    skinPngBase64: png, generationMode: "procedural_fallback", analysis: { cue: "observed" }, quota: { level: "available" } }), { status: 200 }));
  // Return a fresh response for each deliberately distinct request.
  const body = { ok: true, skinPngBase64: png, generationMode: "procedural_fallback", analysis: { cue: "observed" }, quota: { level: "available" } };
  fetch.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  const { requestSkinGeneration } = await import("../../src/lib/cloudflareAI");
  return { fetch, requestSkinGeneration };
}
it("reuses successful same-image output without a second provider request or mutable result alias", async () => {
  const { fetch, requestSkinGeneration: generate } = await setup();
  const first = await generate("data:image/jpeg;base64,YQ==", "data:image/jpeg;base64,Yg==");
  first.skinPngBase64 = "edited-by-client";
  const second = await generate("data:image/jpeg;base64,YQ==", "data:image/jpeg;base64,Yg==");
  expect(second.skinPngBase64).not.toBe("edited-by-client");
  expect(second.quota).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("keys both derivatives and the ordered references", async () => {
  const { fetch, requestSkinGeneration: generate } = await setup();
  await generate("data:image/jpeg;base64,YQ==", "data:image/jpeg;base64,Yg==");
  await generate("data:image/jpeg;base64,Yw==", "data:image/jpeg;base64,Yg==");
  await generate("data:image/jpeg;base64,YQ==", "data:image/jpeg;base64,Yw==");
  await generate("data:image/jpeg;base64,YQ==", "data:image/jpeg;base64,Yg==", ["data:image/jpeg;base64,Yw=="]);
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("deduplicates concurrent requests and does not cache failures", async () => {
  const { fetch, requestSkinGeneration: generate } = await setup();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "temporary" }), { status: 503 }));
  await expect(generate("data:image/jpeg;base64,YQ==")).rejects.toThrow("temporary");
  const [a, b] = await Promise.all([generate("data:image/jpeg;base64,YQ=="), generate("data:image/jpeg;base64,YQ==")]);
  expect(a.skinPngBase64 === b.skinPngBase64).toBe(true); expect(a).not.toBe(b); expect(fetch).toHaveBeenCalledTimes(2);
});
it("expires results and bounds the session cache", async () => {
  const { fetch, requestSkinGeneration: generate } = await setup();
  const now = vi.spyOn(Date, "now").mockReturnValue(1);
  await generate("data:image/jpeg;base64,YQ==");
  now.mockReturnValue(86_400_002);
  await generate("data:image/jpeg;base64,YQ==");
  expect(fetch).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 8; i++) await generate(`data:image/jpeg;base64,${btoa(String(i))}`);
  await generate("data:image/jpeg;base64,YQ==");
  expect(fetch).toHaveBeenCalledTimes(11);
});

it("reuses across app reload without persisting source bytes or analysis", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } });
  const { fetch, requestSkinGeneration: generate } = await setup();
  const result = await generate("data:image/jpeg;base64,cHJpdmF0ZS1waG90bw==");
  const saved = [...values.values()][0];
  expect(saved.includes("cHJpdmF0ZS1waG90bw==")).toBe(false);
  expect(saved.includes("analysis")).toBe(false);
  expect(saved.includes("observed")).toBe(false);
  const record = JSON.parse(saved)[0];
  expect(Object.keys(record).sort()).toEqual(["expires", "key", "mode", "png"]);
  vi.resetModules();
  const reload = await import("../../src/lib/cloudflareAI");
  const repeated = await reload.requestSkinGeneration("data:image/jpeg;base64,cHJpdmF0ZS1waG90bw==");
  expect(repeated.skinPngBase64 === result.skinPngBase64).toBe(true);
  expect(repeated.analysis).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
});

it("ignores malformed/unavailable local storage without changing network success", async () => {
  vi.stubGlobal("localStorage", { getItem: () => "not-json", setItem: () => { throw new Error("disabled"); } });
  const { fetch, requestSkinGeneration: generate } = await setup();
  expect((await generate("data:image/jpeg;base64,YQ==")).ok).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
