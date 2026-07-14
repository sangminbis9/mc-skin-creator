import { describe, expect, it, vi } from "vitest";
import {
  NEURONS_PER_GENERATION_ESTIMATE,
  commitNeurons,
  getQuotaStatus,
  markProviderQuotaExhausted,
} from "../src/quota";
import type { Env } from "../src/types";

function quotaEnv() {
  const values = new Map<string, string>();
  const env = {
    DAILY_BUDGET_RATIO: "0.5",
    MCSKIN_KV: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    },
  } as unknown as Env;
  return { env, values };
}

describe("provider quota circuit breaker", () => {
  const today = new Date("2026-07-15T01:00:00.000Z");

  it("reports local capacity before the provider closes the UTC day", async () => {
    const { env } = quotaEnv();
    const status = await getQuotaStatus(env, today);
    expect(status.level).toBe("available");
    expect(status.remainingGenerations).toBe(
      Math.floor(5_000 / NEURONS_PER_GENERATION_ESTIMATE),
    );
  });

  it("closes immediately after provider exhaustion and reopens next UTC day", async () => {
    const { env, values } = quotaEnv();
    await markProviderQuotaExhausted(env, today);

    expect(values.get("quota:provider-closed:2026-07-15")).toBe("1");
    expect(await getQuotaStatus(env, today)).toEqual({
      level: "closed",
      remainingGenerations: 0,
      resetAtIso: "2026-07-16T00:00:00.000Z",
      usedRatio: 1,
    });
    expect(
      await getQuotaStatus(env, new Date("2026-07-16T00:00:01.000Z")),
    ).toMatchObject({ level: "available" });
  });

  it("keeps local neuron accounting alongside the provider breaker", async () => {
    const { env, values } = quotaEnv();
    await commitNeurons(env, 236);
    expect(values.get(`quota:${new Date().toISOString().slice(0, 10)}`)).toBe(
      "236",
    );
  });
});
