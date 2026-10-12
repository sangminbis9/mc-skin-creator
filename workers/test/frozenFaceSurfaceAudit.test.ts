// Local role/material audit; annotations and historical measured geometry stay immutable.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { historicalHairMaterialPlan, historicalHairMaterialReplay } from "./historicalHairMaterial";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

it("maps visible frozen face shading to planned roles and material owners without inventing new observations", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const root = mkdtempSync("evaluation-artifacts/frozen-face-surface-audit-20261008-");
  const frozen = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
  const annotations: AnnotatedCase[] = JSON.parse(frozen.toString());
  const rows = [];
  try {
    for (const id of ["curly-hair", "long-straight-hair", "headscarf-color-blocks"]) {
      const raw = strictBoundaryAnalysisFromAnnotation(annotations.find(a => a.id === id)!).analysis;
      raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
      const planHash = sha(JSON.stringify(plan));
      const colors = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, colors, plan.hairPlan);
      const baseline = buildProceduralFallbackAtlas(colors, style, plan)!;
      const selected = selectReferenceStyleAtlas(baseline, plan, buildReferenceStylePlan(analysis), style).selected!;
      expect(selected, id).toBeTruthy();
      const composition = selected.composition, atlas = composition.atlas;
      const stored = await decodePng(readFileSync(`evaluation-artifacts/reference-primary-integration-20261005-N3as27/${id}-default.png`));
      const prior = JSON.parse(readFileSync("evaluation-artifacts/frozen-face-surface-audit-20261008-gq1hDr/results.json", "utf8"))
        .rows.find((row: { id: string }) => row.id === id);
      expect(sha(JSON.stringify(historicalHairMaterialPlan(plan)))).toBe(prior.planHash);
      const historical = historicalHairMaterialReplay(colors, style, plan, selected.design, composition);
      expect(selected.design.face.family).toBe(prior.family);
      const changedPigmentCells = [];
      const front = CLASSIC_LAYOUT.head.base.front;
      for (let i = 0; i < 4096; i++) {
        expect(atlas.rgba[i * 4 + 3]).toBe(stored.rgba[i * 4 + 3]);
        if (![0, 1, 2].some(channel => historical.composition.atlas.rgba[i * 4 + channel] !== stored.rgba[i * 4 + channel])) continue;
        const x = i % 64 - front.x, y = Math.floor(i / 64) - front.y;
        expect(composition.diagnostic.faceFinish.irisPigmentCells.some(p => p.x === x && p.y === y)).toBe(true);
        changedPigmentCells.push({ x, y });
      }
      expect(changedPigmentCells.length).toBe(id === "headscarf-color-blocks" ? 2 : 0);
      expect(sha(JSON.stringify(plan))).toBe(planHash);
      const rect = CLASSIC_LAYOUT.head.base.front;
      const pixel = (image: typeof atlas, x: number, y: number) => [...image.rgba.slice(((rect.y + y) * 64 + rect.x + x) * 4, ((rect.y + y) * 64 + rect.x + x) * 4 + 3)];
      const cells = Array.from({ length: 64 }, (_, i) => {
        const x = i % 8, y = Math.floor(i / 8);
        return { x, y, before: pixel(baseline, x, y), after: pixel(atlas, x, y),
          roles: plan.facePixelPlan.pixels.filter(p => p.x === x && p.y === y).map(p => [p.cluster, p.role]),
          owners: plan.headIdentityPlan.ownership!.cells.filter(p => p.layer === "base" && p.face === "front" && p.x === x && p.y === y).map(p => p.owner),
          skinWindow: composition.diagnostic.faceFinish.skinWindowCells.some(p => p.x === x && p.y === y),
          changed: composition.diagnostic.faceFinish.changedCells.some(p => p.x === x && p.y === y) };
      });
      rows.push({ id, planHash, atlasSha256: sha(atlas.rgba), intentionalHairMaterialPixels: historical.changedPixels, changedPigmentCells, geometryUsage: plan.facePixelPlan.layout.geometryUsage,
        hairline: plan.facePixelPlan.layout.hairlineDepthByColumn, faceStyle: { skin: style.skinTone, eye: style.eyeColor, beard: style.facialHair },
        family: selected.design.face.family, faceFinish: composition.diagnostic.faceFinish, cells });
      for (const [label, image] of [["before", baseline], ["current", atlas]] as const) {
        for (const view of renderSkinViews(image)) writeFileSync(`${root}/${id}-${label}-${view.name}.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
      }
    }
    expect(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json")).toEqual(frozen);
    expect(network).not.toHaveBeenCalled();
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, provenance: "frozen_annotation_and_historical_geometry_replay", annotationHash: sha(frozen), rows }, null, 2), { flag: "wx" });
    console.info("FROZEN_FACE_SURFACE_AUDIT", root);
  } finally { network.mockRestore(); }
}, 60000);
