import { describe, expect, it, vi } from "vitest";
import {
  NEURONS_IMAGE_GEN_QUALITY_CALL,
  NEURONS_PER_GENERATION_ESTIMATE,
  NEURONS_VISION_ANALYSIS_ESTIMATE,
  NEURONS_VISION_DETAIL_ESTIMATE,
  commitNeurons,
  estimatedNeuronsPerGeneration,
  getQuotaStatus,
  markProviderQuotaExhausted,
  visionNeuronsFromUsage,
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
    expect(status.capacityBasis).toBe("local_estimate");
  });

  it("uses the deployed Klein 9B cost instead of the 4B tile estimate", async () => {
    const { env } = quotaEnv();
    env.IMAGE_MODEL_TIER = "quality";

    const status = await getQuotaStatus(env, today);

    expect(estimatedNeuronsPerGeneration(env)).toBe(
      NEURONS_VISION_ANALYSIS_ESTIMATE +
        2 * NEURONS_VISION_DETAIL_ESTIMATE +
        NEURONS_IMAGE_GEN_QUALITY_CALL +
        NEURONS_IMAGE_GEN_QUALITY_CALL +
        66,
    );
    expect(status.remainingGenerations).toBe(1);
  });

  it("converts authoritative Llama token usage to Neurons", () => {
    expect(
      visionNeuronsFromUsage(
        {
          usage: {
            prompt_tokens: 10_000,
            completion_tokens: 2_000,
          },
        },
        170,
      ),
    ).toBe(400);
    expect(visionNeuronsFromUsage({ response: {} }, 170)).toBe(170);
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
      capacityBasis: "provider_reported_closed",
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
