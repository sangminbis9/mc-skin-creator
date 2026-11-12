import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePhotoColors } from "../src/lib/photoColors.ts";

test("device generation uses the portrait palette and ignores its warm backdrop", () => {
  const width = 72;
  const height = 96;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = [217, 194, 172, 255];
      if (x >= 22 && x < 50 && y >= 5 && y < 41) color = [51, 38, 32, 255];
      if (x >= 27 && x < 45 && y >= 18 && y < 35) color = [149, 100, 72, 255];
      if (x >= 15 && x < 57 && y >= 41 && y < 80) color = [48, 102, 147, 255];
      data.set(color, (y * width + x) * 4);
    }
  }
  assert.deepEqual(estimatePhotoColors({ width, height, data } as ImageData), {
    skinTone: "#956448", hairColor: "#332620", topColor: "#306693",
  });
});
