import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Matching fingerprints in both 20260926 aperture start-state manifests.
// A regenerated result must never silently replace this historical baseline.
export const HISTORICAL_COMPACT_V2_FROZEN_SHA256 = "f651406ffa157cf3edf23afe990c117682feaa5f56cd6bb2b489e3b9c22d7d8a";

export async function readHistoricalCompactV2Frozen(): Promise<string> {
  const bytes = await readFile("evaluation-artifacts/compact-primary-v2-20260909/frozen-regression.json");
  if (createHash("sha256").update(bytes).digest("hex") !== HISTORICAL_COMPACT_V2_FROZEN_SHA256)
    throw new Error("historical_compact_v2_integrity_unverified: recover original bytes; do not regenerate baseline");
  return bytes.toString("utf8");
}
