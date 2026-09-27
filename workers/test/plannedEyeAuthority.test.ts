import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { makeAnalysis } from "./helpers";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const frozenRoot = "evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-li8W2P";
type Subject = { id: string; calibrated: boolean; baselinePlan: SkinPlan; baselineStyle: FaceStyle;
  baselineFeatures: Record<string, unknown> };
const subjects: Subject[] = JSON.parse(readFileSync(`${frozenRoot}/results.json`, "utf8")).cases;
const replayRoot = "evaluation-artifacts/current-source-v4-geometry-replay-20260926-9KY0Z7";
const replay = JSON.parse(readFileSync(`${replayRoot}/results.json`, "utf8"));
const beforeRoot = "evaluation-artifacts/planned-eye-authority-20260926-lR09gL";
const beforeBytes = readFileSync(`${beforeRoot}/results.json`);
const beforeReport = JSON.parse(beforeBytes.toString());
const old = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005/summary.json", "utf8")).currentDefaultE2E.result;
const saved = old.diagnostics.normalizedPrimary;
subjects.push({ id: "current-source-fixed-context-counterfactual", calibrated: false,
  baselinePlan: replay.renderComparison.afterPlan, baselineFeatures: old.features,
  baselineStyle: buildFaceStyle(makeAnalysis({ ...saved, identityPrompt: saved.observed.hair,
    outfitPrompt: saved.observed.clothing, faceIdentityGeometry: old.diagnostics.geometry.acceptedGeometry }), old.features) });

function render(subject: Subject, style: FaceStyle, planned: boolean) {
  let captured: RawImage | undefined;
  const accepted = buildProceduralFallbackAtlas(subject.baselineFeatures, style, planned ? subject.baselinePlan : undefined,
    (stage, raw) => { if (stage === "final_head") captured = { ...raw, rgba: new Uint8Array(raw.rgba) }; });
  expect(captured).toBeDefined();
  return { atlas: accepted ?? captured!, accepted: accepted !== null };
}

