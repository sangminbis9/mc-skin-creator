// Offline authored parameter audit. Never a replacement for saved provider evidence.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import type { PixelRenderHints } from "../src/analysis";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { decodePng, encodePng } from "../src/png";
import { historicalHairMaterialReplay } from "./historicalHairMaterial";
import { validateFinalAtlas } from "../src/skinPost";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const variants: Array<{ id: string; delta: Partial<PixelRenderHints> }> = [
  { id: "baseline", delta: {} },
  { id: "part-left", delta: { hairPart: "left" } },
  { id: "part-right", delta: { hairPart: "right" } },
  { id: "part-center", delta: { hairPart: "center" } },
  { id: "opening-center", delta: { fringeOpening: "center" } },
  { id: "center-part-and-opening", delta: { hairPart: "center", fringeOpening: "center" } },
  { id: "opening-left", delta: { fringeOpening: "left", faceShape: "oval" } },
  { id: "opening-right", delta: { fringeOpening: "right", faceShape: "oval" } },
  { id: "fringe-brow", delta: { bangsLength: "brow" } },
  { id: "opened-part-left", delta: { hairPart: "left", fringeOpening: "center", faceShape: "oval" } },
  { id: "opened-part-center", delta: { hairPart: "center", fringeOpening: "center", faceShape: "oval" } },
  { id: "opened-part-right", delta: { hairPart: "right", fringeOpening: "center", faceShape: "oval" } },
  { id: "opened-fringe-brow", delta: { hairPart: "center", fringeOpening: "center", faceShape: "oval", bangsLength: "brow" } },
  { id: "full-rounded", delta: { hairVolume: "full", hairSilhouette: "rounded" } },
  { id: "full-flat", delta: { hairVolume: "full", hairSilhouette: "flat" } },
  { id: "side-cheek", delta: { sideHairLength: "cheek" } },
  { id: "ear-visible", delta: { earExposure: "visible" } },
];

function authored(delta: Partial<PixelRenderHints>, modifyRaw?: (raw: ReturnType<typeof makeAnalysis>) => void) {
  const raw = makeAnalysis();
  raw.observed = { ...raw.observed, hair: "short straight dark hair", face: "smooth complexion and neutral expression", accessories: "none", clothing: "black sweatshirt" };
  raw.identityPrompt = raw.observed.hair;
  raw.canonicalIdentity.overallImpression = raw.observed.hair;
  raw.canonicalIdentity.mustPreserve = [raw.observed.hair];
  raw.canonicalIdentity.features = raw.canonicalIdentity.features.filter(f => f.category !== "accessory" && f.category !== "hair");
  raw.canonicalIdentity.features.push({ feature: raw.observed.hair, category: "hair", priority: 5, confidence: "high", evidence: "authored semantic design unit", targetRegions: ["head.front"] });
  Object.assign(raw.fallbackFeatures, { hairstyle: "short", glasses: "none", hat: "none", facialHair: "none", expression: "neutral" });
  Object.assign(raw.renderHints, { hairPart: "none", fringeOpening: "none", bangs: "straight", bangsLength: "short", fringeEdge: "blunt", overallHairLength: "ear", sideHairLength: "short", sideHairShape: "straight", hairVolume: "normal", hairSilhouette: "rounded", earExposure: "partial", hairAccessory: "none", ...delta });
  modifyRaw?.(raw);
  const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features, plan.hairPlan);
  const baseline = buildProceduralSourceAtlas(features, style, plan)!;
  const design = buildReferenceStylePlan(analysis);
  // Hold the authored family constant: this checks source parameter propagation,
  // not provider observation or automatic family selection quality.
  design.hair = { family: "short_soft_feminine", cost: 0, evidence: ["fixed authored audit family"] };
  return { raw, analysis, plan, features, style, baseline, design };
}

