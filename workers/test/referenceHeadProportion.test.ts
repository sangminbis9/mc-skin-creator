import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { scaleNearestNeighbor, renderSkinViews } from "../src/skinRender";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { headProportionOffset } from "../src/referenceHeadProportion";
import { validateFinalAtlas } from "../src/skinPost";
import { makeAnalysis } from "./helpers";

function setup(kind = "short") {
  const raw = makeAnalysis();
  raw.fallbackFeatures.glasses = "none"; raw.fallbackFeatures.facialHair = "none";
  raw.observed.accessories = "none";
  if (kind === "long") {
    raw.observed.hair = "long straight hair with bangs";
    raw.renderHints.overallHairLength = "chest";
    raw.fallbackFeatures.hairstyle = "long";
  }
  if (kind === "bald") { raw.fallbackFeatures.hairstyle = "bald"; raw.observed.hair = "bald head"; }
  if (kind === "glasses") raw.fallbackFeatures.glasses = "round";
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan), design = buildReferenceStylePlan(analysis);
  const atlas = buildProceduralSourceAtlas(features, style, plan)!;
  return { plan, style, design, atlas };
}

it("uses lower two-row, one-column irises with outward sclera without mutating source evidence", () => {
  const b = setup(), frozen = JSON.stringify(b.plan);
  const result = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
  const projection = result.diagnostic.headProportion!;
  expect(projection.eyes).toBe("lower_narrow_pair");
  expect(projection.eyePixels.filter(p => p.role === "iris").map(p => [p.x, p.y])).toEqual([[2, 5], [2, 6], [5, 5], [5, 6]]);
  expect(projection.eyePixels.filter(p => p.role === "sclera").map(p => [p.x, p.y])).toEqual([[1, 5], [1, 6], [6, 5], [6, 6]]);
  expect(measureReferenceRenderedQuality(result, b.atlas, b.plan, b.design, b.style).violations).toEqual([]);
  expect(JSON.stringify(b.plan)).toBe(frozen);
  expect(composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style).atlas).toEqual(result.atlas);
  for (const p of projection.paints) {
    const mutated = structuredClone(result), i = headProportionOffset(p);
    mutated.atlas.rgba[i] ^= 127;
    mutated.diagnostic.headProportion!.paints.find(q => q.face === p.face && q.x === p.x && q.y === p.y)!.color[0] ^= 127;
    expect(measureReferenceRenderedQuality(mutated, b.atlas, b.plan, b.design, b.style).constructionValid, `${p.face}:${p.x},${p.y}`).toBe(false);
  }
});

it("preserves eyewear, measured eyes, scalp-only hair, source part and side ear windows", () => {
  const glasses = setup("glasses");
  expect(composeReferenceStyleAtlas(glasses.atlas, glasses.plan, glasses.design, glasses.style).diagnostic.headProportion!.eyes).toBe("source_preserved");
  const b = setup(); b.plan.facePixelPlan.layout.geometryUsage.eyes = true;
  expect(composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style).diagnostic.headProportion!.eyes).toBe("source_preserved");
  const bald = setup("bald");
  expect(composeReferenceStyleAtlas(bald.atlas, bald.plan, bald.design, bald.style).diagnostic.headProportion!.outline).toBe("source_preserved");
  const part = setup(); part.plan.facePixelPlan.layout.fringeOpening = "center";
  const p = composeReferenceStyleAtlas(part.atlas, part.plan, part.design, part.style).diagnostic.headProportion!;
  expect(p.paints.filter(c => c.role === "hair" && c.face === "front" && [3, 4].includes(c.x))).toEqual([]);
  expect(p.paints.filter(c => c.role === "hair" && c.y >= 5 && (c.face === "right" && c.x >= 6 || c.face === "left" && c.x <= 1))).toEqual([]);
});

