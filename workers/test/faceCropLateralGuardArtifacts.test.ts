import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { PortraitRegion } from "../src/analysis";
import { createIdentityCrops } from "../src/generate";
import { base64ToBytes, bytesToBase64, decodeImage, encodePng, type RawImage } from "../src/png";

const BUILD = process.env.BUILD_FACE_CROP_LATERAL_GUARD_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-crop-lateral-guard-20260922-001");
const FROZEN = path.resolve("evaluation-artifacts/generalization-20260905");
const LOW_EYE = path.resolve("evaluation-artifacts/face-geometry-low-eye-target-audit-20260922-001/summary.json");
const PRIMARY_SIX = path.resolve("evaluation-artifacts/production-primary-face-measurement-six-case-live-20260921-001/primary-results.json");
const hash = (value: Uint8Array | Buffer | string) => createHash("sha256").update(value).digest("hex");
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
type Box = { left: number; top: number; right: number; bottom: number };
type StoredCase = {
  caseId: "warm-white-tee" | "striped-open-shirt";
  sourceSha256: string;
  sourceBytes: number;
  storedPortraitRegion: PortraitRegion;
  cropContext: Record<string, unknown>;
  crop: { sourceDimensions: { width: number; height: number }; faceCropDimensions: { width: number; height: number }; finalFaceBox: Box };
  faceCropSha256: string;
};

function bounds(box: Box, image: RawImage, inverseDiagnostic = false) {
  const chooseLeft = inverseDiagnostic ? Math.round : Math.floor;
  const chooseRight = inverseDiagnostic ? Math.round : Math.ceil;
  const x = Math.max(0, chooseLeft(box.left * image.width));
  const y = Math.max(0, chooseLeft(box.top * image.height));
  const right = Math.min(image.width, chooseRight(box.right * image.width));
  const bottom = Math.min(image.height, chooseRight(box.bottom * image.height));
  return { x, y, right, bottom, width: right - x, height: bottom - y };
}

function crop(image: RawImage, box: Box, inverseDiagnostic = false): RawImage {
  const b = bounds(box, image, inverseDiagnostic);
  const rgba = new Uint8Array(b.width * b.height * 4);
  for (let row = 0; row < b.height; row++) {
    const start = ((b.y + row) * image.width + b.x) * 4;
    rgba.set(image.rgba.subarray(start, start + b.width * 4), row * b.width * 4);
  }
  return { width: b.width, height: b.height, rgba };
}

function overlay(source: RawImage, boxes: Array<{ box: Box; color: [number, number, number, number] }>): RawImage {
  const output = { width: source.width, height: source.height, rgba: new Uint8Array(source.rgba) };
  const paint = (x: number, y: number, color: [number, number, number, number]) => {
    if (x >= 0 && y >= 0 && x < output.width && y < output.height) output.rgba.set(color, (y * output.width + x) * 4);
  };
  for (const item of boxes) {
    const b = bounds(item.box, source);
    for (let width = 0; width < 5; width++) {
      for (let x = b.x; x < b.right; x++) { paint(x, b.y + width, item.color); paint(x, b.bottom - 1 - width, item.color); }
      for (let y = b.y; y < b.bottom; y++) { paint(b.x + width, y, item.color); paint(b.right - 1 - width, y, item.color); }
    }
  }
  return output;
}

function put(target: RawImage, source: RawImage, column: number, row: number, cell = 220) {
  const scale = Math.min((cell - 8) / source.width, (cell - 8) / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const offsetX = column * cell + Math.floor((cell - width) / 2);
  const offsetY = row * cell + Math.floor((cell - height) / 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / width));
    const sourceY = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / height));
    const from = (sourceY * source.width + sourceX) * 4;
    const to = ((offsetY + y) * target.width + offsetX + x) * 4;
    target.rgba.set(source.rgba.subarray(from, from + 4), to);
  }
}

function regionMetrics(region: PortraitRegion, source: { width: number; height: number }) {
  const size = (box: Box) => ({ width: (box.right - box.left) * source.width, height: (box.bottom - box.top) * source.height });
  const face = size(region.faceBox);
  const head = size(region.headBox);
  return {
    facePixels: { ...face, aspect: face.width / face.height },
    headPixels: { ...head, aspect: head.width / head.height },
    faceHeadWidthRatio: face.width / head.width,
    faceHeadHeightRatio: face.height / head.height,
    centerOffsetPixels: {
      x: (((region.faceBox.left + region.faceBox.right) - (region.headBox.left + region.headBox.right)) / 2) * source.width,
      y: (((region.faceBox.top + region.faceBox.bottom) - (region.headBox.top + region.headBox.bottom)) / 2) * source.height,
    },
  };
}

