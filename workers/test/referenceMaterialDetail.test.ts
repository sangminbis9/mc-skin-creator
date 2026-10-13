import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { headMaterialPoint, referenceHairMaterial, referenceLooseHairMaterial } from "../src/referenceMaterialDetail";
import { referenceGarmentFoldPlan } from "../src/referenceGarmentFinish";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV } from "../src/uvLayout";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { buildSkinPlan } from "../src/skinPlan";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { validateFinalAtlas } from "../src/skinPost";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { makeAnalysis } from "./helpers";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
it("uses one physical material coordinate across all head seams, including three-face corners", () => {
  const box = CLASSIC_LAYOUT.head.base;
  const local = (p: {x: number; y: number}) => {
    for (const [face, r] of Object.entries(box)) if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h)
      return { face: face as keyof BoxUV, x: p.x - r.x, y: p.y - r.y };
    throw new Error("outside_head");
  };
  const seams = getBoxUvSeams(box);
  for (const seam of [...seams.vertical, ...seams.horizontal]) seam.primary.forEach((p, n) => {
    const a = local(p), b = local(seam.adjacent[n]);
    expect(headMaterialPoint(a.face, a.x, a.y)).toEqual(headMaterialPoint(b.face, b.x, b.y));
    for (const hairPart of ["none", "center", "left", "right"] as const) for (const hairTexture of ["straight", "wavy"] as const)
      for (const policy of ["clustered_material_v1", "tapered_material_v2", "flow_locks_v3", "continuous_locks_v4"] as const)
        expect(referenceHairMaterial([30, 23, 19], a.face, a.x, a.y, { hairPart, hairTexture }, false, policy))
          .toEqual(referenceHairMaterial([30, 23, 19], b.face, b.x, b.y, { hairPart, hairTexture }, false, policy));
  });
});

it("gives near-black and pale hair a bounded non-random ramp without a new dye color", () => {
  for (const color of [[0, 0, 0], [24, 19, 14], [233, 207, 191], [255, 255, 255]] as [number, number, number][]) {
    const colors = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const value = referenceHairMaterial(color, "back", x, y, {});
      expect(value).toEqual(referenceHairMaterial(color, "back", x, y, {}));
      expect(value.every(c => c >= 0 && c <= 255)).toBe(true);
      expect(value[0]).toBeGreaterThanOrEqual(value[1]); expect(value[1]).toBeGreaterThanOrEqual(value[2]);
      colors.push(value.join(","));
    }
    expect(new Set(colors).size).toBeGreaterThan(1);
    expect(new Set(colors).size).toBeLessThanOrEqual(12);
  }
});

it("tapers reflected ridges instead of drawing full-height bright columns", () => {
  for (const color of [[20, 18, 17], [120, 90, 60], [232, 232, 232]] as [number, number, number][]) {
    const brightest = (y: number) => Math.max(...Array.from({ length: 8 }, (_, x) =>
      referenceHairMaterial(color, "back", x, y, {}, false, "tapered_material_v2")[0]));
    expect(brightest(3)).toBeGreaterThan(brightest(0));
    expect(brightest(3)).toBeGreaterThan(brightest(7));
  }
});

it("breaks full-height cloth stripes into connected terminal folds without widening their ownership", () => {
  const plan = buildSkinPlan(makeAnalysis()).outfitPlan;
  plan.upper.pattern.kind = "none"; plan.upper.colorBlocks = [];
  plan.upper.leftSleeve.terminationRow = 12; plan.upper.rightSleeve.terminationRow = 12;
  const old = referenceGarmentFoldPlan(plan), next = referenceGarmentFoldPlan(plan, true);
  expect(next.length).toBeGreaterThan(0); expect(next.length).toBeLessThan(old.length);
  for (const p of next) {
    expect(old.some(q => q.part === p.part && q.face === p.face && q.x === p.x && q.y === p.y && q.sourceColor.join() === p.sourceColor.join())).toBe(true);
    expect(next.some(q => q.part === p.part && q.face === p.face && q.x === p.x && Math.abs(q.y - p.y) === 1)).toBe(true);
  }
  const arm = next.filter(p => p.part === "rightArm" && p.face === "front");
  expect(arm.some(p => p.y >= 4 && p.y <= 6)).toBe(false);
});