it("does not reinterpret hats, undercuts, tied hair or a measured silhouette as a loose cap", () => {
  for (const kind of ["hat", "undercut", "tied", "measured", "surface"] as const) {
    const b = setup();
    if (kind === "hat") b.plan.headIdentityPlan.ownership!.covering = true;
    if (kind === "undercut") b.style.sideHairShape = "undercut";
    if (kind === "tied") b.plan.headIdentityPlan.ownership!.tiedMass = { position: "high_back", horizontalBias: "center", verticalProminence: 1,
      massWidth: 4, attachmentWidth: 2, attachmentRegion: "crown_back", outerDepth: 1, source: "observed", groupId: "tied-mass", attachmentGroupId: "tied-attachment" };
    if (kind === "measured") b.plan.facePixelPlan.layout.geometryUsage.hairline = true;
    if (kind === "surface") b.plan.hairPlan.surfaceOnly = true;
    const output = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
    expect(output.diagnostic.headProportion!.outline, kind).toBe("source_preserved");
  }
});

it("writes fresh before/after five-surface comparisons including stored suit analysis", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const root = mkdtempSync("evaluation-artifacts/reference-head-proportion-replay-20261011-");
    const cases = ["short", "long"].map(id => ({ id, ...setup(id) }));
    const file = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261008-010/summary.json", bytes = readFileSync(file);
    const trace = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    cases.push({ id: "saved-suit-010", plan: trace.skinPlan.skinPlan, style: trace.injectedParameters.faceStyle,
      design: { ...trace.referenceStyle.design, faceLayoutPolicy: "mouthless_lower_eyes", hairPalettePolicy: "continuous_material", headProportionPolicy: "reference_low_eyes_v1" },
      atlas: buildProceduralSourceAtlas(trace.injectedParameters.features, trace.injectedParameters.faceStyle, trace.skinPlan.skinPlan)! });
    const faces = ["front", "right", "back", "left", "top"] as const, rows = [], evidence = [];
    for (const b of cases) {
      const before = composeReferenceStyleAtlas(b.atlas, b.plan, { ...b.design, headProportionPolicy: undefined }, b.style);
      const after = composeReferenceStyleAtlas(b.atlas, b.plan, b.design, b.style);
      const quality = measureReferenceRenderedQuality(after, b.atlas, b.plan, b.design, b.style);
      expect(quality.violations, b.id).toEqual([]); expect(validateFinalAtlas(after.atlas).ok).toBe(true);
      // The requested proportions cannot silently restyle clothing or limbs.
      const headBytes = new Set<number>();
      for (const box of Object.values(CLASSIC_LAYOUT.head)) for (const r of Object.values(box))
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let ch = 0; ch < 4; ch++) headBytes.add(((r.y + y) * 64 + r.x + x) * 4 + ch);
      expect(after.atlas.rgba.every((v, i) => headBytes.has(i) || v === before.atlas.rgba[i]), b.id).toBe(true);
      for (const [label, r] of [["before", before], ["after", after]] as const) {
        writeFileSync(`${root}/${b.id}-${label}.png`, await encodePng(r.atlas), { flag: "wx" });
        if (b.id === "saved-suit-010") for (const v of renderSkinViews(r.atlas))
          writeFileSync(`${root}/${b.id}-${label}-${v.name}.png`, await encodePng(scaleNearestNeighbor(v.image, v.image.width * 8, v.image.height * 8)), { flag: "wx" });
        rows.push(r.atlas);
      }
      evidence.push({ id: b.id, projection: after.diagnostic.headProportion, quality });
    }
    const sheet: RawImage = { width: 50, height: rows.length * 10, rgba: new Uint8Array(50 * rows.length * 10 * 4) };
    for (let i = 0; i < sheet.rgba.length; i += 4) sheet.rgba.set([120, 145, 155, 255], i);
    rows.forEach((atlas, row) => faces.forEach((f, col) => {
      const base = CLASSIC_LAYOUT.head.base[f], outer = CLASSIC_LAYOUT.head.overlay[f];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = ((base.y + y) * 64 + base.x + x) * 4, o = ((outer.y + y) * 64 + outer.x + x) * 4;
        const a = atlas.rgba[o + 3] / 255;
        sheet.rgba.set([0, 1, 2].map(ch => Math.round(atlas.rgba[i + ch] * (1 - a) + atlas.rgba[o + ch] * a)).concat(255), ((row * 10 + y + 1) * 50 + col * 10 + x + 1) * 4);
      }
    }));
    writeFileSync(`${root}/comparison.png`, await encodePng(scaleNearestNeighbor(sheet, 1000, rows.length * 200)), { flag: "wx" });
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, rows: "short before/after; long before/after; saved suit before/after", columns: faces, evidence }, null, 2), { flag: "wx" });
    expect(readFileSync(file)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info(`HEAD_PROPORTION_REPLAY ${root}`);
  } finally { network.mockRestore(); }
}, 60_000);

