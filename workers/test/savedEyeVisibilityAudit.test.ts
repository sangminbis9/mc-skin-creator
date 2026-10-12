// Offline pixel evidence only: no remote selector, source upload or model output.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";

const frozenRoot = "evaluation-artifacts/reference-style-composition-20261005-VQziED";
const liveRoot = "evaluation-artifacts/reference-style-v3-e2e-braided-ribbon-20261010-006";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type Eye = { x: number; y: number; role: string };
const pixel = (image: RawImage, x: number, y: number) => [...image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

it("distinguishes saved atlas eye delivery from a subjective eyeless preview impression", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const output = freshAuditOutput("evaluation-artifacts/saved-eye-visibility-20261010-");
  const inputs = new Map<string, Buffer>();
  const read = (path: string) => { const bytes = readFileSync(path); inputs.set(path, bytes); return bytes; };
  try {
    const cases: Array<{ caseId: string; eyeEvidence: Eye[] }> = JSON.parse(read(`${frozenRoot}/results.json`).toString()).cases;
    const live = JSON.parse(read(`${liveRoot}/summary.json`).toString());
    const liveEyes: Eye[] = live.currentDefaultE2E.result.propagationTrace.skinPlan.skinPlan.facePixelPlan.pixels
      .filter((p: Eye) => p.role === "iris" || p.role === "sclera");
    const scarfRoot = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-004";
    const scarf = JSON.parse(read(`${scarfRoot}/summary.json`).toString());
    const scarfEyes: Eye[] = scarf.currentDefaultE2E.result.propagationTrace.skinPlan.skinPlan.facePixelPlan.pixels
      .filter((p: Eye) => p.role === "iris" || p.role === "sclera");
    const rows = [];
    for (const item of [
      ...cases.map(c => ({ id: c.caseId, path: `${frozenRoot}/${c.caseId}-styled.png`, front: `${frozenRoot}/${c.caseId}-styled-front.png`, eyes: c.eyeEvidence })),
      { id: "H-consumed-006", path: `${liveRoot}/skin.png`, front: null, eyes: liveEyes },
      { id: "C-consumed-004", path: `${scarfRoot}/skin.png`, front: null, eyes: scarfEyes },
    ]) {
      const bytes = read(item.path), atlas = await decodePng(bytes);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      const rendered = renderSkinViews(atlas)[0].image;
      if (item.front) {
        const storedFront = await decodePng(read(item.front));
        expect(sha(storedFront.rgba), `${item.id}: exact stored front`).toBe(sha(scaleNearestNeighbor(rendered, 384, 576).rgba));
      }
      const evidence = item.eyes.map(eye => {
        const base = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
        const baseRgba = pixel(atlas, base.x + eye.x, base.y + eye.y);
        const overlayRgba = pixel(atlas, outer.x + eye.x, outer.y + eye.y);
        const scale = 28 / rendered.width;
        const sx = Math.round(rendered.width / 2 + (eye.x - 3.5) / scale - 0.5);
        const sy = Math.round((2.5 + eye.y) / scale - 0.5);
        const renderedRgba = pixel(rendered, sx, sy);
        // Expanded overlay geometry can occlude a base texel even when the
        // same logical overlay coordinate is clear. Record, do not hide it.
        return { ...eye, baseRgba, overlayRgba, renderedRgba, baseVisibleAtCenter: JSON.stringify(baseRgba) === JSON.stringify(renderedRgba) };
      });
      if (["wavy-open-blazer", "curly-hair", "H-consumed-006", "C-consumed-004"].includes(item.id)) {
        expect(evidence.length).toBeGreaterThanOrEqual(4);
        expect(evidence.every(e => e.baseVisibleAtCenter), `${item.id}: suspected loss`).toBe(true);
      }
      const head: RawImage = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4) };
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) head.rgba.set(pixel(rendered, x + 32, y + 5), (y * 32 + x) * 4);
      writeFileSync(`${output}/${item.id}-head.png`, await encodePng(scaleNearestNeighbor(head, 256, 256)), { flag: "wx" });
      rows.push({ id: item.id, atlasFileSha256: sha(bytes), evidence });
    }
    for (const [path, bytes] of inputs) expect(readFileSync(path).equals(bytes), `${path}: immutable bytes`).toBe(true);
    expect(network).not.toHaveBeenCalled();
    writeFileSync(`${output}/results.json`, JSON.stringify({ providerCalls: 0, productionChanges: 0,
      scope: "stored PNG and front pixel delivery, not a claim of universal visual quality", rows,
      inputHashes: [...inputs].map(([path, bytes]) => ({ path, sha256: sha(bytes) })) }, null, 2), { flag: "wx" });
    console.info("SAVED_EYE_VISIBILITY", output);
  } finally { network.mockRestore(); }
}, 30_000);
