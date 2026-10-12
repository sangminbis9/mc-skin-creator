import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { SkinModel } from "../../src/editor/SkinModel";
import { MINECRAFT_BOX_FACE_ORDER } from "../../src/lib/skinAtlas";
import { CLASSIC_LAYOUT, type BoxUV } from "../src/uvLayout";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinInspectionView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const yaws = [315, 45, 225, 135];
function sheet(images: RawImage[], columns: number): RawImage {
  const w = images[0].width, h = images[0].height, width = w * columns, height = h * Math.ceil(images.length / columns);
  const out = { width, height, rgba: new Uint8Array(width * height * 4) };
  images.forEach((v, n) => { for (let y = 0; y < h; y++) out.rgba.set(v.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((Math.floor(n / columns) * h + y) * width + n % columns * w) * 4); });
  return out;
}
function head(image: RawImage): RawImage {
  const out = { width: 96, height: 80, rgba: new Uint8Array(96 * 80 * 4) };
  for (let y = 0; y < 80; y++) out.rgba.set(image.rgba.subarray(((y + 8) * image.width + 48) * 4, ((y + 8) * image.width + 144) * 4), y * 96 * 4);
  return scaleNearestNeighbor(out, 288, 240);
}
/** Diagnostic control only: reversing side texels cancels the corrected
 * sampler and reproduces the former side sampling. Source bytes stay intact. */
function legacySideViewInput(atlas: RawImage): RawImage {
  const copy = { ...atlas, rgba: atlas.rgba.slice() };
  for (const part of Object.values(CLASSIC_LAYOUT)) for (const layer of ["base", "overlay"] as const) for (const face of ["right", "left"] as const) {
    const r = part[layer][face];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const src = ((r.y + y) * 64 + r.x + r.w - 1 - x) * 4;
      copy.rgba.set(atlas.rgba.subarray(src, src + 4), ((r.y + y) * 64 + r.x + x) * 4);
    }
  }
  return copy;
}

it.each(["base", "overlay"] as const)("matches actual app geometry for all six faces including every edge and corner on %s", layer => {
  // CanvasTexture does not need a DOM/WebGL context to inspect its UV buffer.
  const model = new SkinModel({ width: 64, height: 64 } as HTMLCanvasElement);
  try {
    const geometry = model.meshes[layer === "base" ? 0 : 1].geometry;
    const positions = geometry.getAttribute("position"), uv = geometry.getAttribute("uv");
    const atlas: RawImage = { width: 64, height: 64, rgba: new Uint8Array(16384) };
    for (const r of Object.values(CLASSIC_LAYOUT.head[layer])) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++)
      atlas.rgba.set([40 + (r.x + x) * 2, 40 + (r.y + y) * 2, 160, 255], ((r.y + y) * 64 + r.x + x) * 4);
    const immutable = hash(atlas.rgba);
    const views = new Map(yaws.map(yaw => [yaw, renderSkinInspectionView(atlas, yaw)]));
    const poles = new Map([60, -60].map(pitch => [pitch, renderSkinInspectionView(atlas, 0, pitch)]));
    const reversed = legacySideViewInput(atlas);
    const oldViews = new Map(yaws.map(yaw => [yaw, renderSkinInspectionView(reversed, yaw)]));
    let reversedSideMismatches = 0;
    // Include both sides of each physical seam, not uniform whole-face colors.
    for (const face of ["front", "right", "back", "left", "top", "bottom"] as (keyof BoxUV)[]) {
      const r = CLASSIC_LAYOUT.head[layer][face], index = MINECRAFT_BOX_FACE_ORDER.indexOf(face) * 4;
      for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) for (const y of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const u = ((r.x + x + 0.5) / 64 - uv.getX(index)) / (uv.getX(index + 1) - uv.getX(index));
        const v = ((r.y + y + 0.5) / 64 - uv.getY(index)) / (uv.getY(index + 2) - uv.getY(index));
        const local = [0, 1, 2].map(axis => positions.getComponent(index, axis)
          + u * (positions.getComponent(index + 1, axis) - positions.getComponent(index, axis))
          + v * (positions.getComponent(index + 2, axis) - positions.getComponent(index, axis)));
        // Compare UV direction, not the intentionally different outer inflate.
        const factor = layer === "base" ? 1 : 8.7 / 9;
        const [wx, wy, wz] = [local[0] * factor, local[1] * factor + 16, local[2] * factor];
        const pitch = face === "top" ? 60 : face === "bottom" ? -60 : 0;
        const yaw = pitch ? 0 : wx < 0 ? wz < 0 ? 225 : 315 : wz < 0 ? 135 : 45;
        const theta = yaw * Math.PI / 180, phi = pitch * Math.PI / 180, scale = 28 / 192;
        const px = Math.round(96 + (Math.cos(theta) * wx - Math.sin(theta) * wz) / scale - 0.5);
        const projectedY = -Math.sin(theta) * Math.sin(phi) * wx + Math.cos(phi) * wy - Math.cos(theta) * Math.sin(phi) * wz;
        const py = Math.round((22 - projectedY) / scale - 0.5), image = pitch ? poles.get(pitch)! : views.get(yaw)!;
        const i = (py * image.width + px) * 4, shade = face === "front" ? 1 : face === "back" ? 0.78 : 0.88;
        expect([...image.rgba.slice(i, i + 4)], `${layer}/${face}/${x}/${y}`).toEqual([40 + (r.x + x) * 2, 40 + (r.y + y) * 2, 160].map(c => Math.round(c * shade)).concat(255));
        if ((face === "left" || face === "right") && oldViews.get(yaw)!.rgba[i] !== image.rgba[i]) reversedSideMismatches++;
      }
    }
    expect(hash(atlas.rgba)).toBe(immutable);
    // All 128 asymmetric side probes reject the old mirrored presentation.
    expect(reversedSideMismatches).toBe(128);
  } finally { model.dispose(); }
});