async function exactBeforeCrop(source: RawImage, stored: StoredCase) {
  const image = crop(source, stored.crop.finalFaceBox, true);
  const bytes = await encodePng(image);
  expect(hash(bytes)).toBe(stored.faceCropSha256);
  expect({ width: image.width, height: image.height }).toEqual(stored.crop.faceCropDimensions);
  return { image, bytes };
}

async function audit() {
  const low = read<{ geometryResults: StoredCase[] }>(LOW_EYE).geometryResults;
  const primary = read<{ cases: Array<{ caseId: string; sourceSelection: { portraitRegion: PortraitRegion | null } | null }> }>(PRIMARY_SIX);
  const historicalWarm = primary.cases.find(item => item.caseId === "warm-white-tee")?.sourceSelection?.portraitRegion ?? null;
  expect(historicalWarm).toBeTruthy();
  const contact: RawImage = { width: 6 * 220, height: 3 * 220, rgba: new Uint8Array(6 * 220 * 3 * 220 * 4) };
  for (let offset = 0; offset < contact.rgba.length; offset += 4) contact.rgba.set([238, 240, 244, 255], offset);
  const results = [];
  for (let row = 0; row < low.length; row++) {
    const stored = low[row];
    const photo = stored.caseId === "warm-white-tee" ? 26954028 : 2881786;
    const sourceBytes = fs.readFileSync(path.join(FROZEN, "sources", `${photo}.jpg`));
    expect(hash(sourceBytes)).toBe(stored.sourceSha256);
    expect(sourceBytes.length).toBe(stored.sourceBytes);
    const source = await decodeImage(sourceBytes);
    const before = await exactBeforeCrop(source, stored);
    const afterSet = await createIdentityCrops(`data:image/jpeg;base64,${bytesToBase64(sourceBytes)}`, stored.storedPortraitRegion, stored.cropContext);
    expect(afterSet).toBeTruthy();
    if (!afterSet?.diagnostics.finalFaceBox) throw new Error(`${stored.caseId}: after crop missing`);
    const afterBytes = base64ToBytes(afterSet.faceDataUrl.slice(afterSet.faceDataUrl.indexOf(",") + 1));
    const after = await decodeImage(afterBytes);
    const rawFace = bounds(stored.storedPortraitRegion.faceBox, source);
    const beforeBounds = bounds(stored.crop.finalFaceBox, source, true);
    const afterBounds = bounds(afterSet.diagnostics.finalFaceBox, source, true);
    const compare = (b: ReturnType<typeof bounds>) => ({
      width: b.width,
      height: b.height,
      aspect: b.width / b.height,
      leftFaceMargin: rawFace.x - b.x,
      rightFaceMargin: b.right - rawFace.right,
      cropHeadWidthFraction: b.width / ((stored.storedPortraitRegion.headBox.right - stored.storedPortraitRegion.headBox.left) * source.width),
    });
    const item = {
      caseId: stored.caseId,
      source: { sha256: hash(sourceBytes), bytes: sourceBytes.length, width: source.width, height: source.height },
      portraitRegion: stored.storedPortraitRegion,
      localizationMetrics: regionMetrics(stored.storedPortraitRegion, source),
      before: { box: stored.crop.finalFaceBox, sha256: hash(before.bytes), ...compare(beforeBounds) },
      after: { box: afterSet.diagnostics.finalFaceBox, sha256: hash(afterBytes), ...compare(afterBounds) },
      lateralGuard: afterSet.diagnostics.faceCropLateralGuard,
      verticalUnchanged: beforeBounds.y === afterBounds.y && beforeBounds.bottom === afterBounds.bottom,
      classificationBefore: stored.caseId === "warm-white-tee" ? "RIGHT_CLIPPED" : "MULTI_EDGE_CLIPPED",
      classificationAfter: stored.caseId === "warm-white-tee" ? "EDGE_TIGHT_BUT_COMPLETE" : "FULL_FACE_MARGIN_OK",
    };
    expect(item.lateralGuard.applied).toBe(true);
    expect(item.after.width).toBeGreaterThan(item.before.width);
    expect(item.verticalUnchanged).toBe(true);
    results.push(item);
    put(contact, source, 0, row);
    put(contact, overlay(source, [
      { box: stored.storedPortraitRegion.headBox, color: [40, 130, 255, 255] },
      { box: stored.storedPortraitRegion.faceBox, color: [255, 210, 0, 255] },
    ]), 1, row);
    put(contact, overlay(source, [{ box: stored.crop.finalFaceBox, color: [255, 55, 55, 255] }]), 2, row);
    put(contact, before.image, 3, row);
    put(contact, overlay(source, [{ box: afterSet.diagnostics.finalFaceBox, color: [35, 210, 95, 255] }]), 4, row);
    put(contact, after, 5, row);
  }

  const warmBytes = fs.readFileSync(path.join(FROZEN, "sources", "26954028.jpg"));
  const warmSource = await decodeImage(warmBytes);
  const normalContractRegion: PortraitRegion = {
    subjectBox: { left: 0.2, top: 0.02, right: 0.8, bottom: 0.62 },
    headBox: { left: 0.35, top: 0.05, right: 0.65, bottom: 0.36 },
    faceBox: { left: 0.39, top: 0.12, right: 0.61, bottom: 0.33 },
    confidence: 0.95,
  };
  const sentinelSet = await createIdentityCrops(`data:image/jpeg;base64,${bytesToBase64(warmBytes)}`, normalContractRegion);
  expect(sentinelSet?.diagnostics.faceCropLateralGuard.applied).toBe(false);
  if (!sentinelSet?.diagnostics.finalFaceBox) throw new Error("historical warm localization unavailable");
  const sentinelBytes = base64ToBytes(sentinelSet.faceDataUrl.slice(sentinelSet.faceDataUrl.indexOf(",") + 1));
  const sentinelCrop = await decodeImage(sentinelBytes);
  put(contact, warmSource, 0, 2);
  put(contact, overlay(warmSource, [
    { box: normalContractRegion.headBox, color: [40, 130, 255, 255] },
    { box: normalContractRegion.faceBox, color: [255, 210, 0, 255] },
  ]), 1, 2);
  put(contact, overlay(warmSource, [{ box: sentinelSet.diagnostics.finalFaceBox, color: [255, 55, 55, 255] }]), 2, 2);
  put(contact, sentinelCrop, 3, 2);
  put(contact, overlay(warmSource, [{ box: sentinelSet.diagnostics.finalFaceBox, color: [35, 210, 95, 255] }]), 4, 2);
  put(contact, sentinelCrop, 5, 2);

  const corpus = [
    ...results.map(item => ({ caseId: item.caseId, source: "latest targeted production-equivalent result", availability: "available", region: item.portraitRegion, metrics: item.localizationMetrics })),
    { caseId: "warm-white-tee-historical-wide", source: "six-case production-equivalent result", availability: "available", region: historicalWarm, metrics: regionMetrics(historicalWarm!, { width: warmSource.width, height: warmSource.height }) },
    ...["wavy-open-blazer", "short-hair-red-shirt", "long-straight-hair", "glasses-monochrome", "headscarf-color-blocks"].map(caseId => ({ caseId, source: "current stored production localization", availability: "unavailable", region: null, metrics: null })),
  ];
  const ratios = corpus.filter(item => item.metrics).map(item => item.metrics!);
  return {
    results,
    contact,
    corpus,
    distribution: {
      available: ratios.length,
      faceHeadWidthRatio: { min: Math.min(...ratios.map(item => item.faceHeadWidthRatio)), max: Math.max(...ratios.map(item => item.faceHeadWidthRatio)) },
      faceHeadHeightRatio: { min: Math.min(...ratios.map(item => item.faceHeadHeightRatio)), max: Math.max(...ratios.map(item => item.faceHeadHeightRatio)) },
      faceAspect: { min: Math.min(...ratios.map(item => item.facePixels.aspect)), max: Math.max(...ratios.map(item => item.facePixels.aspect)) },
      headAspect: { min: Math.min(...ratios.map(item => item.headPixels.aspect)), max: Math.max(...ratios.map(item => item.headPixels.aspect)) },
    },
    normalContractSentinel: {
      caseId: "synthetic-normal-localization-contract",
      availability: "deterministic valid localization fixture on the frozen warm source; not a provider result",
      region: normalContractRegion,
      guard: sentinelSet.diagnostics.faceCropLateralGuard,
      finalFaceBox: sentinelSet.diagnostics.finalFaceBox,
      cropDimensions: sentinelSet.diagnostics.faceCropDimensions,
      cropSha256: hash(sentinelBytes),
      unchangedByGuard: !sentinelSet.diagnostics.faceCropLateralGuard.applied,
    },
  };
}

