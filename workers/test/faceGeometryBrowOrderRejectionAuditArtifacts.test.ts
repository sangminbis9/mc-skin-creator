import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA } from "../src/faceIdentityGeometry";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const root = "evaluation-artifacts/face-geometry-brow-order-rejection-audit-20260923-001";
const rejectedRoot = "evaluation-artifacts/face-geometry-openness-open-directional-live-20260922-001";
const contractRoot = "evaluation-artifacts/face-geometry-openness-contract-live-20260922-001";
const normalRoot = "evaluation-artifacts/face-geometry-openness-normal-anchor-live-20260922-001";
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

it("classifies the bilateral brow-order rejection without provider calls or salvage", async () => {
  const rejectedBytes = await readFile(`${rejectedRoot}/summary.json`);
  const rejected = JSON.parse(rejectedBytes.toString("utf8")) as {
    calls: { primaryPosts: number; geometryPosts: number };
    providerCalls: { geminiStarted: number; gemmaStarted: number; retry: number };
    geometryResults: Array<{ measurements: { eyes: { leftCenterY: number; rightCenterY: number; openness: number; confidence: number };
      brows: { leftGap: number; rightGap: number; confidence: number } }; errors: string[] }>;
  };
  expect(hash(rejectedBytes)).toBe("7b937f7dfb28b68664f551a7dc66419b6b512f19dc2b1b7ead0d4f476850369f");
  expect(rejected.calls).toMatchObject({ primaryPosts: 0, geometryPosts: 1 });
  expect(rejected.providerCalls).toMatchObject({ geminiStarted: 0, gemmaStarted: 1, retry: 0 });
  const result = rejected.geometryResults[0];
  expect(result.errors).toEqual(["faceGeometry.brows:above_eyes"]);
  const leftY = result.measurements.eyes.leftCenterY - result.measurements.brows.leftGap;
  const rightY = result.measurements.eyes.rightCenterY - result.measurements.brows.rightGap;
  expect({ leftY, rightY }).toEqual({ leftY: 1, rightY: 1 });
  expect(result.measurements.brows.leftGap * 308).toBeCloseTo(-218.68);
  expect(result.measurements.brows.rightGap * 308).toBeCloseTo(-218.68);
  expect(result.measurements.eyes.openness).toBe(0.6);

  expect(hash(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe("00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd");
  expect(hash(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe("3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469");
  expect(FACE_IDENTITY_GEOMETRY_PROMPT).toContain("top=0, bottom=1");
  expect(FACE_IDENTITY_GEOMETRY_PROMPT).toContain("Y at each brow center");
  expect(FACE_IDENTITY_GEOMETRY_PROMPT).toContain("Confident brows are above eyes");

  const postContractBytes = await readFile(`${contractRoot}/summary.json`);
  const normalBytes = await readFile(`${normalRoot}/summary.json`);
  expect(hash(postContractBytes)).toBe("16e461ea69b3345694c4b064febb8b1f734369afc1643f09538bfb45be600927");
  expect(hash(normalBytes)).toBe("a72b396ae0d73b23228d478968fdf17bd6ab59287acecdd869455898f17f8240");
  const summaries = [JSON.parse(postContractBytes.toString("utf8")), JSON.parse(normalBytes.toString("utf8"))] as Array<{
    geometryResults: Array<{ measurements: { brows: { leftGap: number; rightGap: number } }; ok: boolean; semanticValidationPassed: boolean }>;
  }>;
  const valid = summaries.flatMap(summary => summary.geometryResults);
  expect(valid).toHaveLength(3);
  expect(valid.every(item => item.ok && item.semanticValidationPassed
    && item.measurements.brows.leftGap > 0 && item.measurements.brows.rightGap > 0)).toBe(true);
  expect(Math.min(...valid.flatMap(item => [item.measurements.brows.leftGap, item.measurements.brows.rightGap]))).toBe(0.06);

  const cause = await readJson<{ classification: string; externalCalls: number; thresholdsChanged: boolean }>(`${root}/cause-ranking.json`);
  const granularity = await readJson<{ secondaryArchitectureIssue: string; salvagePerformed: boolean;
    historicalRejectedOpennessPromoted: boolean }>(`${root}/granularity-audit.json`);
  expect(cause).toEqual(expect.objectContaining({ classification: "PROVIDER_BROW_COORDINATE_ERROR", externalCalls: 0, thresholdsChanged: false }));
  expect(granularity).toEqual(expect.objectContaining({ secondaryArchitectureIssue: "VALIDATOR_GROUP_GRANULARITY_TOO_COARSE",
    salvagePerformed: false, historicalRejectedOpennessPromoted: false }));
});