it("saves corrected comparisons from unchanged original before/after skin PNGs", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const root = mkdtempSync("evaluation-artifacts/side-orientation-20261012-"), rows = [];
    for (const id of ["019", "012"]) {
      const beforePath = `evaluation-artifacts/detail-iteration-v3-e2e-20261012-${id}/skin.png`;
      const afterPath = `evaluation-artifacts/hair-volume-replay-20261012-Nz9pz8/${id}-after.png`;
      const beforeBytes = readFileSync(beforePath), afterBytes = readFileSync(afterPath);
      const before = await decodePng(beforeBytes), after = await decodePng(afterBytes);
      const control = legacySideViewInput(after);
      // Direct front/back projections are unaffected by the side-only change.
      const actualViews = renderSkinViews(after), controlViews = renderSkinViews(control);
      for (const name of ["front", "back"]) expect(actualViews.find(v => v.name === name)!.image).toEqual(controlViews.find(v => v.name === name)!.image);
      const corrected = [before, after].flatMap(a => yaws.map(yaw => head(renderSkinInspectionView(a, yaw))));
      const rendererComparison = [control, after].flatMap(a => yaws.map(yaw => head(renderSkinInspectionView(a, yaw))));
      writeFileSync(`${root}/${id}-volume-comparison-corrected.png`, await encodePng(sheet(corrected, 4)), { flag: "wx" });
      writeFileSync(`${root}/${id}-renderer-fix.png`, await encodePng(sheet(rendererComparison, 4)), { flag: "wx" });
      writeFileSync(`${root}/${id}-corrected-pitched.png`, await encodePng(sheet([before, after].flatMap(a => [45, 135].map(yaw => renderSkinInspectionView(a, yaw, 25))), 2)), { flag: "wx" });
      expect(readFileSync(beforePath)).toEqual(beforeBytes); expect(readFileSync(afterPath)).toEqual(afterBytes);
      rows.push({ id, beforePath, afterPath, beforeSha256: hash(beforeBytes), afterSha256: hash(afterBytes), sourceFilesUnchanged: true });
    }
    expect(network).not.toHaveBeenCalled();
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, sourcePngModified: false,
      columns: ["front-right", "front-left", "back-right", "back-left"],
      volumeComparisonRows: ["before volume, corrected renderer", "after volume, corrected renderer"],
      rendererFixRows: ["old mirrored-side presentation control", "corrected presentation, identical source PNG"], rows }, null, 2), { flag: "wx" });
    console.info(`SIDE_ORIENTATION ${root}`);
  } finally { network.mockRestore(); }
}, 120_000);
