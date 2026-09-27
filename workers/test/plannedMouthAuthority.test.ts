import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng, type RawImage } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import { makeAnalysis } from "./helpers";
import { CLASSIC_LAYOUT, getBoxUvSeams } from "../src/uvLayout";

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
type Subject = { id: string; calibrated: boolean; baselinePlan: SkinPlan; baselineStyle: FaceStyle;
  baselineFeatures: Record<string, unknown> };
const subjects: Subject[] = JSON.parse(readFileSync("evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-li8W2P/results.json", "utf8")).cases;
const replay = JSON.parse(readFileSync("evaluation-artifacts/current-source-v4-geometry-replay-20260926-9KY0Z7/results.json", "utf8"));
const old = JSON.parse(readFileSync("evaluation-artifacts/current-default-v3-e2e-baseline-20260926-005/summary.json", "utf8")).currentDefaultE2E.result;
const saved = old.diagnostics.normalizedPrimary;
subjects.push({ id: "current-source-fixed-context-counterfactual", calibrated: false,
  baselinePlan: replay.renderComparison.afterPlan, baselineFeatures: old.features,
  baselineStyle: buildFaceStyle(makeAnalysis({ ...saved, identityPrompt: saved.observed.hair,
    outfitPrompt: saved.observed.clothing, faceIdentityGeometry: old.diagnostics.geometry.acceptedGeometry }), old.features) });
const perturbations: Partial<FaceStyle>[] = [
  ...["small", "wide", "full", "thin"].map(mouthShape => ({ mouthShape: mouthShape as FaceStyle["mouthShape"] })),
  ...["closed", "slightly_open", "teeth_visible"].map(mouthOpening => ({ mouthOpening: mouthOpening as FaceStyle["mouthOpening"] })),
  ...["thin", "average", "full"].map(lipFullness => ({ lipFullness: lipFullness as FaceStyle["lipFullness"] })),
];
const beforeRoot = "evaluation-artifacts/planned-mouth-authority-20260926-0IpgoT";
const beforeBytes = readFileSync(`${beforeRoot}/results.json`);
const beforeReport = JSON.parse(beforeBytes.toString());
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); }); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

function render(subject: Subject, style: FaceStyle, planned: boolean) {
  let captured: RawImage | undefined;
  const accepted = buildProceduralFallbackAtlas(subject.baselineFeatures, style, planned ? subject.baselinePlan : undefined,
    (stage, raw) => { if (stage === "final_head") captured = { ...raw, rgba: new Uint8Array(raw.rgba) }; });
  expect(captured).toBeDefined();
  return { atlas: accepted ?? captured!, accepted: accepted !== null };
}

it("freezes mouth-style perturbations under a fixed plan without modifying historical inputs", async () => {
  const root = mkdtempSync("evaluation-artifacts/planned-mouth-authority-20260926-");
  const cases = [];
  for (const subject of subjects) {
    const style = subject.baselineStyle, plan = subject.baselinePlan;
    const planHash = sha(JSON.stringify(plan)), control = render(subject, style, true);
    expect(control.accepted, subject.id).toBe(true);
    const previous = beforeReport.cases.find((c: { id: string }) => c.id === subject.id);
    expect(planHash).toBe(previous.planHash);
    const beforeAtlas = await decodePng(readFileSync(`${beforeRoot}/${subject.id}.png`));
    expect(sha(beforeAtlas.rgba)).toBe(previous.atlasHash);
    const rendererChanges = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => beforeAtlas.rgba[p * 4 + c] !== control.atlas.rgba[p * 4 + c])) {
      rendererChanges.push({ x: p % 64, y: Math.floor(p / 64) });
      expect(Math.floor(p / 64)).toBeLessThan(16);
      expect(control.atlas.rgba[p * 4 + 3]).toBe(beforeAtlas.rgba[p * 4 + 3]);
    }
    const front = CLASSIC_LAYOUT.head.base.front;
    const legacyMouth = (p: { x: number; y: number }) => p.x >= front.x + 2 && p.x <= front.x + 5 && p.y >= front.y + 5 && p.y <= front.y + 7;
    const chinSeam = getBoxUvSeams(CLASSIC_LAYOUT.head.base).horizontal.find(s => s.primary.every(p => p.y === front.y + 7))!;
    for (const cell of rendererChanges) {
      if (legacyMouth(cell)) continue;
      const seamIndex = chinSeam.adjacent.findIndex(p => p.x === cell.x && p.y === cell.y);
      if (seamIndex >= 0) {
        expect(legacyMouth(chinSeam.primary[seamIndex])).toBe(true);
        continue;
      }
      const contrastRole = plan.facePixelPlan.pixels.some(p => ["iris", "lip", "mouth_shadow"].includes(p.role) && p.x + front.x === cell.x && p.y + front.y === cell.y);
      expect(contrastRole && rendererChanges.some(p => legacyMouth(p) && Math.abs(p.x - cell.x) + Math.abs(p.y - cell.y) === 1), subject.id).toBe(true);
    }
    const probes = [];
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
    const noPlan = perturbations.map(perturbation => {
      const result = render(subject, { ...style, ...perturbation }, false);
      return { perturbation, accepted: result.accepted, hash: sha(result.atlas.rgba) };
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
  writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, beforeRoot, cases,
    limitation: "Current source is a fixed partial-context counterfactual, not a complete V4 analysis replay or fresh production PNG." }, null, 2), { flag: "wx" });
  console.info(`MOUTH_AUTHORITY_ROOT ${root}`);
  expect(readFileSync(`${beforeRoot}/results.json`)).toEqual(beforeBytes);
}, 30_000);

it("does not let legacy mouth shape add a second mouth under an authoritative plan", () => {
  const subject = subjects.at(-1)!;
  const narrow = render(subject, { ...subject.baselineStyle, mouthShape: "small" }, true);
  const wide = render(subject, { ...subject.baselineStyle, mouthShape: "wide" }, true);
  expect(narrow.accepted).toBe(true); expect(wide.accepted).toBe(true);
  expect(sha(narrow.atlas.rgba)).toBe(sha(wide.atlas.rgba));
});

it("retains planned lip pigment and the no-plan mouth grammar", () => {
  const subject = subjects.at(-1)!;
  const natural = render(subject, { ...subject.baselineStyle, lipColor: "natural" }, true);
  const berry = render(subject, { ...subject.baselineStyle, lipColor: "berry" }, true);
  expect(natural.accepted).toBe(true); expect(berry.accepted).toBe(true);
  expect(sha(natural.atlas.rgba)).not.toBe(sha(berry.atlas.rgba));
  const small = render(subject, { ...subject.baselineStyle, mouthShape: "small" }, false);
  const wide = render(subject, { ...subject.baselineStyle, mouthShape: "wide" }, false);
  expect(sha(small.atlas.rgba)).not.toBe(sha(wide.atlas.rgba));
});

it("confirms the existing nose cleanup already leaves the fixed plan authoritative", () => {
  for (const subject of subjects) {
    const control = render(subject, subject.baselineStyle, true);
    for (const noseShape of ["small", "straight", "rounded", "prominent"] as const) {
      const probe = render(subject, { ...subject.baselineStyle, noseShape }, true);
      expect(probe.accepted, `${subject.id}: ${noseShape}`).toBe(true);
      expect(sha(probe.atlas.rgba), `${subject.id}: ${noseShape}`).toBe(sha(control.atlas.rgba));
    }
  }
}, 30_000);
