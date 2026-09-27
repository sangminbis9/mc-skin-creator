import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, it } from "vitest";
import { decodeImage, encodePng } from "../src/png";
import { MAX_IMAGE_CHARS } from "../src/generate";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = path.resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
const corpus = path.resolve("evaluation-artifacts/generalization-20260905/sources");
const dataUrlLength = (bytes: number) => "data:image/jpeg;base64,".length + 4 * Math.ceil(bytes / 3);

it("separates the frozen original's public input-length rejection from decoder capacity", () => {
  const bytes = fs.readFileSync(source);
  expect(sha256(bytes)).toBe("a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac");
  expect(dataUrlLength(bytes.length)).toBe(4_663_163);
  expect(dataUrlLength(bytes.length)).toBeGreaterThan(MAX_IMAGE_CHARS);
  expect(() => decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 64 })).toThrow(/maxMemoryUsageInMB limit exceeded/);
  expect(() => decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 126 })).toThrow(/maxMemoryUsageInMB limit exceeded/);
  const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 127 });
  expect({ width: decoded.width, height: decoded.height, bytes: decoded.data.length }).toEqual({
    width: 2002, height: 3000, bytes: 24_024_000,
  });
  expect(sha256(decoded.data)).toBe("235b852bbcc9acf02d84e484705d7174a1bbb33748bf5f12ce1aa47f9a7a9c89");
}, 20_000);

it("shows a separate accepted-length corpus JPEG crosses the current decoder cap", () => {
  const bytes = fs.readFileSync(path.join(corpus, "17893810.jpg"));
  expect(sha256(bytes)).toBe("9b482fd0d2e88566fc3a75340f4047b3a55e20aabe56dbb502b5c022dbe7a5be");
  expect(dataUrlLength(bytes.length)).toBe(892_887);
  expect(dataUrlLength(bytes.length)).toBeLessThan(MAX_IMAGE_CHARS);
  expect(() => decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 64 })).toThrow(/maxMemoryUsageInMB limit exceeded/);
});

it("preserves ordinary JPEG pixels across budgets and leaves the PNG path usable", async () => {
  const bytes = fs.readFileSync(path.join(corpus, "19908659.jpg"));
  const normal = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 64 });
  const largerBudget = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 127 });
  expect(sha256(normal.data)).toBe(sha256(largerBudget.data));

  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]);
  const png = await encodePng({ width: 2, height: 2, rgba });
  const decoded = await decodeImage(png);
  expect({ width: decoded.width, height: decoded.height, rgba: [...decoded.rgba] }).toEqual({
    width: 2, height: 2, rgba: [...rgba],
  });
});
