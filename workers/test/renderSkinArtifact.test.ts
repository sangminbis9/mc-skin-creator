import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng } from "../src/png";
import {
  buildSkinViewMontage,
  inspectRenderedSkin,
  renderSkinViews,
  type SkinGeometry,
} from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";

const INPUT = process.env.RENDER_SKIN_PNG;
const OUTPUT = process.env.RENDER_SKIN_ARTIFACT_DIR;
const GEOMETRY: SkinGeometry =
  process.env.RENDER_SKIN_GEOMETRY === "slim" ? "slim" : "classic";

describe.skipIf(!INPUT || !OUTPUT)("saved skin visual inspection", () => {
  it("validates the exact PNG and writes the production six-view montage", async () => {
    const atlas = await decodePng(await readFile(INPUT as string));
    const validation = validateFinalAtlas(atlas);
    expect(validation.ok, validation.problems.join("; ")).toBe(true);

    const views = renderSkinViews(atlas, GEOMETRY);
    const inspection = inspectRenderedSkin(views);
    expect(inspection.ok, inspection.problems.join("; ")).toBe(true);

    const montage = buildSkinViewMontage(views);
    const stem = basename(INPUT as string).replace(/\.png$/i, "");
    await mkdir(OUTPUT as string, { recursive: true });
    await Promise.all([
      writeFile(
        join(OUTPUT as string, `${stem}-${GEOMETRY}-six-view.png`),
        await encodePng(montage),
      ),
      writeFile(
        join(OUTPUT as string, `${stem}-${GEOMETRY}-inspection.json`),
        JSON.stringify({ geometry: GEOMETRY, validation, inspection }, null, 2),
        "utf8",
      ),
    ]);
  });
});
