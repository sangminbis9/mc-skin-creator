import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { resolveHeadOwnership } from "../src/headOwnership";
import { preserveObservedScarfBeltColors } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { referenceEyePresentation } from "../src/referenceFaceFinish";
import { buildReferenceStylePlan, FACE_STYLE_TEMPLATES, type FaceStyleFamily } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas, measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const rect = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
const at = (x: number, y: number, r = rect) => ((r.y + y) * 64 + r.x + x) * 4;
function context() {
  const bytes = readFileSync("evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-001/summary.json");
  expect(sha(bytes)).toBe("d9f82481a49f537a37b26bb5d23534eda6d07560a9d233d070ca83d002938ff1");
  const trace = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
  // Stored safe fields suffice for pure replay; never reconstruct absent prompts.
  const a = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
  const plan: SkinPlan = structuredClone(trace.skinPlan.skinPlan), style: FaceStyle = trace.injectedParameters.faceStyle;
  plan.headIdentityPlan.ownership = resolveHeadOwnership(a, plan.hairPlan, plan.facePixelPlan);
  plan.outfitPlan = preserveObservedScarfBeltColors(plan.outfitPlan, a);
  const baseline = buildProceduralSourceAtlas(trace.injectedParameters.features, style, plan)!;
  const design = buildReferenceStylePlan(a);
  const eye = [1, 3, 5].map(i => Number.parseInt(style.eyeColor.slice(i, i + 2), 16));
  return { a, plan, style, baseline, design, eye };
}

