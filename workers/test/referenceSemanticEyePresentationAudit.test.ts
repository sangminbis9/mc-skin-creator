// OFFLINE DESIGN STUDY. Prototype paints are not imported by production;
// compare them against the independently validated current presentation.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildSkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { preserveObservedScarfBeltColors } from "../src/outfitIdentity";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import type { FaceStyle } from "../src/skinPack";
import { facialHairBaseFootprint } from "../src/facialHairFootprint";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { measureFaceRenderContract } from "../src/identityRenderContract";
import { encodePng, type RawImage } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const front = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
const at = (x: number, y: number, r = front) => ((r.y + y) * 64 + r.x + x) * 4;
function candidateCells(plan: SkinPlan, style: FaceStyle, atlas: RawImage) {
  const p = plan.facePixelPlan, l = p.layout;
  if (l.geometryUsage.eyes || p.protectedGeometry.includes("eye_layout") || p.renderContract.eyes?.protected
    || l.eyeOpenness !== "readable" || l.eyeTopology !== "readable_iris" || l.eyeFootprintTopology !== "medium"
    || p.glassesPlan.topology !== "none" || !/^#[0-9a-f]{6}$/i.test(style.eyeColor ?? "")) return [];
  const eyes = ["left_eye", "right_eye"].map(cluster => p.pixels.filter(c => c.cluster === cluster && c.role !== "brow"));
  if (!eyes.every(e => e.length === 1 && e[0].role === "iris") || eyes[0][0].y !== eyes[1][0].y
    || eyes[0][0].x >= eyes[1][0].x) return [];
  const cells = eyes.map(([e]) => ({ x: e.x, y: e.y - 1 }));
  const protectedMaterial = [...facialHairBaseFootprint(style), ...(plan.headIdentityPlan.ownership?.cells
    .filter(c => c.face === "front" && c.layer === "base" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner)) ?? [])];
  if (!cells.every(c => c.x >= 1 && c.x <= 6 && c.y >= 2 && c.y <= 5 && c.y > l.hairlineDepthByColumn[c.x]
    && !p.pixels.some(q => q.cluster !== "complexion" && q.x === c.x && q.y === c.y)
    && !protectedMaterial.some(q => q.x === c.x && q.y === c.y)
    && atlas.rgba[at(c.x, c.y) + 3] === 255 && atlas.rgba[at(c.x, c.y, outer) + 3] === 0)) return [];
  return cells;
}

