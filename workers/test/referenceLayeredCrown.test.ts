// Actual immutable F004 recovery plus explicitly authored parameter variations.
// No new provider observations, image requests or reconstruction of missing fields.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import * as layeredCrown from "../src/referenceLayeredCrown";

const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-004";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function saved() {
  const bytes = readFileSync(`${sourceRoot}/summary.json`);
  expect(sha(bytes)).toBe("185d2388a2d7343d54d8d11cfc32dd5e04506c9fc61869411c88257fbddfe918");
  const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
  const plan: SkinPlan = t.skinPlan.skinPlan, style = t.injectedParameters.faceStyle;
  return { t, plan, style, design: t.referenceStyle.design,
    baseline: buildProceduralSourceAtlas(t.injectedParameters.features, style, plan)! };
}
function render(b: ReturnType<typeof saved>) {
  return composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
}
function crown(c: ReturnType<typeof render>, y = 0) {
  return c.diagnostic.surfaces.filter(p => p.part === "head" && p.face === "front" && p.layer === "overlay" && p.owner === "hair" && p.y === y).map(p => p.x).sort();
}

it("retains a tousled layered crown distinction instead of flattening it into the rounded band", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const b = saved(), immutable = JSON.stringify(b.plan), actual = await decodePng(readFileSync(`${sourceRoot}/skin.png`));
    expect(sha(actual.rgba)).toBe("bad509c89f4078f3715d0401238c491c4c2e632126f1f9c74e79b5e96ed9119e");
    expect(b.style).toMatchObject({ hairSilhouette: "tousled", fringeEdge: "staggered", hairPart: "none", fringeOpening: "center" });
    expect(b.design.hair.family).toBe("medium_layered");
    expect(b.plan.hairPlan.part).toBe("none");
    const after = render(b), rounded = saved(); rounded.style.hairSilhouette = "rounded";
    const historical = vi.spyOn(layeredCrown, "retainLayeredCrownAccent").mockReturnValue(true);
    try { expect(render(b).atlas.rgba).toEqual(actual.rgba); } finally { historical.mockRestore(); }
    // This controlled variation is an aesthetic unit, not another source observation.
    const smooth = render(rounded);
    expect(crown(smooth)).toEqual([1, 2, 3, 4, 5, 6]);
    const root = freshAuditOutput("evaluation-artifacts/reference-layered-crown-20261011-");
    for (const [name, atlas] of [["actual-live", actual], ["current-offline", after.atlas]] as const) {
      writeFileSync(`${root}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${root}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    console.info("LAYERED_CROWN_REPLAY", root);
    expect(crown(after)).toEqual([1, 2, 5, 6]);
    // A relief break at the silhouette is not permission to draw a root part.
    expect(crown(after, 1)).toEqual(crown(smooth, 1));
    expect(after.atlas.rgba).not.toEqual(smooth.atlas.rgba);
    let changed = 0;
    const headOuter = Object.values(CLASSIC_LAYOUT.head.overlay);
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      changed++;
      const x = i % 64, y = Math.floor(i / 64);
      expect(headOuter.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
      expect(actual.rgba[i * 4 + 3]).toBe(255); expect(after.atlas.rgba[i * 4 + 3]).toBe(0);
    }
    expect(changed).toBeGreaterThan(0);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, b.baseline, b.plan, b.style, buildReferenceCraftPlan(b.plan, b.design, after)).ok).toBe(true);
    expect(selectReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style).selected!.composition.atlas.rgba).toEqual(after.atlas.rgba);
    expect(render(b).atlas.rgba).toEqual(after.atlas.rgba);
    expect((await decodePng(await encodePng(after.atlas))).rgba).toEqual(after.atlas.rgba);
    expect(JSON.stringify(b.plan)).toBe(immutable);
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(readFileSync(`${sourceRoot}/summary.json`)),
      classification: "PARAMETER_PRESERVED_COMPOSITION_LOST", providerCalls: 0, status: "offline_not_fresh_live",
      sourcePart: b.plan.hairPlan.part, sourceSilhouette: b.style.hairSilhouette, sourceFringeEdge: b.style.fringeEdge,
      beforeCrown: crown(smooth), afterCrown: crown(after), beforeHash: sha(actual.rgba), afterHash: sha(after.atlas.rgba),
      removedOuterCells: changed, baseFaceBodyAndPlansUnchanged: true, craftPass: true, atlasPass: true, deterministic: true }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 60_000);

it("preserves smooth/blunt, measured, covered, tied and short/long families", () => {
  const mutations = [
    (b: ReturnType<typeof saved>) => { b.style.hairSilhouette = "rounded"; },
    (b: ReturnType<typeof saved>) => { b.style.fringeEdge = "blunt"; },
    (b: ReturnType<typeof saved>) => { b.plan.hairPlan.headMask.source = "identity_geometry"; },
    (b: ReturnType<typeof saved>) => { b.plan.hairPlan.structure.source = "identity_geometry"; },
    (b: ReturnType<typeof saved>) => { b.plan.headIdentityPlan.ownership!.covering = true; },
    (b: ReturnType<typeof saved>) => { b.plan.headIdentityPlan.ownership!.tiedMass = {
      position: "mid_back", horizontalBias: "center", verticalProminence: 1, massWidth: 4,
      attachmentWidth: 2, attachmentRegion: "crown_back", outerDepth: 1, source: "observed",
      groupId: "tied-mass", attachmentGroupId: "tied-attachment",
    }; },
    (b: ReturnType<typeof saved>) => { b.plan.facePixelPlan.layout.geometryUsage.hairline = true; },
    (b: ReturnType<typeof saved>) => { b.plan.headIdentityPlan.ownership!.cells[0].provenance = "validated_derived"; },
    (b: ReturnType<typeof saved>) => { b.design.hair.family = "long_straight_with_bangs"; },
  ];
  for (const mutate of mutations) {
    const b = saved(); mutate(b); const source = JSON.stringify(b.plan);
    expect(crown(render(b))).toContain(3);
    expect(JSON.stringify(b.plan)).toBe(source);
  }
});

it("does not treat part/opening, palette or occurrence order as evidence of tousled relief", () => {
  const b = saved();
  for (const color of ["#9a9a9a", "#392b21", "#171717"]) {
    for (const part of ["none", "left", "right", "center"]) {
      b.style.hairColor = color; b.style.hairPart = part; b.style.fringeOpening = "none";
      b.style.hairSilhouette = "rounded";
      expect(layeredCrown.retainLayeredCrownAccent("front", 3, 0, b.plan, b.design, b.style)).toBe(true);
      b.style.hairSilhouette = "tousled";
      expect(layeredCrown.retainLayeredCrownAccent("front", 3, 0, b.plan, b.design, b.style)).toBe(false);
      expect(layeredCrown.retainLayeredCrownAccent("front", 3, 1, b.plan, b.design, b.style)).toBe(true);
    }
  }
  const before = render(b); b.plan.headIdentityPlan.ownership!.cells.reverse();
  expect(render(b).atlas.rgba).toEqual(before.atlas.rgba);
});