it("records fixed-plan eye-size perturbations and a fresh offline rendering baseline", async () => {
  const guard = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = mkdtempSync("evaluation-artifacts/planned-eye-authority-20260926-");
    const cases = [];
    for (const subject of subjects) {
      const { baselineStyle: style, baselinePlan: plan } = subject;
      const planHash = sha(JSON.stringify(plan));
      const control = render(subject, style, true);
      expect(control.accepted, subject.id).toBe(true);
      const previous = beforeReport.cases.find((c: { id: string }) => c.id === subject.id);
      expect(planHash).toBe(previous.planHash);
      const baseline = await decodePng(readFileSync(`${beforeRoot}/${subject.id}.png`));
      expect(sha(baseline.rgba)).toBe(previous.atlasHash);
      const rendererChanges = [];
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => baseline.rgba[p * 4 + c] !== control.atlas.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        rendererChanges.push({ x, y });
        expect(y, subject.id).toBeLessThan(16);
        expect(control.atlas.rgba[p * 4 + 3], subject.id).toBe(baseline.rgba[p * 4 + 3]);
      }
      const legacyXs = style.eyeSpacing === "wide" ? [0, 1, 7, 6] : style.eyeSpacing === "close" ? [1, 2, 5, 4] : [1, 2, 6, 5];
      const eyeFootprint = (p: { x: number; y: number }) => legacyXs.includes(p.x - 8) &&
        (p.y === 12 || p.y === 13 || (style.eyeTilt === "upturned" && p.y === 11));
      // The frozen baseline predates the subsequent independent mouth-paint
      // repair. Its exact isolated delta is checked in plannedMouthAuthority.
      const mouthFootprint = (p: { x: number; y: number }) => p.x >= 10 && p.x <= 13 && p.y >= 13 && p.y <= 15;
      const footprint = (p: { x: number; y: number }) => eyeFootprint(p) || mouthFootprint(p);
      const seam = getBoxUvSeams(CLASSIC_LAYOUT.head.base).horizontal.find(s => s.primary.every(p => p.y === 15))!;
      for (const cell of rendererChanges) {
        const seamIndex = seam.adjacent.findIndex(p => p.x === cell.x && p.y === cell.y);
        if (seamIndex >= 0) {
          expect(mouthFootprint(seam.primary[seamIndex])).toBe(true);
          continue;
        }
        const contrastRole = plan.facePixelPlan.pixels.some(p => ["iris", "lip", "mouth_shadow"].includes(p.role) && p.x === cell.x - 8 && p.y === cell.y - 8);
        expect(footprint(cell) || (contrastRole && rendererChanges.some(p => footprint(p) && Math.abs(p.x - cell.x) + Math.abs(p.y - cell.y) === 1)), subject.id).toBe(true);
      }
      const probes = [];
      const perturbations: Partial<FaceStyle>[] = [
        ...["small", "average", "large"].map(eyeSize => ({ eyeSize: eyeSize as FaceStyle["eyeSize"] })),
        ...["narrow", "almond", "round"].map(eyeShape => ({ eyeShape: eyeShape as FaceStyle["eyeShape"] })),
        ...["close", "average", "wide"].map(eyeSpacing => ({ eyeSpacing: eyeSpacing as FaceStyle["eyeSpacing"] })),
        ...["upturned", "level", "downturned"].map(eyeTilt => ({ eyeTilt: eyeTilt as FaceStyle["eyeTilt"] })),
      ];
      for (const perturbation of perturbations) {
        const probe = render(subject, { ...style, ...perturbation }, true);
        const changed = [];
        for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => control.atlas.rgba[p * 4 + c] !== probe.atlas.rgba[p * 4 + c])) {
          const x = p % 64, y = Math.floor(p / 64);
          changed.push({ x, y, roles: plan.facePixelPlan.pixels.filter(cell => cell.x === x - 8 && cell.y === y - 8).map(cell => cell.role) });
        }
        expect(changed, `${subject.id}: ${JSON.stringify(perturbation)}`).toEqual([]);
        probes.push({ perturbation, accepted: probe.accepted, changed });
      }
      const noPlan = ["small", "average", "large"].map(eyeSize => {
        const output = render(subject, { ...style, eyeSize: eyeSize as FaceStyle["eyeSize"] }, false);
        return { eyeSize, accepted: output.accepted, hash: sha(output.atlas.rgba) };
      });
      expect(noPlan, subject.id).toEqual(previous.noPlan);
      expect(sha(JSON.stringify(plan))).toBe(planHash);
      const craft = validateAtlasCraft(control.atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
      expect(craft.ok, subject.id).toBe(true);
      expect(validateFinalAtlas(control.atlas).ok).toBe(true);
      cases.push({ id: subject.id, calibrated: subject.calibrated, planHash, atlasHash: sha(control.atlas.rgba), rendererChanges, probes, noPlan, craft });
      writeFileSync(`${root}/${subject.id}.png`, await encodePng(control.atlas), { flag: "wx" });
      const view = renderSkinViews(control.atlas).find(v => v.name === "front")!;
      writeFileSync(`${root}/${subject.id}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 192, 192)), { flag: "wx" });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, frozenRoot, replayRoot, beforeRoot, cases,
      limitation: "Current-source context is a counterfactual, not a reconstructed V4 primary response or new production PNG." }, null, 2), { flag: "wx" });
    expect(guard).not.toHaveBeenCalled();
    expect(readFileSync(`${beforeRoot}/results.json`)).toEqual(beforeBytes);
    console.info(`EYE_AUTHORITY_ROOT ${root}`);
  } finally { guard.mockRestore(); }
}, 30_000);

it("keeps an authoritative eye footprint independent of legacy eye-size painting", () => {
  const subject = subjects.at(-1)!;
  const small = render(subject, { ...subject.baselineStyle, eyeSize: "small" }, true);
  const large = render(subject, { ...subject.baselineStyle, eyeSize: "large" }, true);
  expect(small.accepted).toBe(true); expect(large.accepted).toBe(true);
  expect(sha(small.atlas.rgba)).toBe(sha(large.atlas.rgba));
});

it("retains source eye-colour contrast and the no-plan legacy eye-size behavior", () => {
  const subject = subjects.at(-1)!;
  const dark = render(subject, { ...subject.baselineStyle, eyeColor: "#151515" }, true);
  const light = render(subject, { ...subject.baselineStyle, eyeColor: "#b9d7ef" }, true);
  expect(dark.accepted).toBe(true); expect(light.accepted).toBe(true);
  expect(sha(dark.atlas.rgba)).not.toBe(sha(light.atlas.rgba));
  const small = render(subject, { ...subject.baselineStyle, eyeSize: "small" }, false);
  const large = render(subject, { ...subject.baselineStyle, eyeSize: "large" }, false);
  expect(sha(small.atlas.rgba)).not.toBe(sha(large.atlas.rgba));
});

it("separates actual eye paint from complexion sampling in the old-geometry control", () => {
  const subject = { ...subjects.at(-1)!, baselinePlan: replay.renderComparison.beforePlan as SkinPlan };
  const output = render(subject, subject.baselineStyle, true);
  const plan = subject.baselinePlan.facePixelPlan;
  const excluded = new Set<string>();
  const anchors = [];
  for (const cluster of ["left_eye", "right_eye"] as const) {
    const cells = plan.pixels.filter(p => p.cluster === cluster && ["iris", "sclera"].includes(p.role));
    const iris = cells.filter(p => p.role === "iris").sort((a, b) => b.y - a.y || a.x - b.x)[0];
    const support = cells.filter(p => p.x !== iris.x).sort((a, b) => a.y - b.y || Math.abs(b.x - iris.x) - Math.abs(a.x - iris.x))[0] ?? iris;
    excluded.add(`${iris.x},${iris.y}`); excluded.add(`${support.x},${support.y}`);
    anchors.push(iris);
  }
  for (const p of plan.pixels.filter(p => ["nose", "mouth"].includes(p.cluster))) excluded.add(`${p.x},${p.y}`);
  const allEyesExcluded = new Set([...excluded, ...plan.pixels.filter(p => ["iris", "sclera"].includes(p.role)).map(p => `${p.x},${p.y}`)]);
  const rgb = (x: number, y: number) => Array.from(output.atlas.rgba.slice(((y + 8) * 64 + x + 8) * 4, ((y + 8) * 64 + x + 8) * 4 + 3));
  const samples = (omit: Set<string>) => [4, 5, 6, 7].flatMap(y => [3, 4].map(x => ({ x, y })))
    .filter(p => !omit.has(`${p.x},${p.y}`)).map(p => ({ ...p, rgb: rgb(p.x, p.y), role: plan.pixels.find(cell => cell.x === p.x && cell.y === p.y)?.role ?? null }));
  const measure = (omit: Set<string>) => {
    const points = samples(omit);
    const skin = [0, 1, 2].map(c => { const sorted = points.map(p => p.rgb[c]).sort((a, b) => a - b), m = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; });
    return { points, skin, eyeContrast: anchors.map(p => ({ ...p, rgb: rgb(p.x, p.y), distance: rgb(p.x, p.y).reduce((sum, v, c) => sum + Math.abs(v - skin[c]), 0) })) };
  };
  const legacy = measure(excluded), completeEyeExclusion = measure(allEyesExcluded);
  expect(legacy.points.some(p => p.role === "iris")).toBe(true);
  expect(completeEyeExclusion.points.some(p => p.role === "iris" || p.role === "sclera")).toBe(false);
  const root = mkdtempSync("evaluation-artifacts/eye-complexion-sampling-20260926-");
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, accepted: output.accepted, legacy,
    completeEyeExclusion, craft: validateAtlasCraft(output.atlas, subject.baselineStyle, undefined, undefined, subject.baselinePlan) }, null, 2), { flag: "wx" });
  console.info(`EYE_COMPLEXION_ROOT ${root}`);
});
