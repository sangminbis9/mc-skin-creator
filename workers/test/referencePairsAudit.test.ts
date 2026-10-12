// Opt-in, read-only reference measurement. Reference pixels never enter production.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT, SLIM_LAYOUT } from "../src/uvLayout";

const sourceRoot = process.env.REFERENCE_PAIRS_DIRECTORY;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function sheet(images: RawImage[]): RawImage {
  const w = images[0].width, h = images[0].height, columns = 4;
  const out = { width: w * columns, height: h * 2, rgba: new Uint8Array(w * columns * h * 2 * 4) };
  for (const [i, image] of images.entries()) for (let y = 0; y < h; y++) {
    out.rgba.set(image.rgba.subarray(y * w * 4, (y + 1) * w * 4),
      ((Math.floor(i / columns) * h + y) * out.width + i % columns * w) * 4);
  }
  return out;
}

it.skipIf(!sourceRoot)("records eight supplied pairs and renders both arm interpretations without modifying inputs", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = mkdtempSync("evaluation-artifacts/reference-pairs-review-20261008-");
    const entries = [], galleries = new Map<string, RawImage[]>();
    for (let i = 0; i < 8; i++) {
      const id = String.fromCharCode(65 + i);
      const atlasPath = path.join(sourceRoot!, `image-${i * 2 + 1}.png`);
      const photoPath = path.join(sourceRoot!, `image-${i * 2 + 2}.png`);
      const atlasBytes = readFileSync(atlasPath), photoBytes = readFileSync(photoPath);
      const atlas = await decodePng(atlasBytes);
      const photo = await decodePng(photoBytes);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      const measurements = [];
      for (const geometry of ["classic", "slim"] as const) {
        const layout = geometry === "classic" ? CLASSIC_LAYOUT : SLIM_LAYOUT;
        const coverage = Object.fromEntries(Object.entries(layout).map(([part, box]) => {
          let occupied = 0, cells = 0;
          for (const r of Object.values(box.overlay)) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
            cells++;
            if (atlas.rgba[((r.y + y) * 64 + r.x + x) * 4 + 3]) occupied++;
          }
          return [part, { occupied, cells, ratio: occupied / cells }];
        }));
        measurements.push({ geometry, outerAlphaCoverage: coverage });
        for (const view of renderSkinViews(atlas, geometry)) {
          const key = `${geometry}-${view.name}`;
          const images = galleries.get(key) ?? [];
          images.push(view.image); galleries.set(key, images);
        }
      }
      writeFileSync(`${root}/${id}-atlas-nearest.png`, await encodePng(scaleNearestNeighbor(atlas, 512, 512)), { flag: "wx" });
      expect(readFileSync(atlasPath)).toEqual(atlasBytes);
      expect(readFileSync(photoPath)).toEqual(photoBytes);
      entries.push({ id, atlasInput: path.basename(atlasPath), photoInput: path.basename(photoPath),
        atlasSha256: sha(atlasBytes), photoSha256: sha(photoBytes),
        photoDimensions: [photo.width, photo.height], measurements });
    }
    for (const [name, images] of galleries) {
      expect(images).toHaveLength(8);
      const all = sheet(images);
      writeFileSync(`${root}/${name}.png`, await encodePng(scaleNearestNeighbor(all, all.width * 3, all.height * 3)), { flag: "wx" });
    }
    writeFileSync(`${root}/measurements.json`, JSON.stringify({ providerCalls: 0,
      note: "Atlas alpha coverage is not hair segmentation or a universal beauty threshold; arm geometry is not presumed.", entries }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled();
    console.info(`REFERENCE_PAIRS_REVIEW ${root}`);
  } finally { network.mockRestore(); }
}, 60000);