it("continues loose locks from the nape pigment without changing historical drape shading", () => {
  const color: [number, number, number] = [57, 42, 33];
  for (const face of ["front", "back"] as const) for (let x = 0; x < 8; x++) {
    const p = {face, x, y: 0, shade: 1};
    expect(referenceLooseHairMaterial(color, p, {}, true)).toEqual(referenceHairMaterial(color, face, x, 7, {}));
    expect(referenceLooseHairMaterial(color, {...p, shade: 0.84}, {}, false)).toEqual(color.map(c => Math.round(c * 0.84)));
  }
});

function context(raw = makeAnalysis()) {
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
  return { plan, style, design, atlas: buildProceduralSourceAtlas(features, style, plan)! };
}

it("keeps source evidence, alpha, face and observed accessory contracts while independently rejecting repaint corruption", () => {
  const raw = makeAnalysis(); raw.fallbackFeatures.glasses = "none"; raw.observed.accessories = "none";
  const b = context(raw), frozen = JSON.stringify(b);
  const before = composeReferenceStyleAtlas(b.atlas, b.plan, { ...b.design, materialDetailPolicy: undefined }, b.style);
  const result = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
  expect(JSON.stringify(b)).toBe(frozen);
  expect(result.atlas).toEqual(composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style).atlas);
  expect(measureReferenceRenderedQuality(result, b.atlas, b.plan, b.design, b.style).violations).toEqual([]);
  const changed = [];
  for (let i = 0; i < result.atlas.rgba.length; i += 4) {
    expect(result.atlas.rgba[i + 3]).toBe(before.atlas.rgba[i + 3]);
    if ([0, 1, 2].some(c => result.atlas.rgba[i + c] !== before.atlas.rgba[i + c])) changed.push(i);
  }
  expect(changed.length).toBeGreaterThan(20);
  const front = CLASSIC_LAYOUT.head.base.front;
  for (const p of result.diagnostic.headProportion!.paints.filter(p => p.role !== "hair")) {
    const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
    expect(result.atlas.rgba.slice(i, i + 4)).toEqual(before.atlas.rgba.slice(i, i + 4));
  }
  // Candidate-owned paint declarations cannot license arbitrary hair color.
  const hair = result.diagnostic.surfacePixels.find(p => p.part === "head" && p.layer === "base" && p.owner === "hair" && p.face === "top")!;
  const r = CLASSIC_LAYOUT.head.base.top, i = ((r.y + hair.y) * 64 + r.x + hair.x) * 4;
  result.atlas.rgba[i] ^= 127; hair.color[0] ^= 127;
  expect(measureReferenceRenderedQuality(result, b.atlas, b.plan, b.design, b.style).constructionValid).toBe(false);
});

function sheet(images: RawImage[], columns: number): RawImage {
  const w = images[0].width, h = images[0].height, width = (w + 2) * columns, height = (h + 2) * Math.ceil(images.length / columns);
  const out: RawImage = { width, height, rgba: new Uint8Array(width * height * 4) };
  for (let i = 0; i < out.rgba.length; i += 4) out.rgba.set([121, 145, 155, 255], i);
  images.forEach((image, n) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (image.rgba[i + 3]) out.rgba.set(image.rgba.slice(i, i + 4), (((Math.floor(n / columns) * (h + 2) + y + 1) * width) + (n % columns) * (w + 2) + x + 1) * 4);
    }
  });
  return scaleNearestNeighbor(out, out.width * 4, out.height * 4);
}