describe("center part source-parameter topology audit (no provider)", () => {
  it("routes an observed short part into distinct front/top outer masks, not only shading", () => {
    const topologies = [], alphaMasks = [];
    for (const part of ["left", "center", "right"] as const) {
      const b = authored({ hairPart: part, fringeOpening: "center", faceShape: "oval" });
      const immutable = JSON.stringify(b.plan);
      const rendered = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
      const outer = rendered.diagnostic.surfaces.filter(c => c.part === "head" && c.owner === "hair" && c.layer === "overlay" && ["front", "top"].includes(c.face));
      topologies.push(JSON.stringify(outer.map(c => [c.face, c.x, c.y]).sort()));
      const alpha = ["front", "top"].flatMap(face => {
        const uv = CLASSIC_LAYOUT.head.overlay[face as "front" | "top"];
        return Array.from({ length: uv.w * uv.h }, (_, i) => rendered.atlas.rgba[((uv.y + Math.floor(i / uv.w)) * 64 + uv.x + i % uv.w) * 4 + 3]);
      });
      alphaMasks.push(JSON.stringify(alpha));
      const gap = part === "center" ? [3, 4] : part === "left" ? [2] : [5];
      for (const x of gap) expect(outer.some(c => c.face === "front" && c.y === 0 && c.x === x), `${part}: root gap`).toBe(false);
      expect(outer.some(c => c.face === "front" && c.y === 0)).toBe(true);
      expect(outer.some(c => c.face === "top")).toBe(true);
      expect(rendered.diagnostic.constraints.baseHairCells).toBeGreaterThan(rendered.diagnostic.constraints.outerHairCells);
      expect(measureReferenceRenderedQuality(rendered, b.baseline, b.plan, b.design, b.style).violations).toEqual([]);
      expect(JSON.stringify(b.plan)).toBe(immutable);
    }
    expect(new Set(topologies).size).toBe(3);
    expect(new Set(alphaMasks).size).toBe(3);
  });
  it("does not use part-position accents to reinterpret absent or measured opening evidence", () => {
    const preserve = [
      (b: ReturnType<typeof authored>) => { delete b.plan.hairPlan.headMask.semanticSilhouette!.fringeOpening; },
      (b: ReturnType<typeof authored>) => { b.plan.hairPlan.headMask.source = "identity_geometry"; },
      (b: ReturnType<typeof authored>) => { b.plan.facePixelPlan.layout.geometryUsage.hairline = true; },
      (b: ReturnType<typeof authored>) => { b.plan.hairPlan.surfaceOnly = true; },
    ];
    for (const guard of preserve) {
      const signatures = [];
      for (const part of ["left", "center", "right"] as const) {
        const b = authored({ hairPart: part, fringeOpening: "center", faceShape: "oval" });
        guard(b);
        const rendered = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
        signatures.push(JSON.stringify(rendered.diagnostic.surfaces.filter(c => c.owner === "hair" && c.layer === "overlay").map(c => [c.face, c.x, c.y]).sort()));
      }
      expect(new Set(signatures).size).toBe(1);
    }
  });
  it("records actual mask/ownership effects without fabricating the saved primary part", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const livePath = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-002/summary.json";
    const liveBytes = readFileSync(livePath);
    try {
      const atlases = new Map<string, ReturnType<typeof composeReferenceStyleAtlas>["atlas"]>();
      const cases = variants.map(({ id, delta }) => {
        let b: ReturnType<typeof authored>;
        try { b = authored(delta); }
        catch (error) { throw new Error(`authored parameter case ${id} inadmissible`, { cause: error }); }
        const immutable = JSON.stringify(b.plan);
        const rendered = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
        const quality = measureReferenceRenderedQuality(rendered, b.baseline, b.plan, b.design, b.style);
        atlases.set(id, rendered.atlas);
        expect(validateFinalAtlas(rendered.atlas).ok).toBe(true);
        expect(quality.violations, id).toEqual([]);
        const cells = b.plan.headIdentityPlan.ownership!.cells;
        const coords = (v: Array<{ face: string; layer: string; x: number; y: number; owner: string }>) => v.map(c => [c.face, c.layer, c.x, c.y, c.owner].join(":")).sort();
        const mask = Object.entries(b.plan.hairPlan.headMask.faces).flatMap(([face, ps]) => ps.map(p => `${face}:${p.x}:${p.y}`)).sort();
        const forehead = [0, 1, 2].flatMap(y => [3, 4].map(x => {
          const r = CLASSIC_LAYOUT.head.base.front, offset = ((r.y + y) * 64 + r.x + x) * 4;
          const outer = CLASSIC_LAYOUT.head.overlay.front, outerOffset = ((outer.y + y) * 64 + outer.x + x) * 4;
          return { x, y, baseOwner: cells.find(c => c.face === "front" && c.layer === "base" && c.x === x && c.y === y)?.owner ?? null,
            rgba: [...rendered.atlas.rgba.slice(offset, offset + 4)], outerAlpha: rendered.atlas.rgba[outerOffset + 3] };
        }));
        expect(JSON.stringify(b.plan)).toBe(immutable);
        expect(b.design.hair.family).toBe("short_soft_feminine");
        for (const [key, value] of Object.entries(delta)) expect(b.analysis.renderHints[key as keyof PixelRenderHints], `${id}:${key}`).toBe(value);
        return { id, provenance: "authored_semantic_design_unit", delta,
          hairlineDepthByColumn: b.plan.facePixelPlan.layout.hairlineDepthByColumn,
          maskSha256: sha(JSON.stringify(mask)), ownershipTopologySha256: sha(JSON.stringify(coords(cells))),
          composedHairTopologySha256: sha(JSON.stringify(coords(rendered.diagnostic.surfaces.filter(c => c.owner === "hair")))),
          fringeCoordinates: b.plan.facePixelPlan.pixels.filter(p => p.cluster === "fringe").map(p => [p.x, p.y]).sort(),
          forehead, atlasRgbaSha256: sha(rendered.atlas.rgba),
          innerHairCells: rendered.diagnostic.constraints.baseHairCells,
          outerHairCells: rendered.diagnostic.constraints.outerHairCells,
          qualityViolations: quality.violations };
      });
      const base = cases[0];
      const comparison = cases.slice(1).map(c => ({ id: c.id, maskChanged: c.maskSha256 !== base.maskSha256,
        ownershipChanged: c.ownershipTopologySha256 !== base.ownershipTopologySha256,
        composedHairTopologyChanged: c.composedHairTopologySha256 !== base.composedHairTopologySha256,
        atlasChanged: c.atlasRgbaSha256 !== base.atlasRgbaSha256 }));
      const rounded = cases.find(c => c.id === "full-rounded")!, flat = cases.find(c => c.id === "full-flat")!;
      const sameVolumeCrownComparison = { maskChanged: rounded.maskSha256 !== flat.maskSha256,
        ownershipChanged: rounded.ownershipTopologySha256 !== flat.ownershipTopologySha256,
        composedHairTopologyChanged: rounded.composedHairTopologySha256 !== flat.composedHairTopologySha256 };
      // These are one-parameter authored comparisons, not a claim that the
      // real primary observed them. The same family must change topology,
      // rather than pass on RGB-only differences.
      expect(sameVolumeCrownComparison).toEqual({ maskChanged: true,
        ownershipChanged: true, composedHairTopologyChanged: true });
      for (const id of ["side-cheek", "ear-visible"]) {
        const change = comparison.find(c => c.id === id)!;
        expect(change.maskChanged, id).toBe(true);
        expect(change.ownershipChanged, id).toBe(true);
        expect(change.composedHairTopologyChanged, id).toBe(true);
      }
      const parameterPairs = [["opened-part-left", "opened-part-center"], ["opened-part-center", "opened-part-right"],
        ["opened-part-center", "opened-fringe-brow"]].map(([from, to]) => {
        const a = cases.find(c => c.id === from)!, b = cases.find(c => c.id === to)!;
        return { from, to, maskChanged: a.maskSha256 !== b.maskSha256,
          ownershipChanged: a.ownershipTopologySha256 !== b.ownershipTopologySha256,
          composedHairTopologyChanged: a.composedHairTopologySha256 !== b.composedHairTopologySha256,
          atlasChanged: a.atlasRgbaSha256 !== b.atlasRgbaSha256 };
      });
      const lengthPair = parameterPairs.find(p => p.to === "opened-fringe-brow")!;
      expect(lengthPair.maskChanged).toBe(true);
      expect(lengthPair.ownershipChanged).toBe(true);
      expect(lengthPair.composedHairTopologyChanged).toBe(true);
      for (const pair of parameterPairs.filter(p => p.to !== "opened-fringe-brow")) {
        expect(pair.maskChanged).toBe(false); // Inner source mask stays authoritative.
        expect(pair.composedHairTopologyChanged).toBe(true); // Raised front/top silhouette, not RGB only.
      }
      for (const id of ["opening-center", "center-part-and-opening", "opening-left", "opening-right"]) {
        const change = comparison.find(c => c.id === id)!;
        expect(change.maskChanged, id).toBe(true);
        expect(change.ownershipChanged, id).toBe(true);
        expect(change.composedHairTopologyChanged, id).toBe(true);
        expect(change.atlasChanged, id).toBe(true);
      }
      const prior = JSON.parse(readFileSync("evaluation-artifacts/center-part-topology-offline-20261007-OnPFUI/audit.json", "utf8"));
      const oldBase = prior.cases.find((c: { id: string }) => c.id === "baseline");
      // The old whole-atlas hash predates the separately tested quiet hair and
      // torso material fixes. Preserve its exact pixels via the existing scoped
      // replay; current topology must still match, and every RGB delta must be
      // licensed by that replay's per-cell material/alpha boundary assertions.
      for (const key of ["hairlineDepthByColumn", "maskSha256", "ownershipTopologySha256",
        "composedHairTopologySha256", "fringeCoordinates", "forehead", "innerHairCells", "outerHairCells"] as const)
        expect(base[key], `baseline topology:${key}`).toEqual(oldBase[key]);
      const b = authored({}), rendered = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
      expect(sha(rendered.atlas.rgba)).toBe(base.atlasRgbaSha256);
      const historical = historicalHairMaterialReplay(b.features, b.style, b.plan, b.design, rendered);
      expect(sha(historical.composition.atlas.rgba)).toBe(oldBase.atlasRgbaSha256);
      const savedPath = "evaluation-artifacts/center-part-topology-offline-20261007-yGfq9V/baseline.png";
      const savedBytes = readFileSync(savedPath), saved = await decodePng(new Uint8Array(savedBytes));
      expect(historical.composition.atlas.rgba).toEqual(saved.rgba);
      expect(historical.retainedMouthPixels).toEqual([]);
      const baselineMaterialBoundary = { historicalPng: savedPath, historicalPngSha256: sha(savedBytes),
        historicalRgbaSha256: sha(saved.rgba), currentRgbaSha256: base.atlasRgbaSha256,
        hairMaterialPixels: historical.changedPixels, torsoMaterialPixels: historical.torsoMaterialPixels,
        retainedMouthPixels: historical.retainedMouthPixels, topologyUnchanged: true, alphaUnchanged: true };
      atlases.set("historical-baseline", historical.composition.atlas);
      const beforePath = "evaluation-artifacts/center-part-topology-offline-20261007-yGfq9V/audit.json";
      const beforeBytes = readFileSync(beforePath), before = JSON.parse(beforeBytes.toString());
      const partReplay = ["opened-part-left", "opened-part-center", "opened-part-right"].map(id => {
        const old = before.cases.find((c: { id: string }) => c.id === id)!, current = cases.find(c => c.id === id)!;
        expect(current.maskSha256).toBe(old.maskSha256);
        expect(current.ownershipTopologySha256).toBe(old.ownershipTopologySha256);
        expect(current.composedHairTopologySha256).not.toBe(old.composedHairTopologySha256);
        return { id, before: old, after: current, innerSourceMaskUnchanged: true, sourceOwnershipUnchanged: true };
      });
      const actual = JSON.parse(liveBytes.toString()).currentDefaultE2E.result.propagationTrace;
      expect(actual.injectedParameters.faceStyle.hairPart).toBe("none");
      expect(actual.injectedParameters.faceStyle.fringeOpening).toBe("none");
      expect(readFileSync(livePath)).toEqual(liveBytes);
      expect(network).not.toHaveBeenCalled();
      const root = mkdtempSync("evaluation-artifacts/center-part-topology-offline-20261007-");
      writeFileSync(`${root}/audit.json`, JSON.stringify({ providerCalls: 0, sourceEvidence: "authored_not_live",
        sameFamily: "short_soft_feminine", productionChange: "explicit_short_part_outer_topology", baselineLiveSummarySha256: sha(liveBytes),
        beforeArtifact: beforePath, beforeArtifactSha256: sha(beforeBytes), partReplay, baselineMaterialBoundary,
        actualPrimaryPart: "none", actualPrimaryOpening: "none", actualLiveEarliestLoss: "PRIMARY_MISSED",
        cases, comparison, parameterPairs, sameVolumeCrownComparison }, null, 2), { flag: "wx" });
      for (const id of ["historical-baseline", "baseline", "center-part-and-opening", "opening-left", "opening-right", "opened-part-left", "opened-part-center", "opened-part-right", "opened-fringe-brow"]) {
        writeFileSync(`${root}/${id}.png`, await encodePng(atlases.get(id)!), { flag: "wx" });
        const view = renderSkinViews(atlases.get(id)!).find(v => v.name === "front")!.image;
        writeFileSync(`${root}/${id}-front.png`, await encodePng(scaleNearestNeighbor(view, 192, 384)), { flag: "wx" });
      }
      expect(readFileSync(savedPath)).toEqual(savedBytes);
      expect(readFileSync(beforePath)).toEqual(beforeBytes);
      console.info(`CENTER_PART_TOPOLOGY_AUDIT ${root}`);
    } finally { network.mockRestore(); }
  }, 30_000);
  it.each(["left", "center", "right"] as const)("preserves the explicit %s window in mask, ownership and real pixels", cue => {
    const b = authored({ hairPart: cue, fringeOpening: cue, faceShape: "oval" });
    const immutable = JSON.stringify(b.plan), rendered = composeReferenceStyleAtlas(b.baseline, b.plan, b.design, b.style);
    expect(b.plan.hairPlan.headMask.semanticSilhouette?.fringeOpening, JSON.stringify({ template: b.plan.hairPlan.template, hints: { opening: b.analysis.renderHints.fringeOpening, length: b.analysis.renderHints.bangsLength, accessory: b.analysis.renderHints.hairAccessory }, hat: b.analysis.fallbackFeatures.hat, layout: { eyes: [b.plan.facePixelPlan.layout.leftEyeRow, b.plan.facePixelPlan.layout.rightEyeRow], brows: [b.plan.facePixelPlan.layout.leftBrowRow, b.plan.facePixelPlan.layout.rightBrowRow], measured: b.plan.facePixelPlan.layout.geometryUsage.hairline } })).toBeDefined();
    const cells = b.plan.hairPlan.headMask.semanticSilhouette!.fringeOpening!.cells;
    expect(cells.map(p => p.x)).toEqual(cue === "center" ? [3, 4] : cue === "left" ? [2] : [5]);
    for (const p of cells) {
      expect(b.plan.hairPlan.headMask.faces.front.some(c => c.x === p.x && c.y === p.y)).toBe(false);
      expect(b.plan.headIdentityPlan.ownership!.cells.find(c => c.layer === "base" && c.face === "front" && c.x === p.x && c.y === p.y)?.owner).toBe("face");
      const uv = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
      const i = ((uv.y + p.y) * 64 + uv.x + p.x) * 4, o = ((outer.y + p.y) * 64 + outer.x + p.x) * 4;
      const skin = [1, 3, 5].map(c => parseInt(b.style.skinTone!.slice(c, c + 2), 16));
      expect([...rendered.atlas.rgba.slice(i, i + 4)]).toEqual([...skin, 255]);
      expect(rendered.atlas.rgba[o + 3]).toBe(0);
    }
    if (cue === "center") for (const x of [2, 5]) {
      // Short fringe already reserves row 1 as the source-supported end
      // window. Its left/right groups must survive on row 0, not refill the
      // deliberately exposed row below (the brow-length case checks row 1).
      expect(rendered.diagnostic.surfaces.some(c => c.part === "head" && c.face === "front" && c.layer === "base" && c.y === 0 && c.x === x && c.owner === "hair")).toBe(true);
      expect(b.plan.headIdentityPlan.ownership!.cells.find(c => c.face === "front" && c.layer === "base" && c.y === 1 && c.x === x)?.owner).toBe("face");
      expect(rendered.diagnostic.surfaces.some(c => c.part === "head" && c.face === "front" && c.layer === "base" && c.y === 1 && c.x === x && c.owner === "hair")).toBe(false);
    }
    expect(rendered.diagnostic.constraints.baseHairCells).toBeGreaterThan(rendered.diagnostic.constraints.outerHairCells);
    expect(measureReferenceRenderedQuality(rendered, b.baseline, b.plan, b.design, b.style).violations).toEqual([]);
    expect(JSON.stringify(b.plan)).toBe(immutable);
    const forged = structuredClone(rendered), p = cells[0], uv = CLASSIC_LAYOUT.head.base.front;
    const i = ((uv.y + p.y) * 64 + uv.x + p.x) * 4;
    forged.atlas.rgba.set([20, 20, 20, 255], i);
    for (const c of forged.diagnostic.surfacePixels.filter(c => c.part === "head" && c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y)) c.color = [20, 20, 20];
    expect(measureReferenceRenderedQuality(forged, b.baseline, b.plan, b.design, b.style).violations).toContain("source_semantic_fringe_window_closed");
    const helmet = structuredClone(rendered), overlay = CLASSIC_LAYOUT.head.overlay.front;
    helmet.atlas.rgba.set([20, 20, 20, 255], ((overlay.y + p.y) * 64 + overlay.x + p.x) * 4);
    expect(measureReferenceRenderedQuality(helmet, b.baseline, b.plan, b.design, b.style).violations).toContain("source_semantic_fringe_window_closed");
  });
  it("does not fabricate an opening from a part, hair ornament or longer hair", () => {
    expect(authored({ hairPart: "center" }).plan.hairPlan.headMask.semanticSilhouette?.fringeOpening).toBeUndefined();
    for (const delta of [{ hairAccessory: "headband" }, { overallHairLength: "jaw" } ] as Partial<PixelRenderHints>[])
      expect(authored({ fringeOpening: "center", ...delta }).plan.hairPlan.headMask.semanticSilhouette?.fringeOpening).toBeUndefined();
  });
  it("keeps actual landmarks, hats, missing hair and measured hairline authoritative", () => {
    const conflict = authored({ fringeOpening: "left" });
    expect(conflict.plan.facePixelPlan.pixels.some(p => p.x === 2 && p.y === 1 && p.role === "brow")).toBe(true);
    expect(conflict.plan.hairPlan.headMask.semanticSilhouette?.fringeOpening).toBeUndefined();
    for (const mutate of [
      (raw: ReturnType<typeof makeAnalysis>) => { raw.fallbackFeatures.hat = "beanie"; },
      (raw: ReturnType<typeof makeAnalysis>) => { raw.visibleRegions.hair = false; },
      (raw: ReturnType<typeof makeAnalysis>) => { raw.observed.hair = "hair obscured and not visible"; },
      (raw: ReturnType<typeof makeAnalysis>) => {
        raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync("evaluation-artifacts/head-structure-iteration-final/short-hair-red-shirt/metrics.json", "utf8")).sourceGeometryAfter)!;
        expect(raw.identityGeometry).toBeDefined();
      },
    ]) {
      const b = authored({ fringeOpening: "center" }, mutate);
      expect(b.plan.hairPlan.headMask.semanticSilhouette?.fringeOpening).toBeUndefined();
    }
  });
  it("changes opening position within the same family/face without moving eyes, brows or mouth", () => {
    const signatures = [];
    const neutral = authored({ faceShape: "oval" });
    const landmarks = (b: ReturnType<typeof authored>) => b.plan.facePixelPlan.pixels.filter(p => p.cluster !== "fringe");
    for (const cue of ["left", "center", "right"] as const) {
      const b = authored({ faceShape: "oval", fringeOpening: cue });
      signatures.push(JSON.stringify(b.plan.hairPlan.headMask.faces.front));
      expect(landmarks(b)).toEqual(landmarks(neutral));
      expect(b.design.hair.family).toBe(neutral.design.hair.family);
    }
    expect(new Set(signatures).size).toBe(3);
  });
  it("does not salvage an inadmissible eye-length fringe/face combination", () => {
    expect(() => authored({ hairPart: "center", fringeOpening: "center", faceShape: "oval", bangsLength: "eye" }))
      .toThrow("No admissible face pixel plan");
  });
  it("preserves source short/brow fringe depth and independently rejects a refilled short-fringe end", () => {
    const delta = { hairPart: "center", fringeOpening: "center", faceShape: "oval" } as const;
    const short = authored(delta), brow = authored({ ...delta, bangsLength: "brow" });
    const windows = short.plan.hairPlan.headMask.semanticSilhouette!.fringeLengthWindows!;
    expect(windows).toEqual({ cue: "short", cells: [{ x: 2, y: 1 }, { x: 5, y: 1 }] });
    expect(brow.plan.hairPlan.headMask.semanticSilhouette!.fringeLengthWindows).toBeUndefined();
    const landmarks = (b: ReturnType<typeof authored>) => b.plan.facePixelPlan.pixels.filter(p => p.cluster !== "fringe");
    expect(landmarks(short)).toEqual(landmarks(brow));
    const rendered = composeReferenceStyleAtlas(short.baseline, short.plan, short.design, short.style);
    expect(measureReferenceRenderedQuality(rendered, short.baseline, short.plan, short.design, short.style).violations).toEqual([]);
    const before = JSON.stringify(short.plan);
    for (const p of windows.cells) {
      expect(short.plan.hairPlan.headMask.faces.front.some(c => c.x === p.x && c.y === p.y)).toBe(false);
      expect(brow.plan.hairPlan.headMask.faces.front.some(c => c.x === p.x && c.y === p.y)).toBe(true);
      expect(short.plan.headIdentityPlan.ownership!.cells.some(c => c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y && c.owner === "face")).toBe(true);
      const forged = structuredClone(rendered), uv = CLASSIC_LAYOUT.head.base.front;
      const offset = ((uv.y + p.y) * 64 + uv.x + p.x) * 4;
      forged.atlas.rgba.set([20, 20, 20, 255], offset);
      for (const c of forged.diagnostic.surfacePixels.filter(c => c.part === "head" && c.face === "front" && c.layer === "base" && c.x === p.x && c.y === p.y)) c.color = [20, 20, 20];
      expect(measureReferenceRenderedQuality(forged, short.baseline, short.plan, short.design, short.style).violations)
        .toContain("source_semantic_fringe_length_window_closed");
    }
    expect(JSON.stringify(short.plan)).toBe(before);
    expect(authored({ hairPart: "center" }).plan.hairPlan.headMask.semanticSilhouette?.fringeLengthWindows).toBeUndefined();
    expect(authored({ fringeOpening: "center" }).plan.hairPlan.headMask.semanticSilhouette?.fringeLengthWindows).toBeUndefined(); // brow reservations win
  });
});
