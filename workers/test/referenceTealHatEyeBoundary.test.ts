// Read-only saved-run diagnosis. No measurement, prompt or production mutation.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { resolveHeadOwnership } from "../src/headOwnership";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { referenceEyePresentation } from "../src/referenceFaceFinish";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

it("separates preserved D005 eyes from unmeasured fallback brow presentation blockage", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-005";
    const bytes = readFileSync(`${root}/summary.json`);
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    expect(sha(bytes)).toBe("c68f89606fd8bbd98a0936a4809a9e5628c8d9533d6ee5dba0dc550675f4efa3");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const p: SkinPlan = structuredClone(t.skinPlan.skinPlan);
    const observed = JSON.stringify(a);
    p.headIdentityPlan.ownership = resolveHeadOwnership(a, p.hairPlan, p.facePixelPlan);
    const hatColor = refineFeatureColorsFromAnalysis(a, t.injectedParameters.features).hatColor;
    const style = { ...t.injectedParameters.faceStyle, hatColor };
    const baseline = buildProceduralSourceAtlas({ ...t.injectedParameters.features, hatColor }, style, p)!;
    const result = renderReferencePrimaryAtlas(baseline, p, a, style);
    expect(result.ok).toBe(true); if (!result.ok || !result.summary.design) throw Error("no_current_reference_result");
    const composition = composeReferenceStyleAtlas(baseline, p, result.summary.design, style);
    expect(composition.atlas.rgba).toEqual(result.atlas.rgba);
    const face = p.facePixelPlan, cues = a.faceMeasurementEvidence!.cues;
    expect(cues.eyeOpenness.value).toBe("normal"); expect(cues.eyeFootprint.value).toBe("medium");
    expect(cues.browEyeDistance.value).toBe("unknown"); expect(cues.browSlope.value).toBe("unknown");
    expect(face.layout.geometryUsage.eyes).toBe(false); expect(face.layout.geometryUsage.brows).toBe(false);
    const eyes = face.pixels.filter(c => c.role === "iris");
    expect(eyes.map(c => [c.x, c.y])).toEqual([[2, 4], [5, 4]]);
    const eye = [1, 3, 5].map(i => Number.parseInt(style.eyeColor.slice(i, i + 2), 16));
    const front = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
    const at = (x: number, y: number, r = front) => ((r.y + y) * 64 + r.x + x) * 4;
    for (const cell of eyes) {
      expect([...result.atlas.rgba.slice(at(cell.x, cell.y), at(cell.x, cell.y) + 3)]).toEqual(eye);
      expect(result.atlas.rgba[at(cell.x, cell.y, outer) + 3]).toBe(0);
      expect(face.pixels.some(c => c.x === cell.x && c.y === cell.y - 1 && c.role === "brow")).toBe(true);
    }
    const previous = JSON.parse(readFileSync("evaluation-artifacts/teal-hat-eye-boundary-offline-20261010-aMCalj/summary.json", "utf8"));
    expect(previous.sourceSummarySha256).toBe(sha(bytes));
    expect(previous.currentPresentation).toEqual({ kind: "retain_source", cells: [] });
    expect(composition.diagnostic.faceFinish.eyePresentation.kind).toBe("paired_upper_catch_unmeasured_brow");
    const material = p.headIdentityPlan.ownership.cells.filter(c => c.face === "front" && c.layer === "base"
      && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner));
    // Single-predicate diagnosis only. Never render or validate the ablated
    // plan as source truth; this shows why the existing presentation opts out.
    const noFallbackBrows = { ...face, pixels: face.pixels.filter(c => c.role !== "brow") };
    const ablation = referenceEyePresentation(noFallbackBrows, result.summary.design, eye, material, baseline);
    expect(ablation.kind).toBe("paired_upper_catch");
    expect(ablation.cells.map(c => [c.x, c.y])).toEqual([[2, 3], [5, 3]]);
    const out = freshAuditOutput("evaluation-artifacts/teal-hat-eye-boundary-offline-20261010-");
    writeFileSync(`${out}/current.png`, await encodePng(result.atlas), { flag: "wx" });
    const view = renderSkinViews(result.atlas).find(v => v.name === "front")!.image;
    writeFileSync(`${out}/front.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
    writeFileSync(`${out}/summary.json`, JSON.stringify({ providerCalls: 0, sourceRun: t.runId, sourceSummarySha256: sha(bytes),
      mode: "offline_saved_plan_diagnosis_not_live", observationsUnchanged: true,
      eyeCuePreserved: true, eyeCoordinatesPreserved: true, irisPalettePreserved: true, eyeOverlayOcclusion: 0,
      browDistanceEvidence: cues.browEyeDistance, browSlopeEvidence: cues.browSlope,
      currentPresentation: composition.diagnostic.faceFinish.eyePresentation,
      historicalPresentation: previous.currentPresentation,
      diagnosticAblation: { onlyRemovedFallbackBrowInstructions: true, notRenderedOrAdopted: true, result: ablation },
      classification: "UNMEASURED_BROW_PRESENTATION_APPLIED",
      nextBoundary: "broader actual output readability and observed clothing pattern propagation",
      currentRgbaSha256: sha(result.atlas.rgba), craft: result.summary.craftValidation, qualityGoalComplete: false,
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(a)).toBe(observed); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled(); console.info("D005_EYE_BOUNDARY", out);
  } finally { network.mockRestore(); }
}, 60_000);
