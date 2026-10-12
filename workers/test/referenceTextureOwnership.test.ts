import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { generateSkin, normalizeAnalysisForRendering, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis, buildFaceStyle, buildProceduralSourceAtlas, buildProceduralFallbackAtlas } from "../src/generate";
import * as primary from "../src/analysis";
import type { Env } from "../src/types";
import { buildSkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { encodePng, decodePng, base64ToBytes, bytesToBase64 } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { CLASSIC_LAYOUT } from "../src/uvLayout";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function textureSource(texture: "curly" | "coily", length: "ear" | "jaw" | "chest") {
  const a = makeAnalysis();
  // Explicit semantic design units, not extra measured/photo annotations.
  a.observed.hair = `${length} length full ${texture} hair with visible textured sides`;
  a.observed.accessories = "none";
  a.canonicalIdentity.features = a.canonicalIdentity.features.filter(f => f.category !== "hair" && f.category !== "accessory");
  a.canonicalIdentity.features.push({ category: "hair", feature: a.observed.hair, evidence: a.observed.hair, confidence: "high", priority: 5, targetRegions: ["head.front", "head.back"] });
  a.renderHints.hairTexture = texture; a.renderHints.hairVolume = "full";
  a.renderHints.overallHairLength = length; a.renderHints.sideHairLength = length === "ear" ? "short" : length === "jaw" ? "jaw" : "shoulder";
  a.renderHints.hairSilhouette = "rounded"; a.renderHints.sideHairShape = "flared";
  a.renderHints.hairAccessory = "none"; a.fallbackFeatures.glasses = "none";
  a.fallbackFeatures.earrings = false; a.fallbackFeatures.hat = "none";
  a.fallbackFeatures.hairstyle = length === "ear" ? "short" : "long";
  return normalizeAnalysisForRendering(a);
}
describe("source-derived texture ownership in the default reference boundary", () => {
  it("styles categorical coily and profile-open curly silhouettes without fake geometry", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const root = mkdtempSync("evaluation-artifacts/reference-texture-ownership-20261005-");
    const entries = [];
    try {
      for (const texture of ["curly", "coily"] as const) for (const length of ["ear", "jaw", "chest"] as const) {
        const a = textureSource(texture, length), source = buildSkinPlan(a);
        expect(a.identityGeometry).toBeUndefined();
        expect(source.hairPlan.headMask.semanticSilhouette?.provenance).toBe("observed_categorical");
        expect(source.hairPlan.structure.grammar).toBe(texture === "curly" ? "curl_lobes" : "coily_clusters");
        expect(source.headIdentityPlan.ownership?.execution).toBe("resolved");
        const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
        const style = buildFaceStyle(a, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source);
        expect(baseline).not.toBeNull(); const before = JSON.stringify(source);
        const rendered = renderReferencePrimaryAtlas(baseline!, source, a, style);
        expect(rendered.ok, `${texture}:${length}:${!rendered.ok ? rendered.reason : ""}`).toBe(true);
        if (!rendered.ok) throw new Error(rendered.reason);
        expect(rendered.summary.status).toBe("reference_style_accepted");
        expect(rendered.summary.constraints?.ok).toBe(true);
        expect(rendered.summary.metrics?.accidentalEyeOcclusionCells).toBe(0);
        if (texture === "curly") {
          expect(source.hairPlan.headMask.semanticSilhouette?.profileOpening).toBe("curly_ringlets");
          for (const [face, templeX] of [["right", 6], ["left", 1]] as const) {
            const r = CLASSIC_LAYOUT.head.overlay[face];
            expect(rendered.atlas.rgba[((r.y + 2) * 64 + r.x + templeX) * 4 + 3]).toBe(0);
            expect(source.headIdentityPlan.ownership?.cells.find(c => c.face === face && c.layer === "outer" && c.x === templeX && c.y === 2)?.sourceGroupId).toBe("curly-profile-window");
          }
          expect(source.hairPlan.headMask.faces.right.some(p => p.x === 4 && p.y === 4)).toBe(false);
          expect(source.hairPlan.headMask.faces.right.filter(p => p.y === 4).map(p => p.x)).toEqual([0, 1, 7]);
        }
        expect(JSON.stringify(source)).toBe(before);
        const id = `${texture}-${length}`;
        writeFileSync(`${root}/${id}.png`, await encodePng(rendered.atlas), { flag: "wx" });
        for (const label of ["front", "back", "right"] as const) {
          const view = renderSkinViews(rendered.atlas).find(v => v.name === label)!.image;
          writeFileSync(`${root}/${id}-${label}.png`, await encodePng(scaleNearestNeighbor(view, view.width * 4, view.height * 4)), { flag: "wx" });
        }
        entries.push({ id, fixtureKind: "authored_semantic_design_unit", sourcePlanHash: hash(before), defaultAtlasHash: hash(rendered.atlas.rgba), summary: rendered.summary });
      }
      expect(network).not.toHaveBeenCalled();
      writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, cases: entries }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_TEXTURE_OWNERSHIP ${root}`);
    } finally { network.mockRestore(); }
  }, 120_000);
  it.each(["legacy_mask", "ornament", "locs"] as const)("does not promote unresolved %s to trusted texture ownership", kind => {
    const a = textureSource("coily", "jaw");
    if (kind === "ornament") { a.observed.hair += " with a flower and headband in the hair"; a.renderHints.hairAccessory = "flower"; }
    const source = buildSkinPlan(a), hair = structuredClone(source.hairPlan);
    if (kind === "legacy_mask") delete hair.headMask.semanticSilhouette;
    if (kind === "locs") hair.structure.grammar = "lock_groups";
    expect(resolveHeadOwnership(a, hair, source.facePixelPlan).execution).toBe("preserve_existing_grammar");
  });
  it.each(["curly", "coily"] as const)("preserves complex %s ornaments rather than manufacturing an owned accessory", texture => {
    const a = textureSource(texture, "jaw");
    a.observed.hair += " with a flower and headband in the hair"; a.renderHints.hairAccessory = "flower";
    expect(buildSkinPlan(a).headIdentityPlan.ownership?.execution).toBe("preserve_existing_grammar");
  });
  it("does not promote a curly silhouette without an explicit profile-opening contract", () => {
    const a = textureSource("curly", "jaw"), source = buildSkinPlan(a);
    const hair = structuredClone(source.hairPlan);
    delete hair.headMask.semanticSilhouette!.profileOpening;
    expect(resolveHeadOwnership(a, hair, source.facePixelPlan).execution).toBe("preserve_existing_grammar");
  });
  it.each(["coily", "curly"] as const)("encodes %s designs through actual default generateSkin without inference", async texture => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    const runPrimary = vi.spyOn(primary, "runPhotoAnalysis");
    const aiRun = vi.fn(async () => { throw new Error("unexpected_inference"); });
    const bindings = { AI: { run: aiRun }, MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } } as unknown as Env;
    try {
      const a = textureSource(texture, "chest"), source = buildSkinPlan(a);
      const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
      const style = buildFaceStyle(a, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
      if (texture === "coily") expect(buildProceduralFallbackAtlas(features, style, source)).toBeNull(); // Legacy shoulder-continuation contract remains enforced.
      const expected = renderReferencePrimaryAtlas(baseline, source, a, style);
      expect(expected.ok).toBe(true); if (!expected.ok) throw new Error(expected.reason);
      runPrimary.mockResolvedValue({ ok: true, analysis: a, attempts: 1, neuronsSpent: 1 });
      const image = `data:image/png;base64,${bytesToBase64(await encodePng(baseline))}`;
      const result = await generateSkin(bindings, image);
      expect(result.status).toBe(200); expect(result.body.analysis?.referenceStyle?.status).toBe("reference_style_accepted");
      const decoded = await decodePng(base64ToBytes(result.body.skinPngBase64!));
      expect(decoded.rgba).toEqual(expected.atlas.rgba);
      expect(runPrimary).toHaveBeenCalledTimes(1); expect(aiRun).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
      const root = mkdtempSync("evaluation-artifacts/reference-texture-default-integration-20261005-");
      writeFileSync(`${root}/${texture}-chest-default.png`, await encodePng(decoded), { flag: "wx" });
      writeFileSync(`${root}/results.json`, JSON.stringify({ fixtureKind: "authored_semantic_design_unit", providerCalls: 0, primary: "mocked_stored_analysis", status: result.status, sourcePlanHash: hash(JSON.stringify(source)), expectedAtlasHash: hash(expected.atlas.rgba), actualDefaultAtlasHash: hash(decoded.rgba), summary: result.body.analysis?.referenceStyle }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_TEXTURE_DEFAULT_INTEGRATION ${root}`);
    } finally { runPrimary.mockRestore(); network.mockRestore(); }
  });
  it("rejects rewritten texture diagnostics instead of accepting arbitrary near-black hair colors", () => {
    const a = textureSource("coily", "jaw"), source = buildSkinPlan(a);
    const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
    const selected = selectReferenceStyleAtlas(baseline, source, buildReferenceStylePlan(a), style).selected!;
    expect(selected.quality.constructionValid).toBe(true);
    const tampered = structuredClone(selected.composition);
    const cell = tampered.diagnostic.surfacePixels.find(c => c.part === "head" && c.layer === "base" && c.face === "back" && c.owner === "hair")!;
    const r = CLASSIC_LAYOUT.head.base.back, i = ((r.y + cell.y) * 64 + r.x + cell.x) * 4;
    cell.color = [90, 140, 190]; tampered.atlas.rgba.set(cell.color, i);
    const quality = measureReferenceRenderedQuality(tampered, baseline, source, selected.design, style);
    expect(quality.constructionValid).toBe(false); expect(quality.violations).toContain("source_hair_palette_changed");
  });
  it("rejects a closed curly profile even when its paint diagnostic claims a new hair accent", () => {
    const a = textureSource("curly", "jaw"), source = buildSkinPlan(a);
    const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, features, source.hairPlan), baseline = buildProceduralSourceAtlas(features, style, source)!;
    const selected = selectReferenceStyleAtlas(baseline, source, buildReferenceStylePlan(a), style).selected!;
    const tampered = structuredClone(selected.composition);
    const c = { part: "head" as const, layer: "overlay" as const, face: "right" as const, x: 6, y: 2, owner: "hair" as const };
    const color: [number, number, number] = [12, 12, 12];
    const r = CLASSIC_LAYOUT.head.overlay.right, i = ((r.y + c.y) * 64 + r.x + c.x) * 4;
    tampered.atlas.rgba.set([...color, 255], i);
    tampered.diagnostic.surfaces.push(c); tampered.diagnostic.surfacePixels.push({ ...c, color });
    const quality = measureReferenceRenderedQuality(tampered, baseline, source, selected.design, style);
    expect(quality.constructionValid).toBe(false); expect(quality.violations).toContain("source_curly_profile_window_closed");
  });
});
