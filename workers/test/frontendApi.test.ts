import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, requestSkinGeneration } from "../../src/lib/cloudflareAI";
import { decodeSkinPng } from "../../src/lib/skinDecode";
import { bytesToBase64, encodePng } from "../src/png";
import { makeSyntheticAtlas } from "./helpers";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const image = "data:image/jpeg;base64,/9j/";
describe("frontend generation contract", () => {
  it("passes the server PNG to preview decoding even without optional features", async () => {
    const skinPngBase64 = bytesToBase64(await encodePng(makeSyntheticAtlas()));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, skinPngBase64, generationMode: "procedural_fallback" })));
    const result = await requestSkinGeneration(image);
    const drawImage = vi.fn();
    const canvas = { width: 64, height: 64, getContext: () => ({ drawImage }) };
    vi.stubGlobal("document", { createElement: () => canvas });
    class MockImage {
      width = 64; height = 64; onload?: () => void;
      set src(value: string) { expect(value).toBe(`data:image/png;base64,${skinPngBase64}`); this.onload?.(); }
    }
    vi.stubGlobal("Image", MockImage);
    expect(await decodeSkinPng(result.skinPngBase64!)).toBe(canvas);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["provider_unavailable", "rate_limited", "quota_exceeded", "SKIN_RENDER_FAILED"])("preserves distinct error %s without retry", async errorCode => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, errorCode, error: "unavailable" }, { status: 503 })));
    await expect(requestSkinGeneration(image)).rejects.toMatchObject({ code: errorCode });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "invalid-png"])("rejects success without a valid PNG: %s", async skinPngBase64 => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, skinPngBase64 })));
    await expect(requestSkinGeneration(image)).rejects.toMatchObject({ code: "SKIN_RENDER_FAILED" });
  });
  it("bounds response body reads, not just the time until headers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
    const pending = requestSkinGeneration(image).catch(error => error);
    await vi.advanceTimersByTimeAsync(150000);
    expect(await pending).toBeInstanceOf(ApiError);
    expect(await pending).toMatchObject({ code: "network" });
  });
  it("rejects oversize uploads before fetch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(requestSkinGeneration(image + "A".repeat(1500000))).rejects.toMatchObject({ code: "bad_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