it("saves fresh offline before/after renders with fixed same-analysis provenance and optional A-H reference gallery", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const root = mkdtempSync("evaluation-artifacts/reference-material-detail-20261012-");
    const input = "evaluation-artifacts/generalization-20260905/annotations.json", frozen = readFileSync(input);
    const fixtures: AnnotatedCase[] = JSON.parse(frozen.toString());
    const cases = fixtures.map(f => {
      const raw = strictBoundaryAnalysisFromAnnotation(f).analysis;
      if (f.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${f.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      return { id: f.id, ...context(raw) };
    });
    const saved = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-010/summary.json", savedBytes = readFileSync(saved);
    const trace = JSON.parse(savedBytes.toString()).currentDefaultE2E.result.propagationTrace;
    cases.unshift({ id: "saved-suit-010", plan: trace.skinPlan.skinPlan, style: trace.injectedParameters.faceStyle,
      design: { ...trace.referenceStyle.design, hairPalettePolicy: "continuous_material", headProportionPolicy: "reference_low_eyes_v1",
        faceLayoutPolicy: "mouthless_lower_eyes", materialDetailPolicy: "clustered_material_v1" } as ReferenceStylePlan,
      atlas: buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, trace.skinPlan.skinPlan)! });
    const evidence = [], gallery: RawImage[] = [];
    for (const b of cases) {
      const identity = JSON.stringify(b.plan), images: RawImage[] = [];
      for (const mode of ["before", "after"] as const) {
        const design = { ...b.design, materialDetailPolicy: mode === "after" ? "clustered_material_v1" as const : undefined };
        const result = composeReferenceStyleAtlas(b.atlas, b.plan, design, b.style);
        const quality = measureReferenceRenderedQuality(result, b.atlas, b.plan, design, b.style);
        expect(quality.violations, `${b.id}:${mode}`).toEqual([]); expect(validateFinalAtlas(result.atlas).ok).toBe(true);
        writeFileSync(`${root}/${b.id}-${mode}.png`, await encodePng(result.atlas), { flag: "wx" });
        const views = renderSkinViews(result.atlas).filter(v => ["front", "right", "back"].includes(v.name));
        images.push(...views.map(v => v.image));
        evidence.push({ id: b.id, mode, atlasSha256: hash(result.atlas.rgba), design, quality, providerCalls: 0 });
      }
      expect(JSON.stringify(b.plan)).toBe(identity);
      writeFileSync(`${root}/${b.id}-comparison.png`, await encodePng(sheet(images, 3)), { flag: "wx" });
      if (gallery.length < 36) gallery.push(...images);
    }
    writeFileSync(`${root}/comparison.png`, await encodePng(sheet(gallery, 6)), { flag: "wx" });
    const references = [], referenceViews: RawImage[] = [];
    if (process.env.REFERENCE_SKIN_DIRECTORY) for (const id of "ABCDEFGH") {
      const file = join(process.env.REFERENCE_SKIN_DIRECTORY, `${id} skin.png`), bytes = readFileSync(file), atlas = await decodePng(bytes);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      referenceViews.push(...renderSkinViews(atlas).filter(v => ["front", "right", "back"].includes(v.name)).map(v => v.image));
      references.push({ id, sha256: hash(bytes) }); expect(readFileSync(file)).toEqual(bytes);
    }
    if (referenceViews.length) writeFileSync(`${root}/references.png`, await encodePng(sheet(referenceViews, 3)), { flag: "wx" });
    expect(readFileSync(input)).toEqual(frozen); expect(readFileSync(saved)).toEqual(savedBytes); expect(network).not.toHaveBeenCalled();
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, generation: "offline same-analysis replay; not fresh primary observation",
      annotationSha256: hash(frozen), savedTraceSha256: hash(savedBytes), references, evidence }, null, 2), { flag: "wx" });
    console.info(`MATERIAL_DETAIL_REPLAY ${root}`);
  } finally { network.mockRestore(); }
}, 180_000);
