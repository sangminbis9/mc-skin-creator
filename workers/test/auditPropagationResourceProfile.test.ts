// Local Node cost measurements only; never claim they are edge CPU limits.
import { cpuUsage, memoryUsage } from "node:process";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";
import { normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis, fallbackFeaturesToHex,
  buildFaceStyle, buildProceduralSourceAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { encodePng, bytesToBase64 } from "../src/png";
import { captureCurrentDefaultPropagation } from "./audit/currentDefaultPropagation";
import { boundedProjection, digest } from "./audit/currentDefaultE2E";

async function timed<T>(work: () => T | Promise<T>) {
  const cpu = cpuUsage(), wall = performance.now(), before = memoryUsage();
  const value = await work();
  const used = cpuUsage(cpu), after = memoryUsage();
  return { value, metrics: { wallMs: performance.now() - wall, cpuMs: (used.user + used.system) / 1000,
    heapBefore: before.heapUsed, heapAfter: after.heapUsed, rssAfter: after.rss,
    note: "process-wide local samples; heap endpoints are not peak memory" } };
}

it("measures deterministic production work and advisory rerender separately without inference", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const primary = makeAnalysis(); // Explicit authored unit, not recovered D001 analysis.
    const a = normalizeAnalysisForRendering(primary);
    const planned = await timed(() => buildSkinPlan(a));
    const plan = planned.value;
    const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
    const style = buildFaceStyle(a, features, plan.hairPlan);
    const baseline = await timed(() => buildProceduralSourceAtlas(features, style, plan));
    expect(baseline.value).not.toBeNull();
    const selected = await timed(() => renderReferencePrimaryAtlas(baseline.value!, plan, a, style));
    expect(selected.value.ok).toBe(true);
    if (!selected.value.ok) throw new Error("authored_render_failed");
    const body = { ok: true, features, analysis: { ...a, skinPlan: plan, referenceStyle: selected.value.summary },
      skinPngBase64: bytesToBase64(await encodePng(selected.value.atlas)) };
    const input = { primary, geometry: null, providerStage: "authored_offline", body,
      runId: "a".repeat(32), inputs: { analysisSha256: "b".repeat(64), generationSha256: "c".repeat(64) } };
    const passive = await timed(() => captureCurrentDefaultPropagation({ ...input, verifyReplay: false }, boundedProjection, digest));
    const phases: { stage: string; wallMs: number }[] = [];
    const phaseStart = performance.now();
    const parameters = await timed(() => captureCurrentDefaultPropagation({ ...input, verifyReplay: true,
      replayMode: "parameters_only", onStage: stage => { phases.push({ stage, wallMs: performance.now() - phaseStart }); } }, boundedProjection, digest));
    const replay = await timed(() => captureCurrentDefaultPropagation({ ...input, verifyReplay: true }, boundedProjection, digest));
    expect(replay.value.parameterEvidence).toBe("verified_exact_same_run_replay");
    expect(replay.value.replay).toMatchObject({ finalAtlasMatch: true, sourcePlanMatch: true, selectedDesignMatch: true,
      scope: "observed_design_atlas", rankingRecomputed: false, acceptedCandidateCountRecomputed: false });
    expect(passive.value.finalPng).toEqual(replay.value.finalPng);
    expect(parameters.value.finalPng).toEqual(replay.value.finalPng);
    expect(parameters.value.parameterEvidence).toBe("verified_same_run_plan_features");
    expect(parameters.value.replay).toMatchObject({ finalAtlasMatch: null, atlasReplay: "deferred_local" });
    expect(passive.value.injectedParameters).toBeNull();
    expect(network).not.toHaveBeenCalled();
    const out = freshAuditOutput("evaluation-artifacts/audit-propagation-resource-profile-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_authored_semantic_unit",
      providerCalls: 0, nodeVersion: process.version, remoteFailureReproduced: false,
      primaryPlan: planned.metrics, baselineAtlas: baseline.metrics, referenceSelection: selected.metrics,
      candidateCount: selected.value.summary.renderAttempts, passiveProjection: passive.metrics,
      parameterVerification: parameters.metrics,
      parameterPhaseObservations: phases,
      phaseDurationsAreLocalOnly: true,
      selectedDesignAdvisoryReplay: replay.metrics, replayExact: true, rankingRecomputed: false,
      conclusion: "audit reproduces only the actual selected design; production ranking is unchanged; cost is local only",
      notEstablished: ["D001 reached renderer", "D001 reached audit replay", "CPU rather than memory", "deployed account CPU budget"],
    }, null, 2), { flag: "wx" });
    console.info("AUDIT_RESOURCE_PROFILE", out);
  } finally { network.mockRestore(); }
}, 30_000);