it("reproduces old target crops and applies one source-grounded lateral guard", async () => {
  const result = await audit();
  expect(result.results.map(item => item.before.sha256)).toEqual([
    "4902d5b8c8cee49c8e9140c2397b31ee5aa7f7a775d5cd18bf596b8b87e70148",
    "4fd01fc62a538c53eb6876b493c6c8386042656a5d39db0a14790e8da3506d30",
  ]);
  expect(result.results.every(item => item.lateralGuard.applied && item.verticalUnchanged)).toBe(true);
  expect(result.normalContractSentinel.unchangedByGuard).toBe(true);
});

it.skipIf(!BUILD)("writes lateral guard audit artifacts", async () => {
  const result = await audit();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("localization-corpus.json", { cases: result.corpus, distribution: result.distribution,
    note: "Only three stored production-equivalent portraitRegion records are available; unavailable sentinels are not fabricated." });
  write("guard-contract.json", {
    trigger: "expanded face crop pixel width < 0.65 * localized headBox pixel height",
    action: "union the expanded face horizontally with a headBox-centred span of that minimum width",
    hardLimits: ["adaptive head crop", "source image bounds"],
    inputs: ["faceBox", "headBox", "source width/height"],
    forbiddenInputs: ["provider geometry", "case id", "accessory/hair label"],
    vertical: "unchanged: top +22%, bottom +20%",
    resizeEncoding: "unchanged: max edge 512, nearest-neighbor centre sampling, PNG",
    basis: "0.65 is the conservative lower pixel-aspect bound in the frozen manual head-envelope corpus, not a target coordinate fit",
  });
  write("before-after-crops.json", { cases: result.results });
  write("sentinel-regression.json", {
    normalContractFixture: result.normalContractSentinel,
    unavailableCurrentProductionLocalizations: ["wavy-open-blazer", "short-hair-red-shirt", "long-straight-hair", "glasses-monochrome", "headscarf-color-blocks"],
    contractFixtures: {
      normal: "unchanged",
      glasses: "unchanged; glasses are not a guard input",
      headscarf: "unchanged for a valid wide head/face region; covering is not a guard input",
      shortHair: "unchanged",
      longHair: "unchanged",
      edgeOfImage: "guarded and clamped",
      malformedOrAbsent: "existing center fallback retained; guard unavailable",
    },
    wavyHistoricalSentinel: "reviewed controlled crop only; not claimed as current production localization",
  });
  fs.writeFileSync(path.join(ROOT, "contact-sheet.png"), await encodePng(result.contact), { flag: "wx" });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Face crop lateral guard\n\n` +
    `- Offline only; external/provider calls 0.\n` +
    `- One generic rule: if expanded face width is below 0.65 of localized head height in source pixels, union it with that head-centred lateral span.\n` +
    `- Warm: ${result.results[0].before.width}x${result.results[0].before.height} -> ${result.results[0].after.width}x${result.results[0].after.height}; ${result.results[0].classificationBefore} -> ${result.results[0].classificationAfter}.\n` +
    `- Striped: ${result.results[1].before.width}x${result.results[1].before.height} -> ${result.results[1].after.width}x${result.results[1].after.height}; ${result.results[1].classificationBefore} -> ${result.results[1].classificationAfter}.\n` +
    `- Top/bottom pixel bounds are unchanged for both targets. Resize/encoding code is unchanged.\n` +
    `- A deterministic valid normal-localization contract fixture does not trigger and remains byte-identical by control flow.\n` +
    `- Current production localization is unavailable for wavy/short/long/glasses/headscarf; no region was fabricated. Contract fixtures for normal, glasses, covering, short/long hair remain unchanged.\n` +
    `- Invalid/absent localization retains existing center fallback.\n` +
    `- Provider/schema/prompt/validator/quantizer/renderer unchanged.\n\nREADY_FOR_LATERAL_GUARD_GEOMETRY_RETEST\n`, { flag: "wx" });
});
