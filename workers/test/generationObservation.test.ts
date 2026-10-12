import { expect, it, vi } from "vitest";
import { GENERATION_OBSERVER, generationObserver } from "../src/generationObservation";

it("requires the internal symbol and has no shared request state", () => {
  const first = vi.fn(); const second = vi.fn();
  const a = generationObserver({ [GENERATION_OBSERVER]: first });
  const b = generationObserver({ [GENERATION_OBSERVER]: second });
  a("primary_returned"); b("png_finished"); a("baseline_returned");
  generationObserver({})("png_finished");
  // Serialized public configuration cannot construct the private symbol key.
  generationObserver(JSON.parse('{"generation_observer":"enabled"}'))("png_finished");
  expect(first.mock.calls).toEqual([["primary_returned"], ["baseline_returned"]]);
  expect(second.mock.calls).toEqual([["png_finished"]]);
});

it("does not propagate synchronous or asynchronous observation failures", async () => {
  const sync = generationObserver({ [GENERATION_OBSERVER]: () => { throw new Error("synthetic"); } });
  const async = generationObserver({ [GENERATION_OBSERVER]: async () => { throw new Error("synthetic"); } });
  expect(() => sync("primary_returned")).not.toThrow();
  expect(() => async("primary_returned")).not.toThrow();
  const brokenContext = { get [GENERATION_OBSERVER](): never { throw new Error("getter"); } };
  expect(() => generationObserver(brokenContext)("primary_returned")).not.toThrow();
  await Promise.resolve(); // rejected observer is already handled, never awaited by the pipeline
});