it("compares two authored upper-catch presentations without changing production, evidence or measured eyes", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const output = freshAuditOutput("evaluation-artifacts/semantic-eye-presentation-study-20261010-");
    const runBytes = readFileSync("evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001/summary.json");
    expect(sha(runBytes)).toBe("d9f82481a49f537a37b26bb5d23534eda6d07560a9d233d070ca83d002938ff1");
    const t = JSON.parse(runBytes.toString()).currentDefaultE2E.result.propagationTrace;
    const savedAnalysis = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const savedPlan: SkinPlan = structuredClone(t.skinPlan.skinPlan);
    savedPlan.headIdentityPlan.ownership = resolveHeadOwnership(savedAnalysis, savedPlan.hairPlan, savedPlan.facePixelPlan);
    savedPlan.outfitPlan = preserveObservedScarfBeltColors(savedPlan.outfitPlan, savedAnalysis);
    const contexts: { id: string; analysis: PhotoAnalysis; plan: SkinPlan; style: FaceStyle; baseline: RawImage }[] = [{
      id: "saved-C", analysis: savedAnalysis, plan: savedPlan, style: t.injectedParameters.faceStyle,
      baseline: buildProceduralSourceAtlas(t.injectedParameters.features, t.injectedParameters.faceStyle, savedPlan)!,
    }];
    const annotationBytes = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
    const annotations: AnnotatedCase[] = JSON.parse(annotationBytes.toString());
    for (const f of annotations) {
      const raw = strictBoundaryAnalysisFromAnnotation(f).analysis;
      if (f.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(`evaluation-artifacts/head-structure-iteration-final/${f.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const analysis = normalizeAnalysisForRendering(raw), plan = buildSkinPlan(analysis);
      const colors = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
      const style = buildFaceStyle(analysis, colors, plan.hairPlan);
      contexts.push({ id: f.id, analysis, plan, style, baseline: buildProceduralSourceAtlas(colors, style, plan)! });
    }
    const rows = [];
    for (const c of contexts) {
      const planBefore = JSON.stringify(c.plan), analysisBefore = JSON.stringify(c.analysis);
      const selection = selectReferenceStyleAtlas(c.baseline, c.plan, buildReferenceStylePlan(c.analysis), c.style);
      expect(selection.selected, c.id).toBeTruthy();
      const chosen = selection.selected!, current = chosen.composition.atlas;
      const cells = candidateCells(c.plan, c.style, current);
      if (c.id === "saved-C") expect(cells).toEqual([{ x: 2, y: 3 }, { x: 5, y: 3 }]);
      if (c.id === "saved-C") {
        // Synthetic guard challenges, never new observations on the stored run.
        for (const blockedBy of ["geometry", "protected", "contract", "compact", "open", "asymmetric", "tilt", "glasses", "brow", "hair", "covering", "outer", "missing_color"] as const) {
          const plan = structuredClone(c.plan), style = { ...c.style }, atlas = structuredClone(current), f = plan.facePixelPlan;
          if (blockedBy === "geometry") f.layout.geometryUsage.eyes = true;
          if (blockedBy === "protected") f.protectedGeometry.push("eye_layout");
          if (blockedBy === "contract") f.renderContract.eyes!.protected = true;
          if (blockedBy === "compact") f.layout.eyeOpenness = "compact";
          if (blockedBy === "open") f.layout.eyeTopology = "open_iris_sclera";
          if (blockedBy === "asymmetric") f.pixels = f.pixels.filter(p => p.cluster !== "left_eye");
          if (blockedBy === "tilt") f.pixels.find(p => p.cluster === "left_eye" && p.role === "iris")!.y++;
          if (blockedBy === "glasses") f.glassesPlan.topology = "rectangular_thin";
          if (blockedBy === "brow") f.pixels.push({ x: 2, y: 3, role: "brow", cluster: "left_eye" });
          if (blockedBy === "hair" || blockedBy === "covering") plan.headIdentityPlan.ownership!.cells.push({
            face: "front", layer: "base", x: 2, y: 3, owner: blockedBy === "hair" ? "hair_base" : "covering",
            sourceGroupId: "synthetic_protection", provenance: "observed",
          });
          if (blockedBy === "outer") atlas.rgba[at(2, 3, outer) + 3] = 255;
          if (blockedBy === "missing_color") style.eyeColor = "";
          expect(candidateCells(plan, style, atlas), blockedBy).toEqual([]);
        }
      }
      const color = [1, 3, 5].map(i => Number.parseInt(c.style.eyeColor!.slice(i, i + 2), 16));
      const variants = [];
      for (const [name, strength] of [["current", 0], ["subtle-cap", 0.58], ["light-cap", 0.82]] as const) {
        const atlas = structuredClone(current);
        const paint = color.map((v, i) => Math.round(v * (1 - strength) + [248, 246, 240][i] * strength));
        if (strength) for (const p of cells) atlas.rgba.set(paint, at(p.x, p.y));
        const allowed = new Set(strength ? cells.map(p => at(p.x, p.y)) : []);
        let changed = 0;
        for (let i = 0; i < atlas.rgba.length; i += 4) {
          expect(atlas.rgba[i + 3]).toBe(current.rgba[i + 3]);
          if (!allowed.has(i)) expect(atlas.rgba.slice(i, i + 4)).toEqual(current.rgba.slice(i, i + 4));
          else if ([0, 1, 2].some(ch => atlas.rgba[i + ch] !== current.rgba[i + ch])) changed++;
        }
        expect(changed).toBe([...allowed].filter(i => paint.some((v, ch) => v !== current.rgba[i + ch])).length);
        expect(validateFinalAtlas(atlas).ok).toBe(true);
        const quality = measureReferenceRenderedQuality({ ...chosen.composition, atlas }, c.baseline, c.plan, chosen.design, c.style);
        if (changed) expect(quality.violations).toContain("source_face_finish_changed");
        const view = renderSkinViews(atlas).find(v => v.name === "front")!.image;
        const renderedCatch = cells.map(p => {
          const scale = 28 / view.width;
          const x = Math.round(view.width / 2 + (p.x - 3.5) / scale - 0.5);
          const y = Math.round((2.5 + p.y) / scale - 0.5);
          const rgba = [...view.rgba.slice((y * view.width + x) * 4, (y * view.width + x) * 4 + 4)];
          if (strength) expect(rgba, `${c.id}: catch visible in rendered front`).toEqual([...paint, 255]);
          return { ...p, rgba };
        });
        writeFileSync(`${output}/${c.id}-${name}-front.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
        if (c.id === "saved-C") writeFileSync(`${output}/${c.id}-${name}.png`, await encodePng(atlas), { flag: "wx" });
        variants.push({ name, changedPixels: changed, paint: strength && cells.length ? paint : null, renderedCatch,
          atlasSha256: sha(atlas.rgba), currentProductionGuardViolations: quality.violations,
          sourceFaceContract: measureFaceRenderContract(atlas, c.plan.facePixelPlan) });
      }
      expect(JSON.stringify(c.plan)).toBe(planBefore); expect(JSON.stringify(c.analysis)).toBe(analysisBefore);
      const f = c.plan.facePixelPlan;
      rows.push({ id: c.id, geometryEyesUsed: f.layout.geometryUsage.eyes,
        eyeOpenness: f.layout.eyeOpenness, eyeTopology: f.layout.eyeTopology, eyeFootprint: f.layout.eyeFootprintTopology,
        sourceEyePixels: f.pixels.filter(p => p.role === "iris" || p.role === "sclera"),
        eyeMeasurements: { openness: f.layout.measurementTrace?.eyeOpenness, footprint: f.layout.measurementTrace?.eyeFootprint },
        candidateCells: cells, sourcePlanUnchanged: true, variants });
    }
    expect(rows).toHaveLength(13); expect(network).not.toHaveBeenCalled();
    expect(sha(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json"))).toBe(sha(annotationBytes));
    expect(sha(readFileSync("evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001/summary.json"))).toBe(sha(runBytes));
    // Unauthorized alternate paint still fails; the production upper-catch
    // contract is tested separately, never licensed by this candidate study.
    writeFileSync(`${output}/results.json`, JSON.stringify({ scope: "offline_presentation_comparison_against_current_contract",
      providerCalls: 0, productionMutatedByTest: false, sourceSummarySha256: sha(runBytes), annotationSha256: sha(annotationBytes), rows }, null, 2), { flag: "wx" });
    console.info(`SEMANTIC_EYE_PRESENTATION_STUDY ${output}`);
  } finally { network.mockRestore(); }
}, 180_000);
