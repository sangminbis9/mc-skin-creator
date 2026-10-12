// Saved D010 partial evidence only. This is not a reconstruction of missing D011 input.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { cpuUsage } from "node:process";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
interface ProfileCase {
  id: string; inputHash: string;
  semantic: { renderAttempts: number; candidateHash: string; selectedDesignHash: string;
    selectedDiagnosticHash: string; selectedAtlasHash: string; namedHairCells: number };
  timings: Array<{ wallMs: number; processCpuMs: number }>;
}
it("profiles saved D010 and observed-only cumulative transfers, preserving every candidate verdict", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const profiler = new Session(); profiler.connect();
  try {
    const bytes = readFileSync("evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-010/summary.json");
    expect(sha(bytes)).toBe("26c58761d0f08a862e8f4721194d02a8271236beb252c3700682c203a9ab8eb6");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis }, old = t.injectedParameters;
    const resolved = buildOutfitPlan(a), colors = refineFeatureColorsFromAnalysis(a, old.features);
    if (typeof colors.hatColor !== "string") throw Error("saved_observed_hat_color_missing");
    const hatColor = colors.hatColor;
    const inputs = ["saved_D010", "D010_observed_only_transfer"].map(id => {
      const source: SkinPlan = structuredClone(t.skinPlan.skinPlan);
      const design: ReferenceStylePlan = structuredClone(t.referenceStyle.design);
      const style: FaceStyle = { ...old.faceStyle }, features = { ...old.features };
      if (id !== "saved_D010") {
        for (const key of ["leftSleeve", "rightSleeve"] as const)
          source.outfitPlan.upper[key] = { ...resolved.upper[key], color: source.outfitPlan.upper[key].color };
        source.outfitPlan.outerLayer = structuredClone(resolved.outerLayer);
        source.outfitPlan.outerLayerRegions = [...resolved.outerLayerRegions];
        source.outfitPlan.provenance = source.outfitPlan.provenance.map(p => p.target === "upper.sleeves"
          ? resolved.provenance.find(x => x.target === "upper.sleeves")! : p);
        source.outfitPlan.upper.pattern = structuredClone(resolved.upper.pattern);
        features.hatColor = hatColor; style.hatColor = hatColor;
        design.drape = buildReferenceStylePlan(a).drape;
      }
      return { id, source, design, style, baseline: buildProceduralSourceAtlas(features, style, source)! };
    });
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.setSamplingInterval", { interval: 200 });
    await profiler.post("Profiler.start");
    const cases: ProfileCase[] = [];
    for (const input of inputs) {
      const { id, source, design, style, baseline } = input, inputHash = sha(JSON.stringify(input));
      const runs = [];
      for (let i = 0; i < 4; i++) {
        const wall = performance.now(), cpu = cpuUsage();
        const r = selectReferenceStyleAtlas(baseline, source, design, style), used = cpuUsage(cpu);
        const wallMs = performance.now() - wall;
        expect(r.selected).not.toBeNull();
        runs.push({ wallMs, processCpuMs: (used.user + used.system) / 1000,
          renderAttempts: r.renderAttempts, candidateHash: sha(JSON.stringify(r.candidates)),
          selectedDesignHash: sha(JSON.stringify(r.selected!.design)),
          selectedDiagnosticHash: sha(JSON.stringify(r.selected!.composition.diagnostic)),
          selectedAtlasHash: sha(r.selected!.composition.atlas.rgba),
          namedHairCells: r.selected!.composition.diagnostic.surfacePixels.filter(c => c.owner === "hair" && c.drapeGroup).length });
      }
      const { wallMs: _wall, processCpuMs: _cpu, ...semantic } = runs[0]; void _wall; void _cpu;
      for (const run of runs) expect(run).toMatchObject(semantic);
      expect(semantic.selectedAtlasHash).toBe(id === "saved_D010"
        ? "07122de62bc23ef361da35d51af127acb5d67a8366a3a0862ca77b05d30e6557"
        : "6e4bbab614615f89258d1af30ce8538209850b804362133e9619a5bee01cc438");
      expect(sha(JSON.stringify(input))).toBe(inputHash);
      cases.push({ id, inputHash, semantic, timings: runs.map(r => ({ wallMs: r.wallMs, processCpuMs: r.processCpuMs })) });
    }
    const { profile } = await profiler.post("Profiler.stop");
    const frames = new Map(profile.nodes.map(n => [n.id, n.callFrame])), times = new Map<string, number>();
    for (const [i, sample] of (profile.samples ?? []).entries()) {
      const frame = frames.get(sample)!;
      const file = frame.url.replaceAll("\\", "/").split("/workers/")[1];
      const key = file ? `${file}:${frame.lineNumber + 1}:${frame.functionName || "anonymous"}`
        : frame.functionName === "(garbage collector)" ? "garbage_collector" : "other_runtime";
      times.set(key, (times.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
    }
    const beforeBytes = readFileSync("evaluation-artifacts/reference-d010-resource-20261011-IKUF4z/summary.json");
    expect(sha(beforeBytes)).toBe("4aa9edc3d773fb8b833a1a0616fc3c563834d50396c4b52ffed2c97cd7ef9461");
    const semantic = (c: ProfileCase) => ({ id: c.id, inputHash: c.inputHash, semantic: c.semantic });
    expect(cases.map(semantic)).toEqual(JSON.parse(beforeBytes.toString()).cases.map(semantic));
    const out = freshAuditOutput("evaluation-artifacts/reference-d010-resource-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_local_node_sampling", providerCalls: 0,
      sourceSummarySha256: sha(bytes), nodeVersion: process.version, preIndexProfileSha256: sha(beforeBytes),
      sourceHashes: Object.fromEntries(["referenceStyleSelection", "referenceStyleRenderer", "referenceStyleConstraints",
        "referenceLooseHair", "referenceOutfitRetention"].map(n => [n, sha(readFileSync(`src/${n}.ts`))])),
      cases, selfSamples: [...times].map(([location, ms]) => ({ location, ms })).sort((a, b) => b.ms - a.ms),
      limitations: ["D011 input unavailable; not a reproduction of D011", "not remote CPU/peak memory measurement",
        "only observed roles transferred; missing analysis context not supplied", "samples include assertions and hashing"],
    }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info("D010_RESOURCE_PROFILE", out);
  } finally { profiler.disconnect(); network.mockRestore(); }
}, 120_000);
