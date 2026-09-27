import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { acceptedFaceGeometry } from "./audit/savedV4FaceGeometry";
import { buildFacePixelPlanVariants } from "../src/identityPlans";
import { buildQuantizedLayoutVariants } from "../src/identityQuantization";
import { buildSkinPlan } from "../src/skinPlan";
import { buildFaceStyle, buildProceduralFallbackAtlas, normalizeAnalysisForRendering } from "../src/generate";
import { encodePng } from "../src/png";
import { renderSkinViews, extractRenderedHeadView, scaleNearestNeighbor } from "../src/skinRender";

it("audits accepted -006 geometry through current fixed-context planning without external calls", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const path = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-006/summary.json";
    const original = readFileSync(path);
    const live = JSON.parse(original.toString()).currentDefaultE2E.result;
    const saved = live.diagnostics.normalizedPrimary;
    const geometry = acceptedFaceGeometry(live.diagnostics.geometry.acceptedGeometry);
    expect(geometry).toEqual(live.diagnostics.geometry.acceptedGeometry);
    const control = makeAnalysis({ ...saved, identityPrompt: saved.observed.hair, outfitPrompt: saved.observed.clothing });
    const root = mkdtempSync("evaluation-artifacts/current006-geometry-retention-20260927-");
    const rows = [];
    for (const enriched of [false, true]) {
      const analysis = normalizeAnalysisForRendering({ ...control, ...(enriched ? { faceIdentityGeometry: geometry } : {}) });
      const layouts = buildQuantizedLayoutVariants(analysis, 3);
      const candidates = buildFacePixelPlanVariants(analysis, 3);
      let stage = "buildSkinPlan", error: string | null = null, atlasAccepted = false;
      let plan = null;
      const stages: unknown[] = [];
      let finalHead: { width: number; height: number; rgba: Uint8Array } | undefined;
      try {
        plan = buildSkinPlan(analysis);
        stage = "buildFaceStyle";
        const style = buildFaceStyle(analysis, live.features, plan.hairPlan);
        stage = "buildProceduralFallbackAtlas";
        atlasAccepted = !!buildProceduralFallbackAtlas(live.features, style, plan, (name, image) => {
          const face = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) =>
            Array.from(image.rgba.slice(((y + 8) * 64 + x + 8) * 4, ((y + 8) * 64 + x + 8) * 4 + 3))));
          stages.push({ name, face });
          if (name === "final_head") finalHead = { ...image, rgba: new Uint8Array(image.rgba) };
        });
        stage = "complete";
      } catch (e) { error = e instanceof Error ? e.message : "unknown_exception"; }
      rows.push({ enriched, layouts, candidates, stage, error, atlasAccepted, stages,
        planSource: plan?.facePixelPlan.source ?? null, renderDiagnostics: log.mock.calls.map(call => call.map(String)) });
      expect(error).toBeNull();
      expect(atlasAccepted).toBe(true);
      expect(plan?.facePixelPlan.source).toBe(enriched ? "identity_geometry" : "semantic_fallback");
      if (finalHead) {
        // Face grammar now has a separately verified eye-axis repair. Compare
        // with that post-repair atlas, not the pre-repair iris/mouth positions.
        const oldRoot = enriched ? "evaluation-artifacts/eye-axis-retention-20260927-RSxnwB"
          : "evaluation-artifacts/current006-geometry-retention-20260927-JnBcfM";
        const { decodePng } = await import("../src/png");
        const oldAtlas = await decodePng(readFileSync(`${oldRoot}/${enriched ? "current-geometry-fixed-context" : "semantic-accepted"}.png`));
        expect(finalHead.rgba).toEqual(oldAtlas.rgba);
        writeFileSync(`${root}/${enriched ? "enriched-accepted" : "semantic-accepted"}.png`, await encodePng(finalHead), { flag: "wx" });
        const view = renderSkinViews(finalHead).find(v => v.name === "front")!;
        writeFileSync(`${root}/${enriched ? "enriched-accepted" : "semantic-accepted"}-head.png`,
          await encodePng(scaleNearestNeighbor(extractRenderedHeadView(view), 256, 256)), { flag: "wx" });
      }
      log.mockClear();
    }
    writeFileSync(`${root}/results.json`, JSON.stringify({ providerCalls: 0,
      liveSummaryHash: createHash("sha256").update(original).digest("hex"),
      actualPlanSource: live.analysis.skinPlan.facePixelPlan.source, rows,
      limitation: "Fixed helper context for omitted rich fields; not exact live reconstruction or proof of historical exception." }, null, 2), { flag: "wx" });
    expect(readFileSync(path)).toEqual(original);
    expect(network).not.toHaveBeenCalled();
    console.info(`GEOMETRY_RETENTION_ROOT ${root}`);
  } finally { network.mockRestore(); log.mockRestore(); }
});
