import assert from "node:assert/strict";
import { test } from "node:test";
import { generationReuseKey, isGenerationReuseKey, SKIN_PRESENTATIONS } from "../src/lib/skinPresentation.ts";

test("same photos are cached separately for each avatar finish", () => {
  const photos = ["a".repeat(64), "b".repeat(64)];
  const keys = SKIN_PRESENTATIONS.map(({ value }) => generationReuseKey(value, photos));
  assert.equal(new Set(keys).size, 3);
  assert.ok(keys.every(isGenerationReuseKey));
  assert.equal(isGenerationReuseKey(photos.join(":")), false);
  assert.equal(isGenerationReuseKey(`unknown:${photos.join(":")}`), false);
});
