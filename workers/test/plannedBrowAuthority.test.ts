import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";

const baselineRoot = "evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-li8W2P";
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
type FrozenCase = { id: string; calibrated: boolean; baselinePlan: SkinPlan; baselineStyle: FaceStyle;
  baselineFeatures: Record<string, unknown>; beforeHash: string };
const baselineBytes = readFileSync(`${baselineRoot}/results.json`);
const fixtures: FrozenCase[] = JSON.parse(baselineBytes.toString()).cases;

it("does not let legacy brow shape add unplanned strokes to an authoritative face plan", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    // Test every frozen plan, not a person-specific production exception.
    for (const fixture of fixtures) {
      const { baselineFeatures: features, baselineStyle: style, baselinePlan: plan } = fixture;
      const control = buildProceduralFallbackAtlas(features, { ...style, eyebrowShape: "straight" }, plan)!;
      expect(control).not.toBeNull();
      for (const eyebrowShape of ["arched", "slanted", "soft"] as const) {
        const candidate = buildProceduralFallbackAtlas(features, { ...style, eyebrowShape }, plan)!;
        expect(candidate).not.toBeNull();
        expect(sha(candidate.rgba), `${fixture.id}: ${eyebrowShape}`).toBe(sha(control.rgba));
      }
    }
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 30_000);

it("preserves all twelve plans and body pixels and records both planned and no-plan rendering", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = mkdtempSync("evaluation-artifacts/planned-brow-authority-20260926-");
    const previousRoot = process.env.BROW_AUTHORITY_PREVIOUS_ROOT;
    const previous = previousRoot ? JSON.parse(readFileSync(`${previousRoot}/results.json`, "utf8")) : undefined;
    const cases = [];
    for (const fixture of fixtures) {
      const { baselineFeatures: features, baselineStyle: style, baselinePlan: plan } = fixture;
      const beforePlan = JSON.stringify(plan);
      const baseline = await decodePng(readFileSync(`${baselineRoot}/${fixture.id}-before.png`));
      expect(sha(baseline.rgba)).toBe(fixture.beforeHash);
      const atlas = buildProceduralFallbackAtlas(features, style, plan)!;
      expect(atlas, fixture.id).not.toBeNull();
      expect(JSON.stringify(plan)).toBe(beforePlan);
      const changed = [];
      for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => baseline.rgba[p * 4 + c] !== atlas.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        changed.push({ x, y });
        expect(y, fixture.id).toBeLessThan(16);
        expect(atlas.rgba[p * 4 + 3], fixture.id).toBe(baseline.rgba[p * 4 + 3]);
      }
      const craft = validateAtlasCraft(atlas, style, plan.facePixelPlan, plan.hairPlan, plan);
      expect(craft.ok, `${fixture.id}: ${craft.problems.join(" / ")}`).toBe(true);
      expect(validateFinalAtlas(atlas).ok).toBe(true);
      const noPlanHashes = ["straight", "arched", "slanted", "soft"].map(eyebrowShape => {
        const unplanned = buildProceduralFallbackAtlas(features, { ...style, eyebrowShape: eyebrowShape as FaceStyle["eyebrowShape"] });
        return unplanned ? sha(unplanned.rgba) : null;
      });
      if (previous) expect(noPlanHashes, fixture.id).toEqual(previous.cases.find((c: { id: string }) => c.id === fixture.id).noPlanHashes);
      cases.push({ id: fixture.id, calibrated: fixture.calibrated, changed, planUnchanged: true,
        atlasHash: sha(atlas.rgba), noPlanHashes, craft, finalAtlasValid: true });
      writeFileSync(`${root}/${fixture.id}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front")!;
      writeFileSync(`${root}/${fixture.id}-head.png`, await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 128, 128)), { flag: "wx" });
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0, baselineRoot, previousRoot, cases }, null, 2), { flag: "wx" });
    expect(readFileSync(`${baselineRoot}/results.json`)).toEqual(baselineBytes);
    expect(network).not.toHaveBeenCalled();
    console.info(`BROW_AUTHORITY_ROOT ${root}`);
  } finally { network.mockRestore(); }
}, 30_000);