describe("explicit categorical singleton eye presentation", () => {
  it.each(Object.keys(FACE_STYLE_TEMPLATES) as FaceStyleFamily[])("%s varies with existing pigment and coordinates without editing measurements", family => {
    const c = context(), f = c.plan.facePixelPlan; c.design.face.family = family;
    // Synthetic variants exercise the reusable grammar, not new photo claims.
    for (const eye of [[74, 55, 40], [38, 73, 104], [156, 181, 198]]) for (const y of [4, 5]) {
      f.pixels = [{ x: 2, y, role: "iris", cluster: "left_eye" }, { x: 5, y, role: "iris", cluster: "right_eye" }];
      const before = JSON.stringify(f);
      const contract = referenceEyePresentation(f, c.design, eye, [], c.baseline);
      const strength = FACE_STYLE_TEMPLATES[family].irisGlint;
      expect(contract).toEqual({ kind: "paired_upper_catch", cells: [2, 5].map(x => ({ x, y: y - 1,
        color: eye.map((v, ch) => Math.round(v * (1 - strength) + [248, 246, 240][ch] * strength)) })) });
      expect(JSON.stringify(f)).toBe(before);
    }
  });
  it.each(["geometry", "protected", "contract", "asymmetry", "compact", "open", "small", "unknown", "untrusted", "glasses", "tilt", "one_eye", "wide", "brow", "iris_brow", "hair", "beard", "outer", "iris_outer", "transparent", "missing_color", "missing_atlas", "legacy"] as const)("retains source for %s", kind => {
    const c = context(), f = c.plan.facePixelPlan, protectedCells: { x: number; y: number }[] = [];
    if (kind === "geometry") f.layout.geometryUsage.eyes = true;
    if (kind === "protected") f.protectedGeometry.push("eye_layout");
    if (kind === "contract") f.renderContract.eyes!.protected = true;
    if (kind === "asymmetry") f.renderContract.eyes!.preserveAsymmetry = true;
    if (kind === "compact") f.layout.eyeOpenness = "compact";
    if (kind === "open") f.layout.eyeTopology = "open_iris_sclera";
    if (kind === "small") f.layout.eyeFootprintTopology = "compact";
    if (kind === "unknown") f.layout.measurementTrace!.eyeOpenness.value = "unknown";
    if (kind === "untrusted") f.layout.measurementTrace = undefined;
    if (kind === "glasses") f.glassesPlan.topology = "rectangular_thin";
    if (kind === "tilt") f.pixels.find(p => p.role === "iris")!.y++;
    if (kind === "one_eye") f.pixels = f.pixels.filter(p => p.cluster !== "left_eye");
    if (kind === "wide") f.pixels.push({ x: 3, y: 4, role: "iris", cluster: "left_eye" });
    if (kind === "brow") f.pixels.push({ x: 2, y: 3, role: "brow", cluster: "left_eye" });
    if (kind === "iris_brow") f.pixels.push({ x: 2, y: 4, role: "brow", cluster: "left_eye" });
    if (kind === "hair") f.layout.hairlineDepthByColumn[2] = 3;
    if (kind === "beard") protectedCells.push({ x: 2, y: 3 });
    if (kind === "outer" || kind === "iris_outer") c.baseline.rgba[at(2, kind === "outer" ? 3 : 4, outer) + 3] = 255;
    if (kind === "transparent") c.baseline.rgba[at(2, 3) + 3] = 0;
    if (kind === "legacy") c.design.version = "reference_style_v1";
    expect(referenceEyePresentation(f, c.design, kind === "missing_color" ? undefined : c.eye,
      protectedCells, kind === "missing_atlas" ? undefined : c.baseline)).toEqual({ kind: "retain_source", cells: [] });
  });
  it("propagates saved categorical evidence through selection, craft and PNG; rejects forged paint/diagnostics", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
    try {
      const c = context(), immutable = JSON.stringify([c.a, c.plan, c.style]);
      const selection = selectReferenceStyleAtlas(c.baseline, c.plan, c.design, c.style);
      expect(selection.selected).not.toBeNull(); const chosen = selection.selected!;
      expect(chosen.quality.violations).toEqual([]);
      const presentation = chosen.composition.diagnostic.faceFinish.eyePresentation;
      expect(presentation.kind).toBe("paired_upper_catch");
      expect(presentation.cells.map(p => [p.x, p.y])).toEqual([[2, 3], [5, 3]]);
      const beforeBytes = readFileSync("evaluation-artifacts/semantic-eye-presentation-study-20261010-UjDEt7/saved-C-current.png");
      const before = await decodePng(beforeBytes);
      expect(sha(before.rgba)).toBe("25545961004b448dece33c6c8c33ccb3e1465d662ac689aebd02eac4c9830826");
      const allowed = new Set([at(2, 3), at(5, 3)]), atlas = chosen.composition.atlas;
      for (let i = 0; i < atlas.rgba.length; i += 4) {
        expect(atlas.rgba[i + 3]).toBe(before.rgba[i + 3]);
        if (!allowed.has(i)) expect(atlas.rgba.slice(i, i + 4), `unrelated:${i}`).toEqual(before.rgba.slice(i, i + 4));
      }
      for (const kind of ["paint", "diagnostic", "occlusion"] as const) {
        const bad = structuredClone(chosen.composition), i = at(2, 3);
        if (kind === "paint") {
          bad.atlas.rgba[i] = 0;
          bad.diagnostic.facePixels.find(p => p.x === 2 && p.y === 3)!.color[0] = 0;
          bad.diagnostic.faceFinish.eyePresentation.cells[0].color[0] = 0;
        }
        if (kind === "diagnostic") bad.diagnostic.faceFinish.eyePresentation = { kind: "retain_source", cells: [] };
        if (kind === "occlusion") bad.atlas.rgba[at(2, 3, outer) + 3] = 255;
        const errors = measureReferenceRenderedQuality(bad, c.baseline, c.plan, chosen.design, c.style).violations;
        expect(errors).toContain(kind === "occlusion" ? "eye_presentation_occluded" : "eye_presentation_contract_changed");
        if (kind === "paint") expect(errors).toContain("source_face_finish_changed");
      }
      const result = renderReferencePrimaryAtlas(c.baseline, c.plan, c.a, c.style);
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
      expect(result.atlas.rgba).toEqual(atlas.rgba);
      expect(validateFinalAtlas(result.atlas).ok).toBe(true);
      const png = await encodePng(result.atlas); expect((await decodePng(png)).rgba).toEqual(atlas.rgba);
      expect(renderReferencePrimaryAtlas(c.baseline, c.plan, c.a, c.style)).toEqual(result);
      expect(JSON.stringify([c.a, c.plan, c.style])).toBe(immutable); expect(network).not.toHaveBeenCalled();
      const output = freshAuditOutput("evaluation-artifacts/reference-eye-presentation-20261010-");
      writeFileSync(`${output}/after.png`, png, { flag: "wx" });
      for (const [name, image] of [["before", before], ["after", atlas]] as const) {
        const view = renderSkinViews(image).find(v => v.name === "front")!.image;
        writeFileSync(`${output}/${name}-front.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
      }
      writeFileSync(`${output}/summary.json`, JSON.stringify({ scope: "offline_saved_C_replay_not_live", providerCalls: 0,
        observedMeasurementsUnchanged: true, planUnchanged: true, presentation, beforeRgba: sha(before.rgba), afterRgba: sha(atlas.rgba),
        intentionalPixelCount: 2, unrelatedPixelDiff: 0, quality: chosen.quality, result: result.summary }, null, 2), { flag: "wx" });
      console.info(`REFERENCE_EYE_PRESENTATION ${output}`);
    } finally { network.mockRestore(); }
  }, 60_000);
});
