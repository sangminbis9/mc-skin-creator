import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createIdentityCrops } from "../src/generate";

const root = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001");
const source = path.join(root, "source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
const frozen = path.join(root, "frozen-open-label.json");
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

it("rejects the frozen original at the unchanged production JPEG decoder before portrait-region cropping", async () => {
  const bytes = fs.readFileSync(source);
  const label = JSON.parse(fs.readFileSync(frozen, "utf8")) as {
    payload: { caseId: string; label: { eyeOpenness: string }; labelFrozenBeforeProvider: boolean };
    payloadSha256: string;
  };
  expect(bytes.length).toBe(3_497_355);
  expect(sha256(bytes)).toBe("a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac");
  expect(sha256(JSON.stringify(label.payload))).toBe("b1c7a8fb3bb8275e5d656420e4bbc418992815c1aefb402896875dc441bc10ed");
  expect(label.payloadSha256).toBe("b1c7a8fb3bb8275e5d656420e4bbc418992815c1aefb402896875dc441bc10ed");
  expect(label.payload).toMatchObject({
    caseId: "open-eye-calibration-001",
    label: { eyeOpenness: "open" },
    labelFrozenBeforeProvider: true,
  });
  const crops = await createIdentityCrops(`data:image/jpeg;base64,${bytes.toString("base64")}`, null, {});
  expect(crops).toBeNull();
});
