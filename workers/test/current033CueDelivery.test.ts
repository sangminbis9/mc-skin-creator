import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng } from "../src/png";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-033";
it("proves observed mustache and tan affect actual 033 pixels without changing provider evidence", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const summaryBytes = readFileSync(`${root}/summary.json`), live = JSON.parse(summaryBytes.toString()).currentDefaultE2E.result;
    const verified = JSON.parse(readFileSync("evaluation-artifacts/current-033-live-verification-20260928-52EhpV/verification.json", "utf8"));
    const plan = live.analysis.skinPlan, style = verified.style, actual = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, style, plan)!.rgba).toEqual(actual.rgba);
    expect(style.goateeHasMustache).toBe(true);
    const withoutMustache = buildProceduralFallbackAtlas(live.features, { ...style, goateeHasMustache: false }, plan)!;
    const counterfactualPlan = structuredClone(plan);
    expect(counterfactualPlan.outfitPlan.upper.pattern.color).toBe("#c5aa82");
    counterfactualPlan.outfitPlan.upper.pattern.color = "#eeeae1";
    const withoutTan = buildProceduralFallbackAtlas(live.features, style, counterfactualPlan)!;
    const upperRects = [CLASSIC_LAYOUT.body, CLASSIC_LAYOUT.leftArm, CLASSIC_LAYOUT.rightArm].flatMap(box => [...Object.values(box.base), ...Object.values(box.overlay)]);
    const changed: Record<string, { x: number; y: number }[]> = { mustache: [], tan: [] };
    for (const [name, counterfactual] of [["mustache", withoutMustache], ["tan", withoutTan]] as const) {
      for (let i = 0; i < 4096; i++) {
        expect(counterfactual.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
        if ([0, 1, 2].some(c => counterfactual.rgba[i * 4 + c] !== actual.rgba[i * 4 + c])) {
          const x = i % 64, y = Math.floor(i / 64);
          if (name === "mustache") { expect(x).toBeGreaterThanOrEqual(8); expect(x).toBeLessThan(16); expect(y).toBeGreaterThanOrEqual(8); expect(y).toBeLessThan(16); }
          else expect(upperRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
          changed[name].push({ x, y });
        }
      }
      expect(changed[name].length).toBeGreaterThan(0);
    }
    expect(plan.hairPlan.surfaceOnly).toBe(true); expect(plan.headIdentityPlan.outerHairGroupIds).toEqual([]);
    const hairOwners = plan.headIdentityPlan.ownership.cells.filter((c: { owner: string }) => c.owner === "hair_base");
    expect(hairOwners.length).toBeGreaterThan(0);
    const out = mkdtempSync("evaluation-artifacts/current-033-cue-delivery-20260928-");
    writeFileSync(`${out}/verification.json`, JSON.stringify({ providerCalls: 0, changed,
      summarySha256: createHash("sha256").update(summaryBytes).digest("hex"), scalpHairBaseOwners: hairOwners.length,
      outerHairGroupCount: 0, actualSurfaceOnly: true, alphaDiff: 0,
      limitation: "Controlled renderer ablations prove causal delivery, not source measurement accuracy. White pattern and absent mustache are synthetic controls, never provider evidence. No scalp-transparency evidence was added." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`CUE_DELIVERY_033 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