const directory = process.env.REFERENCE_SKIN_DIRECTORY;
it.skipIf(!directory)("inspects supplied A-H head surfaces without inference or changing input files", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline_only"));
  try {
    const root = mkdtempSync("evaluation-artifacts/reference-head-proportion-20261011-");
    const faces = ["front", "right", "back", "left", "top"] as const;
    const sheets = Object.fromEntries(["composite", "base", "overlay"].map(name => [name,
      { width: 5 * 10, height: 8 * 10, rgba: new Uint8Array(5 * 10 * 8 * 10 * 4) }])) as Record<string, RawImage>;
    for (const sheet of Object.values(sheets)) for (let i = 0; i < sheet.rgba.length; i += 4) sheet.rgba.set([120, 145, 155, 255], i);
    const evidence = [];
    for (let row = 0; row < 8; row++) {
      const id = String.fromCharCode(65 + row), file = join(directory!, `${id} skin.png`);
      const bytes = readFileSync(file), atlas = await decodePng(bytes);
      expect([atlas.width, atlas.height]).toEqual([64, 64]);
      const grids: Record<string, string[][]> = {};
      for (const [col, face] of faces.entries()) {
        const base = CLASSIC_LAYOUT.head.base[face], outer = CLASSIC_LAYOUT.head.overlay[face];
        const grid: string[][] = [];
        for (let y = 0; y < 8; y++) {
          grid.push([]);
          for (let x = 0; x < 8; x++) {
            const p = [...atlas.rgba.slice(((base.y + y) * 64 + base.x + x) * 4, ((base.y + y) * 64 + base.x + x) * 4 + 4)];
            const q = [...atlas.rgba.slice(((outer.y + y) * 64 + outer.x + x) * 4, ((outer.y + y) * 64 + outer.x + x) * 4 + 4)];
            const alpha = q[3] / 255;
            const composite = p.slice(0, 3).map((v, c) => Math.round(v * (1 - alpha) + q[c] * alpha));
            grid[y].push(composite.map(v => v.toString(16).padStart(2, "0")).join(""));
            for (const [name, color] of [["composite", [...composite, 255]], ["base", p], ["overlay", q]] as const)
              if (color[3]) sheets[name].rgba.set(color, (((row * 10 + y + 1) * 50) + col * 10 + x + 1) * 4);
          }
        }
        grids[face] = grid;
      }
      evidence.push({ id, sha256: createHash("sha256").update(bytes).digest("hex"), grids });
      expect(readFileSync(file)).toEqual(bytes);
    }
    for (const [name, sheet] of Object.entries(sheets)) writeFileSync(`${root}/${name}.png`, await encodePng(scaleNearestNeighbor(sheet, 1200, 1920)), { flag: "wx" });
    writeFileSync(`${root}/pixels.json`, JSON.stringify({ rows: "A B C D E F G H", columns: faces, providerCalls: 0, evidence }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled();
    console.info(`REFERENCE_HEAD_PROPORTION ${root}`);
  } finally { network.mockRestore(); }
}, 30_000);
